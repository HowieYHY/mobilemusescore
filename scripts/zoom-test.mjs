// Pages while zooming (issue #9): after each zoom (buttons and pinch), how long
// the pages in view stay blank, and whether they are all drawn in the end.
// CANVAS_MB=<n> imitates iPad Safari, which refuses new canvases once the
// canvases alive take more than its limit (getContext returns null).
// Phone-sized screen with real touch input, CPU slowed (CPU=4 by default).
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: [CANVAS_MB=256] node scripts/zoom-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/GODS_NUS RESONANCE_FINAL_CHORAL INTRO.mscz"));
const url = process.env.APP_URL || "http://localhost:5180/";
const canvasMb = Number(process.env.CANVAS_MB || 0);
const cpu = Number(process.env.CPU || 4);

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

// PHONE=<url>: a tab already open at that address in a USB phone's Chrome
// (see android-test.mjs for the set-up; keep it in front)
const phone = process.env.PHONE;
const browser = phone ? await chromium.connectOverCDP("http://localhost:9222") : await chromium.launch();
const context = phone ? browser.contexts()[0]
    : await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
if (canvasMb) {
    // Safari: a canvas that would take the total past the limit gets no context.
    // Canvases count until they are freed (width 0) or dropped from the page.
    await context.addInitScript((limit) => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (...a) {
            const live = [...document.querySelectorAll("canvas")].filter((c) => c !== this)
                .reduce((s, c) => s + c.width * c.height * 4, 0);
            window.__canvasPeakMb = Math.max(window.__canvasPeakMb || 0, (live + this.width * this.height * 4) / 1048576);
            if (live + this.width * this.height * 4 > limit * 1048576) {
                window.__canvasRefused = (window.__canvasRefused || 0) + 1;
                return null;
            }
            return get.apply(this, a);
        };
    }, canvasMb);
}
const page = phone ? context.pages().find((p) => p.url().startsWith(phone)) : await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const cdp = await context.newCDPSession(page);

if (phone) {
    await page.reload();
} else {
    await page.goto(url);
}
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
await page.waitForSelector(".page canvas", { timeout: 60000 });
await page.waitForTimeout(1500);
if (!phone) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
}

// Watch every frame: the pages in view without a drawn canvas
await page.evaluate(() => {
    window.__blank = { frames: 0, since: null, longest: 0, now: 0 };
    const tick = (now) => {
        const w = window.__blank;
        const v = document.getElementById("viewer").getBoundingClientRect();
        const blank = [...document.querySelectorAll(".page")].some((p) => {
            const r = p.getBoundingClientRect();
            return r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right && !p.querySelector("canvas");
        });
        if (blank) {
            w.frames++;
            w.since ??= now;
            w.longest = Math.max(w.longest, now - w.since);
        } else {
            w.since = null;
        }
        w.now = blank;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
});

const viewerBox = await page.evaluate(() => {
    const r = document.getElementById("viewer").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
async function pinch(factor) {
    const { x, y } = viewerBox;
    const d0 = 120;
    const pts = (d) => [{ x: x - d / 2, y, id: 0 }, { x: x + d / 2, y, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(d0) });
    for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d0 * (1 + (factor - 1) * i / 10)) });
        await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const steps = [
    ["+", () => page.click("#zoom-in")], ["+", () => page.click("#zoom-in")], ["+", () => page.click("#zoom-in")],
    ["pinch out", () => pinch(1.8)], ["pinch in", () => pinch(0.5)], ["-", () => page.click("#zoom-out")],
    ["scroll", () => page.evaluate(() => (document.getElementById("viewer").scrollTop += 3000))],
    ["pinch out", () => pinch(2)], ["+", () => page.click("#zoom-in")],
    ["scroll", () => page.evaluate(() => (document.getElementById("viewer").scrollTop += 4000))],
    ["-", () => page.click("#zoom-out")], ["-", () => page.click("#zoom-out")], ["-", () => page.click("#zoom-out")],
];
let worst = 0; // zoom steps only: a scroll jump far past the drawn pages is blank for a moment
for (const [name, act] of steps) {
    await page.evaluate(() => Object.assign(window.__blank, { frames: 0, longest: 0, since: null }));
    await act();
    // drawn in the end: every page in view has a canvas within 8 s
    const t0 = Date.now();
    const drawn = await page.waitForFunction(() => {
        const v = document.getElementById("viewer").getBoundingClientRect();
        return [...document.querySelectorAll(".page")].every((p) => {
            const r = p.getBoundingClientRect();
            const inView = r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right;
            return !inView || p.querySelector("canvas:not(.stale)");
        });
    }, null, { timeout: 8000, polling: "raf" }).then(() => true, () => false);
    const sharpMs = Date.now() - t0;
    await page.waitForTimeout(300);
    const w = await page.evaluate(() => ({ ...window.__blank, zoom: Math.round(app.state.zoom * 100) }));
    if (name !== "scroll") {
        worst = Math.max(worst, w.longest);
    }
    console.log(`${name.padEnd(10)} zoom ${String(w.zoom).padStart(3)}%: blank for ${w.longest.toFixed(0)} ms (${w.frames} frames), sharp after ${drawn ? sharpMs + " ms" : "NEVER"}`);
    check(drawn, `${name}: the pages in view are drawn`);
}
const refused = await page.evaluate(() => ({ refused: window.__canvasRefused || 0, peak: window.__canvasPeakMb || 0, live: [...document.querySelectorAll("canvas")].reduce((s, c) => s + c.width * c.height * 4, 0) / 1048576 }));
console.log(`canvases: ${refused.live.toFixed(0)} MB alive at the end${canvasMb ? `, peak ${refused.peak.toFixed(0)} MB, ${refused.refused} refused` : ""}`);
// a tight memory limit may free a page's own stand-in before its new drawing
check(worst < (canvasMb && canvasMb < 200 ? 500 : 150), `pages in view never blank while zooming (worst ${worst.toFixed(0)} ms)`);
check(!errors.length, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
if (!phone) {
    await browser.close();
}
console.log(failures ? `${failures} check(s) FAILED` : "zoom checks passed");
process.exit(failures ? 1 : 0);
