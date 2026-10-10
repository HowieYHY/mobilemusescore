// Updating while a score is open: PocketScore restarts by itself at a quiet moment and reopens the
// score where the reader was. Checks, with an update marked ready (app.markUpdateReady(): a real one
// can't be produced on demand):
//   - no restart while the music plays, nor while the mixer is open,
//   - a restart once the reader leaves the screen alone for 20 s,
//   - after it, on every test score: the same score, view mode, zoom, scroll, play position, speed
//     and loop, and unsaved notes back from their draft; the kept copy of the score is deleted.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/update-restart-test.mjs [folder or score]

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
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on("pageerror", (e) => {
    console.log("FAIL  page error:", e.message, String(e.stack).split("\n").slice(1, 4).join(" | "));
    failures++;
});
const ready = () => page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready") || !!window.app?.state.score, null, { timeout: 180000 });
const snapshot = () => page.evaluate(() => ({
    title: document.getElementById("score-title").textContent,
    view: document.getElementById("view-mode").value,
    zoom: app.state.zoom,
    scrollTop: document.querySelector(".viewer").scrollTop,
    scrollLeft: document.querySelector(".viewer").scrollLeft,
    position: app.state.position,
    speed: document.getElementById("speed-value").textContent,
    loop: document.getElementById("loop-open").getAttribute("aria-pressed"),
    notesDirty: app.notes.dirty,
}));
// a page that has restarted no longer has this mark
const mark = () => page.evaluate(() => (window.beforeRestart = true));
const restarted = () => page.evaluate(() => !window.beforeRestart);
const quiet = (ms) => page.waitForTimeout(ms); // no input at all meanwhile

await page.goto(url);
await ready();

// the rules for when, on the first score
{
    await page.setInputFiles("#file-input", scores[0]);
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    await mark();
    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 30000 });
    await page.evaluate(() => app.markUpdateReady());
    await quiet(24000);
    check(!(await restarted()), "no restart while the music plays (24 s untouched)");
    await page.click("#play");
    await page.click("#mixer-toggle");
    await quiet(24000);
    check(!(await restarted()), "no restart while the mixer is open (24 s untouched)");
    await page.click("#mixer-close");
    await Promise.all([page.waitForEvent("load", { timeout: 60000 }), quiet(23000)]).catch(() => {});
    await ready();
    check(await restarted(), "restarts by itself after 20 s untouched, stopped, nothing open");
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
}

// every score: the reader's place comes back
for (const [i, score] of scores.entries()) {
    await page.setInputFiles("#file-input", score);
    await page.waitForSelector("#ask[open]", { timeout: 3000 }).then(() => page.click('#ask button:has-text("Don\'t save")')).catch(() => {});
    await page.waitForFunction((n) => document.getElementById("score-title").textContent && app.state.scoreKey && app.state.playbackReady, null, { timeout: 180000 });
    await page.waitForTimeout(800);
    if (i === 0) {
        await page.selectOption("#view-mode", "continuous_h");
        await page.waitForTimeout(1500);
    }
    await page.click("#zoom-in").catch(() => page.evaluate(() => document.querySelector(".zoom button:last-child").click()));
    await page.waitForTimeout(500);
    // speed 70%, the loop on
    await page.click("#speed-open");
    for (let k = 0; k < 6; k++) await page.click("#speed-down");
    await page.click("#speed-close");
    await page.click("#loop-open");
    await page.click("#loop-toggle");
    await page.click("#loop-close");
    // a place in the middle, and an unsaved pen stroke
    await page.evaluate(async () => {
        await app.engine.seek(app.state.duration * 0.4);
    });
    await page.waitForTimeout(800);
    await page.click("#notes-toggle");
    const pb = await page.locator(".page").first().boundingBox();
    await page.mouse.move(pb.x + 60, pb.y + 120);
    await page.mouse.down();
    await page.mouse.move(pb.x + 160, pb.y + 150, { steps: 5 });
    await page.mouse.up();
    await page.click("#notes-done");
    await page.evaluate(() => {
        const v = document.querySelector(".viewer");
        v.scrollTop = Math.min(v.scrollHeight - v.clientHeight, 600);
        v.scrollLeft = Math.min(v.scrollWidth - v.clientWidth, 200);
    });
    await page.waitForTimeout(500);
    const before = await snapshot();
    await mark();
    await Promise.all([page.waitForEvent("load", { timeout: 60000 }), page.evaluate(() => app.restartForUpdate())]);
    await ready();
    await page.waitForFunction((t) => document.getElementById("score-title").textContent === t && app.state.playbackReady, before.title, { timeout: 180000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const after = await snapshot();
    const kept = await page.evaluate(() => new Promise((resolve) => {
        const open = indexedDB.open("pocketscore-restart", 1);
        open.onsuccess = () => {
            const req = open.result.transaction("s").objectStore("s").get("score");
            req.onsuccess = () => resolve(!!req.result);
            req.onerror = () => resolve(false);
        };
        open.onerror = () => resolve(false);
    }));
    const same = (a, b, tol) => Math.abs(a - b) <= tol;
    const ok = after.title === before.title && after.view === before.view && same(after.zoom, before.zoom, 0.01)
        && same(after.scrollTop, before.scrollTop, 4) && same(after.scrollLeft, before.scrollLeft, 4)
        && same(after.position, before.position, 0.3) && after.speed === before.speed && after.loop === before.loop
        && after.notesDirty === before.notesDirty && !kept;
    check(ok, `${path.basename(score)}: back as it was${ok ? "" : `\n        before ${JSON.stringify(before)}\n        after  ${JSON.stringify(after)} kept=${kept}`}`);
}

await context.close();
await browser.close();
console.log(failures ? `${failures} FAILED` : "All checks passed");
process.exit(failures ? 1 : 0);
