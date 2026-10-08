// Save must stay dark when nothing was changed (issue #5). Opens each score
// on a phone-sized screen and does things that change nothing: waits for the
// sounds, opens and closes the mixer and the sound list, enters and leaves
// notes mode, switches tools, double-taps nowhere, plays, seeks, taps notes,
// zooms, switches views and back, and reopens the score. After each step it
// checks the Save button and says what differs if it lit up.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/no-change-test.mjs [score.mscz | folder]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const arg = path.resolve(process.argv[2] || path.join(root, "real test musescores"));
const scores = fs.statSync(arg).isDirectory()
    ? fs.readdirSync(arg).filter((f) => /\.mscz$/i.test(f)).map((f) => path.join(arg, f))
    : [arg];
const url = process.env.APP_URL || "http://localhost:5180/";

let failures = 0;
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

for (const scorePath of scores) {
    const name = path.basename(scorePath);
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));

    // Save lit up? Then say why: which mixer values or notes differ
    const check = async (step) => {
        await page.waitForTimeout(500);
        const r = await page.evaluate(() => {
            const save = document.getElementById("save");
            const why = [];
            if (app.mix.dirty) {
                const ref = app.mix.saved || app.mix.score;
                const now = app.currentMix ? app.currentMix() : null;
                why.push("mixer" + (now && ref ? ": " + JSON.stringify(Object.entries(now.parts).filter(([k, p]) => JSON.stringify(p) !== JSON.stringify(ref.parts[k])).map(([k, p]) => [k, p, ref.parts[k]])) + (Math.abs(now.master - ref.master) > 0.05 ? ` master ${ref.master} -> ${now.master}` : "") : ""));
            }
            if (app.notes.dirty) {
                why.push("notes");
            }
            return { lit: !save.disabled, why: why.join("; ") };
        });
        if (r.lit) {
            failures++;
            console.log(`FAIL ${name}: Save lit up after "${step}" (${r.why})`);
        }
        return !r.lit;
    };

    const open = async () => {
        await page.goto(url);
        await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
        await page.setInputFiles("#file-input", scorePath);
        await page.waitForSelector(".page canvas", { timeout: 180000 });
    };

    await open();
    await check("opening");
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    await check("sounds loaded");

    await page.tap("#mixer-toggle");
    await page.waitForTimeout(500);
    await check("opening the mixer");
    const soundBtn = page.locator(".strip .sound").first();
    if (await soundBtn.count()) {
        await soundBtn.tap().catch(() => {});
        await page.waitForTimeout(400);
        await page.goBack().catch(() => {}); // Back closes the list without choosing
        await check("opening and closing a sound list");
    }
    // touching a slider without moving it (or brushing it while scrolling the
    // mixer) makes it report its value again
    await page.evaluate(() => document.querySelectorAll(".mixer input[type=range]").forEach((r) => {
        r.dispatchEvent(new Event("input", { bubbles: true }));
        r.dispatchEvent(new Event("change", { bubbles: true }));
    }));
    await check("touching the sliders without moving them");
    await page.goBack().catch(() => {});
    await page.waitForTimeout(300);
    await check("closing the mixer");

    await page.tap("#notes-toggle");
    // end on the eraser: taps with the pen would draw dots (a real change)
    for (const tool of ["highlighter", "text", "pen", "eraser"]) {
        await page.locator(`.tool[data-tool="${tool}"]`).tap().catch(() => {});
    }
    const box = await page.locator(".page").first().boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 20);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 20);
    await page.waitForTimeout(400);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await check("notes mode: switching tools, tapping the score with the eraser");
    await page.goBack().catch(() => {});
    await check("leaving notes mode");

    await page.tap("#play");
    await page.waitForTimeout(3000);
    await page.tap("#play");
    await check("play and pause");
    await page.evaluate(() => app.engine.seekAt(0, 6000, 8000, 300, true));
    await check("tapping a note");

    await page.tap("#zoom-in").catch(() => {});
    await page.tap("#zoom-out").catch(() => {});
    await check("zooming");
    for (const mode of ["continuous_h", "page"]) {
        await page.selectOption("#view-mode", mode).catch(() => {});
        await page.waitForTimeout(1500);
    }
    await check("switching views and back");

    await open();
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    if (await check("reopening")) {
        console.log(`ok   ${name}`);
    }
    await context.close();
}

await browser.close();
console.log(failures ? `${failures} failure(s)` : "Save stayed dark on every score");
process.exit(failures ? 1 : 0);
