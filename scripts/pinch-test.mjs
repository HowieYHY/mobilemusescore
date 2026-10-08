// Pinch zoom (issue #8): the point of the score between the fingers must stay
// under them, during the gesture and after the page is redrawn at the new size.
// Uses the browser's real touch input on a phone-sized screen.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/pinch-test.mjs [score.mscz]

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

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const cdp = await context.newCDPSession(page);

await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForSelector(".page canvas", { timeout: 180000 });
// the status bar above the score comes and goes while the sounds load, moving
// the score; measure once it has settled
await page.waitForFunction(() => app.state.playbackReady && document.getElementById("status").hidden, null, { timeout: 180000 });
await page.waitForTimeout(500);

// the score point (page, fraction across, fraction down) under a screen point
const pointAt = (x, y) => page.evaluate(([x, y]) => {
    for (const el of document.querySelectorAll(".page")) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            return { page: Number(el.dataset.index), fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
        }
    }
    return null;
}, [x, y]);
// where that score point is on screen now
const screenOf = (p) => page.evaluate((p) => {
    const r = document.querySelectorAll(".page")[p.page].getBoundingClientRect();
    return { x: r.left + p.fx * r.width, y: r.top + p.fy * r.height };
}, p);

// two fingers around (cx, cy), spreading from d0 to d1 apart, the middle moving by (mx, my)
async function pinch(cx, cy, d0, d1, mx = 0, my = 0, steps = 12, checkMidway = null) {
    const pts = (d, ox, oy) => [{ x: cx + ox - d / 2, y: cy + oy, id: 0 }, { x: cx + ox + d / 2, y: cy + oy, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pts(d0, 0, 0)[0]] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(d0, 0, 0) });
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d0 + (d1 - d0) * t, mx * t, my * t) });
        if (checkMidway && i === steps >> 1) {
            await checkMidway(cx + mx * t, cy + my * t);
        }
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(400);
}

async function trial(label, cx, cy, d0, d1, mx = 0, my = 0) {
    const before = await pointAt(cx, cy);
    const z0 = await page.evaluate(() => app.state.zoom);
    if (!before) {
        check(false, `${label}: no page under the fingers`);
        return;
    }
    let midErr = 0;
    await pinch(cx, cy, d0, d1, mx, my, 12, async (x, y) => {
        const s = await screenOf(before);
        midErr = Math.hypot(s.x - x, s.y - y);
    });
    const after = await screenOf(before);
    const err = Math.hypot(after.x - (cx + mx), after.y - (cy + my));
    const z1 = await page.evaluate(() => app.state.zoom);
    check(midErr < 3, `${label}: during the pinch the point stays under the fingers (off by ${midErr.toFixed(1)} px)`);
    check(err < 4 && Math.abs(z1 / z0 - d1 / d0) < 0.02 * (d1 / d0) + 0.001 || (z1 >= 3.99 || z1 <= 0.301) && err < 4,
        `${label}: after redrawing it is still there (off by ${err.toFixed(1)} px), zoom ${Math.round(z0 * 100)}% -> ${Math.round(z1 * 100)}%`);
}

await trial("zoom in on the upper right", 300, 350, 80, 200);
await trial("zoom in further, lower left", 120, 650, 100, 180);
await trial("zoom out in the middle", 206, 450, 220, 110);
await trial("zoom in while moving the fingers", 200, 400, 90, 160, -40, 60);

// buttons zoom around the middle of the view
const v = await page.evaluate(() => { const r = document.getElementById("viewer").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const mid = await pointAt(v.x, v.y);
await page.tap("#zoom-in");
await page.waitForTimeout(300);
const s = await screenOf(mid);
check(Math.hypot(s.x - v.x, s.y - v.y) < 4, `+ keeps the middle of the view in place (off by ${Math.hypot(s.x - v.x, s.y - v.y).toFixed(1)} px)`);

// two-finger scroll: the score follows the fingers, no zoom, nothing drawn
async function twoFingerScroll(label) {
    const before = await page.evaluate(() => ({ top: document.getElementById("viewer").scrollTop, zoom: app.state.zoom, ink: document.querySelectorAll(".ink path").length }));
    const p0 = await pointAt(206, 600);
    await pinch(206, 600, 120, 124, 0, -250, 15); // fingers 4 px wider: still a scroll
    const after = await page.evaluate(() => ({ top: document.getElementById("viewer").scrollTop, zoom: app.state.zoom, ink: document.querySelectorAll(".ink path").length }));
    const s = await screenOf(p0);
    check(after.zoom === before.zoom && after.ink === before.ink && Math.abs(s.y - 350) < 3,
        `${label}: two fingers scroll the score ${(after.top - before.top).toFixed(0)} px, it stays under them (off by ${Math.abs(s.y - 350).toFixed(1)} px), zoom and notes unchanged`);
}
await page.evaluate(() => { document.getElementById("viewer").scrollTop = 100; });
await twoFingerScroll("reading");
await page.tap("#notes-toggle");
if (!(await page.evaluate(() => app.notes.fingerDraws))) {
    await page.tap("#notes-finger");
}
await page.evaluate(() => { document.getElementById("viewer").scrollTop = 100; });
await twoFingerScroll("notes, Draw with finger on");
await page.tap("#notes-finger");
await page.evaluate(() => { document.getElementById("viewer").scrollTop = 100; });
await twoFingerScroll("notes, Draw with finger off");

await browser.close();
console.log(failures ? `${failures} failure(s)` : "pinch checks passed");
process.exit(failures ? 1 : 0);
