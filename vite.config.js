import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

// App version shown in the header (left of "Refresh all"), format "v0.0.0".
// Source of truth: package.json "version" — bump it by hand on every deploy
// (see CLAUDE.md / docs/CONTEXT.md "Bump de versão" section) so the number
// on screen always identifies which feature set is live.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8")
);

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
  },
  server: {
    port: 5173,
  },
});
