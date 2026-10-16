import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e-live", timeout: 240_000, use: { headless: true }, projects: [{ name: "chromium", use: { browserName: "chromium" } }] });
