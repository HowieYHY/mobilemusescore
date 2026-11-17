// Real Bluetooth: the reader opens a score and taps Play at once, while the instrument sounds are still
// loading. Records everything from the moment of the tap (the older android-test.mjs started counting 2 s
// after play began, so the first seconds were never measured): sound gaps, the engine's health notes, the
// queue, output latency, the sound level actually played, long frames, and when playback really started.
//
// Each round is a fresh tab (cold app, sounds loaded from the service worker's cache or the network).
// Does not tap anything on the phone: it drives the page over DevTools. Chrome is brought forward with
// `am start` only. Refuses to run unless Chrome is in front, the screen is on and unlocked, and the
// connected audio output is Bluetooth (BT=0 to allow the phone speaker, for a comparison run).
//
// Usage: ADB=... APP_URL=http://localhost:4173/ ROUNDS=3 WATCH_SECONDS=40 [THROTTLE=4] [WARM=1]
//        node scripts/android-bt-earlyplay-test.mjs <score.mscz> [outDir]
// THROTTLE=N slows the page's CPU N times (CDP), imitating a weaker phone.
// KEEP_QUEUE=1 keeps the remembered sound queue between rounds (default: forgotten, a first visit).
// ALTERNATE=1: odd rounds tap at once, even rounds wait (a fair comparison in one run).
// WARM=1 waits for the sounds before tapping Play (the control: the reader who waits).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { adb } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const outDir = path.resolve(process.argv[3] || path.join(root, "build/android-bt"));
const url = process.env.APP_URL || "http://localhost:4173/";
const rounds = Number(process.env.ROUNDS || 3);
const watchSecs = Number(process.env.WATCH_SECONDS || 40);
const throttle = Number(process.env.THROTTLE || 1);
const alternate = !!process.env.ALTERNATE; // odd rounds tap at once, even rounds wait for the sounds: same conditions for both
const warmFor = (round) => (alternate ? round % 2 === 0 : !!process.env.WARM);
const needBt = process.env.BT !== "0";
fs.mkdirSync(outDir, { recursive: true });
const sh = (cmd) => adb("shell", cmd).toString();

// -- safety: only the app under test, only a phone that is on, unlocked, with Chrome in front
adb("shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");
await new Promise((r) => setTimeout(r, 1500));
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
console.log("device:", sh("getprop ro.product.model").trim(), `| rounds ${rounds}, watch ${watchSecs} s, CPU throttle ${throttle}x, ${alternate ? "alternating: odd rounds tap at once, even rounds wait for the sounds" : warmFor(1) ? "waits for sounds (control)" : "taps Play at once"}`);


// -- the phone's side of the Bluetooth path: AudioFlinger's counters for the A2DP output thread, and the
// system log. A gap the page counted and the same moment in these tells where the sound ran dry.
function a2dpSnap() {
    const txt = sh("dumpsys media.audio_flinger");
    const NL = String.fromCharCode(10);
    const threads = txt.split(NL + "Output thread ").filter((t) => /AUDIO_DEVICE_OUT_BLUETOOTH_A2DP/.test(t.split(NL).slice(0, 20).join(NL)));
    const out = { partial: 0, empty: 0, xrunFrames: 0, trackUnderruns: 0, found: threads.length };
    for (const t of threads) {
        const m = /Normal mixer raw underrun counters: partial=(\d+) empty=(\d+)/.exec(t);
        if (m) {
            out.partial += +m[1];
            out.empty += +m[2];
        }
        for (const x of t.matchAll(/xrunFrames: (\d+)/g)) {
            out.xrunFrames += +x[1];
        }
        for (const x of t.matchAll(/underruns=(\d+)/g)) {
            out.trackUnderruns += +x[1];
        }
    }
    return out;
}
const phoneNow = () => sh("date +'%m-%d %H:%M:%S.000'").trim();
const btLog = (since) => sh(`logcat -d -b all -v threadtime -T '${since}'`)
    .split(String.fromCharCode(10)).filter((l) => /a2dp|bt_a2dp|A2dp|xrun|underrun|underflow|audio_hw|BluetoothAudio|bta_av|codec/i.test(l) && !/chromium.*console/i.test(l)).slice(-60);

adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];
const b64 = fs.readFileSync(scorePath).toString("base64");
const results = [];

for (let round = 1; round <= rounds; round++) {
    const page = await context.newPage();
    try {
        const cdp = await context.newCDPSession(page);
        if (throttle > 1) {
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
        }
        if (!process.env.KEEP_QUEUE) {
            // the app remembers the sound queue a device grew to; every round starts as a first visit would
            // (only this test's address, never the reader's own tab)
            await page.goto(url);
            await page.evaluate(() => localStorage.removeItem("pocketscore.queue"));
        }
        await page.addInitScript(() => {
            // the audio worker's own reports (load, slowest block) with their times, from page start
            window.__wm = [];
            const W = window.Worker;
            window.Worker = class extends W {
                constructor(...a) {
                    super(...a);
                    this.addEventListener("message", (e) => {
                        const m = e.data;
                        if (m && (m.type === "stats" || m.type === "underrun")) {
                            window.__wm.push([Math.round(performance.now()), m.type, m.load, m.loadUnder, m.slowestMs, m.count]);
                        }
                    });
                }
            };
        });
        await page.goto(url + (url.includes("?") ? "&" : "?") + "r=" + Date.now());
        await page.waitForFunction(() => !!window.app?.state && document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 }).catch(() => {});
        const build = await page.evaluate(() => document.querySelector(".version, #version")?.textContent ?? "?");
        // open the score without waiting for sounds
        await page.evaluate(async ({ name, b64 }) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) {
                bytes[i] = bin.charCodeAt(i);
            }
            await app.openScore(name, bytes.buffer);
        }, { name: path.basename(scorePath), b64 });
        await page.waitForSelector(".page canvas", { timeout: 120000 });
        const warm = warmFor(round);
        if (warm) {
            // the control: the sounds are loaded, but the audio has not started (as a reader who waits then taps)
            await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 });
        }
        // watcher inside the page: one sample every 50 ms from the tap, plus every frame's length
        await page.evaluate(() => {
            const w = (window.__w = { t0: performance.now(), samples: [], frames: [], stop: false, playStartedAt: null, readyAt: null });
            const sample = () => {
                const e = app.engine, c = e.ctx;
                const now = performance.now();
                if (w.playStartedAt === null && app.state.playing) {
                    w.playStartedAt = now - w.t0;
                }
                if (w.readyAt === null && app.state.playbackReady) {
                    w.readyAt = now - w.t0;
                }
                w.samples.push({
                    t: Math.round(now - w.t0), playing: app.state.playing, ready: app.state.playbackReady, under: e.underruns,
                    clock: c ? +c.currentTime.toFixed(3) : null, out: c ? +(c.outputLatency * 1000).toFixed(0) : null,
                    queued: +(e.stats?.queuedSecs ?? 0).toFixed(3), level: +e.level.toFixed(3), levelAge: Math.round(now - (e.levelAt ?? now)),
                    pos: +app.state.position.toFixed(3), state: c?.state,
                });
                if (!w.stop) {
                    setTimeout(sample, 50);
                }
            };
            sample();
            let last = performance.now();
            const tick = (n) => {
                w.frames.push(n - last);
                last = n;
                if (!w.stop) {
                    requestAnimationFrame(tick);
                }
            };
            requestAnimationFrame(tick);
        });
        // time every call the page makes to the score engine's worker, and the main thread's long tasks:
        // what was running when the sound ran dry?
        await page.evaluate((traceCalls) => {
            const w = window.__w;
            w.calls = [];
            w.long = [];
            const e = app.engine, orig = e.request;
            if (traceCalls) e.request = function (msg, ...rest) {
                const t = performance.now();
                const done = () => w.calls.push([msg.cmd, Math.round(t - w.t0), Math.round(performance.now() - t)]);
                const p = orig.call(this, msg, ...rest);
                p.then(done, done);
                return p;
            };
            try {
                new PerformanceObserver((l) => {
                    for (const x of l.getEntries()) {
                        w.long.push([Math.round(x.startTime - (w.t0)), Math.round(x.duration)]);
                    }
                }).observe({ entryTypes: ["longtask"] });
            } catch (err) {
                // no long task support
            }
        }, !!process.env.TRACE_CALLS);
        const healthBefore = await page.evaluate(() => app.engine.health.length);
        const snap0 = a2dpSnap();
        const logSince = phoneNow();
        // the tap: the same click the reader makes
        await page.evaluate(() => { window.__w.t0 = performance.now(); });
        await page.click("#play");
        await page.waitForTimeout(watchSecs * 1000);
        const r = await page.evaluate((hb) => {
            const w = window.__w;
            w.stop = true;
            return {
                playStartedAt: w.playStartedAt, readyAt: w.readyAt, samples: w.samples, frames: w.frames,
                under: app.engine.underruns, stats: app.engine.stats, health: app.engine.health.slice(hb),
                calls: w.calls, long: w.long,
                wm: window.__wm, t0abs: w.t0,
            };
        }, healthBefore);

        {
            // what ran in the 1.5 s before each sound gap
            const gapTimes = S0(r.samples);
            for (const g of gapTimes) {
                const near = (t, d) => t + d >= g - 1500 && t <= g + 100;
                console.log(`  gap at ${g} ms after the tap; score-engine calls then: ` + (r.calls.filter(([, t, d]) => near(t, d)).map(([c, t, d]) => `${c}@${t}+${d}ms`).join(", ") || "none") + "; main-thread long tasks: " + (r.long.filter(([t, d]) => near(t, d)).map(([t, d]) => `@${t}+${d}ms`).join(", ") || "none"));
            }
            for (const g of gapTimes) {
                const rel = (x) => Math.round(x[0] - r.t0abs);
                console.log("  audio worker reports before the gap (ms after tap: load %, slowest block ms): " + r.wm.filter((x) => x[1] === "stats" && rel(x) >= g - 4000 && rel(x) <= g + 300).map((x) => `${rel(x)}: ${x[2] === null ? "?" : Math.round(x[2] * 100)}%, ${x[4] === null ? "?" : Math.round(x[4])}`).join(" | "));
            }
            console.log("  worst audio-worker block in the whole run: " + Math.max(0, ...r.wm.filter((x) => x[1] === "stats").map((x) => x[4] || 0)).toFixed(0) + " ms");
            const top = [...r.calls].sort((p, q) => q[2] - p[2]).slice(0, 4).map(([c, t, d]) => `${c}@${t}+${d}ms`).join(", ");
            console.log("  slowest score-engine calls: " + top);
        }
        const snap1 = a2dpSnap();
        const phoneLog = btLog(logSince);
        // analysis from the tap
        const S = r.samples;
        const firstPlay = S.find((s) => s.playing);
        const playSamples = S.filter((s) => s.playing);
        const underAtPlay = firstPlay ? firstPlay.under : 0;
        const gapsAfterPlay = r.under - underAtPlay;
        // sound actually played: the level must be above silence while playing (level is the peak the audio
        // thread last reported; levelAge says how old that report is: a stopped audio thread sends none)
        const silent = playSamples.filter((s) => s.level < 0.001).length;
        const staleReports = playSamples.filter((s) => s.levelAge > 500).length;
        const clockJumps = [];
        for (let i = 1; i < S.length; i++) {
            const dt = (S[i].t - S[i - 1].t) / 1000;
            const dc = S[i].clock - S[i - 1].clock;
            if (S[i].clock !== null && S[i - 1].clock !== null && dt > 0 && Math.abs(dc - dt) > 0.15) {
                clockJumps.push(`${S[i].t} ms: clock +${dc.toFixed(2)} s in ${dt.toFixed(2)} s`);
            }
        }
        const fr = [...r.frames].sort((p, q) => p - q);
        const longFrames = r.frames.filter((d) => d > 50).length;
        const outs = playSamples.map((s) => s.out).filter((v) => v !== null);
        const res = {
            round, build, mode: warm ? "waited" : "early",
            soundsReadyAfterTapMs: r.readyAt === null ? null : Math.round(r.readyAt),
            playingAfterTapMs: r.playStartedAt === null ? null : Math.round(r.playStartedAt),
            gapsBeforePlay: underAtPlay, gapsAfterPlay,
            outputLatencyMs: outs.length ? `${Math.min(...outs)}-${Math.max(...outs)}` : "?",
            silentSamples: silent, staleLevelSamples: staleReports,
            clockJumps: clockJumps.length, longFrames, maxFrameMs: Math.round(fr[fr.length - 1] || 0),
            health: r.health.map((h) => `${h.at} ${h.kind}: ${h.detail}`),
            stats: r.stats,
            a2dp: { found: snap1.found, partialUnderruns: snap1.partial - snap0.partial, emptyUnderruns: snap1.empty - snap0.empty, xrunFrames: snap1.xrunFrames - snap0.xrunFrames, trackUnderruns: snap1.trackUnderruns - snap0.trackUnderruns },
            phoneLog,
        };
        results.push(res);
        fs.writeFileSync(path.join(outDir, `earlyplay-round${round}.json`), JSON.stringify({ res, clockJumps, samples: S }, null, 1));
        console.log(`\nround ${round} [${res.mode}] (${build}):`);
        console.log(`  sounds ready ${res.soundsReadyAfterTapMs} ms after the tap; playing ${res.playingAfterTapMs} ms after the tap`);
        console.log(`  sound gaps: ${gapsBeforePlay(res)} before play, ${gapsAfterPlay} after; output latency ${res.outputLatencyMs} ms`);
        console.log(`  samples while playing with no sound: ${silent} of ${playSamples.length} (50 ms each); stale level reports: ${staleReports}`);
        console.log(`  audio clock jumps: ${clockJumps.length}${clockJumps.length ? " (" + clockJumps.slice(0, 4).join("; ") + ")" : ""}; frames over 50 ms: ${longFrames} (max ${res.maxFrameMs} ms)`);
        for (const h of res.health) {
            console.log("  health", h);
        }
        console.log("  stats", JSON.stringify(r.stats));
        console.log(`  phone's Bluetooth output thread (${res.a2dp.found} found): underruns partial ${res.a2dp.partialUnderruns}, empty ${res.a2dp.emptyUnderruns}, xrun frames ${res.a2dp.xrunFrames}, track underruns ${res.a2dp.trackUnderruns}`);
        for (const l of res.phoneLog.slice(-12)) {
            console.log("  log", l.slice(0, 200));
        }
    } finally {
        await page.close().catch(() => {});
    }
}
function S0(samples) {
    const out = [];
    for (let i = 1; i < samples.length; i++) {
        if (samples[i].under > samples[i - 1].under) {
            out.push(samples[i].t);
        }
    }
    return out;
}
function gapsBeforePlay(res) {
    return res.gapsBeforePlay;
}
await browser.close().catch(() => {});
console.log("\nbluetooth now:", sh("dumpsys bluetooth_manager | grep -A2 -E '^  A2DP:'").trim().replace(/\s+/g, " "));
process.exit(0);
