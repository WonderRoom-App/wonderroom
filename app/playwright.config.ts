import { defineConfig, devices } from '@playwright/test'

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

// A fresh database and data folder for each run. Workers load this file again, so they keep the main process's values.
if (!process.env.WONDERROOM_E2E_DATABASE) {
  const runName = `wonderroom_e2e_${randomBytes(6).toString('hex')}`
  process.env.WONDERROOM_E2E_DATABASE = runName
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:5433/${runName}`
  process.env.PAYLOAD_SECRET = 'e2e-secret'
  process.env.WONDERROOM_DATA_DIR = resolve('../.tmp', runName)
}

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: {
    command: 'node tests/e2e/server.mjs',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    timeout: 180_000,
    url: 'http://localhost:3000',
  },
})
