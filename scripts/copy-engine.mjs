// Copies the built WebAssembly modules and the MS Basic sound font into the
// web app's public folder.
//
// Usage: node scripts/copy-engine.mjs [buildDir=build/wasm47]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.resolve(root, process.argv[2] || "build/wasm47");
const pub = path.join(root, "app/public");

const copies = [
    [path.join(build, "core/mscore.mjs"), path.join(pub, "engine/mscore.mjs")],
    [path.join(build, "core/mscore.wasm"), path.join(pub, "engine/mscore.wasm")],
    [path.join(build, "audio/msaudio.mjs"), path.join(pub, "engine/msaudio.mjs")],
    [path.join(root, "third_party/musescore/share/sound/MS Basic.sf3"), path.join(pub, "sound/MS Basic.sf3")],
];

for (const [src, dst] of copies) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(`${path.relative(root, dst)}  ${(fs.statSync(dst).size / 1048576).toFixed(1)} MB`);
}
