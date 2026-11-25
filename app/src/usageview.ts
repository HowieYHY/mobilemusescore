// The owner's hidden screen: the numbers from the usage counter (tracker/worker.js), on a full screen of
// their own with views to switch between. It is opened by tapping the version line on the start screen
// seven times, and asks for the owner's key, which the counter checks; the key is not in the app, so
// anyone else who finds this screen sees only the box. The key is kept on this device only (the owner's),
// and can be forgotten from the screen. Every time shown is Singapore time (SGT), whatever the device's
// own time zone is.

import { USAGE_URL } from "./usage";

const KEY = "pocketscore.owner";
const PREFS = "pocketscore.owner.view";

type RangeName = "24h" | "7d" | "30d" | "1y";
type MetricName = "people" | "newPeople" | "visits" | "secs" | "play" | "avg";
type WhenName = "hour" | "weekday";
type WhoName = "all" | "others" | "mine";

interface Bucket { t: number; people: number; newPeople: number; visits: number; secs: number; play: number }
interface Slice { visits: number; people: number; secs: number }
interface Stats {
    now: number; range: RangeName; who: WhoName; installs: { mine: number; others: number }; unit: "hour" | "day" | "week"; size: number; start: number; since: number | null;
    total: { people: number; visits: number; hours: number };
    summary: { people: number; visits: number; secs: number; newPeople: number; avgSecs: number; medianSecs: number; avgPlaySecs: number };
    buckets: Bucket[];
    frequency: Record<string, number>;
    versions: Record<string, number>;
    modes: Record<string, number>;
    hourOfDay: Slice[];
    dayOfWeek: Slice[];
    visitLengths: number[];
    top: { who: string; mode: string; visits: number; secs: number; play: number; first: number; last: number; days: number }[];
}

// ---------------------------------------------------------------- Singapore time

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", ...o });
const fHour = fmt({ hour: "numeric", hour12: true });
const fDay = fmt({ day: "numeric", month: "short" });
const fDayLong = fmt({ weekday: "short", day: "numeric", month: "short" });
const fClock = fmt({ hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
const fWhen = fmt({ day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
const fYear = fmt({ day: "numeric", month: "short", year: "numeric" });
const DAY_MS = 86400000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) {
        e.className = cls;
    }
    if (text !== undefined) {
        e.textContent = text; // always text, never HTML
    }
    return e;
}
const svgEl = (tag: string, attrs: Record<string, string | number> = {}) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) {
        e.setAttribute(k, String(v));
    }
    return e;
};

// Under a minute: seconds. From a minute: minutes in quarter-minute steps (1.25 min, 2.5 min). From an
// hour: hours and whole minutes.
const trimmed = (n: number) => String(+n.toFixed(2));
export function fmtDuration(secs: number): string {
    if (Math.round(secs) < 60) {
        return Math.round(secs) + " s";
    }
    const quarters = Math.round(secs / 15) / 4;
    if (quarters < 60) {
        return trimmed(quarters) + " min";
    }
    const m = Math.round(secs / 60);
    return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min";
}
const whole = (n: number) => String(Math.round(n));
const count = (n: number) => Math.round(n).toLocaleString("en-SG");
const hourName = (k: number) => (k === 0 ? "12 am" : k < 12 ? k + " am" : k === 12 ? "12 pm" : k - 12 + " pm");
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LENGTHS = ["under 10 s", "10-30 s", "30-60 s", "1-5 min", "5-15 min", "15-30 min", "over 30 min"];

// ---------------------------------------------------------------- views

const RANGES: [RangeName, string][] = [["24h", "24 hours"], ["7d", "7 days"], ["30d", "1 month"], ["1y", "1 year"]];
const PER: Record<Stats["unit"], string> = { hour: "hour", day: "day", week: "week" };

// time metrics are held in seconds and drawn in seconds, minutes or hours, whichever reads best for the data
interface Metric { key: MetricName; label: string; title: string; time: boolean; get: (b: Bucket) => number }
const METRICS: Metric[] = [
    { key: "people", label: "People", title: "People who used it", time: false, get: (b) => b.people },
    { key: "newPeople", label: "New people", title: "People using it for the first time", time: false, get: (b) => b.newPeople },
    { key: "visits", label: "Visits", title: "Visits (each time the app was opened)", time: false, get: (b) => b.visits },
    { key: "secs", label: "Time in app", title: "Time in the app, all people together", time: true, get: (b) => b.secs },
    { key: "play", label: "Time playing", title: "Time music was playing, all people together", time: true, get: (b) => b.play },
    { key: "avg", label: "Average visit", title: "Average visit length", time: true, get: (b) => (b.visits ? b.secs / b.visits : 0) },
];
const timeUnit = (maxSecs: number) => (maxSecs < 60 ? { div: 1, name: "seconds" } : maxSecs < 36000 ? { div: 60, name: "minutes" } : { div: 3600, name: "hours" });
const oneDecimal = (n: number) => String(+n.toFixed(2));
const quarter = (n: number) => String(+(Math.round(n * 4) / 4).toFixed(2)); // time in minutes or hours: nearest quarter

interface View { range: RangeName; metric: MetricName; when: WhenName; who: WhoName }
function loadView(): View {
    const v: View = { range: "7d", metric: "people", when: "hour", who: "all" };
    try {
        const raw = JSON.parse(localStorage.getItem(PREFS) || "null");
        if (raw && RANGES.some(([k]) => k === raw.range)) v.range = raw.range;
        if (raw && METRICS.some((m) => m.key === raw.metric)) v.metric = raw.metric;
        if (raw && (raw.who === "all" || raw.who === "others")) v.who = raw.who;
        if (raw && (raw.when === "hour" || raw.when === "weekday")) v.when = raw.when;
    } catch { /* the defaults */ }
    return v;
}
function saveView(v: View) {
    try {
        localStorage.setItem(PREFS, JSON.stringify(v));
    } catch { /* not kept */ }
}

function segmented<T extends string>(label: string, options: [T, string][], current: T, onPick: (v: T) => void): HTMLElement {
    const g = el("div", "ou-seg");
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", label);
    for (const [value, text] of options) {
        const b = el("button", undefined, text);
        b.type = "button";
        b.setAttribute("aria-pressed", String(value === current));
        b.onclick = () => {
            g.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
            b.setAttribute("aria-pressed", "true");
            onPick(value);
        };
        g.append(b);
    }
    return g;
}

// ---------------------------------------------------------------- the line chart

function niceStep(max: number, integer: boolean): number {
    if (max <= 0) {
        return 1;
    }
    const raw = max / 3;
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
    return integer ? Math.max(1, Math.ceil(step)) : step;
}

/** A smooth path through the points that never overshoots them (monotone cubic, as d3's curveMonotoneX). */
function smoothPath(pts: [number, number][]): string {
    const n = pts.length;
    if (n === 1) {
        return `M${pts[0][0]},${pts[0][1]}`;
    }
    if (n === 2) {
        return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`;
    }
    const dx: number[] = [], m: number[] = [], t: number[] = [];
    for (let i = 0; i < n - 1; i++) {
        dx[i] = pts[i + 1][0] - pts[i][0];
        m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
    }
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) {
        t[i] = m[i - 1] * m[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
    }
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        d += `C${x0 + dx[i] / 3},${y0 + t[i] * dx[i] / 3} ${x1 - dx[i] / 3},${y1 - t[i + 1] * dx[i] / 3} ${x1},${y1}`;
    }
    return d;
}

interface ChartOpts {
    values: number[];
    axis: string[];       // the label under each point (only some are shown, so they never collide)
    tips: string[][];     // per point: the value first (strong), then what it is, then extras
    fmtY: (n: number) => string;
    integer: boolean;
    width: number;
    height: number;
    label: string;        // what a screen reader is told the chart is
    animate: boolean;     // the line draws itself in (not when only the width changed)
}

let gradients = 0;

/** One series as a thin line over a soft area, on one baseline, with a crosshair, a marker and a readout that
 *  follow the pointer (or keyboard focus) from point to point. Recessive grid. */
function lineChart(o: ChartOpts): HTMLElement {
    const wrap = el("div", "ou-chart" + (o.animate ? " draw" : ""));
    const W = Math.max(280, o.width), H = o.height;
    const L = o.integer ? 34 : 42, R = 12, T = 14, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const max = Math.max(0, ...o.values);
    const step = niceStep(max, o.integer);
    const top = Math.max(step, Math.ceil(max / step - 1e-9) * step);
    const n = o.values.length;
    // the first point sits on the left end of the baseline and the last on its right end (one point: in the middle)
    const xAt = (i: number) => (n === 1 ? L + pw / 2 : L + (pw * i) / (n - 1));
    const yAt = (v: number) => T + ph - (v / top) * ph;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": o.label });

    const gid = "ou-g" + ++gradients;
    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(svgEl("stop", { offset: "0%", class: "ou-stop-a" }), svgEl("stop", { offset: "100%", class: "ou-stop-b" }));
    defs.append(grad);
    svg.append(defs);

    for (let v = 0; v <= top + 1e-9; v += step) {
        const y = yAt(v);
        svg.append(svgEl("line", { x1: L, x2: W - R, y1: y, y2: y, class: v === 0 ? "ou-axis" : "ou-grid" }));
        const t = svgEl("text", { x: L - 8, y: y + 4, "text-anchor": "end", class: "ou-tick" });
        t.textContent = o.fmtY(Math.round(v * 1e6) / 1e6);
        svg.append(t);
    }
    // show every k-th label, k chosen from how wide the longest label is, so neighbours never touch
    const labelWidth = Math.max(...o.axis.map((a) => a.length)) * 6.4 + 18;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / labelWidth))));
    for (let i = 0; i < n; i += every) {
        const t = svgEl("text", { x: xAt(i), y: H - 7, "text-anchor": i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle", class: "ou-tick" });
        t.textContent = o.axis[i];
        svg.append(t);
    }

    const pts = o.values.map((v, i): [number, number] => [xAt(i), yAt(v)]);
    if (n > 1) {
        const line = smoothPath(pts);
        svg.append(svgEl("path", { d: `${line}L${pts[n - 1][0]},${T + ph}L${pts[0][0]},${T + ph}Z`, class: "ou-area", fill: `url(#${gid})` }));
        svg.append(svgEl("path", { d: line, class: "ou-line", pathLength: 1 }));
    }
    // a dot on every point while there are few, otherwise on the last and the highest
    const peak = o.values.indexOf(max);
    const dotted = new Set<number>(n <= 24 ? o.values.map((_, i) => i) : [n - 1, peak]);
    for (const i of dotted) {
        svg.append(svgEl("circle", { cx: pts[i][0], cy: pts[i][1], r: 4, class: "ou-dot" }));
    }

    // follows the pointer: a hairline at the point and a larger marker
    const cross = svgEl("line", { y1: T, y2: T + ph, class: "ou-cross" });
    const mark = svgEl("circle", { r: 5.5, class: "ou-mark" });
    cross.style.display = mark.style.display = "none";
    svg.append(cross, mark);

    const tip = el("div", "ou-tip");
    tip.hidden = true;
    const show = (i: number) => {
        cross.setAttribute("x1", String(xAt(i)));
        cross.setAttribute("x2", String(xAt(i)));
        mark.setAttribute("cx", String(pts[i][0]));
        mark.setAttribute("cy", String(pts[i][1]));
        cross.style.display = mark.style.display = "";
        tip.replaceChildren(el("strong", undefined, o.tips[i][0]), ...o.tips[i].slice(1).map((l) => el("span", undefined, l)));
        tip.hidden = false;
        tip.style.left = Math.max(0, Math.min(W - tip.offsetWidth, pts[i][0] - tip.offsetWidth / 2)) + "px";
        tip.style.top = Math.max(0, pts[i][1] - tip.offsetHeight - 14) + "px";
    };
    const hide = () => {
        cross.style.display = mark.style.display = "none";
        tip.hidden = true;
    };
    for (let i = 0; i < n; i++) {
        // the hit area runs from halfway to the previous point to halfway to the next, the whole height, so the nearest point is always the one chosen
        const x0 = i === 0 ? L : (xAt(i - 1) + xAt(i)) / 2;
        const x1 = i === n - 1 ? W - R : (xAt(i) + xAt(i + 1)) / 2;
        const hit = svgEl("rect", { x: x0, y: T, width: Math.max(1, x1 - x0), height: ph + B, class: "ou-hit", tabindex: 0, "aria-label": o.tips[i].join(", ") });
        hit.addEventListener("pointerenter", () => show(i));
        hit.addEventListener("pointermove", () => show(i));
        hit.addEventListener("pointerleave", hide);
        hit.addEventListener("focus", () => show(i));
        hit.addEventListener("blur", hide);
        svg.append(hit);
    }
    wrap.append(svg, tip);
    return wrap;
}

// ---------------------------------------------------------------- one section's frame, tables

function card(title: string, wide = false): { root: HTMLElement; head: HTMLElement; body: HTMLElement } {
    const root = el("section", "ou-card" + (wide ? " wide" : ""));
    const head = el("div", "ou-card-head");
    head.append(el("h3", undefined, title));
    const body = el("div", "ou-card-body");
    root.append(head, body);
    return { root, head, body };
}

function table(heads: string[], rows: string[][], cls = ""): HTMLElement {
    const wrap = el("div", "ou-table " + cls);
    const t = el("table");
    const thead = el("thead");
    const hr = el("tr");
    heads.forEach((h) => hr.append(el("th", undefined, h)));
    thead.append(hr);
    const tb = el("tbody");
    for (const r of rows) {
        const tr = el("tr");
        r.forEach((c) => tr.append(el("td", undefined, c)));
        tb.append(tr);
    }
    t.append(thead, tb);
    wrap.append(t);
    return wrap;
}

function tableToggle(t: HTMLElement): HTMLElement {
    const d = el("details", "ou-details");
    d.append(el("summary", undefined, "Table"), t);
    return d;
}

/** A list of labelled shares, each with a bar showing its part of the whole. */
function shares(data: [string, number][], empty = "Nothing yet."): HTMLElement {
    const box = el("div", "ou-shares");
    const sum = data.reduce((a, [, n]) => a + n, 0);
    if (!sum) {
        box.append(el("p", "ou-note", empty));
    }
    for (const [name, n] of data) {
        const row = el("div", "ou-share");
        const track = el("span", "ou-track");
        const bar = el("span", "ou-fill");
        bar.style.width = (sum ? Math.round(n / sum * 100) : 0) + "%";
        track.append(bar);
        row.append(el("span", "ou-share-name", name), track, el("span", "ou-n", sum ? `${n} (${Math.round(n / sum * 100)}%)` : "0"));
        box.append(row);
    }
    return box;
}

// ---------------------------------------------------------------- the screen

function bucketLabels(s: Stats, b: Bucket): { axis: string; long: string } {
    const d = new Date(b.t);
    if (s.unit === "hour") {
        return { axis: fHour.format(d), long: fDayLong.format(d) + ", " + fHour.format(d) + " to " + fHour.format(new Date(b.t + s.size)) };
    }
    if (s.unit === "day") {
        return { axis: fDay.format(d), long: fDayLong.format(d) };
    }
    return { axis: fDay.format(d), long: "Week of " + fDay.format(d) + " to " + fDay.format(new Date(b.t + 6 * DAY_MS)) };
}

let stopResize: (() => void) | null = null;

/** Opens the owner's screen in `dlg` (a <dialog>). Does nothing if no counter was built in. */
export function openOwnerScreen(dlg: HTMLDialogElement) {
    if (!USAGE_URL) {
        return;
    }
    const body = dlg.querySelector<HTMLElement>(".ou-body")!;
    const msg = dlg.querySelector<HTMLElement>(".ou-msg")!;
    const keyBox = dlg.querySelector<HTMLInputElement>(".ou-key")!;
    const keyRow = dlg.querySelector<HTMLElement>(".ou-keyrow")!;
    const controls = dlg.querySelector<HTMLElement>(".ou-controls")!;
    const refresh = dlg.querySelector<HTMLButtonElement>(".ou-refresh")!;
    const forget = dlg.querySelector<HTMLButtonElement>(".ou-forget")!;
    const view = loadView();
    let saved = "";
    try {
        saved = localStorage.getItem(KEY) || "";
    } catch { /* the key then has to be typed each time */ }
    let key = saved;
    let last: Stats | null = null;
    let seq = 0;
    const redraws: (() => void)[] = [];
    let anim = true;

    const redrawAll = () => redraws.forEach((r) => r());

    // ---- the screen's parts, built again for each answer from the counter
    function build(s: Stats) {
        last = s;
        anim = true; // the lines draw themselves in once per answer, not when only the width changes
        redraws.length = 0;
        body.replaceChildren();
        const sm = s.summary;
        const rangeText = RANGES.find(([k]) => k === s.range)![1];

        if (!s.buckets.length) {
            body.append(el("p", "ou-empty", "No visits have been counted yet. Open the app (with sharing on) and refresh."));
            return;
        }

        body.append(el("p", "ou-alltime", `All time${s.who === "all" ? "" : " (without your own visits)"}: ${count(s.total.people)} people, ${count(s.total.visits)} visits, ${s.total.hours.toFixed(1)} hours` + (s.since ? `, since ${fYear.format(new Date(s.since))}` : "") + "." + (s.installs.mine ? ` ${s.installs.mine} of the installs ${s.installs.mine === 1 ? "is" : "are"} yours.` : " None of the installs are marked as yours yet: opening this screen on a device marks it.")));

        const grid = el("div", "ou-cards");
        body.append(grid);
        const inner = (c: { body: HTMLElement }) => c.body.clientWidth || 520;

        // ---- over time: each metric's total for the range is a tab that picks what the line shows
        const time = card("Over time", true);
        time.root.classList.add("hero");
        time.head.classList.add("ou-sr");
        const totalPlay = s.buckets.reduce((a, b) => a + b.play, 0);
        const figures: Record<MetricName, [string, string | undefined]> = {
            people: [count(sm.people), "in the last " + rangeText],
            newPeople: [count(sm.newPeople), "first time ever"],
            visits: [count(sm.visits), sm.people ? (sm.visits / sm.people).toFixed(1) + " per person" : undefined],
            secs: [fmtDuration(sm.secs), "all people together"],
            play: [fmtDuration(totalPlay), sm.visits ? fmtDuration(sm.avgPlaySecs) + " per visit" : undefined],
            avg: [fmtDuration(sm.avgSecs), "median " + fmtDuration(sm.medianSecs)],
        };
        const tabs = el("div", "ou-metrics");
        tabs.setAttribute("role", "group");
        tabs.setAttribute("aria-label", "What to chart");
        const timeChart = el("div", "ou-chartbox");
        const drawTime = () => {
            const m = METRICS.find((x) => x.key === view.metric)!;
            const per = PER[s.unit];
            const labels = s.buckets.map((b) => bucketLabels(s, b));
            const raw = s.buckets.map(m.get);
            const u = m.time ? timeUnit(Math.max(0, ...raw)) : { div: 1, name: "" };
            const chart = lineChart({
                values: raw.map((v) => v / u.div),
                axis: labels.map((l) => l.axis),
                tips: s.buckets.map((b, i) => [
                    m.time ? fmtDuration(raw[i]) : whole(raw[i]),
                    m.label + " · " + labels[i].long,
                    `${b.people} people, ${b.newPeople} new, ${b.visits} visits`,
                    `${fmtDuration(b.secs)} in app, ${fmtDuration(b.play)} playing`,
                ]),
                fmtY: m.time && u.div > 1 ? quarter : oneDecimal, integer: !m.time || u.div === 1, width: inner(time), height: 270, animate: anim,
                label: `${m.title}${u.name ? ", in " + u.name : ""}, per ${per}, ${rangeText}`,
            });
            const t = table(["When (SGT)", "People", "New", "Visits", "Time in app", "Playing"],
                [...s.buckets].reverse().map((b, i) => [labels[s.buckets.length - 1 - i].long, String(b.people), String(b.newPeople), String(b.visits), fmtDuration(b.secs), fmtDuration(b.play)]), "scroll");
            timeChart.replaceChildren(el("p", "ou-note ou-cap", `${m.title}${u.name ? ", in " + u.name : ""}, per ${per}${s.buckets.length < (s.unit === "hour" ? 24 : s.unit === "day" ? (s.range === "7d" ? 7 : 30) : 52) ? " (starting from the first visit)" : ""}`), chart, tableToggle(t));
        };
        for (const m of METRICS) {
            const b = el("button", "ou-stat");
            b.type = "button";
            b.setAttribute("aria-pressed", String(m.key === view.metric));
            b.append(el("span", "ou-label", m.label), el("span", "ou-num", figures[m.key][0]));
            if (figures[m.key][1]) {
                b.append(el("span", "ou-note", figures[m.key][1]));
            }
            b.onclick = () => {
                tabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
                b.setAttribute("aria-pressed", "true");
                view.metric = m.key;
                saveView(view);
                anim = true;
                drawTime();
                anim = false;
            };
            tabs.append(b);
        }
        time.body.append(tabs, timeChart);
        redraws.push(drawTime);
        grid.append(time.root);

        // ---- when people use it
        const when = card("When people use it");
        when.root.classList.add("half");
        const whenChart = el("div", "ou-chartbox");
        const drawWhen = () => {
            const hours = view.when === "hour";
            const data = hours ? s.hourOfDay : s.dayOfWeek;
            const names = hours ? data.map((_, k) => hourName(k)) : WEEKDAYS;
            const chart = lineChart({
                values: data.map((x) => x.visits),
                axis: hours ? data.map((_, k) => hourName(k)) : WEEKDAYS,
                tips: data.map((x, i) => [`${x.visits} visits`, hours ? names[i] + " to " + hourName((i + 1) % 24) + " (SGT)" : names[i] + " (SGT)", `${x.people} people, ${fmtDuration(x.secs)} in app`]),
                fmtY: whole, integer: true, width: inner(when), height: 210, animate: anim,
                label: `Visits by ${hours ? "hour of the day" : "day of the week"}, Singapore time`,
            });
            whenChart.replaceChildren(el("p", "ou-note ou-cap", `Visits by ${hours ? "hour of the day" : "day of the week"}, Singapore time, in the last ${rangeText}`), chart,
                tableToggle(table([hours ? "Hour (SGT)" : "Day", "Visits", "People", "Time in app"], data.map((x, i) => [names[i], String(x.visits), String(x.people), fmtDuration(x.secs)]), "scroll")));
        };
        when.head.append(segmented("Group by", [["hour", "Hour of day"], ["weekday", "Day of week"]] as [WhenName, string][], view.when, (v) => {
            view.when = v;
            saveView(view);
            anim = true;
            drawWhen();
            anim = false;
        }));
        when.body.append(whenChart);
        redraws.push(drawWhen);
        grid.append(when.root);

        // ---- how long visits last
        const lens = card("How long visits last");
        lens.root.classList.add("half");
        const drawLens = () => {
            lens.body.replaceChildren(el("p", "ou-note ou-cap", "Visits by how long they lasted, in the last " + rangeText), lineChart({
                values: s.visitLengths,
                axis: LENGTHS,
                tips: s.visitLengths.map((n, i) => [`${n} visits`, LENGTHS[i]]),
                fmtY: whole, integer: true, width: inner(lens), height: 210, animate: anim,
                label: "Number of visits by how long they lasted",
            }), tableToggle(table(["Length", "Visits"], LENGTHS.map((l, i) => [l, String(s.visitLengths[i])]), "scroll")));
        };
        redraws.push(drawLens);
        grid.append(lens.root);

        // ---- coming back, where from, which version: three short lists side by side
        const back = card("How often people came back");
        back.root.classList.add("third");
        back.body.append(el("p", "ou-note", "Different days each person used it (SGT), in the last " + rangeText), shares(Object.entries(s.frequency)));
        grid.append(back.root);
        const dev = card("Installed app or browser");
        dev.root.classList.add("third");
        dev.body.append(el("p", "ou-note", "Where each person last used it"), shares(Object.entries(s.modes).map(([k, n]): [string, number] => [k === "app" ? "Installed app" : "Browser tab", n])));
        grid.append(dev.root);
        const ver = card("Version last used");
        ver.root.classList.add("third");
        ver.body.append(el("p", "ou-note", "Each person's latest version"), shares(Object.entries(s.versions).sort((a, b) => b[1] - a[1])));
        grid.append(ver.root);

        // ---- heaviest users
        const who = card("Heaviest users", true);
        who.body.append(el("p", "ou-note", "The 15 installs with the most time in the app in this range. A short piece of each install's random number, nothing that names anyone."),
            table(["Install", "Where", "Visits", "Days", "Time in app", "Playing", "First (in range)", "Last"],
                s.top.map((t) => [t.who, t.mode === "app" ? "installed app" : "browser", String(t.visits), String(t.days), fmtDuration(t.secs), fmtDuration(t.play), fWhen.format(new Date(t.first)), fWhen.format(new Date(t.last))]), "scroll who"));
        grid.append(who.root);

        body.append(el("p", "ou-note ou-foot", "All times are Singapore time (SGT, UTC+8). A person is one install on one device, so someone with two devices counts twice, and someone who clears their browser data counts again. The counter only knows about people who have sharing on."));
        redrawAll();
        anim = false;
    }

    async function load(k: string) {
        const mine = ++seq;
        msg.textContent = "Loading…";
        body.classList.add("busy"); // the last picture stays, dimmed, until the new one is ready
        try {
            const res = await fetch(USAGE_URL + "/stats?range=" + view.range + "&who=" + view.who, { headers: { authorization: "Bearer " + k }, cache: "no-store" });
            if (mine !== seq) {
                return;
            }
            if (res.status === 401) {
                msg.textContent = "That key was not accepted.";
                key = "";
                keyRow.hidden = false;
                controls.hidden = true;
                forget.hidden = true;
                refresh.hidden = true;
                body.replaceChildren();
                try {
                    localStorage.removeItem(KEY);
                } catch { /* nothing to remove */ }
                return;
            }
            if (!res.ok) {
                throw new Error(String(res.status));
            }
            const stats = (await res.json()) as Stats;
            if (mine !== seq) {
                return;
            }
            key = k;
            try {
                localStorage.setItem(KEY, k);
            } catch { /* typed again next time */ }
            msg.textContent = "Updated " + fClock.format(new Date()) + " SGT";
            keyRow.hidden = true;
            controls.hidden = false;
            forget.hidden = false;
            refresh.hidden = false;
            build(stats);
        } catch {
            if (mine === seq) {
                msg.textContent = "Couldn't reach the counter. Check the connection and try again.";
            }
        } finally {
            if (mine === seq) {
                body.classList.remove("busy");
            }
        }
    }

    // ---- the controls that scope everything (range), above all the views
    controls.replaceChildren(segmented("Time range", RANGES, view.range, (v) => {
        view.range = v;
        saveView(view);
        void load(key);
    }));
    // one tick to leave the owner's own devices out of every figure
    const tick = el("label", "ou-tick");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = view.who === "others";
    box.onchange = () => {
        view.who = box.checked ? "others" : "all";
        saveView(view);
        void load(key);
    };
    tick.append(box, document.createTextNode(" Leave out my own visits"));
    controls.append(tick);
    controls.hidden = true;

    keyBox.value = "";
    keyRow.hidden = !!saved;
    forget.hidden = !saved;
    refresh.hidden = !saved;
    msg.textContent = saved ? "" : "Enter your key.";
    body.replaceChildren();
    const go = dlg.querySelector<HTMLButtonElement>(".ou-go")!;
    go.onclick = () => {
        if (keyBox.value.trim()) {
            void load(keyBox.value.trim());
        }
    };
    keyBox.onkeydown = (e) => {
        if (e.key === "Enter") {
            go.click();
        }
    };
    refresh.onclick = () => void load(key);
    forget.onclick = () => {
        try {
            localStorage.removeItem(KEY);
        } catch { /* nothing to remove */ }
        saved = key = "";
        seq++;
        body.replaceChildren();
        controls.hidden = true;
        keyRow.hidden = false;
        forget.hidden = true;
        refresh.hidden = true;
        msg.textContent = "Key forgotten on this device.";
    };
    dlg.querySelector<HTMLButtonElement>(".ou-close")!.onclick = () => dlg.close();

    // charts are drawn to the width they have, so a turned phone or a resized window draws them again
    stopResize?.();
    let timer = 0;
    const onResize = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => last && redrawAll(), 150);
    };
    window.addEventListener("resize", onResize);
    stopResize = () => {
        window.removeEventListener("resize", onResize);
        clearTimeout(timer);
        stopResize = null;
    };
    dlg.addEventListener("close", () => stopResize?.(), { once: true });

    dlg.showModal();
    dlg.tabIndex = -1;
    dlg.focus(); // not the first button, which would show a focus ring on opening
    if (saved) {
        void load(saved);
    }
}
