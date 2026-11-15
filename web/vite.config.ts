import { defineConfig } from "vite";

export default defineConfig({
  // relative base so the build works from a GitHub Pages project subpath
  base: "./",
  build: {
    target: "es2020",
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
