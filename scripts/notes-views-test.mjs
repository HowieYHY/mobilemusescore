// Notes follow the music into every view: a circle, a highlight and a text box written in Page view
// show in both continuous views on the same music (and Page by page shares Page view's), and the
// other way round; a mark in the page margin stays in its own view; erasing a note from another
// view removes it there too, and Undo brings it back; a speed change doesn't move them; Clear clears
// every view; older notes (saved without their pins) don't light up Save when they get them.
//
// Needs the dev server: (cd app && npx vite --host 127.0.0.1 --port 5180)
// Usage: node scripts/notes-views-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it edited.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 });
const b64 = fs.readFileSync(scorePath).toString("base64");
const open = () => page.evaluate(async ({ name, b64 }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    await app.openScore(name, bytes.buffer);
}, { name: path.basename(scorePath), b64 });
await open();
await page.waitForSelector(".page canvas", { timeout: 120000 });
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
await page.waitForTimeout(1000);
const sp = await page.evaluate(() => app.state.score.spatium);

const view = async (mode) => {
    await page.selectOption("#view-mode", mode);
    await page.waitForTimeout(800);
    await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(700);
};
// where a moment of the music is in the current layout: a fraction down its system, or with `pin`
// ({ staff, dy } from another layout) that far under that staff when this layout shows it, as notes
// are placed. Units and screen, and the pin of the place found (its nearest staff here).
const spot = (secs, fy, pin) => page.evaluate(async ({ secs, fy, pin }) => {
    const c = app.cursorAt(secs);
    const staves = (await app.engine.staves()).find(([pg, y]) => pg === c.page && y === c.y)?.[2] ?? [];
    const st = pin && staves.find(([i]) => i === pin.staff);
    const uy = st ? st[1] + pin.dy : c.y + fy * c.h;
    let near = null, nd = Infinity;
    for (const t of staves) {
        const d = uy < t[1] ? t[1] - uy : uy > t[2] ? uy - t[2] : 0;
        if (d < nd) { nd = d; near = t; }
    }
    const el = document.querySelectorAll(".page")[c.page];
    el.scrollIntoView({ block: "center", inline: "center" });
    const v = document.getElementById("viewer");
    const r = el.getBoundingClientRect();
    const k = r.width / app.state.score.pages[c.page].w;
    // bring the spot itself to the middle of the screen
    const vr = v.getBoundingClientRect();
    v.scrollLeft += r.left + c.x * k - (vr.left + vr.width / 2);
    v.scrollTop += r.top + uy * k - (vr.top + vr.height / 2);
    const r2 = el.getBoundingClientRect();
    return { page: c.page, ux: c.x, uy, sx: r2.left + c.x * k, sy: r2.top + uy * k, k, pin: near && { staff: near[0], dy: uy - near[1] } };
}, { secs, fy, pin });
async function circle(sx, sy, rad = 14) {
    await page.mouse.move(sx + rad, sy);
    await page.mouse.down();
    for (let i = 1; i <= 24; i++) {
        await page.mouse.move(sx + rad * Math.cos(i * Math.PI / 12), sy + rad * Math.sin(i * Math.PI / 12));
    }
    await page.mouse.up();
}
// notes from another view drawn here: their centres (page units) by id
const shownStrokes = (fromMode) => page.evaluate((m) => [...document.querySelectorAll(`.ink path[data-mode="${m}"]`)].map((p) => {
    const b = p.getBBox();
    return { id: p.dataset.id, page: Number(p.closest(".page").dataset.index), x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height };
}), fromMode);
// a stroke's height as written (page units)
const heightOf = (mode, id) => page.evaluate(({ mode, id }) => {
    const s = Object.values(app.notes.data.modes[mode]).flatMap((p) => p.strokes).find((q) => q.id === id);
    const ys = s.pts.filter((_, i) => i % 2 === 1);
    return Math.max(...ys) - Math.min(...ys);
}, { mode, id });
const strokesIn = (mode) => page.evaluate((m) => Object.values(app.notes.data.modes[m] ?? {}).flatMap((p) => p.strokes.map((s) => s.id)), mode);
const near = (a, b, tol) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

// --- write in Page view: a circle on a note, a mark in the top margin, a text box
const duration = await page.evaluate(() => app.state.duration);
const secs = duration * 0.3;
const FY = 0.3;
await page.click("#notes-toggle");
await page.waitForTimeout(400);
let s1 = await spot(secs, FY);
const pin1 = s1.pin;
await circle(s1.sx, s1.sy);
const circleId = (await strokesIn("page"))[0];
// the margin: the very top of page 1
const margin = await page.evaluate(() => {
    const el = document.querySelector(".page");
    el.scrollIntoView({ block: "start" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.015 };
});
await page.mouse.move(margin.x - 40, margin.y);
await page.mouse.down();
await page.mouse.move(margin.x + 40, margin.y, { steps: 6 });
await page.mouse.up();
const marginId = (await strokesIn("page")).find((id) => id !== circleId);
s1 = await spot(secs, FY);
await page.click('.tool[data-tool="text"]');
await page.mouse.dblclick(s1.sx + 80, s1.sy);
await page.keyboard.type("here");
await page.mouse.click(s1.sx + 80, s1.sy + 250);
await page.click('.tool[data-tool="pen"]');
check((await strokesIn("page")).length === 2 && !!marginId, "Page view: a circle on a note and a mark in the margin written");

// --- a line under one staff's lyrics: in every view the same distance under the same staff
// (staves are spread differently per view, and page view hides empty ones)
const staffAt = (secs) => page.evaluate(async (secs) => {
    const c = app.cursorAt(secs);
    const sys = (await app.engine.staves()).find(([pg, y]) => pg === c.page && y === c.y);
    return { c, staves: sys ? sys[2] : [] };
}, secs);
const lyricSecs = duration * 0.4;
const at0 = await staffAt(lyricSecs);
const k = at0.staves[Math.min(2, at0.staves.length - 1)]; // [score staff, top, bottom]
const below = k[2] - k[1] + 2.5 * sp; // 2.5 spaces under the staff (where its lyrics are)
const lyricLine = await page.evaluate(({ c, y }) => {
    const el = document.querySelectorAll(".page")[c.page];
    el.scrollIntoView({ block: "center" });
    const v = document.getElementById("viewer");
    let r = el.getBoundingClientRect();
    const kk = r.width / app.state.score.pages[c.page].w;
    v.scrollTop += r.top + y * kk - (v.getBoundingClientRect().top + v.clientHeight / 2);
    r = el.getBoundingClientRect();
    return { x: r.left + c.x * kk, y: r.top + y * kk };
}, { c: at0.c, y: k[1] + below });
await page.mouse.move(lyricLine.x, lyricLine.y);
await page.mouse.down();
await page.mouse.move(lyricLine.x + 150, lyricLine.y, { steps: 8 });
await page.mouse.up();
const lyricId = (await strokesIn("page")).find((id) => id !== circleId && id !== marginId);

// --- both continuous views: the circle on the same note, not the margin mark; the text shown
for (const mode of ["continuous_h", "continuous_v"]) {
    await view(mode);
    const want = await spot(secs, FY, pin1);
    const shown = await shownStrokes("page");
    const c = shown.find((p) => p.id === circleId);
    check(!!c && c.page === want.page && near(c, { x: want.ux, y: want.uy }, 1.5 * sp),
        `${mode}: the circle is on the same note (${c ? Math.hypot(c.x - want.ux, c.y - want.uy).toFixed(0) : "-"} units off, ${(1.5 * sp).toFixed(0)} allowed)`);
    check(!shown.some((p) => p.id === marginId), `${mode}: the margin mark stays in Page view`);
    const h0 = await heightOf("page", circleId);
    check(!!c && Math.abs(c.h - h0) <= 0.1 * sp, `${mode}: the circle keeps its height (${c ? c.h.toFixed(0) : "-"} units, ${h0.toFixed(0)} as written)`);
    const t = await page.evaluate(() => [...document.querySelectorAll(".tnote.shown")].map((b) => ({ text: b.textContent, edit: b.querySelector(".tbody").isContentEditable })));
    check(t.length === 1 && t[0].text === "here" && !t[0].edit, `${mode}: the text box shows ("${t[0]?.text}"), edited in Page view only`);
    const at = await staffAt(lyricSecs);
    const same = at.staves.find(([i]) => i === k[0]);
    const ly = shown.find((p) => p.id === lyricId);
    const dist = same && ly ? ly.y - same[1] : NaN;
    check(Math.abs(dist - below) <= 0.25 * sp, `${mode}: the line under staff ${k[0] + 1}'s lyrics is ${dist.toFixed(0)} units under that staff (${below.toFixed(0)} in Page view; ${at.staves.length} staves here, ${at0.staves.length} there)`);
}

// --- a speed change doesn't move them
{
    const before = (await shownStrokes("page")).find((p) => p.id === circleId);
    await page.click("#speed-open").catch(() => {});
    await page.waitForTimeout(300);
    for (let i = 0; i < 10; i++) {
        await page.click("#speed-down");
        await page.waitForTimeout(40);
    }
    await page.waitForTimeout(1500);
    const speed = await page.evaluate(() => document.getElementById("speed-value").textContent);
    const after = (await shownStrokes("page")).find((p) => p.id === circleId);
    const later = await (async () => { await page.waitForTimeout(3000); return (await shownStrokes("page")).find((p) => p.id === circleId); })();
    const fmt = (p) => (p ? `page ${p.page + 1} ${p.x.toFixed(0)},${p.y.toFixed(0)}` : "gone");
    check(!!after && near(before, after, 1), `at ${speed} speed the circle stays where it was (before ${fmt(before)}, after ${fmt(after)}, 3 s later ${fmt(later)})`);
    for (let i = 0; i < 10; i++) {
        await page.click("#speed-up");
        await page.waitForTimeout(40);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
}

// --- erase it here (continuous horizontal), it goes from Page view; Undo brings it back
{
    const want = await spot(secs, FY, pin1);
    await page.click('.tool[data-tool="eraser"]');
    await page.mouse.move(want.sx - 30, want.sy - 30);
    await page.mouse.down();
    await page.mouse.move(want.sx + 30, want.sy + 30, { steps: 12 });
    await page.mouse.up();
    check(!(await strokesIn("page")).includes(circleId), "erased in a continuous view: gone from Page view's notes");
    await page.click("#notes-undo");
    await page.waitForTimeout(300);
    check((await strokesIn("page")).includes(circleId) && (await shownStrokes("page")).some((p) => p.id === circleId), "Undo brings it back, shown here again");
    await page.click('.tool[data-tool="pen"]');
}

// --- write in a continuous view; it shows in Page view and Page by page on the same note
const secs2 = duration * 0.55;
await view("continuous_h");
const s2 = await spot(secs2, FY);
const pin2 = s2.pin;
await circle(s2.sx, s2.sy);
const contId = (await strokesIn("continuous_h"))[0];
for (const mode of ["page", "page_turn"]) {
    await view(mode);
    const want = await spot(secs2, FY, pin2);
    const c = (await shownStrokes("continuous_h")).find((p) => p.id === contId);
    check(!!c && c.page === want.page && near(c, { x: want.ux, y: want.uy }, 1.5 * sp),
        `${mode}: the circle written in Continuous is on the same note (${c ? Math.hypot(c.x - want.ux, c.y - want.uy).toFixed(0) : "-"} units off)`);
}

// --- older notes (saved without their pins) get them without lighting up Save
await view("page");
await page.click("#notes-done");
await page.waitForTimeout(300);
await page.evaluate(() => app.notes.commit());
await page.evaluate(() => {
    const k = "pocketscore.notes." + app.state.scoreKey;
    localStorage.setItem(k, JSON.stringify(JSON.parse(localStorage.getItem(k)), (key, v) => (key === "a" ? undefined : v)));
});
await open();
await page.waitForSelector(".page canvas", { timeout: 120000 });
await page.waitForTimeout(1500);
const dirty1 = await page.evaluate(() => [app.notes.dirty, document.getElementById("save").disabled]);
check(!dirty1[0] && dirty1[1], "reopened with notes saved before pins: nothing to save");
await view("continuous_v");
const c3 = (await shownStrokes("page")).find((p) => p.id === circleId);
const dirty2 = await page.evaluate(() => [app.notes.dirty, document.getElementById("save").disabled]);
check(!!c3 && !dirty2[0] && dirty2[1], "they got their pins (the circle shows in Continuous) and Save stays dark");

// --- Clear clears every view; Undo brings all back
await page.click("#notes-toggle");
await page.waitForTimeout(300);
const total = await page.evaluate(() => app.notes.count);
await page.click("#notes-clear");
await page.click('#ask button[value="clear"], #ask [data-key="clear"], #ask button:has-text("Clear all")');
await page.waitForTimeout(300);
const afterClear = await page.evaluate(() => [app.notes.count, document.querySelectorAll(".ink path, .tnote").length]);
check(afterClear[0] === 0 && afterClear[1] === 0, `Clear removes the notes of every view (${total} -> ${afterClear[0]})`);
await page.click("#notes-undo");
await page.waitForTimeout(300);
check(await page.evaluate(() => app.notes.count) === total, "Undo brings them all back");

check(errors.length === 0, "no page errors " + errors.join("; "));
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all notes-in-every-view checks passed");
process.exit(failures ? 1 : 0);
