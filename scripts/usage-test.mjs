// The owner's usage counter. The real Worker code (tracker/worker.js) runs here on an SQLite stand-in for
// D1, the real page (dev server with VITE_USAGE_URL pointing at it) sends its heartbeats, and the hidden
// owner screen reads the numbers back. Checks:
//   - /stats refuses a missing or wrong key; /ping refuses bad ids,
//   - a visit is counted once (one row, this install's id, the build's version, browser tab), and the
//     seconds in front grow (and are kept when the page goes to the background),
//   - a reload is a second visit by the same install; a second browser profile is a second install,
//   - Settings' "Share anonymous usage counts" off sends nothing (the same flow with it on does: the control),
//   - seven taps on the version line open the owner screen; a wrong key is refused, the right key shows
//     the figures, is kept for next time and can be forgotten; fewer than seven taps open nothing,
//   - a copy built with no counter address has no owner screen and the setting is off, saying so.
//
// Starts its own dev server (port 5191) and counter (port 8799).
// Usage: node scripts/usage-test.mjs

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const { default: worker } = await import("../tracker/worker.js");
const version = JSON.parse(fs.readFileSync(path.join(root, "app/package.json"), "utf8")).version;

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the counter: the Worker's own code, with D1's calls answered by SQLite
const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(root, "tracker/schema.sql"), "utf8"));
const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { db.prepare(sql).run(...args); return {}; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
});
const env = {
    DB: { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.all())) },
    STATS_KEY: "test-key-0123456789",
    TZ_OFFSET_HOURS: "8",
};
const counter = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request("http://127.0.0.1:8799" + req.url, {
        method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => counter.listen(8799, "127.0.0.1", r));
const COUNTER = "http://127.0.0.1:8799";

// ---- the page's dev servers: one with the counter built in, one without
function devServer(port, withCounter) {
    const e = { ...process.env };
    delete e.VITE_USAGE_URL;
    if (withCounter) e.VITE_USAGE_URL = COUNTER;
    const p = spawn("npx.cmd", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: path.join(root, "app"), env: e, shell: true, stdio: "ignore" });
    return p;
}
const servers = [devServer(5191, true), devServer(5192, false)];
const killAll = () => servers.forEach((s) => spawn("taskkill", ["/pid", String(s.pid), "/T", "/F"], { stdio: "ignore" }));
async function waitFor(url) {
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
        await sleep(500);
    }
    throw new Error("dev server did not start: " + url);
}

const rows = () => db.prepare("SELECT * FROM sessions ORDER BY started").all();
async function until(fn, ms) {
    const t = Date.now();
    while (Date.now() - t < ms) {
        if (await fn()) return true;
        await sleep(200);
    }
    return false;
}

let browser;
try {
    await Promise.all([waitFor("http://127.0.0.1:5191/"), waitFor("http://127.0.0.1:5192/")]);

    // ---- the counter itself
    const stats = (key) => fetch(COUNTER + "/stats", { headers: key ? { authorization: "Bearer " + key } : {} });
    check((await stats()).status === 401, "/stats without a key: refused");
    check((await stats("wrong")).status === 401, "/stats with a wrong key: refused");
    const bad = await fetch(COUNTER + "/ping", { method: "POST", body: JSON.stringify({ id: "x", sid: "y" }) });
    check(bad.status === 400 && rows().length === 0, "/ping with bad ids: refused, nothing stored");

    browser = await chromium.launch();
    const ctxA = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await ctxA.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("http://127.0.0.1:5191/");

    // ---- one visit
    check(await until(() => rows().length === 1, 10000), "a visit is counted (one row within 10 s)");
    const first = rows()[0];
    check(first && /^[a-z0-9-]{8,40}$/.test(first.id) && first.v === version && first.mode === "tab",
        `its id, version (${version}) and mode (browser tab) are right`);
    check(JSON.stringify(first).indexOf("mscz") < 0 && Object.keys(first).join() === "sid,id,started,last,secs,play,v,mode",
        "the row holds only the listed fields (no score names, no IP)");

    await sleep(7000); // the page counts in 5 s steps
    await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    check(await until(() => rows()[0].secs >= 8, 5000), `seconds in front grow and are sent as the page goes to the background (secs ${rows()[0].secs})`);
    check(rows()[0].play === 0, "nothing played, so playing time stays 0");

    // ---- a reload is a second visit by the same install
    await page.reload();
    check(await until(() => rows().length === 2, 10000), "a reload is a second visit");
    check(new Set(rows().map((r) => r.id)).size === 1 && rows()[0].sid !== rows()[1].sid, "same install, a new visit id");

    // ---- a second profile is a second install
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto("http://127.0.0.1:5191/");
    check(await until(() => new Set(rows().map((r) => r.id)).size === 2, 10000), "a second browser profile is a second install");
    await ctxB.close();

    // ---- fewer than seven taps open nothing; seven do
    await page.reload();
    await page.waitForSelector("#version");
    for (let i = 0; i < 6; i++) await page.click("#version");
    check(!(await page.$eval("#owner", (d) => d.open)), "six taps on the version line open nothing");
    await page.click("#version");
    check(await page.$eval("#owner", (d) => d.open), "the seventh tap opens the owner screen");

    // ---- the key
    await page.fill(".ou-key", "not-the-key");
    await page.click(".ou-go");
    check(await until(async () => /not accepted/.test(await page.textContent(".ou-msg")), 5000), "a wrong key is refused");
    check(!(await page.$eval(".ou-keyrow", (e) => e.hidden)), "the key box stays for another try");
    await page.fill(".ou-key", env.STATS_KEY);
    await page.click(".ou-go");
    const shown = await until(async () => /people so far/.test(await page.textContent(".ou-body")), 5000);
    check(shown, "the right key shows the figures");
    const text = shown ? await page.textContent(".ou-body") : "";
    const figures = await page.$$eval(".ou-stat", (els) => Object.fromEntries(els.map((e) => [e.querySelector(".ou-label").textContent, e.querySelector(".ou-num").textContent])));
    const num = (label) => Number(figures[label]);
    check(num("people so far") === 2, `people so far = 2 (shown ${num("people so far")})`);
    check(num("visits so far") === 3 || num("visits so far") === 4, `visits so far counts every visit (shown ${num("visits so far")}; the page just reloaded)`);
    check(num("used it today") === 2, `used it today = 2 (shown ${num("used it today")})`);
    check(/Each day, last 30 days/.test(text) && /Installed app or browser tab/.test(text), "daily list and breakdowns are shown");
    // a look at it on a phone (build/usage/owner-phone.png)
    fs.mkdirSync(path.join(root, "build/usage"), { recursive: true });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.screenshot({ path: path.join(root, "build/usage/owner-phone.png") });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the owner screen fits a phone's width");
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.click(".ou-close");

    // the key is kept on this device: next time it loads by itself; Forget removes it
    for (let i = 0; i < 7; i++) await page.click("#version");
    check(await until(async () => /people so far/.test(await page.textContent(".ou-body")), 5000), "the saved key is used next time (no typing)");
    await page.click(".ou-forget");
    check(await page.evaluate(() => localStorage.getItem("pocketscore.owner")) === null && !(await page.$eval(".ou-keyrow", (e) => e.hidden)),
        "Forget key removes it and asks again");
    await page.click(".ou-close");

    // ---- the reader's switch
    await page.click("#settings-open");
    check(await page.$eval("[data-set=shareUsage]", (e) => e.checked && !e.disabled), "Settings: sharing is on and available by default");
    await page.click("[data-set=shareUsage]", { force: true });
    check(await page.evaluate(() => JSON.parse(localStorage.getItem("pocketscore.settings")).shareUsage === false), "switching it off is kept");
    const before = rows().length;
    const beforeSecs = rows().map((r) => r.secs).join();
    await page.reload();
    await sleep(9000);
    check(rows().length === before && rows().map((r) => r.secs).join() === beforeSecs, "off: a reload sends nothing (rows and seconds unchanged after 9 s)");
    await ctxA.close();

    // ---- a copy with no counter
    const plain = await browser.newPage();
    await plain.goto("http://127.0.0.1:5192/");
    await plain.waitForSelector("#version");
    for (let i = 0; i < 7; i++) await plain.click("#version");
    check(!(await plain.$eval("#owner", (d) => d.open)), "no counter built in: seven taps open nothing");
    await plain.click("#settings-open");
    check(await plain.$eval("[data-set=shareUsage]", (e) => e.disabled && !e.checked), "no counter built in: the setting is off and disabled");
    check(/Not available in this copy/.test(await plain.textContent("#settings")), "...and says why");
    check(await plain.$eval("#usage-note", (e) => e.hidden), "...and the start screen makes no claim about sending");
    const n = rows().length;
    await sleep(4000);
    check(rows().length === n, "no counter built in: nothing sent");

    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors[0] : ""));
} finally {
    await browser?.close();
    counter.close();
    killAll();
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
