// first: decides whether this is someone's first visit before anything else saves data
import { editDraft, type EditDraft } from "./editdraft";
import { CLEFS, KEYS, TIMES, buildScore, type LineChoice } from "./newscore";
import { CLICK_HZ, CLICK_SECS, SAMPLE_RATE, decodeTo16k, findNotes, removeClicks, toGrid, trackPitch, type GridNote, type SungNote } from "./voice/transcribe";
import * as firstTime from "./firsttime";
import { Engine } from "./engine/engine";
import type { CursorInfo, EditSelection, EditResult, PracticeInfo, ScoreInfo, SoundList, SoundNode, TrackInfo, ViewMode } from "./engine/protocol";
import { CSS_PX_PER_INCH, UNITS_PER_INCH, ensureFonts, ensureImages, pageDrawer } from "./render/pagerenderer";
import { Annotations, COLORS, MORE_COLORS, type Tool } from "./annotations";
import { MixStore, mixOf, sameMix, slot, type Mix } from "./mixerstore";
import { Tour, type TourStep } from "./tour";
import { DEFAULTS, loadSettings, saveSettings, type Settings } from "./settings";
import { numberField } from "./typing";
import { PlayLog, stamp } from "./playlog";

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
    editToggle: $<HTMLButtonElement>("edit-toggle"),
    editbar: $("editbar"),
    editInfo: $("edit-info"),
    editUndo: $<HTMLButtonElement>("edit-undo"),
    editRedo: $<HTMLButtonElement>("edit-redo"),
    editCopy: $<HTMLButtonElement>("edit-copy"),
    editDone: $<HTMLButtonElement>("edit-done"),
    editPrev: $<HTMLButtonElement>("edit-prev"),
    editNext: $<HTMLButtonElement>("edit-next"),
    editUp: $<HTMLButtonElement>("edit-up"),
    editDown: $<HTMLButtonElement>("edit-down"),
    editOctave: $<HTMLButtonElement>("edit-octave"),
    editDelete: $<HTMLButtonElement>("edit-delete"),
    editLengths: $("edit-lengths"),
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
// The Composer (Edit, New score, Continue) is not published yet: the user chose to put Two pages
// live without it (11 Nov 2026), as it had not been tried on devices. Its ways in are hidden in the
// published app unless the address has ?composer; the dev server (and so the tests) shows them.
// To publish it, make this `true` and take the "Not in the published app yet" notes out of the README.
const composer = import.meta.env.DEV || new URLSearchParams(location.search).has("composer");
if (!composer) {
    document.documentElement.classList.add("no-composer");
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
//
// "Two pages" (issue #34) is the same view with two slots per screen: pages 1 and 2, and a swipe
// moves on by one page (2 and 3, then 3 and 4), the right page going to the left. It asks the
// device to stay on its side while it shows (where the device allows that), and starts Focus.
// It is a camera over the pages laid in one row: the pages touch but for PAIR_GAP at every zoom
// (a slot is a page's width plus that), the row's ends are padded so the first and last two can
// sit in the middle, a swipe slides the camera along and it settles on two pages, and zooming
// zooms the camera. Where the screen is wider than two pages (a phone on its side, where the
// height sets the size) the pages before and after show at the sides, cut by the screen's edge.
const PAIR_GAP = 4; // css px between the two pages
const turnView = (v: string) => v === "page_turn" || v === "page_pair";
const pageTurn = () => turnView(ui.viewMode.value);
const engineMode = (v: string): ViewMode => (turnView(v) ? "page" : v as ViewMode);
// pages per screen in the view chosen (a one-page score has its page alone, in the middle)
const perScreen = () => (ui.viewMode.value === "page_pair" ? Math.min(2, state.score?.pages.length || 1) : 1);
let span = 1; // pages per screen in the pages as built (the menu changes before they are rebuilt)

// Zoom at which a whole page fits the screen
function fitPageZoom() {
    const p = state.score?.pages[0];
    if (!p) {
        return 1;
    }
    const css = (u: number) => u / UNITS_PER_INCH * CSS_PX_PER_INCH;
    // below the usual zoom limit if need be: a phone on its side leaves little height
    const n = perScreen();
    return Math.min(MAX_ZOOM, Math.max(0.05, Math.min(((ui.viewer.clientWidth - 16 - (n - 1) * PAIR_GAP) / n) / css(p.w), (ui.viewer.clientHeight - 16) / css(p.h))));
}

// measured on the slots, which keep their width until rebuilt (the viewer may have changed size)
const slotWidth = () => (state.pageEls[0]?.parentElement as HTMLElement | null)?.offsetWidth || ui.viewer.clientWidth / span;
// the last page a screen can start on (two pages: the last but one, so the screen stays full)
const lastTurn = () => Math.max(0, state.pageEls.length - span);
// a page's share of the screen's width: the screen split between its pages, or the slot where
// that is narrower (two pages on a wide screen; any view just after the screen widened, before
// the slots are rebuilt)
const pageShare = () => Math.min(ui.viewer.clientWidth / span, slotWidth());
// the page the screen starts on: the one whose slot holds the middle of the screen's first share
const turnedTo = () => Math.max(0, Math.min(lastTurn(),
    Math.floor((ui.viewer.scrollLeft + pageShare() / 2) / Math.max(1, slotWidth()))));
// the scroll positions that show only the screen starting on page i (one, unless zoomed in)
const slotRange = (i: number) => [i * slotWidth(), i * slotWidth() + Math.max(0, span * slotWidth() - ui.viewer.clientWidth)];
let turning = { to: 0, at: -Infinity }; // the last turn asked for (it glides for a moment)
// The page the screen started on while the pages still fitted the screen they were built for.
// When the screen changes size the browser may move the view at once, before the pages are built
// again (a short score's row is hardly wider than a screen turned on its side: the view was pushed
// back to the start), so where it "is" then says nothing, and the page to keep is this one.
let builtFor = "";
let lastTurned = 0;
const viewerSize = () => `${ui.viewer.clientWidth}x${ui.viewer.clientHeight}`;
ui.viewer.addEventListener("scroll", () => {
    if (pageTurn() && viewerSize() === builtFor) {
        lastTurned = turnedTo();
    }
}, { passive: true });
function turnTo(i: number, smooth = true) {
    i = Math.max(0, Math.min(lastTurn(), i));
    turning = { to: i, at: performance.now() };
    if (!smooth) {
        lastTurned = i; // (no scroll is reported when the view is already there)
    }
    ui.viewer.scrollTo({ left: i * slotWidth(), top: 0, behavior: smooth ? "smooth" : "instant" });
}
// How far one swipe or key goes: a page; in Two pages with Settings' "a swipe turns both", two
const turnStep = () => (span > 1 && settings.pairSwipeTwo ? 2 : 1);
// The page the screen starts on after a turn forward (1) or back (-1) from page `from`. Turning
// both pages keeps to 1-2, 3-4, 5-6…: back from an odd end (4-5 of 5) or a place the music led goes
// to the pair before, not two back.
function turnFrom(from: number, dir: number) {
    const by = turnStep();
    return dir > 0 ? from + by : Math.ceil(from / by) * by - by;
}
// "Page 3 of 9", or "Pages 3-4 of 9" with two on the screen
const turnLabel = () => {
    const i = turnedTo();
    return span > 1 ? `Pages ${i + 1}-${i + span} of ${state.pageEls.length}` : `Page ${i + 1} of ${state.pageEls.length}`;
};
// After a swipe or a two-finger scroll that started on page `from`: past the page's edge by a fifth
// of a page's share of the screen, or a quick flick, turns one step that way; otherwise back.
function settleTurn(from: number, quick: boolean) {
    const [lo, hi] = slotRange(from);
    const sl = ui.viewer.scrollLeft;
    const over = (sl < lo ? sl - lo : sl > hi ? sl - hi : 0) / pageShare();
    const step = Math.abs(over) > 0.2 || (quick && Math.abs(over) > 0.05) ? Math.sign(over) : 0;
    if (step && from + step >= 0 && from + step <= lastTurn()) {
        turnTo(turnFrom(from, step));
    } else if (sl < lo || sl > hi) {
        ui.viewer.scrollTo({ left: Math.min(hi, Math.max(lo, sl)), behavior: "smooth" });
    }
}
// keeps the view on the page under it (after a zoom or a drag of the handle)
function keepOnPage(i = turnedTo()) {
    const [lo, hi] = slotRange(i);
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

// The page the reader is on: the first one showing whole (several small or wide pages can fit on a
// screen, and at the top of the score that is page 1, not the one at the middle); with none whole
// (zoomed in), the one at the middle
function pageInView() {
    const v = ui.viewer.getBoundingClientRect();
    const whole = state.pageEls.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left >= v.left - 0.5 && r.right <= v.right + 0.5 && r.top >= v.top - 0.5 && r.bottom <= v.bottom + 0.5;
    });
    return whole >= 0 ? whole : pageAtMiddle();
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
    span = perScreen();
    builtFor = viewerSize();
    keepSideways(ui.viewMode.value === "page_pair");
    const horizontal = turn || ui.viewMode.value === "continuous_v";
    ui.pages.style.flexDirection = horizontal ? "row" : "column";
    ui.pages.classList.toggle("turn", turn);
    ui.viewer.classList.toggle("turn", turn);
    document.body.classList.toggle("page-turn", turn);
    // one screen per page, bigger when zoomed in past it (all slots alike: the largest page)
    const css = (u: number) => unitsToCss(u) + 16;
    // (two pages: a page's width and the gap, whole px so that the slots' positions add up; the row's
    // ends are padded to bring the first and the last two to the middle of a wider screen)
    const slotW = span > 1
        ? Math.ceil(Math.max(...score.pages.map((p) => unitsToCss(p.w)))) + PAIR_GAP
        : Math.max(Math.ceil(ui.viewer.clientWidth / span), ...score.pages.map((p) => turn ? css(p.w) : 0));
    const spare = turn && span > 1 ? Math.max(0, ui.viewer.clientWidth - span * slotW) : 0;
    ui.pages.style.paddingLeft = spare ? Math.floor(spare / 2) + "px" : "";
    ui.pages.style.paddingRight = spare ? Math.ceil(spare / 2) + "px" : "";
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
            if (state.playing) {
                logWatch.drawMs += performance.now() - t1;
            }
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
// The score point under the screen point, in the engine's units, with a fingertip's reach
function scoreTap(clientX: number, clientY: number, pageEl: HTMLElement) {
    const r = pageEl.getBoundingClientRect();
    const toUnits = (css: number) => css / (CSS_PX_PER_INCH * state.zoom) * UNITS_PER_INCH;
    // a fingertip is wider than a notehead: accept notes within ~18 px, but
    // not so far that a neighbouring staff's note is picked
    const sp = state.score!.spatium;
    const radius = Math.max(0.75 * sp, Math.min(toUnits(18), 3 * sp));
    return { page: Number(pageEl.dataset.index), x: toUnits(clientX - r.left), y: toUnits(clientY - r.top), radius };
}
// Edit: holding a finger still on the score selects from the selection to there (desktop's Shift+click)
const HOLD_MS = 450;
{
    let down: { x: number; y: number; t: number; id: number } | null = null;
    let holdTimer = 0;
    let held = false;
    const cancelHold = () => clearTimeout(holdTimer);
    ui.pages.addEventListener("pointerdown", (e) => {
        down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
        held = false;
        cancelHold();
        const pageEl = (e.target as HTMLElement).closest(".page") as HTMLElement | null;
        if (down && edit.on && edit.sel && pageEl && state.score && !notes.active) {
            const at = down;
            holdTimer = window.setTimeout(() => {
                if (down !== at) {
                    return;
                }
                held = true;
                navigator.vibrate?.(15);
                void editExtendAt(scoreTap(at.x, at.y, pageEl));
            }, HOLD_MS);
        }
    });
    ui.pages.addEventListener("pointermove", (e) => {
        if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) {
            cancelHold(); // a scroll, not a hold
        }
    });
    ui.pages.addEventListener("pointercancel", () => {
        down = null;
        cancelHold();
    });
    ui.pages.addEventListener("pointerup", async (e) => {
        const d = down;
        down = null;
        cancelHold();
        if (held) {
            held = false;
            return; // the hold made a range already
        }
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
        const tap = scoreTap(e.clientX, e.clientY, pageEl);
        if (state.focus && !nearMusic(pageEl, tap, e.clientX, e.clientY)) {
            exitFocus(); // blank paper; a tap on the music plays as usual
            return;
        }
        if (armedMarker) {
            void placeMarker(tap);
            return;
        }
        if (edit.on) {
            void (e.shiftKey && edit.sel ? editExtendAt(tap) : editSelectAt(tap));
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
            return pageTurn() ? turnLabel() : `Page ${pageAtMiddle() + 1} of ${state.pageEls.length}`;
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
        if (performance.now() - turning.at < 600) {
            return; // a turn is still gliding: where the screen "starts" means nothing until it lands
        }
        const i = Number(pageEl.dataset.index);
        const first = turnedTo();
        if (i < first || i >= first + span) {
            turnTo(i); // the music reached a page not on the screen (two pages: it becomes the left one)
            return;
        }
    }
    const on = turnedTo(); // before moving: the nudge below must not carry the view to the next page
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
        keepOnPage(on); // zoomed in: within the page (or the two pages)
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
let leavePause: Promise<void> = Promise.resolve();
document.addEventListener("visibilitychange", () => {
    lastFrame = 0; // no frames while away: not a slow frame
    void updateWakeLock();
    if (state.playing) {
        engine.note(document.visibilityState === "hidden" ? "left" : "back", `audio ${engine.audioRunning ? "running" : "stopped"}, keep playing ${settings.keepPlaying ? "on" : "off"}`);
    }
    if (document.visibilityState === "hidden") {
        if (state.playing && !settings.keepPlaying) {
            pausedOnLeaving = true;
            engine.fadeOut(); // silent at once, whatever the pause still lets through (issue #29)
            leavePause = engine.pause().catch(() => {});
        }
    } else if (pausedOnLeaving) {
        pausedOnLeaving = false;
        void leavePause.then(() => engine.restoreVolume());
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
        setStatus("The sound stuttered, so PocketScore now prepares more of it ahead to keep it smooth.", "info", 10000);
    }
});

// ---------------------------------------------------------------- playback log

// What happened while music played, kept on this device (issue #31: stutters seen while travelling,
// away from USB): the self-check's notes, what went on around them (jumps, focus, page drawing,
// updates, leaving the app) and every 10 s how the device kept up. The reader sends it from Settings
// See playlog.ts.
const playLog = new PlayLog(!embedded);
engine.on("health", (h) => playLog.add(h.kind, h.detail));
const logWatch = {
    playing: false, since: 0, gaps: 0, lastSample: 0,
    frames: 0, slowFrames: 0, longestFrame: 0, drawMs: 0, // since the last sample (page in view only)
    clockWall: 0, clockAudio: 0, outLatency: -1,
};
let battery: { level: number; charging: boolean } | null = null;
(navigator as any).getBattery?.().then((b: any) => (battery = b)).catch(() => {});
const installed = () => matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
const ms = (secs: number) => `${Math.round(secs * 1000)} ms`;
const pad2 = (n: number) => String(n).padStart(2, "0");

function batteryText() {
    return battery ? `battery ${Math.round(battery.level * 100)}%${battery.charging ? " charging" : ""}` : "battery unknown";
}

function playContext() {
    return `"${state.score?.title || "?"}" at ${fmt(state.position)}, ${ui.viewMode.value} view, zoom ${Math.round(state.zoom * 100)}%, speed ${Math.round(practice.speed * 100)}%, focus ${state.focus ? "on" : "off"}`;
}

engine.on("status", (s) => {
    const now = s.status === "playing";
    if (now === logWatch.playing) {
        return;
    }
    logWatch.playing = now;
    if (now) {
        Object.assign(logWatch, { since: performance.now(), gaps: engine.underruns, lastSample: performance.now(), frames: 0, slowFrames: 0, longestFrame: 0, drawMs: 0, clockWall: 0 });
        const a = engine.audioInfo;
        playLog.add("play", playContext() + (a ? `; audio ${a.sampleRate} Hz, latency ${ms(a.baseLatency)} + output ${ms(a.outputLatency)}, queue ${ms(engine.stats.targetSecs)}` : "") + `; ${batteryText()}, page ${document.visibilityState}`);
    } else {
        playLog.add("stop", `${playContext()}; played ${Math.round((performance.now() - logWatch.since) / 1000)} s, sound gaps ${engine.underruns - logWatch.gaps}`);
        playLog.save();
    }
});
engine.on("seeked", (e) => {
    if (logWatch.playing) {
        playLog.add("jump", `to ${fmt(e.secs)}`);
    }
});
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        playLog.save(); // the app may be closed from here
    }
});

// Every second while playing: has the audio clock kept up with real time? It falls behind when the
// device's own sound output does, a stutter PocketScore's queue doesn't see. Every 10 s: a sample.
setInterval(() => {
    if (!logWatch.playing) {
        return;
    }
    const now = performance.now();
    const a = engine.audioInfo;
    if (a && a.state === "running") {
        if (!logWatch.clockWall) {
            logWatch.clockWall = now;
            logWatch.clockAudio = a.time;
        } else if (now - logWatch.clockWall >= 2000) {
            // over 2 s or more, so Android's ~100 ms steps of the audio clock don't count
            const wall = (now - logWatch.clockWall) / 1000;
            const behind = wall - (a.time - logWatch.clockAudio);
            if (behind > 0.25) {
                playLog.add("audio clock slipped", `${ms(behind)} behind over ${wall.toFixed(1)} s (the device's sound output fell behind), page ${document.visibilityState}`);
            }
            logWatch.clockWall = now;
            logWatch.clockAudio = a.time;
        }
        // headphones or a speaker connected or taken away (Bluetooth adds 100+ ms)
        if (logWatch.outLatency >= 0 && Math.abs(a.outputLatency - logWatch.outLatency) > 0.1) {
            playLog.add("sound output", `output latency now ${ms(a.outputLatency)} (was ${ms(logWatch.outLatency)})`);
        }
        logWatch.outLatency = a.outputLatency;
    } else {
        logWatch.clockWall = 0;
    }
    if (now - logWatch.lastSample >= 10000) {
        const st = engine.stats;
        const load = st.load !== null ? `${Math.round(st.load * 100)}%` : st.loadUnder !== null ? `under ${Math.round(st.loadUnder * 100)}%` : "?";
        const frames = document.visibilityState === "visible"
            ? `frames ${logWatch.frames}, longest ${Math.round(logWatch.longestFrame)} ms, ${logWatch.slowFrames} over 50 ms, page drawing ${Math.round(logWatch.drawMs)} ms`
            : "page hidden";
        playLog.add("sample", `at ${fmt(state.position)}: engine load ${load}, slowest block ${st.slowestMs.toFixed(0)} ms, queued ${ms(st.queuedSecs)} of ${ms(st.targetSecs)}, level ${engine.level.toFixed(2)}; ${frames}; ${batteryText()}`);
        Object.assign(logWatch, { lastSample: now, frames: 0, slowFrames: 0, longestFrame: 0, drawMs: 0 });
    }
}, 1000);

function reportHeader(): string[] {
    const n = navigator as any;
    const a = engine.audioInfo;
    const tz = -new Date().getTimezoneOffset();
    const conn = n.connection;
    return [
        "PocketScore playback report",
        `Version ${__APP_VERSION__}, made ${stamp(Date.now())} (times are local, UTC${tz >= 0 ? "+" : "-"}${Math.floor(Math.abs(tz) / 60)}${tz % 60 ? ":" + pad2(Math.abs(tz) % 60) : ""})`,
        `Device: ${navigator.userAgent}`,
        `Running as ${installed() ? "the installed app" : "a browser tab"}; ${n.hardwareConcurrency || "?"} cores, ${n.deviceMemory || "?"} GB memory, screen ${screen.width}x${screen.height} at ${+devicePixelRatio.toFixed(2)}x`,
        a ? `Audio: ${a.sampleRate} Hz, ${a.state}, latency ${ms(a.baseLatency)} + output ${ms(a.outputLatency)}, queue ${ms(engine.stats.targetSecs)}, sound gaps this session ${engine.underruns}` : "Audio: not started this session",
        `Now: ${batteryText()}${conn ? `, network ${conn.effectiveType || "?"}${conn.saveData ? " (data saver on)" : ""}` : ""}`,
        `Settings: keep playing ${settings.keepPlaying ? "on" : "off"}, focus by itself ${settings.autoFocus ? `after ${settings.focusPlayingSecs} s` : "off"}, follow ${settings.follow ? "on" : "off"}, keep the screen on ${settings.keepAwake ? "on" : "off"}`,
        "Web apps can't see battery saver or the phone's heat: please say if either was on.",
    ];
}

// Shared through the phone's own share sheet (GitHub, a message, email) and copied, to paste anywhere
async function sendReport(from: string) {
    playLog.add("report", `sent from ${from}`);
    const text = playLog.report(reportHeader());
    playLog.save();
    let copied = false;
    try {
        await navigator.clipboard.writeText(text);
        copied = true;
    } catch {
        // not allowed here: the share sheet may still work
    }
    if (navigator.share) {
        try {
            await navigator.share({ title: "PocketScore playback report", text });
            return;
        } catch (err) {
            if ((err as Error).name !== "AbortError" && !copied) {
                setStatus("The report couldn't be shared or copied on this device.", "error", 6000);
                return;
            }
        }
    }
    setStatus(copied ? "The playback report is copied. Paste it into a GitHub issue or a message." : "The report couldn't be copied on this device.", copied ? "info" : "error", 6000);
}

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
    if (state.playing && lastFrame && document.visibilityState === "visible") {
        logWatch.frames++;
        logWatch.longestFrame = Math.max(logWatch.longestFrame, now - lastFrame);
        if (now - lastFrame > 50) {
            logWatch.slowFrames++;
        }
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
    updateKeepAlive();
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

// Keep playing on Android (issue #28): Web Audio alone doesn't count as media playback there, so
// about 2 minutes after the app was left Android froze all of Chrome's processes and the sound
// stopped (measured on the Pixel 9a, 17 Oct 2026). A silent <audio> element playing alongside makes
// Chrome show its media notification, whose service keeps Chrome running; the notification's
// play/pause work too. Only with Keep playing on: otherwise leaving the app pauses anyway.
const ANDROID = /Android/i.test(navigator.userAgent);
let keepAlive: HTMLAudioElement | null = null;
function silentWav(secs: number): string {
    const rate = 8000; // 8-bit mono: silence is the value 128
    const n = rate * secs;
    const b = new Uint8Array(44 + n).fill(128);
    const v = new DataView(b.buffer);
    const str = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVEfmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    str(36, "data"); v.setUint32(40, n, true);
    return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}
function updateKeepAlive() {
    const want = ANDROID && settings.keepPlaying && state.playing;
    if (want) {
        if (!keepAlive) {
            keepAlive = new Audio(silentWav(10)); // over 5 s, or Chrome takes it for a short sound
            keepAlive.loop = true;
        }
        if ("mediaSession" in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({ title: ui.title.textContent || "PocketScore", artist: "PocketScore" });
            for (const action of ["play", "pause"] as const) {
                navigator.mediaSession.setActionHandler(action, () => {
                    engine.note("keep playing", `the notification's ${action} (playing ${state.playing}, audio ${engine.audioRunning})`);
                    ui.play.click();
                });
            }
        }
        // allowed without a tap here: the reader has already tapped in the page
        keepAlive.play().catch((err) => engine.note("keep playing", `the silent audio didn't start: ${err}`));
        if ("mediaSession" in navigator) {
            navigator.mediaSession.playbackState = "playing";
        }
    } else if (keepAlive && !keepAlive.paused) {
        keepAlive.pause();
        if ("mediaSession" in navigator) {
            navigator.mediaSession.playbackState = "paused";
        }
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
        // The sound was stopped (not yet tapped, or the device or Chrome stopped it): wait until it
        // runs again, then take the message away; it stayed on screen for good before (17 Oct 2026)
        const running = await Promise.race([
            engine.whenRunning().then(() => true, () => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
        ]);
        if (!running) {
            setStatus("The sound couldn't start. Tap Play again.", "info", 6000);
            return;
        }
        if (ui.status.textContent === "Starting audio…") {
            setStatus("");
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

// popstates of our own history.back(), which close nothing: their panel closed already
let ownBacks = 0;
// entries for panels opened while such a back was on its way, added once it has landed
let laterPushes = 0;

function openLayer(close: () => void) {
    layers.push(close);
    if (ownBacks > 0) {
        laterPushes++;
    } else {
        history.pushState({ pocketscoreLayer: layers.length }, "");
    }
}

/** Close a panel from the app's own controls: at once, with history following. Leaving the closing to
 *  the late popstate let a second close in the meantime (the palette's tap-away, then Notes giving way to
 *  Edit) go back twice, and the second popstate closed the panel just opened. */
function closeLayer(close: () => void) {
    const i = layers.lastIndexOf(close);
    if (i === layers.length - 1 && i >= 0) {
        layers.pop();
        ownBacks++;
        history.back();
    } else if (i >= 0) {
        layers.splice(i, 1);
    }
    close();
}

/** One mode in place of another (Notes and Edit): the new one takes the old one's Back entry. */
function swapLayer(from: () => void, to: () => void) {
    const i = layers.lastIndexOf(from);
    if (i < 0) {
        openLayer(to);
    } else {
        layers[i] = to;
    }
}

window.addEventListener("popstate", () => {
    if (ownBacks > 0) {
        ownBacks--;
        for (; ownBacks === 0 && laterPushes > 0; laterPushes--) {
            history.pushState({ pocketscoreLayer: layers.length - laterPushes + 1 }, "");
        }
        return;
    }
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
        // back in history, whose popstate comes later: wait for it before focus adds its own entry.
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
    if (state.playing) {
        playLog.add("focus", `on (${fullscreen ? "the button" : "by itself"})`);
    }
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
    showFocusHint();
}

// The line at the top of the screen in Focus: how to get the controls back, or something more
// particular (which the usual line doesn't replace while it shows)
const FOCUS_HINT = "Tap off the music to show the controls";
let focusHintUntil = 0;
function showFocusHint(text = FOCUS_HINT, ms = 2600) {
    if (text === FOCUS_HINT && performance.now() < focusHintUntil) {
        return;
    }
    focusHintUntil = text === FOCUS_HINT ? 0 : performance.now() + ms;
    clearTimeout(focusHintTimer);
    focusHint.textContent = text;
    focusHint.classList.remove("fading");
    focusHint.hidden = false;
    focusHintTimer = window.setTimeout(() => {
        focusHint.classList.add("fading");
        focusHintTimer = window.setTimeout(() => (focusHint.hidden = true), 450);
    }, ms);
}

function leaveFocus() {
    barAnimations.forEach((a) => a.cancel());
    barAnimations = [];
    const before = ui.viewer.getBoundingClientRect().top;
    const wasFocused = document.documentElement.classList.contains("focus");
    state.focus = false;
    if (state.playing) {
        playLog.add("focus", "off");
    }
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
    focusHintUntil = 0;
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
numberField(ui.bar, goToTypedBar);
ui.bar.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        ui.bar.blur();
    }
});
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
async function applyTypedTempo() {
    const want = Number(ui.tempoInput.value);
    const base = baseTempoAt(state.position);
    if (!(want > 0) || !base) {
        showTempo();
        return;
    }
    const m = Math.min(3, Math.max(0.1, want / base));
    showPractice(await engine.setSpeed(m, state.position));
    showTempo(); // shows the clamped tempo if the typed one was out of range
}
numberField(ui.tempoInput, () => void applyTypedTempo(), (by) => {
    ui.tempoInput.value = String(Math.max(1, (Number(ui.tempoInput.value) || 0) + by));
    void applyTypedTempo();
});
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
    if (matchMedia("(max-width: 600px)").matches) {
        ui.settings.style.top = ui.settings.style.maxHeight = ""; // phones: the whole screen
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
$("settings-back").onclick = () => closeLayer(closeSettings);

// What this device can't do is shown switched off, saying so (not hidden, not a switch that does nothing)
const rootEl = document.documentElement as any;
const unavailable: Partial<Record<keyof Settings, boolean>> = {
    focusFullscreen: !(rootEl.requestFullscreen || rootEl.webkitRequestFullscreen), // iPhone
    keepAwake: !canWakeLock,
};
$("send-report").onclick = () => void sendReport("Settings");
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
        } else if (k === "keepPlaying") {
            updateKeepAlive();
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
// about unsaved changes first. False when the reader cancelled.
async function openChosen(name: string, data: ArrayBuffer): Promise<boolean> {
    if (!isScoreName(name)) {
        notAScore(name); // before any question: a wrong file must cost nothing (bug hunt, finding 10)
        return false;
    }
    if (state.playing) {
        await engine.stop();
    }
    // What "Don't keep" and "Don't save" throw away goes only once the new score has opened: until
    // then the open score and its drafts are as they were (a file that can't be read, a cancelled question)
    const oldKey = state.scoreKey;
    let dropEdits = false;
    let dropChanges = false;
    if (edit.dirty) {
        // desktop's question on closing (ProjectActionsController::askAboutSavingScore), with this app's
        // Save a copy; asked for a new score even when untouched, as desktop counts it unsaved from the start
        const choice = await ask(`Save a copy of “${ui.title.textContent}” before closing it?`,
            "Your changes will be lost if you don't save a copy.",
            [["cancel", "Cancel"], ["discard", "Don't keep"], ["copy", "Save a copy"]]);
        if (choice === "cancel" || (choice === "copy" && !(await saveCopy()))) {
            return false;
        }
        dropEdits = choice === "discard";
    }
    if (hasUnsaved()) {
        const choice = await ask("Save your changes?",
            `Your notes or mixer changes for “${ui.title.textContent}” are not saved. Save them before opening another score?`,
            [["cancel", "Cancel"], ["discard", "Don't save"], ["save", "Save"]]);
        if (choice === "cancel" || (choice === "save" && !saveAll())) {
            return false;
        }
        dropChanges = choice === "discard";
    }
    return openScore(name, data, async () => {
        if (dropEdits) {
            clearTimeout(edit.draftTimer);
            edit.dirty = false; // a draft being written right now must not come back after the removal
            await editDraft.remove(oldKey);
        }
        if (dropChanges) {
            discardAll();
        }
    });
}

const isScoreName = (name: string) => /\.(mscz|mscx)$/i.test(name);
function notAScore(name: string) {
    setStatus(`"${name}" is not a MuseScore file. Choose a .mscz file.`, "error");
}

// The start screen again, saying why: the engine lets go of the open score before it tries a new
// file (Session::load), so when that file can't be read there is no score any more. The pages of
// the old one stayed on screen before, with Play, the mixer and editing dead (bug hunt, finding 9).
// Unsaved notes, mixer changes and edits of the old score keep their drafts and come back with it.
function backToStart(message: string) {
    while (layers.length) {
        closeLayer(layers[layers.length - 1]);
    }
    setNotesActive(false);
    resetEdit();
    clearTimeout(draftTimer);
    Object.assign(mix, { store: null, score: null, saved: null, dirty: false, pendingSounds: {} });
    Object.assign(state, { score: null, tracks: [], scoreKey: "", duration: 0, position: 0, playbackReady: false });
    openedScore = null;
    lastCursor = null;
    lastPosition = null;
    timeline = [];
    barStarts = [];
    renderGeneration++;
    state.pageOps.clear();
    clearPages();
    cursorEl?.remove();
    keepSideways(false);
    notes.open("", "page");
    ui.viewMode.value = "page";
    shownView = "page";
    for (const el of [ui.viewMode, ui.play, ui.speedOpen, ui.loopOpen, ui.rewind, ui.seek, ui.notesToggle, ui.editToggle, ui.mixerToggle]) {
        el.disabled = true;
    }
    ui.goto.hidden = true;
    ui.section.hidden = true;
    ui.title.textContent = "PocketScore";
    ui.time.textContent = "0:00";
    ui.duration.textContent = fmt(0);
    ui.seek.value = "0";
    ui.empty.hidden = false;
    $("open-label").classList.add("primary");
    updateSaveState();
    void showResume();
    setStatus(message, "error");
}

/** Resolves true once the score is open; `onOpened` runs then, while the old score's stores are still in place. */
async function openScore(name: string, data: ArrayBuffer, onOpened?: () => void | Promise<void>): Promise<boolean> {
    if (!isScoreName(name)) {
        notAScore(name);
        return false;
    }
    // Nothing of the open score is touched until the new one has loaded (bug hunt, findings 9 and 11).
    const key = await scoreKey(name, data); // before the data goes to the engine
    // edits from last time that were never saved as a copy: continue them or start again
    let toLoad = data;
    let restoredEdits = false;
    const draft = embedded || !composer ? null : await editDraft.get(key);
    if (draft) {
        const choice = await ask("Continue your edits?",
            `You changed the notes of “${name}” and did not save a copy. Continue from there, or start again from the file as it is?`,
            [["start", "Start again"], ["continue", "Continue my edits"]]);
        if (choice === "cancel") {
            return false; // Back or Escape: the edits stay kept, and the score that is open stays open
        }
        if (choice === "continue") {
            toLoad = draft.data;
            restoredEdits = true;
        } else {
            await editDraft.remove(key);
        }
    }
    setStatus(`Opening ${name}…`);
    if (!ui.sounds.hidden) {
        closeLayer(closeSounds); // it lists the previous score's parts
    }
    // a Play or a tapped note that was waiting for the last score's sounds is not for this one
    pendingPlay = false;
    pendingPreview = null;
    state.playbackReady = false;
    stutterTold = false;
    // the sounds may report ready at any point from here on: they wait for the restore below
    let mixRestoreDone: (restored: boolean) => void = () => {};
    mixLoading = new Promise((resolve) => (mixRestoreDone = resolve));
    const copy = data.slice(0); // to reopen after restarting into an update (the engine takes `data`)
    const res = await engine.load(name, toLoad);
    if (!res.ok || !res.score) {
        mixRestoreDone(false);
        backToStart(res.error || "Could not open this score.");
        return false;
    }
    await onOpened?.();
    clearTimeout(draftTimer);
    Object.assign(mix, { store: null, score: null, saved: null, dirty: false, pendingSounds: {} });
    state.pageOps.clear();
    ui.mixerToggle.disabled = true;
    state.scoreKey = key;
    openedScore = { name, data: copy };
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
    resetEdit();
    if (restoredEdits) {
        edit.dirty = true; // not saved as a copy yet
        updateEditBar();
        setStatus("Your edits are back. Save a copy to keep them.", "info", 6000);
    }
    notes.open(key, "page");
    ui.notesToggle.disabled = false;
    ui.editToggle.disabled = false;
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
    return true;
}

ui.viewMode.onchange = () => changeView();
async function changeView() {
    const was = shownView;
    const view = ui.viewMode.value;
    shownView = view;
    // page by page and page view share a layout: stay on the same page
    const keepPage = was === "page" || turnView(was) ? (turnView(was) ? turnedTo() : pageInView()) : 0;
    let focusing: Promise<void> | null = null;
    if (view === "page_pair") {
        // two pages want the whole screen: Focus starts with the view (now, while the reader's
        // choice still allows full screen); a tap off the music brings the controls back
        focusing = enterFocus();
    }
    setStatus("Laying out…");
    state.score = await engine.setViewMode(engineMode(view));
    notes.setMode(engineMode(view)); // notes belong to the layout they were written on
    await loadTimeline();
    // before fitting: the message above the score takes height, and when it goes within the same
    // frame nothing reports the screen growing back (the page stayed fitted to the shorter screen)
    setStatus("");
    await focusing; // the bars have gone: fitted once, to the screen as it will be
    if (turnView(view)) {
        if (!turnView(was)) {
            zoomBeforeTurn = state.zoom;
        }
        state.zoom = fitPageZoom();
        turnFitted = true;
    } else if (turnView(was)) {
        state.zoom = zoomBeforeTurn;
    }
    rerenderAll(false);
    if (turnView(view)) {
        turnTo(keepPage, false);
    } else if (turnView(was) && view === "page") {
        state.pageEls[keepPage]?.scrollIntoView({ block: "start" });
    }
    if (view === "page_pair" && was !== view) {
        // two pages want a screen on its side; where the device won't be turned for us, say so
        const turned = await sideways;
        if (!turned && ui.viewMode.value === "page_pair" && ui.viewer.clientWidth < ui.viewer.clientHeight) {
            const turn = "Turn your device on its side to read two pages.";
            if (state.focus) {
                showFocusHint(`${turn} ${FOCUS_HINT}.`, 6000); // the status line is hidden in Focus
            } else {
                setStatus(turn, "info", 6000);
            }
        }
    }
}

// Two pages: the screen is kept on its side while the view shows, where the device allows it
// (Android: the installed app, or full screen such as the Focus button's; iPhone and iPad have no
// way to ask, so there the reader turns it). Given back when another view or score takes over.
let sidewaysHeld = false;
let sideways: Promise<boolean> = Promise.resolve(false); // the last request: did the device agree
function keepSideways(on: boolean) {
    const o = screen.orientation as any;
    if (on && !sidewaysHeld) {
        sideways = !o?.lock ? Promise.resolve(false) : Promise.resolve()
            .then(() => o.lock("landscape"))
            .then(() => {
                if (ui.viewMode.value !== "page_pair") {
                    o.unlock(); // the reader chose another view meanwhile
                    return false;
                }
                return (sidewaysHeld = true);
            }, () => false);
    } else if (!on && sidewaysHeld) {
        sidewaysHeld = false;
        try {
            o?.unlock?.();
        } catch { /* nothing held */ }
    }
}
// full screen makes it possible in a browser tab, and leaving full screen lets the screen go
for (const type of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(type, () => {
        sidewaysHeld = false;
        keepSideways(ui.viewMode.value === "page_pair" && !!state.score);
    });
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
            // the page the reader was on before the screen changed (see lastTurned); if the pages
            // were built for this size meanwhile, where the view is now
            const page = viewerSize() === builtFor ? turnedTo() : lastTurned;
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
            const vw = pageShare() * turnStep();
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
    // (not under a panel; Focus is a layer too, and there the keys turn as ever)
    if (!pageTurn() || !state.score || layers.some((l) => l !== leaveFocus) || t.closest("input, select, textarea, [contenteditable]")) {
        return;
    }
    const step = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[e.key];
    if (step) {
        e.preventDefault();
        // a key pressed again while the page still glides counts from the page it is going to
        turnTo(turnFrom(performance.now() - turning.at < 500 ? turning.to : turnedTo(), step));
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
    let updateLogged = false;
    sw.addEventListener("message", (e) => {
        if (e.data?.type === "sw-progress" && !updateLogged) {
            updateLogged = true; // installing reads every stored file back: heavy work alongside the music
            playLog.add("update", `downloading and installing a new version${state.playing ? " while playing" : ""}`);
        }
        if (isUpdate && e.data?.type === "sw-progress" && !state.playing) {
            setStatus(`Downloading an update to PocketScore… ${Math.round(e.data.done / e.data.total * 100)}%`);
        }
    });
    sw.addEventListener("controllerchange", () => {
        if (!isUpdate) {
            return; // first visit, not an update
        }
        updateReady = true;
        playLog.add("update", "installed");
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
    if (!(await openScore(keep.name, keep.data))) {
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
// Notes and Edit are never on together: each one's button switches the other off
ui.notesToggle.onclick = () => {
    if (notes.active) {
        closeLayer(closeNotes);
        return;
    }
    if (edit.on) {
        swapLayer(closeEdit, closeNotes);
        setEditActive(false);
    } else {
        openLayer(closeNotes);
    }
    setNotesActive(true);
};
ui.notesDone.onclick = () => closeLayer(closeNotes);

// ---------------------------------------------------------------- edit mode (composer)

// Edit changes the notes of the score itself, in the engine (one undo step per change), and the page
// draws it again. The reader keeps the result with Save a copy: a .mscz of its own, never over the
// file that was opened. Notes written on the score (Notes) are pinned to the old layout and may
// no longer line up after an edit.
const edit = {
    on: false,
    sel: null as EditSelection | null,
    busy: false,
    dirty: false,
    octave: false,
    undo: 0, // edits that can be undone
    redo: 0,
    selEls: [] as HTMLDivElement[], // the outline: one box, or one per system for a range
    clip: false, // something was copied (the engine keeps it, across scores, as desktop's clipboard)
    draftTimer: 0,
    fresh: false, // made with New score: no file behind it
    // note input, as desktop's: the length the next note or rest gets (a quarter to start), and whether the
    // selection is the place after the one just entered (then the letters stay, even over an existing note)
    len: { den: 4, dots: 0 },
    step: false,
};

const LENGTHS: [number, string][] = [[1, "Whole"], [2, "Half"], [4, "Quarter"], [8, "Eighth"], [16, "16th"], [32, "32nd"]];

// A note drawn small: hollow head and no stem for a whole note, a stem, flags for eighths and shorter
function lengthIcon(den: number): string {
    const hollow = den <= 2;
    const head = `<ellipse cx="${den === 1 ? 12 : 9}" cy="17" rx="${den === 1 ? 5 : 4.2}" ry="3.2" transform="rotate(-20 ${den === 1 ? 12 : 9} 17)" ${hollow ? 'fill="none" stroke="currentColor" stroke-width="1.8"' : 'fill="currentColor"'}/>`;
    if (den === 1) {
        return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${head}</svg>`;
    }
    const flags = den >= 8 ? Math.round(Math.log2(den / 8)) + 1 : 0;
    let flag = "";
    for (let i = 0; i < flags; i++) {
        flag += `<path d="M13 ${4 + i * 3.6}c0 3 5.5 4 5 8.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
    }
    return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${head}<path d="M12.9 16.4V4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>${flag}</svg>`;
}

for (const [den, name] of LENGTHS) {
    const b = document.createElement("button");
    b.className = "len";
    b.dataset.den = String(den);
    b.disabled = true;
    b.setAttribute("aria-label", name + " note");
    b.title = name;
    b.innerHTML = lengthIcon(den);
    b.onclick = () => {
        if (entering()) { // the length of the notes about to go in, as in desktop's note input
            edit.len = { den, dots: 0 };
            updateEditBar();
        } else {
            edit.len = { den, dots: edit.sel?.dots ?? 0 };
            void runEdit(() => engine.editDuration(den));
        }
    };
    ui.editLengths.appendChild(b);
}
const dotButton = document.createElement("button");
dotButton.className = "len dot";
dotButton.id = "edit-dot";
dotButton.disabled = true;
dotButton.setAttribute("aria-label", "Dotted");
dotButton.title = "Dotted: half as long again";
dotButton.textContent = "•";
dotButton.onclick = () => {
    if (entering()) {
        edit.len = { ...edit.len, dots: edit.len.dots ? 0 : 1 };
        updateEditBar();
    } else {
        void runEdit(() => engine.editDot());
    }
};
ui.editLengths.appendChild(dotButton);

// Paste: at the end of the length row once something was copied (that row has room on a phone)
const pasteButton = document.createElement("button");
pasteButton.className = "len paste";
pasteButton.id = "edit-paste";
pasteButton.hidden = true;
pasteButton.title = "Paste what you copied here (it replaces what is there)";
pasteButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 4V3h6v1M9 11h6M9 15h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Paste</span>';
pasteButton.onclick = () => void runEdit(() => engine.editPaste());
ui.editLengths.appendChild(pasteButton);

// Voice 1-4 (More): entering, the next notes go into that voice here; otherwise the selected notes move to it
for (let v = 1; v <= 4; v++) {
    const b = document.createElement("button");
    b.className = "btn small voice";
    b.dataset.voice = String(v);
    b.textContent = String(v);
    b.disabled = true;
    b.setAttribute("aria-label", `Voice ${v}`);
    b.title = v === 1 ? "Voice 1: the main tune of the line" : `Voice ${v}: another tune on the same line`;
    b.onclick = async () => {
        const input = entering();
        const len = edit.len;
        if (await runEdit(() => engine.editVoice(v, input)) && input) {
            edit.step = true; // carry on entering, now in that voice
            edit.len = len;
            updateEditBar();
        }
    };
    $("edit-voices").appendChild(b);
}
$("edit-marks").querySelectorAll<HTMLButtonElement>(".mark").forEach((b) => {
    b.onclick = () => void runEdit(() => engine.editMark(Number(b.dataset.mark)));
});
$("edit-slur").onclick = () => void runEdit(() => engine.editSlur());
$("edit-cresc").onclick = () => void runEdit(() => engine.editHairpin(0));
$("edit-dim").onclick = () => void runEdit(() => engine.editHairpin(1));
$("edit-insertbars").onclick = () => void runEdit(() => engine.editInsertBars(Math.max(1, Math.min(100, Number(em.bars.value) || 1))));
$("edit-deletebars").onclick = async () => {
    const s = edit.sel;
    const what = s?.kind === "range" && s.barEnd !== s.bar ? `bars ${s.bar}–${s.barEnd}` : `bar ${s?.bar}`;
    const choice = await ask(`Delete ${what}?`, "The bar goes from every line, with what is in it. Undo brings it back.",
        [["cancel", "Cancel"], ["delete", "Delete"]]);
    if (choice === "delete") {
        void runEdit(() => engine.editDeleteBars());
    }
};

$("edit-copysel").onclick = async () => {
    const s = edit.sel;
    const r = await engine.editCopy(false);
    if (!r.ok) {
        setStatus(r.error || "That could not be copied.", "error", 4000);
        return;
    }
    edit.clip = true;
    updateEditBar();
    if (s?.kind === "range") {
        const what = s.bar === s.barEnd ? `bar ${s.bar}` : `bars ${s.bar}–${s.barEnd}`;
        setStatus(`Copied ${what}. Tap where it should go, then Paste.`, "info", 5000);
    }
};
$("edit-cut").onclick = async () => {
    if (await runEdit(() => engine.editCopy(true))) {
        edit.clip = true;
        updateEditBar();
    }
};

const lengthName = (den: number, dots: number) =>
    (dots ? "dotted " : "") + (LENGTHS.find(([d]) => d === den)?.[1].toLowerCase() ?? "long");

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
LETTERS.forEach((name, i) => {
    const b = document.createElement("button");
    b.className = "btn small letter";
    b.textContent = name;
    b.setAttribute("aria-label", `Put a ${name} here`);
    b.title = `Put a ${name} here, then go on to the next place`;
    b.onclick = () => void enterStep(() => engine.editEnterNote(i, edit.len.den, edit.len.dots));
    $("edit-letters").appendChild(b);
});
// a rest of the chosen length, as desktop's 0 key: rhythms with rests go in without leaving the letters
const restButton = document.createElement("button");
restButton.className = "btn small letter rest-key";
restButton.id = "edit-rest";
restButton.setAttribute("aria-label", "Put a rest here");
restButton.title = "Put a rest here, then go on to the next place";
restButton.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="20" aria-hidden="true"><path d="M10 3l4.5 5.2-3 3.6 3.6 4.7c-2.4-.9-4.6-.5-4.2 2.5L8.5 21c-2-2.2-1.4-5.2 2.4-4.6L7.6 12.5l3.2-3.7z" fill="currentColor"/></svg>';
restButton.onclick = () => void enterStep(() => engine.editEnterRest(edit.len.den, edit.len.dots));
$("edit-letters").appendChild(restButton);

// Note input shows the letters: on a rest, and on the place after a note just entered
const entering = () => !!edit.sel && (edit.sel.kind === "rest" || edit.step);
async function enterStep(change: () => Promise<EditResult>) {
    if (await runEdit(change)) {
        edit.step = true;
        updateEditBar();
    }
}

// ---- More: the tools a composer needs less often, behind one button
const em = {
    btn: $<HTMLButtonElement>("edit-morebtn"),
    panel: $("edit-more"),
    words: $<HTMLInputElement>("edit-words"),
    line: $<HTMLInputElement>("edit-line"),
    key: $<HTMLSelectElement>("edit-key"),
    time: $<HTMLSelectElement>("edit-time"),
    clef: $<HTMLSelectElement>("edit-clef"),
    bars: $<HTMLInputElement>("edit-bars"),
};
em.btn.onclick = () => {
    em.panel.hidden = !em.panel.hidden;
    em.btn.setAttribute("aria-pressed", String(!em.panel.hidden));
    em.btn.setAttribute("aria-expanded", String(!em.panel.hidden));
};
LETTERS.forEach((name, i) => {
    const b = document.createElement("button");
    b.className = "btn small letter-more";
    b.textContent = name;
    b.setAttribute("aria-label", `Add a ${name} to this chord`);
    b.title = `Add a ${name} above this note, in the same chord`;
    b.onclick = () => void runEdit(() => engine.editAddToChord(i));
    $("edit-chord").appendChild(b);
});
const DYNAMICS = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"];
DYNAMICS.forEach((name, i) => {
    const b = document.createElement("button");
    b.className = "btn small dyn";
    b.textContent = name;
    b.setAttribute("aria-label", `Mark ${name}`);
    b.title = `Put ${name} under this note`;
    b.onclick = () => void runEdit(() => engine.editDynamic(i));
    $("edit-dynamics").appendChild(b);
});
em.key.add(new Option("Key…", ""));
KEYS.forEach(([k, name]) => em.key.add(new Option(name, String(k))));
em.time.add(new Option("Time…", ""));
TIMES.forEach(([n, d]) => em.time.add(new Option(`${n}/${d}`, `${n}/${d}`)));
CLEFS.forEach(([v, label]) => em.clef.add(new Option(label, v)));
em.key.onchange = () => {
    const v = em.key.value;
    em.key.value = "";
    if (v) void runEdit(() => engine.editSetKey(Number(v)));
};
em.time.onchange = () => {
    const v = em.time.value;
    em.time.value = "";
    if (v) {
        const [n, d] = v.split("/").map(Number);
        void runEdit(() => engine.editSetTime(n, d));
    }
};
$("edit-sharp").onclick = () => void runEdit(() => engine.editAccidental(0));
$("edit-flat").onclick = () => void runEdit(() => engine.editAccidental(1));
$("edit-natural").onclick = () => void runEdit(() => engine.editAccidental(2));
$("edit-tie").onclick = () => void runEdit(() => engine.editTie());
$("edit-triplet").onclick = () => void runEdit(() => engine.editTriplet());
$("edit-text").onclick = () => {
    const t = em.words.value.trim();
    if (t) void runEdit(() => engine.editStaffText(t)).then(() => { em.words.value = ""; });
};
// A syllable goes under the note, and the next note is picked so the words can be typed straight on
const putLyric = async () => {
    const t = em.words.value.trim();
    const before = edit.undo;
    if (!t || edit.busy) {
        return;
    }
    await runEdit(() => engine.editLyric(t));
    if (edit.undo > before) {
        em.words.value = "";
        await moveSelection("next-chord");
        em.words.focus();
    }
};
$("edit-lyric").onclick = () => void putLyric();
em.words.onkeydown = (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        void putLyric();
    }
};
$("edit-addbars").onclick = () => {
    const n = Math.max(1, Math.min(100, Math.round(Number(em.bars.value) || 1)));
    void runEdit(() => engine.editAddBars(n));
};
$("edit-rename").onclick = () => {
    const t = em.line.value.trim();
    if (t) void runEdit(() => engine.editRenameLine(t));
};
$("edit-addline").onclick = async () => {
    const lines = state.tracks.filter((t) => !t.metronome).length;
    const name = em.line.value.trim() || `Line ${lines + 1}`;
    const clef = Math.max(0, CLEFS.findIndex(([v]) => v === em.clef.value));
    await runEdit(() => engine.editAddLine(name, clef));
    em.line.value = "";
};
function updateMore(s: EditSelection | null, idle: boolean) {
    const note = s?.kind === "note" && !idle;
    const any = !!s && !idle;
    const set = (ids: string[], on: boolean) => ids.forEach((id) => ($(id) as HTMLButtonElement).disabled = !on);
    set(["edit-sharp", "edit-flat", "edit-natural", "edit-tie", "edit-lyric"], note);
    set(["edit-triplet", "edit-text", "edit-rename"], any);
    em.key.disabled = em.time.disabled = !any;
    $("edit-chord").querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = !note));
    $("edit-dynamics").querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = !any));
    const range = s?.kind === "range";
    $("edit-voices").querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
        b.disabled = !s || idle;
        b.setAttribute("aria-pressed", String(!!s && !range && Number(b.dataset.voice) === s.voice));
    });
    $("edit-marks").querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = !(note || range) || idle));
    set(["edit-slur", "edit-cresc", "edit-dim"], (note || range) && !idle);
    set(["edit-insertbars", "edit-deletebars"], !!s && !idle);
    $("edit-deletebars").textContent = range && s?.barEnd !== s?.bar ? "Delete bars" : "Delete bar";
    set(["edit-addbars", "edit-addline"], !idle);
    $("edit-tie").setAttribute("aria-pressed", String(!!s?.tie));
}

function updateEditBar() {
    const s = edit.sel;
    const note = s?.kind === "note";
    ui.editInfo.innerHTML = "";
    const range = s?.kind === "range";
    if (s && range) {
        const b = document.createElement("b");
        b.textContent = s.bar === s.barEnd ? `Bar ${s.bar}` : `Bars ${s.bar}–${s.barEnd}`;
        const rest = document.createElement("span");
        rest.className = "dim";
        rest.textContent = ` · ${s.staves === 1 ? "1 line" : `${s.staves} lines`} selected`;
        ui.editInfo.append(b, rest);
    } else if (s) {
        const b = document.createElement("b");
        b.textContent = note ? (s.name ?? "Note") : "Rest";
        const rest = document.createElement("span");
        rest.className = "dim";
        const lines = state.tracks.filter((t) => !t.metronome).length;
        // entering: the length the next note gets, as the length buttons show
        const len = entering() ? edit.len : s;
        rest.textContent = ` · ${lengthName(len.den, len.dots)}${s.voice > 1 ? ` · voice ${s.voice}` : ""}${s.tuplet ? " · triplet" : ""} · bar ${s.bar}${lines > 1 && s.part ? " · " + s.part : ""}`;
        ui.editInfo.append(b, rest);
    } else {
        ui.editInfo.textContent = "Tap a note or rest to change it; hold another to select up to it";
    }
    const idle = edit.busy;
    const input = entering();
    $("edit-letters").parentElement!.classList.toggle("on-rest", input);
    $("edit-letters").parentElement!.classList.toggle("on-range", range);
    $<HTMLButtonElement>("edit-copysel").disabled = $<HTMLButtonElement>("edit-cut").disabled = !range || idle;
    pasteButton.hidden = !edit.clip;
    pasteButton.disabled = !s || idle;
    $("edit-letters").querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = idle));
    updateMore(s, idle);
    $("edit-voice").toggleAttribute("disabled", !s || idle);
    $("edit-voice").title = s ? "Sing or hum a tune and put it in as notes" : "Pick the note or rest where the tune should start";
    ui.editPrev.disabled = ui.editNext.disabled = ui.editDelete.disabled = !s || idle;
    ui.editUp.disabled = ui.editDown.disabled = ui.editOctave.disabled = !(note || range) || idle;
    ui.editOctave.title = note ? "Move by an octave instead of a step" : "Select a note to move it";
    ui.editUndo.disabled = edit.undo === 0 || idle;
    ui.editRedo.disabled = edit.redo === 0 || idle;
    ui.editCopy.disabled = !edit.dirty || idle;
    ui.editLengths.querySelectorAll<HTMLButtonElement>(".len:not(.paste)").forEach((b) => {
        b.disabled = !s || range || idle;
        if (b.dataset.den) {
            // entering: the length the next note gets; otherwise the selected one's
            b.setAttribute("aria-checked", String(!!s && Number(b.dataset.den) === (input ? edit.len.den : s.den)));
            b.setAttribute("role", "radio");
        }
    });
    dotButton.setAttribute("aria-pressed", String(!!s && (input ? edit.len.dots : s.dots) > 0));
}

// The box round the selected note: placed on its page, kept in view
function clearEditSel() {
    edit.selEls.forEach((el) => el.remove());
}
function showEditSel(scroll: boolean) {
    const s = edit.sel;
    const boxes = (s?.boxes ?? (s ? [s] : [])).filter((b) => state.pageEls[b.page]);
    if (!s || !boxes.length) {
        clearEditSel();
        return;
    }
    while (edit.selEls.length < boxes.length) {
        const el = document.createElement("div");
        el.className = "edit-sel";
        edit.selEls.push(el);
    }
    edit.selEls.slice(boxes.length).forEach((el) => el.remove());
    const pad = 3;
    boxes.forEach((b, i) => {
        const el = edit.selEls[i];
        const pageEl = state.pageEls[b.page]!;
        if (el.parentElement !== pageEl) {
            pageEl.appendChild(el);
        }
        el.classList.toggle("range", s.kind === "range");
        el.style.transform = `translate(${unitsToCss(b.x) - pad}px, ${unitsToCss(b.y) - pad}px)`;
        el.style.width = unitsToCss(b.w) + 2 * pad + "px";
        el.style.height = unitsToCss(b.h) + 2 * pad + "px";
    });
    if (scroll) {
        const v = ui.viewer.getBoundingClientRect();
        const r = edit.selEls[0].getBoundingClientRect();
        const margin = 80;
        if (r.top < v.top + margin || r.bottom > v.bottom - margin) {
            ui.viewer.scrollTop += r.top + r.height / 2 - (v.top + v.height / 2);
        }
        if (r.left < v.left + margin || r.right > v.right - margin) {
            ui.viewer.scrollLeft += r.left + r.width / 2 - (v.left + v.width / 2);
        }
    }
}

// Taps and holds on the score are handled one after another: the first tap waits for the sound to start, and a
// hold made meanwhile extended from the old selection, then the late tap replaced the range
let editPicks: Promise<void> = Promise.resolve();
function editPick(pick: () => Promise<EditSelection | null>) {
    editPicks = editPicks.then(async () => {
        if (edit.busy) {
            return;
        }
        edit.sel = await pick();
        edit.step = false;
        showEditSel(false);
        updateEditBar();
    }).catch((err) => console.warn("pick failed:", err));
    return editPicks;
}
function editSelectAt(tap: { page: number; x: number; y: number; radius: number }) {
    return editPick(async () => {
        if (!(engine.audioRunning && state.playbackReady) && !state.playing) {
            await startAudioFromTap(); // the first tap starts the sound, and waits for it, so this note sounds too
        }
        const s = await engine.editSelect(tap.page, tap.x, tap.y, tap.radius);
        // as desktop (InputState::update): picking a note or rest makes its length the one notes go in with;
        // a whole-bar rest keeps the length chosen before
        if (s && s.kind !== "range" && s.den > 0) {
            edit.len = { den: s.den, dots: s.dots };
        }
        return s;
    });
}
function editExtendAt(tap: { page: number; x: number; y: number; radius: number }) {
    return editPick(() => engine.editExtend(tap.page, tap.x, tap.y, tap.radius));
}

// The score changed: its size, the time of each note and the pages are all new
async function afterEdit() {
    state.score = await engine.setViewMode(engineMode(shownView));
    state.duration = state.score.duration;
    ui.duration.textContent = fmt(state.duration);
    await Promise.all([loadTimeline(), loadBars(), loadTempos()]);
    rerenderAll(false);
    // a line was added or renamed: the mixer follows
    const tracks = await engine.tracks();
    if (tracks.map((k) => `${k.key}:${k.title}`).join("|") !== state.tracks.map((k) => `${k.key}:${k.title}`).join("|")) {
        state.tracks = tracks;
        buildMixer();
    }
    edit.sel = await engine.editSelection();
    showEditSel(true);
}

async function runEdit(change: () => Promise<EditResult>, kind: "edit" | "undo" | "redo" = "edit"): Promise<boolean> {
    if (edit.busy || !edit.on) {
        return false;
    }
    edit.busy = true;
    edit.step = false; // any other change ends a run of note input (enterStep sets it again)
    updateEditBar();
    try {
        if (state.playing) {
            await engine.pause();
        }
        const r = await change();
        if (!r.ok) {
            setStatus(r.error || "That could not be changed.", "error", 4000);
            return false;
        }
        edit.dirty = true;
        if (kind === "edit") {
            edit.undo++;
            edit.redo = 0;
        } else if (kind === "undo") {
            edit.undo--;
            edit.redo++;
        } else {
            edit.redo--;
            edit.undo++;
        }
        await afterEdit();
        scheduleEditDraft();
        return true;
    } catch (err) {
        console.warn("edit failed:", err);
        setStatus("That could not be changed. Your score is as it was; try again.", "error", 5000);
        return false;
    } finally {
        edit.busy = false;
        updateEditBar();
    }
}

// The silent draft: the edited score, kept shortly after each change (and when the page is hidden), so
// closing the app or the tab loses nothing. Offered back the next time the same score is opened.
async function saveEditDraft() {
    clearTimeout(edit.draftTimer);
    if (embedded || !edit.dirty || !state.scoreKey) {
        return;
    }
    const key = state.scoreKey;
    const r = await engine.saveCopy();
    if (r.ok && r.data && edit.dirty && key === state.scoreKey) {
        const name = (openedScore?.name ?? "score.mscz").replace(/\.mscx$/i, ".mscz"); // what is stored is always a .mscz
        await editDraft.put(key, { name, data: r.data, at: Date.now(), key, fresh: edit.fresh });
    }
}
function scheduleEditDraft() {
    clearTimeout(edit.draftTimer);
    edit.draftTimer = window.setTimeout(() => void saveEditDraft(), 800);
}
document.addEventListener("visibilitychange", () => {
    if (document.hidden && edit.dirty) {
        void saveEditDraft();
    }
});

// Edit by keyboard, with desktop's keys (computers, iPads with a keyboard): A-G and 0 note input, 1-7 the
// lengths (64th to whole), "." dot, arrows move (Shift: a range), Up/Down pitch (Ctrl: octave), Delete,
// Ctrl+C/X/V, Ctrl+Z/Y. Not while typing in a field, and not with a panel or question open over Edit.
document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (!edit.on || edit.busy || ui.ask.open || layers[layers.length - 1] !== closeEdit || t.closest("input, select, textarea, [contenteditable]")) {
        return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
    const s = edit.sel;
    let handled = true;
    if (ctrl && lower === "z") {
        (e.shiftKey ? ui.editRedo : ui.editUndo).click();
    } else if (ctrl && lower === "y") {
        ui.editRedo.click();
    } else if (ctrl && lower === "c") {
        $("edit-copysel").click();
        if (s?.kind !== "range") { // a single note or rest copies too, as on desktop
            void engine.editCopy(false).then((r) => { edit.clip = r.ok || edit.clip; updateEditBar(); });
        }
    } else if (ctrl && lower === "x") {
        $("edit-cut").click();
    } else if (ctrl && lower === "v") {
        pasteButton.click();
    } else if (ctrl && (key === "ArrowUp" || key === "ArrowDown") && s) {
        void runEdit(() => engine.editPitch(key === "ArrowUp" ? 2 : 3));
    } else if (ctrl || e.altKey) {
        handled = false; // the browser's and the system's own shortcuts
    } else if (/^[a-g]$/.test(lower) && s && s.kind !== "range") {
        void enterStep(() => engine.editEnterNote("cdefgab".indexOf(lower), edit.len.den, edit.len.dots));
    } else if (key === "0" && s && s.kind !== "range") {
        void enterStep(() => engine.editEnterRest(edit.len.den, edit.len.dots));
    } else if (/^[1-7]$/.test(key) && s && s.kind !== "range") {
        const den = [64, 32, 16, 8, 4, 2, 1][Number(key) - 1];
        if (den > 32) {
            handled = false; // no 64th button; desktop's 1 is a 64th
        } else {
            ui.editLengths.querySelector<HTMLButtonElement>(`.len[data-den="${den}"]`)?.click();
        }
    } else if (key === "." && s && s.kind !== "range") {
        dotButton.click();
    } else if ((key === "ArrowRight" || key === "ArrowLeft") && s) {
        const dir = key === "ArrowRight" ? "next" : "prev";
        if (e.shiftKey) {
            void (async () => {
                edit.sel = await engine.editMove(`extend-${dir}-chord`);
                edit.step = false;
                showEditSel(true);
                updateEditBar();
            })();
        } else {
            void moveSelection(`${dir}-chord`);
        }
    } else if ((key === "ArrowUp" || key === "ArrowDown") && (s?.kind === "note" || s?.kind === "range")) {
        void runEdit(() => engine.editPitch(key === "ArrowUp" ? 0 : 1));
    } else if ((key === "Delete" || key === "Backspace") && s) {
        ui.editDelete.click();
    } else {
        handled = false;
    }
    if (handled) {
        e.preventDefault();
    }
});

async function moveSelection(to: "next-chord" | "prev-chord") {
    if (edit.busy) {
        return;
    }
    const s = await engine.editMove(to);
    edit.step = false;
    if (s) {
        edit.sel = s;
    }
    showEditSel(true);
    updateEditBar();
}

// A copy of the score with the edits, as a .mscz of its own. Shared where the device has a share
// sheet that takes files, downloaded otherwise. Resolves true once it was handed over.
async function saveCopy(): Promise<boolean> {
    const r = await engine.saveCopy();
    if (!r.ok || !r.data) {
        setStatus(r.error || "The copy could not be made.", "error", 6000);
        return false;
    }
    const base = (openedScore?.name ?? ui.title.textContent ?? "score").replace(/\.(mscz|mscx)$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim() || "score";
    const name = edit.fresh ? `${base}.mscz` : `${base} (edited).mscz`;
    const file = new File([r.data], name, { type: "application/octet-stream" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: name });
            edit.dirty = false;
            void editDraft.remove(state.scoreKey);
            setStatus(`Saved a copy: ${name}`, "info", 5000);
            updateEditBar();
            return true;
        } catch (err) {
            if ((err as Error).name === "AbortError") {
                return false; // the reader closed the share sheet
            }
            // no luck with the share sheet: download it instead
        }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    edit.dirty = false;
    void editDraft.remove(state.scoreKey);
    setStatus(`Saved a copy: ${name}. Look in your downloads.`, "info", 7000);
    updateEditBar();
    return true;
}

function setEditActive(on: boolean) {
    edit.on = on;
    ui.editbar.hidden = !on;
    ui.editToggle.setAttribute("aria-pressed", String(on));
    document.documentElement.classList.toggle("editing", on);
    if (on) {
        if (notes.active) {
            swapLayer(closeNotes, closeEdit);
            setNotesActive(false);
        }
        if (state.playing) {
            void engine.pause();
        }
    } else {
        edit.sel = null;
        clearEditSel();
        void engine.editClearSelection();
    }
    updateEditBar();
}

// A new score starts with nothing edited
function resetEdit() {
    clearTimeout(edit.draftTimer);
    edit.fresh = false;
    edit.on = false;
    edit.sel = null;
    edit.dirty = false;
    edit.undo = edit.redo = 0;
    edit.step = false;
    edit.len = { den: 4, dots: 0 }; // each score starts note input on quarters, as desktop does
    clearEditSel();
    ui.editbar.hidden = true;
    ui.editToggle.setAttribute("aria-pressed", "false");
    document.documentElement.classList.remove("editing");
}

const closeEdit = () => setEditActive(false);
ui.editToggle.onclick = () => {
    if (edit.on) {
        closeLayer(closeEdit);
    } else {
        setEditActive(true);
        if (!layers.includes(closeEdit)) { // unless it took the Notes' Back entry
            openLayer(closeEdit);
        }
    }
};
ui.editDone.onclick = () => closeLayer(closeEdit);
ui.editUp.onclick = () => void runEdit(() => engine.editPitch(edit.octave ? 2 : 0));
ui.editDown.onclick = () => void runEdit(() => engine.editPitch(edit.octave ? 3 : 1));
ui.editOctave.onclick = () => {
    edit.octave = !edit.octave;
    ui.editOctave.setAttribute("aria-pressed", String(edit.octave));
};
ui.editDelete.onclick = () => void runEdit(() => engine.editDelete());
ui.editUndo.onclick = () => void runEdit(() => engine.editUndo(), "undo");
ui.editRedo.onclick = () => void runEdit(() => engine.editRedo(), "redo");
ui.editPrev.onclick = () => void moveSelection("prev-chord");
ui.editNext.onclick = () => void moveSelection("next-chord");
ui.editCopy.onclick = () => void saveCopy();

// ---------------------------------------------------------------- sing it in (voice to notes, one voice)

// Record (or choose a recording), find the notes on this device, show them, and put them in from the picked
// note or rest on, as one undo step. Nothing is uploaded; the recording is dropped once the notes are found.
const voice = {
    notes: [] as SungNote[],
    grid: [] as GridNote[],
    bpm: 100,
    smallest: 16 as 8 | 16,
    shift: 0,
    stream: null as MediaStream | null,
    recorder: null as MediaRecorder | null,
    chunks: [] as Blob[],
    timer: 0,
    started: 0,
    listen: null as { ctx: AudioContext; stop: () => void } | null,
    token: 0, // a newer recording or a closed dialog makes older work stop
    // the metronome while recording (issue #35): on unless switched off, and it stays as the reader left it
    click: true,
    metro: null as { ctx: AudioContext; stop: () => void } | null,
    clicks: 0, // beeps played in this recording: any at all, and the recording is filtered (removeClicks)
};
const vEl = {
    dlg: $<HTMLDialogElement>("voice"),
    source: $("voice-source"),
    rec: $("voice-rec"),
    time: $("voice-time"),
    result: $("voice-result"),
    roll: $<HTMLCanvasElement>("voice-roll"),
    tempo: $<HTMLInputElement>("voice-tempo"),
    click: $<HTMLInputElement>("voice-click"),
    where: $("voice-where"),
    grid: $<HTMLSelectElement>("voice-grid"),
    status: $("voice-status"),
    listen: $<HTMLButtonElement>("voice-listen"),
    put: $<HTMLButtonElement>("voice-put"),
};
const MAX_VOICE_SECS = 60;

function voiceSay(text: string, bad = false) {
    vEl.status.textContent = text;
    vEl.status.classList.toggle("bad", bad);
}

function voiceStopListening() {
    voice.listen?.stop();
    voice.listen = null;
    vEl.listen.textContent = "Listen";
}

// The beat while recording, on a small synth of its own (the score isn't playing): short high beeps, scheduled
// a little ahead on the audio clock so they stay even when the page is busy.
function voiceMetronome(ctx: AudioContext) {
    const beat = 60 / voice.bpm;
    let next = ctx.currentTime + 0.15;
    const ahead = () => {
        while (next < ctx.currentTime + 0.3) {
            if (voice.click) {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.frequency.value = CLICK_HZ;
                g.gain.setValueAtTime(0.5, next);
                g.gain.exponentialRampToValueAtTime(0.001, next + CLICK_SECS);
                o.connect(g).connect(ctx.destination);
                o.start(next);
                o.stop(next + CLICK_SECS + 0.01);
                voice.clicks++;
            }
            next += beat;
        }
    };
    ahead();
    const timer = window.setInterval(ahead, 100);
    voice.metro = { ctx, stop: () => { clearInterval(timer); void ctx.close(); } };
}

function voiceStopMetronome() {
    voice.metro?.stop();
    voice.metro = null;
}

function voiceReleaseMic() {
    voiceStopMetronome();
    vEl.tempo.disabled = false;
    clearInterval(voice.timer);
    voice.stream?.getTracks().forEach((t) => t.stop());
    voice.stream = null;
    voice.recorder = null;
}

function voiceReset() {
    voice.token++;
    voiceStopListening();
    voiceReleaseMic();
    voice.chunks = [];
    voice.notes = [];
    voice.grid = [];
    voice.shift = 0;
    vEl.source.hidden = false;
    vEl.rec.hidden = true;
    vEl.result.hidden = true;
    vEl.listen.disabled = vEl.put.disabled = true;
    voiceSay("");
}

function drawRoll() {
    const c = vEl.roll;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const notes = voice.grid.filter((n) => n.midi >= 0);
    const total = voice.grid.reduce((a, n) => a + n.units, 0);
    if (!notes.length || !total) {
        return;
    }
    let lo = Math.min(...notes.map((n) => n.midi)) - 1;
    let hi = Math.max(...notes.map((n) => n.midi)) + 1;
    if (hi - lo < 12) {
        lo = Math.floor((hi + lo) / 2 - 6);
        hi = lo + 12;
    }
    const rowH = h / (hi - lo + 1);
    g.strokeStyle = "rgba(16, 24, 36, 0.12)";
    g.lineWidth = 1;
    for (let u = 0; u <= total; u += 4) { // a line for each beat
        const x = Math.round((u / total) * (w - 2)) + 0.5;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
    }
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1e6ad0";
    let at = 0;
    for (const n of voice.grid) {
        if (n.midi >= 0) {
            const x = (at / total) * (w - 2);
            const wd = Math.max(2, (n.units / total) * (w - 2) - 1.5);
            g.beginPath();
            g.roundRect(x + 1, (hi - n.midi) * rowH + 1, wd, Math.max(3, rowH - 2), 2);
            g.fill();
        }
        at += n.units;
    }
}

function voiceRefresh() {
    voice.grid = toGrid(voice.notes, voice.bpm, voice.smallest, voice.shift);
    drawRoll();
    const notes = voice.grid.filter((n) => n.midi >= 0).length;
    const secs = voice.grid.reduce((a, n) => a + n.units, 0) * (60 / (voice.bpm * 4));
    vEl.listen.disabled = vEl.put.disabled = !notes;
    voiceSay(notes ? `${notes} note${notes === 1 ? "" : "s"}, about ${Math.round(secs)} s at this speed. Check them with Listen; change the speed if they look too crowded or too stretched.` : "No notes at this setting.");
}

async function voiceProcess(data: ArrayBuffer, beeped = false) {
    const mine = ++voice.token;
    vEl.source.hidden = true;
    vEl.rec.hidden = true;
    voiceSay("Listening to it…");
    try {
        const samples = await decodeTo16k(data);
        if (voice.token !== mine) {
            return;
        }
        if (samples.length / SAMPLE_RATE > MAX_VOICE_SECS + 5) {
            throw new Error(`That is longer than ${MAX_VOICE_SECS} seconds. Choose or record a shorter tune.`);
        }
        // the microphone heard the metronome too: out it goes, or its beeps come back as notes
        const frames = await trackPitch(beeped ? removeClicks(samples) : samples, (d) => voice.token === mine && voiceSay(`Listening to it… ${Math.round(d * 100)}%`));
        if (voice.token !== mine) {
            return;
        }
        voice.notes = findNotes(frames);
    } catch (err) {
        if (voice.token === mine) {
            const msg = (err as Error).message || "";
            voiceReset();
            voiceSay(/longer than/.test(msg) ? msg : "That recording could not be read. Try another one.", true);
        }
        return;
    }
    if (!voice.notes.length) {
        voiceReset();
        voiceSay("No tune found. Sing a little louder and closer, one note at a time, and try again.", true);
        return;
    }
    // the octave that puts the tune in the middle of the staff it goes into (a bass line sung at C4 goes down)
    const sorted = voice.notes.map((n) => n.midi).sort((a, b) => a - b);
    const mid = edit.sel?.mid;
    voice.shift = mid === undefined ? 0 : Math.max(-3, Math.min(3, Math.round((mid - sorted[sorted.length >> 1]) / 12)));
    vEl.grid.value = String(voice.smallest);
    vEl.result.hidden = false;
    vEl.source.hidden = false;
    voiceRefresh();
}

async function voiceRecord() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        voiceSay("This browser can't record here. Choose a recording instead.", true);
        return;
    }
    // made in the tap itself, before the microphone question: Safari starts sound only from a tap
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const beat: AudioContext = new Ctx();
    void beat.resume();
    try {
        voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    } catch (err) {
        void beat.close();
        voiceSay("PocketScore can't use the microphone. Allow it in the browser's settings for this site, or choose a recording instead.", true);
        return;
    }
    if (state.playing) {
        await engine.pause();
    }
    voice.chunks = [];
    const rec = new MediaRecorder(voice.stream);
    voice.recorder = rec;
    rec.ondataavailable = (e) => e.data.size && voice.chunks.push(e.data);
    rec.onstop = async () => {
        const blob = new Blob(voice.chunks, { type: rec.mimeType });
        const beeped = voice.clicks > 0;
        voiceReleaseMic();
        voice.chunks = [];
        if (vEl.dlg.open && blob.size) {
            await voiceProcess(await blob.arrayBuffer(), beeped);
        }
    };
    rec.start();
    voice.started = performance.now();
    voice.clicks = 0;
    voiceMetronome(beat); // silent while the switch is off, so it can be turned on part-way
    vEl.tempo.disabled = true; // the beat can't change under the singer
    vEl.source.hidden = true;
    vEl.result.hidden = true;
    vEl.rec.hidden = false;
    voiceSay("Sing now: your first note starts the tune. Tap Stop when you are done.");
    const tick = () => {
        const secs = (performance.now() - voice.started) / 1000;
        vEl.time.textContent = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
        if (secs >= MAX_VOICE_SECS && rec.state === "recording") {
            rec.stop();
        }
    };
    tick();
    voice.timer = window.setInterval(tick, 250);
}

// The notes as the tune will sound, on a small synth of their own: a triangle wave per note
function voiceListen() {
    if (voice.listen) {
        voiceStopListening();
        return;
    }
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx();
    const unit = 60 / (voice.bpm * 4);
    let at = ctx.currentTime + 0.1;
    for (const n of voice.grid) {
        const len = n.units * unit;
        if (n.midi >= 0) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = "triangle";
            o.frequency.value = 440 * 2 ** ((n.midi - 69) / 12);
            g.gain.setValueAtTime(0, at);
            g.gain.linearRampToValueAtTime(0.25, at + 0.02);
            g.gain.setValueAtTime(0.25, at + Math.max(0.02, len - 0.06));
            g.gain.linearRampToValueAtTime(0, at + len - 0.01);
            o.connect(g).connect(ctx.destination);
            o.start(at);
            o.stop(at + len);
        }
        at += len;
    }
    const timer = window.setTimeout(() => voice.listen?.ctx === ctx && voiceStopListening(), (at - ctx.currentTime) * 1000 + 100);
    voice.listen = { ctx, stop: () => { clearTimeout(timer); void ctx.close(); } };
    vEl.listen.textContent = "Stop listening";
}

// The speed in force at a bar: the metronome's, and the grid's (issue #35). A score with no speed written
// has the engine's own 120. Kept between 50 and 200 by counting in halves or doubles.
function tempoAtBar(bar: number) {
    const start = barStarts.find(([no]) => no === bar)?.[1] ?? 0;
    let bpm = baseTempoAt(start + 0.001) || 120;
    while (bpm < 50) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    return Math.round(bpm);
}

function openVoice() {
    const s = edit.sel;
    if (!s || edit.busy) {
        return;
    }
    voiceReset();
    voice.bpm = tempoAtBar(s.bar);
    vEl.tempo.value = String(voice.bpm);
    vEl.click.checked = voice.click;
    // where the tune goes: the line and the bar that were picked
    const lines = state.tracks.filter((t) => !t.metronome).length;
    const b = document.createElement("b");
    b.textContent = `${lines > 1 && s.part ? s.part + ", " : ""}bar ${s.bar}`;
    vEl.where.replaceChildren("The notes go into ", b, ", from the note or rest you picked, and replace what is there. A tune longer than the bar carries on into the next bars.");
    vEl.dlg.showModal();
}

$("edit-voice").onclick = openVoice;
$("voice-record").onclick = () => void voiceRecord();
$("voice-stop").onclick = () => voice.recorder?.state === "recording" && voice.recorder.stop();
$<HTMLInputElement>("voice-file").onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) {
        await voiceProcess(await file.arrayBuffer());
    }
};
vEl.tempo.onchange = () => {
    voice.bpm = Math.max(30, Math.min(240, Math.round(Number(vEl.tempo.value)) || voice.bpm));
    vEl.tempo.value = String(voice.bpm);
    if (voice.notes.length) {
        voiceRefresh();
    }
};
vEl.click.onchange = () => {
    voice.click = vEl.click.checked;
};
vEl.grid.onchange = () => {
    voice.smallest = vEl.grid.value === "8" ? 8 : 16;
    voiceRefresh();
};
$("voice-oct-up").onclick = () => { voice.shift = Math.min(3, voice.shift + 1); voiceRefresh(); };
$("voice-oct-down").onclick = () => { voice.shift = Math.max(-3, voice.shift - 1); voiceRefresh(); };
vEl.listen.onclick = voiceListen;
$("voice-cancel").onclick = () => vEl.dlg.close();
vEl.dlg.addEventListener("close", voiceReset);
vEl.put.onclick = async () => {
    const events = voice.grid.map((n) => [n.midi, n.units] as [number, number]);
    vEl.dlg.close();
    let result: EditResult & { done?: number; total?: number } = { ok: false };
    await runEdit(async () => (result = await engine.editInsertNotes(events)));
    if (result.ok) {
        const done = result.done ?? 0;
        const total = result.total ?? 0;
        setStatus(done < total ? `The score ended after ${done} of ${total} notes. Undo takes the tune out again.` : "The tune is in. Undo takes it out again.", "info", 7000);
    }
};
window.addEventListener("beforeunload", (e) => {
    if (edit.dirty) {
        e.preventDefault(); // the browser's own "leave this page?" question
    }
});
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


// ---------------------------------------------------------------- new score

// A blank score made on the spot (newscore.ts): opened like a file, then straight into Edit with the first
// rest picked. It has no file to open again, so its silent draft is offered on the start screen until a copy is saved.
const ns = {
    dlg: $<HTMLDialogElement>("newscore"),
    title: $<HTMLInputElement>("ns-title"),
    lines: $("ns-lines"),
    key: $<HTMLSelectElement>("ns-key"),
    time: $<HTMLSelectElement>("ns-time"),
    bpm: $<HTMLInputElement>("ns-bpm"),
    bars: $<HTMLInputElement>("ns-bars"),
};
// The lines of the new score: a name to change and a clef, as many as the reader adds
function addLine(name?: string) {
    const row = document.createElement("div");
    row.className = "ns-line";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 30;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Name of this line");
    input.value = name ?? `Line ${ns.lines.children.length + 1}`;
    const clef = document.createElement("select");
    clef.setAttribute("aria-label", "Clef");
    CLEFS.forEach(([v, label]) => clef.add(new Option(label, v)));
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "btn small plain";
    drop.setAttribute("aria-label", "Remove this line");
    drop.textContent = "✕";
    drop.onclick = () => { row.remove(); lineButtons(); };
    row.append(input, clef, drop);
    ns.lines.appendChild(row);
    lineButtons();
}
function lineButtons() {
    const rows = ns.lines.children.length;
    ns.lines.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = rows < 2)); // one line stays
    $<HTMLButtonElement>("ns-add").disabled = rows >= 12;
}
$("ns-add").onclick = () => {
    addLine();
    (ns.lines.lastElementChild!.querySelector("input") as HTMLInputElement).select();
};
addLine("Line 1");
KEYS.forEach(([k, name]) => ns.key.add(new Option(name, String(k))));
TIMES.forEach(([n, d]) => ns.time.add(new Option(`${n}/${d}`, `${n}/${d}`)));

$("new-score").onclick = () => ns.dlg.showModal();
// from inside a score too, behind Edit's More (no room for it in the top bar on a phone)
$("edit-newscore").onclick = () => ns.dlg.showModal();
$("ns-cancel").onclick = () => ns.dlg.close();
$("ns-create").onclick = async () => {
    const lines: LineChoice[] = [...ns.lines.children].map((row) => ({
        name: (row.querySelector("input") as HTMLInputElement).value.trim() || "Line",
        clef: (row.querySelector("select") as HTMLSelectElement).value as LineChoice["clef"],
    }));
    const title = ns.title.value.trim() || "Untitled";
    const [num, den] = ns.time.value.split("/").map(Number);
    const text = buildScore({
        title, lines, key: Number(ns.key.value), time: [num, den],
        bpm: Math.max(30, Math.min(240, Number(ns.bpm.value) || 100)),
        bars: Math.max(1, Math.min(300, Number(ns.bars.value) || 16)),
    });
    ns.dlg.close();
    const bytes = new TextEncoder().encode(text);
    // cancelled at "Save a copy … before closing it?": the open score must not become a new one
    if (await openChosen(`${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Untitled"}.mscx`, bytes.buffer as ArrayBuffer)) {
        await beginFresh();
    }
};

// A score made here: Edit opens on its first rest, and nothing is saved until a copy is
async function beginFresh() {
    edit.fresh = true;
    edit.dirty = true;
    em.panel.hidden = true; // the new score shows, not the More panel it was made from
    em.btn.setAttribute("aria-pressed", "false");
    em.btn.setAttribute("aria-expanded", "false");
    if (!edit.on) {
        setEditActive(true);
    }
    if (!layers.includes(closeEdit)) { // made from inside Edit: its Back entry is still there
        openLayer(closeEdit);
    }
    edit.sel = await engine.editSelectStart();
    showEditSel(true);
    updateEditBar();
    void saveEditDraft(); // so even an untouched new score can be resumed
}

// The start screen offers the newest unsaved new score, and the others behind a small "N more" (desktop
// restores every unsaved score of a session; the list stays out of the way until asked for)
const resume = {
    row: $("resume-row"), btn: $<HTMLButtonElement>("resume-score"), drop: $<HTMLButtonElement>("resume-drop"),
    more: $<HTMLButtonElement>("resume-more"), list: $("resume-list"), key: "",
};
const draftName = (d: EditDraft) => d.name.replace(/\.(mscz|mscx)$/i, "");
async function showResume() {
    if (embedded || !composer) {
        return;
    }
    const [d, ...others] = await editDraft.fresh();
    resume.row.hidden = !d || !!state.score;
    if (d) {
        resume.key = d.key ?? "";
        resume.btn.textContent = `Continue “${draftName(d)}”`;
    }
    resume.more.hidden = !others.length;
    resume.more.textContent = `${others.length} more`;
    if (!others.length) {
        resume.list.hidden = true;
        resume.more.setAttribute("aria-expanded", "false");
    }
    resume.list.replaceChildren(...others.map((o) => {
        const row = document.createElement("span");
        row.className = "resume-item";
        const go = document.createElement("button");
        go.className = "btn small";
        go.textContent = `Continue “${draftName(o)}”`;
        go.onclick = () => void continueDraft(o.key ?? "");
        const when = document.createElement("span");
        when.className = "hint";
        when.textContent = new Date(o.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
        const drop = document.createElement("button");
        drop.className = "btn small plain";
        drop.textContent = "Discard";
        drop.setAttribute("aria-label", `Discard “${draftName(o)}”`);
        drop.onclick = () => void dropDraft(o.key ?? "");
        row.append(go, when, drop);
        return row;
    }));
}
async function continueDraft(key: string) {
    const d = await editDraft.get(key);
    if (!d) {
        return;
    }
    resume.row.hidden = true;
    if (!(await openChosen(d.name, d.data))) {
        void showResume();
        return;
    }
    // opened: its draft is kept again, under the new key, by beginFresh (a draft that could not be
    // opened stays where it is: bug hunt, finding 15)
    await editDraft.remove(key);
    await beginFresh();
}
async function dropDraft(key: string) {
    await editDraft.remove(key);
    void showResume();
}
resume.btn.onclick = () => void continueDraft(resume.key);
resume.drop.onclick = () => void dropDraft(resume.key);
resume.more.onclick = () => {
    resume.list.hidden = !resume.list.hidden;
    resume.more.setAttribute("aria-expanded", String(!resume.list.hidden));
};
void showResume();

// Let tests and the console drive the app
// pages: what page drawing is waiting for (tests and USB debugging)
const pagesInfo = () => ({ fingersDown, sinceTouchMs: Math.round(performance.now() - lastTouch), waiting: [...jobs.keys()], drawing });
(window as any).app = { engine, state, settings, edit, voice, layers, updateEditBar, showEditSel, playLog, sendReport, openScore, notes, mix, currentMix, pagesInfo, firstTime, cursorAt: (secs: number) => cursorFromTimeline(secs),
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
            { target: el("settings-open"), also: () => [$("help")], title: "Settings and help", text: "The gear has Settings, such as keeping the music playing when you leave the app, and a playback report to send if the music stutters. Once a score is open, tap ? again to see how to play it, practise your part and write on it." },
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
        ...(!composer ? [] : [{ target: el("edit-toggle"), title: "Change the notes", text: "Edit lets you change the music itself. Tap a note or rest, then move it up or down, change its length, or delete it. On a rest, pick a length and tap letters C to B one after another: each note goes in after the last. Hold your finger on a second note to select everything up to it, then Copy, Cut, Paste or move it. The three dots (More) hold sharps and flats, ties, triplets, voices, marks, slurs and hairpins, chords, dynamics, words and lyrics, key and time, bars and lines, the microphone that turns a tune you sing into notes (a metronome beeps the beat while you record), and New score. Undo and Redo are at the top right. Save a copy makes a new .mscz file: it never replaces the one you opened." }]),
        { target: el("notes-toggle"), also: () => [el("save")()], title: "Your notes", text: "Write on the score with a pen, highlighter or text boxes, using a finger or a stylus. Save keeps your notes and mixer changes for this score on this device, not in the file. If you forget, PocketScore asks before you open another score." },
        { target: el("view-mode"), title: "Views", text: "Page view scrolls through the pages. Page by page shows one whole page at a time: swipe left or right to turn it, and zoom in to read closer. Two pages shows two side by side with the device on its side, and hides the controls (tap off the music to bring them back); each swipe slides along one page, so the right page becomes the left (Settings can make a swipe turn both). Continuous lays the music out in one long line." },
        { target: el("focus-toggle"), also: () => [el("settings-open")(), el("help")()], title: "Focus, settings and help", text: "Focus (the first icon) hides everything but the music and a play button; tap off the staves to bring the controls back. The gear has Settings, such as keeping the music playing when you leave the app, and a playback report to send if the music stutters. ? shows this tour again." },
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
