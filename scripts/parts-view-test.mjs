// One line at a time while editing (#33), by touch on a phone-sized page: a new score with two lines.
// Edit opens on the first line alone (one staff in each system); Lines shown offers All and each line; the
// second line alone: the place picked is the same bar there, and a piano key puts its note on that line; All
// brings both back; the lines button is not there for a score with one line. Nothing about it is saved or
// undone: the copy has both lines visible (read back by desktop MuseScore) and Undo's count is the notes'
// only. Leaving Edit shows every line again; on a wide screen Edit opens on all lines.
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
const out = path.join(root, "build/parts-view");
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

async function open(width, height, lines) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => check(false, "page error: " + e.message));
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.tap("#new-score");
    await page.fill("#ns-title", "Lines");
    for (let i = 1; i < lines; i++) {
        await page.tap("#ns-add");
    }
    await page.fill("#ns-bars", "4");
    await page.tap("#ns-create");
    await page.waitForFunction(() => app.edit.on && app.edit.sel && app.edit.parts.parts.length > 0);
    return { context, page };
}
// what the page shows: the staves of the first system, the lines button, the picked place
const st = (page) => page.evaluate(async () => ({
    staves: (await app.engine.staves())[0]?.[2].map((s) => s[0]) ?? [],
    shown: app.edit.parts.shown,
    button: !document.getElementById("edit-partsbtn").hidden && document.getElementById("edit-partsbtn").offsetParent !== null,
    sel: app.edit.sel && { kind: app.edit.sel.kind, staff: app.edit.sel.staff, bar: app.edit.sel.bar, part: app.edit.sel.part },
    undo: app.edit.undo,
    tracks: app.state.tracks.filter((t) => !t.metronome).map((t) => `${t.title}:${t.hidden ? "hidden" : "shown"}`),
}));
const settled = (page) => page.waitForFunction(() => !app.edit.busy);
const choose = async (page, label) => {
    await page.tap("#edit-partsbtn");
    await page.tap(`#parts-list button:has-text("${label}")`);
    await page.waitForTimeout(50);
    await settled(page);
};

// ---- a phone, two lines
{
    const { context, page } = await open(360, 780, 2);
    await page.waitForFunction(() => app.edit.parts.shown === 0 && !app.edit.busy);
    let s = await st(page);
    check(s.staves.join() === "0" && s.button, `a phone: Edit opens on the first line alone (staves ${s.staves})`);
    check(s.sel?.staff === 0 && s.undo === 0, "the first rest is still picked, and showing one line is not a change to undo");
    const names = await (async () => {
        await page.tap("#edit-partsbtn");
        const n = await page.$$eval("#parts-list button", (bs) => bs.map((b) => `${b.textContent}${b.getAttribute("aria-checked") === "true" ? "*" : ""}`));
        await page.tap("#parts-close");
        return n;
    })();
    check(names.length === 3 && names[0] === "All lines" && names[1].endsWith("*"), `Lines shown lists All and both lines, the one shown marked: ${names.join(", ")}`);

    // on to bar 2, then the second line alone: the same bar is picked there
    await page.tap("#edit-next");
    await page.waitForTimeout(200);
    const bar = (await st(page)).sel.bar;
    await choose(page, names[2].replace("*", ""));
    s = await st(page);
    check(s.staves.join() === "1" && s.shown === 1, `the second line alone (staves ${s.staves})`);
    check(s.sel?.staff === 1 && s.sel.bar === bar, `the same bar is picked on it (bar ${s.sel?.bar}, staff ${s.sel?.staff})`);
    check(s.tracks.every((t) => t.endsWith(":shown")), "the mixer still has both lines as shown: " + s.tracks.join(", "));

    // a key puts its note on the line shown
    const key = page.locator('.piano-key[data-midi="60"]');
    await key.scrollIntoViewIfNeeded();
    const b = await key.boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height * 0.85);
    await page.waitForFunction(() => app.edit.undo === 1 && !app.edit.busy);
    s = await st(page);
    check(s.sel?.staff === 1 && s.staves.join() === "1", "a piano key: the note went on the second line, still alone");

    // the copy has both lines, visible
    const copy = await page.evaluate(async () => { const r = await app.engine.saveCopy(); return r.ok ? Array.from(new Uint8Array(r.data)) : null; });
    check(!!copy, "saved a copy while one line is shown");
    s = await st(page);
    check(s.staves.join() === "1", "after saving, the page still shows the one line");
    if (copy && fs.existsSync(musescore)) {
        const mscz = path.join(out, "lines.mscz"), xml = path.join(out, "lines.musicxml");
        fs.writeFileSync(mscz, Buffer.from(copy));
        fs.rmSync(xml, { force: true });
        try { execFileSync(musescore, ["-o", xml, mscz], { stdio: "ignore", timeout: 300000 }); } catch (e) { /* checked below */ }
        const x = fs.existsSync(xml) ? fs.readFileSync(xml, "utf8") : "";
        const parts = [...x.matchAll(/<part id="(\w+)">([\s\S]*?)<\/part>/g)];
        const hidden = /print-object="no"/.test(x);
        const c4 = parts[1] && /<step>C<\/step>\s*<octave>4/.test(parts[1][2]) && !/<step>C<\/step>/.test(parts[0][2]);
        check(parts.length === 2 && !hidden, `MuseScore reads both lines, neither hidden (${parts.length} parts)`);
        check(!!c4, "and the C is on the second line only");
    }

    // All, then leave Edit from one line: every line is back
    await choose(page, "All lines");
    s = await st(page);
    check(s.staves.join() === "0,1" && s.shown === -1 && s.sel?.staff === 1, `All lines: both back, the place kept (staves ${s.staves})`);
    await choose(page, names[1].replace("*", ""));
    check((await st(page)).staves.join() === "0", "the first line alone again");
    await page.tap("#edit-undo");
    await page.waitForFunction(() => app.edit.undo === 0 && !app.edit.busy);
    s = await st(page);
    check(s.staves.join() === "0" && s.shown === 0, "Undo took out the note and left the line shown as it was");
    await page.tap("#edit-done");
    await page.waitForFunction(async () => !app.edit.on && (await app.engine.staves())[0]?.[2].length === 2);
    check(true, "Done: both lines show again");
    await context.close();
}

// ---- a phone, one line: nothing to choose
{
    const { context, page } = await open(360, 780, 1);
    await page.waitForTimeout(400);
    const s = await st(page);
    check(!s.button && s.shown === -1, "a score with one line: no lines button");
    await context.close();
}

// ---- a tablet: all lines to start, one line on request
{
    const { context, page } = await open(820, 1180, 2);
    await page.waitForTimeout(400);
    await settled(page);
    let s = await st(page);
    check(s.staves.join() === "0,1" && s.button && s.shown === -1, `a tablet: Edit opens on all lines, with the button (staves ${s.staves})`);
    await context.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
