import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    worker: { format: "es" },
    server: { host: true },
    build: { target: "es2022", assetsInlineLimit: 0 },
});
