// Focus mode (issue #17) on a USB-debugging Android phone, in its own Chrome tab, with real touch
// (CDP Input.dispatchTouchEvent, so the browser treats taps as the reader's own and allows full
// screen): Focus goes full screen with only Play showing, a tap on a note stays in focus, Play plays,
// a tap off the staves (the title area) leaves focus and full screen, and so does the phone's real
// Back button, staying in PocketScore. Screenshots come from the phone.
//
// Runs on 127.0.0.1:4173 (a local build, its own storage, so the reader's PocketScore is untouched):
//   cd app && npm run build && npx vite preview --port 4173 --host 127.0.0.1
// Opens its tab with an intent first and waits for other tabs' service workers to settle (a running
// one stalls the connection), and leaves the phone as found: only its own tab is closed and the
// forwarded ports are removed. Usage: node scripts/android-focus-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:4173/";
const version = JSON.parse(fs.readFileSync(path.join(root, "app/package.json"), "utf8")).version;
const outDir = path.join(root, "build/android-focus");
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

console.log("device:", adb("shell", "getprop", "ro.product.model").toString().trim());
adb("reverse", "tcp:4173", "tcp:4173");
adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
// the test's own tab, opened as the reader would open a link
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
const cdp = await page.context().newCDPSession(page);
const touch = async (x, y) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
// screen points are worked out just before each tap: full screen changes the page's size
const tapEl = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    await touch(b.x + b.width / 2, b.y + b.height / 2);
};
const tapPage = async (pt) => {
    const s = await page.evaluate(({ x, y }) => {
        const r = document.querySelector('.page[data-index="0"]').getBoundingClientRect();
        const k = (96 * app.state.zoom) / 1200;
        return { x: r.left + x * k, y: r.top + y * k };
    }, pt);
    await touch(s.x, s.y);
};
const now = () => page.evaluate(() => ({
    focus: app.state.focus,
    fullscreen: !!document.fullscreenElement,
    height: innerHeight,
    topbar: getComputedStyle(document.querySelector(".topbar")).display !== "none",
    url: location.href,
    score: !!app.state.score,
}));

try {
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 300000 });
    const v = await page.evaluate(() => document.getElementById("version").textContent);
    check(v === `PocketScore ${version}`, `the ${version} build (${v})`);

    const b64 = fs.readFileSync(scorePath).toString("base64");
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await window.app.openScore(name, bytes.buffer);
    }, { name: path.basename(scorePath), b64 });
    await page.waitForSelector(".page canvas", { timeout: 300000 });
    await page.waitForFunction(() => window.app.state.playbackReady, null, { timeout: 300000 });
    await page.waitForTimeout(1500);
    check(await page.isVisible("#focus-toggle"), "the Focus button shows with a score open");

    // a note on the first system, and the title area above it, in page units
    const pts = await page.evaluate(async () => {
        const tl = await app.engine.timeline();
        const sp = app.state.score.spatium;
        const firstY = tl.find((p) => p[1] === 0)[3];
        const system = tl.filter((p) => p[1] === 0 && p[3] === firstY);
        const h = system[0][4];
        for (const [secs, pg, x] of system) {
            for (let yy = firstY; yy <= firstY + h; yy += sp / 4) {
                for (const dx of [sp, 1.5 * sp, 0.5 * sp, 2 * sp]) {
                    const c = await app.engine.locate(pg, x + dx, yy, 0.5 * sp);
                    if (c && c.note && Math.abs(c.secs - secs) < 0.01) {
                        const w = parseFloat(document.querySelector('.page[data-index="0"]').style.width) / ((96 * app.state.zoom) / 1200);
                        return { note: { x: x + dx, y: yy }, title: { x: w / 2, y: Math.max(sp, firstY - 6 * sp) } };
                    }
                }
            }
        }
        return null;
    });
    check(!!pts, "found a note on the first system");
    shot("01-score");

    await tapEl("#focus-toggle");
    await page.waitForTimeout(1500);
    const f = await now();
    check(f.focus && !f.topbar, "Focus: the bars are gone");
    check(f.fullscreen, "full screen: Chrome and the status bar give way (see 02-focus.png)");
    const play = await page.locator("#play").boundingBox();
    const vh = await page.evaluate(() => innerHeight);
    check(play && play.y + play.height <= vh, `Play floats on screen (bottom at ${Math.round(play.y + play.height)} of ${vh})`);
    shot("02-focus");

    await page.evaluate(() => document.querySelector(".viewer").scrollTo(0, 0));
    await page.waitForTimeout(400);
    await tapPage(pts.note);
    await page.waitForTimeout(800);
    check((await now()).focus, "a tap on a note stays in focus");

    await tapEl("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 60000 }).catch(() => {});
    const p0 = await page.evaluate(() => app.state.position);
    await page.waitForTimeout(3000);
    const p1 = await page.evaluate(() => app.state.position);
    check(p1 - p0 > 2, `plays in focus: ${p0.toFixed(1)} s -> ${p1.toFixed(1)} s in 3 s`);
    shot("03-playing");
    await tapEl("#play");
    await page.waitForTimeout(600);

    await page.evaluate(() => document.querySelector(".viewer").scrollTo(0, 0));
    await page.waitForTimeout(400);
    await tapPage(pts.title);
    await page.waitForTimeout(1500);
    const off = await now();
    check(!off.focus && off.topbar && !off.fullscreen, "a tap off the staves brings the bars back and leaves full screen");
    shot("04-after-tap-off");

    await tapEl("#focus-toggle");
    await page.waitForTimeout(1500);
    check((await now()).fullscreen, "Focus again: full screen");
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    await page.waitForTimeout(1500);
    const back = await now();
    check(!back.focus && back.topbar && !back.fullscreen && back.url.startsWith(url) && back.score, "the phone's Back leaves focus and full screen, staying in PocketScore");
    shot("05-after-back");
} catch (err) {
    failures++;
    console.log("FAIL ", String(err.message).split("\n")[0]);
} finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    adb("forward", "--remove", "tcp:9222");
    adb("reverse", "--remove", "tcp:4173");
}
console.log(failures ? `${failures} FAILED` : "Android focus checks passed", "- phone screenshots in", outDir);
process.exit(failures ? 1 : 0);
