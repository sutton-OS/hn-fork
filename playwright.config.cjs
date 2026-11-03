const { defineConfig, devices } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: { command: "node test/browser/server.cjs", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
});
