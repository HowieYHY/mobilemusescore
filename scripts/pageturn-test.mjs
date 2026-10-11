// "Page by page" view, with real touch input: one whole page on screen, never part of another; a
// swipe turns exactly one page (a long fast one too, a short one none); the page turns with the
// music; turning the phone fits the page again on the same page; in notes mode two fingers turn it;
// arrow keys turn it; zoom never goes below the whole page, and zoomed in a finger moves around the
// page (no other page shows) and a swipe past its edge turns it; back in Page view the same page.
//
// Needs the dev server: (cd app && npx vite --host 127.0.0.1 --port 5180)
// Usage: [WIDTH=412 HEIGHT=915] node scripts/pageturn-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it edited.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const W = Number(process.env.WIDTH || 412);
const H = Number(process.env.HEIGHT || 915);

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
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
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 60000 }).catch(() => {});

// what is on screen: the pages showing (fully or partly), and whether the zoom box is visible
const view = () => page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    const shown = [];
    let whole = -1;
    document.querySelectorAll(".page").forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const overlapW = Math.min(r.right, v.right) - Math.max(r.left, v.left);
        const overlapH = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
        if (overlapW > 0.5 && overlapH > 0.5) {
            shown.push(i);
            if (r.left >= v.left - 0.5 && r.right <= v.right + 0.5 && r.top >= v.top - 0.5 && r.bottom <= v.bottom + 0.5) {
                whole = i;
            }
        }
    });
    const z = document.querySelector(".zoom").getBoundingClientRect();
    return { shown, whole, zoomShown: z.width > 0, zoom: app.state.zoom, pages: document.querySelectorAll(".page").length };
});
// one page, whole, and nothing of any other
const onePage = (s) => s.shown.length === 1 && s.whole === s.shown[0];
const settle = () => page.waitForTimeout(900);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
const middle = () => page.evaluate(() => {
    const r = document.getElementById("viewer").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
async function swipe(dx, { fingers = 1, ms = 160 } = {}) {
    const m = await middle();
    const steps = 8;
    const pts = (k) => Array.from({ length: fingers }, (_, f) => ({ x: m.x - dx / 2 + dx * k / steps, y: m.y + f * 60, id: f + 1 }));
    await touch("touchStart", pts(0));
    for (let k = 1; k <= steps; k++) {
        await touch("touchMove", pts(k));
        await page.waitForTimeout(ms / steps);
    }
    await touch("touchEnd", []);
    await settle();
}

await page.evaluate(() => {
    window.__statusLog = [];
    new MutationObserver(() => window.__statusLog.push(`${Math.round(performance.now())} ${document.getElementById("status").hidden ? "hidden" : document.getElementById("status").textContent}`))
        .observe(document.getElementById("status"), { attributes: true, childList: true, characterData: true, subtree: true });
});
const bars = await page.evaluate(() => getComputedStyle(document.getElementById("viewer")).scrollbarWidth);
check(bars === "none", `touch screen: the browser's own scrollbars are hidden (scrollbar-width ${bars})`);
await page.selectOption("#view-mode", "page_turn");
await page.waitForTimeout(500);
// the status message ("Laying out…") going makes the screen taller, and the page is fitted again
await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
if (process.env.DEBUG) {
    for (let k = 0; k < 6; k++) {
        console.log("     zoom", await page.evaluate(() => [app.state.zoom.toFixed(3), document.getElementById("viewer").clientHeight, document.getElementById("status").hidden]));
        await page.waitForTimeout(500);
    }
}
let s = await view();
check(onePage(s) && s.whole === 0, `opens on page 1, whole and alone (shown ${s.shown})`);
check(s.zoomShown, "zoom buttons shown");
const fit = s.zoom;
await page.click("#zoom-out");
await settle();
s = await view();
check(Math.abs(s.zoom - fit) < 0.001 && onePage(s) && s.whole === 0, `− at the whole page goes no smaller (zoom ${s.zoom.toFixed(3)}, fitted ${fit.toFixed(3)})`);

await swipe(-W * 0.5);
s = await view();
check(onePage(s) && s.whole === 1, `a swipe left turns one page (page ${s.whole + 1}, shown ${s.shown})`);
await swipe(-W * 0.9, { ms: 60 });
s = await view();
check(onePage(s) && s.whole === 2, `a long fast swipe still turns only one (page ${s.whole + 1}, shown ${s.shown})`);
await swipe(-30, { ms: 300 });
s = await view();
check(onePage(s) && s.whole === 2, `a short slow swipe turns none (page ${s.whole + 1})`);
await swipe(W * 0.5);
s = await view();
check(onePage(s) && s.whole === 1, `a swipe right goes back one (page ${s.whole + 1})`);
const drawn = await page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    return [...document.querySelectorAll(".page .tile")].filter((t) => {
        const r = t.getBoundingClientRect();
        return r.right > v.left && r.left < v.right;
    }).every((t) => t.querySelector("canvas"));
});
check(drawn, "the page shown is drawn");

// pinch out: zoomed in, still only this page; a finger moves around it; past its edge a swipe turns
const z0 = s.zoom;
const onPage = s.whole;
{
    const m = await middle();
    await touch("touchStart", [{ x: m.x - 50, y: m.y, id: 1 }, { x: m.x + 50, y: m.y, id: 2 }]);
    for (let k = 1; k <= 8; k++) {
        await touch("touchMove", [{ x: m.x - 50 - k * 15, y: m.y, id: 1 }, { x: m.x + 50 + k * 15, y: m.y, id: 2 }]);
        await page.waitForTimeout(16);
    }
    await touch("touchEnd", []);
    await page.waitForTimeout(1500);
}
s = await view();
check(s.zoom > z0 * 1.5 && s.shown.length === 1 && s.shown[0] === onPage, `pinching zooms in (zoom ${s.zoom.toFixed(2)}, was ${z0.toFixed(2)}), only page ${onPage + 1} shows (shown ${s.shown})`);
const scrollOf = () => page.evaluate(() => ({ left: document.getElementById("viewer").scrollLeft, top: document.getElementById("viewer").scrollTop }));
{
    const a = await scrollOf();
    const m = await middle();
    await touch("touchStart", [{ x: m.x, y: m.y + 100, id: 1 }]);
    for (let k = 1; k <= 8; k++) {
        await touch("touchMove", [{ x: m.x, y: m.y + 100 - k * 25, id: 1 }]);
        await page.waitForTimeout(16);
    }
    await touch("touchEnd", []);
    await settle();
    const b = await scrollOf();
    s = await view();
    check(b.top > a.top + 100 && s.shown.length === 1 && s.shown[0] === onPage, `zoomed in, a finger moves down the page (${(b.top - a.top).toFixed(0)} px), still page ${onPage + 1} only`);
}
// to the page's right edge, then past it
let swipesToTurn = 0;
for (let k = 0; k < 8; k++) {
    await swipe(-W * 0.6, { ms: 400 });
    swipesToTurn++;
    s = await view();
    if (s.shown[0] !== onPage) {
        break; // turned
    }
}
console.log(`     (${swipesToTurn} swipes: across the zoomed page, then past its edge)`);
const pastEdge = s.shown.length === 1 ? s.shown[0] : -1;
check(pastEdge === onPage + 1, `swiping on past the page's right edge turns to the next page (page ${pastEdge + 1}, shown ${s.shown})`);
await swipe(W * 0.6);
s = await view();
check(s.shown.length === 1 && s.shown[0] === onPage, `and a swipe back past its left edge returns (shown ${s.shown})`);
for (let k = 0; k < 8; k++) {
    await page.click("#zoom-out");
    await page.waitForTimeout(150);
}
await settle();
s = await view();
check(Math.abs(s.zoom - fit) < 0.001 && onePage(s) && s.whole === onPage, `− back to the whole page (zoom ${s.zoom.toFixed(3)}, page ${s.whole + 1})`);

// keys
await page.keyboard.press("ArrowRight");
await settle();
s = await view();
check(onePage(s) && s.whole === 2, `→ turns forward (page ${s.whole + 1})`);
await page.keyboard.press("ArrowLeft");
await settle();
s = await view();
check(onePage(s) && s.whole === 1, `← turns back (page ${s.whole + 1})`);

// turning the phone: the page fits again, same page
await page.setViewportSize({ width: H, height: W });
await page.waitForTimeout(1500);
s = await view();
check(onePage(s) && s.whole === 1, `turned sideways: still page 2, whole and alone (page ${s.whole + 1}, shown ${s.shown})`);
await page.setViewportSize({ width: W, height: H });
await page.waitForTimeout(1500);
s = await view();
check(onePage(s) && s.whole === 1, `and back upright: page 2 (page ${s.whole + 1}, shown ${s.shown})`);

// notes mode: a finger draws, two fingers turn the page
await page.click("#notes-toggle");
await page.waitForTimeout(800);
await swipe(-W * 0.5, { fingers: 2 });
s = await view();
check(onePage(s) && s.whole === 2, `notes mode: two fingers turn the page (page ${s.whole + 1}, shown ${s.shown})`);
await swipe(W * 0.5, { fingers: 2 });
s = await view();
check(onePage(s) && s.whole === 1, `notes mode: and back (page ${s.whole + 1})`);
await page.click("#notes-done").catch(() => page.click("#notes-toggle"));
await page.waitForTimeout(800);

// tapping a note still plays from there (a tap, not a swipe)
{
    const pos0 = await page.evaluate(() => app.state.position);
    const pt = await page.evaluate(async () => {
        const tl = await app.engine.timeline();
        const i = Number(document.querySelector(".page")?.closest(".pages") && [...document.querySelectorAll(".page")].findIndex((el) => {
            const r = el.getBoundingClientRect(), v = document.getElementById("viewer").getBoundingClientRect();
            return r.left >= v.left - 1 && r.right <= v.right + 1;
        }));
        const p = tl.filter((q) => q[1] === i)[5];
        const el = document.querySelectorAll(".page")[i];
        const r = el.getBoundingClientRect();
        const k = r.width / app.state.score.pages[i].w;
        return { x: r.left + p[2] * k + 2, y: r.top + (p[3] + p[4] / 2) * k, secs: p[0] };
    });
    await touch("touchStart", [{ x: pt.x, y: pt.y, id: 1 }]);
    await page.waitForTimeout(60);
    await touch("touchEnd", []);
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => app.state.position);
    s = await view();
    check(Math.abs(after - pt.secs) < 1.5 && after !== pos0 && onePage(s), `tapping a note plays from there (at ${after.toFixed(1)} s, note at ${pt.secs.toFixed(1)} s), page unchanged`);
}

// the drag handle steps through whole pages
{
    await swipe(-W * 0.5);
    await swipe(W * 0.5); // shows the handle
    const box = await page.evaluate(() => {
        const t = document.getElementById("scroller-thumb").getBoundingClientRect();
        const r = document.getElementById("scroller").getBoundingClientRect();
        return { tx: t.left + t.width / 2, ty: t.top + t.height / 2, left: r.left, w: r.width, tw: t.width, shown: document.getElementById("scroller").classList.contains("shown"), across: document.getElementById("scroller").classList.contains("across") };
    });
    check(box.shown && box.across, "the drag handle shows, along the bottom");
    const target = box.left + box.tw / 2 + 0.5 * (box.w - box.tw);
    await touch("touchStart", [{ x: box.tx, y: box.ty, id: 1 }]);
    for (let k = 1; k <= 10; k++) {
        await touch("touchMove", [{ x: box.tx + (target - box.tx) * k / 10, y: box.ty, id: 1 }]);
        await page.waitForTimeout(16);
    }
    const label = await page.textContent("#scroller-label");
    await touch("touchEnd", []);
    await page.waitForTimeout(1200);
    s = await view();
    const want = Math.round((s.pages - 1) * 0.5);
    check(onePage(s) && Math.abs(s.whole - want) <= 1, `dragged to the middle: page ${s.whole + 1} of ${s.pages}, whole and alone`);
    check(label === `Page ${s.whole + 1} of ${s.pages}`, `its label said the page it settled on ("${label}")`);
    await page.keyboard.press("Home").catch(() => {});
    for (let k = 0; k < s.whole - 1; k++) {
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(120);
    }
    await settle();
}

// the page turns with the music: start just before the end of page 2's music
const turnAt = await page.evaluate(async () => {
    const tl = await app.engine.timeline();
    const first3 = tl.find((p) => p[1] === 2);
    return first3 ? first3[0] : null;
});
if (turnAt !== null) {
    await page.evaluate((t) => app.engine.seek(Math.max(0, t - 1.5)), turnAt);
    await page.waitForTimeout(500);
    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 20000 });
    await page.waitForTimeout(4000);
    s = await view();
    const cursorPage = await page.evaluate(() => Number(document.querySelector(".cursor")?.closest(".page")?.dataset.index));
    check(onePage(s) && s.whole === cursorPage && cursorPage === 2, `playing into page 3 turns to it (page ${s.whole + 1}, cursor on page ${cursorPage + 1})`);
    await page.click("#play");
    await page.waitForTimeout(500);
}

// back to page view, on the same page, at the earlier zoom
const before = await view();
await page.selectOption("#view-mode", "page");
await page.waitForTimeout(2500);
const back = await page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    const tops = [...document.querySelectorAll(".page")].map((el) => Math.abs(el.getBoundingClientRect().top - v.top));
    return { atTop: tops.indexOf(Math.min(...tops)), zoom: app.state.zoom, zoomShown: document.querySelector(".zoom").getBoundingClientRect().width > 0 };
});
check(back.atTop === before.whole, `page view opens on the same page (${back.atTop + 1}, was ${before.whole + 1})`);
check(back.zoomShown, `page view has its zoom (${back.zoom.toFixed(2)})`);

if (process.env.DEBUG) {
    console.log((await page.evaluate(() => window.__statusLog)).join(" | "));
}
check(errors.length === 0, "no page errors " + errors.join("; "));
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all page by page checks passed");
process.exit(failures ? 1 : 0);
