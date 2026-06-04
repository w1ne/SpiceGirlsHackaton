import { defineConfig } from "vite";
// App is loaded from file:// inside the WebView, so use relative asset paths.
export default defineConfig({ base: "./", build: { outDir: "dist" } });
