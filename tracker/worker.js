// PocketScore's private usage counter (a Cloudflare Worker with a D1 database).
//   POST /ping   the app's anonymous heartbeat (no key: anyone's copy of the app may send it). A copy that also
//                sends the owner's key marks its install as the owner's own (`own`), so the owner's visits can be
//                told from everyone else's
//   GET  /stats?range=24h|7d|30d|1y&who=all|others|mine  the numbers (times in Singapore time), only with `Authorization: Bearer <STATS_KEY>` (the owner's key, a secret
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
    if (text.length > 900) {
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
    // the owner's own key (typed once on their screen, kept on their device) marks the visit as theirs
    const own = typeof b.k === "string" && b.k.length <= 200 && env.STATS_KEY && sameKey(b.k, env.STATS_KEY) ? 1 : 0;
    await env.DB.prepare(
        `INSERT INTO sessions (sid, id, started, last, secs, play, v, mode, own) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(sid) DO UPDATE SET last = ?3, secs = MAX(secs, ?4), play = MAX(play, ?5), own = MAX(own, ?8)`,
    ).bind(b.sid, b.id, now, clamp(b.secs), clamp(b.play), v, mode, own).run();
    return json({ ok: true });
}

// Everything the owner sees is in Singapore time (SGT, UTC+8, no daylight saving): the buckets below
// start at SGT midnights and hours, whatever time zone the owner's phone is in.
const SGT = 8 * 3600000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const RANGES = {
    "24h": { unit: "hour", size: HOUR, count: 24 },
    "7d": { unit: "day", size: DAY, count: 7 },
    "30d": { unit: "day", size: DAY, count: 30 },
    "1y": { unit: "week", size: WEEK, count: 52 }, // weeks start on Monday
};

/** Start of the first bucket of a range: the range ends with the bucket that holds `now`. */
function rangeStart(now, r) {
    const x = now + SGT;
    // 1 Jan 1970 was a Thursday, so a Monday is 4 days on
    const current = r.unit === "week" ? Math.floor((x - 4 * DAY) / WEEK) * WEEK + 4 * DAY - SGT : Math.floor(x / r.size) * r.size - SGT;
    return current - (r.count - 1) * r.size;
}

async function stats(env, rangeName, whoName) {
    const range = RANGES[rangeName] ? rangeName : "7d";
    const r = RANGES[range];
    const now = Date.now();
    const start = rangeStart(now, r);
    // whose visits: an install is the owner's once any of its visits carried the owner's key (so earlier
    // visits from it count as the owner's too)
    const who = whoName === "mine" || whoName === "others" ? whoName : "all";
    const MINE = "id IN (SELECT id FROM sessions WHERE own = 1)";
    const F = who === "mine" ? " AND " + MINE : who === "others" ? " AND NOT " + MINE : "";
    const W = " WHERE 1 = 1" + F; // for the queries that have no WHERE of their own
    const [per, news, sum, med, freq, vers, modes, all, hod, dow, lens, top, mineN, allN] = await env.DB.batch([
        // per bucket: people, visits, seconds in front, seconds playing
        env.DB.prepare("SELECT CAST((started - ?1) / ?2 AS INTEGER) AS b, COUNT(DISTINCT id) AS people, COUNT(*) AS visits, SUM(secs) AS secs, SUM(play) AS play FROM sessions WHERE started >= ?1" + F + " GROUP BY b").bind(start, r.size),
        // per bucket: people seen for the first time ever
        env.DB.prepare("SELECT CAST((f - ?1) / ?2 AS INTEGER) AS b, COUNT(*) AS n FROM (SELECT MIN(started) AS f FROM sessions" + W + " GROUP BY id) WHERE f >= ?1 GROUP BY b").bind(start, r.size),
        env.DB.prepare("SELECT COUNT(DISTINCT id) AS people, COUNT(*) AS visits, COALESCE(SUM(secs), 0) AS secs, COALESCE(AVG(secs), 0) AS avgSecs, COALESCE(AVG(play), 0) AS avgPlay FROM sessions WHERE started >= ?1" + F).bind(start),
        env.DB.prepare("SELECT secs FROM sessions WHERE started >= ?1" + F + " ORDER BY secs LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM sessions WHERE started >= ?1" + F + ")").bind(start),
        // how many different (SGT) days each person came on
        env.DB.prepare("SELECT days, COUNT(*) AS n FROM (SELECT COUNT(DISTINCT CAST((started + ?2) / 86400000 AS INTEGER)) AS days FROM sessions WHERE started >= ?1" + F + " GROUP BY id) GROUP BY days").bind(start, SGT),
        // each person's latest version and mode in the range
        env.DB.prepare("SELECT v AS k, COUNT(*) AS n FROM (SELECT v, MAX(started) FROM sessions WHERE started >= ?1" + F + " GROUP BY id) GROUP BY v").bind(start),
        env.DB.prepare("SELECT mode AS k, COUNT(*) AS n FROM (SELECT mode, MAX(started) FROM sessions WHERE started >= ?1" + F + " GROUP BY id) GROUP BY mode").bind(start),
        env.DB.prepare("SELECT COUNT(DISTINCT id) AS people, COUNT(*) AS visits, COALESCE(SUM(secs), 0) AS secs, MIN(started) AS since FROM sessions" + W),
        // when people use it: by SGT hour of the day (0-23) and SGT day of the week (0 = Monday)
        env.DB.prepare("SELECT CAST(((started + ?2) / 3600000) % 24 AS INTEGER) AS k, COUNT(*) AS visits, COUNT(DISTINCT id) AS people, SUM(secs) AS secs FROM sessions WHERE started >= ?1" + F + " GROUP BY k").bind(start, SGT),
        env.DB.prepare("SELECT CAST((((started + ?2) / 86400000) + 3) % 7 AS INTEGER) AS k, COUNT(*) AS visits, COUNT(DISTINCT id) AS people, SUM(secs) AS secs FROM sessions WHERE started >= ?1" + F + " GROUP BY k").bind(start, SGT),
        // how long visits last
        env.DB.prepare("SELECT CASE WHEN secs < 10 THEN 0 WHEN secs < 30 THEN 1 WHEN secs < 60 THEN 2 WHEN secs < 300 THEN 3 WHEN secs < 900 THEN 4 WHEN secs < 1800 THEN 5 ELSE 6 END AS k, COUNT(*) AS n FROM sessions WHERE started >= ?1" + F + " GROUP BY k").bind(start),
        // the heaviest installs in the range (a short piece of the random id, nothing that names anyone)
        env.DB.prepare("SELECT substr(id, 1, 8) AS who, MAX(mode) AS mode, COUNT(*) AS visits, SUM(secs) AS secs, SUM(play) AS play, MIN(started) AS first, MAX(started) AS last, COUNT(DISTINCT CAST((started + ?2) / 86400000 AS INTEGER)) AS days FROM sessions WHERE started >= ?1" + F + " GROUP BY id ORDER BY secs DESC LIMIT 15").bind(start, SGT),
        // how many installs are the owner's and how many are everyone else's (all time)
        env.DB.prepare("SELECT COUNT(DISTINCT id) AS n FROM sessions WHERE " + MINE),
        env.DB.prepare("SELECT COUNT(DISTINCT id) AS n FROM sessions WHERE NOT " + MINE),
    ]);
    const since = all.results[0].since;
    const byB = new Map(per.results.map((x) => [x.b, x]));
    const newByB = new Map(news.results.map((x) => [x.b, x.n]));
    const buckets = [];
    for (let i = 0; i < r.count; i++) {
        const t = start + i * r.size;
        if (since === null || t + r.size <= since) {
            continue; // nothing was being counted yet: no empty history before the first visit
        }
        const x = byB.get(i);
        buckets.push({ t, people: x ? x.people : 0, newPeople: newByB.get(i) || 0, visits: x ? x.visits : 0, secs: x ? x.secs : 0, play: x ? x.play : 0 });
    }
    const frequency = { "1 day": 0, "2-3 days": 0, "4-7 days": 0, "8-30 days": 0, "31+ days": 0 };
    for (const { days, n } of freq.results) {
        frequency[days <= 1 ? "1 day" : days <= 3 ? "2-3 days" : days <= 7 ? "4-7 days" : days <= 30 ? "8-30 days" : "31+ days"] += n;
    }
    const fill = (rows, n, pick) => {
        const out = Array.from({ length: n }, () => pick(null));
        for (const x of rows.results) {
            out[x.k] = pick(x);
        }
        return out;
    };
    const tally = (rows) => Object.fromEntries(rows.results.map((x) => [x.k, x.n]));
    return {
        now, range, who, installs: { mine: mineN.results[0].n, others: allN.results[0].n }, unit: r.unit, size: r.size, start, since,
        total: { people: all.results[0].people, visits: all.results[0].visits, hours: all.results[0].secs / 3600 },
        summary: {
            people: sum.results[0].people, visits: sum.results[0].visits, secs: sum.results[0].secs,
            newPeople: [...newByB.values()].reduce((a, b) => a + b, 0),
            avgSecs: sum.results[0].avgSecs, medianSecs: med.results[0] ? med.results[0].secs : 0, avgPlaySecs: sum.results[0].avgPlay,
        },
        buckets, frequency, versions: tally(vers), modes: tally(modes),
        hourOfDay: fill(hod, 24, (x) => ({ visits: x ? x.visits : 0, people: x ? x.people : 0, secs: x ? x.secs : 0 })),
        dayOfWeek: fill(dow, 7, (x) => ({ visits: x ? x.visits : 0, people: x ? x.people : 0, secs: x ? x.secs : 0 })),
        visitLengths: fill(lens, 7, (x) => (x ? x.n : 0)),
        top: top.results,
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
                return json(await stats(env, url.searchParams.get("range"), url.searchParams.get("who")));
            }
        } catch {
            return json({ error: "server error" }, 500);
        }
        return json({ error: "not found" }, 404);
    },
};
