// Checks the installed web app works with no network: visits the production
// build once, waits for the service worker to store everything, goes
// offline, reloads, opens a score and plays it.
//
// Needs: (cd app && npm run build && npx vite preview --port 5181)
// Usage: node scripts/offline-test.mjs <score.mscz>

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:5181/";

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
const page = await context.newPage();
let failures = 0;

try {
    await page.goto(url);
    const t0 = Date.now();
    // wait until the service worker has finished installing (all files cached)
    await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        return !!reg.active;
    });
    const cached = await page.evaluate(async () => {
        let n = 0;
        for (const name of await caches.keys()) {
            n += (await (await caches.open(name)).keys()).length;
        }
        return n;
    });
    console.log(`service worker active after ${Date.now() - t0} ms, ${cached} files cached`);

    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 60000 });
    console.log("offline reload: engine ready");

    await page.setInputFiles("#file-input", scorePath);
    await page.waitForSelector(".page canvas", { timeout: 60000 });
    console.log("offline: score opened and drawn");

    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    const pos = await page.evaluate(() => app.state.position);
    console.log(`offline: playing, position ${pos.toFixed(1)} s`);
    if (pos < 2) {
        console.error("FAIL: offline playback not advancing");
        failures++;
    }
} catch (e) {
    console.error("FAIL:", e.message);
    failures++;
} finally {
    await browser.close();
}
console.log(failures ? "offline test FAILED" : "offline test passed");
process.exit(failures ? 1 : 0);
