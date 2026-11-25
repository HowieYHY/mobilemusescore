// The owner's usage counter. The real Worker code (tracker/worker.js) runs here on an SQLite stand-in for
// D1, the real page (dev server with VITE_USAGE_URL pointing at it) sends its heartbeats, and the hidden
// owner screen reads the numbers back. Checks:
//   - /stats refuses a missing or wrong key; /ping refuses bad ids,
//   - a visit is counted once (one row, this install's id, the build's version, browser tab), and the
//     seconds in front grow (and are kept when the page goes to the background),
//   - a reload is a second visit by the same install; a second browser profile is a second install,
//   - Settings' "Share anonymous usage counts" off sends nothing (the same flow with it on does: the control),
//   - seven taps on the version line open the owner screen (a whole screen); a wrong key is refused, the right
//     key shows the figures, is kept for next time and can be forgotten; fewer than seven taps open nothing,
//   - the ranges (24 hours, 7 days, 1 month, 1 year): Singapore-time columns, nothing drawn before the first
//     visit, every view adding up, hover and table views, with the browser set to New York time,
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
    const ctxA = await browser.newContext({ viewport: { width: 1000, height: 800 }, timezoneId: "America/New_York" }); // not SGT, to see that the screen is
    const page = await ctxA.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("http://127.0.0.1:5191/");

    // ---- one visit
    check(await until(() => rows().length === 1, 10000), "a visit is counted (one row within 10 s)");
    const first = rows()[0];
    check(first && /^[a-z0-9-]{8,40}$/.test(first.id) && first.v === version && first.mode === "tab",
        `its id, version (${version}) and mode (browser tab) are right`);
    check(JSON.stringify(first).indexOf("mscz") < 0 && Object.keys(first).join() === "sid,id,started,last,secs,play,v,mode,own",
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
    const shown = await until(async () => (await page.$$(".ou-stat")).length > 0, 5000);
    check(shown, "the right key shows the figures");
    const figures = await page.$$eval(".ou-stat", (els) => Object.fromEntries(els.map((e) => [e.querySelector(".ou-label").textContent, e.querySelector(".ou-num").textContent])));
    check(Number(figures["People"]) === 2, `people = 2 (shown ${figures["People"]})`);
    check([3, 4].includes(Number(figures["Visits"])), `visits counts every visit (shown ${figures["Visits"]})`);
    check(await page.$eval("#owner", (d) => Math.round(d.getBoundingClientRect().width) === innerWidth && Math.round(d.getBoundingClientRect().height) === innerHeight), "the owner screen takes the whole screen");

    // ---- the counter's own answers: Singapore time, nothing before the first visit
    const SGT = 8 * 3600000, HOUR = 3600000, DAY = 24 * HOUR, WEEK = 7 * DAY;
    const get = async (range) => (await fetch(`${COUNTER}/stats?range=${range}`, { headers: { authorization: "Bearer " + env.STATS_KEY } })).json();
    const [s24, s7, s30, s1y, bogus] = await Promise.all(["24h", "7d", "30d", "1y", "nonsense"].map(get));
    check(bogus.range === "7d", "an unknown range falls back to 7 days");
    check(s24.unit === "hour" && s24.buckets.every((b) => b.t % HOUR === 0), "24 hours: hourly columns");
    check(s7.unit === "day" && s7.buckets.every((b) => (b.t + SGT) % DAY === 0), "7 days: daily columns that start at midnight Singapore time");
    check(s30.buckets.every((b) => (b.t + SGT) % DAY === 0), "1 month: daily columns that start at midnight Singapore time");
    check(s1y.unit === "week" && s1y.buckets.every((b) => (b.t + SGT - 4 * DAY) % WEEK === 0), "1 year: weekly columns that start on a Monday, Singapore time");
    check([s7, s30, s1y].every((x) => x.buckets.length === 1) && s24.buckets.length >= 1 && s24.buckets.length <= 2 && s24.buckets[0].t + HOUR > s24.since,
        `nothing before the first visit is shown (7 days, 1 month, 1 year: 1 column; 24 hours: ${s24.buckets.length})`);
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    check(sum(s7.buckets.map((b) => b.visits)) === s7.summary.visits && sum(s7.hourOfDay.map((x) => x.visits)) === s7.summary.visits
        && sum(s7.dayOfWeek.map((x) => x.visits)) === s7.summary.visits && sum(s7.visitLengths) === s7.summary.visits, "every view adds up to the same number of visits");

    // ---- telling the owner's own visits from everyone else's
    const send = (id, sid, k) => fetch(COUNTER + "/ping", { method: "POST", body: JSON.stringify({ id, sid, v: version, mode: "tab", secs: 30, play: 10, ...(k ? { k } : {}) }) });
    const who = async (w) => (await fetch(`${COUNTER}/stats?range=7d&who=${w}`, { headers: { authorization: "Bearer " + env.STATS_KEY } })).json();
    const everyBefore = await who("all");
    const mineBefore = (await who("mine")).summary.visits;
    await send("owner-device-0001", "owner-visit-0001"); // an install that has not shown the key yet
    await send("other-person-0001", "other-visit-0001", "a-guessed-key");
    check((await who("mine")).summary.visits === mineBefore && rows().find((r) => r.id === "other-person-0001").own === 0, "a visit with a wrong key is not marked as the owner's");
    await send("owner-device-0001", "owner-visit-0002", env.STATS_KEY);
    const mine = await who("mine"), others = await who("others"), every = await who("all");
    check(mine.summary.people >= 1 && mine.installs.mine >= 1 && mine.summary.visits >= 2, "the right key marks the install as the owner's");
    const ownerRows = rows().filter((r) => r.id === "owner-device-0001");
    check(ownerRows.length === 2 && ownerRows.every((r) => r.own === 1 || r.sid === "owner-visit-0001"), "(its first visit, sent before the key, is still stored as it was)");
    check(mine.summary.visits === rows().filter((r) => r.own === 1 || rows().some((o) => o.id === r.id && o.own === 1)).length, "...but counted as the owner's too, since the install is");
    check(others.summary.visits + mine.summary.visits === every.summary.visits && others.summary.people + mine.summary.people === every.summary.people, "mine and others add up to everyone");
    check(every.summary.visits === everyBefore.summary.visits + 3, "everyone still counts every visit");
    check(sum(mine.buckets.map((b) => b.visits)) === mine.summary.visits && sum(others.hourOfDay.map((x) => x.visits)) === others.summary.visits && mine.total.visits === mine.summary.visits, "the filter reaches every part (chart, hours, all time)");
    check((await fetch(`${COUNTER}/stats?range=7d&who=mine`, { headers: { authorization: "Bearer nope" } })).status === 401, "the filter doesn't bypass the key");
    check(!JSON.stringify(rows()).includes(env.STATS_KEY), "the key itself is never stored");
    db.prepare("DELETE FROM sessions WHERE id IN ('owner-device-0001', 'other-person-0001')").run(); // so the counts below are the real ones

    // ---- the views on the screen
    const hits = (card) => page.$$eval(`.ou-cards > .ou-card:nth-child(${card}) .ou-hit`, (e) => e.length);
    const tableRows = (card) => page.$$eval(`.ou-cards > .ou-card:nth-child(${card}) tbody tr`, (rs) => rs.map((r) => [...r.children].map((c) => c.textContent)));
    const pressed = () => page.$$eval(".ou-controls .ou-seg:first-child button[aria-pressed=true]", (b) => b.map((x) => x.textContent).join());
    check((await page.$$(".ou-controls .ou-seg:first-child button")).length === 4 && (await pressed()) === "7 days", "range choices: 24 hours, 7 days, 1 month, 1 year; 7 days at first");
    check((await page.$eval(".ou-tick", (l) => l.textContent.trim())) === "Leave out my own visits" && !(await page.$eval(".ou-tick input", (i) => i.checked)), "a tick: Leave out my own visits, off at first");
    const askedOthers = page.waitForRequest((r) => /who=others/.test(r.url()));
    await page.check(".ou-tick input");
    await askedOthers;
    check(await until(async () => /without your own visits/.test(await page.textContent(".ou-alltime")), 5000), "ticking it asks the counter for everyone but the owner, and the all-time line says so");
    const askedAll = page.waitForRequest((r) => /who=all/.test(r.url()));
    await page.uncheck(".ou-tick input");
    await askedAll;
    check(await until(async () => !/without your own/.test(await page.textContent(".ou-alltime")), 5000), "unticking brings everyone back");
    check((await hits(1)) === s7.buckets.length, "the chart shows only the days since the first visit (1)");
    const asked = page.waitForRequest((r) => /range=24h/.test(r.url()));
    await page.click(".ou-controls button:has-text('24 hours')");
    await asked;
    check(await until(async () => (await pressed()) === "24 hours" && (await hits(1)) === s24.buckets.length, 5000), "24 hours asks the counter for 24 hours and redraws");
    check(await page.evaluate(() => JSON.parse(localStorage.getItem("pocketscore.owner.view")).range === "24h"), "the chosen range is remembered on this device");
    // the hour under the pointer is named in Singapore time although this browser is on New York time
    const sgtHour = (ms) => new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", hour: "numeric", hour12: true }).format(ms);
    const nyHour = (ms) => new Intl.DateTimeFormat("en-SG", { timeZone: "America/New_York", hour: "numeric", hour12: true }).format(ms);
    const lastBucket = s24.buckets.at(-1);
    await page.hover(".ou-cards > .ou-card:nth-child(1) .ou-hit:last-of-type");
    const tipText = await page.textContent(".ou-cards > .ou-card:nth-child(1) .ou-tip");
    check(await page.$eval(".ou-cards > .ou-card:nth-child(1) .ou-tip", (t) => !t.hidden) && tipText.includes(sgtHour(lastBucket.t)) && sgtHour(lastBucket.t) !== nyHour(lastBucket.t),
        `hovering a column names it in Singapore time (${sgtHour(lastBucket.t)}, not ${nyHour(lastBucket.t)}): "${tipText.slice(0, 60)}"`);
    check(await page.$eval(".ou-cards > .ou-card:nth-child(1) .ou-cross", (c) => c.style.display !== "none") && await page.$eval(".ou-cards > .ou-card:nth-child(1) .ou-mark", (c) => c.style.display !== "none"),
        "hovering draws the crosshair and the marker on the point");
    check(/ SGT$/.test(await page.textContent(".ou-msg")), "the screen says its update time is SGT");
    // what to chart
    const caption = () => page.textContent(".ou-cards > .ou-card:nth-child(1) .ou-cap");
    const before1 = await caption();
    await page.click(".ou-metrics button:has-text('Visits')");
    check((await caption()) !== before1 && /Visits/.test(await caption()), "the chart's metric switch changes what is drawn");
    check(sum((await tableRows(1)).map((r) => Number(r[3]))) === s24.summary.visits, "the table behind the chart adds up to the visits in the range");
    await page.click(".ou-metrics button:has-text('Average visit')");
    check(/Average visit/.test(await caption()), "...and so does Average visit");
    // when people use it
    check((await hits(2)) === 24, "when people use it: 24 hours of the day");
    await page.click(".ou-cards > .ou-card:nth-child(2) .ou-seg button:has-text('Day of week')");
    check((await hits(2)) === 7, "...and 7 days of the week");
    check(sum((await tableRows(2)).map((r) => Number(r[1]))) === s24.summary.visits, "...adding up to the visits in the range");
    check((await hits(3)) === 7 && sum((await tableRows(3)).map((r) => Number(r[1]))) === s24.summary.visits, "how long visits last: 7 groups, adding up to the visits");
    const heavy = await tableRows(7);
    check(heavy.length === 2 && heavy.every((r) => r[0].length === 8), "heaviest users: one row per person, with a short id only");
    // look at it on a desktop and on a phone (build/usage)
    fs.mkdirSync(path.join(root, "build/usage"), { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(root, "build/usage/owner-desktop.png") });
    await page.setViewportSize({ width: 390, height: 800 });
    await sleep(400);
    await page.screenshot({ path: path.join(root, "build/usage/owner-phone.png") });
    check(await page.$eval("#owner", (d) => d.scrollWidth <= d.clientWidth), "the owner screen fits a phone's width (no sideways scrolling)");
    await page.setViewportSize({ width: 1000, height: 800 });

    // ---- older visits: the wider ranges show them, from the first visit on
    const old = db.prepare("INSERT INTO sessions (sid, id, started, last, secs, play, v, mode) VALUES (?, ?, ?, ?, ?, ?, '1.0.30', 'app')");
    const at = (daysAgo) => Date.now() - daysAgo * DAY;
    for (const [n, daysAgo, secs] of [[1, 3, 600], [2, 3, 120], [3, 40, 900], [4, 200, 60]]) {
        old.run("old-visit-" + n, "old-person-" + (n === 2 ? 1 : n), at(daysAgo), at(daysAgo), secs, secs / 2);
    }
    const [t7, t30, t1y, t24] = await Promise.all(["7d", "30d", "1y", "24h"].map(get));
    check(t7.summary.people === 3 && t30.summary.people === 3 && t1y.summary.people === 5 && t24.summary.people === 2, "ranges count the right people (24 hours 2, 7 days 3, 1 month 3, 1 year 5)");
    check(t1y.summary.newPeople === 5 && t30.summary.newPeople === 3, "new people are counted the first time ever");
    check(t7.buckets.length === 7 && t30.buckets.length === 30 && t1y.buckets[0].t <= t1y.since && t1y.since < t1y.buckets[0].t + WEEK, "the columns now reach back to the first visit and no further");
    // wait for something only the new range has (the summary's note and the chart's unit), not for a count the old range may share
    const inRange = (text) => until(async () => (await page.textContent(".ou-stat .ou-note")).includes(text) && !(await page.$eval(".ou-body", (b) => b.classList.contains("busy"))), 5000);
    await page.click(".ou-controls button:has-text('1 month')");
    check((await inRange("1 month")) && (await hits(1)) === 30 && /per day/.test(await caption()), "1 month draws 30 days");
    await page.click(".ou-controls button:has-text('1 year')");
    check((await inRange("1 year")) && (await hits(1)) === t1y.buckets.length && /per week/.test(await caption()), `1 year draws the weeks since the first visit (${t1y.buckets.length}), per week`);
    check(Number((await page.$$eval(".ou-stat .ou-num", (n) => n.map((x) => x.textContent)))[0]) === 5, "1 year: 5 people");
    await page.screenshot({ path: path.join(root, "build/usage/owner-year.png") });
    // every chart is a line over an area, not columns
    const kinds = await page.$$eval(".ou-chart", (cs) => cs.map((c) => ({ lines: c.querySelectorAll(".ou-line").length, areas: c.querySelectorAll(".ou-area").length, bars: c.querySelectorAll(".ou-bar").length })));
    check(kinds.length === 3 && kinds.every((k) => k.lines === 1 && k.areas === 1 && k.bars === 0), `all ${kinds.length} charts are lines with an area under them, no columns`);
    // the metric tabs show their totals for the range and move the chart
    const tabsText = await page.$$eval(".ou-metrics .ou-stat", (b) => b.map((x) => x.querySelector(".ou-label").textContent));
    check(tabsText.join() === "People,New people,Visits,Time in app,Time playing,Average visit", "the six metric tabs carry the range's totals");
    await page.click(".ou-close");

    // the key is kept on this device: next time it loads by itself; Forget removes it
    for (let i = 0; i < 7; i++) await page.click("#version");
    check(await until(async () => (await page.$$(".ou-stat")).length > 0, 5000), "the saved key is used next time (no typing)");
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
