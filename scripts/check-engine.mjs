// Before publishing: the built app's score engine must have every function the app calls. The
// engine files aren't in git, so each PC publishes the one it built; 1.0.13-1.0.19 went out from a
// PC with an older engine, and the staff list notes need (1.0.14) never reached the live app.
// Usage: node scripts/check-engine.mjs [dist=app/dist]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(root, process.argv[2] || "app/dist");
const worker = fs.readFileSync(path.join(root, "app/src/engine/core.worker.ts"), "utf8");
const wanted = [...new Set([...worker.matchAll(/\bcall(?:Str|Void|Num)?\("(mss_\w+)"/g)].map((m) => m[1]))];
const engine = fs.readFileSync(path.join(dist, "engine/mscore.mjs"), "utf8");
const missing = wanted.filter((f) => !engine.includes("_" + f));
if (missing.length) {
    console.error(`The engine in ${path.relative(root, dist)} lacks ${missing.join(", ")}, which the app calls.`);
    console.error("Build the engine on this PC (DEVELOPMENT.md, Building) and copy it with scripts/copy-engine.mjs first.");
    process.exit(1);
}
console.log(`engine check: all ${wanted.length} engine functions the app calls are there`);
