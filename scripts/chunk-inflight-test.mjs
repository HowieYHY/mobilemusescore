// The buffer player must tell the audio worker about every frame that played (bug-hunt finding 28).
// The worker counts the frames it sent minus the frames the player reported as consumed ("in flight") and
// renders only while that is under its target; a frame that played but was never reported stays "in flight"
// until the next pause or seek, so the worker believes the queue is fuller than it is.
//
// The check: playing with the buffer player, count the frames the worker sent and the frames reported
// consumed (both ends of the player's port are wrapped), and compare the difference with what really is
// queued ahead of the speaker. Before a freeze the two agree within a tick; a main thread frozen for longer than
// the queue (the player starves, then restarts) must leave them in agreement too.
//
// Needs a server: (cd app && npx vite preview --port 4173). Usage: node scripts/chunk-inflight-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:4173/";
const FREEZES = Number(process.env.FREEZES || 4);
const FREEZE_MS = Number(process.env.FREEZE_MS || 900); // longer than the 512 ms queue
let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 400, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url + "?player=chunk");
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForSelector(".page canvas", { timeout: 180000 });
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 }).catch(() => {});
await page.click("#play");
await page.waitForFunction(() => app.state.playing && app.engine.player, null, { timeout: 60000 });
// count both directions on the player's port
await page.evaluate(() => {
    const p = app.engine.player;
    window.__c = { sent: 0, consumed: 0 };
    const onmsg = p.port.onmessage;
    p.port.onmessage = (e) => {
        if (e.data.type === "audio" && e.data.gen === p.gen) {
            window.__c.sent += e.data.data.length / 2;
        }
        onmsg(e);
    };
    const post = p.port.postMessage.bind(p.port);
    p.port.postMessage = (m, t) => {
        if (m.type === "consumed") {
            window.__c.consumed += m.frames;
        }
        return post(m, t);
    };
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// how many frames the worker believes are in flight, less the frames really queued: the leak
const leak = () => page.evaluate(() => {
    const p = app.engine.player;
    const real = (p.endFrame ? Math.max(0, p.endFrame - p.now) : 0) + p.pendingFrames;
    return { believed: window.__c.sent - window.__c.consumed, real, leakMs: Math.round((window.__c.sent - window.__c.consumed - real) / p.ctx.sampleRate * 1000) };
});
await sleep(4000);
// the counters started in the middle of the stream, so the queue already ahead is a constant offset: measure from it
const base = await leak();
const off = (l) => l.leakMs - base.leakMs;
// control: pretend 500 ms of played audio was never reported; the check must see it
await page.evaluate(() => { app.engine.player.lastAccounted += 24000; });
await sleep(300);
const seen = off(await leak());
check(seen > 250, `control: 500 ms of unreported audio is seen (${seen} ms)`);
await page.evaluate(() => { window.__c.consumed += 24000; }); // and put it right again
let worst = 0;
for (let i = 0; i < FREEZES; i++) {
    await page.evaluate((ms) => { const t = performance.now(); while (performance.now() - t < ms); }, FREEZE_MS);
    await sleep(2500);
    const l = await leak();
    worst = Math.max(worst, Math.abs(off(l)));
    console.log(`  after freeze ${i + 1}: worker believes ${Math.round(l.believed / 48)} ms in flight, really ${Math.round(l.real / 48)} ms; off by ${off(l)} ms`);
}
check(worst < 120, `after ${FREEZES} freezes of ${FREEZE_MS} ms the worker's count still agrees with the real queue (worst off by ${worst} ms)`);
await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
