// "Two pages" view (issue #34) on a USB-debugging Android phone, in its own Chrome tab, with real
// touch (CDP Input.dispatchTouchEvent, which reaches only this tab): what the PC can't show, whether
// the phone really turns its screen. Choosing the view starts Focus. Without the reader's own tap
// behind it (as when a score opens straight into the view) the browser allows no full screen, so
// upright the line *Turn your device on its side* shows, with how to get the controls back, and two
// whole pages still do. Chosen by the reader (here: the menu's change sent as a user's action), it
// goes full screen, the screen turns on its side by itself, two whole pages sit together in the
// middle, a swipe moves on one page and back; leaving full screen gives the screen back as it was.
// Screenshots come from the phone, and their shape (wide or tall) is the proof of which way it is.
//
// This is a Chrome tab, not the installed app (which is its own Android task and may be allowed to
// turn without full screen): that case stays the reader's to try.
//
// Sends no keys or taps through adb, never turns the screen off, and stops before doing anything if
// the phone is asleep, locked or showing something other than Chrome. Runs on 127.0.0.1:4173 (a
// local build, its own storage, so the reader's PocketScore is untouched):
//   cd app && npm run build && npx vite preview --port 4173 --host 127.0.0.1
// Leaves the phone as found: only its own tab is closed and the forwarded ports are removed.
// Usage: node scripts/android-pagepair-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { adb } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:4173/";
const version = JSON.parse(fs.readFileSync(path.join(root, "app/package.json"), "utf8")).version;
const outDir = path.join(root, "build/android-pagepair");
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a screenshot from the phone, and its shape
const shot = (name) => {
    const png = adb("exec-out", "screencap", "-p");
    fs.writeFileSync(path.join(outDir, name + ".png"), png);
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    return { w, h, wide: w > h };
};
const sh = (...args) => adb("shell", ...args).toString();
const focused = () => (sh("dumpsys", "window").match(/mCurrentFocus=.*/) || [""])[0];
const awake = () => /mWakefulness=Awake/.test(sh("dumpsys", "power"));
const locked = () => /mDreamingLockscreen=true|isKeyguardShowing=true|mShowingLockscreen=true/.test(sh("dumpsys", "window"));

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures++;
};

console.log("device:", sh("getprop", "ro.product.model").trim());
if (!awake() || locked()) {
    console.log("STOP the phone is asleep or locked; wake and unlock it, then run again (nothing was sent to it)");
    process.exit(3);
}
adb("reverse", "tcp:4173", "tcp:4173");
adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
// the test's own tab, opened as the reader would open a link
adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, "com.android.chrome");
for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const targets = await fetch("http://localhost:9222/json/list").then((r) => r.json()).catch(() => []);
    const others = targets.filter((t) => t.type === "service_worker" && !t.url.startsWith(url));
    if (targets.some((t) => t.type === "page" && t.url.startsWith(url)) && others.length === 0) break;
}
const cleanup = () => {
    try { adb("forward", "--remove", "tcp:9222"); } catch { /* gone */ }
    try { adb("reverse", "--remove", "tcp:4173"); } catch { /* gone */ }
};
if (!/com\.android\.chrome/.test(focused())) {
    console.log(`STOP Chrome is not in front (${focused()}); nothing was sent to the phone`);
    cleanup();
    process.exit(3);
}
const browser = await chromium.connectOverCDP("http://localhost:9222", { timeout: 120000 });
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(url));
if (!page) {
    console.log("FAIL the test tab did not open");
    cleanup();
    process.exit(1);
}
page.on("pageerror", (e) => check(false, `page error: ${e.message}`));
const cdp = await page.context().newCDPSession(page);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
// every touch first makes sure Chrome is still what the phone shows
const guard = () => {
    const f = focused();
    if (!/com\.android\.chrome/.test(f)) {
        throw new Error(`Chrome is no longer in front (${f}); stopped without touching`);
    }
};
const tapEl = async (sel) => {
    guard();
    const b = await page.locator(sel).boundingBox();
    await touch("touchStart", [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }]);
    await sleep(60);
    await touch("touchEnd", []);
};
async function swipe(frac) {
    guard();
    const m = await page.evaluate(() => {
        const r = document.getElementById("viewer").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });
    const dx = m.w * frac;
    await touch("touchStart", [{ x: m.x - dx / 2, y: m.y, id: 1 }]);
    for (let k = 1; k <= 8; k++) {
        await touch("touchMove", [{ x: m.x - dx / 2 + dx * k / 8, y: m.y, id: 1 }]);
        await sleep(20);
    }
    await touch("touchEnd", []);
    await sleep(1200);
}
const view = () => page.evaluate(() => {
    const v = document.getElementById("viewer").getBoundingClientRect();
    const rects = [...document.querySelectorAll(".page")].map((el) => el.getBoundingClientRect());
    const whole = rects.map((r, i) => (r.left >= v.left - 0.5 && r.right <= v.right + 0.5 && r.top >= v.top - 0.5 && r.bottom <= v.bottom + 0.5 ? i : -1)).filter((i) => i >= 0);
    // the page whose pair (it and the next) sits in the middle of the screen, both whole
    const mid = rects.findIndex((r, i) => rects[i + 1] && whole.includes(i) && whole.includes(i + 1)
        && Math.abs((r.left + rects[i + 1].right) / 2 - (v.left + v.width / 2)) <= 1.5);
    const hint = ["status", "focus-hint"].map((id) => document.getElementById(id)).filter((el) => !el.hidden).map((el) => el.textContent).join(" ");
    return {
        whole, mid, gap: mid >= 0 ? rects[mid + 1].left - rects[mid].right : null, w: innerWidth, h: innerHeight, type: screen.orientation.type,
        fullscreen: !!document.fullscreenElement, focus: app.state.focus, hint,
        bars: getComputedStyle(document.querySelector(".topbar")).display !== "none",
    };
});
const pair = (s, i) => s.mid === i && s.gap >= 3.5 && s.gap <= 5.5;
const say = (s) => `in the middle: ${s.mid < 0 ? "no two pages" : `${s.mid + 1} and ${s.mid + 2}`}, gap ${s.gap?.toFixed(1)} px, whole ${s.whole.map((i) => i + 1)}, page ${s.w}x${s.h}, ${s.type}`;
// the view menu, changed as the reader's own action (which is what lets the browser go full screen)
// or not (as when a score opens straight into the view)
const chooseView = (v, asReader) => cdp.send("Runtime.evaluate", {
    expression: `(() => { const m = document.getElementById("view-mode"); m.value = ${JSON.stringify(v)}; m.dispatchEvent(new Event("change")); })()`,
    userGesture: asReader,
});

try {
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 300000 });
    const v = await page.evaluate(() => document.getElementById("version").textContent);
    check(v === `PocketScore ${version}`, `the ${version} build (${v})`);
    check(await page.evaluate(() => !![...document.querySelectorAll("#view-mode option")].find((o) => o.value === "page_pair")), "this build has the Two pages view");

    const b64 = fs.readFileSync(scorePath).toString("base64");
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        app.state.playbackReady = false; // not a score's from before
        await window.app.openScore(name, bytes.buffer);
    }, { name: path.basename(scorePath), b64 });
    await page.waitForSelector(".page canvas", { timeout: 300000 });
    await page.waitForFunction(() => window.app.state.playbackReady, null, { timeout: 300000 });
    await page.waitForTimeout(1500);
    const start = shot("01-score");
    const before = await view();
    console.log(`     at the start the screen is ${start.wide ? "on its side" : "upright"} (${start.w}x${start.h}, ${before.type})`);

    // not the reader's own choice: Focus without full screen, the screen stays, and the reader is told
    await chooseView("page_pair", false);
    await page.waitForFunction(() => app.state.focus, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3000);
    let s = await view();
    const tab = shot("02-two-pages-no-full-screen");
    check(s.focus && !s.bars, "Two pages starts Focus: the bars are gone");
    if (start.wide) {
        check(!/on its side/.test(s.hint), "already on its side: no line asking to turn it");
    } else if (tab.wide) {
        console.log("     the screen turned by itself without full screen (not expected of Chrome in a tab; noted, not a failure)");
    } else {
        check(/on its side/.test(s.hint) && /show the controls/.test(s.hint), `upright, no full screen: a line says to turn the device and how to get the controls back ("${s.hint}")`);
    }
    check(pair(s, 0), `pages 1 and 2 whole, together in the middle (${say(s)})`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !app.state.focus, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    s = await view();
    check(!s.focus && s.bars, "Escape brings the bars back");
    await chooseView("page", false);
    await page.waitForTimeout(2500);

    // the reader's own choice: full screen comes with it, and now the screen is turned
    await chooseView("page_pair", true);
    await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3500);
    s = await view();
    const full = shot("03-two-pages-chosen");
    check(s.focus && s.fullscreen, "chosen from the menu, Two pages goes into Focus and full screen");
    check(full.wide && /^landscape/.test(s.type), `and the phone turns the screen on its side (screenshot ${full.w}x${full.h}, ${s.type})`);
    check(pair(s, 0), `pages 1 and 2 whole, together in the middle (${say(s)})`);
    check(!/on its side/.test(s.hint), `no line asking to turn the device ("${s.hint}")`);
    const drawn = await page.evaluate(() => {
        const v = document.getElementById("viewer").getBoundingClientRect();
        return [...document.querySelectorAll(".page .tile")].filter((t) => {
            const r = t.getBoundingClientRect();
            return r.right > v.left && r.left < v.right;
        }).every((t) => t.querySelector("canvas"));
    });
    check(drawn, "every page showing is drawn");

    await swipe(-0.3);
    s = await view();
    check(pair(s, 1), `a swipe left moves on one page: 2 and 3 (${say(s)})`);
    shot("04-after-swipe");
    await swipe(-0.3);
    s = await view();
    check(pair(s, 2), `another: 3 and 4 (${say(s)})`);
    await swipe(0.3);
    s = await view();
    check(pair(s, 1), `a swipe right goes back one: 2 and 3 (${say(s)})`);
    check(s.fullscreen && s.focus, "still in Focus and full screen after the swipes");

    // leaving full screen gives the screen back
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForTimeout(3500);
    s = await view();
    const after = shot("05-after-full-screen");
    check(!s.fullscreen && !s.focus && s.bars, "left full screen: out of Focus, the bars are back");
    check(after.wide === start.wide, `the screen is ${start.wide ? "on its side" : "upright"} again, as at the start (screenshot ${after.w}x${after.h}, ${s.type})`);
    check(pair(s, 1), `still pages 2 and 3 in the middle (${say(s)})`);
} catch (err) {
    failures++;
    console.log("FAIL ", String(err.message).split("\n")[0]);
} finally {
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen()).catch(() => {});
    await page.evaluate(() => screen.orientation.unlock?.()).catch(() => {});
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    cleanup();
}
console.log(failures ? `${failures} FAILED` : "Android two pages checks passed", "- phone screenshots in", outDir);
process.exit(failures ? 1 : 0);
