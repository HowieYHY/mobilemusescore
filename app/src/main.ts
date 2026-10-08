import { Engine } from "./engine/engine";
import type { CursorInfo, ScoreInfo, SoundList, SoundNode, TrackInfo, ViewMode } from "./engine/protocol";
import { CSS_PX_PER_INCH, UNITS_PER_INCH, drawPage, ensureFonts, ensureImages } from "./render/pagerenderer";
import { Annotations, COLORS, MORE_COLORS, type Tool } from "./annotations";
import { MixStore, mixOf, sameMix, slot, type Mix } from "./mixerstore";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
    fileInput: $<HTMLInputElement>("file-input"),
    title: $("score-title"),
    viewMode: $<HTMLSelectElement>("view-mode"),
    status: $("status"),
    viewer: $("viewer"),
    empty: $("empty"),
    pages: $("pages"),
    zoomIn: $<HTMLButtonElement>("zoom-in"),
    zoomOut: $<HTMLButtonElement>("zoom-out"),
    zoomLabel: $("zoom-label"),
    rewind: $<HTMLButtonElement>("rewind"),
    play: $<HTMLButtonElement>("play"),
    seek: $<HTMLInputElement>("seek"),
    time: $("time"),
    bar: $("bar"),
    duration: $("duration"),
    mixerToggle: $<HTMLButtonElement>("mixer-toggle"),
    mixer: $("mixer"),
    mixerBody: $("mixer-body"),
    mixerClose: $<HTMLButtonElement>("mixer-close"),
    mixerReverb: $<HTMLButtonElement>("mixer-reverb"),
    save: $<HTMLButtonElement>("save"),
    ask: $<HTMLDialogElement>("ask"),
    sizes: $("sizes"),
    sounds: $("sounds"),
    soundsTitle: $("sounds-title"),
    soundsMany: $<HTMLButtonElement>("sounds-many"),
    soundsBody: $("sounds-body"),
    soundsBack: $<HTMLButtonElement>("sounds-back"),
    notesToggle: $<HTMLButtonElement>("notes-toggle"),
    notesbar: $("notesbar"),
    swatches: $("swatches"),
    notesUndo: $<HTMLButtonElement>("notes-undo"),
    notesClear: $<HTMLButtonElement>("notes-clear"),
    notesDone: $<HTMLButtonElement>("notes-done"),
    notesHint: $("notes-hint"),
    notesFinger: $<HTMLButtonElement>("notes-finger"),
    moreColors: $<HTMLButtonElement>("more-colors"),
    palette: $("palette"),
    paletteGrid: $("palette-grid"),
    paletteCustom: $<HTMLInputElement>("palette-custom"),
    installRow: $("install-row"),
    install: $<HTMLButtonElement>("install"),
};

declare const __APP_VERSION__: string;
$("version").textContent = "PocketScore " + __APP_VERSION__;

const engine = new Engine();

const ICON_PLAY = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>`;

const state = {
    score: null as ScoreInfo | null,
    zoom: 1,
    pageOps: new Map<number, any[]>(),
    pageEls: [] as HTMLDivElement[],
    rendered: new Set<number>(),
    playing: false,
    duration: 0,
    position: 0,
    seeking: false,
    followUntil: 0, // pause auto-follow while the reader scrolls
    tracks: [] as TrackInfo[],
    playbackReady: false,
    masterDb: 0,
    scoreKey: "",
};

// ---------------------------------------------------------------- status

let statusTimer = 0;
function setStatus(text: string, kind: "info" | "error" = "info", autoHideMs = 0) {
    ui.status.hidden = !text;
    ui.status.textContent = text;
    ui.status.classList.toggle("error", kind === "error");
    ui.status.classList.remove("action");
    ui.status.onclick = null;
    clearTimeout(statusTimer);
    if (autoHideMs) {
        statusTimer = window.setTimeout(() => (ui.status.hidden = true), autoHideMs);
    }
}

engine.on("error", (e) => setStatus(e.message, "error"));
engine.on("resources", (p) => {
    if (p.done < p.total) {
        setStatus(`Preparing MuseScore engine… ${Math.round(p.done / p.total * 100)}%`);
    }
});
engine.on("engineReady", () => setStatus("Ready. Open a score.", "info", 2500));
engine.on("audioStatus", (s) => {
    if (s.text) {
        setStatus(s.text);
    } else if (!state.playbackReady && state.score) {
        setStatus("Loading instrument sounds…");
    } else {
        setStatus("");
    }
});

// ---------------------------------------------------------------- time

function fmt(secs: number) {
    secs = Math.max(0, secs);
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- pages

function unitsToCss(u: number) {
    return u / UNITS_PER_INCH * CSS_PX_PER_INCH * state.zoom;
}

function buildPages() {
    ui.pages.innerHTML = "";
    notes.detachAll();
    state.pageEls = [];
    state.rendered.clear();
    const score = state.score;
    if (!score) {
        return;
    }
    const horizontal = ui.viewMode.value === "continuous_v";
    ui.pages.style.flexDirection = horizontal ? "row" : "column";
    score.pages.forEach((p, i) => {
        const el = document.createElement("div");
        el.className = "page";
        el.dataset.index = String(i);
        el.style.width = unitsToCss(p.w) + "px";
        el.style.height = unitsToCss(p.h) + "px";
        ui.pages.appendChild(el);
        state.pageEls.push(el);
        notes.attach(el, i, p.w, p.h);
        observer.observe(el);
    });
    ui.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
}

const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.index);
        if (e.isIntersecting) {
            void renderPage(i);
        }
    }
}, { root: ui.viewer, rootMargin: "600px" });

let renderGeneration = 0;

async function renderPage(i: number) {
    if (state.rendered.has(i) || !state.score) {
        return;
    }
    state.rendered.add(i);
    const gen = renderGeneration;
    let ops = state.pageOps.get(i);
    if (!ops) {
        ops = JSON.parse(await engine.page(i)) as any[];
        if (gen !== renderGeneration) {
            return;
        }
        state.pageOps.set(i, ops);
    }
    await Promise.all([ensureFonts(ops, engine.base), ensureImages(ops)]);
    if (gen !== renderGeneration) {
        return;
    }

    const el = state.pageEls[i];
    const page = state.score.pages[i];
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // keep canvases within mobile limits (about 16 megapixels)
    let scale = unitsToCss(1) * dpr;
    const maxPixels = 16e6;
    if (page.w * page.h * scale * scale > maxPixels) {
        scale = Math.sqrt(maxPixels / (page.w * page.h));
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(page.w * scale);
    canvas.height = Math.ceil(page.h * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawPage(ctx, ops, scale);
    el.querySelector("canvas")?.remove();
    el.prepend(canvas);
}

function rerenderAll(keepOps: boolean) {
    renderGeneration++;
    if (!keepOps) {
        state.pageOps.clear();
    }
    // keep the reader's place: remember the fraction scrolled
    const v = ui.viewer;
    const fx = v.scrollLeft / Math.max(1, v.scrollWidth);
    const fy = v.scrollTop / Math.max(1, v.scrollHeight);
    buildPages();
    v.scrollLeft = fx * v.scrollWidth;
    v.scrollTop = fy * v.scrollHeight;
    showCursor(lastCursor);
}

// Zoom at which the first page fills the screen width (capped at 100%)
function fitWidthZoom() {
    const p = state.score?.pages[0];
    if (!p) {
        return 1;
    }
    const pageCss = p.w / UNITS_PER_INCH * CSS_PX_PER_INCH;
    return Math.min(1, Math.max(0.3, (ui.viewer.clientWidth - 16) / pageCss));
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// Where a screen point falls on the score: a page and the fraction across and
// down it (the nearest page when the point is in a gap)
function anchorAt(x: number, y: number): { page: number; fx: number; fy: number } | null {
    let best: { page: number; fx: number; fy: number } | null = null;
    let bestDist = Infinity;
    state.pageEls.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
        if (d < bestDist) {
            bestDist = d;
            best = { page: i, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
        }
    });
    return best;
}

// Zoom so that the point of the score under (x, y) stays under (toX, toY)
function zoomAround(z: number, x: number, y: number, toX = x, toY = y) {
    const a = anchorAt(x, y);
    state.zoom = clampZoom(z);
    rerenderAll(true);
    const el = a && state.pageEls[a.page];
    if (el) {
        const r = el.getBoundingClientRect();
        ui.viewer.scrollLeft += r.left + a.fx * r.width - toX;
        ui.viewer.scrollTop += r.top + a.fy * r.height - toY;
    }
}

function setZoom(z: number) {
    // around the middle of the view
    const v = ui.viewer.getBoundingClientRect();
    zoomAround(z, v.left + v.width / 2, v.top + v.height / 2);
}

ui.zoomIn.onclick = () => setZoom(state.zoom * 1.25);
ui.zoomOut.onclick = () => setZoom(state.zoom / 1.25);

// Pinch to zoom around the point between the fingers, which stays under them
// (moving both fingers also moves the score). The score is scaled with CSS
// during the gesture and redrawn at the new size when the fingers lift.
{
    let pinch: { dist: number; zoom: number; midX: number; midY: number; sx: number; sy: number; px: number; py: number } | null = null;
    let last = { f: 1, x: 0, y: 0 };
    const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t: TouchList) => Math.max(1, Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY));
    ui.viewer.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2 && state.score) {
            const m = mid(e.touches);
            const r = ui.pages.getBoundingClientRect();
            pinch = {
                dist: dist(e.touches), zoom: state.zoom, midX: m.x, midY: m.y,
                sx: ui.viewer.scrollLeft, sy: ui.viewer.scrollTop,
                px: m.x - r.left, py: m.y - r.top, // the score point between the fingers (unscaled)
            };
            last = { f: 1, x: m.x, y: m.y };
        }
    }, { passive: true });
    ui.viewer.addEventListener("touchmove", (e) => {
        if (!pinch || e.touches.length !== 2) {
            return;
        }
        if (e.cancelable) {
            e.preventDefault();
        }
        const m = mid(e.touches);
        // keep within the zoom limits
        const f = clampZoom(pinch.zoom * dist(e.touches) / pinch.dist) / pinch.zoom;
        // where the unscaled score would be now (the browser may have scrolled it)
        const left0 = pinch.midX - pinch.px - (ui.viewer.scrollLeft - pinch.sx);
        const top0 = pinch.midY - pinch.py - (ui.viewer.scrollTop - pinch.sy);
        const tx = m.x - left0 - pinch.px * f;
        const ty = m.y - top0 - pinch.py * f;
        ui.pages.style.transform = `translate(${tx}px, ${ty}px) scale(${f})`;
        last = { f, x: m.x, y: m.y };
    }, { passive: false });
    const end = (e: TouchEvent) => {
        if (!pinch || e.touches.length >= 2) {
            return;
        }
        const p = pinch;
        pinch = null;
        // the score point that started between the fingers, on screen now
        const left0 = p.midX - p.px - (ui.viewer.scrollLeft - p.sx);
        const top0 = p.midY - p.py - (ui.viewer.scrollTop - p.sy);
        ui.pages.style.transform = "";
        if (last.f === 1 && last.x === p.midX && last.y === p.midY) {
            return;
        }
        zoomAround(p.zoom * last.f, left0 + p.px, top0 + p.py, last.x, last.y);
    };
    ui.viewer.addEventListener("touchend", end);
    ui.viewer.addEventListener("touchcancel", end);
}

// Tap a note or rest to play from there (a tap, not a scroll or pinch).
// While stopped, a tapped note also sounds, as in desktop MuseScore.
let pendingPreview: { page: number; x: number; y: number; radius: number } | null = null;
{
    let down: { x: number; y: number; t: number; id: number } | null = null;
    ui.pages.addEventListener("pointerdown", (e) => {
        down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
    });
    ui.pages.addEventListener("pointercancel", () => (down = null));
    ui.pages.addEventListener("pointerup", async (e) => {
        const d = down;
        down = null;
        if (!d || d.id !== e.pointerId || !state.score || notes.active) {
            return;
        }
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || performance.now() - d.t > 500) {
            return;
        }
        const pageEl = (e.target as HTMLElement).closest(".page") as HTMLElement | null;
        if (!pageEl) {
            return;
        }
        const r = pageEl.getBoundingClientRect();
        const toUnits = (css: number) => css / (CSS_PX_PER_INCH * state.zoom) * UNITS_PER_INCH;
        // a fingertip is wider than a notehead: accept notes within ~18 px, but
        // not so far that a neighbouring staff's note is picked
        const sp = state.score.spatium;
        const radius = Math.max(0.75 * sp, Math.min(toUnits(18), 3 * sp));
        const tap = { page: Number(pageEl.dataset.index), x: toUnits(e.clientX - r.left), y: toUnits(e.clientY - r.top), radius };
        const audioReady = engine.audioRunning && state.playbackReady;
        if (!audioReady && !state.playing) {
            // the first tap starts audio (it must start from a tap on iOS); the note sounds once it's ready
            pendingPreview = tap;
            void startAudioFromTap();
        }
        const c = await engine.seekAt(tap.page, tap.x, tap.y, tap.radius, audioReady);
        if (c) {
            state.followUntil = 0;
        }
    });
}

// pause following the cursor while the reader scrolls by hand
for (const ev of ["wheel", "touchmove"]) {
    ui.viewer.addEventListener(ev, () => (state.followUntil = performance.now() + 2500), { passive: true });
}

// ---------------------------------------------------------------- cursor

let lastCursor: CursorInfo | null = null;
let cursorEl: HTMLDivElement | null = null;
let lastFollowCheck = 0;

function showCursor(c: CursorInfo | null) {
    lastCursor = c;
    if (!c || c.page === undefined || !state.pageEls[c.page]) {
        cursorEl?.remove();
        return;
    }
    if (!cursorEl) {
        cursorEl = document.createElement("div");
        cursorEl.className = "cursor";
    }
    const pageEl = state.pageEls[c.page];
    if (cursorEl.parentElement !== pageEl) {
        pageEl.appendChild(cursorEl);
    }
    const w = Math.max(3, unitsToCss(c.w!));
    cursorEl.style.transform = `translate(${unitsToCss(c.x!)}px, ${unitsToCss(c.y!)}px)`;
    cursorEl.style.width = w + "px";
    cursorEl.style.height = unitsToCss(c.h!) + "px";

    // checking the view means reading layout, so a few times a second is enough
    const now = performance.now();
    if (state.playing && now > state.followUntil && now - lastFollowCheck > 200) {
        lastFollowCheck = now;
        followCursor(pageEl);
    }
}

// Follow in one step when the cursor nears the edge of the view
function followCursor(pageEl: HTMLElement) {
    if (!cursorEl) {
        return;
    }
    const v = ui.viewer.getBoundingClientRect();
    const r = cursorEl.getBoundingClientRect();
    const margin = 0.15;
    if (r.bottom > v.bottom - v.height * margin || r.top < v.top) {
        ui.viewer.scrollTop += r.top - v.top - v.height * 0.2;
    }
    if (r.right > v.right - v.width * margin || r.left < v.left) {
        ui.viewer.scrollLeft += r.left - v.left - v.width * 0.25;
    }
    void pageEl;
}

// The audio engine renders ahead and reports its position in bursts, so while
// playing the cursor is moved every frame from the audio clock, anchored to
// those reports, using the score's timeline (see Session::timelineJson).
type TimelinePoint = [number, number, number, number, number]; // secs, page, x, y, h
let timeline: TimelinePoint[] = [];
const anchor = { secs: 0, clock: 0 };

async function loadTimeline() {
    timeline = await engine.timeline();
}

function cursorFromTimeline(secs: number): CursorInfo | null {
    if (!timeline.length) {
        return null;
    }
    let lo = 0;
    let hi = timeline.length - 1;
    if (secs < timeline[0][0]) {
        hi = 0;
    }
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timeline[mid][0] <= secs) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    const a = timeline[lo];
    const b = timeline[lo + 1];
    let x = a[2];
    // glide to the next point only along the same line and forwards (a repeat jumps back)
    if (b && b[1] === a[1] && b[3] === a[3] && b[0] > a[0] && b[2] >= a[2]) {
        x = a[2] + (b[2] - a[2]) * Math.min(1, (secs - a[0]) / (b[0] - a[0]));
    }
    return { secs, duration: state.duration, page: a[1], x, y: a[3], w: 0.4 * (state.score?.spatium || 25), h: a[4] };
}

engine.on("position", (c: CursorInfo) => {
    state.duration = c.duration || state.duration;
    ui.bar.textContent = c.measure ? `Bar ${c.measure}` : "";
    const clock = engine.audioTime;
    if (state.playing && clock > 0) {
        followReports(c.secs, clock);
        return;
    }
    anchor.secs = c.secs;
    anchor.clock = clock;
    showPosition(c.secs, c);
});

// While playing, the cursor runs on the audio clock: music and clock move at
// exactly the same rate, so the engine's position reports are only needed to
// know the offset between them. Reports wobble with the audio queued ahead
// (Android) and can arrive late and in bursts (iPad Safari delays messages
// from the workers): a late report always looks behind, never ahead. So the
// offset follows the upper edge of the last 0.6 s of reports, in limited steps,
// and only a seek (or a difference over half a second) moves the cursor at once.
const reports: { t: number; offset: number }[] = [];
let resyncCursor = true;
let lastCorrection = 0;
let ignoreReportsUntil = 0;

function followReports(secs: number, clock: number) {
    const now = performance.now();
    if (now < ignoreReportsUntil) {
        return; // just started: these still assume the short queue used while stopped
    }
    if (resyncCursor) {
        resyncCursor = false;
        reports.length = 0;
        anchor.secs = secs;
        anchor.clock = clock;
    }
    reports.push({ t: now, offset: secs - clock });
    while (reports.length && reports[0].t < now - 600) {
        reports.shift();
    }
    const sorted = reports.map((r) => r.offset).sort((a, b) => a - b);
    const target = sorted[Math.floor((sorted.length - 1) * 0.9)];
    const err = target - (anchor.secs - anchor.clock);
    if (Math.abs(err) > 1) {
        // a jump no late report explains (seeks resync by themselves)
        anchor.secs = clock + target;
        anchor.clock = clock;
        reports.length = 0;
    } else {
        // Corrections are limited by the time passed, not per report (reports
        // come in bursts): at most 30% faster or slower, so the cursor never
        // goes backwards and a start-up offset is worked off within a second.
        const dt = Math.min(0.1, (now - lastCorrection) / 1000);
        anchor.secs += Math.max(-0.3 * dt, Math.min(0.3 * dt, err * 0.2));
    }
    lastCorrection = now;
}

engine.on("seeked", () => (resyncCursor = true));

// Leaving PocketScore (another app, the home screen, locking the screen) pauses
// the music, so it doesn't play on unseen; coming back says so.
let pausedOnLeaving = false;
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        if (state.playing) {
            pausedOnLeaving = true;
            void engine.pause();
        }
    } else if (pausedOnLeaving) {
        pausedOnLeaving = false;
        setStatus("The music paused when you left PocketScore. Tap Play to go on.", "info", 6000);
    }
});

// The device can stop the sound by itself (a call, Siri, a system dialog, another
// app taking the audio). Pause then, so the cursor stops with the sound.
engine.on("audioState", (st: string) => {
    if (st !== "running" && state.playing) {
        void engine.pause();
        setStatus("Playback paused because the device stopped the sound. Tap Play to go on.", "info", 6000);
    }
});

function showPosition(secs: number, fallback?: CursorInfo) {
    state.position = secs;
    if (!state.seeking) {
        ui.seek.value = String(Math.round(secs / Math.max(1, state.duration) * 1000));
    }
    ui.time.textContent = fmt(secs);
    showCursor(cursorFromTimeline(secs) || fallback || null);
}

function animate() {
    if (state.playing) {
        // before the sound reaches the speaker the cursor waits where it is
        const secs = Math.min(state.duration, Math.max(0, anchor.secs + Math.max(0, engine.audioTime - anchor.clock)));
        showPosition(secs);
    }
    requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

engine.on("status", (s) => {
    const nowPlaying = s.status === "playing";
    if (nowPlaying && !state.playing) {
        // The music is heard once the audio queued ahead reaches the speaker:
        // the cursor waits at the start until then, and the first reports
        // (made with the stopped queue's latency) are not used.
        anchor.secs = state.position;
        anchor.clock = engine.audioTime + engine.playLatency;
        resyncCursor = false;
        reports.length = 0;
        ignoreReportsUntil = performance.now() + 500;
    }
    state.playing = nowPlaying;
    ui.play.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
    ui.play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
});

// ---------------------------------------------------------------- transport

async function startAudioFromTap() {
    try {
        await engine.startAudio(); // also lets sound out (browsers need a tap for that)
        await engine.whenRunning();
    } catch (err: any) {
        setStatus("Audio could not start: " + (err && err.message || err), "error");
        return;
    }
    // sounds were already loaded: hear the tapped note now
    if (state.playbackReady && pendingPreview) {
        const t = pendingPreview;
        pendingPreview = null;
        void engine.seekAt(t.page, t.x, t.y, t.radius, true);
    }
}

ui.play.onclick = async () => {
    if (!state.score) {
        return;
    }
    if (!engine.audioRunning || !state.playbackReady) {
        setStatus("Starting audio…");
        try {
            await engine.startAudio();
        } catch (err: any) {
            setStatus("Audio could not start: " + (err && err.message || err), "error");
            return;
        }
        if (!state.playbackReady) {
            pendingPlay = true;
            return;
        }
    }
    state.playing ? engine.pause() : engine.play();
};

let pendingPlay = false;

ui.rewind.onclick = () => {
    void engine.stop();
    void engine.seek(0);
};

ui.seek.addEventListener("input", () => {
    state.seeking = true;
    const secs = Number(ui.seek.value) / 1000 * state.duration;
    ui.time.textContent = fmt(secs);
});
ui.seek.addEventListener("change", () => {
    const secs = Number(ui.seek.value) / 1000 * state.duration;
    state.seeking = false;
    state.followUntil = 0;
    void engine.seek(secs);
});

// ---------------------------------------------------------------- mixer

// Volume is shown as loudness compared with the score's own setting: 100% is
// as written, 200% sounds about twice as loud (+10 dB), 50% about half (-10 dB).
// The engine works in dB like desktop's mixer (-60 to +12).
const MIN_DB = -60;
const MAX_DB = 12; // desktop's mixer goes to +12 dB, and scores are saved with it
const MAX_PCT = 230; // +12 dB
const pctFromDb = (db: number) => (db <= MIN_DB ? 0 : Math.min(MAX_PCT, Math.round(100 * Math.pow(2, db / 10))));
const dbFromPct = (pct: number) => (pct <= 0 ? MIN_DB : Math.min(MAX_DB, Math.max(MIN_DB, 10 * Math.log2(pct / 100))));
const fmtDb = (db: number) => (db <= MIN_DB ? "silent" : (db > 0 ? "+" : "") + db.toFixed(1) + " dB");

const ICON_CHEVRON = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_WARN = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3L2 21h20zM12 10v5M12 17.5v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// A volume slider in percent, snapping to 100% (as written) near the middle mark
function volumeControl(row: HTMLElement, label: string, db: number, onChange: (db: number) => void) {
    const vol = row.querySelector<HTMLInputElement>(".vol")!;
    const out = row.querySelector<HTMLElement>(".db")!;
    vol.setAttribute("aria-label", label);
    const show = (pct: number, dbNow: number) => {
        out.textContent = pct + "%";
        vol.setAttribute("aria-valuetext", `${pct} percent`);
        vol.title = fmtDb(dbNow);
    };
    const pct0 = pctFromDb(db);
    vol.value = String(pct0);
    show(pct0, db);
    let last = db;
    vol.oninput = () => {
        let pct = Number(vol.value);
        if (Math.abs(pct - 100) <= 4) {
            pct = 100;
            vol.value = "100";
        }
        // the slider counts whole percent; where it still shows the starting
        // value, keep the exact setting (touching it changes nothing)
        const d = pct === pct0 ? db : dbFromPct(pct);
        show(pct, d);
        if (d !== last) {
            last = d;
            onChange(d);
        }
    };
}

function buildMixer() {
    ui.mixerBody.innerHTML = "";
    const stripHtml = `
        <div class="who"><div class="name"></div></div>
        <button class="toggle m" aria-label="Mute">M</button>
        <button class="toggle s" aria-label="Solo">S</button>
        <div class="level"><input class="vol" type="range" min="0" max="230" step="1"></div>
        <output class="db"></output>
        <div class="note"></div>`;

    const master = document.createElement("div");
    master.className = "strip master";
    master.innerHTML = stripHtml;
    master.querySelector<HTMLElement>(".name")!.textContent = "Master";
    volumeControl(master, "Master volume", state.masterDb, (db) => {
        state.masterDb = db;
        void engine.setMasterVolume(db);
        mixChanged();
    });
    ui.mixerBody.appendChild(master);

    for (const t of state.tracks) {
        const row = document.createElement("div");
        // silent: muted, or another part is soloed
        row.className = "strip" + (t.metronome ? " metronome" : "") + (t.mute || t.forceMute ? " silent" : "");
        row.innerHTML = stripHtml + `
            <label class="rev">Reverb <input type="range" min="0" max="100" step="1"><output></output></label>`;
        row.querySelector<HTMLElement>(".name")!.textContent = t.title;
        if (!t.metronome) {
            const sound = document.createElement("button");
            sound.className = "sound";
            sound.innerHTML = `<span></span>${ICON_CHEVRON}`;
            const soundName = t.ready ? t.sound || "MS Basic" : "Loading sounds…";
            sound.querySelector("span")!.textContent = soundName;
            sound.setAttribute("aria-label", `Sound for ${t.title}: ${soundName}. Change`);
            sound.disabled = !t.ready;
            sound.onclick = () => void openSounds(t);
            row.querySelector(".who")!.appendChild(sound);
        }
        if (t.note) {
            row.querySelector<HTMLElement>(".note")!.innerHTML = ICON_WARN + "<span></span>";
            row.querySelector<HTMLElement>(".note span")!.textContent = t.note + ". Playing MS Basic instead.";
        }
        const m = row.querySelector<HTMLButtonElement>(".m")!;
        const s = row.querySelector<HTMLButtonElement>(".s")!;
        m.classList.toggle("on", t.mute);
        s.classList.toggle("on", t.solo);
        m.setAttribute("aria-pressed", String(t.mute));
        s.setAttribute("aria-pressed", String(t.solo));
        m.setAttribute("aria-label", `Mute ${t.title}`);
        s.setAttribute("aria-label", `Solo ${t.title}`);
        volumeControl(row, `Volume of ${t.title}`, t.volume, (db) => {
            t.volume = db;
            void engine.setVolume(t.key, db);
            mixChanged();
        });
        if (t.mute) {
            row.querySelector<HTMLElement>(".db")!.textContent = "Muted";
        }

        const rev = row.querySelector<HTMLInputElement>(".rev input")!;
        const revOut = row.querySelector<HTMLElement>(".rev output")!;
        rev.setAttribute("aria-label", `Reverb for ${t.title}`);
        rev.value = String(Math.round(t.reverb * 100));
        revOut.textContent = rev.value + "%";
        if (t.metronome) {
            row.querySelector<HTMLElement>(".rev")!.remove();
        }

        m.onclick = async () => {
            await engine.setMute(t.key, !t.mute);
            await refreshTracks();
            mixChanged();
        };
        s.onclick = async () => {
            await engine.setSolo(t.key, !t.solo);
            await refreshTracks();
            mixChanged();
        };
        const rev0 = { pct: rev.value, amount: t.reverb };
        rev.oninput = () => {
            revOut.textContent = rev.value + "%";
            // as for volume: back at the starting mark, keep the exact setting
            const amount = rev.value === rev0.pct ? rev0.amount : Number(rev.value) / 100;
            if (amount !== t.reverb) {
                t.reverb = amount;
                void engine.setReverb(t.key, amount);
                mixChanged();
            }
        };

        ui.mixerBody.appendChild(row);
    }
}

async function refreshTracks() {
    const scroll = ui.mixerBody.scrollTop;
    state.tracks = await engine.tracks();
    buildMixer();
    ui.mixerBody.scrollTop = scroll;
}

// ---------------------------------------------------------------- sounds

// A part's sound can be changed, as in desktop's mixer.
let soundList: SoundList | null = null;

function soundsContain(node: SoundNode, id: string): boolean {
    return "id" in node ? node.id === id : node.c.some((c) => soundsContain(c, id));
}

// The sound list is for the part it was opened from. "Several parts" (a small
// button by the title, so the list stays uncluttered) shows a row of parts to
// add; a sound picked then goes to all of them.
async function openSounds(t: TrackInfo) {
    soundList ||= await engine.sounds();
    const list = soundList;
    const parts = state.tracks.filter((p) => !p.metronome);
    const chosen = new Set<number>([t.key]);
    const selected = () => state.tracks.filter((p) => chosen.has(p.key));
    ui.soundsBody.innerHTML = "";

    // ---- which parts
    const applyTo = document.createElement("div");
    applyTo.className = "apply-to";
    applyTo.innerHTML = `<span class="label">Parts:</span>`;
    const chips: [HTMLButtonElement, number | null][] = [];
    const chip = (label: string, key: number | null) => {
        const b = document.createElement("button");
        b.className = "part-chip" + (key === null ? " all" : "");
        b.textContent = label;
        b.onclick = () => {
            if (key === null) {
                const all = parts.every((p) => chosen.has(p.key));
                chosen.clear();
                (all ? [t] : parts).forEach((p) => chosen.add(p.key));
            } else if (chosen.has(key)) {
                if (chosen.size > 1) {
                    chosen.delete(key);
                }
            } else {
                chosen.add(key);
            }
            update();
        };
        chips.push([b, key]);
        applyTo.appendChild(b);
    };
    ui.soundsMany.hidden = parts.length < 2;
    ui.soundsMany.setAttribute("aria-expanded", "false");
    if (parts.length > 1) {
        chip("All parts", null);
        parts.forEach((p) => chip(p.title, p.key));
        applyTo.hidden = true;
        ui.soundsBody.appendChild(applyTo);
        ui.soundsMany.onclick = () => {
            applyTo.hidden = !applyTo.hidden;
            ui.soundsMany.setAttribute("aria-expanded", String(!applyTo.hidden));
            if (applyTo.hidden) { // back to just the part it was opened for
                chosen.clear();
                chosen.add(t.key);
                update();
            }
            ui.soundsBody.scrollTop = 0;
        };
    }

    // ---- sounds
    const apply = async (soundFor: (p: TrackInfo) => string) => {
        for (const p of selected()) {
            const id = soundFor(p);
            if (id && id !== p.soundId) {
                await engine.setSound(p.key, id);
            }
        }
        closeLayer(closeSounds);
        await refreshTracks();
        mixChanged();
    };

    const picks: HTMLButtonElement[] = [];
    const pick = (id: string, name: string, top = false) => {
        const b = document.createElement("button");
        b.className = "pick" + (top ? " top" : "");
        b.dataset.id = id;
        b.setAttribute("role", "menuitemradio");
        b.innerHTML = `<span class="check"></span><span></span><span class="tag">In score</span>`;
        b.querySelector("span:nth-child(2)")!.textContent = name;
        b.onclick = () => apply(() => id);
        picks.push(b);
        return b;
    };

    const groups: [HTMLDetailsElement, SoundNode][] = [];
    const group = (node: SoundNode): HTMLElement => {
        if ("id" in node) {
            return pick(node.id, node.n);
        }
        const d = document.createElement("details");
        const sum = document.createElement("summary");
        sum.textContent = node.t;
        const dot = document.createElement("span");
        dot.className = "here";
        dot.setAttribute("aria-label", "current sound");
        sum.appendChild(dot);
        d.appendChild(sum);
        node.c.forEach((c) => d.appendChild(group(c)));
        groups.push([d, node]);
        return d;
    };

    // back to the score: each part's own sound
    const own = document.createElement("button");
    own.className = "pick top own";
    own.innerHTML = `<span class="check"></span><span>Each part's sound in the score</span>`;
    own.onclick = () => apply((p) => p.scoreSoundId);
    ui.soundsBody.appendChild(own);

    if (list.auto) {
        ui.soundsBody.appendChild(pick(list.auto, "Choose automatically", true));
    }
    list.tree.forEach((n) => ui.soundsBody.appendChild(group(n)));

    // title, chips and marks for the parts chosen now
    function update() {
        const sel = selected();
        ui.soundsTitle.innerHTML = "Sound for <b></b>";
        ui.soundsTitle.querySelector("b")!.textContent = sel.length === 1 ? sel[0].title : `${sel.length} parts`;
        for (const [b, key] of chips) {
            const on = key === null ? parts.every((p) => chosen.has(p.key)) : chosen.has(key);
            b.setAttribute("aria-pressed", String(on));
        }
        // a sound is marked when every chosen part has it
        const common = sel.every((p) => p.soundId === sel[0].soundId) ? sel[0].soundId : "";
        const scoreIds = new Set(sel.map((p) => p.scoreSoundId));
        for (const b of picks) {
            const on = b.dataset.id === common;
            b.setAttribute("aria-checked", String(on));
            b.querySelector(".check")!.innerHTML = on ? ICON_CHECK : "";
            b.querySelector<HTMLElement>(".tag")!.hidden = !(sel.length === 1 && scoreIds.has(b.dataset.id!));
        }
        const allOwn = sel.every((p) => p.soundId === p.scoreSoundId);
        own.hidden = sel.length === 1; // one part: its score sound is tagged "In score"
        own.setAttribute("aria-checked", String(allOwn));
        own.querySelector(".check")!.innerHTML = allOwn ? ICON_CHECK : "";
        for (const [d, node] of groups) {
            const here = !!common && soundsContain(node, common);
            d.querySelector<HTMLElement>(":scope > summary > .here")!.hidden = !here;
            if (here) {
                d.open = true;
            }
        }
    }
    update();

    ui.mixer.classList.add("picking");
    ui.sounds.hidden = false;
    openLayer(closeSounds);
    ui.soundsBody.querySelector<HTMLElement>('.pick[aria-checked="true"]')?.scrollIntoView({ block: "center" });
}

function closeSounds() {
    ui.sounds.hidden = true;
    ui.mixer.classList.remove("picking");
}

ui.soundsBack.onclick = () => closeLayer(closeSounds);

// ---------------------------------------------------------------- back button

// Panels close with the phone's Back button or gesture instead of leaving the
// app: each open panel adds a history entry, and going back closes the top one.
const layers: (() => void)[] = [];

function openLayer(close: () => void) {
    layers.push(close);
    history.pushState({ pocketscoreLayer: layers.length }, "");
}

/** Close a panel from the app's own controls. */
function closeLayer(close: () => void) {
    const i = layers.lastIndexOf(close);
    if (i < 0) {
        close();
    } else if (i === layers.length - 1) {
        history.back(); // popstate closes it
    } else {
        layers.splice(i, 1);
        close();
    }
}

window.addEventListener("popstate", () => {
    layers.pop()?.();
});

// ---------------------------------------------------------------- mixer panel

function closeMixer() {
    if (!ui.sounds.hidden) {
        closeLayer(closeSounds);
    }
    ui.mixer.hidden = true;
    ui.mixerToggle.setAttribute("aria-expanded", "false");
}

ui.mixerToggle.onclick = () => {
    if (!ui.mixer.hidden) {
        closeLayer(closeMixer);
        return;
    }
    ui.mixer.hidden = false;
    ui.mixerToggle.setAttribute("aria-expanded", "true");
    openLayer(closeMixer);
    void refreshTracks();
};
ui.mixerClose.onclick = () => closeLayer(closeMixer);

ui.mixerReverb.onclick = () => {
    const on = !ui.mixer.classList.contains("show-reverb");
    ui.mixer.classList.toggle("show-reverb", on);
    ui.mixerReverb.setAttribute("aria-pressed", String(on));
};

// ---------------------------------------------------------------- saving

// One Save for the whole score, in the top bar: notes and mixer changes stay
// unsaved until the reader taps it, and are then kept in PocketScore on this
// device for this score (the .mscz itself is never changed). Meanwhile unsaved
// work is kept as a draft, so closing the app loses nothing: it comes back
// next time, still unsaved. The reader is asked only when opening another
// score with unsaved changes.
const mix = {
    store: null as MixStore | null,
    score: null as Mix | null, // as the score was saved
    saved: null as Mix | null, // the reader's saved settings for it
    dirty: false,
    // sounds chosen (or saved) before the sounds were loaded, applied when they are
    pendingSounds: {} as Record<string, string>,
};
let draftTimer = 0;
// restoring the opened score's saved settings (see the playbackReady handler)
let mixLoading: Promise<boolean> = Promise.resolve(false);
let restoredNotice = false;

// A part's sound is recorded only when it isn't the score's own ("" = the score's)
function currentMix(): Mix {
    const m = mixOf(state.tracks, state.masterDb);
    for (const t of state.tracks) {
        const p = m.parts[slot(t)];
        p.soundId = t.ready
            ? (t.soundId && t.soundId !== t.scoreSoundId ? t.soundId : "")
            : (mix.pendingSounds[slot(t)] || "");
    }
    return m;
}

async function applyMix(m: Mix) {
    for (const t of state.tracks) {
        const p = m.parts[slot(t)];
        if (!p) {
            continue;
        }
        if (!t.ready) {
            if (p.soundId) {
                mix.pendingSounds[slot(t)] = p.soundId;
            } else {
                delete mix.pendingSounds[slot(t)];
            }
        } else {
            const target = p.soundId || t.scoreSoundId;
            if (target && target !== t.soundId) {
                await engine.setSound(t.key, target);
            }
        }
        if (Math.abs(p.volume - t.volume) > 0.01) {
            await engine.setVolume(t.key, p.volume);
        }
        if (Math.abs(p.reverb - t.reverb) > 0.001) {
            await engine.setReverb(t.key, p.reverb);
        }
        if (p.mute !== t.mute && !t.metronome) { // the metronome stays as it is (off when a score opens)
            await engine.setMute(t.key, p.mute);
        }
        if (p.solo !== t.solo) {
            await engine.setSolo(t.key, p.solo);
        }
    }
    if (Math.abs(m.master - state.masterDb) > 0.01) {
        state.masterDb = m.master;
        await engine.setMasterVolume(m.master);
    }
    state.tracks = await engine.tracks();
}

// When a score opens: the score's mixer, then the reader's saved settings,
// then any unsaved changes from last time. Returns whether those came back.
async function loadMix(): Promise<boolean> {
    state.masterDb = await engine.masterVolume();
    mix.pendingSounds = {};
    const store = new MixStore(state.scoreKey);
    mix.store = store;
    mix.score = currentMix();
    mix.saved = store.saved(mix.score);
    if (mix.saved) {
        await applyMix(mix.saved);
    }
    const draft = store.draft();
    mix.dirty = !!draft && !sameMix(draft, mix.saved || mix.score);
    if (mix.dirty) {
        await applyMix(draft!);
    } else {
        store.setDraft(null);
    }
    return mix.dirty;
}

function mixChanged() {
    if (!mix.store || !mix.score) {
        return;
    }
    mix.dirty = !sameMix(currentMix(), mix.saved || mix.score);
    clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => mix.store?.setDraft(mix.dirty ? currentMix() : null), 400);
    updateSaveState();
}

function saveMix(): boolean {
    if (!mix.store) {
        return true;
    }
    clearTimeout(draftTimer);
    const now = currentMix();
    // the score's own settings need no saving
    const toSave = mix.score && sameMix(now, mix.score) ? null : now;
    if (!mix.store.save(toSave)) {
        return false;
    }
    mix.saved = toSave;
    mix.dirty = false;
    return true;
}

const hasUnsaved = () => !!state.score && (notes.dirty || mix.dirty);

function updateSaveState() {
    const unsaved = hasUnsaved();
    ui.save.disabled = !unsaved;
    ui.save.classList.toggle("primary", unsaved);
    ui.save.title = unsaved ? "Save your notes and mixer changes for this score" : "Everything is saved";
}

function saveAll(): boolean {
    const ok = notes.commit() && saveMix();
    updateSaveState();
    if (!ok) {
        setStatus("Your changes could not be saved on this device (storage is full or blocked).", "error", 8000);
        return false;
    }
    setStatus("Saved.", "info", 2000);
    return true;
}

function discardAll() {
    clearTimeout(draftTimer);
    notes.discard();
    mix.store?.setDraft(null);
    mix.dirty = false;
}

ui.save.onclick = () => {
    if (hasUnsaved()) {
        saveAll();
    }
};
// Ctrl+S / Cmd+S (keyboards on computers and iPads)
document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (hasUnsaved()) {
            saveAll();
        }
    }
});

// A small question with buttons; resolves with the chosen button's key
// ("cancel" if dismissed with Escape or Back)
function ask(title: string, text: string, buttons: [string, string][]): Promise<string> {
    const d = ui.ask;
    d.querySelector("h2")!.textContent = title;
    d.querySelector("p")!.textContent = text;
    const row = d.querySelector(".ask-buttons")!;
    row.innerHTML = "";
    return new Promise((resolve) => {
        buttons.forEach(([key, label], i) => {
            const b = document.createElement("button");
            b.className = "btn" + (i === buttons.length - 1 ? " primary" : " plain");
            b.textContent = label;
            b.onclick = () => {
                d.close(key);
            };
            row.appendChild(b);
        });
        d.onclose = () => resolve(d.returnValue || "cancel");
        d.returnValue = "";
        d.showModal();
    });
}

engine.on("playbackReady", async () => {
    // The saved settings must be restored first: when the audio is already
    // running the sounds can be ready before that has finished, and the saved
    // sound choices were then lost (parts back on the score's sound).
    await mixLoading;
    state.playbackReady = true;
    const tracks = await engine.tracks();
    state.tracks = tracks;
    setStatus("");
    // sounds chosen (or saved) before the sounds had loaded
    for (const t of tracks) {
        const id = mix.pendingSounds[slot(t)];
        if (id && id !== t.soundId) {
            await engine.setSound(t.key, id);
        }
    }
    mix.pendingSounds = {};
    // settings saved by 0.2.1 name the score's own sound too: that means "the score's"
    for (const m of [mix.saved, mix.score]) {
        for (const t of tracks) {
            const p = m?.parts[slot(t)];
            if (p && p.soundId === t.scoreSoundId) {
                p.soundId = "";
            }
        }
    }
    state.tracks = await engine.tracks();
    if (mix.store) {
        mixChanged();
    }
    if (restoredNotice) {
        restoredNotice = false;
        setStatus("Your unsaved changes from last time are back. Tap Save to keep them.", "info", 8000);
    }
    if (!ui.mixer.hidden) {
        buildMixer();
    }
    if (pendingPlay) {
        pendingPlay = false;
        pendingPreview = null;
        void engine.play();
    } else if (pendingPreview && engine.audioRunning) {
        const t = pendingPreview;
        pendingPreview = null;
        void engine.seekAt(t.page, t.x, t.y, t.radius, true);
    }
});

// ---------------------------------------------------------------- opening

// Opening another score stops the music first (also while the file is being chosen)
$("open-label").addEventListener("click", () => {
    if (state.playing) {
        void engine.pause();
    }
});
ui.fileInput.onchange = async () => {
    const file = ui.fileInput.files?.[0];
    ui.fileInput.value = "";
    if (!file) {
        return;
    }
    if (state.playing) {
        await engine.stop();
    }
    if (hasUnsaved()) {
        const choice = await ask("Save your changes?",
            `Your notes or mixer changes for “${ui.title.textContent}” are not saved. Save them before opening another score?`,
            [["cancel", "Cancel"], ["discard", "Don't save"], ["save", "Save"]]);
        if (choice === "cancel" || (choice === "save" && !saveAll())) {
            return;
        }
        if (choice === "discard") {
            discardAll();
        }
    }
    await openScore(file.name, await file.arrayBuffer());
};

async function openScore(name: string, data: ArrayBuffer) {
    if (!/\.(mscz|mscx)$/i.test(name)) {
        setStatus(`"${name}" is not a MuseScore file. Choose a .mscz file.`, "error");
        return;
    }
    setStatus(`Opening ${name}…`);
    if (!ui.sounds.hidden) {
        closeLayer(closeSounds); // it lists the previous score's parts
    }
    state.playbackReady = false;
    clearTimeout(draftTimer);
    Object.assign(mix, { store: null, score: null, saved: null, dirty: false, pendingSounds: {} });
    // the sounds may report ready at any point from here on: they wait for the restore below
    let mixRestoreDone: (restored: boolean) => void = () => {};
    mixLoading = new Promise((resolve) => (mixRestoreDone = resolve));
    state.pageOps.clear();
    ui.mixerToggle.disabled = true;
    const key = await scoreKey(name, data); // before the data goes to the engine
    state.scoreKey = key;
    const res = await engine.load(name, data);
    if (!res.ok || !res.score) {
        mixRestoreDone(false);
        setStatus(res.error || "Could not open this score.", "error");
        return;
    }
    state.score = res.score;
    state.duration = res.score.duration;
    state.position = 0;
    state.tracks = res.score.tracks;
    lastCursor = null;
    ui.title.textContent = res.score.title || name.replace(/\.(mscz|mscx)$/i, "");
    $("open-label").classList.remove("primary"); // only the start screen's main action
    ui.empty.hidden = true;
    ui.viewMode.disabled = false;
    ui.viewMode.value = "page";
    ui.play.disabled = false;
    ui.rewind.disabled = false;
    ui.seek.disabled = false;
    ui.duration.textContent = fmt(state.duration);
    ui.time.textContent = "0:00";
    ui.seek.value = "0";
    state.zoom = fitWidthZoom();
    renderGeneration++;
    setNotesActive(false);
    notes.open(key, "page");
    ui.notesToggle.disabled = false;
    buildPages();
    void loadTimeline();
    ui.viewer.scrollTop = 0;
    ui.viewer.scrollLeft = 0;

    // the mixer works from the start: its values come from the score, and the
    // sounds load now rather than on the first Play
    const mixRestored = await loadMix();
    mixRestoreDone(mixRestored);
    restoredNotice = notes.restoredDraft || mixRestored;
    ui.mixerToggle.disabled = false;
    if (!ui.mixer.hidden) {
        buildMixer();
    }
    updateSaveState();
    setStatus("Loading instrument sounds…");
    void engine.startAudio().catch(() => {}); // errors are shown by the engine
}

ui.viewMode.onchange = async () => {
    setStatus("Laying out…");
    state.score = await engine.setViewMode(ui.viewMode.value as ViewMode);
    notes.setMode(ui.viewMode.value); // notes belong to the layout they were written on
    await loadTimeline();
    rerenderAll(false);
    setStatus("");
};

// Offline: keep the app, engine and sounds on the device (production builds only)
if ("serviceWorker" in navigator && import.meta.env.PROD) {
    const sw = navigator.serviceWorker;
    const isUpdate = !!sw.controller; // an older version is running this page
    sw.register("./sw.js").then((reg) => {
        // a home-screen app can stay open for days: look for updates when it comes back
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                reg.update().catch(() => {});
            }
        });
    }).catch((err) => console.warn("service worker:", err));
    sw.addEventListener("message", (e) => {
        if (isUpdate && e.data?.type === "sw-progress" && !state.playing) {
            setStatus(`Downloading an update to PocketScore… ${Math.round(e.data.done / e.data.total * 100)}%`);
        }
    });
    sw.addEventListener("controllerchange", () => {
        if (!isUpdate) {
            return; // first visit, not an update
        }
        if (!state.score) {
            location.reload();
            return;
        }
        setStatus("PocketScore has been updated. Tap here to restart it (reopen your score afterwards).");
        ui.status.classList.add("action");
        ui.status.onclick = () => location.reload();
    });
}

// Install: Chrome and Edge (Android, Windows, ChromeOS…) offer to install the
// web app as an app; show a button for it on the start screen. Safari has no
// such prompt (Share > Add to Home Screen), so the button stays hidden there.
let installPrompt: (Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }) | null = null;
const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // show our own button instead of the mini bar
    installPrompt = e as typeof installPrompt;
    ui.installRow.hidden = standalone;
});
window.addEventListener("appinstalled", () => {
    installPrompt = null;
    ui.installRow.hidden = true;
    setStatus("PocketScore is installed. You can open it from your home screen or app list.", "info", 6000);
});
ui.install.onclick = async () => {
    const p = installPrompt;
    if (!p) {
        return;
    }
    installPrompt = null;
    await p.prompt();
    const { outcome } = await p.userChoice;
    if (outcome !== "accepted") {
        ui.installRow.hidden = true; // Chrome offers it again later
    }
};

// A file's notes are found again by its contents, so a renamed copy keeps them
async function scoreKey(name: string, data: ArrayBuffer): Promise<string> {
    try {
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
        return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch (err) {
        return name + ":" + data.byteLength; // no WebCrypto (plain http)
    }
}

// ---------------------------------------------------------------- notes

const notes = new Annotations(ui.pages, ui.viewer, () => updateNotesBar(), (msg) => setStatus(msg, "error", 6000));

const COLOR_NAMES: Record<string, string> = {
    "#000000": "Black", "#ffffff": "White", "#d62828": "Red", "#1d5fd1": "Blue", "#2a9d4b": "Green", "#f2c200": "Yellow",
};

function swatch(c: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = c;
    b.dataset.color = c;
    b.setAttribute("aria-label", COLOR_NAMES[c] || "Colour " + c);
    b.onclick = () => {
        notes.setColor(c);
        closeLayer(closePalette);
        updateNotesBar();
    };
    return b;
}

for (const c of COLORS) {
    ui.swatches.insertBefore(swatch(c), ui.moreColors);
}
for (const c of MORE_COLORS) {
    ui.paletteGrid.appendChild(swatch(c));
}

// "More colours": a palette under the button, and any colour from the system picker
function closePalette() {
    ui.palette.hidden = true;
    ui.moreColors.setAttribute("aria-expanded", "false");
}

ui.moreColors.onclick = () => {
    if (!ui.palette.hidden) {
        closeLayer(closePalette);
        return;
    }
    ui.paletteCustom.value = notes.color || "#000000";
    ui.palette.hidden = false;
    ui.moreColors.setAttribute("aria-expanded", "true");
    const r = ui.moreColors.getBoundingClientRect();
    const w = ui.palette.offsetWidth;
    ui.palette.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    ui.palette.style.top = (r.bottom + 8) + "px";
    openLayer(closePalette);
};
ui.paletteCustom.addEventListener("input", () => {
    notes.setColor(ui.paletteCustom.value.toLowerCase());
    updateNotesBar();
});
ui.paletteCustom.addEventListener("change", () => closeLayer(closePalette));
// a tap anywhere else closes the palette
document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!ui.palette.hidden && !ui.palette.contains(t) && !ui.moreColors.contains(t)) {
        closeLayer(closePalette);
    }
}, true);

ui.notesbar.querySelectorAll<HTMLButtonElement>(".tool").forEach((b) => {
    b.onclick = () => {
        notes.setTool(b.dataset.tool as Tool);
        updateNotesBar();
    };
});

ui.notesFinger.onclick = () => notes.setFingerDraws(!notes.fingerDraws);

function updateNotesBar() {
    ui.notesbar.querySelectorAll<HTMLButtonElement>(".tool").forEach((b) => {
        const on = b.dataset.tool === notes.tool;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
    });
    const color = notes.color;
    ui.swatches.classList.toggle("off", notes.tool === "eraser");
    document.querySelectorAll<HTMLButtonElement>(".swatch[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
    // a colour from the palette shows on the "More colours" button
    const custom = !!color && !COLORS.includes(color);
    ui.moreColors.classList.toggle("custom", custom);
    ui.moreColors.classList.toggle("on", custom);
    ui.moreColors.style.setProperty("--custom", custom ? color : "");
    ui.notesUndo.disabled = !notes.canUndo;
    ui.notesClear.disabled = notes.count === 0;

    // "Draw with finger" matters only for touch screens and the drawing tools
    const touch = matchMedia("(any-pointer: coarse)").matches;
    const drawing = notes.tool !== "text";
    ui.notesFinger.hidden = !touch || !drawing;
    ui.notesFinger.setAttribute("aria-pressed", String(notes.fingerDraws));
    const finger = touch && notes.fingerDraws;
    const how = (verb: string) => finger
        ? `${verb} with your finger or a stylus. Scroll with two fingers.`
        : touch ? `${verb} with a stylus. Fingers scroll; turn on "Draw with finger" to use your finger.` : `${verb} on the score.`;
    const tap = touch ? "tap" : "click";
    const hints: Record<Tool, string> = {
        pen: how("Write"),
        highlighter: how("Highlight"),
        text: `Double-${tap} the score to add a text box. ${tap[0].toUpperCase() + tap.slice(1)} a box to edit it; ${tap} outside it when you're done. Drag the arrows to move it, the corner to make it bigger or smaller.`,
        eraser: touch && !finger ? "Tap or rub over a note with a stylus to remove it." : "Tap or rub over a note to remove it.",
    };
    ui.notesHint.textContent = hints[notes.tool];

    // text is sized by dragging its box's corner instead
    ui.sizes.hidden = notes.tool === "text";
    ui.sizes.querySelectorAll<HTMLButtonElement>(".size").forEach((b, i) => {
        const on = i === notes.size;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
        // a dot that grows step by step, easy to tell apart
        const dot = b.querySelector<HTMLElement>("i")!;
        dot.style.width = dot.style.height = [4, 7, 11, 16][i] + "px";
        b.setAttribute("aria-label", ["Thin", "Medium", "Thick", "Extra thick"][i]);
    });
    updateSaveState();
}

for (let i = 0; i < 4; i++) {
    const b = document.createElement("button");
    b.className = "size";
    b.setAttribute("role", "radio");
    b.innerHTML = "<i></i>";
    b.onclick = () => notes.setSize(i);
    ui.sizes.appendChild(b);
}

function setNotesActive(on: boolean) {
    notes.setActive(on);
    notes.setTool(notes.tool);
    ui.notesbar.hidden = !on;
    ui.notesToggle.setAttribute("aria-pressed", String(on));
    if (!on && !ui.palette.hidden) {
        closeLayer(closePalette);
    }
    updateNotesBar();
}

const closeNotes = () => setNotesActive(false);
ui.notesToggle.onclick = () => {
    if (notes.active) {
        closeLayer(closeNotes);
    } else {
        setNotesActive(true);
        openLayer(closeNotes);
    }
};
ui.notesDone.onclick = () => closeLayer(closeNotes);
ui.notesUndo.onclick = () => notes.undo();
// The app's own question, not confirm(): a system dialog stops the sound on iPad
ui.notesClear.onclick = async () => {
    const choice = await ask("Clear all notes?",
        "This removes all your notes from this score (in this view). You can undo it.",
        [["cancel", "Cancel"], ["clear", "Clear all"]]);
    if (choice === "clear") {
        notes.clear();
    }
};

// Let tests and the console drive the app
(window as any).app = { engine, state, openScore, notes, mix, currentMix };
