import { defineConfig } from "vite";

// In dev the gateway runs on :8787 (pnpm dev:server) and is reached through /api,
// so the client and the gateway share an origin and no CORS setup is needed.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
