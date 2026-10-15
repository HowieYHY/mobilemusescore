// Where the music is in the current layout, from the playback timeline (Session::timelineJson):
// each point is a moment in the music (seconds) and where it is drawn (page, x, the top of its
// system and the system's height, in engraving units). Notes on the score are pinned to the music
// through it, so a note written in one view lands on the same music in the others: a point is kept
// as the moment under it (interpolated between the timeline's notes), how far beyond its line's
// first or last note it is, and its height: from the top of the staff nearest it (by the staff's
// number in the score, from Session::stavesJson), and as a fraction of the system for when that
// staff isn't shown in a layout. Staves are spread differently in each layout (page view fills the
// page, and hides empty staves), so a fraction of the system put a line under one staff's lyrics up
// to 7 staff spaces off in another view.

// secs, page, x, y, h, and secs at 100% speed (engines from 16 Oct 2026; older ones: secs × speed)
export type TimelinePoint = [number, number, number, number, number, number?];
export type SystemStaves = [number, number, [number, number, number][]]; // page, y, [staff, top, bottom]

/** A point pinned to the music: [seconds at 100% speed, x beyond the line's ends, fraction down the
 * system, staff number, distance below that staff's top line]. (Older pins have only the first three.) */
export type Anchor = [number, number, number, number?, number?];

interface System { page: number; y: number; h: number; xs: number[]; ts: number[] } // first playing, by x

export class MusicMap {
    private systems: System[] = [];
    private staves = new Map<string, [number, number, number][]>(); // by "page|y"

    /** Whether staff positions are known (an engine build without them pins to the system only). */
    get hasStaves() {
        return this.staves.size > 0;
    }

    /**
     * @param timeline the current layout's timeline, in played order (times only grow)
     * @param speed the playback speed it was made at (its times are divided by it)
     * @param spatium the staff space, for how far from a system a mark still belongs to it
     */
    constructor(private timeline: TimelinePoint[], private speed: number, private spatium: number, staves: SystemStaves[] = []) {
        for (const [page, y, list] of staves) {
            this.staves.set(`${page}|${y}`, list);
        }
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
                ts.push(this.at100(p));
            }
            this.systems.push({ page: pts[0][1], y: pts[0][3], h: pts[0][4], xs, ts });
        }
    }

    // A point's time at 100% speed. Not simply the time × the speed: pauses (fermatas, breath and
    // section-break pauses) keep their seconds at any speed, so at 50% a note pinned after one landed
    // up to 3 s of music off (16 Oct 2026). The engine reports it; older engines: × the speed.
    private at100(p: TimelinePoint) {
        return p[5] ?? p[0] * this.speed;
    }

    get empty() {
        return this.systems.length === 0;
    }

    /**
     * The music under a point of a page, or null when it is too far from any system (a margin, the
     * title). `refY` chooses the system and staff: a stroke's middle, so the whole stroke follows
     * one staff and keeps its shape (a circle between two staves came apart where they are spaced
     * differently).
     */
    anchor(page: number, x: number, y: number, refY = y): Anchor | null {
        let best: System | null = null;
        let bestDist = Infinity;
        for (const s of this.systems) {
            if (s.page !== page) {
                continue;
            }
            const d = refY < s.y ? s.y - refY : refY > s.y + s.h ? refY - (s.y + s.h) : 0;
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
        // the staff nearest the point, and how far below its top line
        let staff: [number, number, number] | null = null;
        let staffDist = Infinity;
        for (const st of this.staves.get(`${best.page}|${best.y}`) ?? []) {
            const d = refY < st[1] ? st[1] - refY : refY > st[2] ? refY - st[2] : 0;
            if (d < staffDist) {
                staffDist = d;
                staff = st;
            }
        }
        const pin = (t: number, ox: number): Anchor => staff ? [t, ox, fy, staff[0], Math.round(y - staff[1])] : [t, ox, fy];
        const n = xs.length - 1;
        // a line's last point can be its closing barline, at the same moment as the next line's
        // first note: just before that moment, so the point stays on this line
        const last = Math.max(ts[0], ts[n] - 1e-4);
        if (x <= xs[0]) {
            return pin(ts[0], Math.round(x - xs[0]));
        }
        if (x >= xs[n]) {
            return pin(last, Math.round(x - xs[n]));
        }
        let k = 0;
        while (k < n - 1 && xs[k + 1] <= x) {
            k++;
        }
        const f = xs[k + 1] > xs[k] ? (x - xs[k]) / (xs[k + 1] - xs[k]) : 0;
        const t = Math.min(ts[k] + f * (ts[k + 1] - ts[k]), k + 1 === n ? last : Infinity);
        return pin(Math.round(t * 10000) / 10000, 0);
    }

    /** Where a pinned point is in this layout. */
    place(a: Anchor): { page: number; x: number; y: number } | null {
        const tl = this.timeline;
        if (!tl.length) {
            return null;
        }
        // in times at 100% speed, as pins are kept
        const t = a[0];
        const T = (p: TimelinePoint) => this.at100(p);
        // the last point at or before t (times only grow, so the first playing comes first; of a
        // closing barline and the next line's first note, at the same moment, the note)
        let lo = 0;
        let hi = tl.length - 1;
        if (t < T(tl[0])) {
            hi = 0;
        }
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (T(tl[mid]) <= t + 1e-6) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        const p = tl[lo];
        const q = tl[lo + 1];
        let x = p[2];
        if (q && q[1] === p[1] && q[3] === p[3] && T(q) > T(p) && t > T(p)) {
            x = p[2] + (q[2] - p[2]) * Math.min(1, (t - T(p)) / (T(q) - T(p)));
        }
        // by its staff where this layout shows it, else by its place in the system
        const st = a[3] !== undefined ? this.staves.get(`${p[1]}|${p[3]}`)?.find((s) => s[0] === a[3]) : undefined;
        const y = st && a[4] !== undefined ? st[1] + a[4] : p[3] + a[2] * p[4];
        return { page: p[1], x: Math.round(x + a[1]), y: Math.round(y) };
    }
}
