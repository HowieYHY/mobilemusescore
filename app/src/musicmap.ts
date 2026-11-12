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

// secs, page, x, y, h, secs at 100% speed (engines from 16 Oct 2026; older ones: secs × speed), and the
// bar it is in (its number in the score, from 0) with how far through it, 0 to 1 (engines from 12 Nov 2026)
export type TimelinePoint = [number, number, number, number, number, number?, number?, number?];
export type SystemStaves = [number, number, [number, number, number][]]; // page, y, [staff, top, bottom]

/** A point pinned to the music: [seconds at 100% speed, x beyond the line's ends, fraction down the
 * system, staff number, distance below that staff's top line, bar, how far through the bar]. The bar
 * and the place in it are what the point follows when the music is edited (notepins.ts); the seconds
 * are what pins had before, kept for scores pinned by an older version. (Older pins have only the
 * first three, or five; a pin with a bar but no staff has nulls for the staff.) */
export type Anchor = [number, number, number, (number | null)?, (number | null)?, number?, number?];

interface System { page: number; y: number; h: number; xs: number[]; ts: number[]; bs: number[]; fs: number[] } // first playing, by x

export class MusicMap {
    private systems: System[] = [];
    private staves = new Map<string, [number, number, number][]>(); // by "page|y"
    private bars = new Map<number, [number, number]>(); // a bar's first playing: its points' first and last index in the timeline

    /** Whether the engine says which bar each point is in (an older build pins by the time only). */
    get hasBars() {
        return this.bars.size > 0;
    }

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
        timeline.forEach((p, i) => {
            if (p[6] === undefined || p[6] < 0) {
                return;
            }
            const run = this.bars.get(p[6]);
            if (!run) {
                this.bars.set(p[6], [i, i]);
            } else if (run[1] === i - 1) {
                run[1] = i; // (a later playing of the bar, after a repeat, is not next to the first)
            }
        });
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
            const bs: number[] = [];
            const fs: number[] = [];
            for (const p of pts) {
                if (xs.length && p[2] < xs[xs.length - 1]) {
                    break;
                }
                xs.push(p[2]);
                ts.push(this.at100(p));
                bs.push(p[6] ?? -1);
                fs.push(p[7] ?? 0);
            }
            this.systems.push({ page: pts[0][1], y: pts[0][3], h: pts[0][4], xs, ts, bs, fs });
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
        const { xs, ts, bs, fs } = best;
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
        const pin = (t: number, ox: number, k: number, part = 0): Anchor => {
            if (!this.hasBars || bs[k] < 0) {
                return staff ? [t, ox, fy, staff[0], Math.round(y - staff[1])] : [t, ox, fy];
            }
            // between two points: towards the next one in the same bar, or the bar's end (the next bar's first point)
            const to = k + 1 < bs.length && bs[k + 1] === bs[k] ? fs[k + 1] : 1;
            const f = Math.round((fs[k] + part * (to - fs[k])) * 100000) / 100000;
            return [t, ox, fy, staff ? staff[0] : null, staff ? Math.round(y - staff[1]) : null, bs[k], f];
        };
        const n = xs.length - 1;
        // a line's last point can be its closing barline, at the same moment as the next line's
        // first note: just before that moment, so the point stays on this line
        const last = Math.max(ts[0], ts[n] - 1e-4);
        if (x <= xs[0]) {
            return pin(ts[0], Math.round(x - xs[0]), 0);
        }
        if (x >= xs[n]) {
            return pin(last, Math.round(x - xs[n]), n);
        }
        let k = 0;
        while (k < n - 1 && xs[k + 1] <= x) {
            k++;
        }
        const f = xs[k + 1] > xs[k] ? (x - xs[k]) / (xs[k + 1] - xs[k]) : 0;
        const t = Math.min(ts[k] + f * (ts[k + 1] - ts[k]), k + 1 === n ? last : Infinity);
        return pin(Math.round(t * 10000) / 10000, 0, k, f);
    }

    // The timeline point at or before a time (at 100% speed, as pins are kept), and the next one
    private around(t: number): [TimelinePoint, TimelinePoint | undefined] {
        const tl = this.timeline;
        const T = (p: TimelinePoint) => this.at100(p);
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
        return [tl[lo], tl[lo + 1]];
    }

    /** A pin from before bars were known, with the bar under its moment added (null: nothing to add). */
    withBar(a: Anchor): Anchor | null {
        if (!this.hasBars || !this.timeline.length || a[5] != null) {
            return null;
        }
        const [p, q] = this.around(a[0]);
        if (p[6] === undefined || p[6] < 0) {
            return null;
        }
        const T = (pt: TimelinePoint) => this.at100(pt);
        const to = q && q[6] === p[6] ? q[7] ?? 1 : 1;
        const part = q && T(q) > T(p) && a[0] > T(p) ? Math.min(1, (a[0] - T(p)) / (T(q) - T(p))) : 0;
        const f = Math.round(((p[7] ?? 0) + part * (to - (p[7] ?? 0))) * 100000) / 100000;
        return [a[0], a[1], a[2], a[3] ?? null, a[4] ?? null, p[6], f];
    }

    // Where a pin's bar and place in it are in this layout (the bar's first playing)
    private placeInBar(a: Anchor): { page: number; x: number; y: number; sys: string; t: number } | null {
        const run = this.bars.get(a[5]!);
        if (!run) {
            return null; // a bar this layout doesn't play (or one that is gone)
        }
        const tl = this.timeline;
        const f = a[6] ?? 0;
        let i = run[0];
        while (i < run[1] && (tl[i + 1][7] ?? 0) <= f + 1e-9) {
            i++;
        }
        const p = tl[i];
        const q = tl[i + 1];
        let x = p[2];
        let t = this.at100(p);
        if (q && q[1] === p[1] && q[3] === p[3] && q[2] > p[2]) {
            const pf = p[7] ?? 0;
            const qf = q[6] === p[6] ? q[7] ?? 1 : 1;
            const part = qf > pf ? Math.max(0, Math.min(1, (f - pf) / (qf - pf))) : 0;
            x = p[2] + (q[2] - p[2]) * part;
            t += (this.at100(q) - t) * part;
        }
        const st = a[3] != null ? this.staves.get(`${p[1]}|${p[3]}`)?.find((s) => s[0] === a[3]) : undefined;
        const y = st && a[4] != null ? st[1] + a[4] : p[3] + a[2] * p[4];
        return { page: p[1], x: Math.round(x + a[1]), y: Math.round(y), sys: `${p[1]}|${p[3]}`, t: Math.round(t * 10000) / 10000 };
    }

    /** Where a pinned point is in this layout (`sys` names the line it is on, `t` its moment at 100% speed). */
    place(a: Anchor): { page: number; x: number; y: number; sys: string; t: number } | null {
        const tl = this.timeline;
        if (!tl.length) {
            return null;
        }
        if (a[5] != null && this.hasBars) {
            return this.placeInBar(a);
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
        const st = a[3] != null ? this.staves.get(`${p[1]}|${p[3]}`)?.find((s) => s[0] === a[3]) : undefined;
        const y = st && a[4] != null ? st[1] + a[4] : p[3] + a[2] * p[4];
        return { page: p[1], x: Math.round(x + a[1]), y: Math.round(y), sys: `${p[1]}|${p[3]}`, t };
    }
}
