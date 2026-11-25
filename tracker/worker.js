// PocketScore's private usage counter (a Cloudflare Worker with a D1 database).
//   POST /ping   the app's anonymous heartbeat (no key: anyone's copy of the app may send it)
//   GET  /stats  the numbers, only with `Authorization: Bearer <STATS_KEY>` (the owner's key, a secret
//                set with `wrangler secret put STATS_KEY`; it is never in the app)
// Stored: a random install id, a random visit id, version, installed-or-browser, seconds in front and
// seconds of playing. Not stored: IP address, score names, files, notes.

const ID = /^[a-z0-9-]{8,40}$/;
const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
};
const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" } });

function sameKey(a, b) {
    // not a quick-exit compare, so the time taken doesn't tell how much of a guess was right
    const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
    let d = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        d |= (x[i] || 0) ^ (y[i] || 0);
    }
    return d === 0;
}

async function ping(req, env) {
    const text = await req.text();
    if (text.length > 600) {
        return json({ error: "too big" }, 413);
    }
    let b;
    try {
        b = JSON.parse(text);
    } catch {
        return json({ error: "bad json" }, 400);
    }
    if (!b || typeof b.id !== "string" || typeof b.sid !== "string" || !ID.test(b.id) || !ID.test(b.sid)) {
        return json({ error: "bad ids" }, 400);
    }
    const clamp = (n) => Math.max(0, Math.min(86400, Math.floor(Number(n) || 0)));
    const v = String(b.v || "").replace(/[^0-9a-z.\-]/gi, "").slice(0, 16) || "?";
    const mode = b.mode === "app" ? "app" : "tab";
    const now = Date.now();
    await env.DB.prepare(
        `INSERT INTO sessions (sid, id, started, last, secs, play, v, mode) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(sid) DO UPDATE SET last = ?3, secs = MAX(secs, ?4), play = MAX(play, ?5)`,
    ).bind(b.sid, b.id, now, clamp(b.secs), clamp(b.play), v, mode).run();
    return json({ ok: true });
}

const DAY = 86400000;
const LIMIT = 60000;

async function stats(env) {
    const off = (Number(env.TZ_OFFSET_HOURS) || 0) * 3600000;
    const dayOf = (ms) => new Date(ms + off).toISOString().slice(0, 10);
    const now = Date.now();
    const today = dayOf(now);
    const [rows, all, firsts] = await env.DB.batch([
        env.DB.prepare("SELECT id, started, secs, play, v, mode FROM sessions WHERE started >= ?1 ORDER BY started LIMIT ?2").bind(now - 90 * DAY, LIMIT),
        env.DB.prepare("SELECT COUNT(DISTINCT id) AS installs, COUNT(*) AS sessions, COALESCE(SUM(secs), 0) AS secs, MIN(started) AS first FROM sessions"),
        env.DB.prepare("SELECT id, MIN(started) AS f FROM sessions GROUP BY id"),
    ]);
    const ss = rows.results.map((r) => ({ ...r, day: dayOf(r.started) }));
    // the day each install was first seen (over everything, not only the last 90 days)
    const firstSeen = new Map(firsts.results.map((r) => [r.id, dayOf(r.f)]));

    const days = [];
    for (let i = 29; i >= 0; i--) {
        days.push(dayOf(now - i * DAY));
    }
    const perDay = new Map(days.map((d) => [d, { users: new Set(), sessions: 0, secs: 0, play: 0, fresh: new Set() }]));
    for (const s of ss) {
        const p = perDay.get(s.day);
        if (p) {
            p.users.add(s.id);
            p.sessions++;
            p.secs += s.secs;
            p.play += s.play;
            if (firstSeen.get(s.id) === s.day) {
                p.fresh.add(s.id);
            }
        }
    }
    const daily = days.map((d) => {
        const p = perDay.get(d);
        return { day: d, users: p.users.size, newUsers: p.fresh.size, sessions: p.sessions, secs: p.secs, play: p.play };
    });

    const distinct = (fromMs) => new Set(ss.filter((s) => s.started >= fromMs).map((s) => s.id)).size;
    const last30 = ss.filter((s) => s.started >= now - 30 * DAY);
    const lens = last30.map((s) => s.secs).sort((a, b) => a - b);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    // how often each install came back: the number of different days it was used in 30 days
    const daysUsed = new Map();
    for (const s of last30) {
        if (!daysUsed.has(s.id)) {
            daysUsed.set(s.id, new Set());
        }
        daysUsed.get(s.id).add(s.day);
    }
    const frequency = { "1 day": 0, "2-3 days": 0, "4-7 days": 0, "8+ days": 0 };
    for (const set of daysUsed.values()) {
        const n = set.size;
        frequency[n === 1 ? "1 day" : n <= 3 ? "2-3 days" : n <= 7 ? "4-7 days" : "8+ days"]++;
    }

    // installs by the version / mode they used last, in 30 days
    const count = (key) => {
        const latest = new Map();
        for (const s of last30) {
            latest.set(s.id, s[key]);
        }
        const out = {};
        for (const v of latest.values()) {
            out[v] = (out[v] || 0) + 1;
        }
        return out;
    };

    return {
        now, today, tzOffsetHours: Number(env.TZ_OFFSET_HOURS) || 0,
        total: { installs: all.results[0].installs, sessions: all.results[0].sessions, hours: all.results[0].secs / 3600, since: all.results[0].first },
        active: { today: new Set(ss.filter((s) => s.day === today).map((s) => s.id)).size, d7: distinct(now - 7 * DAY), d30: distinct(now - 30 * DAY) },
        session: { avgSecs: avg(lens), medianSecs: lens.length ? lens[Math.floor(lens.length / 2)] : 0, avgPlaySecs: avg(last30.map((s) => s.play)), n: lens.length },
        frequency,
        versions: count("v"),
        modes: count("mode"),
        daily,
        truncated: rows.results.length >= LIMIT,
    };
}

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS });
        }
        try {
            if (url.pathname === "/ping" && req.method === "POST") {
                return await ping(req, env);
            }
            if (url.pathname === "/stats" && req.method === "GET") {
                const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
                if (!env.STATS_KEY || !sameKey(given, env.STATS_KEY)) {
                    return json({ error: "wrong key" }, 401);
                }
                return json(await stats(env));
            }
        } catch {
            return json({ error: "server error" }, 500);
        }
        return json({ error: "not found" }, 404);
    },
};
