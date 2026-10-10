// Screenshots of the Reso library's PocketScore preview, at phone and desktop sizes: the library
// with Preview buttons, the preview loading, the score playing, the mixer, and back to the library.
// Also checks the preview has no Open, Notes or Save. Saves to build/preview-shots.
//
// Needs both local servers: PocketScore (cd app && npx vite --port 5173) and the Reso website
// (npm run db:dev and npm run dev in its repo). Google sign-in can't be automated, so the website
// session is made for its local member with the website's own secret (local server only):
//   node --env-file="<reso-website>/.env.local" scripts/preview-shots.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const reso = path.resolve(process.env.RESO_DIR || path.join(root, "../reso-website"));
const resoRequire = createRequire(path.join(reso, "package.json"));
const { encode } = resoRequire("next-auth/jwt");
const { default: pg } = await import(pathToFileURL(path.join(reso, "node_modules/pg/lib/index.js")).href);

const site = process.env.SITE_URL || "http://localhost:3000";
const outDir = path.join(root, "build/preview-shots");
fs.mkdirSync(outDir, { recursive: true });

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows: [member] } = await db.query("SELECT google_sub, email, name FROM members WHERE status='active' AND google_sub IS NOT NULL LIMIT 1");
await db.end();
const session = await encode({
    token: { googleSub: member.google_sub, email: member.email, name: member.name, sub: member.google_sub },
    secret: process.env.NEXTAUTH_SECRET,
    maxAge: 3600,
});

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

const sizes = [
    ["phone", 390, 844, true],
    ["desktop", 1440, 900, false],
];
const browser = await chromium.launch();
for (const [size, width, height, mobile] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
    await context.addCookies([{ name: "next-auth.session-token", value: session, url: site, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log(`[${size}] page error:`, e.message));
    let n = 0;
    const shot = async (what) => {
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(outDir, `${size}-${String(++n).padStart(2, "0")}-${what}.png`) });
    };

    await page.goto(`${site}/students/library?q=${encodeURIComponent(process.env.QUERY || "dream")}`);
    await page.waitForSelector(".file-preview", { timeout: 180000 });
    const buttons = await page.locator(".file-preview").count();
    const rows = await page.locator(".file-list li").count();
    check(buttons > 0, `${size}: ${buttons} Preview buttons among ${rows} files`);
    // the files (with their Preview buttons) are below the folder tiles
    await page.evaluate(() => document.querySelector(".file-list").scrollIntoView({ block: "start" }));
    await page.evaluate(() => window.scrollBy(0, -80));
    await shot("library");

    await page.locator(process.env.FILE ? `.file-list li:has-text("${process.env.FILE}") .file-preview` : ".file-preview").first().click();
    await page.waitForSelector("dialog.score-preview[open] iframe", { timeout: 30000 });
    await shot("preview-opening");

    const frame = page.frameLocator("dialog.score-preview iframe");
    const inner = () => page.frames().find((f) => f.url().includes("embed=reso"));
    await frame.locator(".page canvas").first().waitFor({ timeout: 300000 });
    await inner().waitForFunction(() => window.app.state.playbackReady, null, { timeout: 300000 });
    const hidden = await inner().evaluate(() =>
        ["open-label", "save", "notes-toggle", "score-title"].every((id) => getComputedStyle(document.getElementById(id)).display === "none")
        && getComputedStyle(document.querySelector(".tip-icon")).display === "none");
    check(hidden, `${size}: no Open, Save, Notes, title or tip in the preview`);
    const from = inner().url();
    check(from.startsWith(`${site}/pocketscore/index.html`), `${size}: PocketScore comes from the website's own copy (${from})`);
    const version = await inner().evaluate(() => document.getElementById("version").textContent);
    check(version === "PocketScore 1.0.4", `${size}: frozen copy is 1.0.4 (${version})`);
    await shot("preview-score");

    await frame.locator("#play").click();
    await page.waitForTimeout(2500);
    const playing = await inner().evaluate(() => window.app.state.playing);
    check(playing, `${size}: plays`);
    await frame.locator("#play").click();
    await frame.locator("#mixer-toggle").click();
    await frame.locator("#mixer:not([hidden])").waitFor({ timeout: 10000 });
    await shot("preview-mixer");

    // play only one part: solo the first part, the others go silent
    const parts = frame.locator("#mixer-body .strip:not(.master):not(.metronome)");
    const partCount = await parts.count();
    await parts.nth(0).locator(".s").click();
    await page.waitForTimeout(500);
    const solo = await inner().evaluate(() => {
        const ps = window.app.state.tracks.filter((t) => !t.metronome);
        return { first: ps[0].solo, othersSilent: ps.slice(1).every((t) => t.forceMute || t.mute) };
    });
    check(solo.first && (partCount < 2 || solo.othersSilent), `${size}: Solo plays only one part (${partCount} parts)`);
    await parts.nth(0).scrollIntoViewIfNeeded();
    await shot("preview-solo");

    // change a part's sound
    const before = await inner().evaluate(() => window.app.state.tracks.find((t) => !t.metronome).soundId);
    await parts.nth(0).locator(".sound").click();
    await frame.locator("#sounds:not([hidden])").waitFor({ timeout: 10000 });
    await shot("preview-sounds");
    const group = frame.locator("#sounds-body details").nth(1);
    await group.locator("summary").click();
    const choice = group.locator(".pick").filter({ hasNot: frame.locator('[aria-checked="true"]') }).first();
    const chosen = await choice.locator("span:nth-child(2)").textContent();
    await choice.click();
    await frame.locator("#sounds").waitFor({ state: "hidden", timeout: 10000 });
    await inner().waitForFunction((b) => window.app.state.tracks.find((t) => !t.metronome).soundId !== b, before, { timeout: 120000 });
    await inner().waitForFunction(() => window.app.state.tracks.every((t) => t.ready), null, { timeout: 120000 });
    const shown = await parts.nth(0).locator(".sound span").textContent();
    check(shown === chosen, `${size}: sound changed to ${chosen} (mixer shows ${shown})`);
    await frame.locator("#play").click();
    await page.waitForTimeout(2500);
    check(await inner().evaluate(() => window.app.state.playing), `${size}: plays the soloed part with its new sound`);
    await frame.locator("#play").click();
    await shot("preview-new-sound");
    await frame.locator("#mixer-close").click();

    await frame.locator("#speed-open").click();
    await shot("preview-speed");
    await frame.locator("#speed-close").click();

    // nothing kept: a preview writes no saved settings or drafts
    const kept = await inner().evaluate(() => Object.keys(localStorage).filter((k) => /mixer|notes(?!Prefs)/.test(k)));
    check(kept.length === 0, `${size}: nothing kept on the device (${kept.join(", ") || "no keys"})`);

    // Files: download the score, and its PDF and recordings from the same folder
    await page.click(".score-preview-files");
    await page.waitForSelector(".score-files .score-files-note:not(:has-text('Looking'))", { timeout: 30000 });
    const listed = await page.locator(".score-files .file-row strong").allTextContents();
    check(listed.length >= 1, `${size}: Files lists ${listed.join(" | ")} (${await page.textContent(".score-files-note")})`);
    await shot("preview-files");
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".score-files .file-row").first().click()]);
    const saved = path.join(outDir, `${size}-download-${download.suggestedFilename()}`);
    await download.saveAs(saved);
    check(fs.statSync(saved).size > 1000 && download.suggestedFilename().endsWith(".mscz"), `${size}: downloads ${download.suggestedFilename()} (${fs.statSync(saved).size} bytes)`);
    fs.rmSync(saved);
    if (!(await page.isVisible(".score-files"))) await page.click(".score-preview-files");
    await page.keyboard.press("Escape");
    check(!(await page.isVisible(".score-files")) && (await page.isVisible("dialog.score-preview[open]")), `${size}: Escape closes Files, not the preview`);
    if (size === "phone") {
        const fits = await page.evaluate(() => {
            const bar = document.querySelector(".score-preview-bar").getBoundingClientRect();
            return [...document.querySelectorAll(".score-preview-bar > *")].every((el) => el.getBoundingClientRect().right <= bar.right + 0.5);
        });
        check(fits, `${size}: the bar's buttons fit at ${width} px`);
    }

    await page.click(".score-preview-close");
    await page.waitForFunction(() => !document.querySelector("dialog.score-preview"), null, { timeout: 10000 });
    check(await page.isVisible(".file-preview"), `${size}: Close goes back to the library`);
    await shot("closed");
    await context.close();
}
await browser.close();
console.log(failures ? `${failures} FAILED` : "All checks passed", "- screenshots in", outDir);
process.exit(failures ? 1 : 0);
