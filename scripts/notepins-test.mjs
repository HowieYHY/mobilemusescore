// Where a note pinned to the music goes when bars are inserted, deleted or written anew
// (app/src/notepins.ts), under Node: no browser, no engine. The rules are desktop MuseScore's for a
// staff text: it belongs to its bar, so it travels with it, goes when the bar is deleted, comes back
// with it on undo, and keeps its tick when a new time signature rewrites the bars.
//   node scripts/notepins-test.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { barMover, staffMover, sameAnchors } = await import(pathToFileURL(path.join(root, "app/src/notepins.ts")).href);

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };
const bars = (ids, ticks = 1920) => ({ ids, ticks: ids.map((_, i) => (Array.isArray(ticks) ? ticks[i] : ticks)) });
const show = (p) => (p ? `bar ${p.bar + 1} at ${Math.round(p.f * 1000) / 1000}` : "gone");
const is = (p, bar, f) => !!p && p.bar === bar && Math.abs(p.f - f) < 1e-9;

// eight bars of 4/4, ids 1 to 8
const before = bars([1, 2, 3, 4, 5, 6, 7, 8]);

{
    const move = barMover(before, bars([1, 2, 21, 22, 3, 4, 5, 6, 7, 8])); // two bars inserted before bar 3
    check(is(move({ bar: 4, f: 0.5 }), 6, 0.5), `two bars inserted before it: bar 5 is bar 7 now (${show(move({ bar: 4, f: 0.5 }))})`);
    check(is(move({ bar: 1, f: 0.25 }), 1, 0.25), `a note before the new bars stays (${show(move({ bar: 1, f: 0.25 }))})`);
}
{
    const after = bars([1, 2, 3, 6, 7, 8]); // bars 4 and 5 deleted
    const move = barMover(before, after);
    check(move({ bar: 3, f: 0.5 }) === null && move({ bar: 4, f: 0 }) === null, "its bar deleted: the note goes with it");
    check(is(move({ bar: 5, f: 0.75 }), 3, 0.75), `a note after the deleted bars moves up (${show(move({ bar: 5, f: 0.75 }))})`);
    const back = barMover(after, before); // undo: the same bars come back, with their ids
    check(is(back({ bar: 3, f: 0.75 }), 5, 0.75), `undo: it is back in bar 6 (${show(back({ bar: 3, f: 0.75 }))})`);
}
{
    const move = barMover(before, bars([1, 2, 3, 4, 5, 6])); // the last two bars deleted
    check(move({ bar: 7, f: 0.1 }) === null && is(move({ bar: 5, f: 1 }), 5, 1), "the last bars deleted: their notes go, the others stay");
    const first = barMover(before, bars([3, 4, 5, 6, 7, 8])); // the first two deleted
    check(first({ bar: 0, f: 0 }) === null && is(first({ bar: 2, f: 0 }), 0, 0), "the first bars deleted: bar 3 is bar 1 now");
}
{
    // 3/4 from bar 5 on: bars 5 to 8 (4 x 1920 ticks) are written anew as 3/4 bars (1440 ticks), 6 of them
    const after = { ids: [1, 2, 3, 4, 31, 32, 33, 34, 35, 36], ticks: [1920, 1920, 1920, 1920, 1440, 1440, 1440, 1440, 1440, 1440] };
    const move = barMover(before, after);
    const p = move({ bar: 5, f: 0.5 }); // bar 6, beat 3: 1920 + 960 = 2880 ticks into the stretch = two 3/4 bars exactly
    check(is(p, 6, 0), `a new time signature: the note keeps its tick (bar 6 beat 3 is ${show(p)})`);
    check(is(move({ bar: 4, f: 0 }), 4, 0), "the first note of the rewritten stretch stays at its start");
    // the old stretch's end, 7680 ticks in, is a third into the sixth 3/4 bar (the rewrite pads the last one with rests)
    check(is(move({ bar: 7, f: 1 }), 9, 480 / 1440), `the end of the old last bar keeps its tick too (${show(move({ bar: 7, f: 1 }))})`);
    check(is(move({ bar: 2, f: 0.5 }), 2, 0.5), "bars before the time signature are untouched");
    // the rewritten stretch shorter than what was pinned in it: held at its end, not lost
    const short = barMover(before, { ids: [1, 2, 3, 4, 41], ticks: [1920, 1920, 1920, 1920, 1920] });
    check(is(short({ bar: 7, f: 0.5 }), 4, 1), `past the end of a shorter rewritten stretch: at its end (${show(short({ bar: 7, f: 0.5 }))})`);
}
{
    // bars deleted and others inserted elsewhere in one go (an undo that crosses two edits is two steps, but be safe)
    const move = barMover(before, bars([1, 51, 2, 3, 4, 7, 8]));
    check(move({ bar: 4, f: 0 }) === null && is(move({ bar: 6, f: 0 }), 5, 0) && is(move({ bar: 1, f: 0 }), 2, 0),
        "a bar inserted early and two deleted later: each note by its own bar");
}
{
    const move = staffMover([10, 11, 12], [10, 99, 11, 12]); // a line added under the first
    check(move(0) === 0 && move(1) === 2 && move(2) === 3, "a line added above: the notes' staves move down one");
    const gone = staffMover([10, 11, 12], [10, 12]);
    check(gone(1) === null && gone(2) === 1, "a staff removed: its notes have no staff, those below move up");
}
{
    const a = { bars: before, staves: [10, 11] };
    check(sameAnchors(a, { bars: bars([1, 2, 3, 4, 5, 6, 7, 8]), staves: [10, 11] }), "an edit that changes no bar or staff moves nothing");
    check(!sameAnchors(a, { bars: bars([1, 2, 3, 4, 5, 6, 7]), staves: [10, 11] }) && !sameAnchors(a, { bars: before, staves: [10] }),
        "a bar or a staff fewer is noticed");
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
