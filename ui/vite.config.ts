import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import filenymousSeo from "./seo/vite-plugin.mjs";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The vault uses sqlite-wasm's opfs-sahpool VFS only. The package also emits a
// "worker1" wrapper and the SharedArrayBuffer-based OPFS proxy (needs COEP,
// which the site doesn't send): never loaded, so drop them to save ~255 KB.
const dropUnusedSqliteWorkers = (): Plugin => ({
  name: "fny-drop-unused-sqlite-workers",
  apply: "build",
  closeBundle() {
    const dir = fileURLToPath(new URL("./dist/assets", import.meta.url));
    try {
      for (const f of readdirSync(dir)) {
        if (/^sqlite3-(worker1|opfs-async-proxy)-.*\.js$/.test(f)) rmSync(join(dir, f));
      }
    } catch {
      /* no dist yet */
    }
  },
});

export default defineConfig({
  worker: { format: "es" },
  plugins: [react(), filenymousSeo(), dropUnusedSqliteWorkers()],
  // libsodium-wrappers importe ./libsodium.mjs en relatif — Vite ne peut pas
  // le résoudre via son système de modules. On exclut du pre-bundling et on
  // force le resolve vers la version CJS qui n'a pas ce problème.
  optimizeDeps: {
    exclude: ["libsodium-wrappers", "@sqlite.org/sqlite-wasm"],
  },
  server: {
    port: 5173,
    // En mode dev, on proxifie le WS du conductor local uniquement.
    // Le bridge centralisé (v1) est supprimé — plus de proxy /api.
    proxy: {
      "/ws": {
        target: process.env.VITE_HC_URL ?? "ws://localhost:8888",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  define: {
    // URL WebSocket du conductor Holochain local (Launcher ou dev direct).
    // En production Holo Host, l'UI se connecte via window.__HC_LAUNCHER_ENV__
    // injecté par le Launcher — cette constante sert uniquement de fallback.
    __HC_URL__: JSON.stringify(
      process.env.VITE_HC_URL ?? "ws://localhost:8888"
    ),

    // URL HTTP du Holo Web Bridge — permet aux visiteurs sans conductor
    // de télécharger des fichiers directement depuis le DHT via HTTP GET.
    // En dev, pointe sur un proxy local (npm run dev:bridge ou rien).
    // En production, pointe sur le sous-domaine Holo Host de l'app.
    __WEB_BRIDGE_URL__: JSON.stringify(
      process.env.VITE_WEB_BRIDGE_URL ?? "https://filenymous.holo.host/web-bridge"
    ),

    // URL du linker Holo Web Conductor expose par l'extension / h2hc-linker.
    __HWC_LINKER_URL__: JSON.stringify(
      process.env.VITE_HWC_LINKER_URL ?? "http://localhost:8090"
    ),

    // App ID Holochain — doit correspondre à happ.yaml > app_name
    __APP_ID__: JSON.stringify(
      process.env.VITE_APP_ID ?? "filenymous"
    ),

    // DNA rôle (dna.yaml > name) — utilisé lors de l'install via Launcher API
    __DNA_ROLE__: JSON.stringify("filenymous"),
  },
  build: {
    // Découpe en chunks pour les librairies lourdes (tweetnacl, etc.)
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
        },
      },
    },
  },
});
