// Your own notes on the score: pen and highlighter ink and text boxes. Kept on
// this device, per score and per view mode, in page units so they stay put
// when zooming. A stylus always draws; a finger draws when "Draw with finger"
// is on (by default until a stylus is seen), and two fingers then scroll.

export type Tool = "pen" | "highlighter" | "text" | "eraser";

interface Stroke { id: string; tool: "pen" | "highlighter"; color: string; width: number; pts: number[] } // x,y,x,y… page units
interface TextNote { id: string; x: number; y: number; size: number; color: string; text: string }
interface PageNotes { strokes: Stroke[]; texts: TextNote[] }
type ModeNotes = Record<string, PageNotes>; // by page index
interface Stored { v: 1; modes: Record<string, ModeNotes> }

type Undo =
    | { op: "add" | "remove"; page: number; kind: "stroke"; item: Stroke }
    | { op: "add" | "remove"; page: number; kind: "text"; item: TextNote }
    | { op: "restore"; data: ModeNotes };

interface PageView { el: HTMLElement; svg: SVGSVGElement; texts: HTMLElement; w: number; h: number }

const SVG = "http://www.w3.org/2000/svg";
const STORAGE_PREFIX = "pocketscore.notes.";
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
    private views = new Map<number, PageView>();
    private undoStack: Undo[] = [];
    private saveTimer = 0;
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
            }
        } catch (err) {
            // storage unavailable: defaults
        }
    }

    private savePrefs() {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify({ colors: this.colors, finger: this.fingerChoice }));
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
        this.key = key;
        this.mode = mode;
        this.undoStack = [];
        this.data = { v: 1, modes: {} };
        try {
            const raw = localStorage.getItem(STORAGE_PREFIX + key);
            if (raw) {
                const d = JSON.parse(raw);
                if (d && d.v === 1 && d.modes) {
                    this.data = d;
                }
            }
        } catch (err) {
            // storage unavailable: notes last until the app closes
        }
        this.onChange();
    }

    setMode(mode: string) {
        this.mode = mode;
        this.undoStack = [];
        this.onChange();
    }

    private modeNotes(): ModeNotes {
        return (this.data.modes[this.mode] ||= {});
    }

    private pageNotes(page: number): PageNotes {
        return (this.modeNotes()[page] ||= { strokes: [], texts: [] });
    }

    get count(): number {
        let n = 0;
        for (const p of Object.values(this.modeNotes())) {
            n += p.strokes.length + p.texts.length;
        }
        return n;
    }

    private save() {
        clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            if (!this.key) {
                return;
            }
            // drop empty pages and modes
            for (const [m, pages] of Object.entries(this.data.modes)) {
                for (const [i, p] of Object.entries(pages)) {
                    if (!p.strokes.length && !p.texts.length) {
                        delete pages[i];
                    }
                }
                if (!Object.keys(pages).length) {
                    delete this.data.modes[m];
                }
            }
            try {
                if (Object.keys(this.data.modes).length) {
                    localStorage.setItem(STORAGE_PREFIX + this.key, JSON.stringify(this.data));
                } else {
                    localStorage.removeItem(STORAGE_PREFIX + this.key);
                }
            } catch (err) {
                this.onError("Your notes could not be saved on this device (storage is full or blocked).");
            }
        }, 300);
        this.onChange();
    }

    // ------------------------------------------------------------ tools

    setActive(on: boolean) {
        this.active = on;
        this.pagesEl.classList.toggle("annotating", on);
        for (const v of this.views.values()) {
            v.texts.querySelectorAll<HTMLElement>(".tbody").forEach((b) => (b.contentEditable = on ? "true" : "false"));
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
            this.data.modes[this.mode] = u.data;
            this.renderAll();
        } else {
            const p = this.pageNotes(u.page);
            const list = (u.kind === "stroke" ? p.strokes : p.texts) as { id: string }[];
            if (u.op === "add") {
                const i = list.findIndex((x) => x.id === u.item.id);
                if (i >= 0) {
                    list.splice(i, 1);
                }
            } else {
                list.push(u.item);
            }
            this.renderPage(u.page);
        }
        this.save();
    }

    clear() {
        this.undoStack.push({ op: "restore", data: JSON.parse(JSON.stringify(this.modeNotes())) });
        this.data.modes[this.mode] = {};
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
        v.svg.replaceChildren();
        // highlighter under pen
        for (const s of [...notes.strokes].sort((a, b) => Number(a.tool === "pen") - Number(b.tool === "pen"))) {
            v.svg.appendChild(this.strokeEl(s));
        }
        v.texts.replaceChildren();
        const ppu = parseFloat(v.el.style.width) / v.w;
        for (const t of notes.texts) {
            v.texts.appendChild(this.textEl(index, t, ppu));
        }
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

        const body = document.createElement("div");
        body.className = "tbody";
        body.textContent = t.text;
        body.contentEditable = this.active ? "true" : "false";
        body.spellcheck = false;
        // highlighted (frame, move and delete buttons) only while being edited
        body.addEventListener("focus", () => box.classList.add("sel"));
        body.addEventListener("input", () => {
            t.text = body.innerText;
            this.save();
        });
        body.addEventListener("blur", () => {
            box.classList.remove("sel");
            t.text = body.innerText.trim();
            if (!t.text) {
                this.removeText(page, t, false);
            }
            this.save();
        });

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

        box.append(grip, body, del);
        return box;
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
            this.save();
        };
        const up = () => end(true);
        const cancel = () => end(false);
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", cancel);
    }

    private removeText(page: number, t: TextNote, undoable: boolean) {
        const p = this.pageNotes(page);
        const i = p.texts.indexOf(t);
        if (i < 0) {
            return;
        }
        p.texts.splice(i, 1);
        if (undoable && t.text) {
            this.undoStack.push({ op: "remove", page, kind: "text", item: t });
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
            if (target.closest(".tnote")) {
                const id = (target.closest(".tnote") as HTMLElement).dataset.id;
                const t = this.pageNotes(hit.index).texts.find((n) => n.id === id);
                if (t) {
                    this.removeText(hit.index, t, true);
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
            width: Math.round((this.tool === "highlighter" ? 14 : 2.4) / ppu),
            pts: [x, y],
        };
        const path = this.strokeEl(stroke);
        hit.v.svg.appendChild(path);
        this.drawing = { pointerId: e.pointerId, page: hit.index, stroke, path, lastX: e.clientX, lastY: e.clientY };
    }

    private onMove(e: PointerEvent) {
        if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
            const prev = this.touches.get(e.pointerId)!;
            if (this.active && this.touches.size === 2 && !this.drawing && this.pagesEl.classList.contains("finger-draw")) {
                // two-finger scroll while fingers draw (the page can't scroll by itself then)
                this.viewer.scrollLeft -= (e.clientX - prev.x) / 2;
                this.viewer.scrollTop -= (e.clientY - prev.y) / 2;
            }
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
            this.pageNotes(d.page).strokes.push(d.stroke);
            this.undoStack.push({ op: "add", page: d.page, kind: "stroke", item: d.stroke });
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
        const r = 10 / this.pxPerUnit(v);
        const hit = p.strokes.filter((s) => {
            const pts = s.pts;
            const reach = r + s.width / 2;
            if (pts.length <= 2) {
                return Math.hypot(pts[0] - x, pts[1] - y) <= reach;
            }
            for (let i = 0; i + 3 < pts.length; i += 2) {
                if (segDist(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= reach) {
                    return true;
                }
            }
            return false;
        });
        if (!hit.length) {
            return;
        }
        for (const s of hit) {
            p.strokes.splice(p.strokes.indexOf(s), 1);
            v.svg.querySelector(`[data-id="${s.id}"]`)?.remove();
            this.undoStack.push({ op: "remove", page, kind: "stroke", item: s });
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
        const size = Math.round(16 / ppu);
        // put the text's first line where the tap was
        const t: TextNote = { id: newId(), x, y: Math.round(y - size * 0.7), size, color: this.colors.text, text: "" };
        this.pageNotes(hit.index).texts.push(t);
        this.undoStack.push({ op: "add", page: hit.index, kind: "text", item: t });
        const el = this.textEl(hit.index, t, parseFloat(hit.v.el.style.width) / hit.v.w);
        hit.v.texts.appendChild(el);
        const body = el.querySelector<HTMLElement>(".tbody")!;
        body.focus();
        this.onChange();
    }
}
