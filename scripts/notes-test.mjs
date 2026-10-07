// Drives the Notes button in a browser: draws with the pen, adds a text box,
// erases, undoes, and checks the notes come back after reloading the app.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/notes-test.mjs [score.mscz] [chromium|webkit]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const playwright = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescore files/I am move it edited.mscz"));
const browserName = process.argv[3] || "chromium";
const url = process.env.APP_URL || "http://localhost:5180/";
const outDir = path.join(root, "build/notes", browserName);
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await playwright[browserName].launch();
const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

async function open() {
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForSelector(".page canvas", { timeout: 180000 });
}

await open();
const box = await page.locator(".page").first().boundingBox();

await page.click("#notes-toggle");
check(await page.isVisible("#notesbar"), "Notes button shows the notes toolbar");

// a pen stroke across the first system
const sx = box.x + box.width * 0.2;
const sy = box.y + box.height * 0.25;
await page.mouse.move(sx, sy);
await page.mouse.down();
for (let i = 1; i <= 20; i++) {
    await page.mouse.move(sx + i * 12, sy + Math.sin(i / 3) * 15);
}
await page.mouse.up();
check(await page.locator(".page .ink path.pen").count() === 1, "pen stroke drawn");
const posBefore = await page.evaluate(() => app.state.position);

// highlighter
await page.click('.tool[data-tool="highlighter"]');
await page.mouse.move(sx, sy + 80);
await page.mouse.down();
await page.mouse.move(sx + 200, sy + 80, { steps: 10 });
await page.mouse.up();
check(await page.locator(".page .ink path.highlighter").count() === 1, "highlight drawn");

// text box
await page.click('.tool[data-tool="text"]');
await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
await page.keyboard.type("Breathe here");
await page.click('.tool[data-tool="pen"]'); // leaves the text box
check((await page.locator(".tnote .tbody").first().innerText()) === "Breathe here", "text box typed");
check(await page.evaluate(() => app.state.position) === posBefore, "drawing did not move the playback position");

// eraser removes the highlight, undo brings it back
await page.click('.tool[data-tool="eraser"]');
await page.mouse.move(sx + 100, sy + 60);
await page.mouse.down();
await page.mouse.move(sx + 100, sy + 100, { steps: 5 });
await page.mouse.up();
check(await page.locator(".page .ink path.highlighter").count() === 0, "eraser removed the highlight");
await page.click("#notes-undo");
check(await page.locator(".page .ink path.highlighter").count() === 1, "undo restored it");

await page.click("#notes-done");
check(!(await page.isVisible("#notesbar")), "Done hides the toolbar");
await page.locator(".page").first().screenshot({ path: path.join(outDir, "page1-notes.png") });

// zoom keeps notes in place (relative to the page)
const rel = async () => page.evaluate(() => {
    const p = document.querySelector(".page").getBoundingClientRect();
    const t = document.querySelector(".tnote").getBoundingClientRect();
    return [(t.left - p.left) / p.width, (t.top - p.top) / p.height];
});
const r1 = await rel();
await page.click("#zoom-in");
await page.waitForTimeout(300);
const r2 = await rel();
check(Math.abs(r1[0] - r2[0]) < 0.01 && Math.abs(r1[1] - r2[1]) < 0.01, `text box stays put when zooming (${r1.map((v) => v.toFixed(3))} vs ${r2.map((v) => v.toFixed(3))})`);

// saved: reload the app and open the same file again
await page.waitForTimeout(500);
await open();
await page.waitForTimeout(300);
check(await page.locator(".page .ink path").count() === 2, "strokes come back after reopening");
check((await page.locator(".tnote .tbody").first().innerText().catch(() => "")) === "Breathe here", "text comes back after reopening");

// while not annotating, a tap on the score still moves the playback position
const c = await page.evaluate(() => app.engine.seekAt(0, 6000, 8000));
check(!!c && c.secs > 0, "tap-to-seek still works outside notes mode");

// clear
await page.click("#notes-toggle");
page.once("dialog", (d) => d.accept());
await page.click("#notes-clear");
check(await page.locator(".page .ink path, .tnote").count() === 0, "Clear removes everything");
await page.click("#notes-undo");
check(await page.locator(".page .ink path").count() === 2, "undo after Clear brings them back");

await browser.close();
console.log(failures ? `${failures} failure(s)` : "all notes checks passed");
process.exit(failures ? 1 : 0);
