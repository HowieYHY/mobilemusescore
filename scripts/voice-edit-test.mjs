// Sing it in, end to end in the browser: pick a rest, choose a recording (a synthetic sung tune, written by
// voice-test.mjs), check the notes it shows, put them in the score, and undo in one step.
// VIDEO=dir films it (phone-sized, with a ring where each tap lands) and converts the film to MP4 with ffmpeg.
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/Paper Hearts.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const video = process.env.VIDEO;
const wav = path.join(root, "build/spike/sung-tune.wav");
execFileSync("node", [path.join(root, "scripts/voice-test.mjs")], { env: { ...process.env, VOICE_WAV: wav }, stdio: "ignore" });

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };
const pause = (ms) => (video ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// a microphone that needs no question and no room: Chrome's own stand-in (it beeps once a second)
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    ...(video ? { recordVideo: { dir: video, size: { width: 412, height: 915 } } } : {}),
});
if (video) {
    // a ring where a finger lands, so the film shows what was tapped
    await context.addInitScript(() => {
        addEventListener("DOMContentLoaded", () => {
            const style = document.createElement("style");
            style.textContent = "@keyframes tapring{from{transform:translate(-50%,-50%) scale(.4);opacity:.9}to{transform:translate(-50%,-50%) scale(1.6);opacity:0}}.tapring{position:fixed;z-index:99999;width:44px;height:44px;border-radius:50%;border:3px solid #ff7a1a;background:rgba(255,122,26,.25);pointer-events:none;animation:tapring .55s ease-out forwards}";
            document.head.appendChild(style);
        });
        addEventListener("pointerdown", (e) => {
            const d = document.createElement("div");
            d.className = "tapring";
            d.style.left = e.clientX + "px";
            d.style.top = e.clientY + "px";
            document.body.appendChild(d);
            setTimeout(() => d.remove(), 700);
        }, true);
    });
}
const page = await context.newPage();
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
const session = await context.newCDPSession(page);
const tapAt = async (x, y) => {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const tap = async (selector) => {
    const box = await page.evaluate((sel) => { document.querySelector(sel).scrollIntoView({ block: "nearest" }); const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
    await tapAt(box.x, box.y);
    await pause(900);
};
const idle = () => page.waitForFunction(() => !app.edit.busy, null, { timeout: 30000 });

await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await pause(1200);
await page.setInputFiles("#file-input", scorePath);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
await page.waitForFunction(() => document.querySelectorAll("#pages canvas").length > 0, null, { timeout: 60000 });
await page.evaluate(() => { app.settings.autoFocus = false; }); // the bars stay while the film is made
await pause(1500);

await tap("#edit-toggle");
check(await page.evaluate(() => document.getElementById("edit-voice").disabled), "the mic button waits for a note or rest to be picked");

// the Bass's first bar (a whole-bar rest): where the tune will start
const spot = await page.evaluate(async () => {
    const sp = app.state.score.spatium, p0 = app.state.score.pages[0];
    for (let y = p0.h * 0.1; y < p0.h * 0.5; y += sp / 2) {
        for (let x = p0.w * 0.25; x < p0.w * 0.8; x += sp / 2) {
            const s = await app.engine.editSelect(0, x, y, sp * 0.3);
            if (s && s.kind === "rest" && s.staff === 4 && s.bar === 1) { await app.engine.editClearSelection(); return { x, y }; }
        }
    }
    return null;
});
check(!!spot, "found the Bass rest in bar 1");
const pt = await page.evaluate(({ x, y }) => {
    const el = document.querySelector("#pages .page"), p0 = app.state.score.pages[0];
    el.scrollIntoView({ block: "start" });
    const r = el.getBoundingClientRect();
    return { x: r.left + x / p0.w * r.width, y: r.top + y / p0.h * r.height };
}, spot);
await tapAt(pt.x, pt.y);
await page.waitForFunction(() => app.edit.sel, null, { timeout: 5000 });
await pause(1200);
check(await page.evaluate(() => app.edit.sel.kind === "rest" && !document.getElementById("edit-voice").disabled), "with the rest picked, the mic button is on");

if (await page.evaluate(() => document.getElementById("edit-more").hidden)) await tap("#edit-morebtn");
await tap("#edit-voice");
check(await page.evaluate(() => document.getElementById("voice").open), "the Sing it in dialog opens");
await pause(1200);

// issue #35: the dialog says where the tune goes, and starts at the speed of the picked bar with the metronome on
const opened = await page.evaluate(async () => {
    let bpm = (await app.engine.tempos())[0]?.[1] || 120;
    while (bpm < 50) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    return { where: document.getElementById("voice-where").textContent, part: app.edit.sel.part, tempo: document.getElementById("voice-tempo").value, want: String(Math.round(bpm)), on: document.getElementById("voice-click").checked };
});
check(opened.where.includes(`${opened.part}, bar 1`) && /carries on into the next bars/.test(opened.where), "it says which line and bar the tune goes into: " + opened.where);
check(opened.tempo === opened.want, `the speed starts as the picked bar's own (${opened.tempo}, the score says ${opened.want})`);
check(opened.on, "the metronome is on to start with");
// Record: the metronome beeps at that speed while the microphone is on
await page.fill("#voice-tempo", "120");
await page.dispatchEvent("#voice-tempo", "change");
await tap("#voice-record");
await page.waitForFunction(() => !document.getElementById("voice-rec").hidden, null, { timeout: 10000 });
await page.waitForTimeout(3000);
const beat = await page.evaluate(() => ({ clicks: app.voice.clicks, state: app.voice.metro?.ctx.state, locked: document.getElementById("voice-tempo").disabled }));
check(beat.state === "running" && beat.clicks >= 5 && beat.clicks <= 8, `after 3 s at 120 it has beeped about 6 times, its sound running (${beat.clicks}, ${beat.state})`);
check(beat.locked, "the speed can't be changed under the singer");
await tap("#voice-click");
await page.waitForTimeout(500); // beeps already on their way still count
const quiet0 = await page.evaluate(() => app.voice.clicks);
await page.waitForTimeout(2000);
check(await page.evaluate((n) => app.voice.clicks === n && !document.getElementById("voice-click").checked, quiet0), "switched off, the beeps stop while the recording goes on");
await tap("#voice-click");
await tap("#voice-stop");
await page.waitForFunction(() => document.getElementById("voice-rec").hidden && !app.voice.metro && !app.voice.stream && !/Listening/.test(document.getElementById("voice-status").textContent), null, { timeout: 30000 });
check(await page.evaluate(() => !document.getElementById("voice-tempo").disabled && !document.getElementById("voice-source").hidden), "Stop ends the beeps and the microphone, and Record is back: " + await page.evaluate(() => document.getElementById("voice-status").textContent));
if (process.env.SHOT_DIALOG) await page.screenshot({ path: process.env.SHOT_DIALOG });

await page.setInputFiles("#voice-file", wav);
await page.waitForFunction(() => !document.getElementById("voice-result").hidden, null, { timeout: 60000 });
await pause(2500);
const summary = await page.evaluate(() => document.getElementById("voice-status").textContent);
check(/^10 notes/.test(summary), "the tune is found: " + summary);
check(await page.evaluate(() => { const c = document.getElementById("voice-roll"); return c.width > 100 && c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0); }), "the notes are drawn");
// the tune was sung at 100 beats a minute; the score's own speed is the starting point
await page.fill("#voice-tempo", "100");
await page.dispatchEvent("#voice-tempo", "change");
await pause(1500);
await tap("#voice-oct-up");
await tap("#voice-oct-down");
await pause(1000);

await tap("#voice-put");
await page.waitForFunction(() => !app.edit.busy && app.edit.undo > 0, null, { timeout: 30000 });
await pause(1800);
// walk the new notes: the first is selected
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
const pitches = [];
for (let i = 0; i < 16; i++) {
    const s = await page.evaluate(() => app.edit.sel);
    if (!s) break;
    if (s.kind === "note") pitches.push(s.pitch);
    else if (pitches.length >= 10) break;
    await tap("#edit-next");
    await page.waitForFunction(({ x, y }) => app.edit.sel && (app.edit.sel.x !== x || app.edit.sel.y !== y), { x: s.x, y: s.y }, { timeout: 4000 }).catch(() => {});
}
check(JSON.stringify(pitches.slice(0, 11)) === JSON.stringify([48, 50, 52, 52, 53, 55, 53, 52, 52, 50, 48]), "the notes are in the score, an octave down for the Bass clef, the one over the bar line tied: " + pitches.join(" "));
check(await page.evaluate(() => app.edit.undo === 1), "all of it is one undo step");
await pause(1500);

await tap("#edit-undo");
await idle();
await pause(1500);
const back = await page.evaluate(async ({ x, y }) => (await app.engine.editSelect(0, x, y, app.state.score.spatium * 0.3)), spot);
check(back && back.kind === "rest", "Undo takes the whole tune out again");
await pause(1500);

await page.close();
await context.close();
await browser.close();
if (video) {
    const webm = fs.readdirSync(video).filter((f) => f.endsWith(".webm")).map((f) => path.join(video, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const mp4 = path.join(video, "pocketscore-voice-demo.mp4");
    execFileSync("ffmpeg", ["-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-movflags", "+faststart", "-an", mp4], { stdio: "ignore" });
    console.log("film: " + mp4);
}
console.log(failures ? `${failures} failed` : "voice edit passed");
process.exit(failures ? 1 : 0);
