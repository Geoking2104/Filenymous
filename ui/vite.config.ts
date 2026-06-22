import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // libsodium-wrappers importe ./libsodium.mjs en relatif — Vite ne peut pas
  // le résoudre via son système de modules. On exclut du pre-bundling et on
  // force le resolve vers la version CJS qui n'a pas ce problème.
  optimizeDeps: {
    exclude: ["libsodium-wrappers"],
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
