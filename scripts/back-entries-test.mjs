// No Back entry is left behind by the Mixer and its sound list (bug hunt, finding 16), by touch on a
// phone-sized page. Before the fix, closing the Mixer with a part's sound list open, or opening Speed
// or Settings over the two, left one history entry with no panel: the phone's Back then did nothing
// once before leaving the app. Each step checks the panels really opened and closed, and that the
// page sits on a Back entry exactly when a panel is open.
// Usage: node scripts/back-entries-test.mjs [score.mscz]
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const scorePath = path.resolve(process.argv[2] || ["real test musescores", "real test musescore files"]
    .map((d) => path.join(root, d, "I am move it edited.mscz")).find((f) => fs.existsSync(f)));

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
await page.setInputFiles("#file-input", scorePath);
await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });

const settle = () => page.waitForTimeout(400); // the browser's own going back lands in here
const now = () => page.evaluate(() => ({
    mixer: !document.getElementById("mixer").hidden,
    sounds: !document.getElementById("sounds").hidden,
    speed: !document.getElementById("speed-panel").hidden,
    settings: !document.getElementById("settings").hidden,
    layers: app.layers.length,
    entry: history.state?.pocketscoreLayer || 0, // which of the app's Back entries the page is on (0: none)
}));
const openIs = (s, ...names) => ["mixer", "sounds", "speed", "settings"].every((n) => s[n] === names.includes(n));
const says = (s) => `${s.layers} panel(s) counted, on Back entry ${s.entry}`;

async function mixerWithSounds() {
    await page.tap("#mixer-toggle");
    await page.waitForSelector("#mixer .sound");
    await page.tap("#mixer .sound >> nth=0");
    await page.waitForSelector("#sounds:not([hidden])");
    await settle();
    const s = await now();
    check(openIs(s, "mixer", "sounds") && s.layers === 2 && s.entry === 2, `the Mixer with a part's sound list: ${says(s)}`);
}

// (a) the Mixer button closes both
await mixerWithSounds();
await page.evaluate(() => document.getElementById("mixer-toggle").click()); // under the sound list on a phone
await settle();
let s = await now();
check(openIs(s) && s.layers === 0, "the Mixer button closes the Mixer and the sound list");
check(s.entry === 0, `no Back entry is left: ${says(s)}`);

// (b) Speed takes the place of both
await mixerWithSounds();
await page.evaluate(() => document.getElementById("speed-open").click());
await settle();
s = await now();
check(openIs(s, "speed") && s.layers === 1, "Speed opens in place of the Mixer and the sound list");
check(s.entry === 1, `one Back entry for the one panel: ${says(s)}`);
await page.goBack();
await settle();
s = await now();
check(openIs(s) && s.layers === 0 && s.entry === 0, `the phone's Back closes Speed and nothing is left: ${says(s)}`);

// (c) Settings takes the place of both, then its own close
await mixerWithSounds();
await page.evaluate(() => document.getElementById("settings-open").click());
await settle();
s = await now();
check(openIs(s, "settings") && s.layers === 1 && s.entry === 1, `Settings in place of the Mixer and the sound list: ${says(s)}`);
await page.evaluate(() => document.getElementById("settings-open").click());
await settle();
s = await now();
check(openIs(s) && s.layers === 0 && s.entry === 0, `Settings closed, nothing left: ${says(s)}`);

// the sound list alone still goes back to the Mixer, and Back from there closes it
await mixerWithSounds();
await page.goBack();
await settle();
s = await now();
check(openIs(s, "mixer") && s.layers === 1 && s.entry === 1, `Back from the sound list shows the Mixer: ${says(s)}`);
await page.goBack();
await settle();
s = await now();
check(openIs(s) && s.layers === 0 && s.entry === 0, `Back again closes the Mixer: ${says(s)}`);

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
