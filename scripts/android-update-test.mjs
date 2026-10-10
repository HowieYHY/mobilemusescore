// Updating with a score open, on a USB-debugging Android phone: a real update (the service worker,
// from a local server that switches builds) arrives while a score is open; the phone's real Home
// button sends Chrome to the background, where PocketScore should restart into the update at once;
// back in Chrome, the new build shows with the score where it was. Screenshots come from the phone.
//
// Serves app/dist and a changed copy of it on 127.0.0.1:4174 (its own address and storage, so the
// reader's PocketScore is untouched). Opens its own tab with an intent, leaves the phone as found:
// only its own tab is closed and the forwarded ports are removed.
//   cd app && npm run build;  node scripts/android-update-test.mjs [score.mscz]

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const outDir = path.join(root, "build/android-update");
fs.mkdirSync(outDir, { recursive: true });
const adbPath = process.env.ADB || (fs.existsSync("D:/tools/platform-tools/adb.exe") ? "D:/tools/platform-tools/adb.exe" : "adb");
const adb = (...args) => execFileSync(adbPath, args, { maxBuffer: 64 << 20 });
const shot = (name) => fs.writeFileSync(path.join(outDir, name + ".png"), adb("exec-out", "screencap", "-p"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures++;
};

// the current build, and a later one (a changed index.html and a new cache version)
const newDir = path.join(root, "app/dist");
const laterDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-later-"));
fs.cpSync(newDir, laterDir, { recursive: true });
{
    const idx = path.join(laterDir, "index.html");
    fs.writeFileSync(idx, fs.readFileSync(idx, "utf8").replace("</body>", "<!-- later -->\n</body>"));
    const pre = JSON.parse(fs.readFileSync(path.join(laterDir, "precache.json"), "utf8"));
    const f = pre.files.find((x) => x.url === "index.html");
    const data = fs.readFileSync(idx);
    f.size = data.length;
    f.h = crypto.createHash("sha1").update(data).digest("hex");
    const oldVersion = pre.version;
    pre.version = ("later" + oldVersion).slice(0, oldVersion.length);
    fs.writeFileSync(path.join(laterDir, "precache.json"), JSON.stringify(pre));
    const sw = path.join(laterDir, "sw.js");
    fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(oldVersion, pre.version));
}
let serveDir = newDir;
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(serveDir, p);
    if (!file.startsWith(serveDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(4174, "127.0.0.1", r));
const url = "http://127.0.0.1:4174/";

console.log("device:", adb("shell", "getprop", "ro.product.model").toString().trim());
adb("reverse", "tcp:4174", "tcp:4174");
adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, "com.android.chrome");
for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const targets = await fetch("http://localhost:9222/json/list").then((r) => r.json()).catch(() => []);
    const others = targets.filter((t) => t.type === "service_worker" && !t.url.startsWith(url));
    if (targets.some((t) => t.type === "page" && t.url.startsWith(url)) && others.length === 0) break;
}
const browser = await chromium.connectOverCDP("http://localhost:9222", { timeout: 120000 });
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(url));
if (!page) {
    console.log("FAIL the test tab did not open");
    process.exit(1);
}
page.on("pageerror", (e) => check(false, `page error: ${e.message}`));
const cacheVersion = () => page.evaluate(() => caches.keys().then((k) => k.join(","))).catch(() => "");

try {
    await page.bringToFront();
    // the current build installs (the whole app, once)
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 600000 });
    for (let i = 0; i < 600 && (await cacheVersion()).split(",").length !== 1; i++) await sleep(1000);
    await page.reload();
    // the engine has started (openScore before that fails: "reading 'FS'")
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 300000 });
    const v = await page.evaluate(() => document.getElementById("version").textContent);
    console.log(`     installed: ${v}, cache ${await cacheVersion()}`);

    // a score, at a place in the middle
    const b64 = fs.readFileSync(scorePath).toString("base64");
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await window.app.openScore(name, bytes.buffer);
    }, { name: path.basename(scorePath), b64 });
    await page.waitForFunction(() => window.app.state.playbackReady, null, { timeout: 300000 });
    await page.evaluate(async () => {
        await app.engine.seek(app.state.duration * 0.4);
    });
    await sleep(1500);
    const before = await page.evaluate(() => ({ title: document.getElementById("score-title").textContent, position: app.state.position }));
    await page.evaluate(() => (window.beforeUpdate = true));
    shot("01-score-open");

    // the later build is published and found
    serveDir = laterDir;
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    for (let i = 0; i < 120 && !(await cacheVersion()).startsWith("pocketscore-later"); i++) await sleep(1000);
    await sleep(1000);
    check(await page.evaluate(() => window.beforeUpdate === true), "while on screen and recently touched, it waits (no restart yet)");

    // the phone's Home button: Chrome goes to the background, PocketScore restarts there
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    await sleep(6000);
    shot("02-home-screen");
    adb("shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");
    await sleep(3000);
    const p2 = browser.contexts()[0].pages().find((p) => p.url().startsWith(url)) || page;
    await p2.waitForFunction(() => !!window.app?.state, null, { timeout: 120000 }).catch(() => {});
    const restarted = await p2.evaluate(() => window.beforeUpdate !== true).catch(() => false);
    const later = (await p2.content().catch(() => "")).includes("<!-- later -->");
    check(restarted && later, "in the background it restarted into the later build");
    await p2.waitForFunction((t) => document.getElementById("score-title").textContent === t && app.state.playbackReady, before.title, { timeout: 300000 }).catch(() => {});
    await sleep(2000);
    const after = await p2.evaluate(() => ({ title: document.getElementById("score-title").textContent, position: app.state.position }));
    check(after.title === before.title && Math.abs(after.position - before.position) < 0.3,
        `back in Chrome, the score is where it was: ${after.title} at ${after.position.toFixed(1)} s (was ${before.position.toFixed(1)} s)`);
    shot("03-back");
} catch (err) {
    failures++;
    console.log("FAIL ", String(err.message).split("\n")[0]);
} finally {
    for (const p of browser.contexts()[0].pages().filter((p) => p.url().startsWith(url))) {
        await p.evaluate(async () => {
            for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
            for (const k of await caches.keys()) await caches.delete(k);
        }).catch(() => {});
        await p.close().catch(() => {});
    }
    await browser.close().catch(() => {});
    adb("forward", "--remove", "tcp:9222");
    adb("reverse", "--remove", "tcp:4174");
    server.close();
    fs.rmSync(laterDir, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "Android update checks passed", "- phone screenshots in", outDir);
process.exit(failures ? 1 : 0);
