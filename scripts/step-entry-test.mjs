// Note input that moves on, as desktop's (composer #2), by touch on a phone-sized page: a new score in 4/4.
// Eighth, C D E: each letter goes in after the last and the letters stay; the rest key puts in an eighth
// rest; Quarter, F; ← goes back to the F with Higher/Lower (an octave up), → returns to the letters;
// lengths carry over; Undo takes out one step; the edit bar keeps its height throughout. The copy is read
// back by desktop MuseScore: C8 D8 E8 rest8 F4(up an octave) G4 ... in that order.
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
    letters: getComputedStyle(document.getElementById("edit-letters")).display !== "none",
    up: getComputedStyle(document.getElementById("edit-up")).display !== "none",
    len: document.querySelector("#edit-lengths .len[aria-checked='true']")?.dataset.den,
    barH: Math.round(document.getElementById("editbar").getBoundingClientRect().height),
    info: document.getElementById("edit-info")?.textContent ?? "",
}));
const idle = () => page.waitForFunction(() => !app.edit.busy);
const tapLetter = async (l) => { await page.tap(`#edit-letters button:has-text("${l}")`); await idle(); };

let s = await st();
const h0 = s.barH;
check(s.letters && s.sel.kind === "rest", "a new score: the first rest picked, the letters shown");
check(s.len === "4", "note input starts on quarters");
const lettersFit = await page.$$eval("#edit-letters button", (bs) => bs.map((b) => b.getBoundingClientRect()).every((r, i, a) => r.width >= 24 && Math.abs(r.top - a[0].top) < 2));
check(lettersFit, "360 px: C to B and the rest key fit on one row, each at least 24 px wide");

await page.tap('#edit-lengths .len[data-den="8"]');
s = await st();
check(s.len === "8" && /eighth/.test(s.info), "Eighth: chosen for the next notes (no change to the score)");
check(await page.evaluate(() => app.edit.undo) === 0, "choosing a length while entering is not an edit");

const xs = [];
for (const l of ["C", "D", "E"]) {
    await tapLetter(l);
    s = await st();
    xs.push(s.sel.x);
    check(s.letters && s.len === "8", `${l}: in, the letters stay, still eighths`);
}
check(xs[0] < xs[1] && xs[1] < xs[2], "each letter moved the place on");
await page.tap("#edit-rest");
await idle();
check((await st()).letters, "the rest key: in, and on to the next place");
await page.tap('#edit-lengths .len[data-den="4"]');
await tapLetter("F");
s = await st();
check(s.barH === h0, `the edit bar keeps its height while entering (${s.barH} px)`);

// fix the octave of the note just entered: back to it, up an octave, on again
await page.tap("#edit-prev");
await page.waitForTimeout(200);
s = await st();
check(s.sel.kind === "note" && s.sel.name.startsWith("F") && s.up && !s.letters, "← goes back to the F, with Higher and Lower");
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
check(s.letters && s.sel.kind === "rest" && s.len === "4", "→ back to the next place: the letters, quarters still chosen");

await tapLetter("G");
const undoBefore = await page.evaluate(() => app.edit.undo);
await tapLetter("A");
await page.tap("#edit-undo");
await idle();
s = await st();
check(await page.evaluate(() => app.edit.undo) === undoBefore, "Undo takes out one step (the A)");

// the end of the score: fill bar 2, and the last letter keeps what it entered
for (let i = 0; i < 6; i++) {
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
    const got = notes.slice(0, 6).join(" ");
    const f = notes[4] || "";
    check(/^C\d:eighth D\d:eighth E\d:eighth r:eighth F\d:quarter G\d:quarter$/.test(got), "MuseScore reads C D E (eighths), a rest, F G (quarters): " + got);
    const fOct = Number(f.slice(1, 2)), eOct = Number((notes[2] || "").slice(1, 2));
    check(fOct >= eOct + 1, `the F is the octave up (E${eOct}, F${fOct})`);
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
