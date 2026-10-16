// Leaving the app on a real Android phone: Keep playing (Settings) off and on, the home screen and
// the screen off, and Keep the screen on. Over a plain DevTools connection: Playwright tells a page it
// is always visible while connected (focus emulation), so the app never saw itself being left
// (found 15 Oct 2026). Local build at its own address, as android-settings-test.mjs; plays quietly;
// opens its own tab and closes only that; turns the screen off once (the reader unlocks it after).
//
//   cd app && npm run build && npx vite preview --host 127.0.0.1 --port 4173
//   adb reverse tcp:4173 tcp:4173
// Keep playing checks the sound level actually played while away (app.engine.level), not only the
// clock: in issue #28 the clock ran on in silence. AWAY=secs sets each stretch (default 120).
// Usage: node scripts/android-background-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adb } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:4173/";
// how long each Keep playing stretch stays away (issue #28: the sound stopped after a while)
const awaySecs = Number(process.env.AWAY || 120);
const sh = (...a) => adb("shell", ...a).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const front = () => sh("am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

// the lock screen hides every page: wait for the reader to unlock
for (let i = 0; i < 150 && !sh("dumpsys", "window").includes("isKeyguardShowing=false"); i++) {
    if (i === 0) console.log("waiting for the phone to be unlocked…");
    await sleep(2000);
}
// the phone reaches this PC's test copy through a reverse port (else it shows its old offline copy)
const port = new URL(url).port;
if (/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname) && port) adb("reverse", `tcp:${port}`, `tcp:${port}`);
// only one tab at the test address, the one this test opens (a leftover one stays hidden and is
// throttled: it drew once a second and couldn't go full screen, 16 Oct 2026)
adb("forward", "tcp:9223", "localabstract:chrome_devtools_remote");
for (const t of await (await fetch("http://localhost:9223/json/list")).json()) {
    if (t.type === "page" && t.url.startsWith(url)) await fetch(`http://localhost:9223/json/close/${t.id}`);
}
sh("am", "start", "-a", "android.intent.action.VIEW", "-d", url, "com.android.chrome");
adb("forward", "tcp:9223", "localabstract:chrome_devtools_remote");
let target;
for (let i = 0; i < 30 && !target; i++) {
    await sleep(1000);
    target = (await (await fetch("http://localhost:9223/json/list")).json()).find((t) => t.type === "page" && t.url.startsWith(url));
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const waiting = new Map();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)(m);
        waiting.delete(m.id);
    }
};
const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
});
const run = async (expression) => {
    const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || "evaluate failed");
    return m.result?.result?.value;
};
const until = async (expression, ms = 60000) => {
    for (const t = Date.now(); Date.now() - t < ms; await sleep(300)) {
        if (await run(expression).catch(() => false)) return true;
    }
    return false;
};
const tapPlay = async () => {
    const p = await run(`(() => { const r = document.getElementById("play").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const setSetting = (k, v) => run(`(() => { const el = document.querySelector('[data-set="${k}"]'); el.checked = ${v}; el.dispatchEvent(new Event("change")); })()`);
const audio = () => run(`({ playing: app.state.playing, clock: app.engine.audioTime, gaps: app.engine.underruns, running: app.engine.audioRunning, hidden: document.hidden,
    level: app.engine.level, silences: app.engine.health.filter((h) => h.kind === "silence").length })`);

try {
    await until(`document.getElementById("status").textContent.startsWith("Ready")`, 180000);
    // the phone keeps the last build it saw at this address: this build, or start afresh (the test's own address)
    const want = JSON.parse(fs.readFileSync(path.join(root, "app/package.json"), "utf8")).version;
    const version = () => run(`document.getElementById("version").textContent`);
    if (!(await version()).endsWith(want)) {
        console.log(`  the phone had ${await version()} at this address; clearing its offline copy`);
        await run(`(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
            for (const k of await caches.keys()) await caches.delete(k); })()`);
        await send("Page.reload", { ignoreCache: true });
        await sleep(3000);
        await until(`document.getElementById("status")?.textContent.startsWith("Ready")`, 180000);
    }
    console.log("test copy:", await version());
    check((await version()).endsWith(want), `the phone runs this build (${want})`);
    const b64 = fs.readFileSync(scorePath).toString("base64");
    await run(`(async () => { const bin = atob("${b64}"); const b = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); await app.openScore(${JSON.stringify(path.basename(scorePath))}, b.buffer); })()`);
    await until(`app.state.playbackReady && !!document.querySelector(".page canvas")`, 180000);
    await run(`app.engine.setMasterVolume(-30)`); // quiet; not saved
    await setSetting("autoFocus", false);
    // record PocketScore's own screen-lock requests, passing them on to the real ones
    await run(`(() => { const real = navigator.wakeLock.request.bind(navigator.wakeLock); window.__locks = [];
        navigator.wakeLock.request = async (t) => { const e = { at: Date.now() }; window.__locks.push(e);
            try { const s = await real(t); e.ok = true; s.addEventListener("release", () => (e.released = true)); return s; }
            catch (err) { e.ok = false; e.error = String(err); throw err; } }; })()`);

    // keep the screen on
    await setSetting("keepAwake", true);
    await tapPlay();
    await until(`app.state.playing`, 30000);
    await sleep(1500);
    const held = await run(`window.__locks.map((l) => ({ ...l }))`);
    await tapPlay();
    await until(`!app.state.playing`, 10000);
    await sleep(1000);
    const after = await run(`window.__locks.map((l) => ({ ...l }))`);
    console.log("  screen lock requests:", JSON.stringify(after));
    check(held.length === 1 && held[0].ok && !held[0].released && after[0].released,
        "keep the screen on: Android grants the screen lock while playing, and it is let go on pause");
    await setSetting("keepAwake", false);

    // keep playing off: the home screen pauses
    await setSetting("keepPlaying", false);
    await tapPlay();
    await until(`app.state.playing`, 30000);
    await sleep(2000);
    sh("input", "keyevent", "KEYCODE_HOME");
    await sleep(4000);
    const off = await audio();
    check(off.hidden && !off.playing, `keep playing off: the home screen pauses (hidden ${off.hidden}, playing ${off.playing})`);
    front();
    await until(`!document.hidden`, 15000);
    await sleep(1000);
    const back = await run(`({ hidden: document.hidden, status: document.getElementById("status").textContent })`);
    console.log("  back:", JSON.stringify(back));

    // keep playing on: the home screen, then the screen off
    await setSetting("keepPlaying", true);
    await tapPlay();
    await until(`app.state.playing`, 30000);
    await sleep(2000);
    for (const [where, key] of [["the home screen", "KEYCODE_HOME"], ["the screen off", "KEYCODE_POWER"]]) {
        await run(`app.engine.seek(0)`); // from the start, so the score doesn't end while away
        await sleep(2000);
        const a = await audio();
        const t = Date.now();
        sh("input", "keyevent", key);
        // the clock running proves nothing on its own (#28): listen to what is played, every 5 s
        const heard = [];
        while (Date.now() - t < awaySecs * 1000) {
            await sleep(5000);
            heard.push((await audio()).level > 0);
        }
        const b = await audio();
        b.screen = sh("dumpsys", "power").match(/mWakefulness=(\w+)/)?.[1];
        const ran = b.clock - a.clock;
        const wall = (Date.now() - t) / 1000;
        const quiet = heard.map((h, i) => (h ? "" : `${(i + 1) * 5}s`)).filter(Boolean);
        console.log(`  ${where}: screen ${b.screen}, hidden ${b.hidden}, playing ${b.playing}, audio running ${b.running}, audio clock ran ${ran.toFixed(1)} s of ${wall.toFixed(1)} s, gaps ${b.gaps - a.gaps}, silent at ${quiet.join(" ") || "none"}`);
        check(b.hidden && b.playing && ran > wall - 2 && b.gaps === a.gaps, `keep playing on: the music goes on with ${where}, no gaps`);
        check(heard.at(-1) && b.silences === a.silences, `keep playing on: sound is still heard after ${awaySecs} s with ${where}`);
        if (key === "KEYCODE_HOME") {
            front();
            await until(`!document.hidden`, 15000); // fully back before the screen goes off
            await sleep(2000);
        }
    }
    sh("input", "keyevent", "KEYCODE_WAKEUP");
} finally {
    console.log("  health:", JSON.stringify(await run(`app.engine.health`).catch(() => null)));
    await run(`app.state?.playing && app.engine.pause()`).catch(() => {});
    await send("Page.close").catch(() => {});
    ws.close();
    adb("forward", "--remove", "tcp:9223");
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
