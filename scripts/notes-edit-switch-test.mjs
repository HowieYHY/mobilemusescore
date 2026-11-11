// Notes and Edit are never on together, by touch on a phone-sized page: Notes, then Edit (Notes goes),
// then Notes (Edit goes), with the colour palette open too, then Back closes the one that is on and
// leaves nothing behind (a second Back would leave the page). Before the fix, the other mode's button
// closed the first through history, and that late popstate closed the new mode instead: tapping Edit
// in Notes left Notes on.
// Usage: node scripts/notes-edit-switch-test.mjs [score.mscz]
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
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
const startHist = await page.evaluate(() => history.length);

const mode = () => page.evaluate(() => ({
    notes: app.notes.active, edit: app.edit.on,
    notesbar: !document.getElementById("notesbar").hidden, editbar: !document.getElementById("editbar").hidden,
    notesBtn: document.getElementById("notes-toggle").getAttribute("aria-pressed") === "true",
    editBtn: document.getElementById("edit-toggle").getAttribute("aria-pressed") === "true",
    palette: !document.getElementById("palette").hidden,
}));
const only = (m, which) => (which === "notes"
    ? m.notes && m.notesbar && m.notesBtn && !m.edit && !m.editbar && !m.editBtn
    : m.edit && m.editbar && m.editBtn && !m.notes && !m.notesbar && !m.notesBtn);
const settle = () => page.waitForTimeout(400); // a late popstate would land in here

await page.tap("#notes-toggle");
await settle();
check(only(await mode(), "notes"), "Notes: only Notes is on");

await page.tap("#edit-toggle");
await settle();
check(only(await mode(), "edit"), "Edit while in Notes: Notes goes, Edit is on");

await page.tap("#notes-toggle");
await settle();
check(only(await mode(), "notes"), "Notes while in Edit: Edit goes, Notes is on");

await page.tap("#more-colors");
await settle();
check((await mode()).palette, "the colour palette is open over Notes");
await page.tap("#edit-toggle");
await settle();
const m = await mode();
check(only(m, "edit") && !m.palette, "Edit with the palette open: palette and Notes go, Edit is on");

await page.goBack();
await settle();
const back = await mode();
check(!back.edit && !back.notes, "Back closes Edit, and Notes doesn't come back");
check(await page.evaluate(() => history.length) >= startHist && await page.evaluate(() => !history.state?.pocketscoreLayer),
    "no Back entry left over from either mode");

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
