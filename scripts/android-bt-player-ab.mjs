// Blind A/B on the phone, over its connected Bluetooth device: PocketScore itself, playing a real score through
// the AudioWorklet player and through the buffer-source player (`?player=chunk`), in random order, three rounds
// of both. After each segment the page shows "How did it sound?" with Clean / Slight / Bad: the READER taps one
// on the phone (their own tap); the script sends no input to the phone. The variant is not shown. At the end it
// prints the ratings per variant next to the app's own gap counts and queue.
//
// Refuses to run unless Chrome is in front, the phone is awake and unlocked, and a Bluetooth device is connected.
// Never turns the screen off. Serve a build first: (cd app && npm run build && npx vite preview --host --port 4173)
// and `adb reverse tcp:4173 tcp:4173`.
//
// Usage: ADB=... SEG_SECONDS=40 ROUNDS=3 node scripts/android-bt-player-ab.mjs [score.mscz]

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
const segSecs = Number(process.env.SEG_SECONDS || 40);
const rounds = Number(process.env.ROUNDS || 3);
const outDir = path.resolve(process.env.OUT_DIR || path.join(root, "build/android-bt-ab"));
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

const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};
const order = [];
for (let r = 0; r < rounds; r++) {
    order.push(...shuffle(["worklet", "chunk"]));
}

adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];
const b64 = fs.readFileSync(scorePath).toString("base64");
const results = [];

for (let i = 0; i < order.length; i++) {
    const player = order[i];
    console.log(`segment ${i + 1} of ${order.length} ...`);
    const page = await context.newPage();
    try {
        await page.goto(url);
        await page.evaluate(() => localStorage.removeItem("pocketscore.queue"));
        await page.goto(url + (player === "chunk" ? "?player=chunk" : ""));
        await page.bringToFront();
        await page.waitForFunction(() => !!window.app?.state && document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 }).catch(() => {});
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
        const used = await page.evaluate(() => app.engine.health.filter((h) => h.kind === "player").map((h) => h.detail).join() || "(starts with the first play)");
        await page.click("#play");
        await page.waitForFunction(() => app.state.playing, null, { timeout: 60000 });
        const started = await page.evaluate(() => ({ under: app.engine.underruns, player: app.engine.health.filter((h) => h.kind === "player").map((h) => h.detail).join() }));
        const t0 = Date.now();
        await sleep(segSecs * 1000);
        const stats = await page.evaluate(() => ({ under: app.engine.underruns, target: app.engine.stats.targetSecs, load: app.engine.stats.load, out: Math.round((app.engine.ctx.outputLatency || 0) * 1000), pos: app.state.position }));
        await page.click("#play"); // pause
        // the rating prompt: the reader taps one
        await page.evaluate((n) => {
            const d = document.createElement("div");
            d.id = "ab-rate";
            d.style.cssText = "position:fixed;inset:0;z-index:99999;background:#fffffff2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;font:20px system-ui;color:#111";
            d.innerHTML = `<div style="font-weight:600">Segment ${n}: how did it sound?</div>` + ["Clean", "Slight crackle", "Bad crackle"].map((t, k) => `<button data-r="${k}" style="width:90%;padding:22px;font-size:20px;border:2px solid #345;border-radius:12px;background:#eef">${t}</button>`).join("");
            d.onclick = (e) => {
                const b = e.target.closest("button");
                if (b) {
                    window.__rating = ["clean", "slight", "bad"][+b.dataset.r];
                    d.remove();
                }
            };
            document.body.appendChild(d);
        }, i + 1);
        await page.waitForFunction(() => window.__rating, null, { timeout: 10 * 60 * 1000 });
        const rating = await page.evaluate(() => window.__rating);
        results.push({ i: i + 1, player, used: started.player || used, rating, gaps: stats.under - started.under, targetSecs: stats.target, load: stats.load, outputLatencyMs: stats.out, secs: Math.round((Date.now() - t0) / 1000) });
    } finally {
        await page.close().catch(() => {});
    }
}
await browser.close().catch(() => {});
adb("forward", "--remove", "tcp:9222");
fs.writeFileSync(path.join(outDir, "ab-results.json"), JSON.stringify(results, null, 1));
const score = { clean: 0, slight: 1, bad: 2 };
console.log("\nresults by player (the reader did not know which was which):");
for (const p of ["worklet", "chunk"]) {
    const r = results.filter((x) => x.player === p);
    console.log(`  ${p.padEnd(8)} ratings: ${r.map((x) => x.rating).join(", ")}  (score ${r.reduce((a, x) => a + score[x.rating], 0)} of ${r.length * 2}); gaps counted by the app: ${r.map((x) => x.gaps).join(", ")}`);
}
console.log("order played:", results.map((x) => `${x.i}:${x.player}=${x.rating}`).join(" "));
console.log("player seen in each segment:", [...new Set(results.map((x) => x.player + " -> " + x.used))].join(" | "));
process.exit(0);
