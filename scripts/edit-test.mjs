// Edit mode in the browser, with real touch: select a note by tapping it, change pitch and length,
// delete, undo, and save a copy; checks the page redraws and the copy opens again.
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
// Usage: node scripts/edit-test.mjs [score.mscz]   (SHOTS=dir keeps screenshots)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium, webkit } = require("playwright");
const engineOf = process.env.BROWSER === "webkit" ? webkit : chromium; // BROWSER=webkit for Safari's engine
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/Paper Hearts.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

// CDP=http://127.0.0.1:9333 drives a real Chrome (the Android emulator's: adb forward tcp:9333
// localabstract:chrome_devtools_remote, adb reverse tcp:5180 tcp:5180) instead of a desktop Chromium.
const cdp = process.env.CDP;
let browser, context, page;
if (cdp) {
    browser = await chromium.connectOverCDP(cdp);
    context = browser.contexts()[0];
    page = context.pages().find((p) => p.url().startsWith(url)) || context.pages()[0];
    await page.reload();
} else {
    browser = await engineOf.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    context = await browser.newContext({
        viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, acceptDownloads: true,
        userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true }));
    page = await context.newPage();
}
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
// real touch events, through the browser's own input path (also in a real Chrome over CDP)
const session = await context.newCDPSession(page);
const tapAt = async (x, y) => {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const tap = async (selector) => {
    const box = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
    await tapAt(box.x, box.y);
};
const shot = async (name) => shots && page.screenshot({ path: path.join(shots, name + ".png") });

if (!cdp) await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
await page.waitForFunction(() => document.querySelectorAll("#pages canvas").length > 0, null, { timeout: 60000 });

check(await page.evaluate(() => !document.getElementById("edit-toggle").disabled), "Edit is available once a score is open");
await tap("#edit-toggle");
check(await page.evaluate(() => !document.getElementById("editbar").hidden), "the edit bar shows");
check(await page.evaluate(() => document.getElementById("edit-info").textContent.includes("Tap a note")), "it says what to do");
check(await page.evaluate(() => ["edit-up", "edit-down", "edit-delete", "edit-prev"].every((i) => document.getElementById(i).disabled)), "note controls are off until something is selected");
await shot("1-edit-open");

// find a note's place with the engine, then tap it on screen
const spot = await page.evaluate(async () => {
    const info = app.state.score, sp = info.spatium, p0 = info.pages[0];
    for (let y = p0.h * 0.1; y < p0.h * 0.6; y += sp / 2) {
        for (let x = p0.w * 0.25; x < p0.w * 0.8; x += sp) {
            const s = await app.engine.editSelect(0, x, y, sp * 0.4);
            if (s && s.kind === "note") { await app.engine.editClearSelection(); return { x, y, pitch: s.pitch }; }
        }
    }
    return null;
});
check(!!spot, "found a note to tap");
const screenPoint = () => page.evaluate(({ x, y }) => {
    const el = document.querySelector("#pages .page"), p0 = app.state.score.pages[0];
    el.scrollIntoView({ block: "start" });
    const r2 = el.getBoundingClientRect();
    return { x: r2.left + x / p0.w * r2.width, y: r2.top + y / p0.h * r2.height };
}, spot);
let pt = await screenPoint();
await tapAt(pt.x, pt.y);
await page.waitForFunction(() => app.edit.sel, null, { timeout: 5000 }).catch(() => {});
let sel = await page.evaluate(() => app.edit.sel);
check(sel && sel.kind === "note" && sel.pitch === spot.pitch, `a touch tap selects the note (${sel?.name}, pitch ${sel?.pitch})`);
check(await page.evaluate(() => !!document.querySelector(".edit-sel")), "the note is outlined");
check(await page.evaluate(() => !document.getElementById("edit-up").disabled), "note controls are on");
await shot("2-selected");

const times = [];
let t0 = 0;
const idle = async () => { await page.waitForFunction(() => !app.edit.busy, null, { timeout: 20000 }); times.push(Date.now() - t0); };
const tapAndWait = async (selector) => { t0 = Date.now(); await tap(selector); await idle(); };
await tapAndWait("#edit-up");
sel = await page.evaluate(() => app.edit.sel);
check(sel.pitch === spot.pitch + 1, `Higher: ${spot.pitch} -> ${sel.pitch} (${sel.name})`);
await tap("#edit-octave"); await tap("#edit-down"); await idle();
sel = await page.evaluate(() => app.edit.sel);
check(sel.pitch === spot.pitch + 1 - 12, `Octave + Lower: -> ${sel.pitch}`);
check(await page.evaluate(() => !document.getElementById("edit-undo").disabled), "Undo is on after an edit");
await tap("#edit-undo"); await idle(); await tap("#edit-undo"); await idle();
check(await page.evaluate(() => document.getElementById("edit-undo").disabled), "Undo is off when everything is undone");
check(await page.evaluate(() => !document.getElementById("edit-redo").disabled), "Redo is on");
await tap("#edit-redo"); await idle(); await tap("#edit-redo"); await idle();
await tap("#edit-undo"); await idle(); await tap("#edit-undo"); await idle();

// undo drops the selection: tap the note again
pt = await screenPoint();
await tapAt(pt.x, pt.y);
await page.waitForFunction(() => app.edit.sel, null, { timeout: 5000 }).catch(() => {});
sel = await page.evaluate(() => app.edit.sel);
check(sel && sel.pitch === spot.pitch, `back to the original pitch ${sel?.pitch}`);

const den0 = sel.den, target = den0 === 8 ? 4 : 8;
await tapAndWait(`.len[data-den="${target}"]`);
sel = await page.evaluate(() => app.edit.sel);
check(sel && sel.den === target, `length 1/${den0} -> 1/${sel?.den}`);
check(await page.evaluate((t) => document.querySelector(`.len[data-den="${t}"]`).getAttribute("aria-checked") === "true", target), "the chosen length is marked");
await shot("3-edited");

await tap("#edit-delete"); await idle();
sel = await page.evaluate(() => app.edit.sel);
check(sel === null || sel.kind === "rest", `Delete leaves a rest (${sel?.kind})`);

// phase 2: a note goes onto the rest through the letter buttons; the bar keeps its height
check(await page.evaluate(() => document.querySelectorAll("#edit-letters button").length === 8 && !document.getElementById("edit-letters").offsetParent === false), "a rest shows the seven note letters and the rest key");
check(await page.evaluate(() => document.getElementById("edit-up").offsetParent === null), "the pitch buttons make room for them");
const barH = await page.evaluate(() => document.getElementById("editbar").getBoundingClientRect().height);
const restSel = sel;
const inputDen = await page.evaluate(() => app.edit.len.den); // note input: the chosen length, as desktop's
await tapAndWait('#edit-letters button[aria-label="Put a E here"]');
const moved = await page.evaluate(() => app.edit.sel);
check(moved && (moved.x !== restSel.x || moved.bar !== restSel.bar), "the letter moved the selection on to the next place");
await tap("#edit-prev"); // back to the E (moving is not an edit: wait for the selection itself)
await page.waitForFunction((m) => app.edit.sel && app.edit.sel.x !== m.x, moved, { timeout: 5000 }).catch(() => {});
sel = await page.evaluate(() => app.edit.sel);
check(sel && sel.kind === "note" && /^E/.test(sel.name) && sel.den === inputDen && sel.bar === restSel.bar, `E entered on the rest: ${sel?.name}, 1/${sel?.den}, bar ${sel?.bar}`);
check(Math.abs(sel.pitch - spot.pitch) <= 12, `in the octave near the music (pitch ${sel?.pitch}, neighbours ${spot.pitch})`);
const barH2 = await page.evaluate(() => document.getElementById("editbar").getBoundingClientRect().height);
check(Math.abs(barH - barH2) < 1, `the edit bar keeps its height (${barH} -> ${barH2})`);
await tap("#edit-up"); await idle(); // back on the new note, it can be adjusted
sel = await page.evaluate(() => app.edit.sel);
check(sel && sel.kind === "note", `the new note can be moved (${sel?.name})`);
await tap("#edit-undo"); await idle(); await tap("#edit-undo"); await idle(); // pitch, then the entry: the rest is back
pt = await screenPoint();
await tapAt(pt.x, pt.y);
await page.waitForFunction(() => app.edit.sel, null, { timeout: 5000 }).catch(() => {});
sel = await page.evaluate(() => app.edit.sel);
check(sel && sel.kind === "rest", `undoing the entry gives the rest back (${sel?.kind})`);
await shot("3b-entered");
const beforeNext = await page.evaluate(() => ({ x: app.edit.sel.x, y: app.edit.sel.y }));
await tap("#edit-next");
await page.waitForFunction(({ x, y }) => app.edit.sel && (app.edit.sel.x !== x || app.edit.sel.y !== y), beforeNext, { timeout: 4000 }).catch(() => {});
check(await page.evaluate(({ x, y }) => app.edit.sel.x !== x || app.edit.sel.y !== y, beforeNext), "Next moves to another note");
await tap("#edit-prev");
await page.waitForFunction(({ x, y }) => app.edit.sel && app.edit.sel.x === x && app.edit.sel.y === y, beforeNext, { timeout: 4000 }).catch(() => {});
check(await page.evaluate(({ x, y }) => app.edit.sel.x === x && app.edit.sel.y === y, beforeNext), "Previous comes back");

// the copy
check(await page.evaluate(() => !document.getElementById("edit-copy").disabled), "Save a copy is on after edits");
let out = "";
if (cdp) {
    await tap("#edit-copy");
    await page.waitForFunction(() => document.getElementById("edit-copy").disabled, null, { timeout: 20000 });
    check(/Saved a copy/.test(await page.evaluate(() => document.getElementById("status").textContent)), "a copy is saved: " + await page.evaluate(() => document.getElementById("status").textContent));
} else {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), tap("#edit-copy")]);
    out = path.join(root, "build/spike", download.suggestedFilename().replace(/[^\w. ()-]/g, "_"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await download.saveAs(out);
    const bytes = fs.readFileSync(out);
    check(/\(edited\)\.mscz$/.test(download.suggestedFilename()) && bytes[0] === 0x50 && bytes[1] === 0x4b, `a copy is downloaded: ${download.suggestedFilename()} (${bytes.length} bytes)`);
    check(await page.evaluate(() => document.getElementById("edit-copy").disabled), "nothing left unsaved after the copy");
}

await tap("#edit-done");
await page.waitForFunction(() => document.getElementById("editbar").hidden, null, { timeout: 3000 }).catch(() => {}); // Back closes it through history
check(await page.evaluate(() => document.getElementById("editbar").hidden && !document.documentElement.classList.contains("editing")), "Done closes the bar");
await shot("4-done");

if (out) {
    // the copy opens
    await page.setInputFiles("#file-input", out);
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
    check(true, "the copy opens in PocketScore again");
}
console.log(`time from tap to the redrawn score (ms): ${times.join(", ")}`);
if (!cdp) await browser.close();
console.log(failures ? `${failures} failed` : "edit mode passed");
process.exit(failures ? 1 : 0);
