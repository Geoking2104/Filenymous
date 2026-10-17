import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  use: { headless: true, screenshot: "only-on-failure" },
  webServer: {
    command: "npm --prefix ../../ui run dev",
    port: 5173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
