import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  define: {
    __APP_URL__: JSON.stringify("https://filenymous.eu/app/"),
    __SIGNAL_URL__: JSON.stringify("ws://127.0.0.1:1"),
    __BROWSER__: JSON.stringify("chrome"),
    __VERSION__: JSON.stringify("test"),
    __E2E__: "false",
  },
  resolve: {
    alias: [{ find: /^\.\/device$/, replacement: resolve(__dirname, "src/device.ts"), customResolver: undefined }],
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
