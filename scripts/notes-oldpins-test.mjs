// Notes saved by an earlier version keep their places when this version opens them. Until 12 Nov 2026 a
// note was pinned to the music by a time in seconds; now also by its bar and the place in it (so it can
// follow the music when it is edited). Draws a line and saves it, rewrites what was stored the way the
// earlier version stored it (pins without a bar), reopens the app and the score, and checks: nothing
// moved on the page, Save is not lit (nothing changed for the reader), the pin has its bar now, and the
// line shows at the same place in the continuous view as before.
// Usage: node scripts/notes-oldpins-test.mjs [score.mscz]
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const scorePath = path.resolve(process.argv[2] || ["real test musescores", "real test musescore files"]
    .map((d) => path.join(root, d, "I am move it edited.mscz")).find((f) => fs.existsSync(f)));

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1366 } })).newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
const open = async () => {
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.waitForFunction(() => !app.state.score);
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    await page.waitForTimeout(500);
};
const stroke = () => page.evaluate(() => {
    const p = Object.entries(app.notes.data.modes.page ?? {}).find(([, v]) => v.strokes.length);
    return p ? { page: Number(p[0]), pts: p[1].strokes[0].pts.slice(), pins: p[1].strokes[0].a } : null;
});
const inContinuous = async () => {
    await page.selectOption("#view-mode", "continuous_h");
    await page.waitForTimeout(1500);
    const at = await page.evaluate(() => [...app.notes.shown.values()].flatMap((v) => v.strokes)[0]?.parts[0] ?? null);
    await page.selectOption("#view-mode", "page");
    await page.waitForTimeout(1500);
    return at;
};

await open();
// a line over the music of the first line of the score
const at = await page.evaluate(async () => {
    const tl = await app.engine.timeline();
    const p = tl[3];
    const el = document.querySelector(`.page[data-index="${p[1]}"]`);
    const r = el.getBoundingClientRect();
    const [, , w, h] = el.querySelector("svg.ink").getAttribute("viewBox").split(" ").map(Number);
    return { x: r.left + p[2] * r.width / w, y: r.top + (p[3] + p[4] * 0.3) * r.height / h };
});
await page.click("#notes-toggle");
await page.mouse.move(at.x, at.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) {
    await page.mouse.move(at.x + i * 12, at.y + (i % 2) * 6);
}
await page.mouse.up();
await page.click("#notes-done");
await page.click("#save");
await page.waitForFunction(() => document.getElementById("save").disabled);
const drawn = await stroke();
check(!!drawn && drawn.pins.every((a) => a && a.length === 7 && a[5] >= 0), "a line drawn now is pinned to its bar");
const before = await inContinuous();
check(!!before, "and shows in the continuous view");

// what the earlier version would have stored: the same notes, pins without the bar
const key = await page.evaluate(() => app.state.scoreKey);
const old = await page.evaluate((k) => {
    const d = JSON.parse(localStorage.getItem("pocketscore.notes." + k));
    for (const pages of Object.values(d.modes)) {
        for (const p of Object.values(pages)) {
            for (const s of p.strokes) {
                s.a = s.a.map((a) => (a ? a.slice(0, a[3] == null ? 3 : 5) : a));
            }
        }
    }
    delete d.stale;
    localStorage.setItem("pocketscore.notes." + k, JSON.stringify(d));
    localStorage.removeItem("pocketscore.notesDraft." + k);
    return Object.values(Object.values(d.modes)[0])[0].strokes[0].a[0].length;
}, key);
check(old === 5 || old === 3, `stored again as the earlier version did (pins of ${old} values)`);

await open();
const now = await stroke();
check(!!now && now.page === drawn.page && now.pts.join() === drawn.pts.join(), "opened by this version: the line is where it was on the page");
check(!!now && now.pins.every((a) => a && a.length === 7 && a[5] >= 0), "its pins have their bar now");
check(!!now && now.pins.every((a, i) => a[5] === drawn.pins[i][5] && Math.abs(a[6] - drawn.pins[i][6]) < 0.001), "the same bar and place as when it was drawn");
check(!(await page.isEnabled("#save")), "Save is not lit: nothing changed for the reader");
check(await page.evaluate(() => !document.getElementById("status").textContent.includes("unsaved")), "and no message about unsaved changes");
const after = await inContinuous();
check(!!after && after.length === before.length && after.every((v, i) => Math.abs(v - before[i]) <= 2), "in the continuous view it is where it was");

await page.evaluate((k) => { localStorage.removeItem("pocketscore.notes." + k); localStorage.removeItem("pocketscore.notesDraft." + k); }, key);
await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
