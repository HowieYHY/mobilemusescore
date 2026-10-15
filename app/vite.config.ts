import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// What the published page may load and run (issue #27): only its own files, with WebAssembly, and
// pictures and fonts from inside the scores. The browser then refuses any script that might ever get
// into the page, and any picture from elsewhere. Built pages only: the dev server injects its own
// styles and connects back over a websocket.
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
].join("; ");

export default defineConfig({
    base: "./",
    plugins: [{
        name: "content-security-policy",
        apply: "build",
        transformIndexHtml: (html) => html.replace(/(<meta charset="utf-8">)/, `$1\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
    }],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    worker: { format: "es" },
    server: { host: true },
    build: { target: "es2022", assetsInlineLimit: 0 },
});
