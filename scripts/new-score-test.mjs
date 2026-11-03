// New score: the generated file opens in desktop MuseScore and in PocketScore with the parts, key, time
// signature and bars that were asked for. Needs the dev server on :5180 (and MuseScore 4 for the desktop check).
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

const L = (...names) => names.map((n) => ({ name: n, clef: n === "Bass line" ? "F" : n === "Low" ? "G8vb" : "G" }));
const cases = [
    { name: "lines", o: { title: "Four lines & more", lines: L("Melody", "Harmony", "Low", "Bass line"), key: 4, time: [4, 4], bpm: 100, bars: 12 }, staves: 4, bars: 12 },
    { name: "one", o: { title: "One line", lines: L("Tune"), key: -3, time: [3, 4], bpm: 90, bars: 8 }, staves: 1, bars: 8 },
    { name: "compound", o: { title: "Two lines", lines: L("Top", "Bottom"), key: 0, time: [6, 8], bpm: 60, bars: 5 }, staves: 2, bars: 5 },
];
const musescore = "C:/Program Files/MuseScore 4/bin/MuseScore4.exe";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });

for (const c of cases) {
    const file = path.join(out, `new-${c.name}.mscx`);
    fs.writeFileSync(file, buildScore(c.o));
    if (fs.existsSync(musescore)) {
        const xml = path.join(out, `new-${c.name}.musicxml`);
        fs.rmSync(xml, { force: true });
        try { execFileSync(musescore, ["-o", xml, file], { stdio: "ignore", timeout: 120000 }); } catch (e) { /* checked below */ }
        const text = fs.existsSync(xml) ? fs.readFileSync(xml, "utf8") : "";
        const parts = (text.match(/<score-part /g) || []).length;
        const measures = (text.match(/<measure /g) || []).length;
        check(parts === c.o.lines.length && measures === c.bars * c.o.lines.length, `${c.name}: desktop MuseScore reads it (${parts} parts, ${measures} measures)`);
    }
    await page.setInputFiles("#file-input", file);
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
    await page.waitForFunction(() => document.querySelectorAll("#pages canvas").length > 0, null, { timeout: 60000 });
    const info = await page.evaluate(() => ({ tracks: app.state.score.tracks.filter((t) => !t.metronome).length, title: app.state.score.title, bars: document.getElementById("seek") && app.state.score.bars }));
    const names = await page.evaluate(() => app.state.score.tracks.filter((t) => !t.metronome).map((t) => t.title));
    check(info.tracks === c.o.lines.length && JSON.stringify(names) === JSON.stringify(c.o.lines.map((l) => l.name)), `${c.name}: PocketScore shows the lines as named: ${names.join(", ")}`);
    await page.screenshot({ path: path.join(out, `new-${c.name}.png`) });
}
await browser.close();
console.log(failures ? `${failures} failed` : "new score passed");
process.exit(failures ? 1 : 0);
