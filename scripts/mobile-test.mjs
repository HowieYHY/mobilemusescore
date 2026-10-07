// Phone checks in Chromium with touch (an Android-sized screen): drawing with
// a finger (on and off), the Back button closing panels, the mixer's volume
// and sound picker, the sound choice coming back after reopening, and the
// install button. Saves screenshots in build/mobile.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/mobile-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:5180/";
const outDir = path.join(root, "build/mobile");
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const cdp = await context.newCDPSession(page);
const shot = (name) => page.screenshot({ path: path.join(outDir, name + ".png") });

async function open(beforeScore = async () => {}) {
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await beforeScore();
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForSelector(".page canvas", { timeout: 180000 });
}

// a one-finger drag through the browser's real touch input
async function fingerDrag(x0, y0, x1, y1, steps = 12) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= steps; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(150);
}

// ---- install button on the start screen (Chrome's beforeinstallprompt, simulated)
await open(async () => {
    await page.evaluate(() => {
        const e = new Event("beforeinstallprompt");
        e.prompt = async () => { window.__prompted = true; };
        e.userChoice = Promise.resolve({ outcome: "accepted" });
        window.dispatchEvent(e);
    });
    check(await page.isVisible("#install"), "Chrome's install offer shows an Install button on the start screen");
    await shot("00-start-install");
    await page.tap("#install");
    check(await page.evaluate(() => window.__prompted === true), "the Install button opens Chrome's install dialog");
});
await shot("01-opened");

// ---- notes with a finger
await page.tap("#notes-toggle");
check(await page.isVisible("#notes-finger"), "the Draw with finger switch shows for the pen");
check(await page.getAttribute("#notes-finger", "aria-pressed") === "true", "Draw with finger is on by default (no stylus yet)");
check(await page.evaluate(() => getComputedStyle(document.getElementById("pages")).touchAction) === "none",
    "the page does not scroll under a drawing finger (touch-action: none)");
await shot("02-notes-bar");

const box = await page.locator(".page").first().boundingBox();
const scroll0 = await page.evaluate(() => document.getElementById("viewer").scrollTop);
await fingerDrag(box.x + 60, box.y + 120, box.x + 260, box.y + 260);
check(await page.locator(".page .ink path.pen").count() === 1, "a finger draws a pen stroke");
check(await page.evaluate(() => document.getElementById("viewer").scrollTop) === scroll0, "drawing with a finger did not scroll the page");

await page.tap("#notes-finger");
check(await page.getAttribute("#notes-finger", "aria-pressed") === "false", "Draw with finger turns off");
check(await page.evaluate(() => getComputedStyle(document.getElementById("pages")).touchAction) !== "none", "with it off, fingers scroll again");
await fingerDrag(box.x + 200, box.y + 500, box.x + 200, box.y + 200);
check(await page.locator(".page .ink path.pen").count() === 1, "with it off, a finger does not draw");
check(/stylus/i.test(await page.textContent("#notes-hint")), "the hint says to use a stylus or turn the switch on");
await page.tap("#notes-finger");

// text: double tap adds, one tap outside finishes
await page.tap('.tool[data-tool="text"]');
check(!(await page.isVisible("#notes-finger")), "the finger switch hides for the text tool");
const tb = await page.locator(".page").first().boundingBox();
await page.touchscreen.tap(tb.x + 150, tb.y + 400);
await page.waitForTimeout(80);
await page.touchscreen.tap(tb.x + 150, tb.y + 400);
await page.waitForTimeout(200);
check(await page.locator(".tnote.sel").count() === 1, "a double tap adds a text box");
await page.keyboard.type("Slower");
await shot("03-text-editing");
await page.touchscreen.tap(tb.x + 150, tb.y + 600);
await page.waitForTimeout(200);
check(await page.locator(".tnote.sel").count() === 0 && await page.locator(".tnote").count() === 1, "one tap outside finishes it");

await page.tap('.tool[data-tool="pen"]');
await page.tap("#more-colors");
await shot("04-palette");
check(await page.isVisible("#palette"), "the palette opens");
await page.goBack();
await page.waitForTimeout(200);
check(!(await page.isVisible("#palette")) && await page.isVisible("#notesbar"), "Back closes the palette, notes stay on");
await page.goBack();
await page.waitForTimeout(200);
check(!(await page.isVisible("#notesbar")), "Back again leaves notes mode");
check(page.url().startsWith(url) && await page.locator(".page canvas").count() > 0, "Back did not leave the app");

// ---- mixer
await page.tap("#play");
await page.waitForFunction(() => app.state.playbackReady && app.state.playing, null, { timeout: 180000 });
await page.waitForTimeout(1500);
await page.tap("#play"); // pause
await page.tap("#mixer-toggle");
await page.waitForSelector(".strip:not(.master)");
await page.waitForTimeout(300);
await shot("05-mixer");
const mixerH = (await page.locator("#mixer").boundingBox()).height;
check(mixerH <= 915 * 0.5, `the mixer takes at most half the screen (${Math.round(mixerH)} px of 915)`);
const labels = await page.locator(".strip .db").allTextContents();
check(labels.every((l) => /^\d+%$|^Muted$/.test(l)), `volumes read as percentages (${labels.slice(0, 4).join(", ")}…)`);

// set the first part to 50%: about -10 dB in the engine
const first = page.locator(".strip:not(.master):not(.metronome)").first();
await first.locator(".vol").evaluate((el) => {
    el.value = "50";
    el.dispatchEvent(new Event("input", { bubbles: true }));
});
const firstKey = await page.evaluate(() => app.state.tracks.find((t) => !t.metronome).key);
const vol = await page.evaluate(async (k) => (await app.engine.tracks()).find((t) => t.key === k).volume, firstKey);
check(Math.abs(vol - -10) < 0.2, `50% sets the part to about -10 dB (${vol.toFixed(1)} dB)`);
check(await first.locator(".db").textContent() === "50%", "its label reads 50%");

// mute shows on the strip
await first.locator(".toggle.m").tap();
await page.waitForTimeout(300);
check(await page.locator(".strip:not(.master):not(.metronome)").first().locator(".db").textContent() === "Muted", "a muted part says Muted");
await page.locator(".strip:not(.master):not(.metronome)").first().locator(".toggle.m").tap();
await page.waitForTimeout(300);

// reverb is behind the Reverb switch
check(!(await page.locator(".strip .rev").first().isVisible()), "reverb sliders are tucked away");
await page.tap("#mixer-reverb");
check(await page.locator(".strip .rev").first().isVisible(), "the Reverb switch shows them");
await shot("06-mixer-reverb");
await page.tap("#mixer-reverb");

// sound picker
const before = await page.evaluate((k) => app.state.tracks.find((t) => t.key === k), firstKey);
await page.locator(".strip:not(.master):not(.metronome)").first().locator(".sound").tap();
await page.waitForSelector("#sounds:not([hidden])");
await page.waitForTimeout(200);
await shot("07-sounds");
check(await page.locator("#sounds .pick.top").textContent().then((t) => /Choose automatically/.test(t)), "the sound list starts with Choose automatically, as on desktop");
check(await page.locator('#sounds .pick[aria-checked="true"]').count() === 1, "the current sound is ticked");
// open a category and pick a sound from it
const cat = page.locator("#sounds-body > details").filter({ hasText: "Strings" }).first();
await cat.locator("> summary").tap();
const choice = cat.locator(".pick").first();
const choiceName = (await choice.textContent()).trim();
await choice.tap();
await page.waitForSelector("#sounds", { state: "hidden" });
await page.waitForTimeout(300);
const after = await page.evaluate(async (k) => (await app.engine.tracks()).find((t) => t.key === k), firstKey);
check(after.soundId !== before.soundId && choiceName.startsWith(after.sound), `the part now plays ${after.sound}`);
check((await page.locator(".strip:not(.master):not(.metronome)").first().locator(".sound").textContent()).includes(after.sound), "the strip shows the new sound");
await shot("08-mixer-new-sound");

// Back closes the mixer
await page.goBack();
await page.waitForTimeout(200);
check(!(await page.isVisible("#mixer")), "Back closes the mixer");

// reopen the score: the sound choice comes back
await open();
await page.tap("#play");
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
await page.waitForTimeout(800);
const reopened = await page.evaluate(async (k) => (await app.engine.tracks()).find((t) => t.key === k), firstKey);
check(reopened.soundId === after.soundId, `the chosen sound comes back after reopening (${reopened.sound})`);

// reset it, so the next run starts clean
await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pocketscore.sounds.")).forEach((k) => localStorage.removeItem(k)));

await browser.close();
console.log(failures ? `${failures} failure(s)` : "all phone checks passed");
process.exit(failures ? 1 : 0);
