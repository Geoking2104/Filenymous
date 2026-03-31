import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tryorama tests can be slow (DHT sync, conductor startup)
    testTimeout: 120_000,
    hookTimeout: 60_000,
    singleThread: true,
  },
});
