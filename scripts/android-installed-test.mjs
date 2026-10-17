// Keep playing in the reader's INSTALLED app on a real Android phone (issue #28: the music stopped
// there while the same build passed in a Chrome tab). Read only: it opens a score (opening writes
// nothing; only Save does), plays it quietly (the volume isn't saved), changes no setting, and
// needs the reader's Keep playing already on. Plain DevTools connection (no Playwright focus
// emulation). Its only inputs: a tap on Play sent into the page over DevTools, and the Home key,
// each sent only after checking PocketScore is in front. Doesn't turn the screen off.
// While away it records the sound played, Chrome's processes (frozen, process state) and the
// media sessions, every 5 s. AWAY=secs (default 180).
// Usage: node scripts/android-installed-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adb } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const SITE = "https://howieyhy.github.io/mobilemusescore/";
const awaySecs = Number(process.env.AWAY || 180);
const sh = (...a) => adb("shell", ...a).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the installed app: the WebAPK whose manifest starts at the site
const webapk = sh("pm", "list", "packages").split(/\s+/).map((l) => l.replace("package:", ""))
    .filter((p) => p.startsWith("org.chromium.webapk"))
    .find((p) => {
        const apk = sh("pm", "path", p).trim().split("\n")[0].replace("package:", "");
        return adb("exec-out", "unzip", "-p", apk, "AndroidManifest.xml").toString("utf16le").includes(SITE);
    });
if (!webapk) {
    console.log("PocketScore isn't installed on this phone");
    process.exit(2);
}
const focus = () => sh("dumpsys", "window").match(/mCurrentFocus=.*/)?.[0] ?? "";
// the installed app shows in Chrome's own activity for web apps, or the WebAPK's splash
const inFront = () => new RegExp(`${webapk.replace(/\./g, "\\.")}|WebApkActivity`).test(focus());
const launch = () => sh("am", "start", "-n", sh("cmd", "package", "resolve-activity", "--brief", webapk).trim().split("\n").pop());

const chromeProcs = () => sh("dumpsys", "activity", "processes").split(/\n\s{2}\*[A-Z]+\* /)
    .filter((p) => /ProcessRecord\{\w+ \d+:(com\.android\.chrome|org\.chromium\.webapk)/.test(p))
    .map((p) => ({
        name: p.match(/\d+:([\w.:]+)\//)?.[1].replace("com.android.chrome", "chrome"),
        frozen: /isFrozen=true/.test(p),
        state: p.match(/curProcState=(\d+)/)?.[1],
    }));
const sessions = () => sh("dumpsys", "media_session").split("\n").filter((l) => /package=|active=|state=PlaybackState \{state=/.test(l))
    .map((l) => l.trim().replace(/PlaybackState \{state=(\w+).*/, "state=$1")).join(" ");

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

if (!sh("dumpsys", "window").includes("isKeyguardShowing=false")) {
    console.log("the phone is locked: unlock it and run again");
    process.exit(2);
}
launch();
for (let i = 0; i < 80 && !inFront(); i++) await sleep(500); // a cold start can take 20 s+
if (!inFront()) {
    console.log(`PocketScore didn't come to the front (${focus()}); stopping without any input`);
    process.exit(2);
}
adb("forward", "tcp:9223", "localabstract:chrome_devtools_remote");
let target;
for (let i = 0; i < 40 && !target; i++) {
    await sleep(1000);
    target = await fetch("http://localhost:9223/json/list").then((r) => r.json()).catch(() => [])
        .then((l) => l.find((t) => t.type === "page" && t.url.startsWith(SITE)));
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
const audio = () => run(`({ playing: app.state.playing, clock: app.engine.audioTime, gaps: app.engine.underruns, running: app.engine.audioRunning, hidden: document.hidden,
    level: performance.now() - app.engine.levelAt < 1000 ? app.engine.level : 0, silences: app.engine.health.filter((h) => h.kind === "silence").length })`);

try {
    await until(`document.getElementById("status").textContent.startsWith("Ready") || !!app.state.score`, 180000);
    console.log("installed app:", webapk, await run(`document.getElementById("version").textContent`));
    if (!(await run(`app.settings.keepPlaying`))) {
        console.log("Keep playing is off in the reader's settings: this test doesn't change it; stopping");
        process.exit(2);
    }
    if (await run(`!!app.state.score`)) {
        console.log("a score is already open in the reader's app: not replacing it; stopping");
        process.exit(2);
    }
    const b64 = fs.readFileSync(scorePath).toString("base64");
    await run(`(async () => { const bin = atob("${b64}"); const b = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); await app.openScore(${JSON.stringify(path.basename(scorePath))}, b.buffer); })()`);
    await until(`app.state.playbackReady && !!document.querySelector(".page canvas")`, 180000);
    await run(`app.engine.setMasterVolume(-30)`); // quiet; not saved
    if (!inFront()) throw new Error(`PocketScore isn't in front (${focus()}): no tap`);
    const p = await run(`(() => { const r = document.getElementById("play").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    check(await until(`app.state.playing`, 30000), "Play starts the music");
    await sleep(3000);
    console.log("  before leaving:", JSON.stringify(await run(`({ session: navigator.mediaSession?.playbackState,
        keepAlive: app.engine.health.filter((h) => h.kind === "keep playing") })`)), "| sessions:", sessions());

    const left = (await run(`app.state.duration`)) - 15;
    const away = Math.min(awaySecs, Math.floor(left));
    const a = await audio();
    if (!inFront()) throw new Error(`PocketScore isn't in front (${focus()}): no Home key`);
    const t = Date.now();
    sh("input", "keyevent", "KEYCODE_HOME");
    const heard = [];
    while (Date.now() - t < away * 1000) {
        await sleep(5000);
        const now = await audio().catch((e) => ({ error: String(e) }));
        const procs = chromeProcs();
        heard.push(now.level > 0);
        console.log(`  ${Math.round((Date.now() - t) / 1000)}s: level ${now.level?.toFixed?.(3) ?? now.error}, clock ${now.clock?.toFixed(1)}, running ${now.running}, hidden ${now.hidden}, `
            + `frozen ${procs.filter((x) => x.frozen).map((x) => x.name).join(",") || "none"}, states ${procs.map((x) => `${x.name.replace(/^chrome:?/, "") || "main"}=${x.state}`).join(" ")}`);
        if (heard.length % 6 === 1) console.log("     sessions:", sessions());
    }
    const b = await audio();
    const wall = (Date.now() - t) / 1000;
    console.log(`  away ${wall.toFixed(0)} s: audio clock ran ${(b.clock - a.clock).toFixed(1)} s, gaps ${b.gaps - a.gaps}, silent at ${heard.map((h, i) => (h ? "" : `${(i + 1) * 5}s`)).filter(Boolean).join(" ") || "none"}`);
    check(b.playing && b.clock - a.clock > wall - 2, "the music goes on while away");
    check(heard.at(-1) && b.silences === a.silences, `sound is still heard after ${away} s away`);
} finally {
    console.log("  health:", JSON.stringify(await run(`app.engine.health`).catch(() => null)));
    await run(`app.state?.playing && app.engine.pause()`).catch(() => {});
    ws.close();
    adb("forward", "--remove", "tcp:9223");
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
