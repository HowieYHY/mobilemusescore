// Settings (the gear in the top bar). Checks, at phone, iPad and desktop sizes:
//   - the gear is on the start screen, the panel opens below the top bar, fits between the bars,
//     closes with Done, the gear and the phone's Back, and shows the defaults (today's behaviour),
//   - each switch and choice is kept after a reload; a setting that needs another is greyed out,
//   - the tour has a Settings step,
// then, on one size, what each setting does:
//   - Keep playing: leaving the app pauses by default, keeps playing when on,
//   - Metronome on when a score opens: unmuted, and Save stays dark,
//   - Tap a note to hear it: off, a tap moves without sounding the note,
//   - Start focus by itself: off never starts; on, after the chosen wait,
//   - Open scores in: every view,
//   - Follow the music: off, the view stays put while the music plays,
//   - Keep the screen on: the screen lock is asked for while playing and let go on pause,
// and with every score in "real test musescores", each view as the opening view. Screenshots in
// build/settings.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/settings-test.mjs [folder or score]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const arg = path.resolve(process.argv[2] || path.join(root, "real test musescores"));
const scores = fs.statSync(arg).isDirectory()
    ? fs.readdirSync(arg).filter((f) => /\.mscz$/i.test(f)).map((f) => path.join(arg, f))
    : [arg];
const main = scores.find((s) => /I am move it/.test(s)) || scores[0];
const url = process.env.APP_URL || "http://localhost:5180/";
const outDir = path.join(root, "build/settings");
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

const browser = await chromium.launch();

// The screen lock, recorded (headless Chromium has none to give)
const fakeWakeLock = () => {
    window.__wakeLocks = { asked: 0, held: 0 };
    Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
            request: async () => {
                window.__wakeLocks.asked++;
                window.__wakeLocks.held++;
                const handlers = [];
                return {
                    addEventListener: (_t, f) => handlers.push(f),
                    release: async () => { window.__wakeLocks.held--; handlers.forEach((f) => f()); },
                };
            },
        },
    });
};

async function newPage(width, height, touch) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch });
    await context.addInitScript(fakeWakeLock);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("page error:", e.message));
    return { context, page };
}

const ready = (page) => page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });

// Opens a score and waits for it: the last score's state still says ready, so its pages are marked
// and the ready flag lowered first (opening lowers it too), and only new pages and a new ready count
async function openScore(page, file) {
    await page.evaluate(() => {
        app.state.pageEls.forEach((el) => (el.dataset.old = "1"));
        app.state.playbackReady = false;
    });
    await page.setInputFiles("#file-input", file);
    await page.waitForFunction(() => app.state.playbackReady && app.state.pageEls.length > 0
        && !app.state.pageEls[0].dataset.old && document.querySelector(".page canvas"), null, { timeout: 180000 });
}

const setSetting = (page, k, v) => page.evaluate(([k, v]) => {
    const el = document.querySelector(`[data-set="${k}"]`);
    if (el.type === "checkbox") el.checked = v; else el.value = String(v);
    el.dispatchEvent(new Event("change"));
}, [k, v]);

// ---------------------------------------------------------------- the panel, at every size

const sizes = [
    ["phone", 390, 844, true],
    ["ipad-air", 820, 1180, true],
    ["desktop", 1280, 800, false],
];
for (const [name, width, height, touch] of sizes) {
    const { context, page } = await newPage(width, height, touch);
    const tap = async (sel) => (touch ? page.tap(sel) : page.click(sel));
    await page.goto(url);
    await ready(page);
    check(await page.isVisible("#settings-open"), `${name}: the gear is on the start screen`);
    await tap("#settings-open");
    await page.waitForSelector("#settings:not([hidden])");
    await page.waitForTimeout(300);
    const box = await page.evaluate(() => {
        const r = document.getElementById("settings").getBoundingClientRect();
        const top = document.querySelector(".topbar").getBoundingClientRect();
        const bottom = document.getElementById("transport").getBoundingClientRect();
        const body = document.querySelector(".settings-body");
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, barBottom: top.bottom, transportTop: bottom.top,
            scrolls: body.scrollHeight > body.clientHeight, overflowX: document.documentElement.scrollWidth > innerWidth };
    });
    // phones: a page of its own over the whole screen, left with Back; wider screens: a panel
    // between the bars, closed with Done
    const phone = width <= 600;
    const closeSel = phone ? "#settings-back" : "#settings-close";
    if (phone) {
        const covers = await page.evaluate(() => ["#play", "#seek", "#score-title", "#viewer"].every((sel) => {
            const r = document.querySelector(sel).getBoundingClientRect();
            const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
            return !!hit?.closest("#settings");
        }));
        check(box.top <= 0.5 && Math.abs(box.bottom - height) < 1.5 && covers, `${name}: Settings is a page of its own, over the whole screen (${Math.round(box.top)}-${Math.round(box.bottom)}; score, playback and top bar hidden: ${covers})`);
        check(await page.isVisible("#settings-back") && !(await page.isVisible("#settings-close")), `${name}: with Back at the top, no Done`);
    } else {
        check(Math.abs(box.top - box.barBottom) < 1.5, `${name}: the panel hangs from the top bar (${Math.round(box.top)} vs ${Math.round(box.barBottom)})`);
        check(box.scrolls ? Math.abs(box.bottom - box.transportTop) < 1.5 : box.bottom <= box.transportTop + 0.5,
            `${name}: and ${box.scrolls ? "reaches the bottom bar, no gap" : "stops above the bottom bar"} (${Math.round(box.bottom)} vs ${Math.round(box.transportTop)})`);
    }
    check(box.left >= 0 && box.right <= width && !box.overflowX, `${name}: within the screen's width`);
    const defaults = await page.evaluate(() => [...document.querySelectorAll("[data-set]")].map((el) =>
        `${el.dataset.set}=${el.type === "checkbox" ? el.checked : el.value}`).join(" "));
    check(defaults === "keepPlaying=false metronomeOn=false tapToHear=true autoFocus=true focusPlayingSecs=4 focusStoppedSecs=10 focusFullscreen=true startView=page follow=true keepAwake=false",
        `${name}: defaults are today's behaviour (${defaults})`);
    // every control is reachable: scroll to the last one and check it's on screen
    const last = page.locator('[data-set="keepAwake"]');
    await last.scrollIntoViewIfNeeded();
    const lb = await last.boundingBox();
    check(lb && lb.y >= box.top && lb.y + lb.height <= box.bottom + 0.5, `${name}: the last setting can be reached${box.scrolls ? " (by scrolling)" : ""}`);
    await page.evaluate(() => (document.querySelector(".settings-body").scrollTop = 0));
    await page.screenshot({ path: path.join(outDir, `${name}-panel.png`) });

    // The status bar's room changing (Android: padding on the top bar, which reports no new size by
    // itself) must not leave a gap: once while closed, once while open
    const gapAfter = async (safeTop) => {
        await page.evaluate((v) => document.documentElement.style.setProperty("--safe-t", v), safeTop);
        await page.waitForTimeout(250);
        return page.evaluate(() => {
            const r = document.getElementById("settings").getBoundingClientRect();
            return { top: r.top - document.querySelector(".topbar").getBoundingClientRect().bottom,
                bottom: document.getElementById("transport").getBoundingClientRect().top - r.bottom };
        });
    };
    const whileOpen = await gapAfter("59px");
    if (phone) {
        // the page's header makes room for the status bar
        const head = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("#settings .mixer-head")).paddingTop));
        check(head >= 59, `${name}: the page's header makes room for the status bar (padding ${head} px)`);
    } else {
        check(Math.abs(whileOpen.top) < 1.5, `${name}: the status bar's room growing while open: still under the top bar (gap ${whileOpen.top.toFixed(1)})`);
    }
    await tap(closeSel);
    await page.waitForTimeout(350);
    await page.evaluate(() => document.documentElement.style.setProperty("--safe-t", "0px"));
    await page.waitForTimeout(250);
    await tap("#settings-open");
    await page.waitForTimeout(350);
    const reopened = await gapAfter("0px");
    if (!phone) {
        check(Math.abs(reopened.top) < 1.5 && (!box.scrolls || Math.abs(reopened.bottom) < 1.5),
            `${name}: and after it shrank while closed (gaps ${reopened.top.toFixed(1)} top, ${reopened.bottom.toFixed(1)} bottom)`);
    }
    await page.evaluate(() => document.documentElement.style.removeProperty("--safe-t"));
    await page.waitForTimeout(250);

    // a tap on a row flips its switch
    await (touch ? page.tap(".set-row:has([data-set=keepPlaying]) .set-name") : page.click(".set-row:has([data-set=keepPlaying]) .set-name"));
    check(await page.evaluate(() => app.settings.keepPlaying), `${name}: tapping a row's name turns it on`);
    // a setting needing another is greyed out without it
    await setSetting(page, "autoFocus", false);
    check(await page.evaluate(() => document.querySelector('[data-set="focusPlayingSecs"]').disabled
        && document.querySelector('[data-set="focusStoppedSecs"]').disabled), `${name}: the waits are greyed out without Start focus by itself`);
    await page.screenshot({ path: path.join(outDir, `${name}-panel-changed.png`) });
    await setSetting(page, "autoFocus", true);
    await setSetting(page, "startView", "page_turn");

    // closes with Done (phones: Back at the top), with the gear (not on phones: the page covers it), with the phone's Back
    await tap(closeSel);
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.getElementById("settings").hidden), `${name}: ${phone ? "Back at the top" : "Done"} closes it`);
    if (!phone) {
        await tap("#settings-open");
        await page.waitForTimeout(300);
        await tap("#settings-open");
        await page.waitForTimeout(400);
        check(await page.evaluate(() => document.getElementById("settings").hidden), `${name}: the gear closes it again`);
    }
    await tap("#settings-open");
    await page.waitForTimeout(300);
    await page.goBack();
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.getElementById("settings").hidden && location.href.startsWith("http")), `${name}: Back closes it and stays in the app`);

    // kept after a reload
    await page.reload();
    await ready(page);
    const kept = await page.evaluate(() => [app.settings.keepPlaying, app.settings.startView]);
    check(kept[0] === true && kept[1] === "page_turn", `${name}: kept after a reload (${kept})`);

    // with a score open: the panel is one panel at a time with the mixer
    await page.evaluate(() => localStorage.removeItem("pocketscore.settings"));
    await page.reload();
    await ready(page);
    await openScore(page, main);
    await tap("#mixer-toggle");
    await page.waitForSelector("#mixer:not([hidden])");
    await tap("#settings-open");
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.getElementById("mixer").hidden && !document.getElementById("settings").hidden), `${name}: opening Settings closes the mixer`);
    await page.screenshot({ path: path.join(outDir, `${name}-panel-score.png`) });
    await page.goBack();
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.getElementById("settings").hidden && document.getElementById("mixer").hidden), `${name}: and Back then closes Settings`);

    // the tour has a Settings step
    await tap("#help");
    await page.waitForSelector("#tour:not([hidden])");
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
        found = /settings/i.test(await page.textContent("#tour-title"));
        if (!found) {
            if (!(await page.isVisible(".tour-next"))) break;
            await page.click(".tour-next");
            await page.waitForTimeout(150);
        }
    }
    check(found, `${name}: the tour has a Settings step`);
    await context.close();
}

// ---------------------------------------------------------------- what each setting does

{
    const { context, page } = await newPage(390, 844, true);
    await page.goto(url);
    await ready(page);
    await openScore(page, main);
    const hide = (hidden) => page.evaluate((hidden) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
    const play = async () => {
        await page.evaluate(() => app.engine.play());
        await page.waitForFunction(() => app.state.playing, null, { timeout: 20000 });
    };
    const pause = async () => {
        await page.evaluate(() => app.engine.pause());
        await page.waitForFunction(() => !app.state.playing, null, { timeout: 20000 });
    };

    // Keep playing
    await setSetting(page, "keepPlaying", false);
    await play();
    await hide(true);
    await page.waitForTimeout(800);
    check(!(await page.evaluate(() => app.state.playing)), "keep playing off: leaving the app pauses");
    await hide(false);
    await setSetting(page, "keepPlaying", true);
    await play();
    await hide(true);
    await page.waitForTimeout(1500);
    check(await page.evaluate(() => app.state.playing), "keep playing on: the music goes on while away");
    await hide(false);
    await pause();

    // Keep the screen on
    await setSetting(page, "keepAwake", true);
    await play();
    await page.waitForTimeout(300);
    const held = await page.evaluate(() => ({ ...window.__wakeLocks }));
    await pause();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ ...window.__wakeLocks }));
    check(held.held === 1 && after.held === 0, `keep the screen on: held while playing (${held.held}), let go on pause (${after.held})`);
    await setSetting(page, "keepAwake", false);
    await play();
    await page.waitForTimeout(300);
    check((await page.evaluate(() => window.__wakeLocks.asked)) === after.asked, "keep the screen on off: not asked for");
    await pause();

    // Tap a note to hear it
    await page.evaluate(() => {
        const orig = app.engine.seekAt.bind(app.engine);
        window.__seekAt = [];
        app.engine.seekAt = (...a) => { window.__seekAt.push(a[4]); return orig(...a); };
    });
    const tapNote = async () => {
        const pt = await page.evaluate(async () => {
            const tl = await app.engine.timeline();
            const [, pg, x, y, h] = tl[2];
            const r = document.querySelector(`.page[data-index="${pg}"]`).getBoundingClientRect();
            const k = (96 * app.state.zoom) / 1200;
            return { x: r.left + (x + 50) * k, y: r.top + (y + h / 2) * k };
        });
        await page.evaluate(() => document.querySelector(".viewer").scrollTo(0, 0));
        await page.touchscreen.tap(pt.x, pt.y);
        await page.waitForTimeout(400);
    };
    await tapNote();
    await setSetting(page, "tapToHear", false);
    await tapNote();
    const plays = await page.evaluate(() => window.__seekAt);
    check(plays.length === 2 && plays[0] === true && plays[1] === false, `tap a note to hear it: sounds when on, not when off (${plays})`);
    await setSetting(page, "tapToHear", true);

    // Start focus by itself
    await page.evaluate(() => (app.testAutoFocus = true));
    await setSetting(page, "autoFocus", false);
    await page.mouse.move(5, 300);
    await page.waitForTimeout(11000);
    check(!(await page.evaluate(() => app.state.focus)), "start focus by itself off: no focus after 11 s stopped");
    await setSetting(page, "autoFocus", true);
    await setSetting(page, "focusStoppedSecs", 5);
    const t0 = Date.now();
    await page.waitForFunction(() => app.state.focus, null, { timeout: 15000 }).catch(() => {});
    const waited = (Date.now() - t0) / 1000;
    check(waited > 4 && waited < 7.5, `start focus by itself: after the chosen 5 s stopped (${waited.toFixed(1)} s)`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await page.evaluate(() => (app.testAutoFocus = false));

    // Follow the music: off, the view stays where it is. From just before page 2, which starts
    // below the screen, for long enough to reach it.
    const page2 = await page.evaluate(async () => (await app.engine.timeline()).find((p) => p[1] === 1)[0]);
    const runFrom = async (follow) => {
        await setSetting(page, "follow", follow);
        await page.evaluate((s) => app.engine.seek(s), Math.max(0, page2 - 1.5));
        await page.evaluate(() => document.querySelector(".viewer").scrollTo(0, 0));
        await page.waitForTimeout(400);
        await play();
        await page.waitForTimeout(4000);
        const r = await page.evaluate(() => ({ top: document.querySelector(".viewer").scrollTop, page: app.cursorAt(app.state.position)?.page }));
        await pause();
        return r;
    };
    const stayed = await runFrom(false);
    const moved = await runFrom(true);
    check(stayed.page === 1 && stayed.top === 0 && moved.page === 1 && moved.top > 0,
        `follow the music: with the music on page 2, off stays (${stayed.top}), on follows (${Math.round(moved.top)})`);


    await context.close();
}

// ---------------------------------------------------------------- opening: metronome and views, every score

{
    const { context, page } = await newPage(390, 844, true);
    await page.goto(url);
    await ready(page);
    await setSetting(page, "metronomeOn", true);
    for (const file of scores) {
        const short = path.basename(file).slice(0, 24);
        for (const view of ["page", "page_turn", "continuous_h", "continuous_v"]) {
            await setSetting(page, "startView", view);
            await openScore(page, file);
            await page.waitForTimeout(300);
            const got = await page.evaluate(() => ({
                view: document.getElementById("view-mode").value,
                turn: document.body.classList.contains("page-turn"),
                pages: app.state.pageEls.length,
                drawn: document.querySelectorAll(".page canvas").length,
                metronome: app.state.tracks.find((t) => t.metronome)?.mute,
                save: document.getElementById("save").disabled,
                position: app.state.position,
            }));
            const engineOk = view.startsWith("continuous") ? got.pages === 1 : got.pages >= 1;
            check(got.view === view && got.turn === (view === "page_turn") && engineOk && got.drawn > 0,
                `${short}: opens in ${view} (${got.pages} page(s), ${got.drawn} drawn)`);
            if (view === "page") {
                check(got.metronome === false && got.save, `${short}: metronome on when it opens, Save stays dark`);
                await page.screenshot({ path: path.join(outDir, `open-${short.replace(/[^\w]+/g, "_")}.png`) });
            }
        }
    }
    await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
