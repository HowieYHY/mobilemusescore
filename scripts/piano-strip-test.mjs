// Needs: cd app && npx vite --port 5181 --host 127.0.0.1
// BREAK_BLACK=1 deliberately removes black-key hit areas to prove the touch check fails.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { chromium } = require("playwright");
const browser = await chromium.launch();
let failures = 0;
const check = (ok, message) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
    if (!ok) failures++;
};
try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(process.env.APP_URL || "http://127.0.0.1:5181/");
    await page.evaluate(async () => {
        const { PianoStrip } = await import("/src/piano.ts");
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;left:0;bottom:0;width:412px;z-index:100;display:none";
        host.id = "test-piano"; // Edit has a piano of its own on the page now: every check is on this one
        document.body.append(host);
        window.pianoCalls = [];
        window.piano = new PianoStrip(host, { onKey: midi => window.pianoCalls.push(midi) });
        window.pianoHost = host;
    });
    const centered = midi => page.evaluate(midi => {
        const view = window.piano.el.getBoundingClientRect();
        const key = window.piano.el.querySelector(`[data-midi="${midi}"]`).getBoundingClientRect();
        return Math.abs(key.x + key.width / 2 - view.x - view.width / 2) < 1;
    }, midi);
    await page.evaluate(() => window.pianoHost.style.display = "block");
    await page.waitForFunction(() => window.piano.el.scrollLeft > 0);
    check(await centered(60), "first visible layout centres C4");
    check(await page.locator('#test-piano .piano-key[aria-label="C sharp 4"]').count() === 1, "black key has a readable pitch name");
    check(await page.locator("#test-piano .piano-white .piano-tag").count() === 52, "all 52 white keys have name tags");

    const point = async (midi, top = false) => {
        const b = await page.locator(`#test-piano .piano-key[data-midi="${midi}"]`).boundingBox();
        assert.ok(b);
        return { x: b.x + b.width / 2, y: b.y + b.height * (top ? 0.3 : 0.85) };
    };
    const touch = (type, p) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [p] : [] });
    const tap = async p => {
        await touch("touchStart", p);
        await touch("touchEnd");
        await page.waitForTimeout(80);
    };
    const calls = () => page.evaluate(() => window.pianoCalls.splice(0));
    const geometry = () => page.evaluate(() => ({
        scroll: window.piano.el.scrollLeft,
        boxes: [window.piano.el, ...window.piano.el.querySelectorAll("button")].map(el => {
            const b = el.getBoundingClientRect();
            return [b.x, b.y, b.width, b.height];
        }),
    }));
    const beforePress = await geometry();
    await touch("touchStart", await point(60));
    check(await page.locator('#test-piano [data-midi="60"].pressed').count() === 1, "pointerdown shows a pressed white key");
    check(JSON.stringify(await geometry()) === JSON.stringify(beforePress), "pressing changes no geometry or scroll");
    await touch("touchEnd");
    await page.waitForTimeout(80);
    check(JSON.stringify(await calls()) === "[60]", "real touch on white key calls onKey(60)");
    check(await page.locator("#test-piano .piano-key.pressed").count() === 0, "lifting clears pressed state");
    if (process.env.BREAK_BLACK) await page.addStyleTag({ content: ".piano-black { pointer-events: none !important; }" });
    await tap(await point(61, true));
    const blackCalls = await calls();
    check(JSON.stringify(blackCalls) === "[61]", `real touch on black key calls onKey(61): got ${JSON.stringify(blackCalls)}`);

    const scrollBefore = await page.evaluate(() => window.piano.el.scrollLeft);
    const start = { x: 340, y: 890 };
    await touch("touchStart", start);
    for (let i = 1; i <= 12; i++) {
        await touch("touchMove", { x: start.x - i * 20, y: start.y });
        await page.waitForTimeout(20);
    }
    check(await page.locator("#test-piano .piano-key.pressed").count() === 0, "native scrolling cancels pressed state");
    await touch("touchEnd");
    await page.waitForFunction(() => {
        const x = window.piano.el.scrollLeft;
        const stable = window.lastPianoScroll === x;
        window.lastPianoScroll = x;
        return stable;
    }, null, { polling: 150 });
    check(await page.evaluate(() => window.piano.el.scrollLeft) > scrollBefore + 100, "sideways touch drag scrolls the strip");
    check((await calls()).length === 0, "sideways drag calls no notes");
    const beforeLit = await geometry();
    await page.evaluate(() => { window.piano.setLit([61]); window.piano.setLit([60, 64]); });
    check(JSON.stringify(await page.locator("#test-piano .piano-key.lit").evaluateAll(keys => keys.map(k => Number(k.dataset.midi)))) === "[60,64]", "setLit replaces selection with exactly C4 and E4");
    check(JSON.stringify(await geometry()) === JSON.stringify(beforeLit), "lighting changes no geometry or scroll");
    await page.evaluate(() => window.piano.centerOn(84));
    check(await centered(84), "centerOn(84) brings C6 to the middle");
    const beforeVisible = await geometry();
    await page.evaluate(() => window.piano.centerOn(86));
    check(JSON.stringify(await geometry()) === JSON.stringify(beforeVisible), "a fully visible key does not scroll");
    await page.evaluate(() => window.piano.setDisabled(true));
    check(JSON.stringify(await geometry()) === JSON.stringify(beforeVisible), "disabling changes no bounding boxes or scroll");
    await tap(await point(84));
    await tap(await point(85, true));
    check((await calls()).length === 0, "disabled white and black keys ignore touch taps");
    check(JSON.stringify(await geometry()) === JSON.stringify(beforeVisible), "disabled taps move nothing");
    // Hidden and shown again (Edit closed and opened): the strip is where it was left. (A request made while
    // it is hidden is covered at the top, where the strip is built hidden. One made after it has been scrolled
    // and hidden can lose to the browser putting the old place back; Edit never asks then.)
    const leftBefore = await page.evaluate(() => { window.piano.setDisabled(false); return window.piano.el.scrollLeft; });
    await page.evaluate(() => window.pianoHost.style.display = "none");
    await page.waitForTimeout(200);
    await page.evaluate(() => window.pianoHost.style.display = "block");
    await page.waitForTimeout(600);
    check(await page.evaluate(() => window.piano.el.scrollLeft) === leftBefore, "hidden and shown again, the strip is where it was");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.piano.centerOn(84, true));
    check(await centered(84), "reduced motion makes requested smooth scrolling immediate");
    await page.setViewportSize({ width: 412, height: 600 });
    check(await page.locator("#test-piano .piano-strip").evaluate(el => el.getBoundingClientRect().height) === 88, "short window uses the 88px strip");
    await page.evaluate(() => window.pianoHost.style.setProperty("--piano-key-w", "20px"));
    check(await page.locator("#test-piano .piano-white").first().evaluate(el => el.getBoundingClientRect().width) === 40, "white keys never shrink below 40px");
    console.log(`${failures ? "FAIL" : "PASS"}: piano strip (${failures} failures)`);
} finally {
    await browser.close();
}
process.exitCode = failures ? 1 : 0;
