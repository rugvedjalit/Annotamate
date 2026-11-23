import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { prepareE2EDirs, SUBPATH } from './e2e/fixtures'

// End-to-end tests run against the real server serving the built SPA:
//   1. npm run build            (writes ../annotamate/server/static)
//   2. npm run e2e              (starts `python -m annotamate serve` with a fresh data dir)
// Set PYTHON to choose the interpreter (default "python"), E2E_PORT to change the port (the sub-path server uses
// E2E_PORT + 1).

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const port = Number(process.env.E2E_PORT ?? 8765)
const python = process.env.PYTHON ?? 'python'
const dirs = prepareE2EDirs()

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    // The smoke spec runs the first-run setup (creates the administrator); every other spec depends on it.
    { name: 'smoke', testMatch: 'smoke.spec.ts', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'chromium',
      testIgnore: 'smoke.spec.ts',
      dependencies: ['smoke'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: `${python} -m annotamate serve --port ${port} --root ${JSON.stringify(dirs.root)} --data-dir ${JSON.stringify(dirs.data)} --log-level warning`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // A second, fresh server behind a URL prefix (reverse-proxy sub-path deployment), used by subpath.spec.ts.
      command: `${python} -m annotamate serve --port ${port + 1} --base-url ${SUBPATH} --root ${JSON.stringify(dirs.root)} --data-dir ${JSON.stringify(dirs.dataSubpath)} --log-level warning`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${port + 1}${SUBPATH}api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
