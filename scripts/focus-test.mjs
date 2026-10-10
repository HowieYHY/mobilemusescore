// Focus mode (issue #17): only the music and a play button. Checks, with touch at phone and iPad
// sizes and the mouse on a desktop:
//   - the Focus button is hidden on the start screen and shows once a score is open,
//   - focus hides both bars and the zoom, leaving only Play on screen,
//   - a tap on a stave plays as usual and stays in focus; Play works,
//   - a tap off the staves (the title area), Escape and the phone's Back each leave it,
//   - an open mixer is hidden, not closed, and comes back; notes mode is finished first,
//   - the tour has a Focus step.
// Then, on every score in "real test musescores", with real clicks: a note on the first system keeps
// focus and the title area above it leaves. Screenshots in build/focus.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/focus-test.mjs [folder or score]

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
const main = scores.find((s) => /I am move it/.test(s)) || scores[0];
const url = process.env.APP_URL || "http://localhost:5180/";
const outDir = path.join(root, "build/focus");
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

// Page coordinates (score units) to the screen, for a point on page `pg`
const toScreen = (page, pg, x, y) =>
    page.evaluate(([pg, x, y]) => {
        const r = document.querySelector(`.page[data-index="${pg}"]`).getBoundingClientRect();
        const k = (96 * app.state.zoom) / 1200;
        return { x: r.left + x * k, y: r.top + y * k };
    }, [pg, x, y]);

// A point on a real notehead of the first system, and one in the title area above it
const points = (page) =>
    page.evaluate(async () => {
        const tl = await app.engine.timeline();
        const sp = app.state.score.spatium;
        // the first notehead on the first system (a score can open with rests)
        const firstSystem = tl.filter((p) => p[1] === 0 && p[3] === tl.find((q) => q[1] === 0)[3]);
        const [, , , y, h] = firstSystem[0];
        let note = null;
        for (const [secs, pg, x] of firstSystem) {
            for (let yy = y; yy <= y + h && !note; yy += sp / 4) {
                for (const dx of [sp, 1.5 * sp, 0.5 * sp, 2 * sp]) {
                    const c = await app.engine.locate(pg, x + dx, yy, 0.5 * sp);
                    if (c && c.note && Math.abs(c.secs - secs) < 0.01) {
                        note = { x: x + dx, y: yy };
                        break;
                    }
                }
            }
            if (note) break;
        }
        const pageW = parseFloat(document.querySelector('.page[data-index="0"]').style.width) / ((96 * app.state.zoom) / 1200);
        return { note, title: { x: pageW / 2, y: Math.max(sp, y - 6 * sp) }, systemTop: y, sp };
    });

const visible = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== "none" && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
}, sel);

const browser = await chromium.launch();
const sizes = [
    ["phone", 390, 844, true],
    ["ipad-air", 820, 1180, true],
    ["desktop", 1280, 800, false],
];
for (const [name, width, height, touch] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log(`[${name}] page error:`, e.message));
    const tapAt = async (pt) => (touch ? page.touchscreen.tap(pt.x, pt.y) : page.mouse.click(pt.x, pt.y));
    const tap = async (sel) => (touch ? page.tap(sel) : page.click(sel));
    const inFocus = () => page.evaluate(() => app.state.focus && document.documentElement.classList.contains("focus"));

    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    check(!(await visible(page, "#focus-toggle")), `${name}: no Focus button on the start screen`);
    await page.setInputFiles("#file-input", main);
    await page.waitForSelector(".page canvas", { timeout: 180000 });
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    check(await visible(page, "#focus-toggle"), `${name}: Focus button shows once a score is open`);
    await page.evaluate(() => (app.testAutoFocus = true)); // off under automation unless asked for

    // an open mixer is hidden while focusing and comes back after
    await tap("#mixer-toggle");
    await page.waitForSelector("#mixer:not([hidden])");
    await tap("#focus-toggle");
    await page.waitForTimeout(400);
    check(await inFocus(), `${name}: Focus enters focus mode`);
    const shown = await page.evaluate(() =>
        ["#topbar, .topbar", "#zoom, .zoom", "#mixer", "#rewind", "#seek", "#speed-open", "#loop-open", "#mixer-toggle"].filter((s) => {
            const el = document.querySelector(s);
            return el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
        }));
    check(shown.length === 0, `${name}: bars, zoom and mixer hidden (${shown.join(", ") || "none showing"})`);
    const play = await page.locator("#play").boundingBox();
    check(play && play.x >= 0 && play.y >= 0 && play.x + play.width <= width && play.y + play.height <= height, `${name}: Play floats on screen at ${Math.round(play.x)},${Math.round(play.y)}`);
    check(await visible(page, "#focus-hint"), `${name}: a hint says how to leave`);
    await page.screenshot({ path: path.join(outDir, `${name}-focus.png`) });

    const p = await points(page);
    // a tap on a note plays from it and stays in focus
    await tapAt(await toScreen(page, 0, p.note.x, p.note.y));
    await page.waitForTimeout(500);
    check(await inFocus(), `${name}: tapping a note stays in focus`);
    await tap("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 20000 }).catch(() => {});
    check(await page.evaluate(() => app.state.playing), `${name}: Play plays in focus`);
    await page.waitForTimeout(1500);
    await tap("#play");
    await page.waitForTimeout(300);

    // off the staves: the title area
    await page.evaluate(() => document.querySelector(".viewer").scrollTo(0, 0));
    await page.waitForTimeout(200);
    await tapAt(await toScreen(page, 0, p.title.x, p.title.y));
    await page.waitForTimeout(500);
    check(!(await inFocus()), `${name}: tapping off the staves leaves focus`);
    check(await visible(page, "#mixer"), `${name}: the open mixer is back`);
    await page.screenshot({ path: path.join(outDir, `${name}-after.png`) });
    await tap("#mixer-close");
    await page.waitForTimeout(300);

    // the phone's Back leaves it too (focus is a layer, like the panels)
    await tap("#focus-toggle");
    await page.waitForTimeout(300);
    await page.goBack();
    await page.waitForTimeout(400);
    check(!(await inFocus()), `${name}: Back leaves focus`);
    if (!touch) {
        await tap("#focus-toggle");
        await page.waitForTimeout(300);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        check(!(await inFocus()), `${name}: Escape leaves focus`);
    }

    // notes mode is finished before focusing
    await tap("#notes-toggle");
    await page.waitForTimeout(300);
    await tap("#focus-toggle");
    await page.waitForTimeout(300);
    check(await page.evaluate(() => !app.notes.active && app.state.focus), `${name}: notes mode finishes when focusing`);
    await page.goBack();
    await page.waitForTimeout(300);

    // the tour has a Focus step
    await tap("#help");
    let titles = [];
    for (let i = 0; i < 14 && (await visible(page, "#tour-card")); i++) {
        titles.push(await page.textContent("#tour-title"));
        if (!(await visible(page, ".tour-next"))) break;
        await tap(".tour-next");
        await page.waitForTimeout(150);
    }
    const order = ["The score", "Play and pause", "Move through the score", "Speed", "Loop", "Mixer", "Save", "Write on the score", "Focus", "Help is here", "Leave a tip"];
    check(titles.join("|") === order.join("|"), `${name}: tour goes bottom bar, top bar, tip last (${titles.join(" / ")})`);

    // smooth: the bars slide and the score glides (transforms and opacity only)
    await page.waitForTimeout(500);
    await tap("#focus-toggle");
    await page.waitForTimeout(120);
    const moving = await page.evaluate(() => document.querySelector(".viewer").getAnimations().length > 0);
    await page.waitForTimeout(500);
    check(moving && (await inFocus()), `${name}: entering focus moves the score up with the bar`);
    await page.goBack();
    await page.waitForTimeout(60);
    const back = await page.evaluate(() => document.querySelector(".topbar").getAnimations().length > 0);
    await page.waitForTimeout(500);
    check(back && !(await inFocus()), `${name}: leaving focus slides the bars back`);

    if (name !== "ipad-air") {
        // focus starts by itself: 4 s without a touch while playing, 10 s while stopped, never over a panel
        await tap("#play");
        await page.waitForFunction(() => app.state.playing, null, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(5000);
        const auto = await page.evaluate(() => ({ focus: app.state.focus, fullscreen: !!document.fullscreenElement }));
        check(auto.focus && !auto.fullscreen, `${name}: focus starts by itself after 4 s of playing untouched (no full screen without a tap)`);
        await page.screenshot({ path: path.join(outDir, `${name}-auto.png`) });
        await tap("#play");
        await page.goBack();
        await page.waitForTimeout(600);
        await page.waitForTimeout(6000);
        check(!(await inFocus()), `${name}: stopped, not yet after 6 s`);
        await page.waitForTimeout(5000);
        check(await inFocus(), `${name}: stopped, focus after 10 s untouched`);
        await page.goBack();
        await page.waitForTimeout(600);
        await tap("#mixer-toggle");
        await page.waitForTimeout(11000);
        check(!(await inFocus()), `${name}: never over an open panel (mixer, 11 s)`);
        await tap("#mixer-close");
    }
    await context.close();
}

// readers who ask for less motion get none
{
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.setInputFiles("#file-input", main);
    await page.waitForSelector(".page canvas", { timeout: 180000 });
    await page.click("#focus-toggle");
    await page.waitForTimeout(50);
    const still = await page.evaluate(() => app.state.focus && document.getAnimations().filter((a) => a.playState === "running" && !(a instanceof CSSTransition)).length === 0);
    check(still, "reduced motion: focus comes at once, with no animation");
    await context.close();
}

// every score, with real clicks: a note keeps focus, the title area above the first system leaves it
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
let previous = null;
for (const score of scores) {
    await page.setInputFiles("#file-input", score);
    if (previous) {
        await page.waitForSelector("#ask[open]", { timeout: 3000 }).then(() => page.click('#ask button:has-text("Don\'t save")')).catch(() => {});
    }
    // wait for this score's own timeline, not the previous score's
    await page.waitForFunction((prev) => app.state.score && app.state.score.title !== prev?.title || app.state.scoreKey !== prev?.key, previous, { timeout: 180000 });
    await page.waitForSelector(".page canvas", { timeout: 180000 });
    await page.waitForTimeout(800);
    previous = await page.evaluate(() => ({ title: app.state.score.title, key: app.state.scoreKey }));
    await page.evaluate(() => document.querySelector(".viewer").scrollTo(0, 0));
    await page.click("#focus-toggle");
    await page.waitForTimeout(300);
    const p = await points(page);
    if (!p.note) {
        check(false, `${path.basename(score)}: no note found on the first system`);
        await page.keyboard.press("Escape");
        continue;
    }
    await page.mouse.click(...Object.values(await toScreen(page, 0, p.note.x, p.note.y)));
    await page.waitForTimeout(300);
    const stays = await page.evaluate(() => app.state.focus);
    if (await page.evaluate(() => app.state.playing)) await page.click("#play");
    const titleRoom = p.systemTop - 6 * p.sp > p.sp;
    let leaves = true;
    if (titleRoom) {
        await page.mouse.click(...Object.values(await toScreen(page, 0, p.title.x, p.title.y)));
        await page.waitForTimeout(300);
        leaves = !(await page.evaluate(() => app.state.focus));
    }
    if (await page.evaluate(() => app.state.focus)) await page.keyboard.press("Escape");
    check(stays && leaves, `${path.basename(score)}: a note keeps focus${titleRoom ? ", the title area leaves it" : " (no room above the first system to test)"}`);
}
await context.close();
await browser.close();
console.log(failures ? `${failures} FAILED` : "All checks passed", "- screenshots in", outDir);
process.exit(failures ? 1 : 0);
