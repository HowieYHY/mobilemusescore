// The Back button's bookkeeping (app/src/layers.ts): one history entry per open panel, whatever order
// panels are opened, closed, swapped or replaced in, and however late the browser's popstates arrive.
// Runs the real code under Node against a stand-in for the browser's history, where going back happens
// later (as in a browser) and the test decides when. No browser needed.
// Bug hunt, finding 16: closing a panel that was not the top one (the Mixer under a part's sound list),
// or one panel replacing two, left a spare entry, so Back did nothing once before leaving the app.
//   node scripts/layers-test.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { makeLayers } = await import(pathToFileURL(path.join(root, "app/src/layers.ts")).href);

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

// A browser's history, as far as the app uses it: pushState is immediate, going back is a task that
// runs later and then fires popstate. `depth` is how many of the app's entries a Back press would meet.
function world() {
    let index = 0;
    let top = 0;
    const tasks = [];
    let pop = () => {};
    const history = {
        pushState() { index++; top = index; },
        go(delta) {
            tasks.push(() => {
                const to = Math.max(0, index + delta);
                if (to !== index) {
                    index = to;
                    pop();
                }
            });
        },
    };
    const L = makeLayers(history, (h) => (pop = h));
    const open = new Set();
    const panel = (name, onClose) => {
        const close = () => { open.delete(name); onClose?.(); };
        close.panel = name;
        return close;
    };
    return {
        L, open, panel,
        get depth() { return index; },
        get waiting() { return tasks.length; },
        userBack: () => history.go(-1),
        // let the browser carry out `n` of the traversals asked for so far (all of them by default)
        async pump(n = Infinity) {
            await null; // what the app queued for the end of its own turn
            for (; n > 0 && tasks.length; n--) {
                tasks.shift()();
                await null;
            }
        },
        show(close) { open.add(close.panel); },
    };
}
const names = (w) => w.L.layers.map((c) => c.panel).join(",") || "none";
const even = (w) => w.depth === w.L.layers.length && w.open.size === w.L.layers.length && w.L.layers.every((c) => w.open.has(c.panel));
const state = (w) => `${w.depth} Back ${w.depth === 1 ? "entry" : "entries"}, panels: ${names(w)}`;

// ---- the cases from the app

// the Mixer with a part's sound list open on it; the Mixer's own close also closes the list
function mixerWorld() {
    const w = world();
    const sounds = w.panel("sounds");
    const mixer = w.panel("mixer", () => { if (w.open.has("sounds")) { w.L.closeLayer(sounds); } });
    const speed = w.panel("speed");
    const settings = w.panel("settings");
    const sheets = [sounds, mixer, speed, settings];
    const sheet = (c) => { w.show(c); w.L.openSheet(c, sheets.filter((o) => o !== c)); };
    return { w, sounds, mixer, speed, settings, sheet };
}
{
    const { w, sounds, mixer, sheet } = mixerWorld();
    sheet(mixer);
    w.show(sounds); w.L.openLayer(sounds);
    await w.pump();
    check(w.depth === 2 && even(w), `Mixer, then a sound list: ${state(w)}`);
    w.L.closeLayer(mixer); // the Mixer button, or its ✕
    await w.pump();
    check(w.depth === 0 && even(w), `closing the Mixer under the sound list leaves nothing behind: ${state(w)}`);
}
{
    const { w, sounds, mixer, speed, sheet } = mixerWorld();
    sheet(mixer);
    w.show(sounds); w.L.openLayer(sounds);
    await w.pump();
    sheet(speed); // Speed while the Mixer and its sound list are open
    await w.pump();
    check(w.depth === 1 && even(w), `Speed in place of the Mixer and its sound list: ${state(w)}`);
    w.L.closeLayer(speed);
    await w.pump();
    check(w.depth === 0 && even(w), `and closed again: ${state(w)}`);
}
{
    const { w, mixer, speed, settings, sheet } = mixerWorld();
    sheet(mixer);
    await w.pump();
    sheet(speed);
    sheet(settings);
    await w.pump();
    check(w.depth === 1 && even(w), `one sheet in place of another, twice: ${state(w)}`);
    w.userBack();
    await w.pump();
    check(w.depth === 0 && even(w), `the phone's Back closes it: ${state(w)}`);
}
// Notes with the colour palette, then Edit takes Notes' place (the 4 Nov 2026 case), all before any popstate
{
    const w = world();
    const palette = w.panel("palette");
    const notes = w.panel("notes", () => { if (w.open.has("palette")) { w.L.closeLayer(palette); } });
    const edit = w.panel("edit");
    w.show(notes); w.L.openLayer(notes);
    w.show(palette); w.L.openLayer(palette);
    await w.pump();
    w.L.closeLayer(palette); // the tap-away
    w.L.swapLayer(notes, edit); w.open.delete("notes"); w.show(edit);
    await w.pump();
    check(w.depth === 1 && names(w) === "edit" && even(w), `Edit in Notes with the palette open: ${state(w)}`);
    w.userBack();
    await w.pump();
    check(w.depth === 0 && even(w), `Back closes Edit and nothing is left: ${state(w)}`);
}
// a panel closed and another opened before the browser has gone back
{
    const w = world();
    const a = w.panel("a");
    const b = w.panel("b");
    w.show(a); w.L.openLayer(a);
    await w.pump();
    w.L.closeLayer(a);
    w.show(b); w.L.openLayer(b);
    check(w.open.has("b") && !w.open.has("a"), "closed at once, without waiting for the browser");
    await w.pump();
    check(w.depth === 1 && names(w) === "b" && even(w), `a closed and b opened in one go: ${state(w)}`);
    w.L.closeLayer(b);
    await w.pump();
    check(w.depth === 0 && even(w), `then b closed: ${state(w)}`);
}
// every panel closed at once (a score that could not be opened goes back to the start screen)
{
    const w = world();
    const ps = ["a", "b", "c", "d"].map((n) => w.panel(n));
    for (const p of ps) { w.show(p); w.L.openLayer(p); }
    await w.pump();
    while (w.L.layers.length) {
        w.L.closeLayer(w.L.layers[w.L.layers.length - 1]);
    }
    await w.pump();
    check(w.depth === 0 && even(w), `four panels closed at once: ${state(w)}`);
}

// ---- anything, in any order: 3000 random runs of opening, closing (top or not), replacing, swapping and
// the phone's Back, with the browser going back at random moments. Whenever the browser has caught up,
// there is one Back entry per open panel. (The phone's Back is pressed only when the browser has caught
// up: a press that crosses one of the app's own is not told apart from it, by this code or any.)
let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
let bad = null;
for (let run = 0; run < 3000 && !bad; run++) {
    const w = world();
    const ps = ["a", "b", "c", "d", "e"].map((n) => w.panel(n));
    const log = [];
    for (let step = 0; step < 14 && !bad; step++) {
        const p = ps[rnd(ps.length)];
        const isOpen = w.open.has(p.panel);
        const op = rnd(6);
        if (op === 0 && !isOpen) {
            log.push("open " + p.panel); w.show(p); w.L.openLayer(p);
        } else if (op === 1 && isOpen) {
            log.push("close " + p.panel); w.L.closeLayer(p);
        } else if (op === 2 && !isOpen) {
            log.push("sheet " + p.panel); w.show(p); w.L.openSheet(p, ps.slice(0, 3).filter((o) => o !== p));
        } else if (op === 3 && !isOpen) {
            const from = ps.find((o) => w.open.has(o.panel));
            if (from) {
                log.push(`swap ${from.panel}>${p.panel}`); w.L.swapLayer(from, p); w.open.delete(from.panel); w.show(p);
            }
        } else if (op === 4) {
            await w.pump();
            if (w.depth > 0) {
                log.push("Back"); w.userBack(); await w.pump();
            }
        } else if (op === 5) {
            log.push("browser"); await w.pump(1 + rnd(2));
        }
        if (rnd(3) === 0) {
            await w.pump();
            if (!even(w)) {
                bad = `${log.join(", ")}: ${state(w)}`;
            }
        }
    }
    await w.pump();
    if (!bad && !even(w)) {
        bad = `${log.join(", ")}: ${state(w)}`;
    }
}
check(!bad, bad ? `random run went wrong after: ${bad}` : "3000 random runs: always one Back entry per open panel");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
