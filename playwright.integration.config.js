import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PORTS, IP_DAILY_LIMIT, FAIL_SECRET } from './e2e/integration/env.js';

const now = Date.now();
const BAN_START = new Date(now - 3600_000).toISOString();
const BAN_END = new Date(now + 86400_000).toISOString();
const PAST_BAN = ['2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z'];

// Each server gets a fresh D1 state dir outside the repo so runs are independent.
function server(name, [start, end], extra = '') {
  const dir = join(tmpdir(), 'election-integration', name);
  const port = PORTS[name];
  return {
    command: [
      `rm -rf "${dir}"`,
      `npx wrangler d1 migrations apply election --local --persist-to "${dir}"`,
      `npx wrangler dev --port ${port} --persist-to "${dir}" --show-interactive-dev-session=false`
        + ` --var IP_DAILY_LIMIT:${IP_DAILY_LIMIT} --var BAN_START:${start} --var BAN_END:${end}${extra}`,
    ].join(' && '),
    url: `http://localhost:${port}/api/candidates`,
    reuseExistingServer: false,
    timeout: 120_000,
  };
}

export default defineConfig({
  testDir: './e2e/integration',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  timeout: 90_000,
  use: { baseURL: `http://localhost:${PORTS.normal}` },
  projects: [
    { name: 'api', testMatch: /api\..*\.spec\.js/ },
    { name: 'iPhone 15', testMatch: /ui\..*\.spec\.js/, use: { ...devices['iPhone 15'] } },
    { name: 'Pixel 7', testMatch: /ui\..*\.spec\.js/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: [server('normal', PAST_BAN), server('ban', [BAN_START, BAN_END]), server('stats', PAST_BAN),
    server('captcha', PAST_BAN, ` --var TURNSTILE_SECRET:${FAIL_SECRET}`)],
});
