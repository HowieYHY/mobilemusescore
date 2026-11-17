// Real Bluetooth, long run: play for a long time over the phone's connected Bluetooth device and catch
// every sound gap with what the phone was doing at that moment (CPU, memory, swap, heat, who was using the
// CPU). Optionally adds deliberate load on the phone in stages, to find how much it takes to break the sound.
//
//   SOAK (default): one stage with no extra load, STAGE_SECONDS long.
//   LOAD=0,2,4,8: stages with that many CPU burners running on the phone (adb shell busy loops), one stage
//   each, STAGE_SECONDS long. The burners are started and killed by this script (their pids are kept; they are
//   killed in a `finally`, and again by name, and checked gone). It stops a stage at once if the phone gets hot
//   (thermal status 3+, or battery above 43 C).
//
// Sends no taps and no input to the phone: the page is driven over DevTools; Chrome is brought forward with
// `am start` only. Refuses to run unless Chrome is in front, the screen is on and unlocked, and a Bluetooth
// device is connected (BT=0 for the speaker). Never turns the screen off.
//
// Usage: ADB=... APP_URL=http://localhost:4173/ STAGE_SECONDS=600 [LOAD=0,2,4,8] [THROTTLE=1]
//        node scripts/android-bt-soak.mjs <score.mscz> [outDir]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { adb } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const outDir = path.resolve(process.argv[3] || path.join(root, "build/android-bt-soak"));
const url = process.env.APP_URL || "http://localhost:4173/";
const stageSecs = Number(process.env.STAGE_SECONDS || 600);
const stages = (process.env.LOAD || "0").split(",").map(Number);
const throttle = Number(process.env.THROTTLE || 1);
const needBt = process.env.BT !== "0";
fs.mkdirSync(outDir, { recursive: true });
const sh = (cmd) => adb("shell", cmd).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- safety, as in android-bt-earlyplay-test.mjs
adb("shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");
await sleep(1500);
const top = sh("dumpsys activity activities | grep topResumedActivity");
if (!top.includes("com.android.chrome")) {
    console.error("Chrome is not in front; stopping:", top.trim());
    process.exit(1);
}
if (!sh("dumpsys power | grep mWakefulness=").includes("Awake") || sh("dumpsys window | grep isKeyguardShowing").includes("=true")) {
    console.error("the phone is asleep or locked; stopping");
    process.exit(1);
}
const a2dp = sh("dumpsys bluetooth_manager | grep -A2 -E '^  A2DP:'").trim().replace(/\s+/g, " ");
console.log("bluetooth:", a2dp);
if (needBt && !/Connected count: [1-9]/.test(a2dp)) {
    console.error("no Bluetooth audio device is connected to the phone; stopping");
    process.exit(1);
}

// ---- what the phone is doing
function phoneState() {
    const mem = sh("cat /proc/meminfo");
    const kb = (k) => Number(new RegExp(k + ":\\s+(\\d+)").exec(mem)?.[1] || 0);
    const load = sh("cat /proc/loadavg").split(" ").slice(0, 3).join(" ");
    const batt = sh("dumpsys battery");
    const temp = Number(/temperature: (\d+)/.exec(batt)?.[1] || 0) / 10;
    const thermal = Number(/Thermal Status: (\d+)/.exec(sh("dumpsys thermalservice | grep 'Thermal Status'"))?.[1] ?? -1);
    return { availMB: Math.round(kb("MemAvailable") / 1024), swapFreeMB: Math.round(kb("SwapFree") / 1024), load, battTempC: temp, thermal };
}
function topProcs() {
    // the busiest processes right now (one snapshot; the burners are named so they are easy to tell apart)
    const out = sh("top -b -n 1 -m 6 -o PID,%CPU,ARGS 2>/dev/null || top -b -n 1 -m 6");
    return out.split("\n").filter((l) => /^\s*\d+\s/.test(l)).slice(0, 6).map((l) => l.trim().replace(/\s+/g, " ").slice(0, 90));
}

// ---- deliberate load: busy loops owned by the shell user, named so they can be found and killed
const burnerPids = [];
function startBurners(n) {
    for (let i = 0; i < n; i++) {
        // `exec -a` is not in toybox sh; the marker is the command line itself
        // a dead-man switch: `timeout` ends it by itself even if this script dies
        const pid = sh(`nohup timeout ${stageSecs + 90} sh -c 'while :; do :; done # pocketscore-burner' >/dev/null 2>&1 & echo $!`).trim();
        if (/^\d+$/.test(pid)) {
            burnerPids.push(pid);
        }
    }
}
function killBurners() {
    for (const pid of burnerPids.splice(0)) {
        try {
            sh(`kill -9 ${pid}`);
        } catch {
            // already gone
        }
    }
    // any left (by their command line), then check
    try {
        sh("pkill -9 -f pocketscore-burner");
    } catch {
        // none
    }
}
const burnersLeft = () => {
    try {
        return sh("pgrep -f pocketscore-burner").trim().split("\n").filter((x) => /^\d+$/.test(x.trim())).length;
    } catch {
        return 0;
    }
};

console.log("device:", sh("getprop ro.product.model").trim(), `| stages (burners): ${stages.join(", ")}, ${stageSecs} s each, CPU throttle ${throttle}x`);
console.log("phone at start:", JSON.stringify(phoneState()));

adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];
const page = await context.newPage();
const summary = [];
try {
    if (throttle > 1) {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    await page.goto(url);
    await page.evaluate(() => localStorage.removeItem("pocketscore.queue"));
    await page.goto(url);
    await page.waitForFunction(() => !!window.app?.state && document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 }).catch(() => {});
    const b64 = fs.readFileSync(scorePath).toString("base64");
    await page.evaluate(async ({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        await app.openScore(name, bytes.buffer);
    }, { name: path.basename(scorePath), b64 });
    await page.waitForSelector(".page canvas", { timeout: 120000 });
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
    console.log("build:", await page.evaluate(() => document.querySelector(".version, #version")?.textContent ?? "?"));

    // in-page watcher: every second, plus a restart when the score ends (page code, no taps)
    await page.evaluate(() => {
        const w = (window.__soak = { rows: [], gaps: [], stop: false, restarts: 0, lastUnder: app.engine.underruns });
        const t0 = performance.now();
        const tick = () => {
            const e = app.engine, c = e.ctx;
            const now = performance.now();
            if (e.underruns > w.lastUnder) {
                w.gaps.push({ t: Math.round(now - t0), n: e.underruns, queued: +(e.stats.queuedSecs ?? 0).toFixed(3), target: +(e.stats.targetSecs ?? 0).toFixed(3), health: e.health.slice(-3).map((h) => `${h.kind}: ${h.detail}`) });
                w.lastUnder = e.underruns;
            }
            w.rows.push([Math.round(now - t0), e.underruns, c ? +c.currentTime.toFixed(2) : null, c ? Math.round(c.outputLatency * 1000) : null, +(e.stats.queuedSecs ?? 0).toFixed(3), +e.level.toFixed(3), c?.state]);
            if (!app.state.playing && app.state.position >= app.state.duration - 0.5 && app.state.duration > 0) {
                w.restarts++;
                void app.engine.seek(0).then(() => app.engine.play());
            }
            if (!w.stop) {
                setTimeout(tick, 1000);
            }
        };
        tick();
    });
    await page.click("#play"); // the one tap, in the page
    await page.waitForFunction(() => app.state.playing, null, { timeout: 30000 });

    for (const burners of stages) {
        const start0 = await page.evaluate(() => ({ under: app.engine.underruns, rows: window.__soak.rows.length, gaps: window.__soak.gaps.length }));
        if (burners > 0) {
            startBurners(burners);
        }
        console.log(`\nstage: ${burners} burner(s) for ${stageSecs} s; started ${burnerPids.length} (${burnerPids.join(",")})`);
        const stageStart = Date.now();
        let hot = false;
        const samples = [];
        while (Date.now() - stageStart < stageSecs * 1000) {
            await sleep(Math.min(10000, stageSecs * 1000 - (Date.now() - stageStart)));
            const ps = phoneState();
            samples.push(ps);
            if (ps.thermal >= 3 || ps.battTempC > 43) {
                hot = true;
                console.log("phone too hot, ending the stage early:", JSON.stringify(ps));
                break;
            }
            const g = await page.evaluate((k) => window.__soak.gaps.length - k, start0.gaps);
            // note the phone's state at the moment a new gap shows up
            if (g > (samples.reportedGaps || 0)) {
                samples.reportedGaps = g;
                console.log(`  gap ${g} in this stage; phone: ${JSON.stringify(ps)}`);
                console.log("   busiest:", topProcs().join(" | "));
            }
        }
        const gapsNow = await page.evaluate((k) => ({ under: app.engine.underruns - k.under, gaps: window.__soak.gaps.slice(k.gaps), restarts: window.__soak.restarts, rows: window.__soak.rows.slice(k.rows) }), start0);
        const busiest = topProcs();
        killBurners();
        await sleep(500);
        const left = burnersLeft();
        const mem = samples.map((s) => s.availMB);
        const sw = samples.map((s) => s.swapFreeMB);
        const queueMax = Math.max(...gapsNow.rows.map((r) => r[4]), 0);
        const outs = gapsNow.rows.map((r) => r[3]).filter((v) => v !== null && v > 0);
        const stage = {
            burners, seconds: Math.round((Date.now() - stageStart) / 1000), gaps: gapsNow.under, hot, burnersLeft: left,
            memAvailMB: mem.length ? `${Math.min(...mem)}-${Math.max(...mem)}` : "?", swapFreeMB: sw.length ? `${Math.min(...sw)}-${Math.max(...sw)}` : "?",
            outputLatencyMs: outs.length ? `${Math.min(...outs)}-${Math.max(...outs)}` : "?", maxBattTempC: Math.max(...samples.map((s) => s.battTempC), 0),
            silentSeconds: gapsNow.rows.filter((r) => r[5] === 0).length, ctxStates: [...new Set(gapsNow.rows.map((r) => r[6]))].join("/"),
            gapDetails: gapsNow.gaps, busiestEnd: busiest,
        };
        summary.push(stage);
        console.log(`stage done: ${stage.burners} burners, ${stage.seconds} s: ${stage.gaps} gap(s); available memory ${stage.memAvailMB} MB, swap free ${stage.swapFreeMB} MB; output latency ${stage.outputLatencyMs} ms; max battery temp ${stage.maxBattTempC} C; burners left after kill: ${left}`);
        for (const g of stage.gapDetails) {
            console.log(`   gap at ${g.t} ms: queue ${g.queued} (target now ${g.target}); ${g.health.join(" / ")}`);
        }
        if (left > 0) {
            console.error("burners still running; stopping");
            break;
        }
        if (hot) {
            break;
        }
        await sleep(15000); // let it cool and settle between stages
    }
} finally {
    killBurners();
    await page.evaluate(() => { window.__soak.stop = true; app.engine.pause(); }).catch(() => {});
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.writeFileSync(path.join(outDir, "soak-summary.json"), JSON.stringify(summary, null, 1));
    console.log("\nburners left:", burnersLeft(), "| bluetooth now:", sh("dumpsys bluetooth_manager | grep -A2 -E '^  A2DP:'").trim().replace(/\s+/g, " "));
    console.log("phone at end:", JSON.stringify(phoneState()));
}
process.exit(0);
