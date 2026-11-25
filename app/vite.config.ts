import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";

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
    "media-src 'self' blob:", // the silent audio that keeps Android playing (Keep playing, #28)
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
].join("; ");

// The owner's usage counter (VITE_USAGE_URL, tracker/worker.js) is the one address the page may send to
export default defineConfig(({ mode }) => {
const usageUrl = loadEnv(mode, process.cwd(), "VITE_").VITE_USAGE_URL || "";
const csp = usageUrl ? CSP.replace("connect-src 'self'", `connect-src 'self' ${new URL(usageUrl).origin}`) : CSP;
return {
    base: "./",
    plugins: [{
        name: "content-security-policy",
        apply: "build",
        transformIndexHtml: (html) => html.replace(/(<meta charset="utf-8">)/, `$1\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`),
    }],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    worker: { format: "es" },
    server: { host: true },
    build: { target: "es2022", assetsInlineLimit: 0 },
};
});
