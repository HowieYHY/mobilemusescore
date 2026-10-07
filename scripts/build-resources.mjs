// Collects the data files MuseScore's engraving and playback code read at
// runtime, using MuseScore's own Qt resource lists (.qrc) so every file lands
// at the path the C++ code asks for (":/fonts/leland/metadata.json" and so on).
//
// Output: app/public/res/<alias> plus app/public/res/manifest.json.
// The app copies them into the WebAssembly file system under "/:/<alias>".
//
// Usage: node scripts/build-resources.mjs [4.7|5.0]   (default 4.7, as the engine)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] || "4.7";
const mu = path.join(root, version === "4.7" ? "third_party/musescore-4.7" : "third_party/musescore");
// the framework (MPE articulation profiles) lives in-tree in 4.7
const muse = version === "4.7" ? path.join(mu, "src") : path.join(root, "third_party/muse");
const out = path.join(root, "app/public/res");

const qrcFiles = [
    path.join(mu, "src/engraving/engraving.qrc"),
    ...fs.readdirSync(path.join(mu, "src/engraving/data/fonts"))
        .filter((f) => f.endsWith(".qrc"))
        .map((f) => path.join(mu, "src/engraving/data/fonts", f)),
];

const entries = [];

for (const qrc of qrcFiles) {
    const xml = fs.readFileSync(qrc, "utf8");
    const prefix = (xml.match(/<qresource prefix="([^"]*)"/) || [, "/"])[1].replace(/^\/|\/$/g, "");
    for (const m of xml.matchAll(/<file(?:\s+alias="([^"]+)")?>([^<]+)<\/file>/g)) {
        const src = path.resolve(path.dirname(qrc), m[2].trim());
        const alias = [prefix, m[1] || m[2].trim()].filter(Boolean).join("/");
        entries.push({ alias, src });
    }
}

// MPE articulation profiles (framework/mpe/CMakeLists.txt, prefix /mpe)
for (const f of fs.readdirSync(path.join(muse, "framework/mpe/resources"))) {
    if (f.endsWith(".json")) {
        entries.push({ alias: `mpe/resources/${f}`, src: path.join(muse, "framework/mpe/resources", f) });
    }
}

fs.rmSync(out, { recursive: true, force: true });
const manifest = [];
let total = 0;
for (const { alias, src } of entries) {
    if (!fs.existsSync(src)) {
        console.warn(`missing: ${src}`);
        continue;
    }
    const dst = path.join(out, alias);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const size = fs.statSync(dst).size;
    total += size;
    manifest.push({ path: alias, size });
}

fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`MuseScore ${version}: ${manifest.length} files, ${(total / 1048576).toFixed(1)} MB -> ${path.relative(root, out)}`);
