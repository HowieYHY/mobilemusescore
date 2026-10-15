// Settings on a real Android phone (USB debugging), in the phone's own Chrome, on a local build at
// its own address (so the reader's notes and settings in the installed app are never touched). Plays
// quietly (master volume down, not saved). Checks:
//   - Settings is a page of its own over the whole screen (phones), left with Back,
//   - Keep the screen on: Android's own power report shows a screen wake lock while playing, and
//     none after pausing,
//   - Full screen with the Focus button: on, the page goes full screen; off, it doesn't,
//   - sound gaps while playing in Page view, with focus starting by itself and with it off
//     (the stutter guesses in DEVELOPMENT.md),
//   - Keep playing: off, going to the home screen pauses; on, the audio clock keeps running with
//     no gaps on the home screen and with the screen off (the screen is turned off near the end;
//     the reader unlocks it after).
// Opens its own tab and closes only that tab. Screenshots in build/android-settings.
//
//   cd app && npm run build && npx vite preview --host --port 4173
//   adb reverse tcp:4173 tcp:4173
// Usage: node scripts/android-settings-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { adb } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:4173/";
const outDir = path.join(root, "build/android-settings");
fs.mkdirSync(outDir, { recursive: true });
const shot = (name) => fs.writeFileSync(path.join(outDir, name + ".png"), adb("exec-out", "screencap", "-p"));
const sh = (...a) => adb("shell", ...a).toString();
// Chrome back in front as it was (its last tab: this one), without opening another tab
const front = () => sh("am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

console.log("device:", sh("getprop", "ro.product.model").trim(), "Android", sh("getprop", "ro.build.version.release").trim());
// the test page as a tab of its own, in front, before connecting (a busy background tab can stall it)
// the phone reaches this PC's test copy through a reverse port (else it shows its old offline copy)
const port = new URL(url).port;
if (/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname) && port) adb("reverse", `tcp:${port}`, `tcp:${port}`);
sh("am", "start", "-a", "android.intent.action.VIEW", "-d", url, "com.android.chrome");
adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
for (let i = 0; i < 30; i++) {
    const list = await (await fetch("http://localhost:9222/json/list")).json();
    if (list.some((t) => t.url.startsWith(url)) && !list.some((t) => t.type === "service_worker")) break;
    await sleep(1000);
}
const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().startsWith(url));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const cdp = await context.newCDPSession(page);

// a real finger tap (counts as the reader's own tap, as full screen needs)
const tap = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const setSetting = (k, v) => page.evaluate(([k, v]) => {
    const el = document.querySelector(`[data-set="${k}"]`);
    if (el.type === "checkbox") el.checked = v; else el.value = String(v);
    el.dispatchEvent(new Event("change"));
}, [k, v]);
const screenLocks = () => sh("dumpsys", "power").split("\n")
    .filter((l) => /^\s+(SCREEN_BRIGHT|SCREEN_DIM|FULL)_WAKE_LOCK/.test(l)).map((l) => l.trim().slice(0, 90));
const audio = () => page.evaluate(() => ({ playing: app.state.playing, clock: app.engine.audioTime, gaps: app.engine.underruns,
    ctx: app.engine.audioRunning, hidden: document.hidden }));

try {
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    // the phone keeps the last build it saw at this address (its offline copy): this build, or start afresh
    // (this address is the test's own: the reader's installed app is not touched)
    const want = JSON.parse(fs.readFileSync(path.join(root, "app/package.json"), "utf8")).version;
    const version = () => page.evaluate(() => document.getElementById("version").textContent);
    if (!(await version()).endsWith(want)) {
        console.log(`  the phone had ${await version()} at this address; clearing its offline copy`);
        await page.evaluate(async () => {
            for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
            for (const k of await caches.keys()) await caches.delete(k);
        });
        await page.reload();
        await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    }
    console.log("test copy:", await version());
    check((await version()).endsWith(want), `the phone runs this build (${want})`);
    const b64 = fs.readFileSync(scorePath).toString("base64");
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await app.openScore(name, bytes.buffer);
    }, { name: path.basename(scorePath), b64 });
    await page.waitForFunction(() => app.state.playbackReady && document.querySelector(".page canvas"), null, { timeout: 180000 });
    await page.evaluate(() => app.engine.setMasterVolume(-30)); // quiet; not saved
    console.log("score open:", await page.evaluate(() => document.getElementById("score-title").textContent));

    // ---- the panel on the real screen
    await tap("#settings-open");
    await sleep(700);
    const full = await page.evaluate(() => {
        const r = document.getElementById("settings").getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: innerHeight };
    });
    shot("panel");
    check(full.top <= 0.5 && Math.abs(full.bottom - full.h) < 1.5, `Settings is a page over the whole screen (${full.top.toFixed(1)}-${full.bottom.toFixed(1)} of ${full.h})`);
    await tap("#settings-back");
    await sleep(500);

    // ---- keep the screen on
    await setSetting("autoFocus", false);
    await setSetting("keepAwake", true);
    const before = screenLocks();
    await tap("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 30000 });
    await sleep(1500);
    const during = screenLocks();
    await tap("#play");
    await page.waitForFunction(() => !app.state.playing, null, { timeout: 10000 });
    await sleep(1500);
    const after = screenLocks();
    console.log("  screen wake locks before / playing / paused:", before.length, during.length, after.length);
    during.forEach((l) => console.log("   ", l));
    check(during.length > before.length && after.length === before.length, "keep the screen on: Android holds the screen awake while playing, lets go on pause");
    await setSetting("keepAwake", false);

    // ---- full screen with the Focus button
    for (const on of [true, false]) {
        await setSetting("focusFullscreen", on);
        await tap("#focus-toggle");
        await sleep(1200);
        const fs1 = await page.evaluate(() => ({ full: !!document.fullscreenElement, focus: app.state.focus }));
        shot(on ? "focus-fullscreen" : "focus-no-fullscreen");
        check(fs1.focus && fs1.full === on, `full screen with the Focus button ${on ? "on" : "off"}: focus ${fs1.focus}, full screen ${fs1.full}`);
        await page.evaluate(() => history.back());
        await sleep(1200);
        if (await page.evaluate(() => !!document.fullscreenElement)) await page.evaluate(() => document.exitFullscreen());
        await sleep(500);
    }

    // ---- sound gaps in Page view: focus by itself on (default timing) and off
    for (const auto of [true, false]) {
        await setSetting("autoFocus", auto);
        await page.evaluate(() => { app.engine.seek(0); app.engine.health.length = 0; });
        await sleep(800);
        const g0 = await page.evaluate(() => app.engine.underruns);
        await tap("#play");
        await page.waitForFunction(() => app.state.playing, null, { timeout: 30000 });
        await sleep(45000);
        const r = await page.evaluate(() => ({ gaps: app.engine.underruns, health: app.engine.health.slice(), focus: app.state.focus, stats: { ...app.engine.stats } }));
        await tap("#play").catch(() => {});
        await page.evaluate(() => app.state.playing && app.engine.pause());
        await sleep(800);
        if (r.focus) { await page.evaluate(() => history.back()); await sleep(800); }
        console.log(`  focus by itself ${auto ? "on" : "off"}: ${r.gaps - g0} gap(s) in 45 s, focus started: ${r.focus}, engine load ${r.stats.load === null ? "?" : (r.stats.load * 100).toFixed(0) + "%"}, slowest block ${r.stats.slowestMs?.toFixed?.(1)} ms`);
        r.health.forEach((h) => console.log(`    ${h.at} ${h.kind}: ${h.detail}`));
        check(r.gaps - g0 === 0, `no sound gaps in 45 s of Page view with focus by itself ${auto ? "on" : "off"}`);
    }
    await setSetting("autoFocus", false);

    // ---- keep playing: off pauses on the home screen
    await setSetting("keepPlaying", false);
    await tap("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 30000 });
    await sleep(2000);
    sh("input", "keyevent", "KEYCODE_HOME");
    await sleep(4000);
    const offHome = await audio();
    check(!offHome.playing, `keep playing off: the home screen pauses (playing ${offHome.playing}, hidden ${offHome.hidden})`);
    front();
    await sleep(3000);
    await page.evaluate(() => app.state.playing && app.engine.pause());

    // ---- keep playing on: home screen, then screen off
    await setSetting("keepPlaying", true);
    await tap("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 30000 });
    await sleep(2000);
    for (const [where, key] of [["the home screen", "KEYCODE_HOME"], ["the screen off", "KEYCODE_SLEEP"]]) {
        const a = await audio();
        const t = Date.now();
        sh("input", "keyevent", key);
        await sleep(30000);
        const b = await audio();
        const ran = b.clock - a.clock;
        const wall = (Date.now() - t) / 1000;
        console.log(`  ${where}: audio clock ran ${ran.toFixed(1)} s of ${wall.toFixed(1)} s, gaps ${b.gaps - a.gaps}, playing ${b.playing}, audio running ${b.ctx}, hidden ${b.hidden}`);
        check(b.playing && ran > wall - 2 && b.gaps === a.gaps, `keep playing on: music goes on with ${where}, no gaps`);
        if (key === "KEYCODE_HOME") {
            front();
            await sleep(3000);
        }
    }
    sh("input", "keyevent", "KEYCODE_WAKEUP");
    await page.evaluate(() => app.state.playing && app.engine.pause()).catch(() => {});
} finally {
    await page.evaluate(() => app.state?.playing && app.engine.pause()).catch(() => {});
    // only this test's tabs (a tab of its address opened by any step)
    for (const p of context.pages().filter((p) => p.url().startsWith(url))) await p.close().catch(() => {});
    await browser.close().catch(() => {});
    adb("forward", "--remove", "tcp:9222");
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
