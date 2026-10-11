// Continuous views are drawn as sharp as Page view (issue #21): the whole score
// is one long page there, which used to be squeezed into one 16-megapixel
// canvas and came out blurred. Reports canvas pixels per CSS pixel in each view.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/continuous-test.mjs [score.mscz]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescore files/I am move it edited.mscz"));
const url = process.env.APP_URL || "http://localhost:5180/";

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

// sharpness of what is in view: canvas pixels per CSS pixel, and whether the view is covered
const measure = () => page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    const res = [];
    let covered = 0;
    for (const c of document.querySelectorAll(".page canvas:not(.stale)")) {
        const r = c.getBoundingClientRect();
        if (r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right) {
            res.push(c.width / r.width);
            covered += (Math.min(r.right, v.right) - Math.max(r.left, v.left)) * (Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top));
        }
    }
    const pages = [...document.querySelectorAll(".page")].map((p) => p.getBoundingClientRect());
    const pageArea = pages.reduce((s, r) => s + Math.max(0, Math.min(r.right, v.right) - Math.max(r.left, v.left)) * Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top)), 0);
    const maxCanvas = Math.max(0, ...[...document.querySelectorAll("canvas")].map((c) => c.width * c.height));
    return { ratio: res.length ? Math.min(...res) : 0, covered: pageArea ? covered / pageArea : 1, maxCanvas };
});
// Each drawn tile against the same part drawn with nothing skipped (the part
// given as boundless): what is skipped as off the tile must really be off it.
// DUMP=1 saves differing tiles in build/continuous.
const compareTiles = () => page.evaluate(async () => {
    const { pageDrawer, UNITS_PER_INCH, CSS_PX_PER_INCH } = await import("/src/render/pagerenderer.ts");
    const s = CSS_PX_PER_INCH * app.state.zoom * Math.min(devicePixelRatio, 3) / UNITS_PER_INCH;
    let worst = 0, tiles = 0;
    for (const c of document.querySelectorAll(".page .tile > canvas")) {
        const tile = c.parentElement;
        const i = Number(tile.parentElement.dataset.index);
        const ops = app.state.pageOps.get(i);
        if (!ops || c.width === 0) {
            continue;
        }
        const ref = document.createElement("canvas");
        ref.width = c.width;
        ref.height = c.height;
        const ctx = ref.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, ref.width, ref.height);
        const x = Number(tile.dataset.x);
        const y = Number(tile.dataset.y);
        pageDrawer(ctx, ops, s, { x, y, w: 1e12, h: 1e12 })(Infinity);
        const a = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const b = ctx.getImageData(0, 0, c.width, c.height).data;
        let diff = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let k = 0; k < a.length; k += 4) {
            if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) > 24) {
                diff++;
                const px = (k / 4) % c.width, py = Math.floor(k / 4 / c.width);
                x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
            }
        }
        if (diff) {
            window.__dumps = (window.__dumps || []).concat([{ key: tile.dataset.key, box: [x0, y0, x1, y1], a: c.toDataURL(), b: ref.toDataURL() }]);
        }
        worst = Math.max(worst, diff / (a.length / 4));
        tiles++;
        ref.width = 0;
    }
    return { worst, tiles };
});

const settle = async () => {
    await page.waitForTimeout(2500);
};

const want = await page.evaluate(() => Math.min(devicePixelRatio, 3));
for (const mode of ["page", "continuous_h", "continuous_v"]) {
    if (mode !== "page") {
        await page.selectOption("#view-mode", mode);
    }
    await settle();
    for (const step of ["start", "zoom+", "scrolled"]) {
        if (step === "zoom+") {
            await page.click("#zoom-in");
            await page.click("#zoom-in");
            await settle();
        } else if (step === "scrolled") {
            await page.evaluate(() => {
                const v = document.getElementById("viewer");
                v.scrollTop = v.scrollHeight * 0.6;
                v.scrollLeft = v.scrollWidth * 0.6;
            });
            await settle();
        }
        const m = await measure();
        check(m.ratio >= want * 0.99 && m.covered > 0.99 && m.maxCanvas <= 16e6,
            `${mode} ${step}: ${m.ratio.toFixed(2)} px per CSS px (want ${want}), view ${(m.covered * 100).toFixed(0)}% drawn, largest canvas ${(m.maxCanvas / 1e6).toFixed(1)} MP`);
        const d = await compareTiles();
        check(d.tiles > 0 && d.worst < 0.0001, `${mode} ${step}: ${d.tiles} tiles same as drawn without skipping (worst ${(d.worst * 100).toFixed(3)}% of pixels differ)`);
    }
    await page.click("#zoom-out");
    await page.click("#zoom-out");
}
if (process.env.DUMP) {
    const dumps = await page.evaluate(() => window.__dumps || []);
    fs.mkdirSync(path.join(root, "build/continuous"), { recursive: true });
    dumps.forEach((d, n) => {
        console.log("differs:", d.key, d.box.join(","));
        for (const k of ["a", "b"]) {
            fs.writeFileSync(path.join(root, `build/continuous/${n}-${k}.png`), Buffer.from(d[k].split(",")[1], "base64"));
        }
    });
}
check(errors.length === 0, "no page errors " + errors.join("; "));
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all pass");
process.exit(failures ? 1 : 0);
