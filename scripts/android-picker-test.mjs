// Opens Android's file picker for each filter on picker-test.html (issue #7)
// and screenshots what it offers, then closes it with Back. Picks nothing and
// writes nothing on the phone. Same set-up as android-test.mjs.
// Usage: APP_URL=http://localhost:4173/ node scripts/android-picker-test.mjs [outDir]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const outDir = path.resolve(process.argv[2] || path.join(root, "build/android-picker"));
const url = new URL("picker-test.html", process.env.APP_URL || "http://localhost:4173/").href;
const adbPath = process.env.ADB || (fs.existsSync("D:/tools/platform-tools/adb.exe") ? "D:/tools/platform-tools/adb.exe" : "adb");
fs.mkdirSync(outDir, { recursive: true });
const adb = (...args) => execFileSync(adbPath, args, { maxBuffer: 64 << 20 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = await browser.contexts()[0].newPage();
const cdp = await page.context().newCDPSession(page);
await page.goto(url);
const letters = await page.$$eval(".row b", (bs) => bs.map((b) => b.textContent));
try {
    for (let i = 0; i < letters.length; i++) {
        const input = page.locator(".row input").nth(i);
        await input.scrollIntoViewIfNeeded();
        const box = await input.boundingBox();
        // a real tap, so Chrome treats it as the user's and opens the picker
        const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await wait(2500);
        const focus = adb("shell", "dumpsys", "window").toString().match(/mCurrentFocus=.*/)?.[0] ?? "?";
        const name = letters[i].slice(0, 1);
        fs.writeFileSync(path.join(outDir, name + ".png"), adb("exec-out", "screencap", "-p"));
        console.log(`${letters[i]}: ${focus}`);
        if (!focus.includes("chrome")) {
            adb("shell", "input", "keyevent", "KEYCODE_BACK");
            await wait(1200);
        }
    }
} finally {
    await page.close();
}
process.exit(0);
