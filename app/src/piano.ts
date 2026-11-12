import "./piano.css";

export interface PianoOptions {
    low?: number;
    high?: number;
    onKey: (midi: number) => void;
}

const names = ["C", "C sharp", "D", "D sharp", "E", "F", "F sharp", "G", "G sharp", "A", "A sharp", "B"];
const black = (midi: number) => names[midi % 12].includes("sharp");

export class PianoStrip {
    readonly el: HTMLElement;
    private keys = new Map<number, HTMLButtonElement>();
    private pending: { midi: number; smooth: boolean; force: boolean } | null = null;

    constructor(host: HTMLElement, opts: PianoOptions) {
        const low = opts.low ?? 21;
        const high = opts.high ?? 108;
        if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high > 127 || low > high) {
            throw new RangeError("Piano pitches must be an ordered MIDI range (0 to 127)");
        }
        this.el = document.createElement("div");
        this.el.className = "piano-strip";
        this.el.setAttribute("role", "group");
        this.el.setAttribute("aria-label", "Piano");
        const row = document.createElement("div");
        row.className = "piano-keys";
        this.el.append(row);
        // A range starting on a black key still needs room on its left for the overhang.
        let whites = black(low) ? 1 : 0;
        if (whites) {
            const space = document.createElement("span");
            space.className = "piano-space";
            row.append(space);
        }
        for (let midi = low; midi <= high; midi++) {
            const key = document.createElement("button");
            const isBlack = black(midi);
            const octave = Math.floor(midi / 12) - 1;
            key.type = "button";
            key.className = "piano-key " + (isBlack ? "piano-black" : "piano-white");
            key.dataset.midi = String(midi);
            key.setAttribute("aria-label", names[midi % 12] + (isBlack ? " " : "") + octave);
            key.setAttribute("aria-pressed", "false");
            if (isBlack) {
                key.style.left = `calc(${whites} * var(--piano-w))`;
            } else {
                whites++;
                const tag = document.createElement("span");
                tag.className = "piano-tag";
                tag.textContent = names[midi % 12] + octave;
                if (midi % 12 === 0) tag.classList.add("piano-c");
                key.append(tag);
            }
            key.addEventListener("click", () => {
                if (!key.disabled) opts.onKey(midi);
            });
            key.addEventListener("pointerdown", (e) => {
                if (!key.disabled && e.button === 0) key.classList.add("pressed");
            });
            for (const event of ["pointerup", "pointerleave", "pointercancel", "lostpointercapture"]) {
                key.addEventListener(event, () => key.classList.remove("pressed"));
            }
            this.keys.set(midi, key);
            row.append(key);
        }
        if (black(high)) {
            const space = document.createElement("span");
            space.className = "piano-space";
            row.append(space);
        }
        host.append(this.el);
        // Edit can open while its host is hidden; keep the latest request until it has a width.
        const observer = new ResizeObserver(() => this.applyCenter());
        observer.observe(this.el);
        this.centerOn(Math.max(low, Math.min(high, 60)), false, true);
    }

    setLit(midis: number[]): void {
        const lit = new Set(midis);
        for (const [midi, key] of this.keys) {
            key.classList.toggle("lit", lit.has(midi));
            key.setAttribute("aria-pressed", String(lit.has(midi)));
        }
    }

    centerOn(midi: number, smooth = false, force = false): void {
        if (!this.keys.has(midi)) return;
        this.pending = { midi, smooth, force };
        this.applyCenter();
    }

    private applyCenter(): void {
        if (!this.pending || !this.el.clientWidth) return;
        const { midi, smooth, force } = this.pending;
        this.pending = null;
        const key = this.keys.get(midi)!;
        const view = this.el.getBoundingClientRect();
        const box = key.getBoundingClientRect();
        if (!force && box.left >= view.left && box.right <= view.left + this.el.clientWidth) return;
        this.el.scrollTo({
            left: this.el.scrollLeft + box.left + box.width / 2 - view.left - this.el.clientWidth / 2,
            behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant",
        });
    }

    setDisabled(off: boolean): void {
        for (const key of this.keys.values()) {
            key.disabled = off;
            if (off) key.classList.remove("pressed");
        }
    }
}
