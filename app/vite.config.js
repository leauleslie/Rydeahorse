import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    // The client calls /api/* and Vite forwards it, so there is no CORS setup and no base URL
    // to configure per environment — the app only ever talks to its own origin.
    proxy: { "/api": { target: "http://localhost:3001", changeOrigin: true } },
  },
  // engine/ lives outside this package and has no build step of its own. Vite needs permission
  // to read it, and it compiles as plain ES modules because that is all it is.
  resolve: { preserveSymlinks: true },
  server_fs_note: undefined,
});
