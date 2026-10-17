// Typing leaves nothing for the system to undo (issue #30: iPadOS's Shake to Undo kept offering
// "Undo Typing"). In WebKit, `document.queryCommandEnabled("undo")` stands in for the iPad's undo
// list: after typing in the Bar field, Speed's tempo field and a note text box it must be false,
// and the typing must still work (caret, Backspace, Enter, leaving the field, arrow keys).
// A plain <input> typed in at the end shows the check can fail.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/undo-typing-test.mjs [score.mscz] [webkit|chromium]   (webkit by default)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const playwright = require("playwright");

const dir = path.join(root, "real test musescores");
const scorePath = (process.argv[2] && process.argv[2] !== "-") ? process.argv[2] : path.join(dir, fs.readdirSync(dir).find((f) => /\.mscz$/i.test(f)));
const url = process.env.APP_URL || "http://localhost:5180/";

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

const browserName = process.argv[3] || "webkit";
const browser = await playwright[browserName].launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
// WebKit on Windows has no Web Audio, so the sounds never load: wait for the score and the bar field
await page.waitForFunction(() => document.querySelector(".page canvas") && !document.getElementById("goto").hidden, null, { timeout: 180000 });
await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
console.log(`score: ${path.basename(scorePath)}, ${browserName}`);
const undoable = () => page.evaluate(() => document.queryCommandEnabled("undo"));
const measure = () => page.evaluate(async () => (await app.engine.cursor(app.state.position)).measure);

// Bar: focus selects all; type, Backspace, type; Enter goes there
const bars = await page.evaluate(async () => (await app.engine.bars()).bars.length);
const want = Math.min(13, bars);
await page.click("#bar");
await page.keyboard.type(String(want).slice(0, -1) + "9");
await page.keyboard.press("Backspace");
await page.keyboard.type(String(want).slice(-1));
check(await page.inputValue("#bar") === String(want), `Bar: typing, Backspace and typing again shows ${want} (${await page.inputValue("#bar")})`);
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
check(await measure() === want, `Bar: Enter goes to bar ${want} (at bar ${await measure()})`);
check(!(await undoable()), "Bar: nothing left to undo");
await page.click("#bar");
await page.keyboard.type("2");
await page.click("#viewer", { position: { x: 5, y: 5 } }); // leaving the field also goes there
await page.waitForTimeout(700);
check(await measure() === Math.min(2, bars), `Bar: leaving the field goes to bar 2 (at bar ${await measure()})`);
check(!(await undoable()), "Bar: still nothing to undo");

// Speed's tempo field
await page.click("#speed-open");
const base = await page.evaluate(() => Number(document.getElementById("tempo-input").value));
const half = Math.round(base / 2);
await page.click("#tempo-input");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type(String(half) + "x"); // a letter is ignored
check(await page.inputValue("#tempo-input") === String(half), `Tempo: typed ${half} (${await page.inputValue("#tempo-input")})`);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const speed = await page.evaluate(() => document.getElementById("speed-value").textContent);
check(Math.abs(parseInt(speed, 10) - 50) <= 2, `Tempo: Enter sets the speed to about 50% (${speed})`);
await page.click("#tempo-input");
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(400);
check(await page.inputValue("#tempo-input") === String(half + 1), `Tempo: arrow up adds one (${await page.inputValue("#tempo-input")})`);
await page.keyboard.press("Enter");
check(!(await undoable()), "Tempo: nothing left to undo");
await page.click("#speed-close");

// A note text box, then typed into again
const box = await page.locator(".page").first().boundingBox();
const tx = box.x + box.width * 0.6;
const ty = box.y + Math.min(box.height, 700) * 0.4;
await page.click("#notes-toggle");
await page.click('.tool[data-tool="text"]');
await page.mouse.dblclick(tx, ty);
await page.keyboard.type("Breathe");
await page.mouse.click(tx, ty + 150);
check(await page.locator(".tnote .tbody").first().innerText() === "Breathe", "Text box: typed and finished");
check(!(await undoable()), "Text box: nothing left to undo once finished");
await page.locator(".tnote .tbody").first().click();
check(await page.locator(".tnote.sel").count() === 1, "Text box: can be edited again");
await page.keyboard.press("End");
await page.keyboard.type(" herx");
await page.keyboard.press("Backspace");
await page.keyboard.type("e");
await page.keyboard.press("Enter");
await page.keyboard.type("in");
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
await page.keyboard.type("then ");
const editingText = await page.evaluate(() => document.querySelector(".tnote .tbody").textContent);
check(editingText === "Breathe here\nthen in", `Text box: Backspace, a new line and typing mid-line work (${JSON.stringify(editingText)})`);
await page.mouse.click(tx, ty + 150);
check(await page.locator(".tnote .tbody").first().innerText() === "Breathe here\nthen in", "Text box: the second typing is kept");
check(!(await undoable()), "Text box: nothing left to undo after editing again");
await page.click("#notes-done");

// the check itself can fail: a plain input keeps its typing
await page.evaluate(() => {
    const i = document.createElement("input");
    i.id = "plain";
    i.style.cssText = "position:fixed;top:0;left:0;z-index:99999";
    document.body.append(i);
});
await page.click("#plain");
await page.keyboard.type("12");
await page.evaluate(() => document.getElementById("plain").blur());
check(await undoable(), "Control: a plain input's typing is undoable (the check works)");

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
