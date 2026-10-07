// Drives the web app in a real browser engine (Playwright): opens a score
// through the file picker, screenshots page 1 next to MuseScore's own
// thumbnail of it, starts playback and checks the cursor moves, then
// exercises the mixer.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/browser-test.mjs <score.mscz> [chromium|webkit] [outDir]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const playwright = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescore files/I am move it edited.mscz"));
const browserName = process.argv[3] || "chromium";
const outDir = path.resolve(process.argv[4] || path.join(root, "build/browser", browserName));
const url = process.env.APP_URL || "http://localhost:5180/";
fs.mkdirSync(outDir, { recursive: true });

const browser = await playwright[browserName].launch({
    args: browserName === "chromium" ? ["--autoplay-policy=no-user-gesture-required"] : [],
});
const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2 }); // iPad-sized
const page = await context.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

let failures = 0;
const fail = (msg) => {
    console.error("FAIL:", msg);
    failures++;
};

try {
    let t0 = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 });
    console.log(`engine ready in ${Date.now() - t0} ms`);

    t0 = Date.now();
    await page.setInputFiles("#file-input", scorePath);
    await page.waitForSelector(".page canvas", { timeout: 120000 });
    await page.waitForTimeout(800); // fonts
    console.log(`score opened and page 1 drawn in ${Date.now() - t0} ms`);
    const info = await page.evaluate(() => ({ pages: app.state.score.pages.length, title: document.getElementById("score-title").textContent }));
    console.log(`title "${info.title}", ${info.pages} pages`);

    // Every page must actually have something drawn on it
    const blank = await page.evaluate(async () => {
        const mod = await import("/src/render/pagerenderer.ts");
        const empty = [];
        for (let i = 0; i < app.state.score.pages.length; i++) {
            const ops = JSON.parse(await app.engine.page(i));
            await mod.ensureFonts(ops, app.engine.base);
            await mod.ensureImages(ops);
            const c = document.createElement("canvas");
            c.width = 300;
            c.height = 400;
            const g = c.getContext("2d");
            g.fillStyle = "#fff";
            g.fillRect(0, 0, 300, 400);
            mod.drawPage(g, ops, 300 / app.state.score.pages[i].w);
            const px = g.getImageData(0, 0, 300, 400).data;
            let ink = 0;
            for (let k = 0; k < px.length; k += 4) {
                if (px[k] < 200) {
                    ink++;
                }
            }
            if (ink < 50) {
                empty.push(i + 1);
            }
        }
        return empty;
    });
    if (blank.length) {
        fail(`blank page(s): ${blank.join(", ")}`);
    } else {
        console.log(`all ${info.pages} pages have content`);
    }

    const page1 = page.locator(".page").first();
    await page1.screenshot({ path: path.join(outDir, "page1.png") });

    // MuseScore's own thumbnail of page 1, for comparison
    const { execFileSync } = await import("node:child_process");
    try {
        const thumb = execFileSync("python", ["-c",
            "import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('Thumbnails/thumbnail.png'))", scorePath]);
        fs.writeFileSync(path.join(outDir, "musescore-thumbnail.png"), thumb);
    } catch (e) {
        console.log("(no thumbnail in score)");
    }

    // Playwright's WebKit for Windows ships without Web Audio; real Safari has it.
    const hasAudio = await page.evaluate(() => typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined");
    if (!hasAudio) {
        console.log(`NOTE: this ${browserName} build has no Web Audio; audio checks skipped (must be checked on a real device).`);
        await page.screenshot({ path: path.join(outDir, "viewer.png") });
        throw { skipped: true };
    }

    // Play
    t0 = Date.now();
    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 120000 }).catch(() => fail("playback did not start"));
    console.log(`playing after ${Date.now() - t0} ms (includes loading MS Basic)`);
    // Compare the score position with the audio hardware clock: they must
    // advance together (otherwise playback is too fast or too slow).
    await page.waitForTimeout(1000);
    const a = await page.evaluate(() => ({ pos: app.state.position, clock: app.engine.ctx.currentTime, wall: performance.now(), rate: app.engine.ctx.sampleRate }));
    await page.waitForTimeout(8000);
    const b = await page.evaluate(() => ({ pos: app.state.position, clock: app.engine.ctx.currentTime, wall: performance.now() }));
    const dPos = b.pos - a.pos;
    const dClock = b.clock - a.clock;
    const dWall = (b.wall - a.wall) / 1000;
    console.log(`over ${dWall.toFixed(2)} s wall time: audio clock +${dClock.toFixed(2)} s, score position +${dPos.toFixed(2)} s (sample rate ${a.rate})`);
    if (Math.abs(dPos - dClock) > 0.25) {
        fail("score position drifts from the audio clock");
    }
    const cursorBox = await page.locator(".cursor").boundingBox();
    if (!cursorBox) {
        fail("no playback cursor on the page");
    }
    await page.screenshot({ path: path.join(outDir, "playing.png") });

    // Mixer
    await page.click("#mixer-toggle");
    await page.waitForSelector(".strip:not(.master)");
    const strips = await page.locator(".strip:not(.master) .name").allTextContents();
    console.log("mixer strips:", strips.join(" | "));
    await page.locator(".strip:not(.master) .toggle.s").first().click();
    await page.waitForTimeout(300);
    const forced = await page.locator(".strip.forced").count();
    console.log(`solo on first part -> ${forced} other strips force-muted`);
    if (forced < 1) {
        fail("solo did not force-mute the other parts");
    }
    await page.screenshot({ path: path.join(outDir, "mixer.png") });
    await page.locator(".strip:not(.master) .toggle.s").first().click();

    // Pause and seek
    await page.click("#play");
    await page.waitForFunction(() => !app.state.playing, null, { timeout: 5000 }).catch(() => fail("pause did not stop playback"));
    await page.evaluate(() => app.engine.seek(60));
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ pos: app.state.position, bar: document.getElementById("bar").textContent }));
    console.log(`after seek to 60 s: position ${after.pos.toFixed(1)} s, ${after.bar}`);
    if (Math.abs(after.pos - 60) > 0.5) {
        fail("seek did not move the position");
    }

    // Tap a spot on page 1 (second system, middle) and expect playback to move there
    await page.click("#mixer-close");
    const direct = await page.evaluate(() => app.engine.seekAt(0, 6000, 8000));
    console.log("engine seekAt(page 1, middle):", JSON.stringify(direct));
    await page.evaluate(() => app.engine.seek(60));
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById("viewer").scrollTo(0, 0));
    const box = await page.locator(".page").first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.62);
    await page.waitForTimeout(500);
    const tapped = await page.evaluate(() => ({ pos: app.state.position, bar: document.getElementById("bar").textContent }));
    console.log(`after tapping page 1: position ${tapped.pos.toFixed(1)} s, ${tapped.bar}`);
    if (!(tapped.pos > 0 && tapped.pos < 30)) {
        fail("tapping the score did not move playback to that spot");
    }
} catch (e) {
    if (!e || !e.skipped) {
        fail(e.message);
    }
} finally {
    fs.writeFileSync(path.join(outDir, "console.log"), logs.join("\n"));
    const errors = logs.filter((l) => /error|pageerror/i.test(l));
    if (errors.length) {
        console.log("console errors:\n  " + errors.slice(0, 10).join("\n  "));
    }
    await browser.close();
}

console.log(failures ? `${failures} check(s) FAILED` : "all browser checks passed");
process.exit(failures ? 1 : 0);
