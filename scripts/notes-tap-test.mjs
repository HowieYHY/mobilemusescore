// In notes mode with "Draw with finger" off, a finger's tap on a note plays it
// (and moves the playback there), as outside notes mode; with it on, a tap
// draws instead. Real touch input on a phone-sized screen.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/notes-tap-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:5180/";

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.text().startsWith("TRACE") && console.log(m.text()));
const cdp = await context.newCDPSession(page);

await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });

// a note on page 1, on screen: from the engine's timeline (a beat a few bars in)
const target = await page.evaluate(async () => {
    const tl = await app.engine.timeline();
    const el = document.querySelector(".page");
    const r = el.getBoundingClientRect();
    const w = app.state.score.pages[0].w;
    const sp = app.state.score.spatium;
    for (const [secs, pg, x, y] of tl.slice(6)) {
        if (pg !== 0) {
            continue;
        }
        // sweep down from the system's top for a note
        for (let yy = y; yy < y + 40 * sp; yy += sp / 3) {
            const c = await app.engine.seekAt(0, x + sp * 1.2, yy, 0.6 * sp, false);
            if (c && c.note) {
                return { ux: x + sp * 1.2, uy: yy, secs: c.secs };
            }
        }
    }
    return null;
});
await page.evaluate(() => app.engine.seek(0));
await page.waitForTimeout(300);

// where the note is on screen now (the view follows the playback, so it moves)
const onScreen = () => page.evaluate((t) => {
    const r = document.querySelector(".page").getBoundingClientRect();
    const w = app.state.score.pages[0].w;
    return { x: r.left + t.ux / w * r.width, y: r.top + t.uy / w * r.width };
}, target);
const tap = async () => {
    const { x, y } = await onScreen();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(500);
};
const strokes = () => page.locator(".page .ink path").count();

await page.tap("#notes-toggle");
await page.waitForTimeout(200);

// Draw with finger on: a tap draws a dot, the playback stays
if (!(await page.evaluate(() => app.notes.fingerDraws))) {
    await page.tap("#notes-finger");
}
await tap();
check(await strokes() === 1 && Math.abs(await page.evaluate(() => app.state.position)) < 0.01, "Draw with finger on: a tap draws, the playback doesn't move");
await page.tap("#notes-undo");

// Draw with finger off: a tap on a note plays it there
await page.tap("#notes-finger");
check(!(await page.evaluate(() => app.notes.fingerDraws)), "Draw with finger is off");
for (const tool of ["pen", "highlighter", "eraser"]) {
    await page.locator(`.tool[data-tool="${tool}"]`).tap();
    await page.evaluate(() => app.engine.seek(0));
    await page.waitForTimeout(300);
    if (process.env.TRACE) {
        await page.evaluate(() => {
            if (!window.__wrapped) {
                window.__wrapped = true;
                const orig = app.engine.seekAt.bind(app.engine);
                app.engine.seekAt = (...a) => { console.log("TRACE seekAt", JSON.stringify(a)); return orig(...a); };
                for (const t of ["pointerdown", "pointerup", "pointercancel"]) {
                    document.getElementById("pages").addEventListener(t, (e) => console.log("TRACE", t, e.pointerType, e.isPrimary, e.target.className?.baseVal ?? e.target.className), true);
                }
            }
        });
    }
    if (process.env.SHOTS) {
        await page.screenshot({ path: `build/mobile/notes-tap-${tool}.png` });
    }
    await tap();
    const pos = await page.evaluate(() => app.state.position);
    check(Math.abs(pos - target.secs) < 0.05 && await strokes() === 0, `${tool}: a finger tap on a note goes there (${pos.toFixed(2)} s) and plays it, nothing drawn`);
}
// Text: taps are for text boxes
await page.locator('.tool[data-tool="text"]').tap();
await page.evaluate(() => app.engine.seek(0));
await page.waitForTimeout(300);
await tap();
check(Math.abs(await page.evaluate(() => app.state.position)) < 0.01, "Text tool: a single tap doesn't move the playback");

await browser.close();
console.log(failures ? `${failures} failure(s)` : "notes tap checks passed");
process.exit(failures ? 1 : 0);
