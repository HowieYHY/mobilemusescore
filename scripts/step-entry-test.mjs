// Note input that moves on, as desktop's piano keyboard, by touch on a phone-sized page: a new score in 4/4.
// Eighth, the keys C D E: each note goes in after the last; the rest key puts in an eighth rest; Quarter, F;
// ← goes back to the F with Higher/Lower (an octave up), → returns; a half note with one beat left in the
// bar is tied over the barline; Chord makes the next key join the note just put in; the picked note's keys
// are lit; Undo takes out one step; the bars keep their height throughout. The copy is read back by desktop
// MuseScore: C8 D8 E8 rest8 F4(up an octave) G4 tied to G4, then A4 with C5 in one chord.
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
const out = path.join(root, "build/step-entry");
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({
    viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });

await page.tap("#new-score");
await page.fill("#ns-title", "Steps");
await page.selectOption("#ns-time", "4/4");
await page.fill("#ns-bars", "2");
await page.tap("#ns-create");
await page.waitForFunction(() => app.edit.on && app.edit.sel);

const st = () => page.evaluate(() => ({
    sel: app.edit.sel && { kind: app.edit.sel.kind, name: app.edit.sel.name, bar: app.edit.sel.bar, x: app.edit.sel.x, pitch: app.edit.sel.pitch },
    piano: document.getElementById("edit-piano").getBoundingClientRect().height > 60,
    lit: [...document.querySelectorAll(".piano-key.lit")].map((k) => Number(k.dataset.midi)),
    sheetH: Math.round(document.getElementById("editsheet").getBoundingClientRect().height),
    up: getComputedStyle(document.getElementById("edit-up")).display !== "none",
    len: document.querySelector("#edit-lengths .len[aria-checked='true']")?.dataset.den,
    barH: Math.round(document.getElementById("editbar").getBoundingClientRect().height),
    info: document.getElementById("edit-info")?.textContent ?? "",
}));
const idle = () => page.waitForFunction(() => !app.edit.busy);
const MIDI = { C: 60, D: 62, E: 64, F: 65, G: 67, A: 69, B: 71, C5: 72 };
// a key is tapped where it shows: the strip is scrolled to it first, as a finger would
const tapLetter = async (l) => {
    const key = page.locator(`.piano-key[data-midi="${MIDI[l]}"]`);
    await key.scrollIntoViewIfNeeded();
    const b = await key.boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height * 0.85);
    await page.waitForTimeout(60);
    await page.waitForFunction(() => !app.edit.busy);
};

let s = await st();
const h0 = s.barH;
const sheet0 = s.sheetH;
check(s.piano && s.sel.kind === "rest", "a new score: the first rest picked, the piano shown");
check(s.len === "4", "note input starts on quarters");
const fit = await page.evaluate(() => {
    const sheet = document.getElementById("editsheet").getBoundingClientRect();
    const foot = document.getElementById("transport").getBoundingClientRect();
    const viewer = document.getElementById("viewer").getBoundingClientRect();
    const keys = [...document.querySelectorAll(".piano-white")].map((k) => k.getBoundingClientRect().width);
    return { above: sheet.bottom <= foot.top + 1, music: Math.round(viewer.height), key: Math.min(...keys) };
});
check(fit.above && fit.music >= 200 && fit.key >= 40, `360 px: the piano sits over the playing controls, keys ${fit.key} px wide, ${fit.music} px of music left`);

await page.tap('#edit-lengths .len[data-den="8"]');
s = await st();
check(s.len === "8" && /eighth/.test(s.info), "Eighth: chosen for the next notes (no change to the score)");
check(await page.evaluate(() => app.edit.undo) === 0, "choosing a length while entering is not an edit");

const xs = [];
for (const l of ["C", "D", "E"]) {
    await tapLetter(l);
    s = await st();
    xs.push(s.sel.x);
    check(s.len === "8", `${l}: in, still eighths`);
}
check(xs[0] < xs[1] && xs[1] < xs[2], "each key moved the place on");
await page.tap("#edit-rest");
await idle();
check((await st()).sel.x > xs[2], "the rest key: in, and on to the next place");
await page.tap('#edit-lengths .len[data-den="4"]');
await tapLetter("F");
s = await st();
check(s.barH === h0 && s.sheetH === sheet0, `the edit bar and the sheet keep their height while entering (${s.barH} and ${s.sheetH} px)`);

// fix the octave of the note just entered: back to it, up an octave, on again
await page.tap("#edit-prev");
await page.waitForTimeout(200);
s = await st();
check(s.sel.kind === "note" && s.sel.name.startsWith("F") && s.up, "← goes back to the F, with Higher and Lower");
check(s.lit.length === 1 && s.lit[0] === 65, `the F's key is lit (${s.lit})`);
check(s.barH === h0, "same height with the note tools");
const before = s.sel.pitch;
await page.tap("#edit-octave");
await page.tap("#edit-up");
await idle();
s = await st();
check(s.sel.pitch === before + 12, `Octave + Higher: the F an octave up (${before} → ${s.sel.pitch})`);
await page.tap("#edit-next");
await page.waitForTimeout(200);
s = await st();
check(s.sel.kind === "rest" && s.len === "4" && s.lit.length === 0, "→ back to the next place: quarters still chosen, no key lit");

// one beat is left in bar 1: a half note is tied over the barline, as on desktop
await page.tap('#edit-lengths .len[data-den="2"]');
await tapLetter("G");
s = await st();
check(s.sel.bar === 2, "a half note with one beat left: on into bar 2");
await page.tap('#edit-lengths .len[data-den="4"]');
await tapLetter("A");
// Chord: the next key joins the A just put in, and the place stays
const place = (await st()).sel.x;
await page.tap("#edit-chordkey");
const undoBefore = await page.evaluate(() => app.edit.undo);
await tapLetter("C5");
s = await st();
check(Math.abs(s.sel.x - place) < 1 && await page.evaluate(() => app.edit.undo) === undoBefore + 1, "Chord: the key joined the note before, the place did not move");
await page.tap("#edit-prev");
await page.waitForTimeout(200);
s = await st();
check(s.lit.join() === "69,72", `the chord's two keys are lit (${s.lit})`);
await page.tap("#edit-chordkey");
await page.tap("#edit-next");
await page.waitForTimeout(200);
await tapLetter("B");
await page.tap("#edit-undo");
await idle();
s = await st();
check(await page.evaluate(() => app.edit.undo) === undoBefore + 1, "Undo takes out one step (the B)");

// the end of the score: fill bar 2, and the last key keeps what it entered
for (let i = 0; i < 4; i++) {
    await tapLetter("B");
}
s = await st();
check(s.sel && s.sel.bar === 2, "at the end of the score the last note stays picked (no error)");

// read back by desktop MuseScore
const copy = await page.evaluate(async () => { const r = await app.engine.saveCopy(); return r.ok ? Array.from(new Uint8Array(r.data)) : null; });
check(!!copy, "saved a copy");
if (copy && fs.existsSync(musescore)) {
    const mscz = path.join(out, "steps.mscz"), xml = path.join(out, "steps.musicxml");
    fs.writeFileSync(mscz, Buffer.from(copy));
    fs.rmSync(xml, { force: true });
    try { execFileSync(musescore, ["-o", xml, mscz], { stdio: "ignore", timeout: 300000 }); } catch (e) { /* checked below; its first start can be slow */ }
    const x = fs.existsSync(xml) ? fs.readFileSync(xml, "utf8") : "";
    const notes = [...x.matchAll(/<note[^>]*>([\s\S]*?)<\/note>/g)].map(([, n]) => {
        const type = (n.match(/<type>(\w+)<\/type>/) || [])[1] || "?";
        if (/<rest/.test(n)) return "r:" + type;
        return (n.match(/<step>(\w)<\/step>/) || [])[1] + (n.match(/<octave>(\d)<\/octave>/) || [])[1] + ":" + type;
    });
    const got = notes.slice(0, 9).join(" ");
    const f = notes[4] || "";
    check(/^C4:eighth D4:eighth E4:eighth r:eighth F\d:quarter G4:quarter G4:quarter A4:quarter C5:quarter$/.test(got), "MuseScore reads C D E (eighths), a rest, F, G over the barline, A with C: " + got);
    const ties = [...x.matchAll(/<tie type="(\w+)"/g)].map((t) => t[1]).join(" ");
    check(ties === "start stop", "the G is tied over the barline: " + ties);
    check(/<note[^>]*>\s*<chord\/>\s*<pitch>\s*<step>C<\/step>\s*<octave>5/.test(x), "the C is in the A's chord");
    const fOct = Number(f.slice(1, 2)), eOct = Number((notes[2] || "").slice(1, 2));
    check(fOct >= eOct + 1, `the F is the octave up (E${eOct}, F${fOct})`);
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
