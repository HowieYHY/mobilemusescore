// Changing several parts' sound at once (issue #6): in the sound list, choose
// more parts (or All parts), pick a sound, and every chosen part gets it;
// "Each part's sound in the score" puts them back.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/sounds-multi-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:5180/";
const outDir = path.join(root, "build/mobile");
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForSelector(".page canvas", { timeout: 180000 });
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });

const parts = () => page.evaluate(() => app.state.tracks.filter((t) => !t.metronome).map((t) => ({ title: t.title, soundId: t.soundId, score: t.scoreSoundId })));
const before = await parts();
console.log(`${before.length} parts: ${before.map((p) => p.title).join(", ")}`);

await page.tap("#mixer-toggle");
await page.waitForTimeout(400);
await page.locator(".strip .sound").first().tap();
await page.waitForSelector("#sounds:not([hidden])");
check(!(await page.locator(".apply-to").isVisible()), "the part chips are hidden until asked for (uncluttered list)");
await page.locator("#sounds-many").tap();
check(await page.locator(".apply-to .part-chip").count() === before.length + 1, "Several parts shows every part and All parts");
check(await page.locator('.part-chip[aria-pressed="true"]').count() === 1, "it starts with just the part it was opened from");

// two parts, then all
await page.locator(".apply-to .part-chip:not(.all)").nth(1).tap();
check((await page.locator("#sounds-title").innerText()).includes("2 parts"), "choosing a second part: title says 2 parts");
await page.locator(".part-chip.all").tap();
check((await page.locator("#sounds-title").innerText()).includes(`${before.length} parts`), `All parts: title says ${before.length} parts`);
await page.screenshot({ path: path.join(outDir, "sounds-multi.png") });

// pick a sound none of them has
const target = await page.evaluate((ids) => {
    for (const b of document.querySelectorAll(".sounds details .pick")) {
        if (!ids.includes(b.dataset.id)) {
            b.closest("details").open = true;
            b.closest("details").parentElement.closest("details")?.setAttribute("open", "");
            b.dataset.test = "target";
            return { id: b.dataset.id, name: b.innerText.trim() };
        }
    }
    return null;
}, before.map((p) => p.soundId));
await page.locator('.sounds .pick[data-test="target"]').scrollIntoViewIfNeeded();
await page.locator('.sounds .pick[data-test="target"]').tap();
await page.waitForTimeout(1500);
const after = await parts();
check(after.every((p) => p.soundId === target.id), `every part now plays "${target.name}"`);
check(!(await page.locator("#save").isDisabled()), "Save lights up");

// back to the score's sounds
await page.locator(".strip .sound").first().tap();
await page.waitForSelector("#sounds:not([hidden])");
await page.locator("#sounds-many").tap();
await page.locator(".part-chip.all").tap();
await page.locator(".pick.own").tap();
await page.waitForTimeout(1500);
const back = await parts();
check(back.every((p, i) => p.soundId === before[i].soundId), "Each part's sound in the score puts every part back");
check(await page.locator("#save").isDisabled(), "Save goes dark again (nothing changed from the score)");

await browser.close();
console.log(failures ? `${failures} failure(s)` : "multi-part sound checks passed");
process.exit(failures ? 1 : 0);
