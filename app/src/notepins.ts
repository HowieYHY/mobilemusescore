// Where the reader's own notes go when the music is edited. A note is pinned to a bar and a place in
// it, as desktop MuseScore's staff texts are (a text belongs to a moment of its bar and to its staff:
// bars inserted before it carry it along, deleting its bar deletes it, a staff added above moves it
// down one; see Segment::annotations, Score::deleteMeasures and segment.cpp's setTrack(track ± VOICES)
// in third_party/musescore-4.7). Pins are kept by the bar's and the staff's number in the score, so
// after every edit they are renumbered: the engine gives each bar and staff an id that stays with it
// through edits, undo and redo (Session::anchorsJson), and this works out where each one is now.
// Plain functions, tested under Node (scripts/notepins-test.mjs).

/** The score's bars in order: the engine's id for each, and its length in ticks. */
export interface Bars { ids: number[]; ticks: number[] }
/** A place in the music: the bar's number in the score (from 0) and how far through it (0 to 1). */
export interface BarPos { bar: number; f: number }

/**
 * Where a place in the music is after an edit; null when its bar was deleted.
 * - A bar that is still there (same id): the same place in it, at its new number.
 * - Bars taken out with nothing put in their place: deleted, and what was pinned there goes with them.
 * - Bars taken out with new ones in their place (a new time signature writes the bars after it anew,
 *   with other lengths): the same distance in ticks from where the rewritten stretch starts, as
 *   desktop keeps a text at its tick through the rewrite (ScoreRange's annotations).
 */
export function barMover(old: Bars, now: Bars): (p: BarPos) => BarPos | null {
    const nowAt = new Map<number, number>();
    now.ids.forEach((id, i) => nowAt.set(id, i));
    const oldIds = new Set(old.ids);
    return (p) => {
        const id = old.ids[p.bar];
        if (id === undefined) {
            return null;
        }
        const direct = nowAt.get(id);
        if (direct !== undefined) {
            return { bar: direct, f: p.f };
        }
        // the stretch of bars that went, around this one: from `a` to `b` in the old score
        let a = p.bar;
        while (a > 0 && !nowAt.has(old.ids[a - 1])) {
            a--;
        }
        let b = p.bar;
        while (b + 1 < old.ids.length && !nowAt.has(old.ids[b + 1])) {
            b++;
        }
        // and what stands between its neighbours now
        const from = a > 0 ? nowAt.get(old.ids[a - 1])! + 1 : 0;
        const to = b + 1 < old.ids.length ? nowAt.get(old.ids[b + 1])! : now.ids.length;
        const fresh: number[] = [];
        for (let i = from; i < to; i++) {
            if (!oldIds.has(now.ids[i])) {
                fresh.push(i);
            }
        }
        if (!fresh.length) {
            return null; // deleted
        }
        let ticks = p.f * old.ticks[p.bar];
        for (let i = a; i < p.bar; i++) {
            ticks += old.ticks[i];
        }
        for (const i of fresh) {
            if (ticks < now.ticks[i] || i === fresh[fresh.length - 1]) {
                return { bar: i, f: now.ticks[i] > 0 ? Math.min(1, ticks / now.ticks[i]) : 0 };
            }
            ticks -= now.ticks[i];
        }
        return null;
    };
}

/** A staff's number after an edit (a line added above moves it down one); null when the staff is gone. */
export function staffMover(old: number[], now: number[]): (staff: number) => number | null {
    const nowAt = new Map<number, number>();
    now.forEach((id, i) => nowAt.set(id, i));
    return (staff) => nowAt.get(old[staff]) ?? null;
}

/** Whether an edit moved anything pinned: bars or staves added, removed or written anew. */
export function sameAnchors(a: { bars: Bars; staves: number[] }, b: { bars: Bars; staves: number[] }): boolean {
    return a.bars.ids.length === b.bars.ids.length && a.bars.ids.every((id, i) => id === b.bars.ids[i] && a.bars.ticks[i] === b.bars.ticks[i])
        && a.staves.length === b.staves.length && a.staves.every((id, i) => id === b.staves[i]);
}
