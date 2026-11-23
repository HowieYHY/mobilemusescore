// Finding the right Sound delay over Bluetooth, by eye and ear, on the phone. PocketScore plays a real score
// (from 12 s, no loop) in a tab of its own; a small bar at the top has "Earlier" / "Later" (50 ms a tap, the cursor and
// score shown that much earlier or later against the sound), "Zero" (back to 0) and "This is right". The READER
// taps them (their own taps; the script sends no input to the phone). It prints the delay chosen, and what
// Chrome itself reported as the output latency, so the setting's default can be judged against it.
//
// Refuses to run unless Chrome is in front, the phone is awake and unlocked, and a Bluetooth device is
// connected. Never turns the screen off. Serve a build first: (cd app && npm run build &&
// npx vite preview --host --port 4173) and `adb reverse tcp:4173 tcp:4173`.
//
// Usage: ADB=... START_MS=0 MAX_MINUTES=15 node scripts/android-bt-delay-tune.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { adb } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:4173/";
const startMs = Number(process.env.START_MS || 0);
const maxMin = Number(process.env.MAX_MINUTES || 10);
const loopFrom = Number(process.env.START_AT || 12); // seconds into the score; it plays on from there
const outDir = path.resolve(process.env.OUT_DIR || path.join(root, "build/android-bt-delay"));
fs.mkdirSync(outDir, { recursive: true });
const sh = (cmd) => adb("shell", cmd).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

adb("shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");
await sleep(1500);
if (!sh("dumpsys activity activities | grep topResumedActivity").includes("com.android.chrome")) {
    console.error("Chrome is not in front; stopping");
    process.exit(1);
}
if (!sh("dumpsys power | grep mWakefulness=").includes("Awake") || sh("dumpsys window | grep isKeyguardShowing").includes("=true")) {
    console.error("the phone is asleep or locked; stopping");
    process.exit(1);
}
const a2dp = sh("dumpsys bluetooth_manager | grep -A2 -E '^  A2DP:'").trim().replace(/\s+/g, " ");
console.log("bluetooth:", a2dp);
if (!/Connected count: [1-9]/.test(a2dp)) {
    console.error("no Bluetooth audio device is connected to the phone; stopping");
    process.exit(1);
}

adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];
const b64 = fs.readFileSync(scorePath).toString("base64");
const page = await context.newPage();
let result = null;
try {
    await page.goto(url + (process.env.PLAYER === "worklet" ? "?player=worklet" : "?player=chunk")); // the buffer player: the worklet crackles over Bluetooth on this phone
    await page.bringToFront();
    await page.waitForFunction(() => !!window.app?.state && document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 }).catch(() => {});
    const seen = await page.evaluate(() => ({ url: location.href, script: [...document.scripts].map((s) => s.src.split("/").pop()).join(), has: "soundDelayMs" in app.settings }));
    console.log("page:", JSON.stringify(seen));
    if (!seen.has) {
        console.error("this build has no Sound delay setting (an old copy is being served); stopping");
        process.exit(1);
    }
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) {
            bytes[k] = bin.charCodeAt(k);
        }
        await app.openScore(name, bytes.buffer);
    }, { name: path.basename(scorePath), b64 });
    await page.waitForSelector(".page canvas", { timeout: 120000 });
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
    await page.evaluate((ms) => { app.settings.soundDelayMs = ms; app.engine.extraLatency = ms / 1000; }, startMs);
    // the bar: the reader's own taps change the delay while the music plays; the music plays on
    await page.evaluate(() => {
        const d = document.createElement("div");
        d.id = "tune";
        d.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99999;background:#fffffff0;display:flex;gap:6px;align-items:center;justify-content:center;padding:calc(env(safe-area-inset-top,0px) + 4px) 6px 6px;font:16px system-ui;color:#111;border-bottom:2px solid #345";
        const b = (id, t) => `<button data-a="${id}" style="padding:12px 10px;font-size:16px;border:2px solid #345;border-radius:10px;background:#eef">${t}</button>`;
        d.innerHTML = b("earlier", "Earlier") + `<span id="tune-v" style="min-width:70px;text-align:center;font-weight:600"></span>` + b("later", "Later") + b("zero", "Zero") + b("done", "Right");
        const show = () => { document.getElementById("tune-v").textContent = (app.settings.soundDelayMs > 0 ? "+" : "") + app.settings.soundDelayMs + " ms"; };
        const set = (ms) => { app.settings.soundDelayMs = ms; app.engine.extraLatency = ms / 1000; show(); window.__log.push([Date.now(), ms]); };
        window.__log = [];
        d.onclick = (e) => {
            const a = e.target.closest("button")?.dataset.a;
            if (a === "earlier") set(app.settings.soundDelayMs - 50);
            else if (a === "later") set(app.settings.soundDelayMs + 50);
            else if (a === "zero") set(0);
            else if (a === "done") window.__done = app.settings.soundDelayMs;
        };
        document.body.appendChild(d);
        show();
        // no jumps back: a seek restarts the sound, which is what the reader is judging
    });
    await page.evaluate((t) => app.engine.seek(t), loopFrom);
    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 60000 });
    console.log(`playing; the reader taps Earlier / Later until cursor and sound agree, then Right (up to ${maxMin} min)`);
    await page.waitForFunction(() => window.__done !== undefined, null, { timeout: maxMin * 60 * 1000, polling: 500 });
    result = await page.evaluate(() => ({
        chosenMs: window.__done,
        taps: window.__log.length,
        outputLatencyMs: Math.round((app.engine.ctx.outputLatency || 0) * 1000),
        baseLatencyMs: Math.round((app.engine.ctx.baseLatency || 0) * 1000),
        queueMs: Math.round(app.engine.stats.targetSecs * 1000),
        gaps: app.engine.underruns,
    }));
    await page.click("#play").catch(() => {}); // pause
} finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    adb("forward", "--remove", "tcp:9222");
}
if (result) {
    fs.writeFileSync(path.join(outDir, "delay-result.json"), JSON.stringify(result, null, 1));
    console.log("chosen:", JSON.stringify(result));
}
process.exit(0);
