// Composer spike: can the engine add a note, undo, and save a .mscz that loads again?
// Usage: node scripts/edit-spike.mjs [score.mscz] [bar] [staff]   (bar and staff count from 0)
import fs from "node:fs";
import path from "node:path";
import { createNodeEngine, root } from "./lib/node-engine.mjs";
import { writeFile } from "../app/src/engine/resources.js";

const scorePath = process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz");
const bar = Number(process.argv[3] || 2), staff = Number(process.argv[4] || 0);
let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const engine = await createNodeEngine();
const { core, callStr } = engine;
const stats = () => {
    const tl = JSON.parse(callStr("mss_timeline"));
    const page = JSON.parse(callStr("mss_render_page", 0));
    return { points: tl.length, ops: page.length, noteheads: page.filter((o) => o[0] === "T" || o[0] === "S").length };
};
const info = engine.load(scorePath);
const before = stats();
console.log("before", JSON.stringify(before), "duration", info.duration.toFixed(2));

const add = JSON.parse(callStr("mss_edit_add_note", bar, 0, 1, staff, 72, 1, 4));
check(add.ok, `add C5 (quarter) at bar ${bar + 1}, staff ${staff}: ${JSON.stringify(add)}`);
const after = stats();
console.log("after ", JSON.stringify(after));
check(after.ops !== before.ops || after.points !== before.points, "the score changed (drawing or timeline differs)");

const save = JSON.parse(callStr("mss_save", "/scores/edited.mscz"));
check(save.ok, "saved to the engine's file system: " + JSON.stringify(save));
const bytes = core.FS.readFile("/scores/edited.mscz");
fs.writeFileSync(path.join(root, "build/spike/edited.mscz"), bytes);
check(bytes.length > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b, `a zip of ${bytes.length} bytes`);

const undo = JSON.parse(callStr("mss_edit_undo"));
const undone = stats();
check(undo.ok && undone.ops === before.ops && undone.points === before.points, `undo restores the score ${JSON.stringify(undone)}`);
const redo = JSON.parse(callStr("mss_edit_redo"));
const redone = stats();
check(redo.ok && redone.ops === after.ops, `redo brings the note back ${JSON.stringify(redone)}`);

// load the saved file again
const info2 = engine.load(path.join(root, "build/spike/edited.mscz"));
const reloaded = stats();
check(reloaded.ops === after.ops && reloaded.points === after.points, `the saved file reloads the same ${JSON.stringify(reloaded)}`);
// the sound follows the edit
const pcm = engine.render(2, 0);
let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
check(peak > 0.001, `it still plays (peak ${peak.toFixed(3)})`);
process.exit(failures ? 1 : 0);
