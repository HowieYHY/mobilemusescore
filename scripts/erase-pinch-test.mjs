// The eraser must stop when a second finger lands (that is a pinch or a two-finger scroll, which the app
// handles itself): bug-hunt finding 27. With "Draw with finger" on and the Eraser chosen, one finger
// moving over a stroke erases it; with a second finger already down, the first finger moving over the
// stroke must erase nothing (a pen stroke is already cancelled by a second finger).
// Real touch input (CDP Input.dispatchTouchEvent), as the CLAUDE.md lesson asks.
//
// Needs a server: (cd app && npx vite preview --port 4173), or the dev server (APP_URL).
// Usage: node scripts/erase-pinch-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:4173/";
let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const cdp = await context.newCDPSession(page);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForSelector(".page canvas", { timeout: 180000 });
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
const box = await page.locator(".page").first().boundingBox();
await page.click("#notes-toggle");

const sx = box.x + box.width * 0.2;
const sy = box.y + box.height * 0.25;
async function drawStroke() {
    await page.click('.tool[data-tool="pen"]');
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
        await page.mouse.move(sx + i * 12, sy);
    }
    await page.mouse.up();
}
const strokes = () => page.locator(".page .ink path.pen").count();

await page.evaluate(() => app.notes.setFingerDraws(true));

// control: one finger, eraser, moving over the stroke erases it (so the check below can fail)
await drawStroke();
check(await strokes() === 1, "a pen stroke is drawn");
await page.click('.tool[data-tool="eraser"]');
let A = { x: sx - 40, y: sy }; // well outside the eraser's reach (about 10 px): the touch-down itself erases nothing
await touch("touchStart", [A]);
for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [{ x: A.x + i * 10, y: A.y }]);
    await sleep(20);
}
await touch("touchEnd", []);
check(await strokes() === 0, "control: one finger with the eraser erases the stroke it moves over");

// a second finger is down: the first moving over a stroke erases nothing
await drawStroke();
check(await strokes() === 1, "a second pen stroke is drawn");
await page.click('.tool[data-tool="eraser"]');
const B = { x: sx + 150, y: sy + 260 };
await touch("touchStart", [A]);
check(await strokes() === 1, "the first finger landing 40 px away erases nothing");
await sleep(30);
await touch("touchStart", [A, B]); // the second finger lands
await sleep(30);
for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [{ x: A.x + i * 10, y: A.y }, B]);
    await sleep(20);
}
await touch("touchEnd", []);
check(await strokes() === 1, "with a second finger down, the first moving over the stroke erases nothing");

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
