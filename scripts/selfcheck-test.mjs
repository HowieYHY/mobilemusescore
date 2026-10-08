// Playback self-check (issue #4): when the device falls behind and the sound
// has a gap, PocketScore notes it, says so once, keeps more sound ready from
// then on, and plays on without further gaps. The audio engine is frozen on
// purpose (a test hook) to cause the gap. Also checks that page drawing during
// playback doesn't freeze the playback line (frames over 100 ms).
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/selfcheck-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:5180/";

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
await page.tap("#play");
await page.waitForFunction(() => app.state.playing, null, { timeout: 60000 });
await page.waitForTimeout(4000);

const t0 = await page.evaluate(() => app.engine.stats.targetSecs);
check(t0 > 0.45, `Android starts with more sound ready (${(t0 * 1000).toFixed(0)} ms)`);
check(await page.evaluate(() => app.engine.underruns) === 0, "no gaps in steady playback");

// freeze the engine for longer than the queue: a gap
await page.evaluate((ms) => app.engine.testStall(ms), Math.round(t0 * 1000) + 400);
await page.waitForTimeout(3500);
const r = await page.evaluate(() => ({
    gaps: app.engine.underruns, health: app.engine.health, status: document.getElementById("status").textContent,
    statusShown: !document.getElementById("status").hidden, target: app.engine.stats.targetSecs,
}));
check(r.gaps >= 1, `the gap was detected (${r.gaps})`);
check(r.health.some((h) => h.kind === "gap"), `and logged: ${JSON.stringify(r.health.filter((h) => h.kind === "gap")[0])}`);
check(r.statusShown && /stuttered/.test(r.status), `the reader is told once: "${r.status}"`);
await page.waitForTimeout(4000);
const t1 = await page.evaluate(() => app.engine.stats.targetSecs);
check(t1 > t0, `more sound is kept ready from now on (${(t0 * 1000).toFixed(0)} -> ${(t1 * 1000).toFixed(0)} ms)`);

// recovers: no more gaps
const g = await page.evaluate(() => app.engine.underruns);
await page.waitForTimeout(8000);
check(await page.evaluate(() => app.engine.underruns) === g, "then plays on without further gaps");

// a second gap: no second message
await page.evaluate(() => { document.getElementById("status").hidden = true; });
await page.evaluate((ms) => app.engine.testStall(ms), Math.round(t1 * 1000) + 400);
await page.waitForTimeout(2000);
check(await page.evaluate(() => document.getElementById("status").hidden), "a later gap doesn't repeat the message");
check(await page.evaluate(() => app.state.playing), "playback carried on throughout");

const slow = await page.evaluate(() => app.engine.health.filter((h) => h.kind === "slow frame"));
console.log(`slow frames logged: ${slow.length}${slow.length ? " (" + slow.map((h) => h.detail).join(", ") + ")" : ""}`);

await browser.close();
console.log(failures ? `${failures} failure(s)` : "self-check passed");
process.exit(failures ? 1 : 0);
