// "Two pages" view (issue #34), with real touch input: Focus starts with the view (the bars go, and
// the arrow keys still turn); two whole pages together in the middle of the screen with the same
// few px between them at every zoom (a camera over the pages in a row: where the screen is wider
// than the two, the pages before and after show at the sides, whole or cut by the screen, and the
// view still settles with two pages in the middle); a swipe moves on by exactly one page (1-2, 2-3, 3-4),
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
// a run once lost its score mid-test (the page back on the start screen): say if the page was loaded again, and by whom
let loads = 0;
page.on("load", () => {
    if (++loads > 1) {
        errors.push("the page was loaded again");
        console.log("NOTE the page was loaded again during the test");
    }
});
page.on("console", (m) => {
    if (/\[vite\]/.test(m.text()) && !/connect/.test(m.text())) {
        console.log("NOTE dev server: " + m.text());
    }
});
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
    // the space between the first page showing and the next, and how far the whole pages' middle
    // is from the screen's
    const rects = [...document.querySelectorAll(".page")].map((el) => el.getBoundingClientRect());
    const gap = shown.length && rects[shown[0] + 1] ? rects[shown[0] + 1].left - rects[shown[0]].right : null;
    // for each page, how far the middle of it and the next is from the middle of the screen
    const offs = rects.map((r, i) => (rects[i + 1] ? (r.left + rects[i + 1].right) / 2 - (v.left + v.width / 2) : Infinity));
    return { shown, whole, gap, offs, zoom: app.state.zoom, pages: rects.length, focus: app.state.focus };
});
const GAP = [3.5, 5.5]; // PAIR_GAP is 4; a slot is whole px wide, so up to 1 more
const tight = (s) => s.gap !== null && s.gap >= GAP[0] && s.gap <= GAP[1];
// the page whose pair (it and the next) sits in the middle of the screen, both whole; -1 if none
const centred = (s) => s.offs.findIndex((o, i) => Math.abs(o) <= 1.5 && s.whole.includes(i) && s.whole.includes(i + 1));
// pages i and i + 1 whole, together (the gap) and in the middle of the screen
const pair = (s, i) => centred(s) === i && tight(s);
const say = (s) => `in the middle: ${centred(s) < 0 ? "no two pages" : `${centred(s) + 1} and ${centred(s) + 2}`}, gap ${s.gap?.toFixed(1)} px, whole ${s.whole.map((k) => k + 1)}`;
const hintText = () => page.evaluate(() => ["status", "focus-hint"].map((id) => document.getElementById(id)).filter((el) => !el.hidden).map((el) => el.textContent).join(" "));
// Focus hides the bars the rest of the test uses
const leaveFocus = async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !app.state.focus, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1300);
};
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
const choose = async (v, { stay = false } = {}) => {
    if (await page.evaluate(() => app.state.focus)) {
        await leaveFocus();
    }
    await page.selectOption("#view-mode", v);
    await page.waitForTimeout(500);
    await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (v === "page_pair" && !stay) {
        await leaveFocus();
    }
};
// what was asked of the screen, in order
const asked = () => page.evaluate(() => window.__orient);

await page.selectOption("#view-mode", "page_pair");
const focusLine = await page.waitForFunction(() => !document.getElementById("focus-hint").hidden && document.getElementById("focus-hint").textContent, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => "");
check(/show the controls/.test(focusLine), `a line says how to get the controls back ("${focusLine}")`);
await page.waitForTimeout(2000);
let s = await view();
const n = s.pages;
if (n < 5) {
    console.log(`this score has ${n} page(s); the test needs 5`);
    process.exit(2);
}
check(s.focus && await page.evaluate(() => getComputedStyle(document.querySelector(".topbar")).display === "none"), "choosing Two pages starts Focus: the bars are gone");
check(pair(s, 0), `opens on pages 1 and 2, whole, together in the middle (${say(s)})`);
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(900);
s = await view();
check(pair(s, 1) && s.focus, `in Focus the right arrow still moves on one page (${say(s)})`);
await swipe(W * 0.3);
s = await view();
check(pair(s, 0) && s.focus, `and a swipe right goes back, still in Focus (${say(s)})`);
const focusZoom = s.zoom;
await leaveFocus();
s = await view();
check(!s.focus && pair(s, 0) && s.zoom <= focusZoom + 0.001, `Escape brings the bars back: the same two pages, fitted to the room left (zoom ${s.zoom.toFixed(3)}, in Focus ${focusZoom.toFixed(3)}; ${say(s)})`);
let orient = await asked();
check(orient.length > 0 && orient.every((o) => o === "lock landscape"), `the device is asked to stay on its side (${orient.join(", ") || "nothing asked"})`);
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
const scrollBefore = await page.evaluate(() => document.getElementById("viewer").scrollLeft);

await swipe(-W * 0.3);
s = await view();
check(pair(s, 1), `a swipe left moves on one page: 2 and 3 (${say(s)})`);
{
    // the camera moved by one page and its gap, no more
    const moved = await page.evaluate(() => document.getElementById("viewer").scrollLeft) - scrollBefore;
    const step = await page.evaluate(() => document.querySelector(".page").getBoundingClientRect().width);
    check(moved - step >= GAP[0] - 0.5 && moved - step <= GAP[1] + 0.5, `the view moved one page's width and the gap (${moved.toFixed(1)} px, page ${step.toFixed(1)} px)`);
}
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
check(tight(s), `zoomed in, the pages are as close together (gap ${s.gap?.toFixed(1)} px)`);
for (let k = 0; k < 4; k++) {
    await page.click("#zoom-out");
    await page.waitForTimeout(150);
}
await settle();
s = await view();
check(Math.abs(s.zoom - fit) < 0.001 && centred(s) >= 0, `− back to two whole pages (zoom ${s.zoom.toFixed(3)}; ${say(s)})`);
await page.evaluate(() => app.turnTo?.(0));
for (let k = 0; k < n; k++) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(120);
}
await settle();
s = await view();
check(pair(s, 0), `back at the start (shown ${s.shown})`);

// the drag handle: its label names both pages (the app shows it when there is more than a screen
// to move through; a short score with small pages is nearly all on the screen, and has none)
const handleUseful = await page.evaluate(() => {
    const v = document.getElementById("viewer");
    return v.scrollWidth - v.clientWidth > v.clientWidth;
});
if (!handleUseful) {
    await swipe(-W * 0.3);
    await swipe(W * 0.3);
    check(!(await page.evaluate(() => document.getElementById("scroller").classList.contains("shown"))), "nearly the whole score is on the screen: no drag handle");
} else {
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
    check(centred(s) >= 0 && tight(s), `dragged to the middle: two whole pages (${say(s)})`);
    check(label === `Pages ${centred(s) + 1}-${centred(s) + 2} of ${n}`, `its label named the two it settled on ("${label}")`);
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
    const stay = centred(await view());
    check(stay === centred(s), `a short slow swipe turns none (pages ${stay + 1} and ${stay + 2})`);
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
const before = centred(await view());
await choose("page_turn");
s = await view();
check(s.shown.join() === String(before) && s.whole.join() === String(before), `Page by page opens on the left page, ${before + 1}, alone (shown ${s.shown})`);
orient = await asked();
check(orient[orient.length - 1] === "unlock", `leaving the view lets the screen turn again (last asked: ${orient[orient.length - 1]})`);
await choose("page_pair");
s = await view();
check(pair(s, before), `and Two pages again: ${before + 1} and ${before + 2} (shown ${s.shown})`);
orient = await asked();
check(orient[orient.length - 1] === "lock landscape", `asked to stay on its side again (last asked: ${orient[orient.length - 1]})`);
const hint = await hintText();
check(!/on its side/.test(hint), `no "turn your device" line when it is on its side ("${hint}")`);

// upright on a device that won't turn by itself (an iPhone): two pages still, and a line says so
await choose("page");
await page.evaluate(() => (window.__lockFails = true));
await page.setViewportSize({ width: H, height: W });
await page.waitForTimeout(1200);
await page.selectOption("#view-mode", "page_pair");
// (in Focus the status line is hidden: the line is Focus's own, with how to get the controls back)
const turnLine = await page.waitForFunction(() => {
    const el = ["status", "focus-hint"].map((id) => document.getElementById(id)).find((el) => !el.hidden && /on its side/.test(el.textContent));
    return el && el.textContent;
}, null, { timeout: 15000 }).then((h) => h.jsonValue(), () => "");
check(/on its side/.test(turnLine) && /show the controls/.test(turnLine), `upright, and the device won't turn itself: a line says to turn it, and how to get the controls back ("${turnLine}")`);
await page.waitForTimeout(2000);
s = await view();
check(centred(s) >= 0 && tight(s), `upright it still shows two whole pages (${say(s)})`);
const upright = centred(s);
await leaveFocus(); // (a full-screen window can't be given another size here)
await page.setViewportSize({ width: W, height: H });
await page.waitForTimeout(1500);
s = await view();
check(pair(s, upright) && s.zoom > fit * 0.98, `turned on its side: the same two pages, fitted again (shown ${s.shown}, zoom ${s.zoom.toFixed(3)})`);

await swipe(-W * 0.3);
const left = centred(await view());
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
