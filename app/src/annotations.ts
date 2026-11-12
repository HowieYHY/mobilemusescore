// Your own notes on the score: pen and highlighter ink and text boxes. Kept on
// this device, per score, in page units of the layout they were written in, so
// they stay put when zooming. Each is also pinned to the music (musicmap.ts),
// so it shows in the other layouts too, on the same music; marks away from the
// music (margins, the title) show only where they were written. When the music is
// edited, each pinned note follows its bar as a staff text does in desktop MuseScore
// (musicChanged; the rules are in notepins.ts). A stylus always
// draws; a finger draws when "Draw with finger" is on (by default until a
// stylus is seen), and two fingers then scroll.

import { MusicMap, type Anchor, type SystemStaves, type TimelinePoint } from "./musicmap";
import { textField } from "./typing";
import { barMover, staffMover, sameAnchors, type Bars } from "./notepins";

/** What notes are pinned to, as the engine lists it: every bar and staff of the score with its id. */
export interface ScoreAnchors { bars: Bars; staves: number[] }

// Text boxes take plain text only, so pasted formatting or pictures never enter one (issue #27);
// browsers without "plaintext-only" fall back to "true" (the text is still saved as plain text)
const editable = (() => {
    const probe = document.createElement("div");
    probe.contentEditable = "plaintext-only";
    return probe.contentEditable === "plaintext-only" ? "plaintext-only" : "true";
})();

export type Tool = "pen" | "highlighter" | "text" | "eraser";

// `a`: the music under each point (null where there is none), filled in by the layout it was written in
// `part`: what is left of the stroke with this id after some of its bars were deleted (undo brings the whole back)
interface Stroke { id: string; tool: "pen" | "highlighter"; color: string; width: number; pts: number[]; a?: (Anchor | null)[]; part?: string } // x,y,x,y… page units
interface TextNote { id: string; x: number; y: number; size: number; color: string; text: string; a?: Anchor | null }
interface PageNotes { strokes: Stroke[]; texts: TextNote[] }
type ModeNotes = Record<string, PageNotes>; // by page index
// `stale`: layouts whose notes' places on the page are from before the music was edited; they are
// worked out again from the pins the next time that layout is shown
interface Stored { v: 1; modes: Record<string, ModeNotes>; stale?: string[] }

// A note that went with its deleted bars, kept while the score is open so that undoing the deletion
// brings it back: its pins' bars by the engine's ids (`ids`, one per point; null: not pinned to a bar)
interface Gone { mode: string; page: number; kind: "stroke" | "text"; item: Stroke | TextNote; ids: (number | null)[] }

// `mode`: the layout the item belongs to (a note from another layout can be erased here)
type Undo =
    | { op: "add" | "remove"; mode: string; page: number; kind: "stroke"; item: Stroke }
    | { op: "add" | "remove"; mode: string; page: number; kind: "text"; item: TextNote }
    | { op: "restore"; data: Record<string, ModeNotes> };

// A note from another layout as placed in this one
interface Shown { mode: string; page: number } // where it belongs
interface ShownStroke extends Shown { item: Stroke; parts: number[][] } // its points here, a part per run on one page
interface ShownText extends Shown { item: TextNote; x: number; y: number }

interface PageView { el: HTMLElement; svg: SVGSVGElement; texts: HTMLElement; w: number; h: number }

const SVG = "http://www.w3.org/2000/svg";
const STORAGE_PREFIX = "pocketscore.notes.";      // saved notes, by score
const DRAFT_PREFIX = "pocketscore.notesDraft.";   // notes changed since the last Save
const PREFS_KEY = "pocketscore.notesPrefs";
const DOUBLE_TAP_MS = 400;

/** The colours in the toolbar. */
export const COLORS = ["#000000", "#ffffff", "#d62828", "#1d5fd1", "#2a9d4b", "#f2c200"];
/** The fuller palette behind the toolbar's "More colours" button. */
export const MORE_COLORS = [
    "#000000", "#4d4d4d", "#8c8c8c", "#c8c8c8", "#ffffff",
    "#7a1010", "#d62828", "#f26b5b", "#e8590c", "#f59f00",
    "#f2c200", "#ffe066", "#5c940d", "#2a9d4b", "#8ce99a",
    "#0b7285", "#22b8cf", "#1d5fd1", "#74a7f2", "#1b2a80",
    "#5f3dc4", "#9c6ade", "#c2255c", "#f783ac", "#7b4a26",
];

const ICON_CLOSE = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const ICON_MOVE = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2l3.5 3.5h-2.5v5h5V8l3.5 3.5-3.5 3.5v-2.5h-5v5h2.5L12 21l-3.5-3.5H11v-5H6V15l-3.5-3.5L6 8v2.5h5v-5H8.5z" fill="currentColor"/></svg>`;

type SizedTool = "pen" | "highlighter" | "eraser";
/** Sizes on screen (CSS px): stroke width, eraser reach. Text is sized by
 * resizing its box instead. */
export const SIZES: Record<SizedTool, number[]> = {
    pen: [1.2, 2.4, 4, 7],
    highlighter: [8, 14, 22, 32],
    eraser: [6, 10, 18, 30],
};
const TEXT_PX = 16; // new text boxes
const MIN_TEXT_PX = 8;

/** Notes as stored: empty pages and views dropped, so equal notes give equal text. */
function serialised(d: Stored): string {
    const modes: Record<string, ModeNotes> = {};
    for (const [m, pages] of Object.entries(d.modes)) {
        const kept: ModeNotes = {};
        for (const [i, p] of Object.entries(pages)) {
            if (p.strokes.length || p.texts.length) {
                kept[i] = p;
            }
        }
        if (Object.keys(kept).length) {
            modes[m] = kept;
        }
    }
    const stale = (d.stale ?? []).filter((m) => modes[m]);
    return JSON.stringify(stale.length ? { v: 1, modes, stale } : { v: 1, modes });
}

/** The same without the pins to the music, to tell whether the reader changed anything: older
 * notes get their pins when their layout is shown, which must not light up Save. */
function normalised(d: Stored): string {
    return JSON.stringify(JSON.parse(serialised(d)), (k, v) => (k === "a" ? undefined : v));
}

const ICON_RESIZE = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M20 4L4 20M20 4h-6M20 4v6M4 20h6M4 20v-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function pathD(p: number[]): string {
    if (p.length <= 2) {
        return `M${p[0]} ${p[1]}L${p[0]} ${p[1]}`; // a dot (round caps)
    }
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length - 2; i += 2) {
        d += `Q${p[i]} ${p[i + 1]} ${(p[i] + p[i + 2]) / 2} ${(p[i + 1] + p[i + 3]) / 2}`;
    }
    return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class Annotations {
    active = false;
    tool: Tool = "pen";
    private colors: Record<Tool, string> = { pen: "#000000", highlighter: "#f2c200", text: "#000000", eraser: "" };
    private sawStylus = false;
    /** "Draw with finger" as the reader set it; null = automatic (on until a stylus is seen). */
    private fingerChoice: boolean | null = null;
    private key = "";
    private mode = "page";
    private data: Stored = { v: 1, modes: {} };
    /** Where the music is in the current layout (null until its timeline is known). */
    private map: MusicMap | null = null;
    /** Other layouts' notes as placed in this one, by page. */
    private shown = new Map<number, { strokes: ShownStroke[]; texts: ShownText[] }>();
    private views = new Map<number, PageView>();
    private undoStack: Undo[] = [];
    private gone: Gone[] = [];
    private saveTimer = 0;
    /** Notes save by themselves: "" (nothing written yet), "saving", "saved" or "failed". */
    /** The saved notes (normalised JSON), to tell whether there are unsaved changes. */
    private savedJson = "";
    /** Opening the score brought back changes that were never saved. */
    restoredDraft = false;
    /** Thickness / size choice per tool: an index into SIZES. */
    private sizes: Record<SizedTool, number> = { pen: 1, highlighter: 1, eraser: 1 };
    private drawing: { pointerId: number; page: number; stroke: Stroke; path: SVGPathElement; lastX: number; lastY: number } | null = null;
    private erasing: { pointerId: number; page: number } | null = null;
    private touches = new Map<number, { x: number; y: number }>();
    private lastPointerType = "";
    private tapStart: { id: number; x: number; y: number } | null = null;
    private lastTap: { t: number; x: number; y: number } | null = null;

    constructor(
        private pagesEl: HTMLElement,
        private viewer: HTMLElement,
        private onChange: () => void, // undo availability etc.
        private onError: (msg: string) => void,
    ) {
        this.loadPrefs();
        pagesEl.addEventListener("pointerdown", (e) => this.onDown(e));
        pagesEl.addEventListener("pointermove", (e) => this.onMove(e));
        pagesEl.addEventListener("pointerup", (e) => this.onUp(e));
        pagesEl.addEventListener("pointercancel", (e) => this.onCancel(e));
        // Stop the page scrolling under the pen. CSS (touch-action, see
        // updateTouchMode) does this for fingers; a stylus on iOS also needs
        // touchstart cancelled, decided here: a stylus always draws.
        pagesEl.addEventListener("touchstart", (e) => {
            const t = e.changedTouches[0] as Touch & { touchType?: string };
            if (t?.touchType === "stylus") {
                this.noteStylus();
            }
            if (!this.active || !this.drawingTool || (e.target as Element).closest?.(".tnote")) {
                return;
            }
            const stylus = t?.touchType === "stylus" || this.lastPointerType === "pen";
            if (e.touches.length === 1 && (stylus || this.fingerDraws)) {
                e.preventDefault();
            }
        }, { passive: false });
    }

    private get drawingTool() {
        return this.tool === "pen" || this.tool === "highlighter" || this.tool === "eraser";
    }

    /**
     * In notes mode, whether a finger's tap is free for the score (hearing a
     * note, moving the playback): "Draw with finger" is off and the tool is
     * not Text (whose taps make text boxes).
     */
    fingerTapIsFree(e: PointerEvent): boolean {
        return e.pointerType === "touch" && !this.fingerDraws && this.tool !== "text"
            && !(e.target as Element).closest?.(".tnote") && !this.editingText;
    }

    /** Whether one finger draws (true) or scrolls (false). */
    get fingerDraws(): boolean {
        return this.fingerChoice ?? !this.sawStylus;
    }

    setFingerDraws(on: boolean) {
        this.fingerChoice = on;
        this.savePrefs();
        this.updateTouchMode();
        this.onChange();
    }

    private noteStylus() {
        if (!this.sawStylus) {
            this.sawStylus = true;
            this.updateTouchMode();
            this.onChange(); // "Draw with finger" turns off, unless set by hand
        }
    }

    // A finger that draws must not also scroll the page. The browser decides
    // that from touch-action when the touch starts, so it is set ahead of time;
    // otherwise the browser takes the gesture over and cancels the stroke
    // (Chrome on Android).
    private updateTouchMode() {
        this.pagesEl.classList.toggle("finger-draw", this.active && this.drawingTool && this.fingerDraws);
    }

    private loadPrefs() {
        try {
            const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
            if (p && typeof p === "object") {
                for (const t of ["pen", "highlighter", "text"] as const) {
                    const c = p.colors?.[t];
                    if (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)) {
                        this.colors[t] = c;
                    }
                }
                if (typeof p.finger === "boolean") {
                    this.fingerChoice = p.finger;
                }
                for (const t of ["pen", "highlighter", "eraser"] as const) {
                    const s = p.sizes?.[t];
                    if (Number.isInteger(s) && s >= 0 && s < SIZES[t].length) {
                        this.sizes[t] = s;
                    }
                }
            }
        } catch (err) {
            // storage unavailable: defaults
        }
    }

    private savePrefs() {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify({ colors: this.colors, finger: this.fingerChoice, sizes: this.sizes }));
        } catch (err) {
            // storage unavailable: the choice lasts until the app closes
        }
    }

    get canUndo() {
        return this.undoStack.length > 0;
    }

    // ------------------------------------------------------------ data

    /** Load the notes for a score (`key` identifies the file). */
    open(key: string, mode: string) {
        clearTimeout(this.saveTimer);
        this.key = key;
        this.mode = mode;
        this.map = null; // the new score's layout comes with its timeline (setLayout)
        this.shown.clear();
        this.undoStack = [];
        this.gone = [];
        const read = (k: string): Stored | null => {
            try {
                const d = JSON.parse(localStorage.getItem(k) || "null");
                return d && d.v === 1 && d.modes ? d : null;
            } catch (err) {
                return null; // storage unavailable
            }
        };
        const saved = read(STORAGE_PREFIX + key) || { v: 1, modes: {} };
        this.savedJson = normalised(saved);
        // notes written but not saved (the app was closed) come back, still unsaved
        const draft = read(DRAFT_PREFIX + key);
        this.restoredDraft = !!draft && normalised(draft) !== this.savedJson;
        this.data = this.restoredDraft ? draft! : saved;
        this.onChange();
    }

    /** Changes since the last Save. */
    get dirty(): boolean {
        return !!this.key && normalised(this.data) !== this.savedJson;
    }

    /** Save: keep the notes for this score. Returns false if storage is full or blocked. */
    commit(): boolean {
        clearTimeout(this.saveTimer);
        const json = normalised(this.data);
        try {
            if (json === normalised({ v: 1, modes: {} })) {
                localStorage.removeItem(STORAGE_PREFIX + this.key);
            } else {
                localStorage.setItem(STORAGE_PREFIX + this.key, serialised(this.data)); // with the pins
            }
            localStorage.removeItem(DRAFT_PREFIX + this.key);
        } catch (err) {
            return false;
        }
        this.savedJson = json;
        this.restoredDraft = false;
        this.onChange();
        return true;
    }

    /** Don't save: forget the unsaved changes (call before opening another score). */
    discard() {
        clearTimeout(this.saveTimer);
        try {
            localStorage.removeItem(DRAFT_PREFIX + this.key);
        } catch (err) {
            // nothing kept
        }
    }

    setMode(mode: string) {
        this.mode = mode;
        this.map = null; // until the new layout's timeline comes (setLayout)
        this.shown.clear();
        this.undoStack = [];
        this.onChange();
    }

    /**
     * The current layout's timeline (after open or setMode, and again when the speed changes its
     * times): this layout's notes get pinned to the music, and the other layouts' are placed here.
     */
    setLayout(timeline: TimelinePoint[], speed: number, spatium: number, staves: SystemStaves[] = []) {
        this.map = new MusicMap(timeline, speed, spatium, staves);
        if (this.data.stale?.includes(this.mode)) {
            // the music was edited since these were placed: where they are comes from their pins now
            if (!this.map.empty) {
                this.placeFromPins();
                this.data.stale = this.data.stale.filter((m) => m !== this.mode);
                this.save();
            }
            this.placeOthers();
            this.renderAll();
            return;
        }
        // pin this layout's notes that have no pins yet, or pins from before staves or bars were known
        const old = (a: Anchor | null | undefined) => a === undefined
            || (!!a && ((this.map!.hasStaves && a.length < 5) || (this.map!.hasBars && a[5] == null)));
        for (const [page, p] of Object.entries(this.modeNotes())) {
            for (const st of p.strokes) {
                if (!st.a || st.a.some(old)) {
                    st.a = this.pin(Number(page), st.pts);
                }
            }
            for (const t of p.texts) {
                if (old(t.a)) {
                    t.a = this.map.anchor(Number(page), t.x, t.y);
                }
            }
        }
        this.placeOthers();
        this.renderAll();
    }

    /**
     * The music was edited (before the new layout's timeline comes with setLayout). Every pinned note
     * follows its bar and its staff, as a staff text does in desktop MuseScore: `was` and `now` are the
     * score's bars and staves before and after, by the engine's ids. Notes whose bars were deleted go
     * with them and come back if the deletion is undone. Where the notes are on the page is worked out
     * again from the pins, in this layout now and in the others when they are next shown: an edit that
     * adds or removes no bar can still move the music to another line.
     */
    musicChanged(was: ScoreAnchors, now: ScoreAnchors) {
        const map = this.map;
        const each = (fn: (mode: string, page: number, p: PageNotes) => void) => {
            for (const [mode, pages] of Object.entries(this.data.modes)) {
                for (const [pg, p] of Object.entries(pages)) {
                    fn(mode, Number(pg), p);
                }
            }
        };
        // pins from before bars were known get their bar from the layout as it was until now
        if (map?.hasBars) {
            each((_m, _pg, p) => {
                for (const st of p.strokes) {
                    st.a = st.a?.map((a) => (a && map.withBar(a)) || a);
                }
                for (const t of p.texts) {
                    t.a = (t.a && map.withBar(t.a)) || t.a;
                }
            });
        }
        if (!sameAnchors(was, now)) {
            const bar = barMover(was.bars, now.bars);
            const staff = staffMover(was.staves, now.staves);
            const nowAt = new Map<number, number>();
            now.bars.ids.forEach((id, i) => nowAt.set(id, i));
            // a pin after the edit: null when its bar was deleted; a pin with no bar is left as it is
            const moved = (a: Anchor): Anchor | null => {
                const out = a.slice() as Anchor;
                if (a[3] != null) {
                    const s = staff(a[3]);
                    out[3] = s;
                    out[4] = s === null ? null : a[4];
                }
                if (a[5] != null) {
                    const at = bar({ bar: a[5], f: a[6] ?? 0 });
                    if (!at) {
                        return null;
                    }
                    out[5] = at.bar;
                    out[6] = at.f;
                }
                return out;
            };
            const idsOf = (pins: (Anchor | null | undefined)[]) => pins.map((a) => (a && a[5] != null ? was.bars.ids[a[5]] ?? null : null));
            const leaving: Gone[] = [];
            each((mode, page, p) => {
                p.strokes = p.strokes.flatMap((st) => {
                    if (!st.a) {
                        return [st];
                    }
                    const after = st.a.map((a) => (a ? moved(a) : null));
                    const lost = st.a.map((a, i) => !!a && !after[i]);
                    if (!lost.some(Boolean)) {
                        st.a = after;
                        return [st];
                    }
                    leaving.push({ mode, page, kind: "stroke", item: JSON.parse(JSON.stringify(st)), ids: idsOf(st.a) });
                    if (st.a.every((a, i) => !a || lost[i])) {
                        return []; // every bar it was on is gone
                    }
                    // what is left of it: the points on bars that stayed
                    const keep = st.a.map((_a, i) => !lost[i]);
                    return [{ ...st, part: st.part ?? st.id, pts: st.pts.filter((_v, i) => keep[i >> 1]), a: after.filter((_a, i) => keep[i]) }];
                });
                p.texts = p.texts.filter((t) => {
                    if (!t.a) {
                        return true;
                    }
                    const after = moved(t.a);
                    if (!after) {
                        leaving.push({ mode, page, kind: "text", item: JSON.parse(JSON.stringify(t)), ids: idsOf([t.a]) });
                        return false;
                    }
                    t.a = after;
                    return true;
                });
            });
            // notes whose bars are back (the deletion was undone) come back whole, at the bars' new numbers
            this.gone = this.gone.filter((g) => {
                if (!g.ids.every((id) => id === null || nowAt.has(id))) {
                    return true;
                }
                const pins = g.kind === "stroke" ? (g.item as Stroke).a ?? [] : [(g.item as TextNote).a];
                pins.forEach((a, i) => {
                    if (a && g.ids[i] !== null) {
                        a[5] = nowAt.get(g.ids[i]!);
                    }
                });
                const p = this.pageNotes(g.page, g.mode);
                if (g.kind === "stroke") {
                    p.strokes = p.strokes.filter((st) => st.part !== g.item.id && st.id !== g.item.id);
                    for (const pages of Object.values(this.data.modes[g.mode] ?? {})) {
                        pages.strokes = pages.strokes.filter((st) => st.part !== g.item.id); // its pieces, wherever they went
                    }
                    p.strokes.push(g.item as Stroke);
                } else {
                    p.texts.push(g.item as TextNote);
                }
                return false;
            });
            this.gone.push(...leaving);
        }
        // every layout's page positions are from before the edit now
        const stale = Object.entries(this.data.modes)
            .filter(([, pages]) => Object.values(pages).some((p) => p.strokes.length || p.texts.length)).map(([m]) => m);
        if (!stale.length && !this.data.stale?.length) {
            return; // no notes on this score
        }
        this.data.stale = stale;
        this.undoStack = []; // its entries point at notes by where they were
        this.save();
    }

    // This layout's notes put where their pins are now (after the music was edited). A stroke whose
    // bars are now on two lines becomes a piece on each; a point with no pin of its own (off the end
    // of the music) keeps its distance from the nearest pinned point; a note with no pin at all (a
    // margin, the title) stays where it was written.
    private placeFromPins() {
        const map = this.map!;
        const out: ModeNotes = {};
        const on = (page: number) => (out[page] ||= { strokes: [], texts: [] });
        for (const [pg, p] of Object.entries(this.modeNotes())) {
            const page = Number(pg);
            for (const st of p.strokes) {
                const at = (st.a ?? []).map((a) => (a ? map.place(a) : null));
                if (!at.some(Boolean)) {
                    on(page).strokes.push(st);
                    continue;
                }
                const n = st.pts.length >> 1;
                interface Run { page: number; sys: string; pts: number[]; a: (Anchor | null)[] }
                const runs: Run[] = [];
                for (let i = 0; i < n; i++) {
                    let j = i; // the nearest point that has a place
                    for (let d = 0; !at[j] && d < n; d++) {
                        j = at[i - d] ? i - d : at[i + d] ? i + d : j;
                    }
                    const ref = at[j]!;
                    const x = ref.x + st.pts[2 * i] - st.pts[2 * j];
                    const y = ref.y + st.pts[2 * i + 1] - st.pts[2 * j + 1];
                    let run = runs[runs.length - 1];
                    if (!run || run.sys !== ref.sys) {
                        runs.push((run = { page: ref.page, sys: ref.sys, pts: [], a: [] }));
                    }
                    const a = at[i] ? st.a![i] : null;
                    if (a && at[i]) {
                        a[0] = at[i]!.t; // the moment it is at now, for versions that pin by time
                    }
                    run.pts.push(Math.round(x), Math.round(y));
                    run.a.push(a);
                }
                // where it already is, to the unit: left untouched, so an edit that moved nothing
                // changes nothing (pins round to a unit; Save must not light up for that)
                if (runs.length === 1 && runs[0].page === page && runs[0].pts.every((v, i) => Math.abs(v - st.pts[i]) <= 1)) {
                    st.a = runs[0].a;
                    on(page).strokes.push(st);
                    continue;
                }
                runs.forEach((r, k) => on(r.page).strokes.push(k === 0
                    ? { ...st, pts: r.pts, a: r.a }
                    : { ...st, id: newId(), pts: r.pts, a: r.a }));
            }
            for (const t of p.texts) {
                const at = t.a ? map.place(t.a) : null;
                if (at) {
                    if (at.page !== page || Math.abs(at.x - t.x) > 1 || Math.abs(at.y - t.y) > 1) {
                        t.x = at.x;
                        t.y = at.y;
                    }
                    t.a![0] = at.t;
                }
                on(at ? at.page : page).texts.push(t);
            }
        }
        this.data.modes[this.mode] = out;
    }

    // the music under each point of a stroke (undefined while the layout isn't known); the whole
    // stroke follows the staff nearest its middle, so it keeps its shape
    private pin(page: number, pts: number[]): (Anchor | null)[] | undefined {
        const map = this.map;
        if (!map || map.empty) {
            return undefined;
        }
        let top = Infinity;
        let bottom = -Infinity;
        for (let i = 1; i < pts.length; i += 2) {
            top = Math.min(top, pts[i]);
            bottom = Math.max(bottom, pts[i]);
        }
        const middle = (top + bottom) / 2;
        const a: (Anchor | null)[] = [];
        for (let i = 0; i + 1 < pts.length; i += 2) {
            a.push(map.anchor(page, pts[i], pts[i + 1], middle));
        }
        return a;
    }

    // The other layouts' notes, placed in this one by their pins
    private placeOthers() {
        this.shown.clear();
        const map = this.map;
        if (!map || map.empty) {
            return;
        }
        const on = (page: number) => {
            let s = this.shown.get(page);
            if (!s) {
                this.shown.set(page, (s = { strokes: [], texts: [] }));
            }
            return s;
        };
        for (const [mode, pages] of Object.entries(this.data.modes)) {
            if (mode === this.mode) {
                continue;
            }
            for (const [pg, p] of Object.entries(pages)) {
                const page = Number(pg);
                for (const st of p.strokes) {
                    // a run of pinned points on one page here makes a part; a point with no music,
                    // or one on another page here, ends it
                    const parts = new Map<number, number[][]>();
                    let run: number[] | null = null;
                    let runPage = -1;
                    for (const a of st.a ?? []) {
                        const at = a && map.place(a);
                        if (!at) {
                            run = null;
                            continue;
                        }
                        if (!run || at.page !== runPage) {
                            run = [];
                            runPage = at.page;
                            const list = parts.get(at.page) ?? [];
                            list.push(run);
                            parts.set(at.page, list);
                        }
                        run.push(at.x, at.y);
                    }
                    for (const [here, list] of parts) {
                        on(here).strokes.push({ mode, page, item: st, parts: list });
                    }
                }
                for (const t of p.texts) {
                    const at = t.a && map.place(t.a);
                    if (at) {
                        on(at.page).texts.push({ mode, page, item: t, x: at.x, y: at.y });
                    }
                }
            }
        }
    }

    private modeNotes(): ModeNotes {
        return (this.data.modes[this.mode] ||= {});
    }

    private pageNotes(page: number, mode = this.mode): PageNotes {
        return ((this.data.modes[mode] ||= {})[page] ||= { strokes: [], texts: [] });
    }

    /** All notes, in every layout (Clear removes them all). */
    get count(): number {
        let n = 0;
        for (const pages of Object.values(this.data.modes)) {
            for (const p of Object.values(pages)) {
                n += p.strokes.length + p.texts.length;
            }
        }
        return n;
    }

    // After every change: the notes stay unsaved until Save, but a draft is
    // kept so closing the app doesn't lose them.
    private save() {
        clearTimeout(this.saveTimer);
        this.draftDue = true;
        this.saveTimer = window.setTimeout(() => this.flush(), 300);
        this.onChange();
    }

    private draftDue = false;
    /** Write the draft now if a change is waiting for it (the app is being left). */
    flush() {
        clearTimeout(this.saveTimer);
        if (!this.draftDue || !this.key) {
            return;
        }
        this.draftDue = false;
        try {
            if (this.dirty) {
                localStorage.setItem(DRAFT_PREFIX + this.key, serialised(this.data));
            } else {
                localStorage.removeItem(DRAFT_PREFIX + this.key);
            }
        } catch (err) {
            this.onError("Your notes could not be kept on this device (storage is full or blocked). Tap Save to try again.");
        }
    }

    // ------------------------------------------------------------ tools

    setActive(on: boolean) {
        this.active = on;
        this.pagesEl.classList.toggle("annotating", on);
        for (const v of this.views.values()) {
            v.texts.querySelectorAll<HTMLElement>(".tbody").forEach((b) => (b.contentEditable = on ? editable : "false"));
        }
        if (!on) {
            this.deselect();
        }
        this.updateTouchMode();
    }

    setTool(tool: Tool) {
        this.tool = tool;
        this.pagesEl.dataset.tool = tool;
        this.lastTap = null;
        if (tool !== "text") {
            this.deselect();
        }
        this.updateTouchMode();
    }

    /** Finish editing a text box: it stops being highlighted and the keyboard closes. */
    deselect() {
        const a = document.activeElement as HTMLElement | null;
        if (a && a !== document.body && this.pagesEl.contains(a)) {
            a.blur();
        }
    }

    private get editingText(): HTMLElement | null {
        const a = document.activeElement as HTMLElement | null;
        return a && a.classList.contains("tbody") && this.pagesEl.contains(a) ? a : null;
    }

    get color() {
        return this.colors[this.tool];
    }

    /** The size choice for the current tool (index into SIZES[tool]); -1 for text. */
    get size() {
        return this.tool === "text" ? -1 : this.sizes[this.tool];
    }

    setSize(i: number) {
        if (this.tool !== "text") {
            this.sizes[this.tool] = i;
            this.savePrefs();
            this.onChange();
        }
    }

    setColor(c: string) {
        if (this.tool === "eraser") {
            return;
        }
        this.colors[this.tool] = c;
        this.savePrefs();
        // recolour the text box being edited, as a text editor would
        const body = this.tool === "text" ? this.editingText : null;
        const box = body?.closest<HTMLElement>(".tnote");
        const pageEl = box?.closest<HTMLElement>(".page");
        if (box && pageEl) {
            const t = this.pageNotes(Number(pageEl.dataset.index)).texts.find((n) => n.id === box.dataset.id);
            if (t) {
                t.color = c;
                box.style.color = c;
                this.save();
            }
        }
    }

    undo() {
        const u = this.undoStack.pop();
        if (!u) {
            return;
        }
        if (u.op === "restore") {
            this.data.modes = u.data;
        } else {
            const p = this.pageNotes(u.page, u.mode);
            const list = (u.kind === "stroke" ? p.strokes : p.texts) as { id: string }[];
            if (u.op === "add") {
                const i = list.findIndex((x) => x.id === u.item.id);
                if (i >= 0) {
                    list.splice(i, 1);
                }
            } else {
                list.push(u.item);
            }
        }
        this.placeOthers();
        this.renderAll();
        this.save();
    }

    /** Remove every note of this score, in every layout (undoable). */
    clear() {
        this.undoStack.push({ op: "restore", data: JSON.parse(JSON.stringify(this.data.modes)) });
        this.data.modes = {};
        this.placeOthers();
        this.renderAll();
        this.save();
    }

    // ------------------------------------------------------------ drawing on pages

    /** Called when a page element is (re)built. */
    attach(el: HTMLElement, index: number, w: number, h: number) {
        el.querySelectorAll(".ink, .texts").forEach((n) => n.remove());
        const svg = document.createElementNS(SVG, "svg");
        svg.setAttribute("class", "ink");
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("preserveAspectRatio", "none");
        const texts = document.createElement("div");
        texts.className = "texts";
        el.append(svg, texts);
        this.views.set(index, { el, svg, texts, w, h });
        this.renderPage(index);
    }

    detachAll() {
        this.views.clear();
    }

    private renderAll() {
        for (const i of this.views.keys()) {
            this.renderPage(i);
        }
    }

    private pxPerUnit(v: PageView) {
        return v.el.getBoundingClientRect().width / v.w || parseFloat(v.el.style.width) / v.w;
    }

    private renderPage(index: number) {
        const v = this.views.get(index);
        if (!v) {
            return;
        }
        const notes = this.modeNotes()[index] || { strokes: [], texts: [] };
        const others = this.shown.get(index) ?? { strokes: [], texts: [] };
        v.svg.replaceChildren();
        // highlighter under pen; this layout's notes and the others' alike
        const paths: [Stroke, SVGPathElement][] = notes.strokes.map((s) => [s, this.strokeEl(s)]);
        for (const o of others.strokes) {
            for (const part of o.parts) {
                const path = this.strokeEl({ ...o.item, pts: part });
                path.dataset.mode = o.mode;
                path.dataset.page = String(o.page);
                paths.push([o.item, path]);
            }
        }
        paths.sort((a, b) => Number(a[0].tool === "pen") - Number(b[0].tool === "pen"));
        for (const [, path] of paths) {
            v.svg.appendChild(path);
        }
        v.texts.replaceChildren();
        const ppu = parseFloat(v.el.style.width) / v.w;
        for (const t of notes.texts) {
            v.texts.appendChild(this.textEl(index, t, ppu));
        }
        for (const o of others.texts) {
            v.texts.appendChild(this.shownTextEl(index, o, ppu));
        }
    }

    // A text box from another layout: shown here, edited where it was written (the eraser removes it)
    private shownTextEl(page: number, o: ShownText, ppu: number): HTMLElement {
        const box = document.createElement("div");
        box.className = "tnote shown";
        box.dataset.id = o.item.id;
        box.dataset.mode = o.mode;
        box.dataset.page = String(o.page);
        box.style.left = (o.x / this.views.get(page)!.w * 100) + "%";
        box.style.top = (o.y / this.views.get(page)!.h * 100) + "%";
        box.style.color = o.item.color;
        box.style.fontSize = (o.item.size * ppu) + "px";
        const body = document.createElement("div");
        body.className = "tbody";
        body.textContent = o.item.text;
        box.append(body);
        return box;
    }

    private strokeEl(s: Stroke): SVGPathElement {
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("d", pathD(s.pts));
        path.setAttribute("stroke", s.color);
        path.setAttribute("stroke-width", String(s.width));
        path.setAttribute("class", s.tool);
        path.dataset.id = s.id;
        return path;
    }

    private textEl(page: number, t: TextNote, ppu: number): HTMLElement {
        const box = document.createElement("div");
        box.className = "tnote";
        box.dataset.id = t.id;
        box.style.left = (t.x / this.views.get(page)!.w * 100) + "%";
        box.style.top = (t.y / this.views.get(page)!.h * 100) + "%";
        box.style.color = t.color;
        box.style.fontSize = (t.size * ppu) + "px";

        const body = this.textBody(page, t, box);

        const del = document.createElement("button");
        del.className = "tdel";
        del.type = "button";
        del.setAttribute("aria-label", "Delete text");
        del.innerHTML = ICON_CLOSE;
        del.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            e.preventDefault(); // keep the text focused until the click lands
        });
        del.addEventListener("click", () => this.removeText(page, t, true));

        const grip = document.createElement("span");
        grip.className = "tgrip";
        grip.setAttribute("aria-label", "Move");
        grip.innerHTML = ICON_MOVE;
        grip.addEventListener("pointerdown", (e) => this.dragText(e, page, t, box));

        const corner = document.createElement("span");
        corner.className = "tsize";
        corner.setAttribute("aria-label", "Make the text bigger or smaller");
        corner.innerHTML = ICON_RESIZE;
        corner.addEventListener("pointerdown", (e) => this.resizeText(e, page, t, box));

        box.append(grip, body, del, corner);
        return box;
    }

    private textBody(page: number, t: TextNote, box: HTMLElement): HTMLElement {
        const body = document.createElement("div");
        body.className = "tbody";
        body.contentEditable = this.active ? editable : "false";
        body.spellcheck = false;
        // typed in code, so iPadOS has no typing to offer to undo on a shake (#30)
        const text = textField(body, t.text, (v) => {
            t.text = v;
            this.save();
        });
        // highlighted (frame, move and delete buttons) only while being edited
        body.addEventListener("focus", () => box.classList.add("sel"));
        body.addEventListener("blur", () => {
            box.classList.remove("sel");
            t.text = text().trim();
            if (!t.text) {
                this.removeText(page, t, false);
            }
            this.save();
        });
        return body;
    }

    // Drag the corner: the box grows or shrinks and the text with it
    private resizeText(e: PointerEvent, page: number, t: TextNote, box: HTMLElement) {
        e.preventDefault(); // also keeps the text focused
        e.stopPropagation();
        getSelection()?.removeAllRanges();
        const v = this.views.get(page)!;
        const handle = e.currentTarget as HTMLElement;
        handle.setPointerCapture(e.pointerId);
        const r = box.querySelector(".tbody")!.getBoundingClientRect();
        const start = { x: e.clientX, y: e.clientY, size: t.size, w: Math.max(20, r.width), h: Math.max(12, r.height) };
        const shown = () => parseFloat(v.el.style.width) / v.w; // CSS px per page unit as laid out
        const minSize = MIN_TEXT_PX / this.pxPerUnit(v);
        const move = (ev: PointerEvent) => {
            // both directions count, so a diagonal drag feels natural
            const s = ((start.w + ev.clientX - start.x) / start.w + (start.h + ev.clientY - start.y) / start.h) / 2;
            t.size = Math.round(Math.max(minSize, start.size * Math.min(8, Math.max(0.2, s))));
            box.style.fontSize = (t.size * shown()) + "px";
        };
        const end = (dropped: boolean) => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", cancel);
            if (!dropped) {
                t.size = start.size;
                box.style.fontSize = (t.size * shown()) + "px";
            }
            this.save();
        };
        const up = () => end(true);
        const cancel = () => end(false);
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", cancel);
    }

    private dragText(e: PointerEvent, page: number, t: TextNote, box: HTMLElement) {
        e.preventDefault(); // also keeps the text focused
        e.stopPropagation();
        const v = this.views.get(page)!;
        const grip = e.currentTarget as HTMLElement;
        grip.setPointerCapture(e.pointerId);
        const ppu = this.pxPerUnit(v);
        const start = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
        const place = () => {
            box.style.left = (t.x / v.w * 100) + "%";
            box.style.top = (t.y / v.h * 100) + "%";
        };
        const move = (ev: PointerEvent) => {
            t.x = Math.round(start.tx + (ev.clientX - start.x) / ppu);
            t.y = Math.round(start.ty + (ev.clientY - start.y) / ppu);
            place();
        };
        const end = (dropped: boolean) => {
            grip.removeEventListener("pointermove", move);
            grip.removeEventListener("pointerup", up);
            grip.removeEventListener("pointercancel", cancel);
            if (!dropped) {
                // the system took the gesture away: put the box back
                t.x = start.tx;
                t.y = start.ty;
                place();
            }
            if (this.map) {
                t.a = this.map.anchor(page, t.x, t.y); // moved: pinned where it is now
            }
            this.save();
        };
        const up = () => end(true);
        const cancel = () => end(false);
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", cancel);
    }

    private removeText(page: number, t: TextNote, undoable: boolean, mode = this.mode) {
        const p = this.pageNotes(page, mode);
        const i = p.texts.indexOf(t);
        if (i < 0) {
            return;
        }
        p.texts.splice(i, 1);
        if (mode !== this.mode) {
            // from another layout: shown here only
            this.undoStack.push({ op: "remove", mode, page, kind: "text", item: t });
            this.placeOthers();
            this.renderAll();
            this.save();
            return;
        }
        if (undoable && t.text) {
            this.undoStack.push({ op: "remove", mode, page, kind: "text", item: t });
        } else if (!undoable) {
            this.undoStack = this.undoStack.filter((u) => u.op === "restore" || u.item !== t);
        }
        this.views.get(page)?.texts.querySelector(`[data-id="${t.id}"]`)?.remove();
        this.save();
    }

    private pageAt(e: PointerEvent): { index: number; v: PageView } | null {
        const el = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
        if (!el) {
            return null;
        }
        const index = Number(el.dataset.index);
        const v = this.views.get(index);
        return v ? { index, v } : null;
    }

    private toUnits(v: PageView, e: { clientX: number; clientY: number }) {
        const r = v.el.getBoundingClientRect();
        return { x: Math.round((e.clientX - r.left) * v.w / r.width), y: Math.round((e.clientY - r.top) * v.h / r.height) };
    }

    private allowed(e: PointerEvent) {
        if (e.pointerType === "pen") {
            this.noteStylus();
            return true;
        }
        return e.pointerType === "mouse" || this.fingerDraws;
    }

    private onDown(e: PointerEvent) {
        this.lastPointerType = e.pointerType;
        if (!this.active) {
            return;
        }
        if (e.pointerType === "touch") {
            if (e.isPrimary) {
                // a new touch: forget fingers whose lifting was never seen (their
                // page was redrawn under them), or one finger would count as two
                this.touches.clear();
            }
            this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.touches.size > 1) {
                this.cancelStroke(); // two fingers: scroll and zoom instead
                return;
            }
        }
        const target = e.target as HTMLElement;
        if (target.closest(".tnote") && this.tool !== "eraser") {
            return; // editing or moving a text box
        }
        if (this.tool === "text") {
            this.tapStart = { id: e.pointerId, x: e.clientX, y: e.clientY };
            if (this.isSecondTap(e)) {
                // The second tap of a double tap makes a text box and focuses it.
                // A finger's tap is followed by emulated mouse events that move the
                // focus away again (and the empty box would be removed); cancelling
                // the pointerdown stops them.
                e.preventDefault();
            }
            return;
        }
        if (this.editingText) {
            this.deselect(); // a touch outside the text box finishes it
        }
        const hit = this.pageAt(e);
        if (!hit || !this.allowed(e)) {
            return;
        }
        e.preventDefault();
        this.pagesEl.setPointerCapture(e.pointerId);
        const { x, y } = this.toUnits(hit.v, e);
        if (this.tool === "eraser") {
            this.erasing = { pointerId: e.pointerId, page: hit.index };
            const box = target.closest<HTMLElement>(".tnote");
            if (box) {
                // this layout's text box, or one from another layout shown here
                const mode = box.dataset.mode ?? this.mode;
                const page = box.dataset.mode ? Number(box.dataset.page) : hit.index;
                const t = this.pageNotes(page, mode).texts.find((n) => n.id === box.dataset.id);
                if (t) {
                    this.removeText(page, t, true, mode);
                }
            }
            this.eraseAt(hit.index, hit.v, x, y);
            return;
        }
        const ppu = this.pxPerUnit(hit.v);
        const stroke: Stroke = {
            id: newId(),
            tool: this.tool,
            color: this.color,
            width: Math.max(1, Math.round(SIZES[this.tool as "pen" | "highlighter"][this.sizes[this.tool as "pen" | "highlighter"]] / ppu)),
            pts: [x, y],
        };
        const path = this.strokeEl(stroke);
        hit.v.svg.appendChild(path);
        this.drawing = { pointerId: e.pointerId, page: hit.index, stroke, path, lastX: e.clientX, lastY: e.clientY };
    }

    private onMove(e: PointerEvent) {
        if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
            this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }
        const d = this.drawing;
        if (d && d.pointerId === e.pointerId) {
            const v = this.views.get(d.page);
            if (!v) {
                return;
            }
            const events = e.getCoalescedEvents?.() || [e];
            for (const ev of events.length ? events : [e]) {
                if (Math.hypot(ev.clientX - d.lastX, ev.clientY - d.lastY) < 1.5) {
                    continue;
                }
                d.lastX = ev.clientX;
                d.lastY = ev.clientY;
                const { x, y } = this.toUnits(v, ev);
                d.stroke.pts.push(x, y);
            }
            d.path.setAttribute("d", pathD(d.stroke.pts));
            return;
        }
        const er = this.erasing;
        if (er && er.pointerId === e.pointerId) {
            const v = this.views.get(er.page);
            if (v) {
                const { x, y } = this.toUnits(v, e);
                this.eraseAt(er.page, v, x, y);
            }
        }
    }

    private onUp(e: PointerEvent) {
        this.touches.delete(e.pointerId);
        const d = this.drawing;
        if (d && d.pointerId === e.pointerId) {
            this.drawing = null;
            d.stroke.a = this.pin(d.page, d.stroke.pts);
            this.pageNotes(d.page).strokes.push(d.stroke);
            this.undoStack.push({ op: "add", mode: this.mode, page: d.page, kind: "stroke", item: d.stroke });
            this.save();
            return;
        }
        if (this.erasing && this.erasing.pointerId === e.pointerId) {
            this.erasing = null;
            return;
        }
        const tap = this.tapStart;
        this.tapStart = null;
        if (this.active && this.tool === "text" && tap && tap.id === e.pointerId
            && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10 && !(e.target as HTMLElement).closest(".tnote")) {
            this.onTextTap(e);
        }
    }

    private onCancel(e: PointerEvent) {
        this.touches.delete(e.pointerId);
        if (this.drawing?.pointerId === e.pointerId) {
            this.cancelStroke();
        }
        if (this.erasing?.pointerId === e.pointerId) {
            this.erasing = null;
        }
        if (this.tapStart?.id === e.pointerId) {
            this.tapStart = null;
        }
    }

    private cancelStroke() {
        this.drawing?.path.remove();
        this.drawing = null;
    }

    private eraseAt(page: number, v: PageView, x: number, y: number) {
        const p = this.pageNotes(page);
        const r = SIZES.eraser[this.sizes.eraser] / this.pxPerUnit(v);
        const touches = (pts: number[], width: number) => {
            const reach = r + width / 2;
            if (pts.length <= 2) {
                return Math.hypot(pts[0] - x, pts[1] - y) <= reach;
            }
            for (let i = 0; i + 3 < pts.length; i += 2) {
                if (segDist(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= reach) {
                    return true;
                }
            }
            return false;
        };
        const hit = p.strokes.filter((s) => touches(s.pts, s.width));
        // notes from other layouts, where they are shown here
        const hitOthers = (this.shown.get(page)?.strokes ?? []).filter((o) => o.parts.some((part) => touches(part, o.item.width)));
        if (!hit.length && !hitOthers.length) {
            return;
        }
        for (const s of hit) {
            p.strokes.splice(p.strokes.indexOf(s), 1);
            v.svg.querySelector(`[data-id="${s.id}"]`)?.remove();
            this.undoStack.push({ op: "remove", mode: this.mode, page, kind: "stroke", item: s });
        }
        for (const o of hitOthers) {
            const list = this.pageNotes(o.page, o.mode).strokes;
            if (list.includes(o.item)) {
                list.splice(list.indexOf(o.item), 1);
                this.undoStack.push({ op: "remove", mode: o.mode, page: o.page, kind: "stroke", item: o.item });
            }
        }
        if (hitOthers.length) {
            this.placeOthers();
            this.renderAll();
        }
        this.save();
    }

    // Text tool: one tap outside a text box finishes it, so the reader can go
    // on (scroll, switch tools); a double tap on the score adds a new box.
    private isSecondTap(e: PointerEvent) {
        const prev = this.lastTap;
        return !!prev && performance.now() - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30;
    }

    private onTextTap(e: PointerEvent) {
        const isDouble = this.isSecondTap(e);
        this.lastTap = isDouble ? null : { t: performance.now(), x: e.clientX, y: e.clientY };
        if (this.editingText) {
            this.deselect();
            return;
        }
        if (isDouble) {
            this.addTextAt(e);
        }
    }

    private addTextAt(e: PointerEvent) {
        const hit = this.pageAt(e);
        if (!hit) {
            return;
        }
        const { x, y } = this.toUnits(hit.v, e);
        const ppu = this.pxPerUnit(hit.v);
        const size = Math.round(TEXT_PX / ppu);
        // put the text's first line where the tap was
        const t: TextNote = { id: newId(), x, y: Math.round(y - size * 0.7), size, color: this.colors.text, text: "" };
        if (this.map) {
            t.a = this.map.anchor(hit.index, t.x, t.y);
        }
        this.pageNotes(hit.index).texts.push(t);
        this.undoStack.push({ op: "add", mode: this.mode, page: hit.index, kind: "text", item: t });
        const el = this.textEl(hit.index, t, parseFloat(hit.v.el.style.width) / hit.v.w);
        hit.v.texts.appendChild(el);
        const body = el.querySelector<HTMLElement>(".tbody")!;
        body.focus();
        this.onChange();
    }
}
