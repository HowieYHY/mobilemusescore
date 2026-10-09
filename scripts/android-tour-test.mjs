// Today's features on a USB-debugging Android phone, in its own Chrome tab: the start screen (tour
// invitation, Chrome's install button, no iPhone install box), the tour before and with a score (each
// ring around its control, each card on screen), the phone's real Back button closing the tour while
// staying in the app, and playback. Screenshots come from the phone.
//
// Runs on 127.0.0.1:4173 (a local build, its own storage, so the reader's PocketScore is untouched):
//   cd app && npm run build && npx vite preview --port 4173
//   adb reverse tcp:4173 tcp:4173
// Leaves the phone as found: only its own tab is closed, and the forwarded ports are removed.
// Usage: node scripts/android-tour-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:4173/";
const outDir = path.join(root, "build/android-tour");
fs.mkdirSync(outDir, { recursive: true });
const adbPath = process.env.ADB || (fs.existsSync("D:/tools/platform-tools/adb.exe") ? "D:/tools/platform-tools/adb.exe" : "adb");
const adb = (...args) => execFileSync(adbPath, args, { maxBuffer: 64 << 20 });
const shot = (name) => fs.writeFileSync(path.join(outDir, name + ".png"), adb("exec-out", "screencap", "-p"));

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures++;
};

// Once the ring has settled: it encloses its control (the part on screen), and the card is on screen.
async function step(page) {
    await page.waitForTimeout(500);
    return page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const ringEl = document.getElementById("tour-ring");
        const r = ringEl.getBoundingClientRect();
        const c = document.getElementById("tour-card").getBoundingClientRect();
        const t = document.getElementById(ringEl.dataset.for).getBoundingClientRect();
        const within = (a, lo, hi) => a >= lo - 1 && a <= hi + 1;
        return {
            title: document.querySelector(".tour-title").textContent,
            count: document.querySelector(".tour-count").textContent,
            last: document.querySelector(".tour-next").textContent === "Done",
            ring: r.width > 0 && within(Math.max(0, t.left), r.left, r.right) && within(Math.min(vw, t.right), r.left, r.right)
                && within(Math.max(0, t.top), r.top, r.bottom) && within(Math.min(vh, t.bottom), r.top, r.bottom),
            card: c.left >= 0 && c.top >= 0 && c.right <= vw && c.bottom <= vh,
        };
    });
}

async function walkTour(page, label, shotsAt) {
    const titles = [];
    for (;;) {
        const s = await step(page);
        titles.push(s.title);
        check(s.ring && s.card, `${label} ${s.count} "${s.title}": ring on its control, card on screen`);
        if (shotsAt.includes(s.title)) shot(`${label}-${s.title.replace(/\W+/g, "-").toLowerCase()}`);
        await page.click(".tour-next");
        if (s.last) break;
    }
    return titles;
}

console.log("device:", adb("shell", "getprop", "ro.product.model").toString().trim());
adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
const browser = await chromium.connectOverCDP("http://localhost:9222", { timeout: 120000 });
const page = await browser.contexts()[0].newPage();
page.on("pageerror", (e) => check(false, `page error: ${e.message}`));
try {
    await page.bringToFront();
    await page.goto(url);
    // a newcomer in this tab's own storage
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 300000 });
    await page.waitForTimeout(3000); // "Ready" hides itself
    check(await page.evaluate(() => document.getElementById("version").textContent) === "PocketScore 1.0.4", "the 1.0.4 build");
    check(await page.isVisible("#tour-invite"), "a newcomer is invited to the tour");
    check(await page.isHidden("#install-ios"), "no iPhone install box on Android");
    console.log(`     Chrome's Install button: ${(await page.isVisible("#install-row")) ? "shown" : "not offered here (normal for a local address)"}`);
    shot("01-start");

    await page.click("#tour-start");
    const start = await walkTour(page, "start", ["Open a score"]);
    check(start.at(-1) === "Leave a tip", `start tour: ${start.join(" / ")}`);

    // a score, as the Android test opens one
    const b64 = fs.readFileSync(scorePath).toString("base64");
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await window.app.openScore(name, bytes.buffer);
    }, { name: path.basename(scorePath), b64 });
    await page.waitForSelector(".page canvas", { timeout: 300000 });
    await page.waitForFunction(() => window.app.state.playbackReady, null, { timeout: 300000 });
    await page.waitForTimeout(1000);

    await page.click("#help");
    const score = await walkTour(page, "score", ["The score", "Mixer", "Leave a tip"]);
    check(score.length === 10 && score.at(-1) === "Leave a tip", `score tour, ${score.length} steps: ${score.join(" / ")}`);

    // the phone's own Back button
    await page.click("#help");
    await page.waitForTimeout(400);
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({ tour: !document.getElementById("tour").hidden, url: location.href, score: !!window.app?.state.score }));
    check(!after.tour && after.url.startsWith(url) && after.score, "the phone's Back button closes the tour and stays in PocketScore");
    shot("02-after-back");

    // playback still works
    await page.click("#play");
    await page.waitForFunction(() => window.app.state.playing, null, { timeout: 120000 }).catch(() => {});
    const p0 = await page.evaluate(() => window.app.state.position);
    await page.waitForTimeout(3000);
    const p1 = await page.evaluate(() => window.app.state.position);
    check(p1 - p0 > 2, `plays: position ${p0.toFixed(1)} s -> ${p1.toFixed(1)} s in 3 s`);
    shot("03-playing");
    await page.click("#play");
} catch (err) {
    failures++;
    console.log("FAIL ", String(err.message).split("\n")[0]);
} finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    adb("forward", "--remove", "tcp:9222");
}
console.log(failures ? `${failures} FAILED` : "Android checks passed", "- phone screenshots in", outDir);
process.exit(failures ? 1 : 0);
