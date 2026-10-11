// Lists every file of the built app (app/dist) into dist/precache.json so the
// service worker can store the whole app for offline use.
//
// Usage: node scripts/gen-precache.mjs   (after `vite build`)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "app/dist");

// Text files with Windows line endings (a Windows checkout's public/ files) are
// stored with Unix ones once committed to gh-pages, so their hashes would never
// match what is served, and every update would download them again. Write them
// as served. (.mjs, .wasm and .sf3 are kept byte for byte: build/ghpages's
// .gitattributes marks them -text; fonts and pictures are binary.)
const KEEP = /\.(mjs|wasm|sf3|otf|ttf|woff2?|png|jpe?g|gif|ico|webp)$/i;
(function normalise(dir) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) {
            normalise(p);
        } else if (!KEEP.test(name)) {
            const b = fs.readFileSync(p);
            if (!b.includes(0) && b.includes("\r\n")) {
                fs.writeFileSync(p, b.toString("utf8").replace(/\r\n/g, "\n"));
            }
        }
    }
})(dist);

const files = [];
const hash = crypto.createHash("sha256");
(function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, name);
        const rel = path.relative(dist, p).split(path.sep).join("/");
        if (fs.statSync(p).isDirectory()) {
            walk(p);
        } else if (rel !== "precache.json" && rel !== "sw.js") {
            const st = fs.statSync(p);
            const h = crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
            hash.update(rel + ":" + st.size + ":" + h);
            // h lets an update keep files it already has (see sw.js)
            files.push({ url: rel.split("/").map(encodeURIComponent).join("/"), size: st.size, h });
        }
    }
})(dist);
files.unshift({ url: "./", size: 0 });

const version = hash.digest("hex").slice(0, 16);
fs.writeFileSync(path.join(dist, "precache.json"), JSON.stringify({ version, files }));
const swPath = path.join(dist, "sw.js");
fs.writeFileSync(swPath, fs.readFileSync(swPath, "utf8").replace("__BUILD_VERSION__", version));
const total = files.reduce((a, f) => a + f.size, 0);
console.log(`precache: ${files.length} files, ${(total / 1048576).toFixed(1)} MB, version ${version}`);
