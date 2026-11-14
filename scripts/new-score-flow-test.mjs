// Building a score from nothing, layer by layer: New score (three lines), sing a tune into the Melody,
// sing another into Harmony, close the page and come back (the unsaved score is offered on the start
// screen), then save a copy. VIDEO=dir films it (phone-sized, a ring at each tap) and makes an MP4.
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const video = process.env.VIDEO;
const wav = path.join(root, "build/spike/sung-tune.wav");
execFileSync("node", [path.join(root, "scripts/voice-test.mjs")], { env: { ...process.env, VOICE_WAV: wav }, stdio: "ignore" });

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };
const pause = (ms) => (video ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    ...(video ? { recordVideo: { dir: video, size: { width: 412, height: 915 } } } : {}),
});
await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true }));
if (video) {
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
    await pause(800);
};
const ready = async () => {
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.waitForFunction(() => { const a = window.app; return !!a; });
};
const scoreReady = async () => {
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
    await page.waitForFunction(() => document.querySelectorAll("#pages canvas").length > 0, null, { timeout: 60000 });
    await page.evaluate(() => { app.settings.autoFocus = false; });
};
// the rest or note at the start of a staff: found on the page, then picked with a real touch
const pickStart = async (staff) => {
    // a phone shows one line at a time in Edit: bring this one up with the lines button, as a finger would
    if (await page.evaluate((st) => app.edit.parts.shown >= 0 && app.edit.parts.parts[app.edit.parts.shown].staff !== st, staff)) {
        await page.evaluate(() => document.getElementById("edit-partsbtn").click());
        await page.evaluate((st) => document.querySelectorAll("#parts-list button")[1 + app.edit.parts.parts.findIndex((p) => p.staff === st)].click(), staff);
        await page.waitForFunction((st) => !app.edit.busy && app.edit.parts.parts[app.edit.parts.shown]?.staff === st, staff, { timeout: 10000 });
        await pause(400);
    }
    const spot = await page.evaluate(async (st) => {
        const sp = app.state.score.spatium, p0 = app.state.score.pages[0];
        for (let y = p0.h * 0.05; y < p0.h * 0.7; y += sp / 2) {
            for (let x = p0.w * 0.05; x < p0.w * 0.9; x += sp / 2) { // a line of empty bars by itself has bar 1 far left
                const s = await app.engine.editSelect(0, x, y, sp * 0.3);
                if (s && s.staff === st && s.bar === 1) { await app.engine.editClearSelection(); return { x: s.x + s.w / 2, y: s.y + s.h / 2 }; }
            }
        }
        return null;
    }, staff);
    const pt = await page.evaluate(({ x, y }) => {
        const el = document.querySelector("#pages .page"), p0 = app.state.score.pages[0];
        el.scrollIntoView({ block: "start" });
        const r = el.getBoundingClientRect();
        return { x: r.left + x / p0.w * r.width, y: r.top + y / p0.h * r.height };
    }, spot);
    await page.evaluate(() => { app.edit.sel = null; }); // not the one from before
    await tapAt(pt.x, pt.y);
    await page.waitForFunction(() => app.edit.sel, null, { timeout: 5000 });
    await pause(900);
};
// every note of one staff from its first bar on, by pitch
const walk = async (staff) => {
    await pickStart(staff);
    // the pick can land mid-bar: go back to the first one
    for (let i = 0; i < 30; i++) {
        const s = await page.evaluate(() => app.edit.sel);
        await page.evaluate(() => document.getElementById("edit-prev").click());
        const moved = await page.waitForFunction(({ x, y }) => app.edit.sel && (app.edit.sel.x !== x || app.edit.sel.y !== y), { x: s.x, y: s.y }, { timeout: 1200 }).then(() => true, () => false);
        if (!moved) break;
    }
    const out = [];
    for (let i = 0; i < 24; i++) {
        const s = await page.evaluate(() => app.edit.sel);
        if (s.kind === "note") out.push(s.pitch);
        const before = { x: s.x, y: s.y, bar: s.bar };
        await page.evaluate(() => document.getElementById("edit-next").click());
        const moved = await page.waitForFunction(({ x, y }) => app.edit.sel && (app.edit.sel.x !== x || app.edit.sel.y !== y), before, { timeout: 2500 }).then(() => true, () => false);
        if (!moved) break;
    }
    return out;
};
const sing = async () => {
    if (await page.evaluate(() => document.getElementById("edit-more").hidden)) await tap("#edit-morebtn");
    await tap("#edit-voice");
    await page.setInputFiles("#voice-file", wav);
    await page.waitForFunction(() => !document.getElementById("voice-result").hidden, null, { timeout: 60000 });
    await page.fill("#voice-tempo", "100");
    await page.dispatchEvent("#voice-tempo", "change");
    await pause(1800);
    await tap("#voice-put");
    await page.waitForFunction(() => !app.edit.busy && app.edit.undo > 0, null, { timeout: 30000 });
    await pause(1500);
};

await page.goto(url);
await ready();
await pause(1500);
check(await page.evaluate(() => document.getElementById("resume-row").hidden), "nothing to resume on a clean start");
await tap("#new-score");
check(await page.evaluate(() => document.getElementById("newscore").open), "the New score dialog opens");
await page.fill("#ns-title", "Test tune");
check(await page.evaluate(() => document.querySelectorAll("#ns-lines .ns-line").length === 1), "a new score starts with one line");
await tap("#ns-add");
await tap("#ns-add");
await page.fill("#ns-lines .ns-line:nth-child(1) input", "Melody");
await page.fill("#ns-lines .ns-line:nth-child(2) input", "Harmony");
await page.selectOption("#ns-lines .ns-line:nth-child(3) select", "F");
await page.selectOption("#ns-key", "4");
await page.fill("#ns-bars", "12");
await pause(1500);
await tap("#ns-create");
await scoreReady();
await pause(1500);
check(await page.evaluate(() => app.state.score.title === "Test tune" && !document.getElementById("editbar").hidden), "the blank score opens straight into Edit");
check(await page.evaluate(() => app.edit.sel && app.edit.sel.kind === "rest" && app.edit.sel.staff === 0 && app.edit.sel.bar === 1), "the first rest (Melody, bar 1) is picked");

// layer 1: the Melody
await sing();
const s1 = await walk(0);
check(s1.length >= 10 && s1[0] === 72 && s1[5] === 79, "Melody has the tune, an octave up for a treble staff: " + s1.join(" "));
// layer 2: Harmony, from its own first rest
await pickStart(1);
check(await page.evaluate(() => app.edit.sel.kind === "rest" && app.edit.sel.staff === 1), "Harmony's rest is picked");
await sing();
const a1 = await walk(1);
check(a1.length >= 10, "Harmony has a tune too: " + a1.join(" "));
check((await walk(0)).join() === s1.join(), "and the Melody is as it was");
// one letter on the third line
await pickStart(2);
// the piano makes way while More is open on a phone: close it, and slide the strip to the key
if (await page.evaluate(() => !document.getElementById("edit-more").hidden)) await tap("#edit-morebtn");
await page.evaluate(() => document.querySelector('.piano-key[data-midi="67"]').scrollIntoView({ inline: "center", block: "nearest", behavior: "instant" }));
await pause(300);
await tap('.piano-key[data-midi="67"]');
await page.waitForFunction(() => !app.edit.busy && app.edit.step);
await tap("#edit-prev"); // note input moved on: back to the G
await page.waitForFunction(() => !app.edit.busy && app.edit.sel && app.edit.sel.kind === "note");
check(await page.evaluate(() => app.edit.sel.staff === 2 && /^G/.test(app.edit.sel.name)), "a piano key puts a note into the third line: " + await page.evaluate(() => app.edit.sel.name));
await pause(1500);

// come back later: the unsaved score is on the start screen
await page.waitForTimeout(1500); // the silent draft is kept 0.8 s after the last change
await page.reload();
await ready();
await pause(1500);
check(await page.evaluate(() => !document.getElementById("resume-row").hidden && /Test tune/.test(document.getElementById("resume-score").textContent)), "after closing the page, the start screen offers “Test tune”");
await tap("#resume-score");
await scoreReady();
await pause(1500);
check((await walk(0)).join() === s1.join() && (await walk(1)).join() === a1.join(), "both layers came back");
check(await page.evaluate(() => app.edit.dirty), "and it still counts as unsaved");

// save a copy: its own name, and the draft goes
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), tap("#edit-copy")]);
check(download.suggestedFilename() === "Test tune.mscz", "the copy is called " + download.suggestedFilename());
await page.waitForTimeout(800);
await pause(1500);
await page.reload();
await ready();
check(await page.evaluate(() => document.getElementById("resume-row").hidden), "once saved, nothing is left to resume");
await pause(1000);

await page.close();
await context.close();
await browser.close();
if (video) {
    const webm = fs.readdirSync(video).filter((f) => f.endsWith(".webm")).map((f) => path.join(video, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const mp4 = path.join(video, "pocketscore-new-score-demo.mp4");
    execFileSync("ffmpeg", ["-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-movflags", "+faststart", "-an", mp4], { stdio: "ignore" });
    console.log("film: " + mp4);
}
console.log(failures ? `${failures} failed` : "new score flow passed");
process.exit(failures ? 1 : 0);
