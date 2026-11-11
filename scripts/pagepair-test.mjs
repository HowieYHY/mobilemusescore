// "Two pages" view (issue #34), with real touch input: two whole pages side by side and nothing of
// any other; a swipe moves on by exactly one page (1-2, 2-3, 3-4: the right page becomes the left),
// a long fast one too, a short slow one none; the last screen is the last two pages; arrow keys;
// zoom never goes below the two pages; the drag handle's label names both pages; the view moves
// with the music (the page it reaches becomes the left one); the device is asked to stay on its
// side while the view shows and let go after (screen.orientation, recorded here); upright, a line
// says to turn the device; Page by page and Page view open on the same page.
//
// Needs the dev server: (cd app && npx vite --host 127.0.0.1 --port 5180)
// Usage: [WIDTH=915 HEIGHT=412] node scripts/pagepair-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it edited.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const W = Number(process.env.WIDTH || 915);
const H = Number(process.env.HEIGHT || 412);

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// the device's answer to "stay on your side" is the device's; here the requests are recorded
await context.addInitScript(() => {
    window.__orient = [];
    const o = screen.orientation;
    o.lock = (how) => {
        window.__orient.push("lock " + how);
        return window.__lockFails ? Promise.reject(new Error("not allowed")) : Promise.resolve();
    };
    o.unlock = () => void window.__orient.push("unlock");
});
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
    app.state.playbackReady = false; // not a score's from before
    await app.openScore(name, bytes.buffer);
}, { name: path.basename(scorePath), b64 });
await page.waitForSelector(".page canvas", { timeout: 120000 });
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 60000 }).catch(() => {});

// the pages showing (fully or partly) and those showing whole
const view = () => page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    const shown = [];
    const whole = [];
    document.querySelectorAll(".page").forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const overlapW = Math.min(r.right, v.right) - Math.max(r.left, v.left);
        const overlapH = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
        if (overlapW > 0.5 && overlapH > 0.5) {
            shown.push(i);
            if (r.left >= v.left - 0.5 && r.right <= v.right + 0.5 && r.top >= v.top - 0.5 && r.bottom <= v.bottom + 0.5) {
                whole.push(i);
            }
        }
    });
    return { shown, whole, zoom: app.state.zoom, pages: document.querySelectorAll(".page").length };
});
// pages i and i + 1, whole, the first on the left, and nothing of any other
const pair = (s, i) => s.shown.join() === `${i},${i + 1}` && s.whole.join() === s.shown.join();
const settle = () => page.waitForTimeout(900);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
const middle = () => page.evaluate(() => {
    const r = document.getElementById("viewer").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
async function swipe(dx, { ms = 160 } = {}) {
    const m = await middle();
    const steps = 8;
    await touch("touchStart", [{ x: m.x - dx / 2, y: m.y, id: 1 }]);
    for (let k = 1; k <= steps; k++) {
        await touch("touchMove", [{ x: m.x - dx / 2 + dx * k / steps, y: m.y, id: 1 }]);
        await page.waitForTimeout(ms / steps);
    }
    await touch("touchEnd", []);
    await settle();
}
const choose = async (v) => {
    await page.selectOption("#view-mode", v);
    await page.waitForTimeout(500);
    await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
};

await choose("page_pair");
let s = await view();
const n = s.pages;
if (n < 5) {
    console.log(`this score has ${n} page(s); the test needs 5`);
    process.exit(2);
}
check(pair(s, 0), `opens on pages 1 and 2, whole, side by side, nothing else (shown ${s.shown}, whole ${s.whole})`);
let orient = await page.evaluate(() => window.__orient.join(", "));
check(orient === "lock landscape", `the device is asked to stay on its side (${orient || "nothing asked"})`);
const sideBySide = await page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll(".page")].map((el) => el.getBoundingClientRect());
    return a.right <= b.left && Math.abs(a.top - b.top) < 1;
});
check(sideBySide, "page 1 on the left, page 2 on the right");
const fit = s.zoom;
await page.click("#zoom-out");
await settle();
s = await view();
check(Math.abs(s.zoom - fit) < 0.001 && pair(s, 0), `− at two whole pages goes no smaller (zoom ${s.zoom.toFixed(3)}, fitted ${fit.toFixed(3)})`);

await swipe(-W * 0.3);
s = await view();
check(pair(s, 1), `a swipe left moves on one page: 2 and 3 (shown ${s.shown})`);
await swipe(-W * 0.3);
s = await view();
check(pair(s, 2), `another: 3 and 4 (shown ${s.shown})`);
await swipe(-W * 0.9, { ms: 60 });
s = await view();
check(pair(s, 3), `a long fast swipe still moves only one: 4 and 5 (shown ${s.shown})`);
await swipe(-20, { ms: 300 });
s = await view();
check(pair(s, 3), `a short slow swipe moves none (shown ${s.shown})`);
await swipe(W * 0.3);
s = await view();
check(pair(s, 2), `a swipe right goes back one: 3 and 4 (shown ${s.shown})`);
await swipe(W * 0.3);
s = await view();
check(pair(s, 1), `and again: 2 and 3 (shown ${s.shown})`);
const drawn = await page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    return [...document.querySelectorAll(".page .tile")].filter((t) => {
        const r = t.getBoundingClientRect();
        return r.right > v.left && r.left < v.right;
    }).every((t) => t.querySelector("canvas"));
});
check(drawn, "both pages shown are drawn");

// keys
await page.keyboard.press("ArrowRight");
await settle();
s = await view();
check(pair(s, 2), `→ moves on one (shown ${s.shown})`);
await page.keyboard.press("ArrowLeft");
await settle();
s = await view();
check(pair(s, 1), `← goes back one (shown ${s.shown})`);

// the end: the last two pages, and no further
for (let k = 0; k < n + 2; k++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(120);
}
await settle();
s = await view();
check(pair(s, n - 2), `the last screen is the last two pages, ${n - 1} and ${n} (shown ${s.shown})`);
await swipe(-W * 0.3);
s = await view();
check(pair(s, n - 2), `a swipe left there stays (shown ${s.shown})`);
await swipe(W * 0.3);
s = await view();
check(pair(s, n - 3), `a swipe right goes back one from the end (shown ${s.shown})`);

// zoomed in and back out: the same two pages
await page.click("#zoom-in");
await settle();
s = await view();
check(s.zoom > fit * 1.2, `+ zooms in (zoom ${s.zoom.toFixed(3)})`);
for (let k = 0; k < 4; k++) {
    await page.click("#zoom-out");
    await page.waitForTimeout(150);
}
await settle();
s = await view();
check(Math.abs(s.zoom - fit) < 0.001 && s.whole.length === 2, `− back to two whole pages (zoom ${s.zoom.toFixed(3)}, shown ${s.shown})`);
await page.evaluate(() => app.turnTo?.(0));
for (let k = 0; k < n; k++) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(120);
}
await settle();
s = await view();
check(pair(s, 0), `back at the start (shown ${s.shown})`);

// the drag handle: its label names both pages
{
    await swipe(-W * 0.3);
    await swipe(W * 0.3); // shows the handle
    const box = await page.evaluate(() => {
        const t = document.getElementById("scroller-thumb").getBoundingClientRect();
        const r = document.getElementById("scroller").getBoundingClientRect();
        return { tx: t.left + t.width / 2, ty: t.top + t.height / 2, left: r.left, w: r.width, tw: t.width, shown: document.getElementById("scroller").classList.contains("shown") };
    });
    check(box.shown, "the drag handle shows");
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
    check(s.whole.length === 2 && s.shown.length === 2, `dragged to the middle: two whole pages (shown ${s.shown})`);
    check(label === `Pages ${s.shown[0] + 1}-${s.shown[1] + 1} of ${n}`, `its label named the two it settled on ("${label}")`);
    for (let k = 0; k < n; k++) {
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(120);
    }
    await settle();
}

// with the music: while it is on the right page nothing moves; the page it reaches next becomes the left one
{
    const at = await page.evaluate(async () => {
        const tl = await app.engine.timeline();
        return { p2: tl.find((p) => p[1] === 1)?.[0] ?? null, p3: tl.find((p) => p[1] === 2)?.[0] ?? null };
    });
    if (at.p2 !== null && at.p3 !== null) {
        await page.evaluate((t) => app.engine.seek(Math.max(0, t - 1.5)), at.p2);
        await page.waitForTimeout(500);
        await page.click("#play");
        await page.waitForFunction(() => app.state.playing, null, { timeout: 20000 });
        await page.waitForTimeout(4000);
        s = await view();
        let cursorPage = await page.evaluate(() => Number(document.querySelector(".cursor")?.closest(".page")?.dataset.index));
        check(cursorPage === 1 && pair(s, 0), `playing into page 2 (the right page) moves nothing (shown ${s.shown}, music on page ${cursorPage + 1})`);
        await page.click("#play");
        await page.waitForTimeout(500);
        await page.evaluate((t) => app.engine.seek(Math.max(0, t - 1.5)), at.p3);
        await page.waitForTimeout(500);
        await page.click("#play");
        await page.waitForFunction(() => app.state.playing, null, { timeout: 20000 });
        await page.waitForTimeout(4500);
        s = await view();
        cursorPage = await page.evaluate(() => Number(document.querySelector(".cursor")?.closest(".page")?.dataset.index));
        check(cursorPage === 2 && pair(s, 2), `playing into page 3 shows 3 and 4, the music on the left (shown ${s.shown}, music on page ${cursorPage + 1})`);
        await page.click("#play");
        await page.waitForTimeout(500);
    }
}

// Settings' "a swipe turns both": 1-2, 3-4, 5-6; keys too; the end and the way back keep to pairs
{
    const setBoth = (on) => page.evaluate((on) => {
        const el = document.querySelector('[data-set="pairSwipeTwo"]');
        el.checked = on;
        el.dispatchEvent(new Event("change"));
    }, on);
    const home = async () => {
        await page.evaluate(() => document.getElementById("viewer").scrollTo({ left: 0, behavior: "instant" }));
        await settle();
    };
    await home();
    check((await page.evaluate(() => app.settings.pairSwipeTwo)) === false, "a swipe moves on one page unless Settings says otherwise");
    await setBoth(true);
    check((await page.evaluate(() => app.settings.pairSwipeTwo)) === true, "Settings: a swipe turns both, switched on");
    await swipe(-W * 0.3);
    s = await view();
    check(pair(s, 2), `turning both: a swipe left goes from 1-2 to 3-4 (shown ${s.shown})`);
    await swipe(-W * 0.9, { ms: 60 });
    s = await view();
    check(pair(s, 4) || (n < 6 && pair(s, n - 2)), `a long fast swipe turns one pair: 5-6 (shown ${s.shown})`);
    await swipe(-20, { ms: 300 });
    const stay = (await view()).shown.join();
    check(stay === s.shown.join(), `a short slow swipe turns none (shown ${stay})`);
    await swipe(W * 0.3);
    s = await view();
    check(pair(s, 2), `a swipe right goes back a pair: 3-4 (shown ${s.shown})`);
    await page.keyboard.press("ArrowLeft");
    await settle();
    s = await view();
    check(pair(s, 0), `← goes back a pair: 1-2 (shown ${s.shown})`);
    await page.keyboard.press("ArrowRight");
    await settle();
    s = await view();
    check(pair(s, 2), `→ turns a pair: 3-4 (shown ${s.shown})`);
    for (let k = 0; k < n; k++) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(120);
    }
    await settle();
    s = await view();
    check(pair(s, n - 2), `the last screen is the last two pages, ${n - 1} and ${n} (shown ${s.shown})`);
    await swipe(W * 0.3);
    s = await view();
    const prev = Math.ceil((n - 2) / 2) * 2 - 2; // the pair before: from 4-5 of 5 to 3-4, from 5-6 of 6 to 3-4
    check(pair(s, prev), `back from the end goes to the pair before, ${prev + 1}-${prev + 2} (shown ${s.shown})`);
    // from a place between pairs (the music led there, or the setting changed): back to the pair it cuts
    await page.evaluate(() => {
        const v = document.getElementById("viewer");
        v.scrollTo({ left: document.querySelector(".slot").offsetWidth, behavior: "instant" });
    });
    await settle();
    s = await view();
    check(pair(s, 1), `(placed on 2-3, shown ${s.shown})`);
    await swipe(W * 0.3);
    s = await view();
    check(pair(s, 0), `from 2-3 a swipe right goes to 1-2 (shown ${s.shown})`);
    await setBoth(false);
    await swipe(-W * 0.3);
    s = await view();
    check(pair(s, 1), `switched off: a swipe moves on one page again, 2-3 (shown ${s.shown})`);
    await home();
    await swipe(-W * 0.3);
    await swipe(-W * 0.3);
}

// Page by page opens on the left page; back to two pages; Page view on the same page
const before = (await view()).shown[0];
await choose("page_turn");
s = await view();
check(s.shown.join() === String(before) && s.whole.join() === String(before), `Page by page opens on the left page, ${before + 1}, alone (shown ${s.shown})`);
orient = await page.evaluate(() => window.__orient.join(", "));
check(orient === "lock landscape, unlock", `leaving the view lets the screen turn again (${orient})`);
await choose("page_pair");
s = await view();
check(pair(s, before), `and Two pages again: ${before + 1} and ${before + 2} (shown ${s.shown})`);
orient = await page.evaluate(() => window.__orient.join(", "));
check(orient === "lock landscape, unlock, lock landscape", `asked to stay on its side again (${orient})`);
const hint = await page.evaluate(() => document.getElementById("status").hidden ? "" : document.getElementById("status").textContent);
check(!/on its side/.test(hint), `no "turn your device" line when it is on its side ("${hint}")`);

// upright on a device that won't turn by itself (an iPhone): two pages still, and a line says so
await choose("page");
await page.evaluate(() => (window.__lockFails = true));
await page.setViewportSize({ width: H, height: W });
await page.waitForTimeout(1200);
await page.selectOption("#view-mode", "page_pair");
await page.waitForFunction(() => /on its side/.test(document.getElementById("status").textContent) && !document.getElementById("status").hidden, null, { timeout: 15000 })
    .then(() => check(true, "upright, and the device won't turn itself: a line says to turn it"), () => check(false, "upright: no line saying to turn the device"));
await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
s = await view();
check(s.shown.length === 2 && s.whole.length === 2, `upright it still shows two whole pages (shown ${s.shown}, whole ${s.whole})`);
const upright = s.shown[0];
await page.setViewportSize({ width: W, height: H });
await page.waitForTimeout(1500);
s = await view();
check(pair(s, upright) && s.zoom > fit * 0.98, `turned on its side: the same two pages, fitted again (shown ${s.shown}, zoom ${s.zoom.toFixed(3)})`);

await swipe(-W * 0.3);
const left = (await view()).shown[0];
await choose("page");
const back = await page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    const tops = [...document.querySelectorAll(".page")].map((el) => Math.abs(el.getBoundingClientRect().top - v.top));
    return tops.indexOf(Math.min(...tops));
});
check(back === left, `Page view opens on the left page (${back + 1}, was ${left + 1})`);

check(errors.length === 0, "no page errors " + errors.join("; "));
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all two pages checks passed");
process.exit(failures ? 1 : 0);
