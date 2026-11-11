// The top bar and the edit bar at every device width: nothing cut off or overflowing, and the
// edit bar's height. Screenshots in SHOTS (default build/edit-shots). Needs the dev server on :5180.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.env.SCORE || path.join(root, "real test musescores/Paper Hearts.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const shots = process.env.SHOTS || path.join(root, "build/edit-shots");
fs.mkdirSync(shots, { recursive: true });

const sizes = [["phone-320", 320, 640], ["phone-360", 360, 780], ["phone-412", 412, 915], ["ipad-mini", 744, 1133], ["ipad-air", 820, 1180], ["ipad-air-wide", 1180, 820], ["desktop", 1366, 768]];
let failures = 0;
const browser = await chromium.launch();
for (const [name, width, height] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: width < 1000, hasTouch: width < 1000 });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    await page.waitForFunction(() => document.querySelectorAll("#pages canvas").length > 0, null, { timeout: 60000 });
    await page.click("#edit-toggle");
    await page.evaluate(async () => {
        const sp = app.state.score.spatium, p0 = app.state.score.pages[0];
        for (let y = p0.h * 0.1; y < p0.h * 0.6; y += sp / 2) {
            for (let x = p0.w * 0.25; x < p0.w * 0.8; x += sp) {
                const s = await app.engine.editSelect(0, x, y, sp * 0.4);
                if (s && s.kind === "note") { app.edit.sel = s; app.showEditSel(false); app.updateEditBar(); return; }
            }
        }
    });
    await page.click("#edit-octave"); // to see a pressed state too
    const r = await page.evaluate(() => {
        const box = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
        const W = document.documentElement.clientWidth;
        const bad = [];
        for (const el of document.querySelectorAll(".topbar *, .editbar *")) {
            const b = el.getBoundingClientRect();
            if (b.width && (b.left < -0.5 || b.right > W + 0.5) && getComputedStyle(el).display !== "none") bad.push((el.id || el.className || el.tagName) + `@${Math.round(b.left)}..${Math.round(b.right)}`);
        }
        const tops = [...document.querySelectorAll(".editbar button")].map((b) => b.getBoundingClientRect()).filter((b) => b.width);
        return { W, bad: [...new Set(bad)], open: box("open-label"), edit: box("edit-toggle"), view: box("view-mode"), bar: box("editbar"), minTap: Math.min(...tops.map((b) => Math.min(b.width, b.height))) };
    });
    const ok = r.bad.length === 0 && r.minTap >= 34 && r.open.r - r.open.l >= 48;
    failures += ok ? 0 : 1;
    console.log((ok ? "ok   " : "FAIL ") + `${name} ${width}x${height}: edit bar ${r.bar.b - r.bar.t}px high, smallest button ${Math.round(r.minTap)}px, Open ${r.open.l}..${r.open.r}, Edit ${r.edit.l}..${r.edit.r}, View ${r.view.l}..${r.view.r}${r.bad.length ? ", OUTSIDE: " + r.bad.join(" ") : ""}`);
    await page.screenshot({ path: path.join(shots, `layout-${name}.png`) });
    // a rest selected: the letters replace the pitch buttons, same bar height, nothing outside, readable taps
    await page.evaluate(async () => {
        const sp = app.state.score.spatium, p0 = app.state.score.pages[0];
        for (let y = p0.h * 0.1; y < p0.h * 0.6; y += sp / 2) {
            for (let x = p0.w * 0.25; x < p0.w * 0.8; x += sp) {
                const s = await app.engine.editSelect(0, x, y, sp * 0.4);
                if (s && s.kind === "rest") { app.edit.sel = s; app.showEditSel(false); app.updateEditBar(); return; }
            }
        }
    });
    const rr = await page.evaluate(() => {
        const W = document.documentElement.clientWidth;
        const L = [...document.querySelectorAll("#edit-letters button")].map((b) => b.getBoundingClientRect());
        const bar = document.getElementById("editbar").getBoundingClientRect();
        return { n: L.length, minW: Math.min(...L.map((b) => b.width)), minH: Math.min(...L.map((b) => b.height)), out: L.some((b) => b.right > W + 0.5 || b.left < -0.5), h: Math.round(bar.height), oneRow: new Set(L.map((b) => Math.round(b.top))).size === 1 };
    });
    const rok = rr.n === 8 && rr.minW >= 24 // C to B and the rest key && rr.minH >= 34 && !rr.out && rr.oneRow && (width < 340 || rr.h === r.bar.b - r.bar.t);
    failures += rok ? 0 : 1;
    console.log((rok ? "ok   " : "FAIL ") + `${name} rest: letters ${Math.round(rr.minW)}x${Math.round(rr.minH)} px, bar ${rr.h}px (note: ${r.bar.b - r.bar.t}px), one row ${rr.oneRow}`);
    await page.screenshot({ path: path.join(shots, `layout-${name}-rest.png`) });
    await context.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
