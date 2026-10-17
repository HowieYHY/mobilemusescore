// Leaving the app while playing is silent (issue #29). Measures what reaches the speaker (an
// analyser after the engine's output gain), for every score:
//   - Keep playing off: from 60 ms after the page is hidden nothing is heard (the fade takes 30 ms);
//     without the fade the notes' release tails and the cut of the dropped queue were heard,
//   - coming back: the output is at full volume and Play is heard again,
//   - Keep playing on: the music goes on at the speaker while away.
// NOFIX=1 turns the fade off, to see the test fail without it.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/leave-silence-test.mjs [folder or score]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const arg = path.resolve(process.argv[2] || path.join(root, "real test musescores"));
const scores = fs.statSync(arg).isDirectory()
    ? fs.readdirSync(arg).filter((f) => /\.mscz$/i.test(f)).map((f) => path.join(arg, f))
    : [arg];
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const LEAVES = 3;

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
if (process.env.NOFIX) {
    await context.addInitScript(() => (window.__nofix = true));
}
const page = await context.newPage();
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });

const hide = (hidden) => page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
    return app.engine.ctx.currentTime;
}, hidden);
const setSetting = (k, v) => page.evaluate(([k, v]) => {
    const el = document.querySelector(`[data-set="${k}"]`);
    el.checked = v;
    el.dispatchEvent(new Event("change"));
}, [k, v]);
const play = async () => {
    await page.evaluate(() => app.engine.play());
    await page.waitForFunction(() => app.state.playing, null, { timeout: 20000 });
};
// The loudest sample at the speaker after `from`, on the audio clock (the analyser shows the last
// ~21 ms rendered, and the browser renders ahead of the page's clock, so times are the audio's)
const loudest = (from) => page.evaluate((from) => Math.max(0, ...window.__speaker.filter(([t]) => t > from).map(([, m]) => m)), from);
// a stretch of the score with notes sounding: some loudness at the speaker before leaving
const sounding = async () => {
    const t = await page.evaluate(() => app.engine.ctx.currentTime);
    await page.waitForFunction((t) => window.__speaker.some(([s, m]) => s > t && m > 0.01), t, { timeout: 10000 }).catch(() => {});
    return loudest(t);
};

for (const file of scores) {
    const name = path.basename(file, ".mscz");
    await page.evaluate(() => {
        app.state.pageEls.forEach((el) => (el.dataset.old = "1"));
        app.state.playbackReady = false;
    });
    await page.setInputFiles("#file-input", file);
    await page.waitForFunction(() => app.state.playbackReady && app.state.pageEls.length > 0
        && !app.state.pageEls[0].dataset.old && document.querySelector(".page canvas"), null, { timeout: 180000 });
    // the sounds are already loading; start the audio as a tap would, and listen at the speaker
    await page.evaluate(async () => {
        await app.engine.startAudio();
        await app.engine.whenRunning();
        if (window.__nofix) {
            app.engine.fadeOut = () => {};
        }
        if (!window.__speaker) {
            const e = app.engine;
            const an = e.ctx.createAnalyser();
            an.fftSize = 1024;
            (e.out || e.node).connect(an);
            const buf = new Float32Array(an.fftSize);
            window.__speaker = [];
            setInterval(() => {
                an.getFloatTimeDomainData(buf);
                let m = 0;
                for (const v of buf) m = Math.max(m, Math.abs(v));
                window.__speaker.push([e.ctx.currentTime, m]);
                if (window.__speaker.length > 2000) window.__speaker.splice(0, 1000);
            }, 15);
        }
    });

    // a score saved with every part muted ("Make me wanna smoke") has nothing to hear
    await play();
    await page.waitForTimeout(1500);
    const audible = (await sounding()) > 0.01;
    await page.evaluate(() => app.engine.pause());
    await page.waitForFunction(() => !app.state.playing);
    if (!audible) {
        console.log(`----  ${name}: silent when played (every part muted in the score), skipped`);
        continue;
    }

    // Keep playing off: silent from just after leaving
    await setSetting("keepPlaying", false);
    const heard = [];
    let before = 0;
    for (let i = 0; i < LEAVES; i++) {
        await play();
        await page.waitForTimeout(1500 + i * 400);
        before = Math.max(before, await sounding());
        const t0 = await hide(true);
        await page.waitForTimeout(1200);
        heard.push(await loudest(t0 + 0.03 + 0.03)); // the fade, then a full analyser window
        await hide(false);
        await page.waitForTimeout(300);
    }
    const max = Math.max(...heard);
    check(before > 0.01 && max < 0.001, `${name}: leaving while playing is silent (loudest after leaving ${heard.map((v) => v.toFixed(4)).join(", ")}; playing ${before.toFixed(3)})`);
    check(!(await page.evaluate(() => app.state.playing)), `${name}: and the music is paused`);

    // back: Play is heard again
    await play();
    await page.waitForTimeout(1000);
    const back = await sounding();
    check(back > 0.01, `${name}: after coming back, Play is heard (${back.toFixed(3)})`);
    await page.evaluate(() => app.engine.pause());
    await page.waitForFunction(() => !app.state.playing);

    // back, stopped: the output is at full volume again, so a tapped note is heard (the fade is the
    // only thing between the engine and the speaker)
    const gain = await page.evaluate(() => app.engine.out ? app.engine.out.gain.value : 1);
    check(gain === 1, `${name}: after coming back, the output is at full volume (${gain})`);

    // Keep playing on: the music goes on at the speaker
    await setSetting("keepPlaying", true);
    await page.evaluate(() => app.engine.seek(Math.min(20, app.state.duration / 3))); // where the music sounds
    await play();
    await sounding();
    const t2 = await hide(true);
    await page.waitForTimeout(2000);
    const away = await loudest(t2 + 0.06);
    check(away > 0.01 && (await page.evaluate(() => app.state.playing)), `${name}: Keep playing on, the music is heard while away (${away.toFixed(3)})`);
    await hide(false);
    await page.evaluate(() => app.engine.pause());
    await page.waitForFunction(() => !app.state.playing);
    await setSetting("keepPlaying", false);
}

await browser.close();
console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
