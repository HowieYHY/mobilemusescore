// Edit's "More" panel with real touch: open it, put in notes, sharp, chord, tie, triplet, dynamic, words, lyric,
// key, time, bars and lines, each through its button; every control gets a check of its effect. Then a copy is saved
// and read with desktop MuseScore. Also lays the open panel out at phone, tablet and desktop widths (SHOTS=dir keeps them).
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
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(out, { recursive: true });
await esbuild.build({ entryPoints: [path.join(root, "app/src/newscore.ts")], bundle: true, format: "esm", outfile: path.join(out, "newscore.mjs"), logLevel: "silent" });
const { buildScore } = await import(pathToFileURL(path.join(out, "newscore.mjs")).href);
const musescore = "C:/Program Files/MuseScore 4/bin/MuseScore4.exe";

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const file = path.join(out, "more-ui-start.mscx");
fs.writeFileSync(file, buildScore({ title: "More UI", lines: [{ name: "Melody", clef: "G" }], key: 0, time: [4, 4], bpm: 100, bars: 4 }));

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true }));
const page = await context.newPage();
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
const session = await context.newCDPSession(page);
const tapAt = async (x, y) => {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const tap = async (selector) => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const box = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
    await tapAt(box.x, box.y);
};
const settle = () => page.waitForFunction(() => !app.edit.busy, null, { timeout: 15000 });
// a tap on a button, then its effect: the change counter went up (undo list longer) and the bar is idle again
const press = async (selector, label) => {
    const before = await page.evaluate(() => app.edit.undo);
    // More's tools need More open; the piano makes way while it is, so a key needs it closed
    const wantMore = !selector.startsWith(".piano-key");
    if (await page.evaluate((w) => document.getElementById("edit-more").hidden === w, wantMore)) {
        await page.evaluate(() => document.getElementById("edit-morebtn").click());
        await page.waitForTimeout(150);
    }
    await tap(selector);
    const did = await page.waitForFunction((n) => app.edit.undo > n && !app.edit.busy, before, { timeout: 8000 }).then(() => true, () => false);
    check(did, `${label} changed the score`);
};

await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", file);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
await page.waitForFunction(() => document.querySelectorAll("#pages canvas").length > 0, null, { timeout: 60000 });
await page.evaluate(() => { app.settings.autoFocus = false; });

await tap("#edit-toggle");
await page.waitForFunction(() => !document.getElementById("editbar").hidden);
check(await page.evaluate(() => document.getElementById("edit-more").hidden), "More starts closed");
await tap("#edit-morebtn");
check(await page.evaluate(() => !document.getElementById("edit-more").hidden && document.getElementById("edit-morebtn").getAttribute("aria-expanded") === "true"), "More opens");
check(await page.evaluate(() => ["edit-sharp", "edit-tie", "edit-triplet", "edit-text", "edit-lyric", "edit-key", "edit-time", "edit-rename"].every((id) => document.getElementById(id).disabled)), "note tools wait for a pick");
check(await page.evaluate(() => !document.getElementById("edit-addbars").disabled && !document.getElementById("edit-addline").disabled), "adding bars and lines needs no pick");

// pick the first rest by finding it on the page, then a real touch on it
const spot = await page.evaluate(async () => {
    const sp = app.state.score.spatium, p0 = app.state.score.pages[0];
    for (let y = p0.h * 0.05; y < p0.h * 0.7; y += sp / 2) {
        for (let x = p0.w * 0.2; x < p0.w * 0.9; x += sp / 2) {
            const s = await app.engine.editSelect(0, x, y, sp * 0.3);
            if (s && s.bar === 1) { await app.engine.editClearSelection(); return { x: s.x + s.w / 2, y: s.y + s.h / 2 }; }
        }
    }
    return null;
});
await page.evaluate(() => { document.getElementById("edit-more").hidden = true; document.getElementById("edit-morebtn").setAttribute("aria-expanded", "false"); app.edit.sel = null; });
const pt = await page.evaluate(({ x, y }) => {
    const el = document.querySelector("#pages .page"), p0 = app.state.score.pages[0];
    el.scrollIntoView({ block: "start" });
    const r = el.getBoundingClientRect();
    return { x: r.left + x / p0.w * r.width, y: r.top + y / p0.h * r.height };
}, spot);
await tapAt(pt.x, pt.y);
await page.waitForFunction(() => app.edit.sel, null, { timeout: 5000 });
await tap("#edit-morebtn");
await settle();
check(await page.evaluate(() => !document.getElementById("edit-triplet").disabled && document.getElementById("edit-sharp").disabled), "a rest picked: triplet and words are on, note-only tools off");

// bar 1: E, sharpened, with a G in its chord, mezzo forte, words above and a lyric; then the second note
await page.evaluate(() => { document.querySelector('.piano-key[data-midi="64"]').click(); });
await page.waitForFunction(() => app.edit.sel && !app.edit.busy && app.edit.step);
await page.evaluate(() => document.getElementById("edit-prev").click()); // note input moved on: back to the E
await page.waitForFunction(() => app.edit.sel && app.edit.sel.kind === "note" && !app.edit.busy);
const e0 = await page.evaluate(() => app.edit.sel.pitch);
await press("#edit-sharp", "Sharp");
check(await page.evaluate((p) => app.edit.sel.pitch === p + 1, e0), "the sharp raised the note by a semitone");
// Chord: the next key joins the picked note
await page.evaluate(() => document.getElementById("edit-chordkey").click());
await press('.piano-key[data-midi="67"]', "Add a G to the chord");
check(await page.evaluate(() => app.edit.sel.pitches?.length === 2), "the E's chord has two notes");
await page.evaluate(() => document.getElementById("edit-chordkey").click());
await press('#edit-dynamics button[aria-label="Mark mf"]', "mf");
await page.fill("#edit-words", "dolce");
await press("#edit-text", "Words above");
check(await page.evaluate(() => document.getElementById("edit-words").value === ""), "the words box clears after they are put in");
await press("#edit-triplet", "Triplet");
check(await page.evaluate(() => /triplet/.test(document.getElementById("edit-info").textContent)), "the bar says it is a triplet");
// lyric: the next note is picked so the next syllable can go straight in
await page.fill("#edit-words", "la-");
const before = await page.evaluate(() => ({ x: app.edit.sel.x, y: app.edit.sel.y }));
await press("#edit-lyric", "Lyric");
check(await page.evaluate((b) => app.edit.sel.x !== b.x || app.edit.sel.y !== b.y, before), "after a lyric the next note is picked");
check(await page.evaluate(() => document.getElementById("edit-words").value === ""), "and the box is empty for the next syllable");

// tie: a C on the whole rest of bar 2 and another on bar 3 (the same height), then Tie on the first
const step = async (id) => {
    const from = await page.evaluate(() => ({ x: app.edit.sel.x, y: app.edit.sel.y }));
    await tap(id);
    await page.waitForFunction((f) => app.edit.sel && (app.edit.sel.x !== f.x || app.edit.sel.y !== f.y) && !app.edit.busy, from, { timeout: 5000 });
};
for (let i = 0; i < 12 && !(await page.evaluate(() => app.edit.sel.kind === "rest" && app.edit.sel.bar === 2)); i++) await step("#edit-next");
check(await page.evaluate(() => app.edit.sel.kind === "rest" && app.edit.sel.bar === 2), "walked to the rest of bar 2 with the arrows");
// note input: the second C goes straight after the first, at the same height (nearest the note before)
await press('.piano-key[data-midi="60"]', "C on bar 2");
await press('.piano-key[data-midi="60"]', "a second C after it");
await step("#edit-prev");
const pitches = await page.evaluate(() => app.edit.sel.pitch);
await step("#edit-prev");
check(await page.evaluate((p) => app.edit.sel.kind === "note" && app.edit.sel.pitch === p && !app.edit.sel.tie, pitches), "two Cs of one height, not tied yet");
await press("#edit-tie", "Tie");
check(await page.evaluate(() => app.edit.sel.tie === true), "the tied note says it is tied");

// key, time, bars, lines
await page.selectOption("#edit-key", "2");
await page.waitForFunction(() => !app.edit.busy && app.edit.undo >= 8, null, { timeout: 8000 }).catch(() => {});
check(await page.evaluate(() => document.getElementById("edit-key").value === ""), "the key list goes back to its title after a change");
await page.fill("#edit-bars", "3");
await press("#edit-addbars", "Add bars");
await page.fill("#edit-line", "Harmony");
await page.selectOption("#edit-clef", "F");
await press("#edit-addline", "Add a line");
check(await page.evaluate(() => app.state.tracks.filter((t) => !t.metronome).map((t) => t.title).join()) === "Melody,Harmony", "the new line is in the score: " + await page.evaluate(() => app.state.tracks.filter((t) => !t.metronome).map((t) => t.title).join()));
await page.fill("#edit-line", "Tune");
await press("#edit-rename", "Rename");
check(await page.evaluate(() => app.edit.sel && app.edit.sel.part === "Tune"), "the picked note's line is now called Tune");

// layout of the open panel at every width: nothing wider than the screen
for (const [w, h] of [[320, 640], [412, 915], [820, 1180], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const fit = await page.evaluate(() => {
        const bar = document.getElementById("editbar"), more = document.getElementById("edit-more");
        const wide = [...more.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.id || el.className);
        return { overflow: bar.scrollWidth > bar.clientWidth + 1, wide, top: Math.round(more.getBoundingClientRect().top), h: Math.round(bar.getBoundingClientRect().height), vh: window.innerHeight };
    });
    check(!fit.overflow && fit.wide.length === 0, `${w} px: the open panel fits (bar ${fit.h} px of ${fit.vh}; sticks out: ${fit.wide.join(",") || "nothing"})`);
    if (shots) await page.screenshot({ path: path.join(shots, `more-${w}.png`) });
}
await page.setViewportSize({ width: 412, height: 915 });

// the copy, read by desktop MuseScore
const copy = await page.evaluate(async () => { const r = await app.engine.saveCopy(); return r.ok ? Array.from(new Uint8Array(r.data)) : null; });
check(!!copy, "saved a copy");
if (copy && fs.existsSync(musescore)) {
    const mscz = path.join(out, "more-ui.mscz"), xml = path.join(out, "more-ui.musicxml");
    fs.writeFileSync(mscz, Buffer.from(copy));
    fs.rmSync(xml, { force: true });
    try { execFileSync(musescore, ["-o", xml, mscz], { stdio: "ignore", timeout: 120000 }); } catch (e) { /* checked below */ }
    const x = fs.existsSync(xml) ? fs.readFileSync(xml, "utf8") : "";
    const has = (re, msg) => check(re.test(x), "copy has " + msg);
    has(/<part-name[^>]*>Tune<\/part-name>/, "the line Tune");
    has(/<part-name[^>]*>Harmony<\/part-name>/, "the line Harmony");
    has(/<alter>1<\/alter>/, "the sharp");
    has(/<chord\/>/, "the chord");
    has(/<dynamics[^>]*>\s*<mf\/>/, "mf");
    has(/dolce/, "the words");
    has(/<text>la<\/text>/, "the lyric");
    has(/<tie type="start"\/>/, "the tie");
    has(/<time-modification>/, "the triplet");
    has(/<fifths>2<\/fifths>/, "the new key");
    check(((x.match(/<measure /g) || []).length) >= 14, "and the extra bars");
}
await browser.close();
console.log(failures ? `${failures} failed` : "edit-more-ui passed");
process.exit(failures ? 1 : 0);
