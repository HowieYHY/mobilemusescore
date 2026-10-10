// Checks that an installed web app (service worker) updates to a new build:
// only changed files are downloaded, and the new version shows after the
// update. Serves builds from a local server that can switch between them.
//
// Usage: node scripts/update-test.mjs <old dist dir> [new dist dir = app/dist]

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const oldDir = path.resolve(process.argv[2]);
const newDir = path.resolve(process.argv[3] || path.join(root, "app/dist"));

// later builds: the new one with a changed index.html, to test updating from a version that
// updates by itself ("newer": no score open; "newest": a score open)
function laterBuild(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ps-${tag}-`));
    fs.cpSync(newDir, dir, { recursive: true });
    const idx = path.join(dir, "index.html");
    fs.writeFileSync(idx, fs.readFileSync(idx, "utf8").replace("</body>", `<!-- ${tag} -->\n</body>`));
    const pre = JSON.parse(fs.readFileSync(path.join(dir, "precache.json"), "utf8"));
    const f = pre.files.find((x) => x.url === "index.html");
    const data = fs.readFileSync(idx);
    f.size = data.length;
    f.h = crypto.createHash("sha1").update(data).digest("hex");
    const oldVersion = pre.version;
    pre.version = (tag + oldVersion).slice(0, oldVersion.length);
    fs.writeFileSync(path.join(dir, "precache.json"), JSON.stringify(pre));
    const sw = path.join(dir, "sw.js");
    fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(oldVersion, pre.version));
    return dir;
}
const newerDir = laterBuild("newer");
const newestDir = laterBuild("newest");
const scorePath = path.join(root, "real test musescores/I am move it(howie version).mscz");

let serveDir = oldDir;
let bytes = 0;
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) {
        p += "index.html";
    }
    const file = path.join(serveDir, p);
    if (!file.startsWith(serveDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
    }
    const data = fs.readFileSync(file);
    bytes += data.length;
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "max-age=600" });
    res.end(data);
});
await new Promise((r) => server.listen(5190, r));
const url = "http://localhost:5190/";

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ps-profile-"));
const ctx = await chromium.launchPersistentContext(profile);
const page = ctx.pages()[0] || await ctx.newPage();
const version = () => page.evaluate(() => document.getElementById("version")?.textContent || "(no version shown)");
async function waitInstalled(v) {
    for (let i = 0; i < 600; i++) {
        const keys = await page.evaluate(() => caches.keys()).catch(() => []);
        if (keys.length === 1 && keys[0] === "pocketscore-" + v) {
            return;
        }
        await page.waitForTimeout(500);
    }
    throw new Error("version " + v + " was not installed");
}
const versionOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "precache.json"), "utf8")).version;

// 1. first visit: the old build installs and caches everything
await page.goto(url);
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 300000 });
await waitInstalled(versionOf(oldDir));
console.log(`old build installed (${mb(bytes)} downloaded); shows: ${await version()}`);

// 2. the new build is published; the app is opened again
serveDir = newDir;
bytes = 0;
await page.goto(url);
await waitInstalled(versionOf(newDir));
const updateBytes = bytes;
check(updateBytes < 20 * 1048576, `update downloaded only changed files: ${mb(updateBytes)}`);
await page.goto(url); // the next launch
await page.waitForTimeout(1000);
if (process.env.DEBUG) {
    console.log(await page.evaluate(async () => {
        const out = { keys: await caches.keys(), sw: navigator.serviceWorker.controller?.scriptURL };
        const c = await caches.open(out.keys[0]);
        for (const k of ["./", "index.html"]) {
            const r = await c.match(new URL(k, location.href).href);
            out[k] = r ? (await r.text()).match(/index-[\w-]+\.js/)?.[0] : "missing";
        }
        out.loaded = [...document.scripts].map((s) => s.src);
        return JSON.stringify(out, null, 1);
    }));
}
const v2 = await version();
const newVersion = JSON.parse(fs.readFileSync(path.join(root, "app/package.json"), "utf8")).version;
check(v2.endsWith(" " + newVersion), `after reopening it shows the new version: ${v2}`);

// 3. a later build: this version notices the update and reloads by itself
serveDir = newerDir;
bytes = 0;
const reloaded = page.waitForEvent("load", { timeout: 300000 });
await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
await reloaded;
await page.waitForTimeout(500);
const html = await page.content();
check(html.includes("<!-- newer -->"), `the open app reloaded into the newer build by itself (${mb(bytes)} downloaded)`);

// 4. a later build while a score is open: it restarts by itself once left alone (20 s), and the
// score comes back where the reader was
await page.setInputFiles("#file-input", scorePath);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 300000 });
await page.evaluate(async () => {
    await app.engine.seek(app.state.duration * 0.4);
});
await page.waitForTimeout(1000);
const placeBefore = await page.evaluate(() => ({ title: document.getElementById("score-title").textContent, position: app.state.position }));
serveDir = newestDir;
bytes = 0;
const restarted = page.waitForEvent("load", { timeout: 300000 });
const t0 = Date.now();
await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
await restarted;
const tookS = ((Date.now() - t0) / 1000).toFixed(0);
await page.waitForFunction((t) => document.getElementById("score-title").textContent === t, placeBefore.title, { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 300000 }).catch(() => {});
await page.waitForTimeout(1500);
const placeAfter = await page.evaluate(() => ({ title: document.getElementById("score-title").textContent, position: app.state.position }));
check((await page.content()).includes("<!-- newest -->"), `with a score open, it restarted into the newest build by itself after ${tookS} s untouched`);
check(placeAfter.title === placeBefore.title && Math.abs(placeAfter.position - placeBefore.position) < 0.3,
    `the score came back where it was: ${placeAfter.title} at ${placeAfter.position.toFixed(1)} s (was ${placeBefore.position.toFixed(1)} s)`);

// offline afterwards: still opens
await ctx.setOffline(true);
await page.goto(url);
check(await page.isVisible("#open-label"), "the updated app opens offline");

await ctx.close();
server.close();
fs.rmSync(newerDir, { recursive: true, force: true });
fs.rmSync(newestDir, { recursive: true, force: true });
console.log(failures ? `${failures} failure(s)` : "update checks passed");
process.exit(failures ? 1 : 0);
