import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
    base: "./",
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    worker: { format: "es" },
    server: { host: true },
    build: { target: "es2022", assetsInlineLimit: 0 },
});
