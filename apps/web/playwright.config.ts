import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * P0／P1-A：consolidation 拦截与刷新恢复。
 * 不启动 Vite／Gemini Live；不复用日常浏览器 profile。
 */
export default defineConfig({
  testDir: path.join(webRoot, "e2e"),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: path.join(webRoot, ".playwright", "test-results"),
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "off",
    video: "off",
    /* 阻断 service worker，降低绕过 route 的风险（非绝对隔离）。 */
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium-p0",
      testMatch: "**/*.p0.spec.ts",
      use: { browserName: "chromium" },
    },
    {
      name: "chromium-p1a",
      testMatch: "**/*.p1a.spec.ts",
      use: { browserName: "chromium" },
    },
    {
      name: "chromium-p1b",
      testMatch: "**/*.p1b.spec.ts",
      use: { browserName: "chromium" },
    },
    {
      name: "chromium-p1c",
      testMatch: "**/*.p1c.spec.ts",
      use: { browserName: "chromium" },
    },
  ],
});
