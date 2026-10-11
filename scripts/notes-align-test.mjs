// Notes land exactly where they are drawn, on every page and in every view, and stay on the same
// spot of the score after zooming and after switching views and back. Draws a short line with the
// mouse and with a finger, then measures where its ink is on the screen. Screenshots in build/align.
//
// Needs the dev server: (cd app && npx vite --host 127.0.0.1 --port 5180)
// Usage: [WIDTH= HEIGHT= TOUCH=1] node scripts/notes-align-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it edited.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const W = Number(process.env.WIDTH || 1100);
const H = Number(process.env.HEIGHT || 850);
const TOUCH = !!process.env.TOUCH;
const out = path.join(root, "build/align");
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: TOUCH, hasTouch: TOUCH });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
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
await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(800);

const settle = async () => {
    await page.waitForTimeout(600);
    await page.waitForFunction(() => document.getElementById("status").hidden, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600);
};
const view = async (mode) => {
    await page.selectOption("#view-mode", mode);
    await settle();
};
// bring page i into view and return a spot on it (fractions across and down), on screen
const spotOn = (i, fx, fy) => page.evaluate(({ i, fx, fy }) => {
    const el = document.querySelectorAll(".page")[i];
    const v = document.getElementById("viewer");
    if (document.getElementById("view-mode").value === "page_turn") {
        const w = el.parentElement.offsetWidth;
        v.scrollLeft = i * w;
    } else {
        el.scrollIntoView({ block: "start", inline: "start" });
    }
    const r = el.getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    // the spot, kept inside the viewer (a continuous page is much bigger than the screen)
    let x = r.left + fx * r.width, y = r.top + fy * r.height;
    if (x > vr.right - 120 || x < vr.left + 20) {
        v.scrollLeft += x - (vr.left + vr.width / 2);
    }
    if (y > vr.bottom - 120 || y < vr.top + 20) {
        v.scrollTop += y - (vr.top + vr.height / 2);
    }
    const r2 = el.getBoundingClientRect();
    return { x: r2.left + fx * r2.width, y: r2.top + fy * r2.height };
}, { i, fx, fy });
async function line(a, b) {
    if (TOUCH) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
        for (let k = 1; k <= 10; k++) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x + (b.x - a.x) * k / 10, y: a.y + (b.y - a.y) * k / 10, id: 1 }] });
            await page.waitForTimeout(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 10 });
        await page.mouse.up();
    }
    await page.waitForTimeout(150);
}
// the newest own stroke's ends on screen (from its points, as drawn in the SVG)
const ends = (id) => page.evaluate((id) => {
    const p = [...document.querySelectorAll(".ink path")].find((q) => q.dataset.id === id && !q.dataset.mode);
    if (!p) {
        return null;
    }
    const svg = p.ownerSVGElement;
    const m = p.getScreenCTM();
    const len = p.getTotalLength();
    const s = p.getPointAtLength(0), e = p.getPointAtLength(len);
    const pt = (q) => ({ x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f });
    void svg;
    return { a: pt(s), b: pt(e) };
}, id);
// every own stroke's id in this view's notes (the newest is the one not seen before)
const strokeIds = () => page.evaluate(() => {
    const m = app.notes.data.modes[document.getElementById("view-mode").value === "page_turn" ? "page" : document.getElementById("view-mode").value] ?? {};
    return Object.values(m).flatMap((p) => p.strokes.map((s) => s.id));
});
const off = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

await page.click("#notes-toggle");
await page.waitForTimeout(400);
const pages = await page.evaluate(() => app.state.score.pages.length);
const drawn = []; // { mode, id, page, fa, fb } fractions of the page, to check later

for (const mode of ["page", "page_turn", "continuous_h", "continuous_v"]) {
    if (mode !== "page") {
        await view(mode);
    }
    const n = await page.evaluate(() => document.querySelectorAll(".page").length);
    const list = n > 1 ? [0, Math.min(2, n - 1), n - 1] : [0];
    for (const i of list) {
        const a = await spotOn(i, 0.3, 0.42);
        const b = { x: a.x + 120, y: a.y + 40 };
        const known = new Set(await strokeIds());
        await line(a, b);
        const id = (await strokeIds()).find((x) => !known.has(x));
        const e = id && await ends(id);
        const err = e ? Math.max(off(e.a, a), off(e.b, b)) : Infinity;
        check(err <= 2, `${mode}, page ${i + 1} of ${n}: the line is where it was drawn (${e ? err.toFixed(1) : "-"} px off)`);
        if (e) {
            // where it is on the page, as fractions, for the checks after zooming and switching
            const f = await page.evaluate(({ i, a, b }) => {
                const r = document.querySelectorAll(".page")[i].getBoundingClientRect();
                return { fa: { x: (a.x - r.left) / r.width, y: (a.y - r.top) / r.height }, fb: { x: (b.x - r.left) / r.width, y: (b.y - r.top) / r.height } };
            }, { i, a, b });
            drawn.push({ mode, id, page: i, ...f });
        }
        if (i === list[1] || n === 1) {
            await page.screenshot({ path: path.join(out, `${mode}-page${i + 1}.png`), clip: { x: Math.max(0, a.x - 200), y: Math.max(0, a.y - 150), width: Math.min(400, W - Math.max(0, a.x - 200)), height: Math.min(300, H - Math.max(0, a.y - 150)) } });
        }
    }
    // zoom in and out: the lines stay on the same spot of the page
    if (mode !== "page_turn") {
        for (const z of ["#zoom-in", "#zoom-in", "#zoom-out", "#zoom-out", "#zoom-out"]) {
            await page.click(z);
            await page.waitForTimeout(300);
        }
        await settle();
        for (const d of drawn.filter((q) => q.mode === mode)) {
            const e = await ends(d.id);
            const r = await page.evaluate((i) => {
                const b = document.querySelectorAll(".page")[i].getBoundingClientRect();
                return { left: b.left, top: b.top, width: b.width, height: b.height };
            }, d.page);
            const want = { x: r.left + d.fa.x * r.width, y: r.top + d.fa.y * r.height };
            const err = e ? off(e.a, want) : Infinity;
            check(err <= 2, `${mode}, page ${d.page + 1}: after zooming in and out the line is on the same spot (${e ? err.toFixed(1) : "-"} px off)`);
        }
    }
}

// back to page view: its lines where they were drawn
await view("page");
for (const d of drawn.filter((q) => q.mode === "page" || q.mode === "page_turn")) {
    const e = await ends(d.id);
    const r = await page.evaluate((i) => {
        const el = document.querySelectorAll(".page")[i];
        el.scrollIntoView({ block: "center" });
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, width: b.width, height: b.height };
    }, d.page);
    const e2 = await ends(d.id);
    const want = { x: r.left + d.fa.x * r.width, y: r.top + d.fa.y * r.height };
    const err = e2 ? off(e2.a, want) : Infinity;
    void e;
    check(err <= 2, `page view after switching views: the ${d.mode} line on page ${d.page + 1} is where it was drawn (${e2 ? err.toFixed(1) : "-"} px off)`);
}

check(errors.length === 0, "no page errors " + errors.join("; "));
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all alignment checks passed");
process.exit(failures ? 1 : 0);
