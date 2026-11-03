// The engine's composing edits beyond notes: bars, key, time, tie, accidental, triplet, chord, words, dynamic,
// lyric, a new line, a renamed line. Builds a blank score, edits it through the engine, saves a copy, and reads
// the copy with desktop MuseScore (MusicXML) to see what really is in it.
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const esbuild = require("esbuild");
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const out = path.join(root, "build/spike");
fs.mkdirSync(out, { recursive: true });
await esbuild.build({ entryPoints: [path.join(root, "app/src/newscore.ts")], bundle: true, format: "esm", outfile: path.join(out, "newscore.mjs"), logLevel: "silent" });
const { buildScore } = await import(pathToFileURL(path.join(out, "newscore.mjs")).href);

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };
const musescore = "C:/Program Files/MuseScore 4/bin/MuseScore4.exe";

const file = path.join(out, "more-start.mscx");
fs.writeFileSync(file, buildScore({ title: "More", lines: [{ name: "Melody", clef: "G" }], key: 0, time: [4, 4], bpm: 100, bars: 4 }));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", file);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
await page.waitForFunction(() => document.querySelectorAll("#pages canvas").length > 0, null, { timeout: 60000 });

const E = (code) => page.evaluate(code);
const ok = async (label, expr) => { const r = await E(expr); check(r && r.ok !== false, `${label}${r && r.error ? ": " + r.error : ""}`); return r; };
const goBar = (n) => E(`(async () => { let s = await app.engine.editSelectStart(); for (let i = 0; i < 20 && s && s.bar < ${n}; i++) s = await app.engine.editMove("next-measure"); return s && s.bar; })()`);

await E("app.engine.editSelectStart()");
// bar 1: a note, a second note on its chord, a sharp on the top one, a dynamic, words, a lyric
await ok("enter C", "app.engine.editEnterNote(0)");
await ok("add E to the chord", "app.engine.editAddToChord(2)");
await ok("sharp", "app.engine.editAccidental(0)");
await ok("dynamic mf", "app.engine.editDynamic(4)");
await ok("words", 'app.engine.editStaffText("dolce")');
await ok("lyric la-", 'app.engine.editLyric("la-")');
// bar 2: two half notes of one pitch, tied
await goBar(2);
await ok("two half notes", "app.engine.editInsertNotes([[72, 8], [72, 8]])");
await ok("tie", "app.engine.editTie()");
// bar 3: four quarters, the first becomes a triplet
await goBar(3);
await ok("four quarters", "app.engine.editInsertNotes([[74, 4], [74, 4], [74, 4], [74, 4]])");
await ok("triplet", "app.engine.editTriplet()");
// key and time from bar 3 on
await ok("key of D (2 sharps)", "app.engine.editSetKey(2)");
await ok("time 3/4", "app.engine.editSetTime(3, 4)");
await ok("add 3 bars", "app.engine.editAddBars(3)");
await E("app.engine.editSelectStart()");
await ok("rename the line", 'app.engine.editRenameLine("Tune")');
await ok("add a line", 'app.engine.editAddLine("Bass", 2)');
check((await E("app.engine.tracks().then((t) => t.map((x) => x.title).join())")) === "Tune,Bass,Metronome", "the mixer lists the renamed and the new line: " + (await E("app.engine.tracks().then((t) => t.map((x) => x.title).join())")));
// undo of the last step brings the line back out again, redo returns it
await ok("undo", "app.engine.editUndo()");
check((await E("app.state.score.tracks.filter((t) => !t.metronome).length")) >= 1, "undo kept the score");
await ok("redo", "app.engine.editRedo()");
await E("new Promise((r) => setTimeout(r, 500))");

const copy = await E("(async () => { const r = await app.engine.saveCopy(); return r.ok ? Array.from(new Uint8Array(r.data)) : null; })()");
check(!!copy, "saved a copy");
if (copy && fs.existsSync(musescore)) {
    const mscz = path.join(out, "more-edited.mscz");
    const xml = path.join(out, "more-edited.musicxml");
    fs.writeFileSync(mscz, Buffer.from(copy));
    fs.rmSync(xml, { force: true });
    try { execFileSync(musescore, ["-o", xml, mscz], { stdio: "ignore", timeout: 120000 }); } catch (e) { /* checked below */ }
    const x = fs.existsSync(xml) ? fs.readFileSync(xml, "utf8") : "";
    check(x.length > 0, "desktop MuseScore reads the copy");
    const has = (re, msg) => check(re.test(x), msg);
    has(/<part-name[^>]*>Tune<\/part-name>/, "line renamed to Tune");
    has(/<part-name[^>]*>Bass<\/part-name>/, "a second line, Bass");
    has(/<alter>1<\/alter>/, "a sharp");
    has(/<chord\/>/, "a chord");
    has(/<dynamics[^>]*>\s*<mf\/>/, "dynamic mf");
    has(/dolce/, "words 'dolce'");
    has(/<text>la<\/text>/, "lyric 'la'");
    has(/<syllabic>begin<\/syllabic>/, "lyric begins a word");
    has(/<tie type="start"\/>/, "a tie");
    has(/<time-modification>/, "a triplet");
    has(/<fifths>2<\/fifths>/, "key of D");
    has(/<beats>3<\/beats>/, "3/4 time");
    const bars = (x.match(/<measure /g) || []).length;
    check(bars >= 14, `at least 7 bars on two lines (${bars} measures; 4/4 notes spill over when 3/4 starts)`);
}
await browser.close();
console.log(failures ? `${failures} failed` : "edit-more passed");
process.exit(failures ? 1 : 0);
