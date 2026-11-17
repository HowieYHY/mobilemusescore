// Read-only watcher for a real Bluetooth stutter, while the READER plays on the phone (nothing is tapped,
// typed or opened: it only reads). Attaches to the PocketScore tab/installed app that is already open and
// logs, once a second, whether it is playing, the sound gaps counted, the queue, the sound level actually
// played and Chrome's output latency; and from the phone: AudioFlinger's counters for the Bluetooth output
// thread, and, afterwards, the Bluetooth controller's own quality reports (signal strength, retransmissions,
// packets not received, flow-off) and Chrome's audio-buffer underflow lines for the same window.
// Then it says, for every gap the app counted, what the radio and the phone were doing around it.
//
// Usage: ADB=... WATCH_SECONDS=300 node scripts/android-bt-watch.mjs [url prefix of the open PocketScore]
// The default prefix is the published app (https://howieyhy.github.io/mobilemusescore/).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { adb } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const prefix = process.argv[2] || "https://howieyhy.github.io/mobilemusescore/";
const watchSecs = Number(process.env.WATCH_SECONDS || 300);
const outDir = path.resolve(process.env.OUT_DIR || path.join(root, "build/android-bt-watch"));
fs.mkdirSync(outDir, { recursive: true });
const sh = (cmd) => adb("shell", cmd).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);

const a2dpSnap = () => {
    const txt = sh("dumpsys media.audio_flinger");
    const out = { partial: 0, empty: 0, xrun: 0 };
    for (const t of txt.split(NL + "Output thread ").filter((x) => /AUDIO_DEVICE_OUT_BLUETOOTH_A2DP/.test(x.split(NL).slice(0, 20).join(NL)))) {
        const m = /Normal mixer raw underrun counters: partial=(\d+) empty=(\d+)/.exec(t);
        if (m) {
            out.partial += +m[1];
            out.empty += +m[2];
        }
        for (const x of t.matchAll(/xrunFrames: (\d+)/g)) {
            out.xrun += +x[1];
        }
    }
    return out;
};
const phoneClock = () => sh("date +'%m-%d %H:%M:%S'").trim();
const phoneState = () => {
    const mem = sh("cat /proc/meminfo");
    const kb = (k) => Number(new RegExp(k + ":\\s+(\\d+)").exec(mem)?.[1] || 0);
    return {
        thermal: Number(/Thermal Status: (\d+)/.exec(sh("dumpsys thermalservice | grep 'Thermal Status'"))?.[1] ?? -1),
        load: sh("cat /proc/loadavg").split(" ")[0], availMB: Math.round(kb("MemAvailable") / 1024), swapFreeMB: Math.round(kb("SwapFree") / 1024),
        camera: !/Active Camera Clients:\s*\[\]/.test(sh("dumpsys media.camera | grep -A1 'Active Camera Clients'").replace(/\r/g, "")),
    };
};

console.log("device:", sh("getprop ro.product.model").trim(), "| phone clock", phoneClock(), "| watching", watchSecs, "s, read-only");
console.log("bluetooth:", sh("dumpsys bluetooth_manager | grep -A2 -E '^  A2DP:'").trim().replace(/\s+/g, " "));
const startClock = process.env.START_CLOCK || phoneClock(); // START_CLOCK="11-18 01:00:11": analyse an earlier window
adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(prefix));
if (!page) {
    console.error("PocketScore is not open on the phone at", prefix);
    process.exit(1);
}
const info = await page.evaluate(() => ({ score: document.getElementById("score-title")?.textContent, version: document.querySelector(".version, #version")?.textContent, under: app.engine.underruns }));
console.log(`watching ${info.version}, score "${info.score}", gaps so far ${info.under}. Play it now.`);

// Level of what is sent to the speaker: the worklet reports the loudest sample every ~100 ms. Counting those
// reports (in page memory only; gone on reload) tells whether the sound reaches or passes full scale, which
// a phone speaker's limiter hides but a Bluetooth encoder turns into crackle.
await page.evaluate(() => {
    const e = app.engine;
    if (e.__peakWatch) {
        return;
    }
    const w = (e.__peakWatch = { reports: 0, max: 0, ge90: 0, ge98: 0, ge100: 0, over100: 0, hist: new Array(12).fill(0), playingReports: 0 });
    const orig = e.onQueued;
    e.onQueued = function (frames, peak) {
        if (app.state.playing) {
            w.playingReports++;
            w.max = Math.max(w.max, peak);
            w.ge90 += peak >= 0.9 ? 1 : 0;
            w.ge98 += peak >= 0.98 ? 1 : 0;
            w.ge100 += peak >= 1 ? 1 : 0;
            w.over100 += peak > 1 ? 1 : 0;
            w.hist[Math.min(11, Math.floor(peak * 10))]++;
        }
        return orig.call(this, frames, peak);
    };
});

const rows = [];
const events = [];
let last = info.under;
let lastSnap = a2dpSnap();
const snap0 = lastSnap;
const t0 = Date.now();
let playedSecs = 0;
while (Date.now() - t0 < watchSecs * 1000) {
    const r = await page.evaluate(() => {
        const e = app.engine, c = e.ctx;
        return { playing: app.state.playing, pos: +app.state.position.toFixed(2), under: e.underruns, queued: +(e.stats.queuedSecs ?? 0).toFixed(3), target: +(e.stats.targetSecs ?? 0).toFixed(3), level: +e.level.toFixed(3), levelAge: Math.round(performance.now() - e.levelAt), out: c ? Math.round(c.outputLatency * 1000) : null, state: c?.state, vis: document.visibilityState, load: e.stats.load, health: e.health.slice(-2).map((h) => h.kind + ": " + h.detail) };
    }).catch(() => null);
    if (!r) {
        console.log("lost the page; stopping");
        break;
    }
    const now = Date.now() - t0;
    rows.push({ t: now, ...r });
    if (r.playing) {
        playedSecs++;
    }
    if (r.under > last) {
        const snap = a2dpSnap();
        events.push({ at: phoneClock(), tms: now, gapsNow: r.under, queued: r.queued, target: r.target, vis: r.vis, state: r.state, out: r.out, engineLoad: r.load, a2dpDelta: { partial: snap.partial - lastSnap.partial, empty: snap.empty - lastSnap.empty, xrun: snap.xrun - lastSnap.xrun }, phone: phoneState() });
        lastSnap = snap;
        last = r.under;
        const ev = events[events.length - 1];
        console.log(`GAP ${r.under} at phone time ${ev.at}: queue ${r.queued}s (target ${r.target}s), page ${r.vis}, audio ${r.state}; bluetooth output thread underruns +${ev.a2dpDelta.partial + ev.a2dpDelta.empty}, xrun +${ev.a2dpDelta.xrun}; phone ${JSON.stringify(ev.phone)}`);
    }
    await sleep(900);
}
const end = a2dpSnap();
const endClock = phoneClock();
const outs = rows.filter((r) => r.playing && r.out).map((r) => r.out);
console.log(`\nwatched ${Math.round((Date.now() - t0) / 1000)} s (phone ${startClock} to ${endClock}); playing ${playedSecs} s; gaps counted by the app: ${events.length}`);
console.log(`bluetooth output thread over the watch: underruns +${end.partial - snap0.partial + end.empty - snap0.empty}, xrun frames +${end.xrun - snap0.xrun}; output latency while playing ${outs.length ? Math.min(...outs) + "-" + Math.max(...outs) : "?"} ms`);
const silent = rows.filter((r) => r.playing && r.level === 0 && r.levelAge < 500).length;
console.log(`seconds playing with zero level: ${silent}; page not visible while playing: ${rows.filter((r) => r.playing && r.vis !== "visible").length} s`);

const pk = await page.evaluate(() => app.engine.__peakWatch).catch(() => null);
if (pk) {
    console.log(`\nsound level while playing: ${pk.playingReports} reports (100 ms each); loudest sample ${pk.max.toFixed(3)} (1.0 = full scale); reports at 0.90+: ${pk.ge90}, 0.98+: ${pk.ge98}, at or over 1.0: ${pk.ge100}, over 1.0: ${pk.over100}`);
    console.log("   histogram of the loudest sample per report (0.0-0.1 ... 1.0+): " + pk.hist.join(" "));
}

// ---- the controller's own reports and Chrome's buffer underflows over the same window
const log = adb("logcat", "-d", "-b", "all", "-v", "threadtime", "-T", startClock.replace(" ", " ") + ".000").toString();
fs.writeFileSync(path.join(outDir, "logcat.txt"), log);
const lines = log.split(NL);
const reports = [];
for (let i = 0; i < lines.length; i++) {
    if (!/BluetoothQualityReportNativeCallback: BQR: \{/.test(lines[i])) {
        continue;
    }
    let block = "";
    for (let j = i; j < Math.min(i + 14, lines.length); j++) {
        block += " " + lines[j].replace(/^.*?BluetoothQualityReportNativeCallback:\s*/, "");
        if (/^\d\d-\d\d.*BluetoothQualityReportNativeCallback: \}\s*$/.test(lines[j])) {
            break;
        }
    }
    const g = (k) => {
        const m = new RegExp(k + ": (-?\\d+)").exec(block);
        return m ? Number(m[1]) : null;
    };
    const idm = /mQualityReportId: ([^,]+),/.exec(block);
    const b = ["mRssiChainOver50", "mRssiChain50To55", "mRssiChain55To60", "mRssiChain60To65", "mRssiChain65To70", "mRssiChain70To75", "mRssiChain75To80", "mRssiChain80To85", "mRssiChain85To90", "mRssiChainUnder90"].map(g);
    const tot = b.reduce((x, y) => x + (y || 0), 0);
    reports.push({
        at: lines[i].slice(0, 14), id: idm?.[1], rssi: g("mRssi"), retrans: g("mRetransmissionCount"), noRx: g("mNoRxCount"), nak: g("mNakCount"), flowOff: g("mFlowOffCount"),
        overflow: g("mOverflowCount"), underflow: g("mUnderflowCount"), txTotal: g("mTxTotalPackets"), txUnack: g("mTxUnackPackets"), txFlush: g("mTxFlushPackets"), crc: g("mCrcErrorPackets"), unrecv: g("mRxUnRecvPackets"),
        weak80: tot ? Math.round(((b[7] + b[8] + b[9]) / tot) * 100) : null, weak90: tot ? Math.round((b[9] / tot) * 100) : null, period: g("mReportTimePeriod"),
    });
}
console.log(`\nBluetooth controller quality reports in the window: ${reports.length}`);
for (const r of reports) {
    console.log("  " + JSON.stringify(r));
}
const fifo = lines.filter((l) => /PushPullFIFO::PullAndUpdateEarmarkedFrames underflow/.test(l)).map((l) => l.slice(6, 18));
console.log(`Chrome audio-buffer underflow lines: ${fifo.length}${fifo.length ? " at " + fifo.slice(0, 12).join(", ") : ""}`);
const other = lines.filter((l) => /a2dp.*(underrun|underflow|xrun|congest|flush|suspend|stop|start)|audio_hw.*(underrun|xrun)|A2DP.*(suspend|reconfig|codec)/i.test(l)).slice(-10).map((l) => l.slice(0, 200));
for (const l of other) {
    console.log("  log", l);
}
fs.writeFileSync(path.join(outDir, "watch.json"), JSON.stringify({ events, reports, rows }, null, 1));
await browser.close().catch(() => {});
adb("forward", "--remove", "tcp:9222");
process.exit(0);
