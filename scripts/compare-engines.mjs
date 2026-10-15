// Compares two builds of the score engine on every test score: page drawings (every page, every
// view), timelines, staves, score info and 10 s of audio. For checking an engine change does only
// what it should. Each build is a folder with core/mscore.{mjs,wasm} and audio/msaudio.mjs.
// Usage: node scripts/compare-engines.mjs <old build> <new build> [folder]   (paths under the repo)
import fs from "node:fs";
import path from "node:path";
import { createNodeEngine, root } from "./lib/node-engine.mjs";

const [oldB, newB, dir = "real test musescores"] = process.argv.slice(2);
const scores = fs.readdirSync(path.join(root, dir)).filter((f) => /\.mscz$/i.test(f)).map((f) => path.join(root, dir, f));
const engines = [await createNodeEngine({ coreBuild: oldB }), await createNodeEngine({ coreBuild: newB })];
let diffs = 0;
for (const s of scores) {
    const out = engines.map((e) => {
        const info = e.load(s);
        const r = { info: JSON.stringify({ ...info, tracks: undefined }), pages: [], timeline: {}, staves: {} };
        for (const mode of ["page", "continuous_h", "continuous_v"]) {
            const si = JSON.parse(e.callStr("mss_set_view_mode", mode));
            for (let i = 0; i < si.pages.length; i++) r.pages.push(e.callStr("mss_render_page", i));
            // the first five values of each point (newer engines add the time at 100% speed)
            r.timeline[mode] = JSON.stringify(JSON.parse(e.callStr("mss_timeline")).map((pt) => pt.slice(0, 5)));
            r.staves[mode] = e.core._mss_staves ? e.callStr("mss_staves") : null;
        }
        e.callStr("mss_set_view_mode", "page");
        r.audio = e.render(10);
        r.bars = e.core._mss_bars ? e.callStr("mss_bars") : null;
        return r;
    });
    const [a, b] = out;
    const pagesSame = a.pages.length === b.pages.length && a.pages.every((p, i) => p === b.pages[i]);
    // the same drawing commands in another order (seen after other scores were opened in the same
    // engine: a few lyric hyphens); counted apart from real differences
    const sorted = (p) => JSON.parse(p).map((o) => JSON.stringify(o)).sort().join("|");
    const reordered = !pagesSame && a.pages.length === b.pages.length && a.pages.every((p, i) => p === b.pages[i] || sorted(p) === sorted(b.pages[i]));
    const tlSame = JSON.stringify(a.timeline) === JSON.stringify(b.timeline);
    const stSame = !a.staves.page || JSON.stringify(a.staves) === JSON.stringify(b.staves); // an old build may have no staff list
    let maxDiff = 0;
    for (let i = 0; i < Math.min(a.audio.length, b.audio.length); i++) maxDiff = Math.max(maxDiff, Math.abs(a.audio[i] - b.audio[i]));
    const same = (pagesSame || reordered) && tlSame && stSame && a.info === b.info && maxDiff === 0;
    if (!same) diffs++;
    console.log(`${same ? "same" : "DIFF"}  ${path.basename(s)}: ${a.pages.length} page drawings ${pagesSame ? "identical" : reordered ? "the same, some in another order" : "DIFFER"}, timelines ${tlSame ? "identical" : "differ"}, staves ${stSame ? "identical" : "differ"}, info ${a.info === b.info ? "identical" : "differs"}, audio max difference ${maxDiff}`);
    if (b.bars) {
        const j = JSON.parse(b.bars);
        console.log(`      bars 1-${j.bars.at(-1)?.[0]} (${j.bars.length}), sections: ${j.sections.map(([t, x, n]) => `${x} @bar ${n} ${t.toFixed(1)}s`).join(", ") || "none"}`);
    }
}
console.log(diffs ? `\n${diffs} score(s) differ` : "\nall identical");
