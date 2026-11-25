// Shows the owner's usage screen with MADE-UP data, to look at in a browser: the real Worker code on an
// SQLite stand-in for D1, filled with ~200 days of invented visits, and the dev server pointed at it.
// Nothing here touches the real counter or anyone's data; it runs on 127.0.0.1 (its own storage).
//
// Usage: node scripts/usage-demo.mjs        then open http://127.0.0.1:5193/ , tap the version line 7 times,
//        key: demo-key . Ctrl+C stops it.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { default: worker } = await import("../tracker/worker.js");

const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(root, "tracker/schema.sql"), "utf8"));
const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { db.prepare(sql).run(...args); return {}; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
});
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.all())) }, STATS_KEY: "demo-key" };

// ---- invented visits: growing over 200 days, busier in the evening (SGT) and on weekdays
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const HOUR = 3600000, DAY = 24 * HOUR, SGT = 8 * HOUR, now = Date.now();
const insert = db.prepare("INSERT INTO sessions (sid, id, started, last, secs, play, v, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const people = [];
for (let i = 0; i < 140; i++) {
    const joined = Math.floor(200 * Math.pow(rnd(), 0.6)); // more people joined recently
    // like a real install id: random at the front, which is the part the screen shows
    people.push({ id: Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, "0") + "-demo-" + i.toString().padStart(3, "0"), joined, app: rnd() < 0.4, keen: 0.05 + rnd() * rnd() * 0.9 });
}
const HOURS_W = [1, 1, 0.5, 0.3, 0.3, 0.3, 0.6, 1.2, 1.5, 1.5, 1.4, 1.5, 2, 1.6, 1.5, 1.6, 1.8, 2.2, 2.8, 3.4, 3.8, 3.2, 2.2, 1.4];
const pickHour = () => { const t = HOURS_W.reduce((a, b) => a + b); let r = rnd() * t; for (let h = 0; h < 24; h++) { r -= HOURS_W[h]; if (r <= 0) return h; } return 20; };
let n = 0;
for (const p of people) {
    for (let d = p.joined; d >= 0; d--) {
        const day = Math.floor((now + SGT) / DAY) - d;
        const dow = (day + 3) % 7; // 0 = Monday
        const chance = p.keen * (dow >= 5 ? 0.6 : 1) * (d === p.joined ? 20 : 1);
        if (rnd() > chance) continue;
        const started = day * DAY - SGT + pickHour() * HOUR + Math.floor(rnd() * HOUR);
        if (started > now) continue;
        const secs = Math.round(Math.exp(3.2 + rnd() * 3.6)); // ~25 s to ~15 min, a few long
        const play = Math.round(secs * rnd() * 0.8);
        const v = d > 120 ? "1.0.30" : d > 60 ? "1.0.32" : d > 20 ? "1.0.33" : "1.0.34";
        insert.run("demo-visit-" + n++, p.id, started, started + secs * 1000, secs, play, v, p.app ? "app" : "tab");
    }
}
console.log("made-up visits:", n, "from", people.length, "people");

const counter = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request("http://127.0.0.1:8798" + req.url, {
        method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
});
counter.listen(8798, "127.0.0.1");

const e = { ...process.env, VITE_USAGE_URL: "http://127.0.0.1:8798" };
const vite = spawn("npx.cmd", ["vite", "--port", "5193", "--strictPort", "--host", "127.0.0.1"], { cwd: path.join(root, "app"), env: e, shell: true, stdio: "ignore" });
process.on("SIGINT", () => { spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { stdio: "ignore" }); process.exit(0); });
console.log("open http://127.0.0.1:5193/ , tap the version line 7 times, key: demo-key");
