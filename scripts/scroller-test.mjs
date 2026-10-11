// The drag handle at the score's edge (issue #20), with real touch input on a phone-sized screen:
// a finger's scroll shows it and it fades after; scrolling done by the app (following the music)
// doesn't show it; dragging it moves the score to the same fraction, with the page (page view) or
// the time in the music (continuous views) in its label; pages are drawn while it is held; it never
// covers the zoom buttons (or Focus mode's play button), and while hidden it takes no taps.
//
// Needs the dev server: (cd app && npx vite --host 127.0.0.1 --port 5180)
// Usage: node scripts/scroller-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it edited.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const cdp = await context.newCDPSession(page);
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 });
const b64 = fs.readFileSync(scorePath).toString("base64");
await page.evaluate(async ({ name, b64 }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    await app.openScore(name, bytes.buffer);
}, { name: path.basename(scorePath), b64 });
await page.waitForSelector(".page canvas", { timeout: 120000 });
await page.waitForTimeout(1500); // the status bar settles (it moves the viewer)

const shown = () => page.evaluate(() => document.getElementById("scroller").classList.contains("shown"));
const viewerMiddle = () => page.evaluate(() => {
    const r = document.getElementById("viewer").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
// a finger's scroll, as real touch input (Input.synthesizeScrollGesture doesn't scroll the viewer here)
async function swipe(dx, dy) {
    const m = await viewerMiddle();
    const x0 = m.x - 60 - dx / 2;
    const y0 = m.y - dy / 2;
    await touch("touchStart", x0, y0);
    for (let i = 1; i <= 10; i++) {
        await touch("touchMove", x0 + dx * i / 10, y0 + dy * i / 10);
        await page.waitForTimeout(16);
    }
    await touch("touchEnd");
}
const state = () => page.evaluate(() => {
    const v = document.getElementById("viewer");
    const across = document.getElementById("view-mode").value === "continuous_v";
    const t = document.getElementById("scroller-thumb").getBoundingClientRect();
    const z = document.querySelector(".zoom").getBoundingClientRect();
    return {
        frac: across ? v.scrollLeft / (v.scrollWidth - v.clientWidth) : v.scrollTop / (v.scrollHeight - v.clientHeight),
        thumb: { x: t.left + t.width / 2, y: t.top + t.height / 2, left: t.left, right: t.right, top: t.top, bottom: t.bottom },
        zoom: { left: z.left, right: z.right, top: z.top, bottom: z.bottom },
        label: document.getElementById("scroller-label").textContent,
        labelShown: getComputedStyle(document.getElementById("scroller-label")).display !== "none",
    };
});
const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
// a page in view still waiting for its drawing
const blankInView = () => page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    return [...document.querySelectorAll(".page .tile")].some((t) => {
        const r = t.getBoundingClientRect();
        return r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right && !t.querySelector("canvas");
    });
});

// drag the thumb with a finger to `f` of the way along its track; returns the state while still held
async function drag(f, midway) {
    await page.waitForFunction(() => document.getElementById("status").hidden); // the viewer at its full height
    const s = await state();
    const track = await page.evaluate(() => {
        const r = document.getElementById("scroller").getBoundingClientRect();
        return { left: r.left, top: r.top, w: r.width, h: r.height };
    });
    const across = await page.evaluate(() => document.getElementById("view-mode").value === "continuous_v");
    const len = across ? track.w : track.h;
    const thumbLen = across ? s.thumb.right - s.thumb.left : s.thumb.bottom - s.thumb.top;
    const target = (across ? track.left : track.top) + thumbLen / 2 + f * (len - thumbLen);
    await touch("touchStart", s.thumb.x, s.thumb.y);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        await touch("touchMove", across ? s.thumb.x + (target - s.thumb.x) * k : s.thumb.x, across ? s.thumb.y : s.thumb.y + (target - s.thumb.y) * k);
        await page.waitForTimeout(16);
        if (i === steps / 2 && midway) {
            await midway();
        }
    }
    await page.waitForTimeout(1500); // held still: the pages in view get drawn
    const held = { ...(await state()), blank: await blankInView(), shown: await shown() };
    await touch("touchEnd");
    return held;
}

for (const mode of ["page", "continuous_h", "continuous_v"]) {
    if (mode !== "page") {
        await page.selectOption("#view-mode", mode);
        await page.waitForTimeout(2500);
    }
    const across = mode === "continuous_v";
    check(!(await shown()), `${mode}: hidden until the reader scrolls`);

    // the app scrolling by itself (as when following the music) doesn't show it
    await page.evaluate((across) => {
        const v = document.getElementById("viewer");
        across ? (v.scrollLeft += 400) : (v.scrollTop += 400);
    }, across);
    await page.waitForTimeout(300);
    check(!(await shown()), `${mode}: not shown when the app scrolls (following the music)`);

    await swipe(across ? -300 : 0, across ? 0 : -300);
    await page.waitForTimeout(200);
    check(await shown(), `${mode}: a finger's scroll shows it`);
    // while hidden it must take no taps: check after it fades
    await page.waitForTimeout(2200);
    check(!(await shown()), `${mode}: fades out after the scroll stops`);
    const hiddenHit = await page.evaluate(() => {
        const t = document.getElementById("scroller-thumb").getBoundingClientRect();
        const el = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
        return el?.closest("#scroller") ? "the handle" : el?.className || el?.tagName;
    });
    check(hiddenHit !== "the handle", `${mode}: while hidden, a tap there reaches the score (${hiddenHit})`);

    for (const f of [0.5, 0.9, 0.1]) {
        await swipe(across ? -40 : 0, across ? 0 : -40);
        await page.waitForTimeout(200);
        const held = await drag(f);
        const want = mode === "page" ? /^Page \d+ of \d+$/ : /^\d+:\d\d of \d+:\d\d$/;
        check(held.shown && Math.abs(held.frac - f) < 0.03, `${mode}: dragged to ${f * 100}%, the score is at ${(held.frac * 100).toFixed(1)}%`);
        check(held.labelShown && want.test(held.label), `${mode}: label while dragging: "${held.label}"`);
        check(!held.blank, `${mode}: pages in view drawn while the handle is held`);
        check(!overlap(held.thumb, held.zoom), `${mode}: the handle stays clear of the zoom buttons`);
    }
    const after = await state();
    check(!after.labelShown, `${mode}: label gone when the finger lifts`);
    await page.waitForTimeout(2200);
    check(!(await shown()), `${mode}: fades out after the drag`);
}

// the label follows the score: dragging to the end in page view says the last page
await page.selectOption("#view-mode", "page");
await page.waitForTimeout(2500);
await swipe(0, -300);
await page.waitForTimeout(200);
const end = await drag(1);
const pages = await page.evaluate(() => app.state.score.pages.length);
check(end.label === `Page ${pages} of ${pages}`, `page view: at the end the label says "${end.label}" (${pages} pages)`);

// a status message appearing above the score mid-drag (the viewer gets shorter) doesn't move the
// score away from where the finger put it
await swipe(0, 300); // back from the end
await page.waitForTimeout(200);
const resized = await drag(0.5, () => page.evaluate(() => {
    const s = document.getElementById("status");
    s.textContent = "Loading instrument sounds… (test)";
    s.hidden = false;
}));
await page.evaluate(() => (document.getElementById("status").hidden = true));
check(Math.abs(resized.frac - 0.5) < 0.01, `status message mid-drag: the score is at ${(resized.frac * 100).toFixed(1)}% (50% wanted)`);
await page.waitForTimeout(2200);


// Focus mode: no zoom box, a floating play button at the bottom right instead; the handle stops short of it
await page.click("#focus-toggle");
await page.waitForTimeout(1500);
await swipe(0, 300); // back from the end, where the last drag left it
await page.waitForTimeout(200);
const inFocus = await drag(1);
const play = await page.evaluate(() => {
    const r = document.querySelector(".transport").getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
});
check(inFocus.shown && !overlap(inFocus.thumb, play), `focus: at the end the handle stays clear of the play button (handle bottom ${inFocus.thumb.bottom.toFixed(0)}, button top ${play.top.toFixed(0)})`);

check(errors.length === 0, "no page errors " + errors.join("; "));
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all scroller checks passed");
process.exit(failures ? 1 : 0);
