// Where the music is in the current layout, from the playback timeline (Session::timelineJson):
// each point is a moment in the music (seconds) and where it is drawn (page, x, the top of its
// system and the system's height, in engraving units). Notes on the score are pinned to the music
// through it, so a note written in one view lands on the same music in the others: a point is kept
// as the moment under it (interpolated between the timeline's notes), how far beyond its line's
// first or last note it is, and its height as a fraction of the system's.

export type TimelinePoint = [number, number, number, number, number]; // secs, page, x, y, h

/** A point pinned to the music: [seconds at 100% speed, x beyond the line's ends, fraction down the system]. */
export type Anchor = [number, number, number];

interface System { page: number; y: number; h: number; xs: number[]; ts: number[] } // first playing, by x

export class MusicMap {
    private systems: System[] = [];

    /**
     * @param timeline the current layout's timeline, in played order (times only grow)
     * @param speed the playback speed it was made at (its times are divided by it)
     * @param spatium the staff space, for how far from a system a mark still belongs to it
     */
    constructor(private timeline: TimelinePoint[], private speed: number, private spatium: number) {
        const byKey = new Map<string, TimelinePoint[]>();
        for (const p of timeline) {
            const k = `${p[1]}|${p[3]}|${p[4]}`;
            let list = byKey.get(k);
            if (!list) {
                byKey.set(k, (list = []));
            }
            list.push(p);
        }
        for (const pts of byKey.values()) {
            // the system's first playing: from its earliest point while x keeps going right (a
            // repeat starts again further left; its second time has the same places)
            const xs: number[] = [];
            const ts: number[] = [];
            for (const p of pts) {
                if (xs.length && p[2] < xs[xs.length - 1]) {
                    break;
                }
                xs.push(p[2]);
                ts.push(p[0] * speed);
            }
            this.systems.push({ page: pts[0][1], y: pts[0][3], h: pts[0][4], xs, ts });
        }
    }

    get empty() {
        return this.systems.length === 0;
    }

    /** The music under a point of a page, or null when it is too far from any system (a margin, the title). */
    anchor(page: number, x: number, y: number): Anchor | null {
        let best: System | null = null;
        let bestDist = Infinity;
        for (const s of this.systems) {
            if (s.page !== page) {
                continue;
            }
            const d = y < s.y ? s.y - y : y > s.y + s.h ? y - (s.y + s.h) : 0;
            if (d < bestDist) {
                bestDist = d;
                best = s;
            }
        }
        // lyrics, dynamics and marks near the staves belong to the system; a title or the page's
        // margins don't (a fixed reach: a tall system's height let the top margin count)
        if (!best || bestDist > 6 * this.spatium) {
            return null;
        }
        const { xs, ts } = best;
        const fy = Math.round((y - best.y) / best.h * 10000) / 10000;
        const n = xs.length - 1;
        // a line's last point can be its closing barline, at the same moment as the next line's
        // first note: just before that moment, so the point stays on this line
        const last = Math.max(ts[0], ts[n] - 1e-4);
        if (x <= xs[0]) {
            return [ts[0], Math.round(x - xs[0]), fy];
        }
        if (x >= xs[n]) {
            return [last, Math.round(x - xs[n]), fy];
        }
        let k = 0;
        while (k < n - 1 && xs[k + 1] <= x) {
            k++;
        }
        const f = xs[k + 1] > xs[k] ? (x - xs[k]) / (xs[k + 1] - xs[k]) : 0;
        const t = Math.min(ts[k] + f * (ts[k + 1] - ts[k]), k + 1 === n ? last : Infinity);
        return [Math.round(t * 10000) / 10000, 0, fy];
    }

    /** Where a pinned point is in this layout. */
    place(a: Anchor): { page: number; x: number; y: number } | null {
        const tl = this.timeline;
        if (!tl.length) {
            return null;
        }
        const t = a[0] / this.speed;
        // the last point at or before t (times only grow, so the first playing comes first; of a
        // closing barline and the next line's first note, at the same moment, the note)
        let lo = 0;
        let hi = tl.length - 1;
        if (t < tl[0][0]) {
            hi = 0;
        }
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (tl[mid][0] <= t + 1e-6) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        const p = tl[lo];
        const q = tl[lo + 1];
        let x = p[2];
        if (q && q[1] === p[1] && q[3] === p[3] && q[0] > p[0] && t > p[0]) {
            x = p[2] + (q[2] - p[2]) * Math.min(1, (t - p[0]) / (q[0] - p[0]));
        }
        return { page: p[1], x: Math.round(x + a[1]), y: Math.round(p[3] + a[2] * p[4]) };
    }
}
