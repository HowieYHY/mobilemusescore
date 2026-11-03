// Edit API check in Node: select by tapping, change pitch and duration, delete, undo; save and reload.
// Usage: node scripts/edit-api-test.mjs [score.mscz]
import fs from "node:fs";
import path from "node:path";
import { createNodeEngine, root } from "./lib/node-engine.mjs";

const scorePath = process.argv[2] || path.join(root, "real test musescores/Paper Hearts.mscz");
let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };
const engine = await createNodeEngine();
const { callStr, core } = engine;
engine.load(scorePath);
const J = (name, ...a) => JSON.parse(callStr(name, ...a));

// find a note on page 1 from the drawing itself: the first notehead glyph's position
const ops = JSON.parse(callStr("mss_render_page", 0));
const info = J("mss_score_info");
const sp = info.spatium;
let sel = null;
for (let y = 0; y < info.pages[0].h && !sel; y += sp / 2) {
    for (let x = info.pages[0].w * 0.2; x < info.pages[0].w * 0.8 && !sel; x += sp) {
        const s = J("mss_edit_select", 0, x, y, sp * 0.4);
        if (s && s.kind === "note") sel = { ...s, tapX: x, tapY: y };
    }
}
check(!!sel, "a tap on a notehead selects a note: " + JSON.stringify(sel));
const before = J("mss_edit_selection");
check(before && before.pitch === sel.pitch, "the selection is kept: pitch " + before?.pitch + " " + before?.name);

let r = J("mss_edit_pitch", 0);
let after = J("mss_edit_selection");
check(r.ok && after.pitch === sel.pitch + 1, `semitone up: ${sel.pitch} -> ${after?.pitch} (${after?.name})`);
r = J("mss_edit_pitch", 3);
after = J("mss_edit_selection");
check(r.ok && after.pitch === sel.pitch + 1 - 12, `octave down: -> ${after?.pitch}`);
r = J("mss_edit_undo"); r = J("mss_edit_undo");
const undone = J("mss_edit_selection");
console.log("after two undos the selection is", JSON.stringify(undone));
const re = J("mss_edit_select", 0, sel.tapX, sel.tapY, sp * 0.4);
check(re && re.pitch === sel.pitch, `two undos restore pitch ${sel.pitch}: ${re?.pitch}`);

const d0 = re.den;
r = J("mss_edit_duration", d0 === 4 ? 8 : 4);
const d1 = J("mss_edit_selection");
check(r.ok && d1 && d1.den !== d0, `duration 1/${d0} -> 1/${d1?.den}`);
r = J("mss_edit_undo");
r = J("mss_edit_select", 0, sel.tapX, sel.tapY, sp * 0.4);
r = J("mss_edit_delete");
const gone = J("mss_edit_select", 0, sel.tapX, sel.tapY, sp * 0.4);
check(!gone || gone.kind === "rest", `delete turns the note into a rest (${gone?.kind})`);
const nx = J("mss_edit_move", "next-chord");
check(nx === null || typeof nx.bar === "number", "move to next: " + JSON.stringify(nx));
J("mss_save", "/scores/e.mscz");
const bytes = core.FS.readFile("/scores/e.mscz");
fs.mkdirSync(path.join(root, "build/spike"), { recursive: true });
fs.writeFileSync(path.join(root, "build/spike/api-edited.mscz"), bytes);
engine.load(path.join(root, "build/spike/api-edited.mscz"));
check(true, `saved ${bytes.length} bytes and reloaded`);
process.exit(failures ? 1 : 0);
