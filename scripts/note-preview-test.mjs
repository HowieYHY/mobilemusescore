// Checks that tapping a note while stopped sounds it, as desktop MuseScore
// does when a note is selected, and that tapping empty space does not.
// Runs both engines in Node (see lib/node-engine.mjs).
// Usage: node scripts/note-preview-test.mjs [score.mscz]

import path from "node:path";
import { createNodeEngine, root } from "./lib/node-engine.mjs";

const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz"));
const eng = await createNodeEngine({ sampleRate: 48000 });
const score = eng.load(scorePath);
const sp = score.spatium;

let failures = 0;
const fail = (m) => {
    console.error("FAIL:", m);
    failures++;
};

const seekAt = (page, x, y, radius, play) => JSON.parse(eng.callStr("mss_seek_at", page, x, y, radius, play ? 1 : 0));
const rms = (secs) => {
    let sum = 0;
    let n = 0;
    for (let b = 0; b < Math.ceil(secs * eng.sampleRate / eng.block); b++) {
        const pcm = eng.renderBlock();
        for (let i = 0; i < pcm.length; i++) {
            sum += pcm[i] * pcm[i];
        }
        n += pcm.length;
    }
    return Math.sqrt(sum / n);
};
const db = (v) => (20 * Math.log10(Math.max(v, 1e-9))).toFixed(1) + " dB";

// let any start-up sound die away
rms(1);
const silence = rms(0.5);

// find a note: sweep down the staff at a beat from the score's timeline
const timeline = JSON.parse(eng.callStr("mss_timeline"));
let hit = null;
for (const [, page, x, y, h] of timeline.slice(4, 40)) {
    for (let yy = y; yy < y + h && !hit; yy += sp / 4) {
        const c = seekAt(page, x + sp * 1.2, yy, 0.5 * sp, false);
        if (c && c.note) {
            hit = { page, x: x + sp * 1.2, y: yy, secs: c.secs };
        }
    }
    if (hit) {
        break;
    }
}
if (!hit) {
    fail("no note found near the timeline points");
} else {
    console.log(`note found on page ${hit.page + 1} at ${hit.secs.toFixed(2)} s`);
    rms(0.5);
    const quiet = rms(0.3); // tapping without preview: still silent
    seekAt(hit.page, hit.x, hit.y, 0.5 * sp, true);
    const note = rms(0.6);
    rms(1.5); // the 500 ms note and its release end
    const after = rms(0.3);
    console.log(`silence ${db(silence)}, before ${db(quiet)}, tapped note ${db(note)}, after ${db(after)}`);
    if (note < 10 * Math.max(quiet, 1e-5)) {
        fail("the tapped note did not sound");
    }
    if (after > note / 10) {
        fail("the tapped note did not stop");
    }

    // empty space far from any note: moves, but no sound
    const c = seekAt(hit.page, 5, 5, 0.5 * sp, true);
    const empty = rms(0.6);
    console.log(`tap on empty margin: note=${!!(c && c.note)}, ${db(empty)}`);
    if ((c && c.note) || empty > note / 10) {
        fail("tapping empty space made a sound");
    }
}

console.log(failures ? `${failures} failure(s)` : "note preview checks passed");
process.exit(failures ? 1 : 0);
