// The reader's own notes follow the music when it is edited (bug hunt, finding 24), as a staff text
// does in desktop MuseScore: a note belongs to its bar. In a new 16-bar score, with a real mouse on a
// tablet-sized page: a pen line is drawn over bar 6 and another in the top margin; then, in Edit:
//   - two bars inserted before bar 3: the line is over the same bar, now bar 8, and Undo puts it back;
//   - bar 3 deleted: the line is over what is now bar 5, and Undo puts it back;
//   - its own bar deleted: the line goes with it, and Undo brings it back whole;
//   - 3/4 from the start (every bar written anew): the line keeps its tick;
//   - it shows over the same bar in the continuous view too.
// The line in the margin never moves. "Over its bar" is measured: the line's first point against the
// place of the bar's start in the timeline the engine gives after each edit.
// Before the change the line stayed where bar 6 had been on the paper.
// Needs the dev server (it shows the Composer): (cd app && npx vite --port 5180 --host 127.0.0.1)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1366 } })).newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.click("#new-score");
await page.fill("#ns-title", "Follow");
await page.click("#ns-create");
await page.waitForFunction(() => app.state.score && app.edit.on && app.edit.sel, null, { timeout: 30000 });
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
check(await page.evaluate(async () => !!(await app.engine.anchors())), "the engine says which bar is which");

// where a bar starts and ends, on the page (page units) and on the screen
const bar = (b) => page.evaluate(async (b) => {
    const tl = await app.engine.timeline();
    const i = tl.findIndex((p) => p[6] === b);
    if (i < 0) {
        return null;
    }
    const p = tl[i];
    const q = tl.slice(i + 1).find((n) => n[6] !== b) ?? null;
    const el = document.querySelector(`.page[data-index="${p[1]}"]`);
    const r = el.getBoundingClientRect();
    const [, , w, h] = el.querySelector("svg.ink").getAttribute("viewBox").split(" ").map(Number);
    const end = q && q[1] === p[1] && q[3] === p[3] ? q[2] : null; // the next bar's start, when it is on the same line
    return { page: p[1], x: p[2], end, y: p[3], h: p[4], sx: r.width / w, sy: r.height / h, left: r.left, top: r.top };
}, b);
const strokes = () => page.evaluate(() => {
    const out = [];
    for (const [pg, p] of Object.entries(app.notes.data.modes.page ?? {})) {
        for (const s of p.strokes) {
            out.push({ page: Number(pg), color: s.color, x: s.pts[0], y: s.pts[1], n: s.pts.length / 2, pts: s.pts.slice(), bars: [...new Set((s.a ?? []).map((a) => (a ? a[5] : null)))] });
        }
    }
    return out;
});
const busy = () => page.waitForFunction(() => !app.edit.busy).then(() => page.waitForTimeout(400));
const selectBar = async (b) => {
    const at = await bar(b);
    // the whole-bar rest sits in the middle of its bar, on the staff
    const x = at.left + (at.x + ((at.end ?? at.x + 400) - at.x) / 2) * at.sx;
    const y = at.top + (at.y + at.h / 2) * at.sy;
    await page.evaluate(() => (app.edit.sel = null));
    await page.mouse.click(x, y);
    await page.waitForFunction(() => app.edit.sel, null, { timeout: 5000 });
    return page.evaluate(() => app.edit.sel.bar);
};
const deleteBar = async (b) => {
    const picked = await selectBar(b);
    await page.evaluate(() => document.getElementById("edit-deletebars").click());
    await page.click("#ask .ask-buttons .btn.primary");
    await busy();
    return picked;
};
const undo = async () => {
    await page.evaluate(() => document.getElementById("edit-undo").click());
    await busy();
};

// ---- write the two notes: Edit off, Notes on, the pen
await page.click("#edit-done");
await page.click("#notes-toggle");
await page.waitForFunction(() => app.notes.active);
const b6 = await bar(5);
const b7 = await bar(6);
check(b6 && b6.end !== null && b7.page === b6.page, "bars 6 and 7 are on one line (the test draws over bar 6)");
const width = b6.end - b6.x;
const draw = async (x0, y0, x1, y1) => {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
        await page.mouse.move(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8);
    }
    await page.mouse.up();
    await page.waitForTimeout(100);
};
// over bar 6: from a tenth to six tenths of the bar, a little above the middle of the system
const lineY = b6.top + (b6.y + b6.h * 0.4) * b6.sy;
await draw(b6.left + (b6.x + width * 0.1) * b6.sx, lineY, b6.left + (b6.x + width * 0.6) * b6.sx, lineY);
// in the top margin of the first page
await draw(b6.left + 40, b6.top + 14, b6.left + 120, b6.top + 14);
let all = await strokes();
const onBar = all.find((s) => s.bars.includes(5));
const margin = all.find((s) => s.bars.every((b) => b === null));
check(all.length === 2 && !!onBar && onBar.bars.length === 1, `a line over bar 6 is pinned to bar 6 (pinned to: ${all.map((s) => s.bars.map((b) => (b === null ? "nothing" : "bar " + (b + 1))).join("+")).join("; ")})`);
check(!!margin, "a line in the top margin is pinned to nothing");
// a text box over bar 7 (the Text tool: a double click makes one, a click elsewhere finishes it)
await page.click('[data-tool="text"]');
const textX = b7.left + (b7.x + width * 0.3) * b7.sx;
await page.mouse.dblclick(textX, lineY);
await page.keyboard.type("breathe");
await page.mouse.click(b6.left + 300, b6.top + 20);
await page.waitForTimeout(300);
const texts = () => page.evaluate(async () => {
    const tl = await app.engine.timeline();
    return Object.entries(app.notes.data.modes.page ?? {}).flatMap(([pg, p]) => p.texts.map((t) => {
        const b = t.a ? t.a[5] : null;
        const i = tl.findIndex((x) => x[6] === b);
        const q = i < 0 ? null : tl.slice(i + 1).find((n) => n[6] !== b);
        return { page: Number(pg), text: t.text, bar: b, off: i < 0 || !q ? NaN : (t.x - tl[i][2]) / (q[2] - tl[i][2]), onPage: i >= 0 && tl[i][1] === Number(pg) };
    }));
});
const text0 = (await texts())[0];
check(!!text0 && text0.text === "breathe" && text0.bar === 6, `a text box over bar 7 is pinned to bar 7 (${text0 ? "bar " + (text0.bar + 1) : "no text box"})`);
const textNear = (t) => !!t && t.onPage && Math.abs(t.off - text0.off) < 0.03;
await page.click('[data-tool="pen"]');
await page.click("#notes-done");
await page.click("#edit-toggle");
await page.waitForFunction(() => app.edit.on);

// the line that started on bar 6: where it is against where its bar starts now
const where = async (b) => {
    const at = await bar(b);
    const s = (await strokes()).find((x) => x.bars.includes(b));
    return s && at ? { at, s, off: (s.x - at.x) / ((at.end ?? at.x + width) - at.x) } : { at, s: null, off: NaN };
};
const start = await where(5);
const near = (w) => !!w.s && Math.abs(w.off - start.off) < 0.03 && w.s.page === w.at.page && Math.abs((w.s.y - w.at.y) - (start.s.y - start.at.y)) < 4;
const says = (w) => (w.s ? `${Math.round(w.off * 100)}% into its bar (drawn at ${Math.round(start.off * 100)}%), page ${w.s.page + 1}` : "no line there");
const marginStays = async () => {
    const m = (await strokes()).find((s) => s.bars.every((b) => b === null));
    return !!m && m.page === margin.page && m.pts.join() === margin.pts.join();
};

// ---- two bars inserted before bar 3
await selectBar(2);
await page.evaluate(() => { document.getElementById("edit-bars").value = "2"; document.getElementById("edit-insertbars").click(); });
await busy();
let w = await where(7);
check(near(w), `two bars inserted before bar 3: the line is over the same bar, now bar 8: ${says(w)}`);
check(await marginStays(), "the line in the margin has not moved");
let tx = (await texts())[0];
check(textNear(tx) && tx.bar === 8, `and the text box is over its bar, now bar 9 (${tx ? `bar ${tx.bar + 1}, ${Math.round(tx.off * 100)}% in, written at ${Math.round(text0.off * 100)}%` : "gone"})`);
await undo();
tx = (await texts())[0];
check(textNear(tx) && tx.bar === 6, "Undo: the text box is back over bar 7");
w = await where(5);
check(near(w) && w.s.pts.every((v, i) => Math.abs(v - start.s.pts[i]) <= 2), `Undo: it is back over bar 6, where it was drawn: ${says(w)}`);

// ---- bar 3 deleted
await deleteBar(2);
w = await where(4);
check(near(w), `bar 3 deleted: the line is over the same bar, now bar 5: ${says(w)}`);
await undo();
w = await where(5);
check(near(w), `Undo: back over bar 6: ${says(w)}`);

// ---- its own bar deleted
await deleteBar(5);
all = await strokes();
check(all.length === 1 && all[0].bars.every((b) => b === null), `its own bar deleted: the line goes with it (${all.length} line(s) left)`);
await undo();
w = await where(5);
check(near(w) && w.s.n === start.s.n, `Undo: the line is back, whole, over bar 6: ${says(w)}`);
await deleteBar(6);
check((await texts()).length === 0, "the text box's own bar deleted: it goes with it");
await undo();
tx = (await texts())[0];
check(textNear(tx) && tx.bar === 6 && tx.text === "breathe", "Undo: the text box is back over bar 7, with its words");
check(await marginStays(), "the line in the margin still has not moved");

// ---- the same bar in another view
await page.selectOption("#view-mode", "continuous_h");
await page.waitForTimeout(1500);
const shown = await page.evaluate(async () => {
    const tl = await app.engine.timeline();
    const p = tl.find((x) => x[6] === 5);
    const q = tl.find((x) => x[6] === 6);
    const s = [...app.notes.shown.values()].flatMap((v) => v.strokes)[0];
    return s ? { x: s.parts[0][0], from: p[2], to: q[2] } : null;
});
check(!!shown && shown.x > shown.from && shown.x < shown.to, `in the continuous view the line is over bar 6 too (${shown ? `at ${shown.x}, the bar is ${shown.from} to ${shown.to}` : "not shown"})`);
await page.selectOption("#view-mode", "page");
await page.waitForTimeout(1500);

// ---- 3/4 from the first bar: every bar is written anew, and the line keeps its tick.
// It was a tenth into bar 6 of 4/4: 5 bars and 0.1 = 5.1 x 4 beats = 20.4 beats = 6 bars of 3/4 and 2.4 beats
await selectBar(0);
await page.evaluate(() => {
    const sel = document.getElementById("edit-time");
    sel.value = "3/4";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await busy();
const expected = (5 + start.off) * 4 / 3;
all = await strokes();
const kept = all.find((s) => s.bars.some((b) => b !== null));
w = kept ? await where(kept.bars[0]) : { s: null };
const got = w.s ? kept.bars[0] + w.off : NaN;
check(!!w.s && Math.abs(got - expected) < 0.06, `3/4 from the start: the line keeps its tick (starts ${got.toFixed(2)} bars in, its tick is ${expected.toFixed(2)} bars of 3/4 in)`);
await undo();
w = await where(5);
check(near(w), `Undo: back over bar 6 of 4/4: ${says(w)}`);

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
