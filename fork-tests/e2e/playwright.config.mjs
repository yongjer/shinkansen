// 驛傳（Ekiden）fork 自有的 Playwright 冒煙測試（與上游 test/ 分開）
// 執行：npm run test:fork:e2e
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.mjs'],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { screenshot: 'off', video: 'off', trace: 'off' },
});
