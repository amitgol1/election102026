import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'integration/**',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: 'iPhone 15', use: { ...devices['iPhone 15'] } },
    { name: 'Pixel 7', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node e2e/server.js',
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
