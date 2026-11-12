// An update on a bad connection must not cost the reader the app they had (bug hunt, finding 1).
// Serves a build from a local server, lets it install, then publishes a later build while one of its
// changed files can't be downloaded (the connection drops mid-file). Before the fix the new version took
// over anyway and deleted the old one's complete copy, so offline the app was missing that file. Now the
// old version must stay whole and open offline; and once the connection is good again the update goes
// in, downloading only what it still lacks.
//
// Needs a production build: (cd app && npm run build)
// Usage: node scripts/update-fail-test.mjs [dist dir = app/dist]
//   SW=<file>   use this sw.js in the later build (the old one, to see the checks fail)
// Runs on its own address (127.0.0.1:5191) and in a browser profile of its own.

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

const oldDir = path.resolve(process.argv[2] || path.join(root, "app/dist"));
if (!fs.existsSync(path.join(oldDir, "precache.json"))) {
    console.log("No build found in " + oldDir + ": run `npm run build` in app/ first.");
    process.exit(2);
}
const sha1 = (data) => crypto.createHash("sha1").update(data).digest("hex");

// The later build: the same app with two files changed. index.html (small), and the app's script,
// which is the one that will fail to download.
const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-later-"));
fs.cpSync(oldDir, newDir, { recursive: true });
const pre = JSON.parse(fs.readFileSync(path.join(newDir, "precache.json"), "utf8"));
const oldVersion = pre.version;
const script = pre.files.find((f) => /^assets\/index-.*\.js$/.test(f.url));
const mark = { "index.html": (s) => s.replace("</body>", "<!-- later -->\n</body>"), [script.url]: (s) => s + "\n// later\n" };
for (const f of [pre.files.find((x) => x.url === "index.html"), script]) {
    const p = path.join(newDir, decodeURIComponent(f.url));
    const data = Buffer.from(mark[f.url](fs.readFileSync(p, "utf8")));
    fs.writeFileSync(p, data);
    f.size = data.length;
    f.h = sha1(data);
}
pre.version = ("later" + oldVersion).slice(0, oldVersion.length);
fs.writeFileSync(path.join(newDir, "precache.json"), JSON.stringify(pre));
const swSource = process.env.SW
    ? fs.readFileSync(path.resolve(process.env.SW), "utf8").replace(/\r\n/g, "\n").replace("__BUILD_VERSION__", pre.version)
    : fs.readFileSync(path.join(newDir, "sw.js"), "utf8").replace(oldVersion, pre.version);
fs.writeFileSync(path.join(newDir, "sw.js"), swSource);
const fileCount = pre.files.length;

let serveDir = oldDir;
let dropScript = false; // the connection drops while the app's script downloads
let bytes = 0;
let drops = 0;
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
    const headers = { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" };
    if (dropScript && serveDir === newDir && p === "/" + decodeURIComponent(script.url)) {
        drops++;
        res.writeHead(200, { ...headers, "content-length": data.length });
        res.write(data.subarray(0, Math.floor(data.length / 2)));
        setTimeout(() => res.destroy(), 100); // half the file, then the line goes dead
        return;
    }
    bytes += data.length;
    res.writeHead(200, headers);
    res.end(data);
});
await new Promise((r) => server.listen(5191, "127.0.0.1", r));
const url = "http://127.0.0.1:5191/";

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ps-profile-"));
const ctx = await chromium.launchPersistentContext(profile);
const page = ctx.pages()[0] || await ctx.newPage();
// what the device holds: each stored version with its number of files, and whether the app's script
// of each build is among them
const stored = () => page.evaluate(async (appScript) => {
    const out = {};
    for (const key of await caches.keys()) {
        const c = await caches.open(key);
        const body = await (await c.match(new URL(appScript, location.href).href))?.text();
        out[key.replace("pocketscore-", "")] = {
            files: (await c.keys()).length,
            script: body === undefined ? "missing" : body.endsWith("// later\n") ? "later" : "old",
        };
    }
    return out;
}, script.url);
const waitFor = async (what, test, ms = 300000) => {
    for (let waited = 0; waited < ms; waited += 500) {
        if (await test().catch(() => false)) {
            return true;
        }
        await page.waitForTimeout(500);
    }
    console.log("  (gave up waiting for: " + what + ")");
    return false;
};
const opensOffline = async () => {
    await ctx.setOffline(true);
    let ok = false;
    try {
        await page.goto(url, { timeout: 30000 });
        // the app itself must run, not only its first page: the engine starts and says Ready
        ok = await page.waitForFunction(() => document.getElementById("status")?.textContent.startsWith("Ready"), null, { timeout: 60000 }).then(() => true, () => false);
    } catch (err) {
        ok = false;
        if (process.env.DEBUG) {
            console.log("  offline: " + err.message.split("\n")[0]);
        }
    }
    if (process.env.DEBUG) {
        console.log("  offline: status " + JSON.stringify(await page.evaluate(() => document.getElementById("status")?.textContent).catch((e) => e.message)));
    }
    const later = ok && (await page.content()).includes("<!-- later -->");
    await ctx.setOffline(false);
    return { ok, later };
};

// 1. the first build installs, whole
await page.goto(url);
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 300000 });
await waitFor("the first build stored", async () => {
    const s = await stored();
    return Object.keys(s).length === 1 && s[oldVersion]?.files >= fileCount;
});
let s = await stored();
check(s[oldVersion]?.files >= fileCount && s[oldVersion].script === "old", `the first build is installed: ${s[oldVersion]?.files} files (${mb(bytes)} downloaded)`);

// 2. a later build is published; the app is opened again on a connection that drops
serveDir = newDir;
dropScript = true;
bytes = 0;
await page.goto(url);
await waitFor("the update tried", async () => drops > 0, 120000);
await page.waitForTimeout(4000); // time for the new version to take over, if it is going to
s = await stored();
check(drops > 0, `the update was tried and the connection dropped during ${script.url}`);
check(s[oldVersion]?.files >= fileCount && s[oldVersion].script === "old",
    `the version that was installed is still whole on the device: ${JSON.stringify(s)}`);
const line = await page.evaluate(() => (document.getElementById("status").hidden ? "" : document.getElementById("status").textContent));
check(!line.startsWith("Downloading an update"), `the "Downloading an update…" line is not left up: ${JSON.stringify(line)}`);
let off = await opensOffline();
check(off.ok, "offline, the app still opens and its engine starts");
check(off.ok && !off.later, "and it is the version that was installed, not half of the next one");

// 3. the connection is good again: the next visit installs the update
dropScript = false;
bytes = 0;
await page.goto(url);
const installed = await waitFor("the later build stored", async () => {
    const now = await stored();
    return Object.keys(now).length === 1 && now[pre.version]?.files >= fileCount;
}, 120000);
s = await stored();
check(installed && s[pre.version]?.script === "later", `on a good connection the update goes in, whole: ${JSON.stringify(s)}`);
check(bytes < 5 * 1048576, `downloading only what it still lacked: ${mb(bytes)}`);
await page.goto(url); // the next launch
off = await opensOffline();
check(off.ok && off.later, "offline, the updated app opens and its engine starts");

await ctx.close();
server.close();
fs.rmSync(newDir, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
