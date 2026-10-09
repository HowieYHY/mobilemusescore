// The guided tour (issue #15) and its first-time invitation (#16), at phone and iPad sizes:
// - the start screen invites newcomers only, and nothing starts by itself;
// - every step rings a control that is on screen, and the card stays fully on screen;
// - Escape, Skip tour and the phone's Back button close it; Back doesn't leave the app;
// - after opening a score the invitation is gone for good; the ? button still starts the tour;
// - the website preview (?embed=reso) has neither.
// Screenshots of each step go to build/tour-shots.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/tour-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:5180/";
const outDir = path.join(root, "build/tour-shots");
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures++;
};

const sizes = [
    ["phone", 412, 915],
    ["ipad-mini", 744, 1133],
    ["ipad-air", 820, 1180],
    ["ipad-air-landscape", 1180, 820],
    ["ipad-pro-13", 1032, 1376],
];

// Once the ring has finished moving: it encloses the control it is for (as much of it as is on
// screen), and the card is wholly on screen.
async function stepIsSound(page) {
    await page.waitForTimeout(450); // the ring slides over 0.28 s
    return page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const ringEl = document.getElementById("tour-ring");
        const c = document.getElementById("tour-card").getBoundingClientRect();
        const r = ringEl.getBoundingClientRect();
        const t = document.getElementById(ringEl.dataset.for).getBoundingClientRect();
        const within = (a, lo, hi) => a >= lo - 1 && a <= hi + 1;
        const ring = r.width > 0 && within(Math.max(0, t.left), r.left, r.right) && within(Math.min(vw, t.right), r.left, r.right)
            && within(Math.max(0, t.top), r.top, r.bottom) && within(Math.min(vh, t.bottom), r.top, r.bottom);
        return { cardOnScreen: c.left >= 0 && c.top >= 0 && c.right <= vw && c.bottom <= vh, ring, title: document.querySelector(".tour-title").textContent, count: document.querySelector(".tour-count").textContent };
    });
}

const browser = await chromium.launch();
for (const [size, width, height] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => check(false, `${size}: page error ${e.message}`));
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    const all = size === "phone"; // every step on the phone, a sample elsewhere

    check(await page.isVisible("#tour-invite"), `${size}: a newcomer is invited to the tour`);
    check(await page.isHidden("#tour"), `${size}: the tour doesn't start by itself`);
    check(await page.isVisible("#help"), `${size}: the ? button is in the top bar`);
    await page.screenshot({ path: path.join(outDir, `${size}-00-start.png`) });

    // start-screen tour
    await page.click("#tour-start");
    check(await page.isHidden("#tour-invite"), `${size}: taking the tour removes the invitation`);
    let n = 0;
    for (;;) {
        const s = await stepIsSound(page);
        check(s.ring && s.cardOnScreen, `${size}: start step ${s.count} "${s.title}" rings a control, card on screen`);
        if (all || n === 0) await page.screenshot({ path: path.join(outDir, `${size}-start-${++n}.png`) });
        const label = await page.textContent(".tour-next");
        await page.click(".tour-next");
        if (label === "Done") break;
    }
    check(await page.isHidden("#tour"), `${size}: Done closes the tour`);

    // with a score: every control
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForSelector(".page canvas", { timeout: 180000 });
    await page.waitForFunction(() => window.app.state.playbackReady, null, { timeout: 180000 });
    await page.waitForTimeout(800);
    await page.click("#help");
    n = 0;
    for (;;) {
        const s = await stepIsSound(page);
        check(s.ring && s.cardOnScreen, `${size}: score step ${s.count} "${s.title}" rings a control, card on screen`);
        if (all || ["1 of", "6 of", "9 of"].some((p) => s.count.startsWith(p))) await page.screenshot({ path: path.join(outDir, `${size}-score-${String(++n).padStart(2, "0")}.png`) });
        const label = await page.textContent(".tour-next");
        if (label === "Done") break;
        await page.click(".tour-next");
    }
    await page.click(".tour-next");

    // ways out
    await page.click("#help");
    await page.keyboard.press("Escape");
    check(await page.isHidden("#tour"), `${size}: Escape closes the tour`);
    await page.click("#help");
    await page.click(".tour-skip");
    check(await page.isHidden("#tour"), `${size}: Skip tour closes it`);
    await page.click("#help");
    await page.goBack();
    await page.waitForTimeout(300);
    check(await page.isHidden("#tour") && page.url().startsWith(url) && !!(await page.evaluate(() => window.app?.state.score)), `${size}: Back closes the tour and stays in the app`);

    // next visit: no invitation (a score was opened), the ? still works
    await page.reload();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    check(await page.isHidden("#tour-invite"), `${size}: no invitation once a score has been opened`);
    await context.close();
}

// regular users and the website preview
{
    const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
    await context.addInitScript(() => localStorage.setItem("pocketscore.notesPrefs", "{}"));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.app?.firstTime, null, { timeout: 120000 });
    check(await page.isHidden("#tour-invite"), "a returning user isn't invited");
    check(await page.isVisible("#help"), "a returning user still has the ? button");
    await page.setContent(`<iframe src="${url}?embed=reso" style="width:400px;height:800px"></iframe>`);
    const frame = page.frames().find((f) => f.url().includes("embed=reso")) || (await (await page.waitForSelector("iframe")).contentFrame());
    await frame.waitForFunction(() => window.app?.firstTime, null, { timeout: 120000 });
    check(await frame.isHidden("#help") && await frame.isHidden("#tour-invite"), "the website preview has no ? button or invitation");
    await context.close();
}
await browser.close();
console.log(failures ? `${failures} FAILED` : "tour checks passed", "- screenshots in", outDir);
process.exit(failures ? 1 : 0);
