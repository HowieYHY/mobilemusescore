// A double tap on Sing it in's Record must open one microphone, not two (bug-hunt finding 29), and a dialog closed
// while the microphone is being asked for must leave nothing recording (finding 30): the second
// getUserMedia replaced the first stream, whose tracks were then never stopped (the microphone stayed on,
// with the browser's recording indicator), and a second timer ticked for good. The fake microphone
// (Chromium's fake device) is wrapped to keep every stream it hands out; after Stop, every one must be ended.
//
// Needs a server: (cd app && npx vite preview --port 4173). Usage: node scripts/voice-double-record-test.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:4173/";
let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, permissions: ["microphone"] })).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.evaluate(() => {
    window.__streams = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); window.__streams.push(s); return s; };
});
// a control: one tap opens one microphone, and Stop ends it
const record = (n) => page.evaluate((times) => { for (let i = 0; i < times; i++) document.getElementById("voice-record").click(); }, n);
const live = () => page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);
await record(1);
await page.waitForFunction(() => app.voice.recorder && app.voice.recorder.state === "recording", null, { timeout: 10000 });
await page.evaluate(() => app.voice.recorder.stop());
await page.waitForFunction(() => !app.voice.recorder, null, { timeout: 5000 });
check(await live() === 0, "control: one tap, then Stop: no microphone track is left live");
// a double tap
await page.evaluate(() => { window.__streams = []; });
await record(2);
await page.waitForFunction(() => app.voice.recorder && app.voice.recorder.state === "recording", null, { timeout: 10000 });
await page.waitForTimeout(800);
const opened = await page.evaluate(() => window.__streams.length);
await page.evaluate(() => app.voice.recorder.stop());
await page.waitForFunction(() => !app.voice.recorder, null, { timeout: 5000 });
await page.waitForTimeout(300);
check(opened === 1, `a double tap opens one microphone (${opened} opened)`);
check(await live() === 0, `after Stop no microphone track is left live (${await live()} live)`);
// the dialog closed while the microphone is being asked for: nothing may be left recording
await page.evaluate(() => { window.__streams = []; });
await page.evaluate(() => {
    const dlg = document.getElementById("voice");
    if (!dlg.open) dlg.showModal();
    document.getElementById("voice-record").click();
    dlg.close(); // before the microphone answers
});
await page.waitForTimeout(1500);
check(await page.evaluate(() => !app.voice.recorder && !app.voice.stream), "closed dialog: no recorder or stream is kept");
check(await live() === 0, `closed dialog: no microphone track is left live (${await live()} live)`);
await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
