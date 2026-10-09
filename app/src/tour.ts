// A short guided tour of the controls (issue #15): one control at a time is ringed, with a card
// beside it saying what it does. Started from the ? button, or from the start screen's invitation
// for first-time users. Nothing starts by itself, so regular users are never interrupted.

export interface TourStep {
    target: () => HTMLElement | null;
    title: string;
    text: string;
}

const GAP = 12; // between the ringed control and the card
const EDGE = 12; // the card keeps clear of the screen's edges
const PAD = 6; // the ring stands a little outside the control

export class Tour {
    private steps: TourStep[] = [];
    private at = 0;
    private onEnd: () => void = () => {};
    private readonly title: HTMLElement;
    private readonly text: HTMLElement;
    private readonly count: HTMLElement;
    private readonly back: HTMLButtonElement;
    private readonly next: HTMLButtonElement;

    constructor(private root: HTMLElement, private ring: HTMLElement, private card: HTMLElement) {
        this.title = card.querySelector(".tour-title")!;
        this.text = card.querySelector(".tour-text")!;
        this.count = card.querySelector(".tour-count")!;
        this.back = card.querySelector(".tour-back")!;
        this.next = card.querySelector(".tour-next")!;
        this.back.onclick = () => this.show(this.at - 1);
        this.next.onclick = () => (this.at < this.steps.length - 1 ? this.show(this.at + 1) : this.end());
        card.querySelector<HTMLButtonElement>(".tour-skip")!.onclick = () => this.end();
        root.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                this.end();
            } else if (e.key === "ArrowRight" && this.at < this.steps.length - 1) {
                this.show(this.at + 1);
            } else if (e.key === "ArrowLeft" && this.at > 0) {
                this.show(this.at - 1);
            }
        });
        window.addEventListener("resize", () => this.open && this.show(this.at));
    }

    get open(): boolean {
        return !this.root.hidden;
    }

    /** Steps whose control isn't on screen (hidden in this layout) are left out. */
    start(steps: TourStep[], onEnd: () => void) {
        this.steps = steps.filter((s) => {
            const el = s.target();
            return !el || el.getClientRects().length > 0;
        });
        this.onEnd = onEnd;
        this.root.hidden = false;
        this.show(0);
    }

    /** Closes the tour; `onEnd` runs once. */
    end() {
        if (!this.open) {
            return;
        }
        this.root.hidden = true;
        const done = this.onEnd;
        this.onEnd = () => {};
        done();
    }

    private show(i: number) {
        this.at = Math.max(0, Math.min(i, this.steps.length - 1));
        const step = this.steps[this.at];
        this.title.textContent = step.title;
        this.text.textContent = step.text;
        this.count.textContent = `${this.at + 1} of ${this.steps.length}`;
        this.back.hidden = this.at === 0;
        this.next.textContent = this.at === this.steps.length - 1 ? "Done" : "Next";

        const el = step.target();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const card = this.card;
        card.style.left = card.style.top = "0px";
        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        if (!el) {
            this.ring.hidden = true;
            card.style.left = `${Math.round((vw - cw) / 2)}px`;
            card.style.top = `${Math.round((vh - ch) / 2)}px`;
        } else {
            const r = el.getBoundingClientRect();
            const top = Math.max(0, r.top - PAD);
            const left = Math.max(0, r.left - PAD);
            const bottom = Math.min(vh, r.bottom + PAD);
            const right = Math.min(vw, r.right + PAD);
            this.ring.hidden = false;
            this.ring.dataset.for = el.id; // which control it rings (tests)
            Object.assign(this.ring.style, {
                top: `${top}px`, left: `${left}px`, width: `${right - left}px`, height: `${bottom - top}px`,
            });
            // below the control if it fits, else above, else inside it near its bottom (a big area)
            let y: number;
            if (bottom + GAP + ch <= vh - EDGE) {
                y = bottom + GAP;
            } else if (top - GAP - ch >= EDGE) {
                y = top - GAP - ch;
            } else {
                y = Math.max(EDGE, bottom - ch - GAP * 2);
            }
            const x = Math.min(Math.max(EDGE, (left + right) / 2 - cw / 2), vw - cw - EDGE);
            card.style.left = `${Math.round(x)}px`;
            card.style.top = `${Math.round(y)}px`;
        }
        this.next.focus({ preventScroll: true });
    }
}
