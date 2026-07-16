import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build metadata shown in the app header (left of "Refresh all").
// On Vercel, VERCEL_GIT_COMMIT_SHA identifies the exact deployed commit —
// compare it against `git log` on main to confirm a deploy landed.
// Local/dev builds (no Vercel env) show "dev".
const commit = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || "dev";
const buildDate = new Date().toISOString().slice(0, 10);

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BUILD__: JSON.stringify(`${commit} · ${buildDate}`),
  },
  server: {
    port: 5173,
  },
});
