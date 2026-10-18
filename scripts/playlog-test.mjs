// The playback log (issue #31): what happened while playing is kept on the device and can be sent
// later, away from USB. Plays a score, causes a sound gap (the engine frozen on purpose) and an
// audio clock slip (the clock held back by a test hook), then checks the log has the play, the
// samples, the gap, the slip and the stop; that it survives a reload (the app closed); that the
// stutter notice and Settings' Send both produce the report (copied to the clipboard); and that the
// report stays under a GitHub comment's 65536 characters with a full log.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/playlog-test.mjs [score.mscz]

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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
// the share sheet can't be driven here: the report goes to the clipboard, as where there is none
await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true }));
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

async function openAndPlay() {
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    await page.tap("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 60000 });
}

await page.goto(url);
await page.evaluate(() => localStorage.removeItem("pocketscore.playlog"));
await page.reload();
await openAndPlay();
await page.waitForTimeout(12000);

let kinds = await page.evaluate(() => app.playLog.entries.map((e) => e.kind));
check(kinds.includes("play"), "Play is logged");
check(kinds.includes("sample"), `a sample every 10 s (${kinds.filter((k) => k === "sample").length})`);
const sample = await page.evaluate(() => app.playLog.entries.find((e) => e.kind === "sample")?.detail);
check(/engine load .*queued .*frames \d+/.test(sample || ""), `the sample has the load, queue and frames: ${sample}`);
check(!kinds.includes("audio clock slipped"), "steady playback: no clock slip");

// a gap: logged, and the notice offers the report
const t0 = await page.evaluate(() => app.engine.stats.targetSecs);
await page.evaluate((ms) => app.engine.testStall(ms), Math.round(t0 * 1000) + 400);
await page.waitForFunction(() => app.playLog.entries.some((e) => e.kind === "gap"), null, { timeout: 8000 }).catch(() => {});
check(await page.evaluate(() => app.playLog.entries.some((e) => e.kind === "gap")), "the gap is in the log");
const notice = await page.evaluate(() => ({ text: document.getElementById("status").textContent, action: document.getElementById("status").classList.contains("action") }));
check(notice.action && /send a playback report/.test(notice.text), `the stutter notice offers the report: "${notice.text}"`);

// the device's output falls behind: the audio clock is held back 600 ms
await page.evaluate(() => {
    const proto = Object.getPrototypeOf(app.engine);
    const real = Object.getOwnPropertyDescriptor(proto, "audioInfo").get;
    const from = performance.now();
    Object.defineProperty(app.engine, "audioInfo", { configurable: true, get() {
        const a = real.call(this);
        return a && { ...a, time: a.time - Math.min(0.6, (performance.now() - from) / 1000 * 0.3) };
    } });
});
await page.waitForFunction(() => app.playLog.entries.some((e) => e.kind === "audio clock slipped"), null, { timeout: 8000 }).catch(() => {});
const slip = await page.evaluate(() => app.playLog.entries.find((e) => e.kind === "audio clock slipped")?.detail);
check(!!slip, `a slip of the audio clock is logged: ${slip}`);
await page.evaluate(() => delete app.engine.audioInfo);

// the notice, tapped: the report is copied
await page.evaluate(() => { const s = document.getElementById("status"); s.hidden = false; s.click(); });
await page.waitForTimeout(500);
let clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip.startsWith("PocketScore playback report") && /sound gap/.test(clip), `tapping the notice copies the report (${clip.length} characters)`);

await page.tap("#play"); // pause
await page.waitForFunction(() => !app.state.playing, null, { timeout: 10000 });
await page.waitForTimeout(300);
const stop = await page.evaluate(() => app.playLog.entries.findLast((e) => e.kind === "stop")?.detail);
check(/played \d+ s, sound gaps [1-9]/.test(stop || ""), `the stop is logged with its gaps: ${stop}`);

// the app is closed and opened again: the log is still there
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.reload();
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
kinds = await page.evaluate(() => app.playLog.entries.map((e) => e.kind));
check(["play", "gap", "audio clock slipped", "stop", "report"].every((k) => kinds.includes(k)), `the log survives closing the app (${kinds.length} entries)`);

// Settings' Send, with no score open
await page.evaluate(() => navigator.clipboard.writeText(""));
await page.tap("#settings-open");
await page.waitForSelector("#send-report", { state: "visible" });
await page.locator("#send-report").scrollIntoViewIfNeeded();
await page.tap("#send-report");
await page.waitForTimeout(500);
clip = await page.evaluate(() => navigator.clipboard.readText());
const lines = clip.split("\n");
check(/^Version \d/.test(lines[1]) && /Running as a browser tab/.test(clip) && /Counts: .*gap [1-9]/.test(clip), `Settings' Send copies the report:\n${lines.slice(0, 9).map((l) => "       " + l).join("\n")}`);
const status = await page.evaluate(() => document.getElementById("status").textContent);
check(/copied/.test(status), `and says so: "${status}"`);

// a full log fits in a GitHub comment
const size = await page.evaluate(() => {
    for (let i = 0; i < 700; i++) {
        app.playLog.add("sample", "at 1:23: engine load 17%, slowest block 8 ms, queued 510 ms of 510 ms, level 0.31; frames 600, longest 33 ms, 0 over 50 ms, page drawing 0 ms; battery 54%");
    }
    return { n: app.playLog.entries.length, chars: app.playLog.report(["header"]).length };
});
check(size.n === 600 && size.chars < 65536, `a full log is capped (${size.n} entries, report ${size.chars} characters)`);
await page.evaluate(() => app.playLog.clear());

await browser.close();
console.log(failures ? `${failures} failure(s)` : "playback log passed");
process.exit(failures ? 1 : 0);
