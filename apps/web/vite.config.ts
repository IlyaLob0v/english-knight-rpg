import { defineConfig } from "vite";

// The gateway (pnpm dev:server, :8787) is reached through /api in dev and in preview,
// so the platform and the gateway share an origin and no CORS setup is needed.
const proxy = { "/api": { target: "http://localhost:8787", rewrite: (path: string) => path.replace(/^\/api/, "") } };

export default defineConfig({
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { target: "es2022" },
});
