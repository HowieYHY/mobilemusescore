// The iPhone/iPad install hint (issue #13): shown on the start screen in an iPhone or iPad browser
// (iPadOS also passes for a Mac with touch), not once PocketScore runs as the installed app, and not
// on Android, computers or in the Reso website's preview. The start-screen tour includes it.
// Screenshot: build/install-hint.png. A real iPhone/iPad is still the final check.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/install-hint-test.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://localhost:5180/";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
const touchPoints = (n) => `Object.defineProperty(navigator, "maxTouchPoints", { get: () => ${n} });`;

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures++;
};

const browser = await chromium.launch();
async function startScreen({ userAgent, init = "", path: at = "", width = 412, height = 915 }) {
    const context = await browser.newContext({ userAgent, viewport: { width, height }, deviceScaleFactor: 2 });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    await page.goto(url + at);
    await page.waitForFunction(() => window.app?.firstTime, null, { timeout: 120000 });
    return { context, page, shown: () => page.isVisible("#install-ios") };
}

{
    const { context, page, shown } = await startScreen({ userAgent: IPHONE, init: touchPoints(5) });
    check(await shown(), "iPhone browser: install hint shown");
    await page.screenshot({ path: path.join(root, "build/install-hint.png") });
    await page.click("#tour-start");
    const titles = [];
    for (;;) {
        titles.push(await page.textContent(".tour-title"));
        if ((await page.textContent(".tour-next")) === "Done") break;
        await page.click(".tour-next");
    }
    check(titles.includes("Install PocketScore"), `iPhone: the start-screen tour includes installing (${titles.join(" / ")})`);
    await context.close();
}
// each browser shows only its own steps
const CHROME_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1";
const FIREFOX_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15";
for (const [what, userAgent, want] of [["Safari", IPHONE, "for-safari"], ["Chrome", CHROME_IOS, "for-chrome"], ["Firefox", FIREFOX_IOS, "for-other"]]) {
    const { context, page, shown } = await startScreen({ userAgent, init: touchPoints(5) });
    const visible = await page.evaluate(() => [...document.querySelectorAll("#install-ios [class^='for-']")].filter((el) => !el.hidden).map((el) => el.className));
    check(await shown() && visible.length > 0 && visible.every((c) => c === want), `iPhone ${what}: only its own steps (${[...new Set(visible)].join(", ")})`);
    if (what === "Chrome") await page.screenshot({ path: path.join(root, "build/install-hint-chrome.png") });
    await context.close();
}
for (const [what, opts, expected] of [
    ["iPad (passing for a Mac, with touch)", { userAgent: IPAD, init: touchPoints(5), width: 820, height: 1180 }, true],
    ["iPhone home-screen app", { userAgent: IPHONE, init: touchPoints(5) + ` Object.defineProperty(navigator, "standalone", { get: () => true });` }, false],
    ["a Mac without touch", { userAgent: IPAD, init: touchPoints(0), width: 1280, height: 800 }, false],
    ["Android", { userAgent: ANDROID, init: touchPoints(5) }, false],
]) {
    const { context, shown } = await startScreen(opts);
    check((await shown()) === expected, `${what}: install hint ${expected ? "shown" : "not shown"}`);
    await context.close();
}
{
    const context = await browser.newContext({ userAgent: IPHONE });
    await context.addInitScript(touchPoints(5));
    const page = await context.newPage();
    await page.setContent(`<iframe src="${url}?embed=reso" style="width:400px;height:800px"></iframe>`);
    const frame = await (await page.waitForSelector("iframe")).contentFrame();
    await frame.waitForFunction(() => window.app?.firstTime, null, { timeout: 120000 });
    check(await frame.isHidden("#install-ios"), "website preview on an iPhone: no install hint");
    await context.close();
}
await browser.close();
console.log(failures ? `${failures} FAILED` : "install hint checks passed");
process.exit(failures ? 1 : 0);
