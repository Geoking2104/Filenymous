import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy WebSocket to Holochain conductor in dev mode
    proxy: {
      "/api": {
        target: "http://localhost:3001", // bridge
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  define: {
    // Conductor WebSocket URL (override via VITE_HC_URL env var)
    __HC_URL__: JSON.stringify(
      process.env.VITE_HC_URL ?? "ws://localhost:8888"
    ),
    __BRIDGE_URL__: JSON.stringify(
      process.env.VITE_BRIDGE_URL ?? "http://localhost:3001"
    ),
  },
});
