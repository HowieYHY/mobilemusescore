// first: decides whether this is someone's first visit before anything else saves data
import * as firstTime from "./firsttime";
import { Engine } from "./engine/engine";
import type { CursorInfo, PracticeInfo, ScoreInfo, SoundList, SoundNode, TrackInfo, ViewMode } from "./engine/protocol";
import { CSS_PX_PER_INCH, UNITS_PER_INCH, ensureFonts, ensureImages, pageDrawer } from "./render/pagerenderer";
import { Annotations, COLORS, MORE_COLORS, type Tool } from "./annotations";
import { MixStore, mixOf, sameMix, slot, type Mix } from "./mixerstore";
import { Tour, type TourStep } from "./tour";
import { DEFAULTS, loadSettings, saveSettings, type Settings } from "./settings";

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
    bar: $<HTMLInputElement>("bar"),
    goto: $("goto"),
    section: $<HTMLSelectElement>("section"),
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
    speedPanel: $("speed-panel"),
    speedOpen: $<HTMLButtonElement>("speed-open"),
    speedClose: $<HTMLButtonElement>("speed-close"),
    loopPanel: $("loop-panel"),
    loopOpen: $<HTMLButtonElement>("loop-open"),
    loopClose: $<HTMLButtonElement>("loop-close"),
    loopClear: $<HTMLButtonElement>("loop-clear"),
    loopHint: $("loop-hint"),
    tempoInput: $<HTMLInputElement>("tempo-input"),
    speed: $<HTMLInputElement>("speed"),
    speedValue: $("speed-value"),
    speedDown: $<HTMLButtonElement>("speed-down"),
    speedUp: $<HTMLButtonElement>("speed-up"),
    speedBadge: $("speed-badge"),
    loopToggle: $<HTMLButtonElement>("loop-toggle"),
    loopRange: $("loop-range"),
    loopLeft: $<HTMLButtonElement>("loop-left"),
    loopRight: $<HTMLButtonElement>("loop-right"),
    loopBand: $("loop-band"),
    installRow: $("install-row"),
    install: $<HTMLButtonElement>("install"),
    settings: $("settings"),
    settingsOpen: $<HTMLButtonElement>("settings-open"),
    settingsClose: $<HTMLButtonElement>("settings-close"),
};

declare const __APP_VERSION__: string;

// A preview inside the NUS Resonance website's library: the website hands over one score to play.
// Only playing, speed, loop and the mixer; no opening other files, notes or saving, and nothing is
// kept on the device.
const embedded = new URLSearchParams(location.search).get("embed") === "reso" && window.parent !== window;
// The only pages allowed to hand over a score. A local copy of the website (localhost:3000) too, so
// a branch of it can be tried with this live app. Safe: the page only gives PocketScore a score to
// play and gets nothing back; who may fetch a score is decided by the website's own sign-in.
const EMBED_ORIGINS = ((import.meta.env.VITE_EMBED_ORIGINS as string | undefined) || "https://www.nusresonance.com,https://nusresonance.com,http://localhost:3000")
    .split(",").map((o) => o.trim()).filter(Boolean);
if (embedded) {
    document.documentElement.classList.add("embedded");
}
// The reader's settings (the gear); a preview keeps nothing, so it plays with the defaults
const settings: Settings = loadSettings(!embedded);
$("version").textContent = "PocketScore " + __APP_VERSION__;

const engine = new Engine();

const ICON_PLAY = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>`;

const state = {
    score: null as ScoreInfo | null,
    zoom: 1,
    pageOps: new Map<number, any[]>(),
    pageEls: [] as HTMLDivElement[],
    rendered: new Set<string>(), // tiles drawn or being drawn
    playing: false,
    duration: 0,
    position: 0,
    seeking: false,
    followUntil: 0, // pause auto-follow while the reader scrolls
    tracks: [] as TrackInfo[],
    playbackReady: false,
    masterDb: 0,
    scoreKey: "",
    focus: false, // focus mode: only the music and a play button (issue #17)
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
// a score can only be loaded once the engine has started (a preview's score may arrive before)
let engineStarted: () => void;
const engineReady = new Promise<void>((resolve) => (engineStarted = resolve));
engine.on("engineReady", () => {
    engineStarted();
    if (!embedded) {
        setStatus("Ready. Open a score.", "info", 2500);
    }
});
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

// Pages are drawn in tiles of at most TILE_SIDE canvas pixels a side and
// TILE_PIXELS in all, and only the tiles near the view are drawn. In the
// continuous views the whole score is one long page: squeezed into one canvas
// (16 megapixels at most) it came out blurred (issue #21).
const TILE_SIDE = 2048;
const TILE_PIXELS = 4e6;
// css px: tiles this close to the view along the reading direction are drawn,
// so pages are ready before the music reaches them; across it, only this close
// (at high zoom the page's sides took canvas memory for nothing)
const NEAR = 1500;
const ACROSS = 400;

interface Rect { x: number; y: number; w: number; h: number }
interface Tile extends Rect { key: string; page: number; whole: boolean; el: HTMLDivElement }
const tiles = new Map<string, Tile>(); // by "page:tile"

// canvas pixels per engraving unit at the current zoom
const pageScale = () => unitsToCss(1) * Math.min(window.devicePixelRatio || 1, 3);

// A page's tiles in engraving units. Each overlaps the next by two canvas
// pixels, so no seam shows between them.
function tileRects(w: number, h: number, scale: number): Rect[] {
    const cols = Math.ceil(w * scale / TILE_SIDE);
    const tw = w / cols;
    const rows = Math.ceil(h * scale / Math.min(TILE_SIDE, TILE_PIXELS / (tw * scale)));
    const th = h / rows;
    const pad = 2 / scale;
    const rects: Rect[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            rects.push({ x: c * tw, y: r * th, w: Math.min(tw + pad, w - c * tw), h: Math.min(th + pad, h - r * th) });
        }
    }
    return rects;
}

// "Page by page": the page layout shown one page at a time, each page in a `.slot` at least one
// screen wide and high; a swipe turns exactly one page and the view locks onto it. Zoom goes from
// the whole page fitted to the screen (never smaller, so no other page shows) up to the usual
// limit; zoomed in, a finger moves around the page and a swipe past its edge turns it.
const pageTurn = () => ui.viewMode.value === "page_turn";
const engineMode = (v: string): ViewMode => (v === "page_turn" ? "page" : v as ViewMode);

// Zoom at which a whole page fits the screen
function fitPageZoom() {
    const p = state.score?.pages[0];
    if (!p) {
        return 1;
    }
    const css = (u: number) => u / UNITS_PER_INCH * CSS_PX_PER_INCH;
    // below the usual zoom limit if need be: a phone on its side leaves little height
    return Math.min(MAX_ZOOM, Math.max(0.05, Math.min((ui.viewer.clientWidth - 16) / css(p.w), (ui.viewer.clientHeight - 16) / css(p.h))));
}

// measured on the slots, which keep their width until rebuilt (the viewer may have changed size)
const slotWidth = () => (state.pageEls[0]?.parentElement as HTMLElement | null)?.offsetWidth || ui.viewer.clientWidth;
// the page whose slot holds the middle of the screen (a slot is never narrower than the screen,
// except just after the screen widened, before the slots are rebuilt: then the slot's middle)
const turnedTo = () => Math.max(0, Math.min(state.pageEls.length - 1,
    Math.floor((ui.viewer.scrollLeft + Math.min(ui.viewer.clientWidth, slotWidth()) / 2) / Math.max(1, slotWidth()))));
// the scroll positions that show only page i (one, unless zoomed in)
const slotRange = (i: number) => [i * slotWidth(), i * slotWidth() + Math.max(0, slotWidth() - ui.viewer.clientWidth)];
function turnTo(i: number, smooth = true) {
    i = Math.max(0, Math.min(state.pageEls.length - 1, i));
    ui.viewer.scrollTo({ left: i * slotWidth(), top: 0, behavior: smooth ? "smooth" : "instant" });
}
// After a swipe or a two-finger scroll that started on page `from`: past the page's edge by a fifth
// of the screen, or a quick flick, turns to the next page that way; otherwise back within the page.
function settleTurn(from: number, quick: boolean) {
    const [lo, hi] = slotRange(from);
    const sl = ui.viewer.scrollLeft;
    const over = (sl < lo ? sl - lo : sl > hi ? sl - hi : 0) / ui.viewer.clientWidth;
    const step = Math.abs(over) > 0.2 || (quick && Math.abs(over) > 0.05) ? Math.sign(over) : 0;
    if (step && from + step >= 0 && from + step < state.pageEls.length) {
        turnTo(from + step);
    } else if (sl < lo || sl > hi) {
        ui.viewer.scrollTo({ left: Math.min(hi, Math.max(lo, sl)), behavior: "smooth" });
    }
}
// keeps the view on the page under it (after a zoom or a drag of the handle)
function keepOnPage() {
    const [lo, hi] = slotRange(turnedTo());
    ui.viewer.scrollLeft = Math.min(hi, Math.max(lo, ui.viewer.scrollLeft));
}

// The page nearest the middle of the screen
function pageAtMiddle() {
    const v = ui.viewer.getBoundingClientRect();
    const cx = v.left + v.width / 2;
    const cy = v.top + v.height / 2;
    let best = 0;
    let bestDist = Infinity;
    state.pageEls.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const d = Math.hypot(Math.max(r.left - cx, 0, cx - r.right), Math.max(r.top - cy, 0, cy - r.bottom));
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    });
    return best;
}

// places an element over a part of page `i` (engraving units), so it scales with the page
function placeOnPage(el: HTMLElement, i: number, r: Rect) {
    const p = state.score!.pages[i];
    el.style.left = (r.x / p.w * 100) + "%";
    el.style.top = (r.y / p.h * 100) + "%";
    el.style.width = (r.w / p.w * 100) + "%";
    el.style.height = (r.h / p.h * 100) + "%";
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// a stand-in's part of its page, in engraving units
const standInRect = (c: HTMLCanvasElement): Rect => ({ x: +c.dataset.x!, y: +c.dataset.y!, w: +c.dataset.w!, h: +c.dataset.h! });
const standInsOf = (i: number) => [...state.pageEls[i]?.querySelectorAll<HTMLCanvasElement>(":scope > canvas.stale") ?? []];

// Removes the pages, freeing their drawings except those in `keep`
function clearPages(keep = new Set<HTMLCanvasElement>()) {
    observer.disconnect(); // the old pages would report "out of view" as they go
    ui.pages.querySelectorAll("canvas").forEach((c) => keep.has(c) || freeCanvas(c));
    ui.pages.innerHTML = "";
    notes.detachAll();
    state.pageEls = [];
    state.rendered.clear();
    tiles.clear();
    jobs.clear();
}

// standIns: the pages' current drawings, shown stretched while each tile is
// redrawn at a new size (zoom), so no page goes blank meanwhile
function buildPages(standIns?: Map<number, HTMLCanvasElement[]>) {
    clearPages(new Set([...standIns?.values() ?? []].flat()));
    const score = state.score;
    if (!score) {
        return;
    }
    const turn = pageTurn();
    const horizontal = turn || ui.viewMode.value === "continuous_v";
    ui.pages.style.flexDirection = horizontal ? "row" : "column";
    ui.pages.classList.toggle("turn", turn);
    ui.viewer.classList.toggle("turn", turn);
    document.body.classList.toggle("page-turn", turn);
    // one screen per page, bigger when zoomed in past it (all slots alike: the largest page)
    const css = (u: number) => unitsToCss(u) + 16;
    const slotW = Math.max(ui.viewer.clientWidth, ...score.pages.map((p) => turn ? css(p.w) : 0));
    const slotH = Math.max(ui.viewer.clientHeight, ...score.pages.map((p) => turn ? css(p.h) : 0));
    observer = new IntersectionObserver(tilesSeen, { root: ui.viewer, rootMargin: horizontal ? `${ACROSS}px ${NEAR}px` : `${NEAR}px ${ACROSS}px` });
    const scale = pageScale();
    score.pages.forEach((p, i) => {
        const el = document.createElement("div");
        el.className = "page";
        el.dataset.index = String(i);
        el.style.width = unitsToCss(p.w) + "px";
        el.style.height = unitsToCss(p.h) + "px";
        if (turn) {
            // one screen per page, the page in the middle
            const slot = document.createElement("div");
            slot.className = "slot";
            slot.style.width = slotW + "px";
            slot.style.height = slotH + "px";
            slot.append(el);
            ui.pages.appendChild(slot);
        } else {
            ui.pages.appendChild(el);
        }
        state.pageEls.push(el);
        for (const old of standIns?.get(i) ?? []) {
            old.classList.add("stale");
            placeOnPage(old, i, standInRect(old));
            el.append(old);
        }
        const rects = tileRects(p.w, p.h, scale);
        rects.forEach((r, t) => {
            const te = document.createElement("div");
            te.className = "tile";
            const key = `${i}:${t}`;
            te.dataset.key = key;
            Object.assign(te.dataset, { x: r.x, y: r.y }); // exact, for tests (a % style keeps about six digits)
            placeOnPage(te, i, r);
            el.append(te);
            tiles.set(key, { key, page: i, ...r, whole: rects.length === 1, el: te });
            observer.observe(te);
        });
        notes.attach(el, i, p.w, p.h);
    });
    ui.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
    if (turn) {
        turnFitted = Math.abs(state.zoom - fitPageZoom()) < 0.001;
    }
}

function tilesSeen(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
        const key = (e.target as HTMLElement).dataset.key!;
        if (tiles.get(key)?.el !== e.target) {
            continue; // a tile from before a rebuild
        }
        if (e.isIntersecting) {
            void renderTile(key);
        } else {
            releaseTile(key);
        }
    }
}
let observer = new IntersectionObserver(tilesSeen);

// A canvas's pixels are freed at once by sizing it to nothing (Safari counts a
// removed canvas until it is collected)
function freeCanvas(c: HTMLCanvasElement | null | undefined) {
    if (c) {
        c.width = 0;
        c.height = 0;
        c.remove();
    }
}

// A tile far out of view gives back its drawing (iPad Safari refuses new
// canvases past a memory limit, leaving pages blank); it is drawn again when
// it comes near. The page's stand-ins far from the view go too.
function releaseTile(key: string) {
    const tile = tiles.get(key);
    if (!tile) {
        return;
    }
    state.rendered.delete(key);
    const job = jobs.get(key);
    if (job) {
        jobs.delete(key);
        freeCanvas(job.canvas);
    }
    freeCanvas(tile.el.querySelector("canvas"));
    standInsOf(tile.page).filter((c) => distanceFromView(c) >= NEAR).forEach(freeCanvas);
}

// A page's stand-ins go once the tiles over them are drawn
function dropCoveredStandIns(i: number) {
    const own = [...tiles.values()].filter((t) => t.page === i);
    for (const c of standInsOf(i)) {
        const r = standInRect(c);
        if (own.every((t) => !overlaps(t, r) || t.el.querySelector("canvas"))) {
            freeCanvas(c);
        }
    }
}

let renderGeneration = 0;

// a page's drawing commands, fetched once even when several tiles ask
const opsLoading = new Map<string, Promise<any[]>>();
async function pageOps(i: number, gen: number): Promise<any[] | null> {
    const cached = state.pageOps.get(i);
    if (cached) {
        return cached;
    }
    const k = `${gen}:${i}`;
    let p = opsLoading.get(k);
    if (!p) {
        p = engine.page(i).then((json) => {
            const t0 = performance.now();
            const ops = JSON.parse(json) as any[];
            performance.measure("page-parse", { start: t0 }); // see app.state / perf tests
            return ops;
        });
        opsLoading.set(k, p);
        p.then(() => opsLoading.delete(k), () => opsLoading.delete(k));
    }
    const ops = await p;
    if (gen !== renderGeneration) {
        return null;
    }
    state.pageOps.set(i, ops);
    return ops;
}

async function renderTile(key: string) {
    const tile = tiles.get(key);
    if (!tile || state.rendered.has(key) || !state.score) {
        return;
    }
    state.rendered.add(key);
    const gen = renderGeneration;
    // a tile queued for a layout with more pages (the view changed meanwhile, e.g. a score reopened
    // after an update going back to its continuous view) has nothing to draw
    const still = () => gen === renderGeneration && state.rendered.has(key) && !!state.score?.pages[tile.page];
    if (!still()) {
        state.rendered.delete(key);
        return;
    }
    const ops = await pageOps(tile.page, gen).catch(() => null);
    if (!ops || !still()) {
        return;
    }
    await Promise.all([ensureFonts(ops, engine.base), ensureImages(ops)]);
    if (!still()) {
        return;
    }

    const scale = pageScale();
    // A device short of canvas memory refuses the context (iPad Safari). Make
    // room first: this tile's stand-ins, then stand-ins out of view; then
    // try smaller (a softer page beats a blank one), and else again in a while.
    const roomMakers = [
        () => standInsOf(tile.page).filter((c) => overlaps(tile, standInRect(c))).forEach(freeCanvas),
        () => ui.pages.querySelectorAll<HTMLCanvasElement>("canvas.stale").forEach((c) => {
            if (distanceFromView(c) > 0) {
                freeCanvas(c);
            }
        }),
    ];
    for (const s of [scale, scale, scale, scale / 2, scale / 4]) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(tile.w * s);
        canvas.height = Math.ceil(tile.h * s);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            freeCanvas(canvas);
            roomMakers.shift()?.();
            continue;
        }
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        jobs.set(key, { gen, tile, canvas, draw: pageDrawer(ctx, ops, s, tile.whole ? undefined : tile) });
        void drawJobs();
        return;
    }
    state.rendered.delete(key);
    setTimeout(() => {
        if (gen === renderGeneration && tiles.get(key) === tile && distanceFromView(tile.el) < NEAR) {
            void renderTile(key);
        }
    }, 1500);
}

// Tiles waiting to be drawn. Drawn in pieces (about 6 ms a frame while playing,
// 12 when stopped) so the playback line keeps moving, nearest the view first.
const jobs = new Map<string, { gen: number; tile: Tile; canvas: HTMLCanvasElement; draw: (ms: number) => boolean }>();
let drawing = false;
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

function distanceFromView(el: Element) {
    const v = ui.viewer.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return Math.hypot(Math.max(r.left - v.right, 0, v.left - r.right), Math.max(r.top - v.bottom, 0, v.top - r.bottom));
}

async function drawJobs() {
    if (drawing) {
        return;
    }
    drawing = true;
    try {
        while (jobs.size) {
            // fingers on the screen: wait, so the page answers them at once (when
            // it is busy, Chrome stops waiting for it and scrolls by itself)
            if (fingersBusy()) {
                await nextFrame();
                continue;
            }
            let key = "";
            let best = Infinity;
            for (const [k, job] of jobs) {
                if (job.gen !== renderGeneration || tiles.get(k) !== job.tile) {
                    jobs.delete(k);
                    freeCanvas(job.canvas);
                    continue;
                }
                const d = distanceFromView(job.tile.el);
                if (d < best) {
                    best = d;
                    key = k;
                }
            }
            if (!key) {
                break;
            }
            const job = jobs.get(key)!;
            let done = false;
            const t1 = performance.now();
            try {
                done = job.draw(state.playing ? 6 : 12);
            } catch (err) {
                // one page failing must not stop the others
                console.warn("page tile", key, "could not be drawn:", err);
                jobs.delete(key);
                freeCanvas(job.canvas);
                continue;
            }
            performance.measure("page-draw", { start: t1 });
            if (done) {
                jobs.delete(key);
                freeCanvas(job.tile.el.querySelector("canvas"));
                job.tile.el.prepend(job.canvas);
                dropCoveredStandIns(job.tile.page);
            }
            await nextFrame();
        }
    } finally {
        drawing = false;
    }
}

// Fingers down, from the touches' own count. A touch that ended on an element
// since removed may never say so, so a count with no touch activity for 3 s
// is not trusted (page drawing once waited for it for good: issue #9).
let fingersDown = 0;
let lastTouch = 0;
// (not while the finger drags the scroll handle: the app scrolls then, and the pages passed are drawn)
const fingersBusy = () => fingersDown > 0 && !scrollerDragging && performance.now() - lastTouch < 3000;
for (const t of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    window.addEventListener(t, (e) => {
        fingersDown = (e as TouchEvent).touches.length;
        lastTouch = performance.now();
    }, { passive: true, capture: true });
}

function rerenderAll(keepOps: boolean) {
    renderGeneration++;
    if (!keepOps) {
        state.pageOps.clear();
    }
    // same layout (zoom): the current drawings stand in until redrawn
    const standIns = new Map<number, HTMLCanvasElement[]>();
    if (keepOps) {
        state.pageEls.forEach((_, i) => standIns.set(i, standInsOf(i)));
        for (const tile of tiles.values()) {
            const c = tile.el.querySelector("canvas");
            if (c) {
                Object.assign(c.dataset, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
                standIns.get(tile.page)?.push(c);
            }
        }
    }
    for (const job of jobs.values()) {
        freeCanvas(job.canvas);
    }
    // keep the reader's place: remember the fraction scrolled
    const v = ui.viewer;
    const fx = v.scrollLeft / Math.max(1, v.scrollWidth);
    const fy = v.scrollTop / Math.max(1, v.scrollHeight);
    buildPages(standIns);
    v.scrollLeft = fx * v.scrollWidth;
    v.scrollTop = fy * v.scrollHeight;
    showCursor(lastCursor);
    showLoopMarks();
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
// page by page: never smaller than the whole page on the screen
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(pageTurn() ? fitPageZoom() : MIN_ZOOM, z));

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
    if (pageTurn()) {
        keepOnPage();
    }
}

function setZoom(z: number) {
    // around the middle of the view
    const v = ui.viewer.getBoundingClientRect();
    zoomAround(z, v.left + v.width / 2, v.top + v.height / 2);
}

ui.zoomIn.onclick = () => setZoom(state.zoom * 1.25);
ui.zoomOut.onclick = () => setZoom(state.zoom / 1.25);

// Two fingers: they scroll the score, and spreading or pinching them zooms
// around the point between them, which stays under them. Until the fingers'
// distance changes clearly it is a plain scroll (no zoom, no redraw); once it
// is a pinch the score is scaled with CSS and redrawn at the new size when the
// fingers lift. The only two-finger handling, in and out of notes mode.
const PINCH_START = 0.08; // the fingers' distance must change by 8% to zoom
{
    let pinch: { dist: number; zoom: number; midX: number; midY: number; sx: number; sy: number; px: number; py: number; zooming: boolean } | null = null;
    let last = { f: 1, x: 0, y: 0 };
    const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t: TouchList) => Math.max(1, Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY));
    // page by page: the page the fingers started on, and when (to settle on a page after)
    let turnFrom = { page: 0, t0: 0 };
    ui.viewer.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2 && state.score) {
            turnFrom = { page: turnedTo(), t0: performance.now() };
            const m = mid(e.touches);
            const r = ui.pages.getBoundingClientRect();
            pinch = {
                dist: dist(e.touches), zoom: state.zoom, midX: m.x, midY: m.y,
                sx: ui.viewer.scrollLeft, sy: ui.viewer.scrollTop,
                px: m.x - r.left, py: m.y - r.top, // the score point between the fingers (unscaled)
                zooming: false,
            };
            last = { f: 1, x: m.x, y: m.y };
        }
    }, { passive: true });
    let lastTouch = { m: { x: 0, y: 0 }, ratio: 1 };
    const follow = (m: { x: number; y: number }, ratio: number) => {
        if (!pinch) {
            return;
        }
        lastTouch = { m, ratio };
        if (!pinch.zooming && Math.abs(ratio - 1) < PINCH_START) {
            // scrolling: the score follows the fingers
            ui.viewer.scrollLeft = pinch.sx - (m.x - pinch.midX);
            ui.viewer.scrollTop = pinch.sy - (m.y - pinch.midY);
            last = { f: 1, x: m.x, y: m.y };
            return;
        }
        pinch.zooming = true;
        // keep within the zoom limits
        const f = clampZoom(pinch.zoom * ratio) / pinch.zoom;
        // where the unscaled score would be now (the browser may have scrolled it)
        const left0 = pinch.midX - pinch.px - (ui.viewer.scrollLeft - pinch.sx);
        const top0 = pinch.midY - pinch.py - (ui.viewer.scrollTop - pinch.sy);
        const tx = m.x - left0 - pinch.px * f;
        const ty = m.y - top0 - pinch.py * f;
        ui.pages.style.transform = `translate(${tx}px, ${ty}px) scale(${f})`;
        last = { f, x: m.x, y: m.y };
    };
    ui.viewer.addEventListener("touchmove", (e) => {
        if (!pinch || e.touches.length !== 2) {
            return;
        }
        if (e.cancelable) {
            e.preventDefault();
        }
        follow(mid(e.touches), dist(e.touches) / pinch.dist);
    }, { passive: false });
    // if the browser scrolls anyway, keep the zoomed score under the fingers
    ui.viewer.addEventListener("scroll", () => {
        if (pinch?.zooming) {
            follow(lastTouch.m, lastTouch.ratio);
        }
    }, { passive: true });
    // Finished when the last finger lifts: finishing at the first rebuilt the
    // pages under the other finger, whose lifting then never reached the app,
    // and page drawing waited for it (issue #9)
    const end = (e: TouchEvent) => {
        if (!pinch || e.touches.length > 0) {
            return;
        }
        const p = pinch;
        pinch = null;
        // the score point that started between the fingers, on screen now
        const left0 = p.midX - p.px - (ui.viewer.scrollLeft - p.sx);
        const top0 = p.midY - p.py - (ui.viewer.scrollTop - p.sy);
        ui.pages.style.transform = "";
        if (!p.zooming || last.f === 1) {
            if (p.zooming) { // pinched and back: where the fingers left it
                ui.viewer.scrollLeft -= last.x - (left0 + p.px);
                ui.viewer.scrollTop -= last.y - (top0 + p.py);
            }
            if (pageTurn()) {
                // two fingers moved sideways (notes mode, where one finger draws): turn or stay
                settleTurn(turnFrom.page, performance.now() - turnFrom.t0 < 300);
            }
            return; // a scroll: already in place
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
        // in notes mode a tap draws, except a finger's when it doesn't draw
        if (!d || d.id !== e.pointerId || !state.score || (notes.active && !notes.fingerTapIsFree(e))) {
            return;
        }
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || performance.now() - d.t > 500) {
            return;
        }
        const pageEl = (e.target as HTMLElement).closest(".page") as HTMLElement | null;
        if (!pageEl) {
            if (state.focus) {
                exitFocus(); // between or around the pages: off the music
            }
            return;
        }
        const r = pageEl.getBoundingClientRect();
        const toUnits = (css: number) => css / (CSS_PX_PER_INCH * state.zoom) * UNITS_PER_INCH;
        // a fingertip is wider than a notehead: accept notes within ~18 px, but
        // not so far that a neighbouring staff's note is picked
        const sp = state.score.spatium;
        const radius = Math.max(0.75 * sp, Math.min(toUnits(18), 3 * sp));
        const tap = { page: Number(pageEl.dataset.index), x: toUnits(e.clientX - r.left), y: toUnits(e.clientY - r.top), radius };
        if (state.focus && !nearMusic(pageEl, tap, e.clientX, e.clientY)) {
            exitFocus(); // blank paper; a tap on the music plays as usual
            return;
        }
        if (armedMarker) {
            void placeMarker(tap);
            return;
        }
        const audioReady = engine.audioRunning && state.playbackReady;
        if (!audioReady && !state.playing) {
            // the first tap starts audio (it must start from a tap on iOS); the note sounds once it's ready
            pendingPreview = settings.tapToHear ? tap : null;
            void startAudioFromTap();
        }
        const c = await engine.seekAt(tap.page, tap.x, tap.y, tap.radius, audioReady && settings.tapToHear);
        if (c) {
            state.followUntil = 0;
        }
    });
}

// Focus mode: a tap on the screen around the score (the viewer itself, past the end of the pages:
// a short score, or one far zoomed out) leaves it too; taps on the pages are handled above
{
    let down: { x: number; y: number; t: number; id: number } | null = null;
    ui.viewer.addEventListener("pointerdown", (e) => {
        down = e.isPrimary && !ui.pages.contains(e.target as Node) ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
    });
    ui.viewer.addEventListener("pointercancel", () => (down = null));
    ui.viewer.addEventListener("pointerup", (e) => {
        const d = down;
        down = null;
        if (d && d.id === e.pointerId && state.focus && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 10 && performance.now() - d.t <= 500) {
            exitFocus();
        }
    });
}

// pause following the cursor while the reader scrolls by hand
for (const ev of ["wheel", "touchmove"]) {
    ui.viewer.addEventListener(ev, () => (state.followUntil = performance.now() + 2500), { passive: true });
}

// ---------------------------------------------------------------- drag handle (issue #20)

// A handle at the score's edge (the right, or the bottom in the horizontal continuous view) to move
// through a long score quickly. It shows only while the reader scrolls (not when the page follows
// the music) and fades out after; dragging it shows the page, or in the continuous views the time
// in the music, at the middle of the screen.
let scrollerDragging = false;
{
    const box = $("scroller");
    const thumb = $("scroller-thumb");
    const label = $("scroller-label");
    const EDGE = 4; // px between the track and the screen's edge or the controls
    let hideTimer = 0;
    let lastInput = -Infinity; // the reader's own scrolling, as opposed to the page following the music
    let track = { start: 0, len: 0, across: false };
    let grab = 0; // where on the thumb the finger took it

    const across = () => ui.viewMode.value === "continuous_v" || pageTurn();
    let dragFrac = 0; // where the finger has the thumb (page by page snaps the score to whole pages)
    const thumbLen = () => (across() ? thumb.offsetWidth : thumb.offsetHeight) || 56;
    const scrollMax = () => across() ? ui.viewer.scrollWidth - ui.viewer.clientWidth : ui.viewer.scrollHeight - ui.viewer.clientHeight;
    const scrollPos = () => (across() ? ui.viewer.scrollLeft : ui.viewer.scrollTop);
    // worth having only when the score is at least two screens long
    const useful = () => !!state.score && scrollMax() > (across() ? ui.viewer.clientWidth : ui.viewer.clientHeight);

    // the track runs along the viewer's edge, stopping short of the controls over it (zoom box,
    // focus mode's play button)
    function placeTrack() {
        const v = ui.viewer.getBoundingClientRect();
        const a = across();
        const right = v.left + ui.viewer.clientLeft + ui.viewer.clientWidth; // inside a desktop scrollbar
        const bottom = v.top + ui.viewer.clientTop + ui.viewer.clientHeight;
        let end = a ? right - EDGE : bottom - EDGE;
        for (const el of document.querySelectorAll<HTMLElement>(".zoom, .focus .transport")) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) {
                continue; // hidden
            }
            if (a && r.bottom > bottom - 40 && r.top < bottom) {
                end = Math.min(end, r.left - EDGE);
            } else if (!a && r.right > right - 40 && r.left < right) {
                end = Math.min(end, r.top - EDGE);
            }
        }
        box.classList.toggle("across", a);
        if (a) {
            track = { start: v.left + EDGE, len: Math.max(0, end - v.left - EDGE), across: true };
            Object.assign(box.style, { left: track.start + "px", top: bottom - 40 + "px", width: track.len + "px", height: "40px" });
        } else {
            track = { start: v.top + EDGE, len: Math.max(0, end - v.top - EDGE), across: false };
            Object.assign(box.style, { left: right - 40 + "px", top: track.start + "px", width: "40px", height: track.len + "px" });
        }
    }

    // what is at the middle of the screen: the page in page view, the time in the music otherwise
    function labelText() {
        const v = ui.viewer.getBoundingClientRect();
        const cx = v.left + v.width / 2;
        const cy = v.top + v.height / 2;
        if (ui.viewMode.value === "page" || pageTurn()) {
            // page by page: the page it will settle on when let go
            return `Page ${(pageTurn() ? Math.min(turnedTo(), state.pageEls.length - 1) : pageAtMiddle()) + 1} of ${state.pageEls.length}`;
        }
        const el = state.pageEls[0];
        if (!el || !timeline.length) {
            return "";
        }
        const r = el.getBoundingClientRect();
        const toUnits = (css: number) => css / (CSS_PX_PER_INCH * state.zoom) * UNITS_PER_INCH;
        const a = across();
        const at = toUnits(a ? cx - r.left : cy - r.top);
        // the nearest point along the score (its first playing, where there are repeats)
        let secs = 0;
        let bestDist = Infinity;
        for (const [t, , x, y, h] of timeline) {
            const d = a ? Math.abs(x - at) : Math.max(y - at, 0, at - (y + h));
            if (d < bestDist - 1e-6) {
                bestDist = d;
                secs = t;
            }
        }
        return `${fmt(secs)} of ${fmt(state.duration)}`;
    }

    function update() {
        const max = scrollMax();
        const room = Math.max(0, track.len - thumbLen());
        const f = scrollerDragging ? dragFrac : max > 0 ? Math.min(1, Math.max(0, scrollPos() / max)) : 0;
        const t = f * room;
        thumb.style.transform = track.across ? `translateX(${t}px)` : `translateY(${t}px)`;
        thumb.setAttribute("aria-valuenow", String(Math.round(f * 100)));
        if (scrollerDragging) {
            label.textContent = labelText();
            const lw = label.offsetWidth;
            const lh = label.offsetHeight;
            label.style.transform = track.across
                ? `translateX(${Math.min(Math.max(0, t + thumbLen() / 2 - lw / 2), Math.max(0, track.len - lw))}px)`
                : `translateY(${t + thumbLen() / 2 - lh / 2}px)`;
        }
    }

    function show() {
        if (!useful()) {
            box.classList.remove("shown");
            return;
        }
        if (!box.classList.contains("shown")) {
            placeTrack();
        }
        box.classList.add("shown");
        update();
        clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => {
            if (!scrollerDragging) {
                box.classList.remove("shown");
            }
        }, 1500);
    }

    for (const ev of ["wheel", "touchmove", "keydown"]) {
        ui.viewer.addEventListener(ev, () => (lastInput = performance.now()), { passive: true });
    }
    // a desktop scrollbar dragged with the mouse
    ui.viewer.addEventListener("pointerdown", (e) => {
        if (e.target === ui.viewer) {
            lastInput = Infinity;
        }
    });
    window.addEventListener("pointerup", () => {
        if (lastInput === Infinity) {
            lastInput = performance.now();
        }
    });
    ui.viewer.addEventListener("scroll", () => {
        if (scrollerDragging || performance.now() - lastInput < 1000) {
            show();
        } else if (box.classList.contains("shown")) {
            update();
        }
    }, { passive: true });
    window.addEventListener("resize", () => box.classList.remove("shown"));
    ui.viewMode.addEventListener("change", () => box.classList.remove("shown"));

    thumb.addEventListener("pointerdown", (e) => {
        if (!box.classList.contains("shown")) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        thumb.setPointerCapture(e.pointerId);
        placeTrack();
        const r = thumb.getBoundingClientRect();
        grab = track.across ? e.clientX - r.left : e.clientY - r.top;
        dragFrac = Math.min(1, Math.max(0, scrollPos() / Math.max(1, scrollMax())));
        scrollerDragging = true;
        box.classList.add("dragging");
        state.followUntil = performance.now() + 3000;
        update();
    });
    thumb.addEventListener("pointermove", (e) => {
        if (!scrollerDragging) {
            return;
        }
        const room = Math.max(1, track.len - thumbLen());
        const p = (track.across ? e.clientX : e.clientY) - grab - track.start;
        const f = Math.min(1, Math.max(0, p / room));
        dragFrac = f;
        if (track.across) {
            ui.viewer.scrollLeft = f * scrollMax();
        } else {
            ui.viewer.scrollTop = f * scrollMax();
        }
        state.followUntil = performance.now() + 3000; // the reader's place, not the music's
        update();
    });
    const drop = () => {
        if (!scrollerDragging) {
            return;
        }
        scrollerDragging = false;
        box.classList.remove("dragging");
        state.followUntil = performance.now() + 3000;
        show(); // fades out a moment later
    };
    thumb.addEventListener("pointerup", drop);
    thumb.addEventListener("pointercancel", drop);
    thumb.addEventListener("lostpointercapture", drop);
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
    if (state.playing && settings.follow && now > state.followUntil && now - lastFollowCheck > 200) {
        lastFollowCheck = now;
        followCursor(pageEl);
    }
}

// Follow in one step when the cursor nears the edge of the view
function followCursor(pageEl: HTMLElement) {
    if (!cursorEl) {
        return;
    }
    if (pageTurn()) {
        const i = Number(pageEl.dataset.index);
        if (i !== turnedTo()) {
            turnTo(i); // the music reached another page
            return;
        }
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
    if (pageTurn()) {
        keepOnPage(); // zoomed in: within the page
    }
}

// The audio engine renders ahead and reports its position in bursts, so while
// playing the cursor is moved every frame from the audio clock, anchored to
// those reports, using the score's timeline (see Session::timelineJson).
type TimelinePoint = [number, number, number, number, number]; // secs, page, x, y, h
let timeline: TimelinePoint[] = [];
const anchor = { secs: 0, clock: 0 };

async function loadTimeline() {
    const [tl, staves] = await Promise.all([engine.timeline(), engine.staves()]);
    timeline = tl;
    // notes are pinned to the music through it and the staves (they show in every view); its times
    // follow the speed
    notes.setLayout(timeline, practice.speed, state.score?.spatium ?? 100, staves);
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
    // Times come rounded (the timeline to 0.1 ms, positions to 1 µs), so a
    // note's own time can read a hair before its point. Within half a
    // millisecond counts as reached: otherwise a line's first note fell back to
    // the previous line's closing barline, which has the same time (cursor and
    // loop markers drawn at the end of the line before).
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timeline[mid][0] <= secs + 0.0005) {
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
    if (c.duration && c.duration !== state.duration) { // changes with the speed
        state.duration = c.duration;
        ui.duration.textContent = fmt(state.duration);
    }
    showBar(c);
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
    if (holdAt) {
        // released by a report at the target: one from the old place (before or
        // after it, for a jump either way) or not yet reaching it is ignored
        const atTarget = secs >= holdAt.secs - 0.03 && secs <= holdAt.secs + 0.6;
        if (!atTarget && now < holdAt.until) {
            return;
        }
        holdAt = null;
        resyncCursor = true;
    }
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

// A jump while playing (a tapped note, the slider) is heard only once the new
// sound reaches the speaker; the reports until then still describe the old
// place, so re-syncing to the first one put the line half a second before the
// tapped note on Android. The line waits on the target instead, and moves on
// once the reports show the sound has got there (at most 2 s).
let holdAt: { secs: number; until: number } | null = null;
engine.on("seeked", (e: { secs?: number }) => {
    if (state.playing && e.secs !== undefined) {
        holdAt = { secs: e.secs, until: performance.now() + 2000 };
        reports.length = 0;
        resyncCursor = true;
        showPosition(e.secs);
    } else {
        resyncCursor = true;
    }
});

// Leaving PocketScore (another app, the home screen, locking the screen) pauses
// the music, so it doesn't play on unseen; coming back says so. Unless the reader
// chose Keep playing (Settings), for listening with the screen off.
let pausedOnLeaving = false;
document.addEventListener("visibilitychange", () => {
    lastFrame = 0; // no frames while away: not a slow frame
    void updateWakeLock();
    if (document.visibilityState === "hidden") {
        if (state.playing && !settings.keepPlaying) {
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
// A gap in the sound: the audio engine already keeps more ready from now on;
// say so once per score, so a stutter isn't a mystery
let stutterTold = false;
engine.on("stutter", () => {
    if (!stutterTold && state.playing) {
        stutterTold = true;
        setStatus("The sound stuttered, so PocketScore now prepares more of it ahead to keep it smooth.", "info", 6000);
    }
});

engine.on("audioState", (st: string) => {
    if (st !== "running" && state.playing) {
        void engine.pause();
        setStatus("Playback paused because the device stopped the sound. Tap Play to go on.", "info", 6000);
    }
});

function showPosition(secs: number, fallback?: CursorInfo) {
    state.position = secs;
    showTempo();
    if (!state.seeking) {
        ui.seek.value = String(Math.round(secs / Math.max(1, state.duration) * 1000));
    }
    ui.time.textContent = fmt(secs);
    showCursor(cursorFromTimeline(secs) || fallback || null);
}

// Playback self-check, on screen: a frame that took far too long (the line
// would jump) is logged for diagnosis (app.engine.health)
let lastFrame = 0;
function animate() {
    const now = performance.now();
    if (state.playing && lastFrame && now - lastFrame > 120 && document.visibilityState === "visible") {
        engine.note("slow frame", `${Math.round(now - lastFrame)} ms`);
    }
    lastFrame = now;
    if (state.playing) {
        // before the sound reaches the speaker the cursor waits where it is
        const secs = holdAt ? holdAt.secs
            : Math.min(state.duration, Math.max(0, anchor.secs + Math.max(0, engine.audioTime - anchor.clock)));
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
    const wasPlaying = state.playing;
    state.playing = nowPlaying;
    if (wasPlaying !== nowPlaying) {
        scheduleAutoFocus(); // the wait is shorter while playing
    }
    ui.play.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
    ui.play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
    void updateWakeLock();
});

// Keep the screen on while playing (Settings). The browser lets the lock go whenever the app is
// left, so it is asked for again on coming back.
const canWakeLock = "wakeLock" in navigator;
let wakeLock: { release(): Promise<void> } | null = null;
let wakeLockAsking = false;
async function updateWakeLock() {
    const want = canWakeLock && settings.keepAwake && state.playing && document.visibilityState === "visible";
    if (want && !wakeLock && !wakeLockAsking) {
        wakeLockAsking = true;
        try {
            const lock = await (navigator as any).wakeLock.request("screen");
            lock.addEventListener("release", () => {
                if (wakeLock === lock) {
                    wakeLock = null;
                }
            });
            wakeLock = lock;
        } catch {
            // refused (battery saver, or not allowed here): the screen behaves as usual
            return;
        } finally {
            wakeLockAsking = false;
        }
        void updateWakeLock(); // the music may have stopped while asking
    } else if (!want && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        lock.release().catch(() => {});
    }
}

// ---------------------------------------------------------------- transport

// When the sound can't start. A browser without AudioWorklet (an old one, or any page on a plain
// http address, like a test copy on the Wi-Fi) can't play at all: say so plainly. Anything else keeps
// its details, for diagnosing.
function audioFailed(err: any) {
    if (!window.isSecureContext || typeof AudioWorkletNode === "undefined") {
        setStatus("This browser can't play sound here. Use a recent Safari, Chrome or Edge, with PocketScore's usual address (https://howieyhy.github.io/mobilemusescore/).", "error");
        return;
    }
    setStatus("Audio could not start: " + (err && err.message || err), "error");
}

async function startAudioFromTap() {
    try {
        await engine.startAudio(); // also lets sound out (browsers need a tap for that)
        await engine.whenRunning();
    } catch (err: any) {
        audioFailed(err);
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
            audioFailed(err);
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
// `base` is the score's own setting in dB (100%); a part saved silent counts from 0 dB.
const MIN_DB = -60;
const MAX_DB = 12; // desktop's mixer goes to +12 dB, and scores are saved with it
const baseDb = (base: number) => (base <= -40 ? 0 : base);
const pctFromDb = (db: number, base: number) => (db <= MIN_DB ? 0 : Math.min(200, Math.round(100 * Math.pow(2, (db - baseDb(base)) / 10))));
const dbFromPct = (pct: number, base: number) => (pct <= 0 ? MIN_DB : Math.min(MAX_DB, Math.max(MIN_DB, baseDb(base) + 10 * Math.log2(pct / 100))));
const fmtDb = (db: number) => (db <= MIN_DB ? "silent" : (db > 0 ? "+" : "") + db.toFixed(1) + " dB");

const ICON_CHEVRON = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_WARN = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3L2 21h20zM12 10v5M12 17.5v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// A volume slider in percent of the score's own setting (`base`, in dB), snapping
// to 100% (as the score was saved) near the middle mark
function volumeControl(row: HTMLElement, label: string, db: number, base: number, onChange: (db: number) => void) {
    const vol = row.querySelector<HTMLInputElement>(".vol")!;
    const out = row.querySelector<HTMLElement>(".db")!;
    vol.setAttribute("aria-label", label);
    const show = (pct: number, dbNow: number) => {
        out.textContent = pct + "%";
        vol.setAttribute("aria-valuetext", `${pct} percent`);
        vol.title = fmtDb(dbNow);
    };
    const pct0 = pctFromDb(db, base);
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
        // value, keep the exact setting (touching it changes nothing), and
        // 100% is exactly the score's setting
        const d = pct === pct0 ? db : pct === 100 ? baseDb(base) : dbFromPct(pct, base);
        show(pctFromDb(d, base), d); // above +12 dB it stops: say what it is
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
        <div class="level"><input class="vol" type="range" min="0" max="200" step="1"></div>
        <output class="db"></output>
        <div class="note"></div>`;

    const master = document.createElement("div");
    master.className = "strip master";
    master.innerHTML = stripHtml;
    master.querySelector<HTMLElement>(".name")!.textContent = "Master";
    volumeControl(master, "Master volume", state.masterDb, mix.score?.master ?? state.masterDb, (db) => {
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
        volumeControl(row, `Volume of ${t.title}`, t.volume, mix.score?.parts[slot(t)]?.volume ?? t.volume, (db) => {
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

// ---------------------------------------------------------------- focus mode

// Focus (issue #17): the bars go, leaving the music and a play button, and the browser goes full
// screen where it allows (not on an iPhone, nor inside the Reso website). A tap on a stave plays as
// usual; a tap anywhere off the staves, Escape or the phone's Back brings everything back. Open
// panels are only hidden, so they come back as they were.
const focusHint = $("focus-hint");
let focusFullscreen = false;
let focusHintTimer = 0;

let focusStarting = false;
// Smooth, and only with transforms and opacity. Going in, the score rises with the top bar as the bars
// slide off their edges, so no gap opens above the music; then the layout changes under it. Coming
// back, the layout changes at once and the score is drawn where it was and glides down (a FLIP) as
// the bars slide in. Off for readers who ask for less motion.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
let barAnimations: Animation[] = [];
const barEls = () => [document.querySelector<HTMLElement>(".topbar")!, $("transport")];
function glideViewer(fromTop: number) {
    const dy = fromTop - ui.viewer.getBoundingClientRect().top;
    if (dy && !reduceMotion.matches) {
        ui.viewer.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 300, easing: EASE_OUT });
    }
}

async function enterFocus(fullscreen = true) {
    if (state.focus || focusStarting || !state.score) {
        return;
    }
    if (notes.active) {
        // finish writing first (the notes bar would be hidden anyway). Closing the top layer goes
        // through history.back(), whose popstate comes later: wait for it, or it would close focus.
        focusStarting = true;
        const closed = layers[layers.length - 1] === closeNotes
            ? new Promise<void>((done) => window.addEventListener("popstate", () => done(), { once: true }))
            : null;
        closeLayer(closeNotes);
        await closed;
        focusStarting = false;
    }
    clearTimeout(autoFocusTimer);
    state.focus = true;
    openLayer(leaveFocus);
    // full screen only from the Focus button: browsers allow it just after the reader's own tap
    const root = document.documentElement as any;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (fullscreen && settings.focusFullscreen && request && !embedded && !document.fullscreenElement) {
        focusFullscreen = true;
        Promise.resolve(request.call(root, { navigationUI: "hide" })).catch(() => (focusFullscreen = false));
    }
    if (!reduceMotion.matches) {
        const [top, bottom] = barEls();
        const out = { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" as FillMode };
        const rise = ui.viewer.getBoundingClientRect().top; // where the score starts once the bar is gone
        barAnimations = [
            top.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }], out),
            bottom.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(100%)", opacity: 0 }], out),
            ui.viewer.animate([{ transform: "none" }, { transform: `translateY(${-rise}px)` }], out),
        ];
        await Promise.all(barAnimations.map((a) => a.finished.catch(() => {})));
        if (!state.focus) {
            return; // left again meanwhile
        }
    }
    document.documentElement.classList.add("focus");
    barAnimations.forEach((a) => a.cancel()); // the layout now puts the score where it was drawn
    barAnimations = [];
    if (!reduceMotion.matches) {
        ui.play.animate([{ opacity: 0, transform: "scale(0.85)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 120, easing: EASE_OUT, fill: "backwards" });
    }
    clearTimeout(focusHintTimer);
    focusHint.classList.remove("fading");
    focusHint.hidden = false;
    focusHintTimer = window.setTimeout(() => {
        focusHint.classList.add("fading");
        focusHintTimer = window.setTimeout(() => (focusHint.hidden = true), 450);
    }, 2600);
}

function leaveFocus() {
    barAnimations.forEach((a) => a.cancel());
    barAnimations = [];
    const before = ui.viewer.getBoundingClientRect().top;
    const wasFocused = document.documentElement.classList.contains("focus");
    state.focus = false;
    document.documentElement.classList.remove("focus");
    placeSettings(); // an open panel comes back between the bars
    if (wasFocused) {
        glideViewer(before);
        if (!reduceMotion.matches) {
            const [top, bottom] = barEls();
            const back = { duration: 300, easing: EASE_OUT };
            top.animate([{ transform: "translateY(-100%)", opacity: 0 }, { transform: "none", opacity: 1 }], back);
            bottom.animate([{ transform: "translateY(100%)", opacity: 0 }, { transform: "none", opacity: 1 }], back);
        }
    }
    clearTimeout(focusHintTimer);
    focusHint.hidden = true;
    const d = document as any;
    if (focusFullscreen && (d.fullscreenElement || d.webkitFullscreenElement)) {
        Promise.resolve((d.exitFullscreen || d.webkitExitFullscreen).call(d)).catch(() => {});
    }
    focusFullscreen = false;
    scheduleAutoFocus();
}

// Focus also starts by itself when the reader leaves the screen alone: by default after 4 s while the
// music plays (like a video player's controls), 10 s while stopped (time to reach the mixer or speed);
// both, and whether it starts by itself at all, are in Settings.
// Not while something is in use: a panel, notes, the tour or a question. Without the reader's tap it
// can't go full screen, so it hides PocketScore's own bars only.
let autoFocusTimer = 0;
function scheduleAutoFocus() {
    clearTimeout(autoFocusTimer);
    // Not under test automation (navigator.webdriver, never set for a reader), where pauses longer
    // than 4 s would hide the controls the tests tap next; focus-test.mjs turns it on.
    if (!state.score || state.focus || embedded || !settings.autoFocus || (navigator.webdriver && !(window as any).app?.testAutoFocus)) {
        return;
    }
    autoFocusTimer = window.setTimeout(autoFocus, 1000 * (state.playing ? settings.focusPlayingSecs : settings.focusStoppedSecs));
}
function autoFocus() {
    if (!state.score || state.focus) {
        return;
    }
    if (layers.length || notes.active || tour.open || ui.ask.open || document.hidden || focusStarting) {
        scheduleAutoFocus();
        return;
    }
    void enterFocus(false);
}
let lastInputAt = performance.now();
for (const type of ["pointerdown", "pointermove", "keydown", "wheel"]) {
    document.addEventListener(type, () => {
        lastInputAt = performance.now();
        scheduleAutoFocus();
    }, { capture: true, passive: true });
}

function exitFocus() {
    if (state.focus) {
        closeLayer(leaveFocus);
    }
}

// leaving full screen the browser's way (Escape, Android's Back, a swipe) leaves focus too
for (const type of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(type, () => {
        const d = document as any;
        if (!(d.fullscreenElement || d.webkitFullscreenElement) && focusFullscreen) {
            focusFullscreen = false;
            exitFocus();
        }
    });
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.focus) {
        exitFocus();
    }
});
$("focus-toggle").onclick = () => void enterFocus();

// Focus mode: whether a tap is on the music (it plays from there) or off it (it leaves focus). On
// the music = within a system's band (onStave: not the title or a margin) and with printed ink
// (staff lines, notes) within a fingertip's reach on the drawn page. The bands alone counted the
// white space between staves and inside empty bars as music, so far zoomed out most of the paper
// couldn't leave focus. Before the page is drawn, the bands decide.
function nearMusic(pageEl: HTMLElement, tap: { page: number; x: number; y: number }, cx: number, cy: number): boolean {
    if (!onStave(tap.page, tap.x, tap.y)) {
        return false;
    }
    const canvas = [...pageEl.querySelectorAll<HTMLCanvasElement>(".tile > canvas, canvas.stale")].find((c) => {
        const r = c.getBoundingClientRect();
        return c.width > 0 && cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom;
    });
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
        return true;
    }
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width; // canvas pixels per CSS px
    // a staff space and a half, at least a fingertip (8 px) and at most 24 px
    const sp = unitsToCss(state.score?.spatium || 25);
    const reach = Math.min(24, Math.max(8, 1.5 * sp)) * k;
    const x0 = Math.max(0, Math.floor((cx - r.left) * k - reach));
    const y0 = Math.max(0, Math.floor((cy - r.top) * k - reach));
    const w = Math.min(canvas.width, Math.ceil((cx - r.left) * k + reach)) - x0;
    const h = Math.min(canvas.height, Math.ceil((cy - r.top) * k + reach)) - y0;
    if (w <= 0 || h <= 0) {
        return true;
    }
    const d = ctx.getImageData(x0, y0, w, h).data;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] < 600) {
            return true; // something printed nearby
        }
    }
    return false;
}

// The systems on each page, from the timeline: a tap counts as on a stave when it is inside a
// system's band, or near enough that a tap there would pick one of its notes.
let bands: { page: number; top: number; bottom: number; left: number; right: number }[] = [];
let bandsOf: TimelinePoint[] | null = null;
function onStave(page: number, x: number, y: number): boolean {
    if (bandsOf !== timeline) {
        const systems = new Map<string, (typeof bands)[number]>();
        for (const [, pg, px, py, h] of timeline) {
            const key = `${pg}|${py}`;
            const b = systems.get(key);
            if (b) {
                b.left = Math.min(b.left, px);
                b.right = Math.max(b.right, px);
            } else {
                systems.set(key, { page: pg, top: py, bottom: py + h, left: px, right: px });
            }
        }
        bands = [...systems.values()];
        bandsOf = timeline;
    }
    const sp = state.score?.spatium || 25;
    // clefs and key signatures sit before the first note, the final barline after the last
    return bands.some((b) => b.page === page && y >= b.top - 3 * sp && y <= b.bottom + 3 * sp
        && x >= b.left - 10 * sp && x <= b.right + 6 * sp);
}

// ---------------------------------------------------------------- speed and loop

// As desktop's playback toolbar, as two controls: Speed (10-300%, steps of 5)
// and Loop playback with its left and right markers, set at the play
// position and drawn on the score. Kept per score for the session only (a new
// score starts at 100% with no loop).
let practice: PracticeInfo = { speed: 1, duration: 0, loop: false };

function showPractice(p: PracticeInfo | null) {
    if (!p) {
        return;
    }
    const speedChanged = Math.abs(p.speed - practice.speed) > 1e-6;
    practice = p;
    const pct = Math.round(p.speed * 100);
    ui.speed.value = String(pct);
    ui.speedValue.textContent = pct + "%";
    ui.speedDown.disabled = pct <= 10;
    ui.speedUp.disabled = pct >= 300;
    // once changed, the button shows the tempo now (BPM), set in showTempo
    ui.speedBadge.hidden = pct === 100;
    ui.speedOpen.classList.toggle("changed", pct !== 100);

    const marked = p.fromBar !== undefined && p.toBar !== undefined;
    const bars = marked ? (p.fromBar === p.toBar ? `Bar ${p.fromBar}` : `Bars ${p.fromBar}–${p.toBar}`) : "Whole score";
    ui.loopOpen.setAttribute("aria-pressed", String(p.loop));
    ui.loopOpen.setAttribute("aria-label", p.loop ? `Loop (on: ${bars})` : "Loop (off)");
    ui.loopToggle.setAttribute("aria-pressed", String(p.loop));
    ui.loopRange.textContent = p.loop ? bars : marked ? bars + " (off)" : "Whole score";
    ui.loopClear.disabled = !marked;

    showTempo();
    if (p.duration) {
        state.duration = p.duration;
        ui.duration.textContent = fmt(state.duration);
    }
    // the loop on the position slider
    const d = Math.max(1, state.duration);
    ui.loopBand.hidden = !(p.loop && p.from !== undefined && p.to !== undefined);
    if (!ui.loopBand.hidden) {
        const f = p.from! / d;
        const t = p.to! / d;
        ui.loopBand.style.left = `calc(8px + (100% - 16px) * ${f})`;
        ui.loopBand.style.width = `calc((100% - 16px) * ${Math.max(0.004, t - f)})`;
    }
    if (speedChanged) {
        // the cursor's and markers' times follow the speed
        void Promise.all([loadTimeline(), loadTempos(), loadBars()]).then(() => {
            showPosition(state.position);
            showLoopMarks();
        });
    } else {
        showLoopMarks();
    }
}

// The markers on the score: the playback line's place at the loop's start and
// just before its end (so the end stays on its own system, as desktop does)
const loopMarks = { in: null as HTMLDivElement | null, out: null as HTMLDivElement | null };
function showLoopMarks() {
    const p = practice;
    const place = (which: "in" | "out", secs: number | undefined) => {
        const c = secs === undefined ? null : cursorFromTimeline(which === "in" ? secs : Math.max(0, secs - 0.005));
        const pageEl = c && c.page !== undefined ? state.pageEls[c.page] : null;
        let el = loopMarks[which];
        if (!c || !pageEl || p.fromBar === undefined) {
            el?.remove();
            return;
        }
        if (!el) {
            el = loopMarks[which] = document.createElement("div");
            el.className = "loop-mark " + which;
            el.setAttribute("aria-hidden", "true");
        }
        if (el.parentElement !== pageEl) {
            pageEl.appendChild(el);
        }
        // the cursor's x is its left edge; the end marker goes to its right edge
        const x = unitsToCss(c.x! + (which === "out" ? c.w! : 0));
        el.style.transform = `translate(${x}px, ${unitsToCss(c.y!)}px)`;
        el.style.height = unitsToCss(c.h!) + "px";
        el.style.opacity = p.loop ? "1" : "0.45";
    };
    place("in", p.from);
    place("out", p.to);
}

// The tempo at the play position, as desktop's toolbar shows it: quarter notes
// per minute, with the speed applied. Typing one sets the speed to match.
let tempos: [number, number][] = [];
// ---------------------------------------------------------------- go to a bar or a section (issue #26)

// Where each printed bar and section first plays (at the current speed: fetched again when it changes)
let barStarts: [number, number][] = [];
let sections: [number, string, number][] = [];

async function loadBars() {
    const b = await engine.bars();
    barStarts = b.bars;
    sections = b.sections;
    ui.section.replaceChildren(new Option("Section", "", true, false), ...sections.map(([, title], i) => new Option(title, String(i))));
    ui.section.options[0].disabled = true; // shown before the first section, not a choice
    ui.section.hidden = sections.length === 0;
    ui.goto.hidden = barStarts.length === 0;
    if (!lastPosition && barStarts.length) {
        ui.bar.value = String(barStarts[0][0]); // before the first position report: the start
    }
    showBar(lastPosition);
}

let lastPosition: CursorInfo | null = null;
// The bar and section where the music is, unless the reader is typing or choosing
function showBar(c: CursorInfo | null) {
    lastPosition = c;
    if (c?.measure && document.activeElement !== ui.bar) {
        ui.bar.value = String(c.measure);
    }
    if (c && document.activeElement !== ui.section && sections.length) {
        let at = -1;
        sections.forEach(([secs], i) => {
            if (secs <= c.secs + 1e-3) {
                at = i;
            }
        });
        ui.section.value = at < 0 ? "" : String(at);
    }
}

// Jumps there and brings it into view, also while stopped (the view follows only while playing)
async function goTo(secs: number) {
    state.followUntil = 0;
    await engine.seek(secs);
    showPosition(secs);
    const c = lastCursor;
    if (c?.page !== undefined && state.pageEls[c.page]) {
        if (pageTurn()) {
            turnTo(c.page);
        } else {
            followCursor(state.pageEls[c.page]);
        }
    }
}

function goToTypedBar() {
    const n = parseInt(ui.bar.value, 10);
    ui.bar.blur(); // closes the phone's keyboard
    if (!barStarts.length || Number.isNaN(n)) {
        showBar(lastPosition);
        return;
    }
    // that bar, or the nearest one there is (past the end: the last)
    let best = barStarts[0];
    for (const b of barStarts) {
        if (b[0] <= n) {
            best = b;
        }
    }
    ui.bar.value = String(best[0]);
    void goTo(best[1]);
}
ui.bar.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        goToTypedBar();
    } else if (e.key === "Escape") {
        ui.bar.blur();
    }
});
ui.bar.addEventListener("change", goToTypedBar);
ui.bar.addEventListener("focus", () => ui.bar.select());
ui.bar.addEventListener("blur", () => setTimeout(() => showBar(lastPosition), 0));
ui.section.addEventListener("change", () => {
    const s = sections[Number(ui.section.value)];
    ui.section.blur();
    if (s) {
        void goTo(s[0]);
    }
});

async function loadTempos() {
    tempos = await engine.tempos();
    showTempo();
}
function baseTempoAt(secs: number) {
    let bpm = tempos.length ? tempos[0][1] : 120;
    for (const [t, b] of tempos) {
        if (t > secs + 1e-6) {
            break;
        }
        bpm = b;
    }
    return bpm;
}
function showTempo() {
    const v = String(Math.round(baseTempoAt(state.position) * practice.speed));
    if (ui.speedBadge.textContent !== v) {
        ui.speedBadge.textContent = v;
        const pct = Math.round(practice.speed * 100);
        ui.speedOpen.setAttribute("aria-label", pct === 100 ? `Speed (tempo ${v})` : `Speed (${pct}%, tempo ${v})`);
    }
    if (document.activeElement === ui.tempoInput) {
        return; // being typed
    }
    if (ui.tempoInput.value !== v) {
        ui.tempoInput.value = v;
    }
}
ui.tempoInput.onchange = async () => {
    const want = Number(ui.tempoInput.value);
    const base = baseTempoAt(state.position);
    if (!(want > 0) || !base) {
        showTempo();
        return;
    }
    const m = Math.min(3, Math.max(0.1, want / base));
    showPractice(await engine.setSpeed(m, state.position));
    showTempo(); // shows the clamped tempo if the typed one was out of range
};
ui.tempoInput.onkeydown = (e) => {
    if (e.key === "Enter") {
        ui.tempoInput.blur(); // commits (change), and closes the phone's keyboard
    }
};
ui.tempoInput.onblur = () => setTimeout(showTempo, 0);

// Buttons and the slider move in 5% steps, as desktop's Speed control
async function setSpeed(pct: number) {
    pct = Math.min(300, Math.max(10, Math.round(pct / 5) * 5));
    ui.speedValue.textContent = pct + "%";
    showPractice(await engine.setSpeed(pct / 100, state.position));
}

ui.speed.oninput = () => {
    const pct = Math.round(Number(ui.speed.value) / 5) * 5;
    ui.speedValue.textContent = pct + "%";
    ui.tempoInput.value = String(Math.round(baseTempoAt(state.position) * pct / 100));
};
ui.speed.onchange = () => void setSpeed(Number(ui.speed.value));
ui.speedDown.onclick = () => void setSpeed(Math.round(practice.speed * 100) - 5);
ui.speedUp.onclick = () => void setSpeed(Math.round(practice.speed * 100) + 5);
ui.loopToggle.onclick = async () => showPractice(await engine.setLoop(!practice.loop));
// A marker button waits for a tap on the score, then puts its marker on the
// note tapped (without moving the playback or sounding the note). Tapping the
// button again, or closing the panel, cancels.
let armedMarker: "left" | "right" | null = null;
function armMarker(which: "left" | "right" | null) {
    armedMarker = which;
    ui.loopLeft.setAttribute("aria-pressed", String(which === "left"));
    ui.loopRight.setAttribute("aria-pressed", String(which === "right"));
    // the three sentences share one spot (style.css), so the panel keeps its height
    ui.loopHint.dataset.armed = which || "";
    for (const span of ui.loopHint.querySelectorAll("span")) {
        span.setAttribute("aria-hidden", String(!span.classList.contains(which ? `hint-${which}` : "hint-idle")));
    }
}
async function placeMarker(tap: { page: number; x: number; y: number; radius: number }) {
    const right = armedMarker === "right";
    armMarker(null);
    const c = await engine.locate(tap.page, tap.x, tap.y, tap.radius);
    if (c) {
        showPractice(await engine.setLoopMarker(right, c.secs));
    }
}
ui.loopLeft.onclick = () => armMarker(armedMarker === "left" ? null : "left");
ui.loopRight.onclick = () => armMarker(armedMarker === "right" ? null : "right");
ui.loopClear.onclick = async () => showPractice(await engine.clearLoop());

// Bottom-sheet panels: the mixer, speed and loop; one open at a time
const sheets = [
    { panel: ui.speedPanel, open: ui.speedOpen, close: closeSpeed },
    { panel: ui.loopPanel, open: ui.loopOpen, close: closeLoop },
];
function closeSpeed() {
    ui.speedPanel.hidden = true;
    ui.speedOpen.setAttribute("aria-expanded", "false");
}
function closeLoop() {
    armMarker(null);
    ui.loopPanel.hidden = true;
    ui.loopOpen.setAttribute("aria-expanded", "false");
}
// Opening one while another is open takes over its Back entry: closing the
// other through history first happened later and closed the new one instead
function openSheet(close: () => void) {
    const others = [closeSounds, closeMixer, closeSpeed, closeLoop, closeSettings].filter((c) => c !== close);
    let reuse = false;
    for (let i = layers.length - 1; i >= 0; i--) {
        if (others.includes(layers[i])) {
            const c = layers.splice(i, 1)[0];
            c();
            reuse = true;
        }
    }
    if (reuse) {
        layers.push(close);
    } else {
        openLayer(close);
    }
}
for (const s of sheets) {
    s.open.onclick = () => {
        if (!s.panel.hidden) {
            closeLayer(s.close);
            return;
        }
        s.panel.hidden = false;
        s.open.setAttribute("aria-expanded", "true");
        openSheet(s.close);
    };
}
ui.speedClose.onclick = () => closeLayer(closeSpeed);
ui.loopClose.onclick = () => closeLayer(closeLoop);

// Panels and the zoom buttons sit on the bottom bar, whose height changes
// (two rows on phones, the home indicator)
new ResizeObserver(() => {
    document.documentElement.style.setProperty("--transport-h", $("transport").offsetHeight + "px");
}).observe($("transport"));

// ---------------------------------------------------------------- settings

// The gear: one set of settings for the whole app, kept on this device. Each applies at once; those
// about opening a score apply to the next one opened. One panel at a time, like the bottom sheets.
function closeSettings() {
    ui.settings.hidden = true;
    ui.settingsOpen.setAttribute("aria-expanded", "false");
}
// The panel fills the space between the two bars exactly, measured where they are now. A size kept
// from earlier went stale on Android: the status bar's room is padding on the top bar, and a
// change of it alone reports no new size, so the panel hung ~60 px below the bar (seen 15 Oct 2026).
// Layout offsets, not the screen box: the bars may be sliding back in after focus.
function placeSettings() {
    if (ui.settings.hidden) {
        return;
    }
    const bar = document.querySelector<HTMLElement>(".topbar")!;
    const top = bar.offsetTop + bar.offsetHeight;
    const bottom = $("transport").offsetTop;
    ui.settings.style.top = top + "px";
    ui.settings.style.maxHeight = Math.max(120, bottom - top) + "px";
}
for (const el of [document.querySelector<HTMLElement>(".topbar")!, $("transport")]) {
    new ResizeObserver(placeSettings).observe(el, { box: "border-box" });
}
window.addEventListener("resize", placeSettings);
window.visualViewport?.addEventListener("resize", placeSettings);
ui.settingsOpen.onclick = () => {
    if (!ui.settings.hidden) {
        closeLayer(closeSettings);
        return;
    }
    showSettings();
    ui.settings.hidden = false;
    placeSettings();
    ui.settingsOpen.setAttribute("aria-expanded", "true");
    openSheet(closeSettings);
};
ui.settingsClose.onclick = () => closeLayer(closeSettings);

// What this device can't do is shown switched off, saying so (not hidden, not a switch that does nothing)
const rootEl = document.documentElement as any;
const unavailable: Partial<Record<keyof Settings, boolean>> = {
    focusFullscreen: !(rootEl.requestFullscreen || rootEl.webkitRequestFullscreen), // iPhone
    keepAwake: !canWakeLock,
};
const settingInputs = [...ui.settings.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-set]")];

function showSettings() {
    for (const el of settingInputs) {
        const k = el.dataset.set as keyof Settings;
        const off = !!unavailable[k];
        const needs = el.dataset.needs as keyof Settings | undefined;
        const disabled = off || (!!needs && !settings[needs]);
        if (el instanceof HTMLInputElement) {
            el.checked = !off && settings[k] as boolean;
        } else {
            el.value = String(settings[k]);
        }
        el.disabled = disabled;
        const row = el.closest(".set-row")!;
        row.classList.toggle("off", disabled);
        const hint = row.querySelector<HTMLElement>(".set-hint[data-unavailable]");
        if (hint && off) {
            hint.textContent = hint.dataset.unavailable!;
        }
    }
    ui.settings.querySelectorAll<HTMLElement>(".apple-only").forEach((e) => (e.hidden = !appleTouch));
}

for (const el of settingInputs) {
    el.addEventListener("change", () => {
        const k = el.dataset.set as keyof Settings;
        (settings as any)[k] = el instanceof HTMLInputElement ? el.checked
            : typeof DEFAULTS[k] === "number" ? Number(el.value) : el.value;
        saveSettings(settings, !embedded);
        showSettings(); // a setting can switch others on or off
        if (k === "autoFocus" || k === "focusPlayingSecs" || k === "focusStoppedSecs") {
            scheduleAutoFocus();
        } else if (k === "keepAwake") {
            void updateWakeLock();
        }
    });
}

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
    openSheet(closeMixer);
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
    const store = new MixStore(state.scoreKey, !embedded); // a preview keeps nothing
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
    if (embedded) {
        return true; // a preview keeps nothing (and has no Save)
    }
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
    await openChosen(file.name, await file.arrayBuffer());
};

// A score the reader chose (Open score, or shared from another app): asks
// about unsaved changes first
async function openChosen(name: string, data: ArrayBuffer) {
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
    await openScore(name, data);
}

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
    stutterTold = false;
    clearTimeout(draftTimer);
    Object.assign(mix, { store: null, score: null, saved: null, dirty: false, pendingSounds: {} });
    // the sounds may report ready at any point from here on: they wait for the restore below
    let mixRestoreDone: (restored: boolean) => void = () => {};
    mixLoading = new Promise((resolve) => (mixRestoreDone = resolve));
    state.pageOps.clear();
    ui.mixerToggle.disabled = true;
    const key = await scoreKey(name, data); // before the data goes to the engine
    state.scoreKey = key;
    openedScore = { name, data: data.slice(0) }; // a copy to reopen after restarting into an update
    const res = await engine.load(name, data);
    if (!res.ok || !res.score) {
        mixRestoreDone(false);
        setStatus(res.error || "Could not open this score.", "error");
        return;
    }
    state.score = res.score;
    scheduleAutoFocus();
    state.duration = res.score.duration;
    state.position = 0;
    state.tracks = res.score.tracks;
    lastCursor = null;
    ui.title.textContent = res.score.title || name.replace(/\.(mscz|mscx)$/i, "");
    $("open-label").classList.remove("primary"); // only the start screen's main action
    ui.empty.hidden = true;
    firstTime.markSeen("opened");
    ui.viewMode.disabled = false;
    ui.viewMode.value = "page";
    shownView = "page";
    ui.play.disabled = false;
    ui.speedOpen.disabled = false;
    ui.loopOpen.disabled = false;
    showPractice({ speed: 1, duration: state.duration, loop: false }); // the engine starts each score so
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
    // the view chosen in Settings: laid out straight in it, without drawing Page view first
    const startView = settings.startView;
    if (startView === "page") {
        buildPages();
        void loadTimeline();
    } else {
        clearPages(); // the last score's pages go now; changeView below builds this one's
    }
    void loadTempos();
    lastPosition = null;
    void loadBars();
    ui.viewer.scrollTop = 0;
    ui.viewer.scrollLeft = 0;
    if (startView !== "page") {
        ui.viewMode.value = startView;
        await changeView();
    }

    // the mixer works from the start: its values come from the score, and the
    // sounds load now rather than on the first Play
    const mixRestored = await loadMix();
    if (settings.metronomeOn) {
        // the metronome's on/off isn't part of the saved mixer, so this changes nothing to save
        const m = state.tracks.find((t) => t.metronome);
        if (m?.mute) {
            await engine.setMute(m.key, false);
            state.tracks = await engine.tracks();
        }
    }
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

ui.viewMode.onchange = () => changeView();
async function changeView() {
    const was = shownView;
    const view = ui.viewMode.value;
    shownView = view;
    // page by page and page view share a layout: stay on the same page
    const keepPage = was === "page" || was === "page_turn" ? (was === "page_turn" ? turnedTo() : pageAtMiddle()) : 0;
    setStatus("Laying out…");
    state.score = await engine.setViewMode(engineMode(view));
    notes.setMode(engineMode(view)); // notes belong to the layout they were written on
    await loadTimeline();
    // before fitting: the message above the score takes height, and when it goes within the same
    // frame nothing reports the screen growing back (the page stayed fitted to the shorter screen)
    setStatus("");
    if (view === "page_turn") {
        if (was !== "page_turn") {
            zoomBeforeTurn = state.zoom;
        }
        state.zoom = fitPageZoom();
        turnFitted = true;
    } else if (was === "page_turn") {
        state.zoom = zoomBeforeTurn;
    }
    rerenderAll(false);
    if (view === "page_turn") {
        turnTo(keepPage, false);
    } else if (was === "page_turn" && view === "page") {
        state.pageEls[keepPage]?.scrollIntoView({ block: "start" });
    }
}
let shownView = "page";
let zoomBeforeTurn = 1;
let turnFitted = true; // page by page at the whole-page zoom (kept that way when the screen changes)

// Page by page: a new screen size (turning the phone, focus mode, the notes bar) fits the page
// again (or, zoomed in, keeps the zoom within the new limits), on the same page
{
    let size = "";
    let timer = 0;
    new ResizeObserver(() => {
        const now = `${ui.viewer.clientWidth}x${ui.viewer.clientHeight}`;
        if (now === size) {
            return;
        }
        size = now;
        if (!pageTurn() || !state.score) {
            return;
        }
        clearTimeout(timer);
        timer = window.setTimeout(() => {
            const page = turnedTo(); // now, not when the size changed: the reader may have turned since
            state.zoom = turnFitted ? fitPageZoom() : clampZoom(state.zoom);
            rerenderAll(true);
            turnTo(page, false);
        }, 150);
    }).observe(ui.viewer);
}

// Page by page: turning with a finger. The browser's own scroll snapping chose the nearest page
// when the finger lifted, so a slow half swipe went back, and it differs between Chrome and Safari;
// here the page follows the finger (zoomed in, it moves around the page), and on lifting past the
// page's edge it turns one page that way if it went a fifth of the screen or was a quick flick, else
// it springs back (settleTurn). The viewer has touch-action: none in this view, so the browser
// doesn't scroll by itself. (A finger that draws in notes mode draws; two fingers move there.)
{
    let swipe: { x0: number; y0: number; left: number; top: number; from: number; t0: number; moving: boolean } | null = null;
    ui.viewer.addEventListener("touchstart", (e) => {
        swipe = null;
        if (pageTurn() && e.touches.length === 1 && !ui.pages.classList.contains("finger-draw")) {
            const t = e.touches[0];
            swipe = { x0: t.clientX, y0: t.clientY, left: ui.viewer.scrollLeft, top: ui.viewer.scrollTop, from: turnedTo(), t0: performance.now(), moving: false };
        }
    }, { passive: true });
    ui.viewer.addEventListener("touchmove", (e) => {
        if (!swipe || e.touches.length !== 1) {
            swipe = null;
            return;
        }
        const dx = e.touches[0].clientX - swipe.x0;
        const dy = e.touches[0].clientY - swipe.y0;
        if (!swipe.moving && Math.hypot(dx, dy) > 8) {
            swipe.moving = true;
            state.followUntil = performance.now() + 2500; // the reader's page, not the music's
        }
        if (swipe.moving) {
            // never further than the next page either way
            const [lo, hi] = slotRange(swipe.from);
            const vw = ui.viewer.clientWidth;
            ui.viewer.scrollLeft = Math.min(Math.max(swipe.left - dx, lo - vw), hi + vw);
            ui.viewer.scrollTop = swipe.top - dy;
        }
    }, { passive: true });
    const lift = () => {
        const sw = swipe;
        swipe = null;
        if (sw?.moving) {
            settleTurn(sw.from, performance.now() - sw.t0 < 300);
        }
    };
    ui.viewer.addEventListener("touchend", lift);
    ui.viewer.addEventListener("touchcancel", lift);

    // a trackpad or wheel scrolling sideways: when it stops between pages, go to the nearest
    let idle = 0;
    ui.viewer.addEventListener("scroll", () => {
        if (!pageTurn()) {
            return;
        }
        clearTimeout(idle);
        idle = window.setTimeout(() => {
            if (!pageTurn() || swipe || fingersDown > 0 || scrollerDragging) {
                return;
            }
            const [lo, hi] = slotRange(turnedTo());
            const sl = ui.viewer.scrollLeft;
            if (sl < lo - 0.5 || sl > hi + 0.5) {
                ui.viewer.scrollTo({ left: Math.min(hi, Math.max(lo, sl)), behavior: "smooth" });
            }
        }, 150);
    }, { passive: true });
}

// Keys turn pages in page by page (computers, iPads with a keyboard)
document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (!pageTurn() || !state.score || layers.length || t.closest("input, select, textarea, [contenteditable]")) {
        return;
    }
    const step = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[e.key];
    if (step) {
        e.preventDefault();
        turnTo(turnedTo() + step);
    }
});

// Offline: keep the app, engine and sounds on the device (production builds only)
if ("serviceWorker" in navigator && import.meta.env.PROD) {
    const sw = navigator.serviceWorker;
    const isUpdate = !!sw.controller; // an older version is running this page
    // updateViaCache "none": check sw.js itself for updates, not a copy kept by the browser's cache
    // (GitHub Pages lets browsers keep it 10 minutes; Safari then stayed on the old version after 1.0.3)
    sw.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
        // a home-screen app can stay open for days: look for updates when it comes back
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                reg.update().catch(() => {});
            }
        });
        // and every 30 minutes while it stays open (a tablet on a music stand)
        setInterval(() => {
            if (document.visibilityState === "visible") {
                reg.update().catch(() => {});
            }
        }, 30 * 60 * 1000);
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
        updateReady = true;
        if (!state.score) {
            location.reload();
            return;
        }
        // a fallback the reader can use at once; otherwise it restarts by itself at a quiet moment
        setStatus("PocketScore has been updated. It restarts by itself when you pause (your score comes back), or tap here now.");
        ui.status.classList.add("action");
        ui.status.onclick = () => void restartForUpdate();
        void maybeRestartForUpdate();
    });
}

// ---------------------------------------------------------------- updating while a score is open

// An update is applied by restarting the page, which would close the score: so PocketScore restarts by
// itself at a quiet moment and reopens the score where the reader was. Never while the music plays,
// nor while a panel, notes, the tour or a question is open (focus mode is fine); at once when the app
// is in the background (another app, home screen, locked), otherwise after 20 s untouched. The score
// is kept in IndexedDB across the restart only, and deleted when it has been reopened; unsaved notes
// and mixer changes come back from their silent drafts, as after closing the app.
let updateReady = false;
let restarting = false;
let openedScore: { name: string; data: ArrayBuffer } | null = null;
const UPDATE_IDLE_MS = 20000;
const RESTART_DB = "pocketscore-restart";

function quietForUpdate(): boolean {
    return !state.playing && !restarting && !focusStarting && !notes.active && !tour.open && !ui.ask.open
        && !layers.some((close) => close !== leaveFocus);
}
async function maybeRestartForUpdate() {
    if (updateReady && state.score && quietForUpdate()
        && (document.hidden || performance.now() - lastInputAt >= UPDATE_IDLE_MS)) {
        await restartForUpdate();
    }
}
setInterval(() => void maybeRestartForUpdate(), 2000);
document.addEventListener("visibilitychange", () => void maybeRestartForUpdate());

function restartStore<T>(write: boolean, act: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    return new Promise((resolve) => {
        const open = indexedDB.open(RESTART_DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore("s");
        open.onerror = () => resolve(undefined);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("s", write ? "readwrite" : "readonly");
            const req = act(tx.objectStore("s"));
            tx.oncomplete = () => {
                db.close();
                resolve(req ? (req.result as T) : undefined);
            };
            tx.onerror = tx.onabort = () => {
                db.close();
                resolve(undefined);
            };
        };
    });
}

interface RestartState {
    at: number;
    name: string;
    data: ArrayBuffer;
    view: string;
    zoom: number;
    scrollTop: number;
    scrollLeft: number;
    position: number;
    speed: number;
    loop: boolean;
    from?: number;
    to?: number;
    focus: boolean;
}

async function restartForUpdate() {
    if (restarting) {
        return;
    }
    restarting = true;
    if (openedScore && state.score) {
        clearTimeout(draftTimer); // unsaved mixer changes: their draft now, not in 400 ms
        mix.store?.setDraft(mix.dirty ? currentMix() : null);
        const keep: RestartState = {
            at: Date.now(),
            name: openedScore.name,
            data: openedScore.data,
            view: ui.viewMode.value,
            zoom: state.zoom,
            scrollTop: ui.viewer.scrollTop,
            scrollLeft: ui.viewer.scrollLeft,
            position: state.position,
            speed: practice.speed,
            loop: practice.loop,
            from: practice.from,
            to: practice.to,
            focus: state.focus,
        };
        await restartStore(true, (s) => s.put(keep, "score"));
    }
    if (!document.hidden) {
        setStatus("Updating PocketScore…");
    }
    location.reload();
}

// After the restart: the score, its layout, speed, loop, place and view, as they were
async function reopenAfterUpdate() {
    if (embedded) {
        return;
    }
    const keep = await restartStore<RestartState>(false, (s) => s.get("score"));
    if (!keep) {
        return;
    }
    await restartStore(true, (s) => {
        s.delete("score");
    });
    if (Date.now() - keep.at > 10 * 60 * 1000 || !(keep.data instanceof ArrayBuffer)) {
        return; // not from a restart just now
    }
    await engineReady;
    await openScore(keep.name, keep.data);
    if (!state.score) {
        return;
    }
    if (keep.view !== ui.viewMode.value && [...ui.viewMode.options].some((o) => o.value === keep.view)) {
        ui.viewMode.value = keep.view; // as it was, whatever view Settings opens scores in
        await changeView();
    }
    if (keep.speed !== 1) {
        showPractice(await engine.setSpeed(keep.speed, 0));
    }
    if (keep.from !== undefined && keep.to !== undefined) {
        await engine.setLoopMarker(false, keep.from);
        showPractice(await engine.setLoopMarker(true, keep.to));
        if (practice.loop !== keep.loop) {
            showPractice(await engine.setLoop(keep.loop));
        }
    }
    if (keep.position > 0) {
        // the engine takes a jump once the sounds are ready; one sent earlier is lost
        for (let waited = 0; !state.playbackReady && waited < 60000; waited += 100) {
            await new Promise((r) => setTimeout(r, 100));
        }
        await engine.seek(keep.position);
    }
    if (Math.abs(keep.zoom - state.zoom) > 0.001) {
        state.zoom = clampZoom(keep.zoom);
        rerenderAll(true);
    }
    state.followUntil = performance.now() + 3000; // the reader's own place, not the cursor's
    ui.viewer.scrollTop = keep.scrollTop;
    ui.viewer.scrollLeft = keep.scrollLeft;
    setStatus(`PocketScore is up to date (${__APP_VERSION__}). Your score is back where you were.`, "info", 5000);
    if (keep.focus) {
        void enterFocus(false);
    }
}
void reopenAfterUpdate();

// A score shared to PocketScore from another app (Android's Share list): the
// service worker keeps it and opens the app with ?shared=1 (sw.js receiveShared)
async function openShared() {
    const url = new URL(location.href);
    if (url.searchParams.get("shared") !== "1" || embedded) {
        return;
    }
    url.searchParams.delete("shared");
    history.replaceState(null, "", url.href); // a reload doesn't open it again
    let found: { name: string; data: ArrayBuffer } | null = null;
    try {
        const cache = await caches.open("shared-score");
        const key = new URL("shared-score", url).href;
        const res = await cache.match(key);
        if (res) {
            found = { name: decodeURIComponent(res.headers.get("x-name") || "shared.mscz"), data: await res.arrayBuffer() };
            await cache.delete(key);
        }
    } catch {
        // no cache storage: nothing was kept
    }
    if (!found) {
        setStatus("Nothing arrived from the other app. Use Open score instead.", "error");
        return;
    }
    await engineReady;
    await openChosen(found.name, found.data);
}
void openShared();

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
// iPhone and iPad (iPadOS also passes for a Mac, with touch) have no install prompt, so the start
// screen says how, until PocketScore runs as the installed app (issue #13).
const appleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
$("install-ios").hidden = !appleTouch || standalone || embedded;
// The steps differ by browser: Chrome (CriOS) and other iOS browsers (Firefox FxiOS, Edge EdgiOS…)
// name themselves in the user agent; anything else is Safari.
// iPad Safari has Share at the top right instead of under ••• at the bottom (checked on an iPad).
const onIPad = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const iosBrowser = /CriOS\//.test(navigator.userAgent) ? "chrome" : /FxiOS|EdgiOS|OPiOS|GSA\//.test(navigator.userAgent) ? "other" : onIPad ? "safari-ipad" : "safari";
for (const el of document.querySelectorAll<HTMLElement>("#install-ios [class^='for-']")) {
    el.hidden = !el.classList.contains("for-" + iosBrowser);
}
const installSteps = {
    safari: "In Safari: ••• at the bottom, then Share, then View More and Add to Home Screen further down the list.",
    "safari-ipad": "In Safari: Share at the top right, then View More and Add to Home Screen further down the list.",
    chrome: "In Chrome: Share beside the address, then View More and Add to Home Screen further down the list.",
    other: "Choose Add to Home Screen from your browser's Share menu.",
}[iosBrowser];

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
        "This removes all your notes from this score, in every view. You can undo it.",
        [["cancel", "Cancel"], ["clear", "Clear all"]]);
    if (choice === "clear") {
        notes.clear();
    }
};

// Let tests and the console drive the app
// pages: what page drawing is waiting for (tests and USB debugging)
const pagesInfo = () => ({ fingersDown, sinceTouchMs: Math.round(performance.now() - lastTouch), waiting: [...jobs.keys()], drawing });
(window as any).app = { engine, state, settings, openScore, notes, mix, currentMix, pagesInfo, firstTime, cursorAt: (secs: number) => cursorFromTimeline(secs),
    // update-restart-test.mjs: an update can't be produced on demand there
    markUpdateReady: () => (updateReady = true), restartForUpdate };

// ---------------------------------------------------------------- preview in the Reso website

if (embedded) {
    setStatus("Loading the score…");
    window.addEventListener("message", async (e) => {
        if (e.source !== window.parent || !EMBED_ORIGINS.includes(e.origin)) {
            return; // only the Resonance website's own page may hand over a score
        }
        const m = e.data;
        if (m?.type !== "pocketscore-open" || typeof m.name !== "string" || !(m.data instanceof ArrayBuffer)) {
            return;
        }
        await engineReady;
        if (state.playing) {
            await engine.stop();
        }
        await openScore(m.name, m.data);
    });
    // nothing secret in it: the website answers with the score only if it is the page around us
    window.parent.postMessage({ type: "pocketscore-ready" }, "*");
}

// ---------------------------------------------------------------- tour (issue #15)

// What each control does, one at a time. The ? button starts it; first-time users (#16) are also
// invited on the start screen until they take it or open a score. It never starts by itself.
const tour = new Tour($("tour"), $("tour-ring"), $("tour-card"));
const tourInvite = $("tour-invite");
tourInvite.hidden = embedded || !firstTime.isNewcomer() || firstTime.hasSeen("tour") || firstTime.hasSeen("opened");

function tourSteps(): TourStep[] {
    const el = (id: string) => () => $(id);
    // last in both: a tip, never called a donation (Stripe's rules)
    const tipStep: TourStep = { target: el("tip-heart"), title: "Leave a tip", text: "PocketScore is free. If it helps you, tap the heart to leave a tip by PayNow or card. Tips pay UI designers and, in future, the App Store and Google Play fees." };
    if (!state.score) {
        return [
            { target: el("open-label"), title: "Open a score", text: "Choose a MuseScore file (.mscz) on this device. On iPhone and iPad, save your scores to the Files app first. On Android you can also share a score to PocketScore from the Files app." },
            ...(ui.installRow.hidden ? [] : [{ target: el("install-row"), title: "Install PocketScore", text: "Add it to your home screen or app list, so it opens like an app and works offline." }]),
            ...($("install-ios").hidden ? [] : [{ target: el("install-ios"), title: "Install PocketScore", text: installSteps + " It opens like an app and works offline." }]),
            { target: el("settings-open"), also: () => [$("help")], title: "Settings and help", text: "The gear has Settings, such as keeping the music playing when you leave the app. Once a score is open, tap ? again to see how to play it, practise your part and write on it." },
            tipStep,
        ];
    }
    // bottom bar left to right, then the top bar, the tip last: no bouncing between the two. Neighbouring
    // controls share a step (the user found 14 steps too many, 16 Oct 2026)
    return [
        { target: () => ui.viewer, title: "The score", text: "Tap any note to play from there. While stopped, a tap plays just that note. Pinch, or use − and +, to zoom. In a long score, start scrolling and drag the handle that appears at the edge." },
        { target: el("play"), also: () => [el("rewind")(), document.querySelector<HTMLElement>(".timeline")], title: "Play and move around", text: "Play and pause here; the blue line shows where you are, and the page follows it. Drag the slider to jump anywhere, or type a bar number under it" + (sections.length ? " or pick a section from the menu beside it" : "") + ". The button on the left goes back to the start." },
        { target: el("speed-open"), also: () => [el("loop-open")()], title: "Practise", text: "Speed: play slower or faster, or type the tempo you want. Loop: repeat a passage, from a marker on its first note to one on its last." },
        { target: el("mixer-toggle"), title: "Mixer", text: "Hear your own part: change each part's volume, mute or solo it, or choose a different sound." },
        { target: el("notes-toggle"), also: () => [el("save")()], title: "Your notes", text: "Write on the score with a pen, highlighter or text boxes, using a finger or a stylus. Save keeps your notes and mixer changes for this score on this device, not in the file. If you forget, PocketScore asks before you open another score." },
        { target: el("view-mode"), title: "Views", text: "Page view scrolls through the pages. Page by page shows one whole page at a time: swipe left or right to turn it, and zoom in to read closer. Continuous lays the music out in one long line." },
        { target: el("focus-toggle"), also: () => [el("settings-open")(), el("help")()], title: "Focus, settings and help", text: "Focus (the first icon) hides everything but the music and a play button; tap off the staves to bring the controls back. The gear has Settings, such as keeping the music playing when you leave the app. ? shows this tour again." },
        tipStep,
    ];
}

const closeTour = () => tour.end();

function startTour() {
    if (tour.open || embedded) {
        return;
    }
    firstTime.markSeen("tour");
    tourInvite.hidden = true;
    // the phone's Back button closes it, like the other panels
    tour.start(tourSteps(), () => closeLayer(closeTour));
    openLayer(closeTour);
}

$("help").onclick = startTour;
$("tour-start").onclick = startTour;
