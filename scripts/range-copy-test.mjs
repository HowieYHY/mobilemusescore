// Ranges, Copy, Cut and Paste in Edit (composer #1), by real touch on a phone-sized page. A new score
// (Soprano, Alto; 4/4, 4 bars) with C D E F in bar 1 of the Soprano. Tap the C, hold a finger on the F:
// bar 1 is a range (outlined, "Bar 1 · 1 line selected"; ‹ › give way to Copy and Cut, the bar keeps its
// height). Copy, pick bar 2's rest, Paste: bar 2 is C D E F. Hold bar 2 into a range, Higher: up a
// semitone. Cut bar 1: rests. Shift+click with a mouse makes a range too. A short tap ends the range.
// The copy is read back by desktop MuseScore. Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const musescore = "C:/Program Files/MuseScore 4/bin/MuseScore4.exe";
const out = path.join(root, "build/range-copy");
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
const cdp = await context.newCDPSession(page);
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });

await page.tap("#new-score");
await page.fill("#ns-title", "Ranges");
await page.locator("#ns-lines input").first().fill("Soprano");
await page.tap("#ns-add");
await page.locator("#ns-lines input").nth(1).fill("Alto");
await page.selectOption("#ns-time", "4/4");
await page.fill("#ns-bars", "4");
await page.tap("#ns-create");
await page.waitForFunction(() => app.edit.on && app.edit.sel);

// the first tap starts the sound and a status message shows above the score, moving it: start the sound
// first and wait for the status bar to go, so screen points stay where they are measured
const settle = async () => {
    await page.evaluate(() => app.engine.startAudio().catch(() => {}));
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
    await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(300);
};
const idle = () => page.waitForFunction(() => !app.edit.busy, null, { timeout: 20000 });
const sel = () => page.evaluate(() => app.edit.sel);
// where the selection is on screen: the middle of its (first) outline box, measured just before use
const selPoint = () => page.evaluate(() => {
    const r = document.querySelector(".edit-sel").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const hold = async (p, ms = 650) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
};
const tapAt = async (p) => { await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(300); await idle(); };
const visible = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).display !== "none" && !document.getElementById(i).hidden, id);
const barH = () => page.evaluate(() => Math.round(document.getElementById("editbar").getBoundingClientRect().height));
const pitches = (from, n) => page.evaluate(async ([bar, count]) => {
    // read the Soprano's notes of a bar through the engine, leaving the app's selection as it was
    let s = await app.engine.editSelectStart();
    for (let i = 0; i < 8 && s && s.bar < bar; i++) s = await app.engine.editMove("next-measure");
    const got = [];
    for (let i = 0; i < count && s; i++) { got.push(s.kind === "note" ? s.pitch : "r"); s = await app.engine.editMove("next-chord"); }
    return got;
}, [from, n]);
const reselect = async (bar) => {
    await page.evaluate(async (b) => {
        let s = await app.engine.editSelectStart();
        for (let i = 0; i < 8 && s && s.bar < b; i++) s = await app.engine.editMove("next-measure");
        app.edit.sel = s; app.showEditSel(false); app.updateEditBar();
    }, bar);
};
// select the nth note or rest of a bar (no scrolling) and return where it is on screen now
const pointOf = async (bar, nth) => {
    await page.evaluate(async ([b, n]) => {
        let s = await app.engine.editSelectStart();
        for (let i = 0; i < 8 && s && s.bar < b; i++) s = await app.engine.editMove("next-measure");
        for (let i = 0; i < n && s; i++) s = await app.engine.editMove("next-chord");
        app.edit.sel = s; app.showEditSel(false); app.updateEditBar();
    }, [bar, nth]);
    return selPoint();
};

// bar 1: C D E F by note input
for (const l of ["C", "D", "E", "F"]) {
    await page.tap(`#edit-letters button:has-text("${l}")`);
    await idle();
}
await settle();
const bar1 = await pitches(1, 4);
check(bar1.length === 4 && bar1.every((p) => typeof p === "number"), "bar 1 has four notes: " + bar1.join(" "));

// tap the C, then hold a finger on the F
const fPt = await pointOf(1, 3);
const cPt = await pointOf(1, 0);
await tapAt(cPt);
check((await sel())?.kind === "note" && /^C/.test((await sel()).name), "a tap picks the C");
const h0 = await barH();
await hold(fPt);
let s = await sel();
check(s?.kind === "range" && s.bar === 1 && s.barEnd === 1 && s.staves === 1, `holding the F makes a range: ${s?.kind} ${s?.bar}-${s?.barEnd}, ${s?.staves} line(s)`);
check((await page.textContent("#edit-info")).includes("Bar 1") && (await page.textContent("#edit-info")).includes("1 line selected"), "the bar says what is selected");
check(await page.evaluate(() => document.querySelectorAll(".edit-sel.range").length) >= 1, "the range is outlined");
check(await visible("edit-copysel") && await visible("edit-cut") && !(await visible("edit-prev")), "Copy and Cut take the place of ‹ ›");
check(await barH() === h0, `the edit bar keeps its height (${h0} px)`);
check(!(await visible("edit-paste")), "no Paste before anything is copied");

// Copy, then Paste into bar 2
await page.tap("#edit-copysel");
await page.waitForTimeout(200);
check(await visible("edit-paste"), "after Copy, Paste shows at the end of the length row");
await tapAt(await pointOf(2, 0));
check((await sel())?.bar === 2 && (await sel()).kind !== "range", "a tap on bar 2 picks its rest (and ends the range)");
await page.tap("#edit-paste");
await idle();
const bar2 = await pitches(2, 4);
check(bar2.join(" ") === bar1.join(" "), `Paste: bar 2 is the same as bar 1 (${bar2.join(" ")})`);

// bar 2 as a range, Higher: a semitone up
const b2last = await pointOf(2, 3);
const b2first = await pointOf(2, 0);
await tapAt(b2first);
await hold(b2last);
check((await sel())?.kind === "range", "bar 2 held into a range");
await page.tap("#edit-up");
await idle();
const up = await pitches(2, 4);
check(up.every((p, i) => p === bar1[i] + 1), `Higher moves the whole range up a semitone (${up.join(" ")})`);

// Cut bar 1
const b1last = await pointOf(1, 3);
await tapAt(await pointOf(1, 0));
await hold(b1last);
await page.tap("#edit-cut");
await idle();
const cut = await pitches(1, 1);
check(cut[0] === "r", "Cut leaves rests in bar 1");

// Shift+click with a mouse makes a range too
const m2 = await pointOf(2, 3);
const m1 = await pointOf(2, 0);
await page.mouse.click(m1.x, m1.y);
await page.waitForTimeout(300);
await page.keyboard.down("Shift");
await page.mouse.click(m2.x, m2.y);
await page.keyboard.up("Shift");
await page.waitForTimeout(400);
check((await sel())?.kind === "range", "Shift+click makes a range");
await page.mouse.click(m1.x, m1.y);
await page.waitForTimeout(400);
check((await sel())?.kind === "note", "a plain tap ends the range");

// read back by desktop MuseScore
const copy = await page.evaluate(async () => { const r = await app.engine.saveCopy(); return r.ok ? Array.from(new Uint8Array(r.data)) : null; });
check(!!copy, "saved a copy");
if (copy && fs.existsSync(musescore)) {
    const mscz = path.join(out, "ranges.mscz"), xml = path.join(out, "ranges.musicxml");
    fs.writeFileSync(mscz, Buffer.from(copy));
    fs.rmSync(xml, { force: true });
    try { execFileSync(musescore, ["-o", xml, mscz], { stdio: "ignore", timeout: 300000 }); } catch (e) { /* checked below */ }
    const x = fs.existsSync(xml) ? fs.readFileSync(xml, "utf8") : "";
    const sop = (x.match(/<part id="P1">([\s\S]*?)<\/part>/) || [])[1] || "";
    const bars = [...sop.matchAll(/<measure[^>]*>([\s\S]*?)<\/measure>/g)].map(([, m]) => [...m.matchAll(/<note[^>]*>([\s\S]*?)<\/note>/g)]
        .map(([, n]) => (/<rest/.test(n) ? "r" : (n.match(/<step>(\w)<\/step>/) || [])[1] + ((n.match(/<alter>(-?\d)<\/alter>/) || [])[1] === "1" ? "#" : ""))).join(" "));
    check(/^r/.test(bars[0] || ""), "MuseScore reads bar 1 as rests: " + bars[0]);
    check((bars[1] || "").split(" ").length === 4 && !/r/.test(bars[1] || ""), "and bar 2 as four notes, a semitone up: " + bars[1]);
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
