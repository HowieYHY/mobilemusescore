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

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
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
check(await page.locator(".page .ink path.pen").getAttribute("stroke") === "#000000", "the pen is black by default");
check(await page.locator('#swatches .swatch[data-color="#ffffff"]').count() === 1, "white is in the toolbar's colours");
const posBefore = await page.evaluate(() => app.state.position);

// highlighter
await page.click('.tool[data-tool="highlighter"]');
await page.mouse.move(sx, sy + 80);
await page.mouse.down();
await page.mouse.move(sx + 200, sy + 80, { steps: 10 });
await page.mouse.up();
check(await page.locator(".page .ink path.highlighter").count() === 1, "highlight drawn");

// text box: a single tap does nothing, a double tap adds one
await page.click('.tool[data-tool="text"]');
const tx = box.x + box.width * 0.6;
const ty = box.y + box.height * 0.4;
await page.mouse.click(tx, ty);
await page.waitForTimeout(500); // longer than a double tap
check(await page.locator(".tnote").count() === 0, "a single tap with the text tool adds no text box");
await page.mouse.dblclick(tx, ty);
check(await page.locator(".tnote.sel").count() === 1, "a double tap adds a text box, ready to type");
await page.keyboard.type("Breathe here");
check(await page.locator(".tnote.sel .tdel").isVisible(), "the box being edited shows its delete button");
const bodyAt = () => page.locator(".tnote .tbody").first().boundingBox();
const editing = await bodyAt();
check(await page.locator(".tnote.sel .tbody").evaluate((el) => getComputedStyle(el).backgroundColor) === "rgba(0, 0, 0, 0)",
    "the box being edited is see-through, not yellow");
await page.mouse.click(tx, ty + 200); // one tap outside
const finished = await bodyAt();
check(Math.abs(editing.x - finished.x) < 1 && Math.abs(editing.y - finished.y) < 1,
    `the text stays exactly where it was when the box is finished (moved ${(finished.x - editing.x).toFixed(1)}, ${(finished.y - editing.y).toFixed(1)} px)`);
check(await page.isHidden("#sizes"), "the Text tool has no size dots (the box is resized instead)");

// drag the box's corner: the text gets bigger, and starts where it did
await page.click(".tnote .tbody");
const before = await bodyAt();
const corner = await page.locator(".tnote.sel .tsize").boundingBox();
await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
await page.mouse.down();
await page.mouse.move(corner.x + corner.width / 2 + 80, corner.y + corner.height / 2 + 30, { steps: 8 });
await page.mouse.up();
const after = await bodyAt();
check(after.width > before.width * 1.3 && after.height > before.height * 1.3, `dragging the corner makes the text bigger (${Math.round(before.width)}x${Math.round(before.height)} to ${Math.round(after.width)}x${Math.round(after.height)} px)`);
check(Math.abs(after.x - before.x) < 1 && Math.abs(after.y - before.y) < 1, "and the text still starts in the same place");
await page.mouse.click(tx, ty + 200); // finish it
check(await page.locator(".tnote.sel").count() === 0 && await page.locator(".tnote").count() === 1,
    "one tap outside finishes the text box without adding another");
check(!(await page.locator(".tnote .tdel").first().isVisible()), "a finished text box is no longer highlighted");
check((await page.locator(".tnote .tbody").first().innerText()) === "Breathe here", "text box typed");
await page.click('.tool[data-tool="pen"]');

// more colours: the palette sets the pen colour
await page.click("#more-colors");
check(await page.isVisible("#palette"), "More colours opens the palette");
await page.click('#palette .swatch[data-color="#5f3dc4"]');
check(!(await page.isVisible("#palette")), "choosing a colour closes the palette");
check(await page.locator("#more-colors.custom").count() === 1, "a palette colour shows on the More colours button");
await page.mouse.move(sx, sy + 140);
await page.mouse.down();
await page.mouse.move(sx + 120, sy + 150, { steps: 6 });
await page.mouse.up();
check(await page.locator('.page .ink path.pen[stroke="#5f3dc4"]').count() === 1, "the pen draws in the palette colour");
await page.click("#notes-undo");
await page.click('#swatches .swatch[data-color="#000000"]');

// thickness: the thickest pen draws a wider line than the default
const widthOf = (sel) => page.locator(sel).last().evaluate((el) => Number(el.getAttribute("stroke-width")));
const normalWidth = await widthOf(".page .ink path.pen");
await page.locator("#sizes .size").nth(3).click();
check(await page.locator("#sizes .size.on").count() === 1 && await page.locator("#sizes .size").nth(3).getAttribute("aria-checked") === "true", "a size can be chosen");
await page.mouse.move(sx, sy + 140);
await page.mouse.down();
await page.mouse.move(sx + 120, sy + 150, { steps: 6 });
await page.mouse.up();
const thickWidth = await widthOf(".page .ink path.pen");
check(thickWidth > normalWidth * 2, `the thickest pen draws a wider line (${thickWidth} vs ${normalWidth} page units)`);
await page.click("#notes-undo");
await page.locator("#sizes .size").nth(1).click();
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

// not saved yet: Save lights up; closing the app keeps the work, still unsaved
check(await page.isEnabled("#save") && await page.locator("#save.primary").count() === 1, "Save lights up after changes");
await page.waitForTimeout(500);
await open();
await page.waitForTimeout(300);
check(await page.locator(".page .ink path").count() === 2, "unsaved strokes come back after reopening");
check((await page.locator(".tnote .tbody").first().innerText().catch(() => "")) === "Breathe here", "unsaved text comes back after reopening");
check(await page.isEnabled("#save"), "and they are still marked unsaved");
await page.waitForFunction(() => /unsaved changes from last time/.test(document.getElementById("status").textContent), null, { timeout: 60000 })
    .then(() => check(true, "a message says the unsaved changes are back"), () => check(false, "a message says the unsaved changes are back"));

// Save, then reopen: kept, and nothing unsaved
await page.click("#save");
check(!(await page.isEnabled("#save")), "after Save there is nothing to save");
await open();
await page.waitForTimeout(300);
check(await page.locator(".page .ink path").count() === 2 && await page.locator(".tnote").count() === 1, "saved notes come back after reopening");
check(!(await page.isEnabled("#save")), "saved notes are not marked unsaved");

// while not annotating, a tap on the score still moves the playback position
const c = await page.evaluate(() => app.engine.seekAt(0, 6000, 8000));
check(!!c && c.secs > 0, "tap-to-seek still works outside notes mode");

// clear (the app's own question: a system dialog would stop the sound on iPad)
await page.click("#notes-toggle");
await page.click("#notes-clear");
await page.waitForSelector("#ask[open]");
await page.click('#ask button:has-text("Clear all")');
await page.waitForTimeout(200); // the answer arrives once the question has closed
check(await page.locator(".page .ink path, .tnote").count() === 0, "Clear removes everything");
await page.click("#notes-undo");
check(await page.locator(".page .ink path").count() === 2, "undo after Clear brings them back");

// opening a score with unsaved changes asks first; Don't save drops them
await page.click("#notes-clear");
await page.click('#ask button:has-text("Clear all")');
await page.waitForTimeout(200);
await page.setInputFiles("#file-input", scorePath);
await page.waitForSelector("#ask[open]");
check(true, "opening a score with unsaved changes asks whether to save");
await page.click('#ask button:has-text("Don\'t save")');
await page.waitForTimeout(1500);
check(await page.locator(".page .ink path").count() === 2, "Don't save keeps the last saved notes");

// tidy up for the next run
await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pocketscore.")).forEach((k) => localStorage.removeItem(k)));

await browser.close();
console.log(failures ? `${failures} failure(s)` : "all notes checks passed");
process.exit(failures ? 1 : 0);
