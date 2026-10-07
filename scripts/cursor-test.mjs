// How smoothly the playback cursor moves, on a clean audio clock and on one
// that behaves like Android's: the device takes audio in big batches, so the
// audio clock (getOutputTimestamp) only moves about 10 times a second with
// jittery timestamps, and the engine's position reports are noisy.
//
// Counts "jumps": animation frames where the cursor moved more than 40 ms of
// music away from what the frame's real duration says (or went backwards).
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/cursor-test.mjs [score.mscz] [seconds=12]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const seconds = Number(process.argv[3] || 12);
const url = process.env.APP_URL || "http://localhost:5180/";

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
let failures = 0;

// mode: "steady"; "android" (stepped, jittery output timestamps and noisy
// position reports); "android-no-timestamp" (getOutputTimestamp gives zeros,
// as on some devices, and currentTime moves only in ~100 ms batches);
// "ios-late-reports" (position reports held up and delivered in bursts, up to
// 400 ms late, as when Safari delays messages from the workers)
async function run(mode) {
    const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForSelector(".page canvas", { timeout: 180000 });
    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 180000 });

    if (mode === "ios-late-reports") {
        await page.evaluate(() => {
            const emit = app.engine.emit.bind(app.engine);
            let held = [];
            let releaseAt = 0;
            app.engine.emit = (ev, data) => {
                if (ev !== "position") {
                    return emit(ev, data);
                }
                held.push(data);
                const now = performance.now();
                if (!releaseAt) {
                    releaseAt = now + 100 + Math.random() * 300;
                }
                if (now >= releaseAt) {
                    const batch = held;
                    held = [];
                    releaseAt = 0;
                    batch.forEach((d) => emit(ev, d));
                }
            };
        });
    }
    if (mode === "android-no-timestamp") {
        await page.evaluate(() => {
            const ctx = app.engine.ctx;
            ctx.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
            const real = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "currentTime").get;
            Object.defineProperty(ctx, "currentTime", { get: () => Math.floor(real.call(ctx) / 0.1) * 0.1 });
        });
    }
    if (mode === "android") {
        await page.evaluate(() => {
            // audio clock: steps of ~100 ms, timestamps up to 15 ms late
            const ctx = app.engine.ctx;
            let last = null;
            ctx.getOutputTimestamp = () => {
                const now = performance.now();
                if (!last || now - last.perf > 100) {
                    const lag = Math.random() * 15;
                    last = { perf: now - lag, ctx: ctx.currentTime - lag / 1000 };
                }
                return { contextTime: last.ctx, performanceTime: last.perf };
            };
            // position reports: +-60 ms noise, as the queued audio swings
            const emit = app.engine.emit.bind(app.engine);
            app.engine.emit = (ev, data) => emit(ev, ev === "position" && data && typeof data.secs === "number"
                ? { ...data, secs: data.secs + (Math.random() - 0.5) * 0.12 } : data);
        });
    }

    await page.waitForTimeout(1500); // settle
    const r = await page.evaluate((secs) => new Promise((resolve) => {
        let prev = null;
        let jumps = 0;
        let back = 0;
        let frames = 0;
        const end = performance.now() + secs * 1000;
        const tick = (now) => {
            const pos = app.state.position;
            if (prev) {
                const music = pos - prev.pos;
                const real = (now - prev.now) / 1000;
                if (music < -0.001) {
                    back++;
                }
                if (Math.abs(music - real) > 0.04) {
                    jumps++;
                }
                frames++;
            }
            prev = { pos, now };
            if (now < end) {
                requestAnimationFrame(tick);
            } else {
                resolve({ jumps, back, frames });
            }
        };
        requestAnimationFrame(tick);
    }), seconds);
    await page.close();
    return r;
}

for (const mode of ["steady", "android", "android-no-timestamp", "ios-late-reports"]) {
    const r = await run(mode);
    const label = mode;
    console.log(`${label}: ${r.jumps} jumps, ${r.back} steps backwards in ${r.frames} frames`);
    if (r.jumps > r.frames * 0.01 || r.back > 0) {
        console.log(`FAIL ${label}: the cursor does not move smoothly`);
        failures++;
    }
}
await browser.close();
console.log(failures ? `${failures} failure(s)` : "cursor moves smoothly");
process.exit(failures ? 1 : 0);
