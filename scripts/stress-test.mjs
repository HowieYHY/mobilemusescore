// Plays a score in Chromium with the CPU slowed down (DevTools throttling) to
// mimic slower phones, and reports audio underruns (gaps you would hear) and
// how smoothly the page animates.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/stress-test.mjs <score.mscz> [slowdown=4] [seconds=20]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const rate = Number(process.argv[3] || 4);
const seconds = Number(process.argv[4] || 20);
const url = process.env.APP_URL || "http://localhost:5180/";

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
const page = await context.newPage();

// slow every thread of the page down: main thread and its workers/worklets
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate });

await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForSelector(".page canvas", { timeout: 180000 });
await page.click("#play");
await page.waitForFunction(() => app.state.playing, null, { timeout: 180000 });
await page.waitForTimeout(2000);

const r = await page.evaluate(async (secs) => {
    const u0 = app.engine.underruns;
    const c0 = app.engine.audioTime;
    const p0 = app.state.position;
    const frames = [];
    let last = performance.now();
    await new Promise((resolve) => {
        const end = last + secs * 1000;
        function tick(now) {
            frames.push(now - last);
            last = now;
            now < end ? requestAnimationFrame(tick) : resolve();
        }
        requestAnimationFrame(tick);
    });
    frames.sort((a, b) => a - b);
    return {
        underruns: app.engine.underruns - u0,
        audio: app.engine.audioTime - c0,
        position: app.state.position - p0,
        fps: frames.length / secs,
        p95: frames[Math.floor(frames.length * 0.95)],
        worst: frames[frames.length - 1],
    };
}, seconds);

console.log(`CPU slowed ${rate}x, ${seconds}s: underruns ${r.underruns}, audio clock +${r.audio.toFixed(2)}s, `
    + `score +${r.position.toFixed(2)}s, ${r.fps.toFixed(0)} fps (95% of frames under ${r.p95.toFixed(0)} ms, worst ${r.worst.toFixed(0)} ms)`);
await browser.close();
process.exit(r.underruns > 0 ? 1 : 0);
