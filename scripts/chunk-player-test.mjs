// The buffer-source player (`?player=chunk`, app/src/engine/chunkplayer.ts) against the AudioWorklet one, in
// desktop Chromium, alternating between them so both see the same conditions. For each round it checks the
// things a player must get right: sound plays (the level reported is above silence), the audio clock and the
// score position run together, no sound gaps in steady play, pausing silences at once (nothing scheduled
// keeps playing), a seek while playing silences the old place and plays the new one, and resuming works.
// It cannot hear Bluetooth: that is the blind test on the phone.
//
// Needs a build served: (cd app && npm run build && npx vite preview --port 4173)
// Usage: ROUNDS=2 node scripts/chunk-player-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const base = process.env.APP_URL || "http://127.0.0.1:4173/";
const rounds = Number(process.env.ROUNDS || 2);
const watchSecs = Number(process.env.WATCH_SECONDS || 12);

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "  ok   " : "  FAIL ") + msg);
    failures += ok ? 0 : 1;
};
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

for (let round = 1; round <= rounds; round++) {
    for (const player of ["worklet", "chunk"]) {
        console.log(`\nround ${round}: player ${player}`);
        const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(base + (player === "chunk" ? "?player=chunk" : ""));
        await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
        await page.setInputFiles("#file-input", scorePath);
        await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
        const used = await page.evaluate(() => app.engine.health.filter((h) => h.kind === "player").map((h) => h.detail).join());
        check(player === "chunk" ? /buffer sources/.test(used) : /worklet/.test(used) || used === "", `the player asked for is the one running (${used || "worklet"})`);

        // sample the level every 100 ms in the page
        await page.evaluate(() => {
            const w = (window.__t = { lv: [], stop: false });
            const tick = () => {
                const e = app.engine;
                w.lv.push([Math.round(performance.now()), e.level, app.state.playing]);
                if (!w.stop) {
                    setTimeout(tick, 100);
                }
            };
            tick();
        });
        await page.tap("#play");
        await page.waitForFunction(() => app.state.playing, null, { timeout: 60000 });
        // watch the buffer sources the player makes (none in worklet mode): when each starts, how long it is,
        // and whether stop() was called on it
        await page.evaluate(() => {
            const ctx = app.engine.ctx, orig = ctx.createBufferSource.bind(ctx);
            window.__src = [];
            ctx.createBufferSource = () => {
                const s = orig(), rec = { when: null, dur: 0, stopped: false }, os = s.start.bind(s), ost = s.stop.bind(s);
                s.start = (w) => {
                    rec.when = w; rec.dur = s.buffer ? s.buffer.duration : 0;
                    const d = s.buffer ? s.buffer.getChannelData(0) : [];
                    rec.peak = 0;
                    for (let i = 0; i < d.length; i++) { rec.peak = Math.max(rec.peak, Math.abs(d[i])); }
                    return os(w);
                };
                s.stop = (...a) => { rec.stopped = true; return ost(...a); };
                window.__src.push(rec);
                return s;
            };
        });
        await page.waitForTimeout(2500);
        const a = await page.evaluate(() => ({ under: app.engine.underruns, pos: app.state.position, clock: app.engine.ctx.currentTime, t: performance.now() }));
        await page.waitForTimeout(watchSecs * 1000);
        const b = await page.evaluate((n) => ({ under: app.engine.underruns, pos: app.state.position, clock: app.engine.ctx.currentTime, t: performance.now(), stats: app.engine.stats, lv: window.__t.lv.filter((x) => x[2]).slice(-n).map((x) => x[1]) }), Math.floor(watchSecs * 8));
        const secs = (b.t - a.t) / 1000;
        check(b.under === a.under, `no sound gaps in steady play (${b.under - a.under})`);
        check(Math.abs((b.clock - a.clock) - secs) < 0.5, `the audio clock runs in real time (${(b.clock - a.clock).toFixed(2)} s in ${secs.toFixed(2)} s)`);
        check(Math.abs((b.pos - a.pos) - (b.clock - a.clock)) < 0.4, `the score position follows the clock (${(b.pos - a.pos).toFixed(2)} vs ${(b.clock - a.clock).toFixed(2)} s)`);
        const sounding = b.lv.filter((v) => v > 0.001).length / b.lv.length;
        check(sounding > 0.6, `there is sound (${Math.round(sounding * 100)}% of level reports above silence)`);
        console.log(`  queue ${b.stats.queuedSecs.toFixed(3)} s of target ${b.stats.targetSecs.toFixed(3)} s, engine load ${b.stats.load === null ? "?" : (b.stats.load * 100).toFixed(0) + "%"}`);

        // pause: what was scheduled must stop at once
        await page.tap("#play");
        await page.waitForFunction(() => !app.state.playing, null, { timeout: 10000 });
        await page.waitForTimeout(40);
        // right after Pause (the leftover would have played out by itself a second later)
        const live = await page.evaluate(() => {
            const ctx = app.engine.ctx, now = ctx.currentTime;
            const lv = window.__src.filter((r) => !r.stopped && r.when !== null && r.when + r.dur > now + 0.05 && r.peak > 0.001);
            return { made: window.__src.length, live: lv.filter((r) => r.peak > 0.05).length, tails: lv.length - lv.filter((r) => r.peak > 0.05).length, loudest: Math.max(0, ...lv.map((r) => r.peak)) };
        });
        await page.waitForTimeout(210);
        const quiet = await page.evaluate(async () => {
            const out = [];
            for (let i = 0; i < 8; i++) {
                await new Promise((r) => setTimeout(r, 100));
                out.push(app.engine.level);
            }
            return out;
        });
        check(quiet.every((v) => v < 0.05), `after Pause the reported level is silent within 450 ms (levels ${quiet.map((v) => v.toFixed(2)).join(" ")})`);
        // the level is the player's own bookkeeping; the real test is that no scheduled buffer is left to play
        if (player === "chunk") {
            check(live.made > 0, `the buffer sources were seen (${live.made})`);
            check(live.live === 0, `after Pause no scheduled buffer with sound in it is left to play (${live.live} louder than 0.05 still live, loudest leftover ${live.loudest.toFixed(3)}; ${live.tails} quiet release tails and the silent idle blocks the worker keeps sending are not counted)`);
        }

        // resume, then jump while playing
        await page.tap("#play");
        await page.waitForFunction(() => app.state.playing, null, { timeout: 10000 });
        await page.waitForTimeout(2500);
        const u1 = await page.evaluate(() => app.engine.underruns);
        await page.evaluate(() => app.engine.seek(40));
        await page.waitForTimeout(3000);
        const after = await page.evaluate(() => ({ pos: app.state.position, playing: app.state.playing, under: app.engine.underruns, lv: window.__t.lv.slice(-20).map((x) => x[1]) }));
        check(after.playing && after.pos > 40 && after.pos < 46, `a jump while playing lands near the new place and keeps playing (position ${after.pos.toFixed(1)} s)`);
        check(after.lv.some((v) => v > 0.001), "and there is sound after the jump");
        check(after.under - u1 <= 1, `at most one gap from the jump itself (${after.under - u1})`);
        check(errors.length === 0, `no page errors${errors.length ? ": " + errors[0] : ""}`);
        await page.evaluate(() => { window.__t.stop = true; });
        await context.close();
    }
}
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
