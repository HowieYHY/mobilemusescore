// Drives PocketScore in Chrome on an Android phone through adb with
// Playwright's Android support: opens a score, checks page drawing, plays it
// through the real audio path and checks timing, mixer and seeking.
//
// Needs a USB-debugging phone (or emulator) with Chrome, and adb on PATH.
// APP_URL picks the site (default: the published web app). To test a local
// build, run `npx vite preview --host` in app/ and `adb reverse tcp:4173 tcp:4173`,
// then APP_URL=http://localhost:4173/ (Chrome allows audio on localhost).
// Usage: node scripts/android-test.mjs <score.mscz> [outDir]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { _android: android } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const outDir = path.resolve(process.argv[3] || path.join(root, "build/android"));
const url = process.env.APP_URL || "https://howieyhy.github.io/mobilemusescore/";
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const fail = (m) => {
    console.error("FAIL:", m);
    failures++;
};

const [device] = await android.devices();
if (!device) {
    console.error("no Android device or emulator found");
    process.exit(1);
}
console.log(`device: ${device.model()} (${device.serial()})`);

const browser = await device.launchBrowser(); // Chrome
const page = await browser.newPage();
await page.goto(url);

try {
    let t0 = Date.now();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready") || !!window.app?.state, null, { timeout: 120000 });
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 }).catch(() => {});
    console.log(`engine ready in ${Date.now() - t0} ms`);

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
    await page.waitForTimeout(1000);
    console.log(`score opened and page 1 drawn in ${Date.now() - t0} ms`);
    console.log("title:", await page.evaluate(() => document.getElementById("score-title").textContent));
    await device.screenshot({ path: path.join(outDir, "opened.png") });

    t0 = Date.now();
    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 120000 }).catch(() => fail("playback did not start"));
    console.log(`playing after ${Date.now() - t0} ms (includes loading MS Basic)`);

    await page.waitForTimeout(3000); // emulator start-up: position updates catch up first
    const a = await page.evaluate(() => ({ under: app.engine.underruns, pos: app.state.position, clock: app.engine.ctx.currentTime, rate: app.engine.ctx.sampleRate, base: app.engine.ctx.baseLatency }));
    await page.waitForTimeout(8000);
    const b = await page.evaluate(() => ({ under: app.engine.underruns, pos: app.state.position, clock: app.engine.ctx.currentTime }));
    console.log(`audio clock +${(b.clock - a.clock).toFixed(2)} s, score position +${(b.pos - a.pos).toFixed(2)} s (sample rate ${a.rate}), `
        + `${b.under - a.under} audio gap(s)`);
    if (b.under > a.under) {
        fail("audio had gaps (underruns) during steady playback");
    }
    if (b.clock - a.clock < 6) {
        fail("audio clock is not running in real time (audio output stalled?)");
    }
    if (Math.abs((b.pos - a.pos) - (b.clock - a.clock)) > 0.4) {
        fail("score position drifts from the audio clock");
    }
    await device.screenshot({ path: path.join(outDir, "playing.png") });

    await page.click("#mixer-toggle");
    await page.waitForSelector(".strip:not(.master)");
    await page.locator(".strip:not(.master) .toggle.m").nth(1).click();
    await page.waitForTimeout(300);
    const muted = await page.locator(".strip:not(.master) .toggle.m.on").count();
    console.log(`mixer: ${muted} part(s) muted after tapping M`);
    if (muted !== 1) {
        fail("mute toggle did not apply");
    }
    await device.screenshot({ path: path.join(outDir, "mixer.png") });
    await page.click("#mixer-close");

    await page.evaluate(() => app.engine.seek(60));
    await page.waitForTimeout(800);
    const bar = await page.evaluate(() => document.getElementById("bar").textContent);
    console.log(`after seek to 60 s: ${bar}`);
    await page.click("#play"); // pause
} catch (e) {
    fail(e.message);
} finally {
    await device.close();
}

console.log(failures ? `${failures} check(s) FAILED` : "all Android checks passed");
process.exit(failures ? 1 : 0);
