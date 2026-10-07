// Screenshots of the toolbars and mixer at phone and iPad sizes, for checking
// the layout by eye (wrapping, empty space). Saves to build/layout.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/layout-shots.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:5180/";
const outDir = path.join(root, "build/layout");
fs.mkdirSync(outDir, { recursive: true });

const sizes = [
    ["phone", 412, 915],
    ["ipad-mini", 744, 1133],
    ["ipad-air", 820, 1180],
    ["ipad-air-landscape", 1180, 820],
    ["ipad-pro-13", 1032, 1376],
];

const browser = await chromium.launch();
for (const [name, width, height] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForSelector(".page canvas", { timeout: 180000 });
    await page.tap("#notes-toggle");
    // a stroke, so the "Saved" note shows
    const pb = await page.locator(".page").first().boundingBox();
    await page.mouse.move(pb.x + 50, pb.y + 100);
    await page.mouse.down();
    await page.mouse.move(pb.x + 150, pb.y + 140, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    for (const tool of ["pen", "text"]) {
        await page.tap(`.tool[data-tool="${tool}"]`);
        await page.waitForTimeout(150);
        const bar = await page.locator("#notesbar").boundingBox();
        await page.screenshot({ path: path.join(outDir, `${name}-notes-${tool}.png`), clip: { x: 0, y: 0, width, height: Math.ceil(bar.y + bar.height + 8) } });
        console.log(`${name} ${tool}: notes bar ${Math.round(bar.height)} px high`);
    }
    await page.tap("#notes-undo");
    await page.tap("#notes-done");

    if (name === "phone" || name === "ipad-air") {
        await page.tap("#play");
        await page.waitForFunction(() => app.state.playbackReady && app.state.playing, null, { timeout: 180000 });
        await page.waitForTimeout(4000); // playback check fills in
        await page.tap("#play");
        await page.tap("#mixer-toggle");
        await page.waitForSelector(".strip:not(.master)");
        await page.locator(".strip:not(.master):not(.metronome)").first().locator(".toggle.s").tap();
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(outDir, `${name}-mixer-unsaved.png`) });
        // opening another score asks about the unsaved changes
        await page.setInputFiles("#file-input", scorePath);
        await page.waitForSelector("#ask[open]");
        await page.screenshot({ path: path.join(outDir, `${name}-ask.png`) });
        await page.click('#ask button:has-text("Don\'t save")');
        await page.waitForSelector(".page canvas", { timeout: 180000 });
    }
    await context.close();
}
await browser.close();
