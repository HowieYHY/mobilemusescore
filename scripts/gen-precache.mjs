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
            hash.update(rel + ":" + st.size + ":" + crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex"));
            files.push({ url: rel.split("/").map(encodeURIComponent).join("/"), size: st.size });
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
