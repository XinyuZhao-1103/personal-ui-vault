import { defineConfig } from "@playwright/test"
import path from "node:path"

export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  outputDir: "./test-results/browser",
  timeout: 60000,
  use: {
    baseURL: "http://localhost:14312",
    channel: "msedge",
    headless: true,
    viewport: { width: 1440, height: 960 },
  },
  webServer: {
    command: "node server/index.mjs --production",
    url: "http://localhost:14312/api/health",
    reuseExistingServer: false,
    env: {
      VAULT_PASSWORD: "browser-test-password-123",
      VAULT_ORIGIN: "http://localhost:14312",
      VAULT_HOST: "127.0.0.1",
      VAULT_PORT: "14312",
      VAULT_DATA_DIR: path.resolve(`work/browser-${process.pid}-${Date.now()}`),
    },
  },
})
