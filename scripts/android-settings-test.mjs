// Settings on a real Android phone (USB debugging), in the phone's own Chrome, on a local build at
// its own address (so the reader's notes and settings in the installed app are never touched). Plays
// quietly (master volume down, not saved). Checks:
//   - the phone runs this build (a stale offline copy at the address is cleared first),
//   - Settings is a page of its own over the whole screen, left with Back,
//   - Full screen with the Focus button: on, the page goes full screen; off, it doesn't,
//   - sound gaps while playing in Page view, with focus starting by itself and with it off
//     (the stutter guesses in DEVELOPMENT.md).
// Leaving the app (Keep playing, Keep the screen on) is android-background-test.mjs.
// Over a plain DevTools connection: Playwright stalls while the page's service worker is busy and
// tells a page it is always visible (16 Oct 2026). Opens its own tab (closing leftovers at its
// address first) and closes only that. Screenshots in build/android-settings.
//
//   cd app && npm run build && npx vite preview --host 127.0.0.1 --port 4173
// Usage: node scripts/android-settings-test.mjs [score.mscz]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adb, chromeDevtools } from "./lib/adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const url = process.env.APP_URL || "http://localhost:4173/";
const outDir = path.join(root, "build/android-settings");
fs.mkdirSync(outDir, { recursive: true });
const shot = (name) => fs.writeFileSync(path.join(outDir, name + ".png"), adb("exec-out", "screencap", "-p"));
const sh = (...a) => adb("shell", ...a).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

console.log("device:", sh("getprop", "ro.product.model").trim(), "Android", sh("getprop", "ro.build.version.release").trim());
// the lock screen hides every page: wait for the reader to unlock
for (let i = 0; i < 150 && !sh("dumpsys", "window").includes("isKeyguardShowing=false"); i++) {
    if (i === 0) console.log("waiting for the phone to be unlocked…");
    await sleep(2000);
}
if (!sh("dumpsys", "window").includes("isKeyguardShowing=false")) {
    console.log("the phone is still locked after 5 minutes: unlock it and run again");
    process.exit(2);
}
// the phone reaches this PC's test copy through a reverse port (else it shows its old offline copy)
const port = new URL(url).port;
if (/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname) && port) adb("reverse", `tcp:${port}`, `tcp:${port}`);
// only one tab at the test address, the one this test opens (a leftover one stays hidden and is
// throttled: it drew once a second and couldn't go full screen)
await chromeDevtools(9224);
const list = async () => (await fetch("http://localhost:9224/json/list")).json();
for (const t of await list()) {
    if (t.type === "page" && t.url.startsWith(url)) await fetch(`http://localhost:9224/json/close/${t.id}`);
}
sh("am", "start", "-a", "android.intent.action.VIEW", "-d", url, "com.android.chrome");
let target;
for (let i = 0; i < 30 && !target; i++) {
    await sleep(1000);
    target = (await list()).find((t) => t.type === "page" && t.url.startsWith(url));
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
// a real finger tap (counts as the reader's own tap, as full screen needs)
const tap = async (sel) => {
    const p = await run(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const setSetting = (k, v) => run(`(() => { const el = document.querySelector('[data-set="${k}"]'); el.checked = ${v}; el.dispatchEvent(new Event("change")); })()`);

try {
    await until(`document.getElementById("status")?.textContent.startsWith("Ready")`, 180000);
    // the phone keeps the last build it saw at this address: this build, or start afresh
    const want = JSON.parse(fs.readFileSync(path.join(root, "app/package.json"), "utf8")).version;
    const version = () => run(`document.getElementById("version").textContent`);
    // by the script's name, not the version: rebuilds keep the version (17 Oct 2026)
    const script = fs.readFileSync(path.join(root, "app/dist/index.html"), "utf8").match(/assets\/index-[\w-]+\.js/)[0];
    const sameBuild = () => run(`!!document.querySelector('script[src*="${script}"]')`);
    if (!(await sameBuild())) {
        console.log(`  the phone had ${await version()} at this address; clearing its offline copy`);
        await run(`(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
            for (const k of await caches.keys()) await caches.delete(k); })()`);
        await send("Page.reload", { ignoreCache: true });
        await sleep(3000);
        await until(`document.getElementById("status")?.textContent.startsWith("Ready")`, 180000);
    }
    console.log("test copy:", await version());
    check((await version()).endsWith(want) && (await sameBuild()), `the phone runs this build (${want}, ${script})`);
    check(await run(`!document.hidden`), "the test tab is the one on screen");
    const b64 = fs.readFileSync(scorePath).toString("base64");
    await run(`(async () => { const bin = atob("${b64}"); const b = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); await app.openScore(${JSON.stringify(path.basename(scorePath))}, b.buffer); })()`);
    await until(`app.state.playbackReady && !!document.querySelector(".page canvas")`, 180000);
    await run(`app.engine.setMasterVolume(-30)`); // quiet; not saved
    console.log("score open:", await run(`document.getElementById("score-title").textContent`));

    // ---- Settings: a page of its own on a phone
    await tap("#settings-open");
    await sleep(700);
    const full = await run(`(() => { const r = document.getElementById("settings").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight }; })()`);
    shot("panel");
    check(full.top <= 0.5 && Math.abs(full.bottom - full.h) < 1.5, `Settings is a page over the whole screen (${full.top.toFixed(1)}-${full.bottom.toFixed(1)} of ${full.h})`);
    await tap("#settings-back");
    await sleep(600);
    check(await run(`document.getElementById("settings").hidden`), "Back closes it");
    await setSetting("autoFocus", false);

    // ---- full screen with the Focus button
    for (const on of [true, false]) {
        await setSetting("focusFullscreen", on);
        await tap("#focus-toggle");
        await sleep(1200);
        const f = await run(`({ full: !!document.fullscreenElement, focus: app.state.focus })`);
        shot(on ? "focus-fullscreen" : "focus-no-fullscreen");
        check(f.focus && f.full === on, `full screen with the Focus button ${on ? "on" : "off"}: focus ${f.focus}, full screen ${f.full}`);
        await run(`history.back()`);
        await sleep(1200);
        await run(`document.fullscreenElement ? document.exitFullscreen() : null`);
        await sleep(500);
    }

    // ---- sound gaps in Page view: focus by itself on (default timing) and off
    for (const auto of [true, false]) {
        await setSetting("autoFocus", auto);
        await run(`(() => { app.engine.seek(0); app.engine.health.length = 0; })()`);
        await sleep(800);
        const g0 = await run(`app.engine.underruns`);
        await tap("#play");
        await until(`app.state.playing`, 30000);
        await sleep(45000);
        const r = await run(`({ gaps: app.engine.underruns, health: app.engine.health.slice(), focus: app.state.focus, stats: { ...app.engine.stats } })`);
        await run(`app.state.playing && app.engine.pause()`);
        await sleep(800);
        if (r.focus) {
            await run(`history.back()`);
            await sleep(800);
        }
        console.log(`  focus by itself ${auto ? "on" : "off"}: ${r.gaps - g0} gap(s) in 45 s, focus started: ${r.focus}, engine load ${r.stats.load === null ? "?" : (r.stats.load * 100).toFixed(0) + "%"}, slowest block ${r.stats.slowestMs?.toFixed?.(1)} ms`);
        r.health.forEach((h) => console.log(`    ${h.at} ${h.kind}: ${h.detail}`));
        check(r.gaps - g0 === 0, `no sound gaps in 45 s of Page view with focus by itself ${auto ? "on" : "off"}`);
    }

    // every setting away from its default is kept: after a reload, and after an update's reload
    // (offline copy cleared and fetched again); then the test copy's defaults are put back
    const changed = await run(`(() => {
        const out = {};
        for (const el of document.querySelectorAll("[data-set]")) {
            const k = el.dataset.set;
            if (el.type === "checkbox") el.checked = !el.checked;
            else if (el.tagName === "SELECT") el.value = [...el.options].find((o) => !o.selected).value;
            else el.value = String(Number(el.value) + 1);
            el.dispatchEvent(new Event("change"));
        }
        for (const k of Object.keys(app.settings)) out[k] = app.settings[k];
        return out;
    })()`);
    const stored = () => run(`({ ...app.settings })`);
    const same = (s) => Object.keys(changed).filter((k) => s[k] !== changed[k]);
    for (const [how, prep] of [["a reload", ""], ["an update (offline copy cleared)",
        `for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k);`]]) {
        await run(`(async () => { ${prep} })()`);
        await send("Page.reload", { ignoreCache: true });
        await sleep(3000);
        await until(`document.getElementById("status")?.textContent.startsWith("Ready")`, 180000);
        const off = same(await stored());
        check(off.length === 0, `every setting changed from its default is kept after ${how}${off.length ? ` (lost: ${off.join(", ")})` : ""} (${Object.keys(changed).length} settings)`);
    }
    await run(`localStorage.removeItem("pocketscore.settings")`);
} finally {
    await run(`app.state?.playing && app.engine.pause()`).catch(() => {});
    await send("Page.close").catch(() => {});
    ws.close();
    adb("forward", "--remove", "tcp:9224");
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
