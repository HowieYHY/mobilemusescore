// Saved sound choices must come back every time a score is reopened, also
// when the audio is already running (the sounds then load in a moment, and the
// saved settings used to lose that race now and then).
//
// Gives several parts another sound, saves, then reopens the score a number
// of times (and opens another score in between), checking every part's sound.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/reopen-test.mjs [score.mscz] [times=8]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/GODS_NUS RESONANCE_FINAL_CHORAL INTRO.mscz"));
const otherPath = path.join(root, "real test musescores/midnight sun.mscz");
const times = Number(process.argv[3] || 8);
const url = process.env.APP_URL || "http://localhost:5180/";

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url);
await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pocketscore.")).forEach((k) => localStorage.removeItem(k)));
await page.reload();
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });

// SLOW=1: restoring saved settings takes longer than the sounds take to load,
// and each mixer change takes a moment, as on a slower phone or tablet
if (process.env.SLOW) {
    await page.evaluate(() => {
        const orig = app.engine.masterVolume.bind(app.engine);
        app.engine.masterVolume = async () => {
            await new Promise((r) => setTimeout(r, 1500));
            return orig();
        };
        // each mixer change takes a moment, so the sounds can become ready
        // while the saved settings are still being put back, part by part
        const vol = app.engine.setVolume.bind(app.engine);
        app.engine.setVolume = async (k, db) => {
            await new Promise((r) => setTimeout(r, 250));
            return vol(k, db);
        };
    });
}

async function open(file) {
    // the flag is still set from the score before: clear it, so the wait below is for this one
    await page.evaluate(() => (app.state.playbackReady = false));
    await page.setInputFiles("#file-input", file);
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    await page.waitForTimeout(1500); // anything still settling
}
const soundsNow = () => page.evaluate(async () => (await app.engine.tracks()).filter((t) => !t.metronome).map((t) => t.sound));

await open(scorePath);
const before = await soundsNow();
console.log(`parts: ${before.length}; sounds: ${before.join(", ")}`);

// give 6 parts (or as many as there are) a string sound, one after another
const leaves = await page.evaluate(async () => {
    const out = [];
    const walk = (n) => ("id" in n ? out.push(n) : n.c.forEach(walk));
    (await app.engine.sounds()).tree.forEach(walk);
    return out;
});
const pick = leaves.filter((l) => /violin|viola|cello|strings|flute|oboe/i.test(l.n));
const parts = await page.evaluate(async () => (await app.engine.tracks()).filter((t) => !t.metronome).map((t) => t.key));
const changed = parts.slice(0, Math.min(6, parts.length));
for (let i = 0; i < changed.length; i++) {
    await page.evaluate(([k, id]) => app.engine.setSound(k, id), [changed[i], pick[i % pick.length].id]);
    await page.evaluate((k) => app.engine.setVolume(k, -3), changed[i]); // and a volume, as practising often does
}
// as the mixer does after a change
await page.click("#mixer-toggle");
await page.waitForSelector(".strip:not(.master)");
await page.locator(".strip.metronome .toggle.m").click(); // any change refreshes the mixer state
await page.waitForTimeout(300);
await page.locator(".strip.metronome .toggle.m").click();
await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById("mixer-close").click());
const wanted = await soundsNow();
await page.evaluate(async () => {
    // make the app record the new sounds as a change, then save
    app.state.tracks = await app.engine.tracks();
});
await page.locator("#mixer-toggle").click();
await page.locator(".strip:not(.master):not(.metronome) .toggle.s").first().click(); // solo on
await page.waitForTimeout(300);
await page.locator(".strip:not(.master):not(.metronome) .toggle.s").first().click(); // and off
await page.waitForTimeout(300);
if (!(await page.isEnabled("#save"))) {
    console.log("FAIL: the sound changes did not light up Save");
    process.exit(1);
}
await page.click("#save");
console.log(`chosen: ${wanted.join(", ")}`);

let failures = 0;
for (let i = 1; i <= times; i++) {
    if (i % 2 === 0) {
        await open(otherPath); // another score in between
    }
    await open(scorePath);
    const now = await soundsNow();
    const wrong = now.filter((s, j) => s !== wanted[j]).length;
    console.log(`${wrong ? "FAIL" : "ok  "} reopen ${i}: ${wrong} part(s) not on the saved sound${wrong ? " (" + now.join(", ") + ")" : ""}`);
    failures += wrong ? 1 : 0;
}
await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pocketscore.")).forEach((k) => localStorage.removeItem(k)));
await browser.close();
console.log(failures ? `${failures} of ${times} reopenings lost saved sounds` : "saved sounds came back every time");
process.exit(failures ? 1 : 0);
