import { defineConfig } from "@playwright/test";

/**
 * Live smoke-test config: runs the e2e/ specs against the production site
 * (no local web server). Example:
 *   npx playwright test e2e/send-browser-link.spec.ts --config=playwright.live.config.ts
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: "https://filenymous.eu/app/",
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
