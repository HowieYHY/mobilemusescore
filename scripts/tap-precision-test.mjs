// Tapping notes: for every notehead on the first pages of a score, tap its
// centre with the reach a fingertip gets on a phone (as the app: up to 3
// spatia) and check
//   1. the engine picks that note (the same one a pinpoint tap on it gets),
//   2. the playback line is drawn at that note (cursorAt: within a notehead),
//   3. a left loop marker set there is drawn there too, also for each line's
//      first note (it used to land at the end of the line before).
// Noteheads are found in the page drawing (SMuFL U+E0A0-E0A4).
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/tap-precision-test.mjs [folder or score] [pages=2]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const arg = path.resolve(process.argv[2] || path.join(root, "real test musescores"));
const files = fs.statSync(arg).isDirectory()
    ? fs.readdirSync(arg).filter((f) => /\.mscz$/i.test(f)).map((f) => path.join(arg, f))
    : [arg];
const pagesToCheck = Number(process.argv[3] || 2);
const url = process.env.APP_URL || "http://localhost:5180/";

const browser = await chromium.launch();
let failures = 0;
for (const file of files) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"));
    const b64 = fs.readFileSync(file).toString("base64");
    await page.evaluate(async (b64) => {
        const bin = atob(b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            u[i] = bin.charCodeAt(i);
        }
        await app.openScore("t.mscz", u.buffer);
    }, b64);
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
    await page.waitForTimeout(500);
    const r = await page.evaluate(async (pagesToCheck) => {
        const sp = app.state.score.spatium;
        const out = { heads: 0, wrongNote: [], lineOff: [], markOff: [] };
        for (let pg = 0; pg < Math.min(pagesToCheck, app.state.score.pages.length); pg++) {
            const ops = JSON.parse(await app.engine.page(pg));
            let tf = [1, 0, 0, 1, 0, 0];
            const heads = [];
            for (const op of ops) {
                if (op[0] === "T") {
                    tf = [op[1] / 1000, op[2] / 1000, op[3] / 1000, op[4] / 1000, op[5], op[6]];
                } else if (op[0] === "y" && op[3] >= 0xE0A0 && op[3] <= 0xE0A4) {
                    // the glyph's origin is the notehead's left edge, on its middle line
                    const gx = op[1] + 0.59 * sp / Math.max(1e-6, Math.hypot(tf[0], tf[1]));
                    const gy = op[2];
                    heads.push({ x: tf[0] * gx + tf[2] * gy + tf[4], y: tf[1] * gx + tf[3] * gy + tf[5] });
                }
            }
            for (const h of heads) {
                out.heads++;
                const exact = await app.engine.locate(pg, h.x, h.y, 0.3 * sp);
                const finger = await app.engine.locate(pg, h.x, h.y, 3 * sp);
                if (!exact || !exact.note) {
                    continue; // not a playable note (e.g. the range noteheads at the start)
                }
                if (!finger || Math.abs(finger.secs - exact.secs) > 0.001) {
                    out.wrongNote.push({ pg, x: Math.round(h.x), y: Math.round(h.y), want: exact.secs, got: finger && finger.secs });
                    continue;
                }
                const d = app.cursorAt(exact.secs);
                // the line sits about a spatium left of the notehead (as desktop draws it)
                if (!d || d.page !== pg || h.x - d.x < -0.5 * sp || h.x - d.x > 2.5 * sp || h.y < d.y || h.y > d.y + d.h) {
                    out.lineOff.push({ pg, headX: Math.round(h.x), headY: Math.round(h.y), linePage: d?.page, lineX: d && Math.round(d.x), lineY: d?.y, lineH: d?.h });
                }
            }
        }
        // each line's first note: the left marker belongs on it, not at the end of the line before
        const tl = await app.engine.timeline();
        const firsts = tl.filter((p, i) => i === 0 || tl[i - 1][3] !== p[3] || tl[i - 1][1] !== p[1]).slice(0, 12);
        for (const [secs, pg, x, y] of firsts) {
            const p = await app.engine.setLoopMarker(false, secs);
            const d = app.cursorAt(p.from);
            if (!d || d.page !== pg || Math.abs(d.y - y) > 1 || Math.abs(d.x - x) > 0.5 * sp) {
                out.markOff.push({ secs, from: p.from, wantPage: pg, wantY: y, gotPage: d?.page, gotY: d?.y });
            }
        }
        await app.engine.clearLoop();
        return out;
    }, pagesToCheck);
    const bad = r.wrongNote.length + r.lineOff.length + r.markOff.length;
    failures += bad ? 1 : 0;
    console.log(`${bad ? "FAIL" : "ok  "} ${path.basename(file)}: ${r.heads} noteheads; another note picked ${r.wrongNote.length}, line not at the note ${r.lineOff.length}, line-start marker elsewhere ${r.markOff.length}/12`);
    for (const e of [...r.wrongNote.slice(0, 3), ...r.lineOff.slice(0, 3), ...r.markOff.slice(0, 2)]) {
        console.log("       ", JSON.stringify(e));
    }
    await page.close();
}
await browser.close();
console.log(failures ? `${failures} score(s) FAILED` : "tap precision checks passed");
process.exit(failures ? 1 : 0);
