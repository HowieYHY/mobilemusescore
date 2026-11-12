// The sound font download fails once (a dropped connection): the next Play must load it again (bug hunt,
// finding 3). Before, the failed start was kept and Play stayed dead for the whole visit.
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/Paper Hearts.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true })).newPage();
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
let fontAsked = 0;
let cut = true;
await page.route("**/sound/MS%20Basic.sf3", (route) => {
    fontAsked++;
    return cut ? route.abort("connectionreset") : route.continue();
});
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
const b64 = fs.readFileSync(scorePath).toString("base64");
await page.evaluate(async (data) => {
    const bin = atob(data);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return app.openScore("Paper Hearts.mscz", u.buffer);
}, b64);
await page.waitForSelector("#pages .page canvas");
const status = () => page.evaluate(() => document.getElementById("status").textContent);

// the score's own start of the sounds fails
await page.waitForFunction(() => /sounds|Audio/i.test(document.getElementById("status").textContent) && document.getElementById("status").classList.contains("error"), null, { timeout: 30000 }).catch(() => {});
check(fontAsked === 1, `the sound font was asked for once (${fontAsked})`);
check(/tap Play again/.test(await status()), "the reader is told to tap Play again: " + await status());
check(!(await page.evaluate(() => app.state.playbackReady)), "no sounds yet");

// the connection is back: Play loads them
cut = false;
await page.click("#play");
const ready = await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 }).then(() => true, () => false);
check(fontAsked === 2, `Play asked for the sound font again (${fontAsked})`);
check(ready, "and the sounds loaded: " + await status());
if (ready) {
    const playing = await page.waitForFunction(() => app.state.playing, null, { timeout: 20000 }).then(() => true, () => false);
    check(playing, "the music plays (the Play that was tapped)");
}

await browser.close();
console.log(failures ? `${failures} failure(s)` : "sounds-retry test passed");
process.exit(failures ? 1 : 0);
