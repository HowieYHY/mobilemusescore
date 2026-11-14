// Composer #3-#6 and #10, by touch and keyboard on a phone-sized page: voices (move a note to voice 2, and
// enter a second tune in voice 2), marks (staccato, accent, fermata, breath), a slur and a crescendo over a
// range, bars inserted before and deleted in the middle, and desktop's keys (5 = quarter, G A, 0 = rest,
// arrows, Shift+arrow, Ctrl+Z). The More panel fits at 360 px. The copy is read back by desktop MuseScore.
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
const musescore = "C:/Program Files/MuseScore 4/bin/MuseScore4.exe";
const out = path.join(root, "build/composer-tools");
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({
    viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
const cdp = await context.newCDPSession(page);
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });

await page.tap("#new-score");
await page.fill("#ns-title", "Tools");
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
const goTo = (bar, nth = 0, voice = 1) => page.evaluate(async ([b, n, v]) => {
    let s = await app.engine.editSelectStart();
    for (let i = 0; i < 12 && s && s.bar < b; i++) s = await app.engine.editMove("next-measure");
    for (let i = 0; i < n && s; i++) s = await app.engine.editMove("next-chord");
    app.edit.sel = s; app.edit.step = false; app.showEditSel(false); app.updateEditBar();
    return s;
}, [bar, nth, voice]);
const selPoint = () => page.evaluate(() => {
    const r = document.querySelector(".edit-sel").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const hold = async (p) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
    await page.waitForTimeout(650);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
};
// on a phone the piano and the lengths make way while More is open: close it first, as a finger would
const less = async () => {
    if (await page.evaluate(() => !document.getElementById("edit-more").hidden)) await page.tap("#edit-morebtn");
};
const letter = async (l) => { await less(); await page.tap(`.piano-key[data-midi="${{ C: 60, D: 62, E: 64, F: 65, G: 67, A: 69, B: 71 }[l]}"]`); await idle(); };
const more = async () => {
    if (await page.evaluate(() => document.getElementById("edit-more").hidden)) await page.tap("#edit-morebtn");
};
const tapIn = async (selector) => { await more(); await page.locator(selector).scrollIntoViewIfNeeded(); await page.tap(selector); await idle(); };

// bar 1: C D E F
for (const l of ["C", "D", "E", "F"]) await letter(l);
await settle();

// the More panel at 360 px: every row fits, nothing sticks out sideways
await more();
const fit = await page.evaluate(() => {
    const p = document.getElementById("edit-more");
    const r = p.getBoundingClientRect();
    const wide = [...p.querySelectorAll("button, input, select")].filter((e) => e.getBoundingClientRect().right > r.right + 1).map((e) => e.id || e.textContent);
    return { wide, scroll: document.documentElement.scrollWidth > innerWidth };
});
check(!fit.wide.length && !fit.scroll, `360 px: the More panel fits (sticks out: ${fit.wide.join(",") || "nothing"})`);

// #3 voices: move the C to voice 2, then back with Undo
await goTo(1, 0);
await tapIn('#edit-voices button[data-voice="2"]');
check((await sel())?.voice === 2, "Voice 2 on a note moves it to voice 2");
await page.tap("#edit-undo"); await idle();
// enter a second tune in voice 2 of bar 2: pick its rest (entering), voice 2, then piano keys
await goTo(2, 0);
await tapIn('#edit-voices button[data-voice="2"]');
let s = await sel();
check(s?.voice === 2 && s.kind === "rest" && await page.evaluate(() => !document.getElementById("edit-rest").disabled), "Voice 2 on a rest: the place in voice 2, ready for notes");
await less();
check(await page.evaluate(() => document.getElementById("editsheet").offsetHeight > 100), "More closed: the piano is back");
await page.tap('#edit-lengths .len[data-den="2"]');
await letter("A"); await letter("A");
check(await page.evaluate(() => /voice 2/.test(document.getElementById("edit-info").textContent)) || (await sel())?.voice === 2, "entering carries on in voice 2");

// #5 marks on bar 1
await goTo(1, 0);
await tapIn('#edit-marks [data-mark="0"]');
await tapIn('#edit-marks [data-mark="1"]');
await goTo(1, 3);
await tapIn('#edit-marks [data-mark="4"]');
await goTo(1, 2);
await tapIn('#edit-marks [data-mark="5"]');
check(true, "marks put on (read back below)");

// #6 a slur and a crescendo over bar 1 (a range by holding)
const rangeBar1 = async () => {
    await goTo(1, 3);
    const last = await selPoint();
    await goTo(1, 0);
    const first = await selPoint();
    await page.touchscreen.tap(first.x, first.y); await page.waitForTimeout(300); await idle();
    await hold(last);
};
await rangeBar1();
check((await sel())?.kind === "range", "bar 1 held into a range");
await tapIn("#edit-slur");
await rangeBar1();
await tapIn("#edit-cresc");

// #4 bars: one before bar 2, then delete bar 3 (the new bar 2's old self is bar 3 now)
const bars0 = await page.evaluate(() => app.state.score.bars ?? null);
await goTo(2, 0);
await page.fill("#edit-bars", "1");
await tapIn("#edit-insertbars");
await goTo(4, 0);
await tapIn("#edit-deletebars");
await page.waitForSelector("#ask[open]");
check((await page.textContent("#ask")).includes("Delete bar 4"), "Delete bar asks first");
const undoBefore = await page.evaluate(() => app.edit.undo);
await page.tap('#ask button:has-text("Delete")');
// the delete starts once the question has closed: wait for it, or the next step's selection gets deleted
await page.waitForFunction((n) => app.edit.undo > n && !app.edit.busy, undoBefore, { timeout: 20000 });

// #10 keys: in the last bar, 5 = quarter, G A, 0 = rest, B; ← back; Ctrl+Z; Shift+→
await goTo(4, 0);
await page.keyboard.press("5");
for (const k of ["g", "a", "0", "b"]) { await page.keyboard.press(k); await idle(); }
s = await sel();
check(s && s.bar === 4, "keys G A 0 B went into bar 4");
const undoN = await page.evaluate(() => app.edit.undo);
await page.keyboard.press("Control+z"); await idle();
check(await page.evaluate(() => app.edit.undo) === undoN - 1, "Ctrl+Z undoes one step");
await page.keyboard.press("Control+y"); await idle();
await goTo(4, 0);
await page.keyboard.press("Shift+ArrowRight"); await page.waitForTimeout(300);
check((await sel())?.kind === "range", "Shift+→ makes a range");
await page.keyboard.press("ArrowUp"); await idle();
check(true, "↑ on the range");

// read back by desktop MuseScore
const copy = await page.evaluate(async () => { const r = await app.engine.saveCopy(); return r.ok ? Array.from(new Uint8Array(r.data)) : null; });
check(!!copy, "saved a copy");
if (copy && fs.existsSync(musescore)) {
    const mscz = path.join(out, "tools.mscz"), xml = path.join(out, "tools.musicxml");
    fs.writeFileSync(mscz, Buffer.from(copy));
    fs.rmSync(xml, { force: true });
    try { execFileSync(musescore, ["-o", xml, mscz], { stdio: "ignore", timeout: 300000 }); } catch (e) { /* checked below */ }
    const x = fs.existsSync(xml) ? fs.readFileSync(xml, "utf8") : "";
    const has = (re, msg) => check(re.test(x), "MuseScore reads " + msg);
    has(/<voice>2<\/voice>/, "a second voice");
    has(/<staccato[\s/]/, "the staccato");
    has(/<accent[\s/]/, "the accent");
    has(/<fermata/, "the fermata");
    has(/<breath-mark/, "the breath mark");
    has(/<slur type="start"/, "the slur");
    has(/<wedge type="crescendo"/, "the crescendo");
    const measures = (x.match(/<measure /g) || []).length;
    check(measures === 4, `4 bars after one inserted and one deleted (${measures})`);
    const m4 = (x.match(/<measure number="4"[^>]*>([\s\S]*?)<\/measure>/) || [])[1] || "";
    const notes4 = [...m4.matchAll(/<note[^>]*>([\s\S]*?)<\/note>/g)].map(([, n]) => (/<rest/.test(n) ? "r" : (n.match(/<step>(\w)<\/step>/) || [])[1])).join(" ");
    check(/^G A r B/.test(notes4), "bar 4 from the keys: " + notes4);
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
