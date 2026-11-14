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
    // a rest selected: the same bar height; the sheet's lengths and the piano inside the screen, over the playing controls
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
        const L = [...document.querySelectorAll("#edit-lengths .len")].map((b) => b.getBoundingClientRect()).filter((b) => b.width);
        const K = [...document.querySelectorAll(".piano-white")].map((b) => b.getBoundingClientRect());
        const bar = document.getElementById("editbar").getBoundingClientRect();
        const sheet = document.getElementById("editsheet").getBoundingClientRect();
        const foot = document.getElementById("transport").getBoundingClientRect();
        const music = document.getElementById("viewer").getBoundingClientRect();
        return { n: L.length, minW: Math.min(...L.map((b) => b.width)), minH: Math.min(...L.map((b) => b.height)), keyW: Math.min(...K.map((b) => b.width)), keyH: Math.round(K[0].height),
            out: sheet.right > W + 0.5 || sheet.left < -0.5 || sheet.bottom > foot.top + 1, h: Math.round(bar.height), music: Math.round(music.height), oneRow: new Set(L.map((b) => Math.round(b.top))).size === 1 };
    });
    // six lengths, the dot, the rest key and Chord (Paste shows only once something is copied)
    // (the lengths share a narrow phone's width, 28 px at 320: the letters they replace were 24; a 320x640 phone
    // has little room for the music in Edit, 100 px)
    const rok = rr.n === 9 && rr.minW >= 28 && rr.minH >= 34 && rr.keyW >= 40 && rr.keyH >= 60 && !rr.out && rr.oneRow && rr.h === r.bar.b - r.bar.t && rr.music >= (height < 700 ? 90 : 180);
    failures += rok ? 0 : 1;
    console.log((rok ? "ok   " : "FAIL ") + `${name} rest: lengths ${Math.round(rr.minW)}x${Math.round(rr.minH)} px in one row ${rr.oneRow}, keys ${Math.round(rr.keyW)}x${rr.keyH} px, bar ${rr.h}px (note: ${r.bar.b - r.bar.t}px), ${rr.music}px of music`);
    await page.screenshot({ path: path.join(shots, `layout-${name}-rest.png`) });
    await context.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
