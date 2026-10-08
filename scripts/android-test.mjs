// Drives PocketScore in Chrome on a USB-debugging Android phone: opens a
// score, plays it through the real audio path, and measures what the reader
// would notice: gaps in the sound, frozen frames and a stuttering playback
// line. Then checks the mixer and seeking.
//
// Connects to the phone's own Chrome through its normal debugging socket
// (Playwright's launchBrowser needs a command-line file that release Chrome
// ignores). Opens its own tab and closes only that tab; nothing is installed
// or written on the phone. Screenshots go straight to this computer.
//
// To test a local build (its own origin, so the reader's saved notes and
// mixers on the published app are never touched):
//   cd app && npm run build && npx vite preview --host --port 4173
//   adb reverse tcp:4173 tcp:4173
// adb is found on PATH or in ADB (default D:/tools/platform-tools/adb.exe).
// Usage: APP_URL=http://localhost:4173/ PLAY_SECONDS=60 node scripts/android-test.mjs <score.mscz> [outDir]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const outDir = path.resolve(process.argv[3] || path.join(root, "build/android"));
const url = process.env.APP_URL || "http://localhost:4173/";
const playSeconds = Number(process.env.PLAY_SECONDS || 30);
const adbPath = process.env.ADB || (fs.existsSync("D:/tools/platform-tools/adb.exe") ? "D:/tools/platform-tools/adb.exe" : "adb");
fs.mkdirSync(outDir, { recursive: true });

const adb = (...args) => execFileSync(adbPath, args, { maxBuffer: 64 << 20 });
const shot = (name) => fs.writeFileSync(path.join(outDir, name + ".png"), adb("exec-out", "screencap", "-p"));

let failures = 0;
const fail = (m) => {
    console.error("FAIL:", m);
    failures++;
};

console.log("device:", adb("shell", "getprop", "ro.product.model").toString().trim());
adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];
// ATTACH=1: use the installed web app's open window (the published app, as the
// reader runs it) instead of a new tab at APP_URL. Refuses to open a score
// there if the reader has unsaved changes, and skips the mixer check so
// nothing of theirs is changed.
// ATTACH=<url> attaches to an open tab at that address instead (bring Chrome
// to the front with it first: a hidden tab is throttled)
const attach = !!process.env.ATTACH;
const attachUrl = process.env.ATTACH === "1" ? "https://howieyhy.github.io/mobilemusescore/" : process.env.ATTACH;
let page;
if (attach) {
    page = context.pages().find((p) => p.url().startsWith(attachUrl));
    if (!page) {
        console.error("PocketScore is not open on the phone");
        process.exit(1);
    }
    const s = await page.evaluate(() => ({
        standalone: matchMedia("(display-mode: standalone)").matches,
        score: document.getElementById("score-title")?.textContent,
        unsaved: !!document.getElementById("save") && !document.getElementById("save").disabled,
    }));
    console.log(`installed app: standalone ${s.standalone}, open score "${s.score || "none"}", unsaved changes ${s.unsaved}`);
    if (s.unsaved) {
        console.error("the reader has unsaved changes; not opening another score");
        process.exit(1);
    }
} else {
    page = await context.newPage();
    await page.goto(url);
}
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

try {
    let t0 = Date.now();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready") || !!window.app?.state, null, { timeout: 120000 });
    if (!attach) {
        await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 }).catch(() => {});
    }
    console.log(`app ready in ${Date.now() - t0} ms, version ${await page.evaluate(() => document.querySelector(".version, #version")?.textContent ?? "?")}`);

    t0 = Date.now();
    const b64 = fs.readFileSync(scorePath).toString("base64");
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        await app.openScore(name, bytes.buffer);
    }, { name: path.basename(scorePath), b64 });
    await page.waitForSelector(".page canvas", { timeout: 120000 });
    console.log(`score opened and page 1 drawn in ${Date.now() - t0} ms: ${await page.evaluate(() => document.getElementById("score-title").textContent)}`);
    shot("opened");

    t0 = Date.now();
    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 120000 }).catch(() => fail("playback did not start"));
    console.log(`playing after ${Date.now() - t0} ms`);
    await page.waitForTimeout(2000);

    // Watch every frame: how long it took, and where the playback line is
    await page.evaluate(() => {
        const w = (window.__watch = { frames: [], stop: false });
        const tick = (now) => {
            const c = document.querySelector(".cursor");
            const m = c && /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(c.style.transform);
            w.frames.push([now, m ? +m[1] : NaN, m ? +m[2] : NaN, app.state.position]);
            if (!w.stop) {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    });
    // SCROLL=1: a finger drags the score up and down while it plays (real touch
    // input), as a reader looking ahead would
    let scrolling = null;
    if (process.env.SCROLL) {
        const cdp = await context.newCDPSession(page);
        const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        let stop = false;
        scrolling = (async () => {
            for (let dir = 1; !stop; dir = -dir) {
                const x = vp.w / 2;
                let y = dir > 0 ? vp.h * 0.7 : vp.h * 0.3;
                await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
                for (let i = 0; i < 20; i++) {
                    y -= dir * vp.h * 0.02;
                    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
                    await new Promise((r) => setTimeout(r, 16));
                }
                await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
                await new Promise((r) => setTimeout(r, 400));
            }
        })();
        scrolling.stop = () => (stop = true);
    }
    const a = await page.evaluate(() => ({ under: app.engine.underruns, pos: app.state.position, clock: app.engine.ctx.currentTime, rate: app.engine.ctx.sampleRate, base: app.engine.ctx.baseLatency, out: app.engine.ctx.outputLatency, health: app.engine.health.length }));
    await page.waitForTimeout(playSeconds * 1000);
    if (scrolling) {
        scrolling.stop();
        await scrolling;
    }
    const b = await page.evaluate(() => {
        window.__watch.stop = true;
        return { under: app.engine.underruns, pos: app.state.position, clock: app.engine.ctx.currentTime, stats: app.engine.stats, health: app.engine.health, frames: window.__watch.frames };
    });
    shot("playing");

    const span = b.clock - a.clock;
    console.log(`audio: sample rate ${a.rate}, base latency ${(a.base * 1000).toFixed(0)} ms, output latency ${(a.out * 1000).toFixed(0)} ms`);
    console.log(`over ${playSeconds} s: audio clock +${span.toFixed(2)} s, score +${(b.pos - a.pos).toFixed(2)} s, ${b.under - a.under} sound gap(s)`);
    console.log("engine stats:", JSON.stringify(b.stats));
    for (const h of b.health.slice(a.health)) {
        console.log(`  health ${h.at} ${h.kind}: ${h.detail}`);
    }

    // Frames: long ones freeze the line; the line should move forward a little
    // every frame within a system (same y)
    const f = b.frames;
    const dts = f.slice(1).map((x, i) => x[0] - f[i][0]).sort((p, q) => p - q);
    const pct = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))].toFixed(1);
    const long = dts.filter((d) => d > 50).length;
    let still = 0, back = 0, stallMs = 0, run = 0;
    for (let i = 1; i < f.length; i++) {
        if (f[i][2] !== f[i - 1][2] || Number.isNaN(f[i][1])) {
            run = 0;
            continue; // new system or no cursor
        }
        const dx = f[i][1] - f[i - 1][1];
        if (dx < -0.5) {
            back++;
        }
        if (Math.abs(dx) < 0.01) {
            still++;
            run += f[i][0] - f[i - 1][0];
            stallMs = Math.max(stallMs, run);
        } else {
            run = 0;
        }
    }
    console.log(`frames: ${f.length} (${(f.length / playSeconds).toFixed(0)} fps), interval median ${pct(0.5)} ms, 99% ${pct(0.99)} ms, max ${dts[dts.length - 1].toFixed(0)} ms, ${long} over 50 ms`);
    console.log(`playback line: ${still} frames standing still (longest ${stallMs.toFixed(0)} ms), ${back} steps backwards`);
    fs.writeFileSync(path.join(outDir, "frames.json"), JSON.stringify(f));

    if (b.under > a.under) {
        fail("sound had gaps during steady playback");
    }
    if (span < playSeconds * 0.9) {
        fail("audio clock is not running in real time");
    }
    if (Math.abs((b.pos - a.pos) - span) > 0.4) {
        fail("score position drifts from the audio clock");
    }
    if (long > playSeconds / 10) {
        fail(`${long} frames over 50 ms`);
    }

    if (!attach) {
    await page.click("#mixer-toggle");
    await page.waitForSelector(".strip:not(.master)");
    const mutedBefore = await page.locator(".strip:not(.master) .toggle.m.on").count(); // some scores save parts muted
    const m = page.locator(".strip:not(.master) .toggle.m").nth(1);
    const wasOn = await m.evaluate((el) => el.classList.contains("on"));
    await m.click();
    await page.waitForTimeout(300);
    const muted = await page.locator(".strip:not(.master) .toggle.m.on").count();
    console.log(`mixer: ${mutedBefore} -> ${muted} part(s) muted after tapping M`);
    if (muted !== mutedBefore + (wasOn ? -1 : 1)) {
        fail("mute toggle did not apply");
    }
    shot("mixer");
    await page.click("#mixer-close");
    }

    // Jumps while playing (dragging the slider, tapping a note mid-song) must
    // not leave gaps: the refill after each jump used to run dry once or twice
    // and the self-check took that for a slow device
    const gapsBefore = await page.evaluate(() => app.engine.underruns);
    for (let i = 0; i < 8; i++) {
        await page.evaluate((s) => app.engine.seek(s), 5 + i * 7);
        await page.waitForTimeout(1500);
    }
    const seekGaps = (await page.evaluate(() => app.engine.underruns)) - gapsBefore;
    console.log(`8 jumps while playing: ${seekGaps} sound gap(s)`);
    if (seekGaps) {
        fail("jumping while playing left gaps in the sound");
    }

    await page.evaluate(() => app.engine.seek(60));
    await page.waitForTimeout(800);
    console.log(`after seek to 60 s: ${await page.evaluate(() => document.getElementById("bar").textContent)}`);
    await page.click("#play"); // pause
} catch (e) {
    fail(e.message);
} finally {
    if (!attach) {
        await page.close(); // only the test's tab; exiting drops the connection, Chrome keeps running
    }
}

console.log(failures ? `${failures} check(s) FAILED` : "all Android checks passed");
process.exit(failures ? 1 : 0);
