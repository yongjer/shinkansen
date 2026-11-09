// Regression: spa-rescan-tiny-silent (v1.9.27)
//
// pickRescanToast({ ..., isTinyRescan: true }) → 回 'silent'，不彈 success toast。
// 對應 SPEC-PRIVATE §25.20.6:X / Threads / Reddit 滑到串尾 lazy mount link card /
// OG preview 等小元素 trigger 1-unit < 200 char rescan,toast「翻譯新內容 1/1 18 秒」
// 體感雜訊。tiny rescan 走靜默路徑。
//
// SANITY 紀錄：暫拿掉 isTinyRescan silent 分支 → tiny rescan 應仍彈 success toast →
// spec fail → 還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('Layer 13b:isTinyRescan=true + done>0 + 無失敗 → silent', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`JSON.stringify(window.__SK._pickRescanToast({ done: 1, failedCount: 0, pageUsage: { cacheHits: 0 }, totalRequested: 1, isTinyRescan: true }))`);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.type, 'tiny rescan 應 silent').toBe('silent');

  await page.close();
});

test('Layer 13b 守門：isTinyRescan=false + 無 cache hit → success toast', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`JSON.stringify(window.__SK._pickRescanToast({ done: 5, failedCount: 0, pageUsage: { cacheHits: 0 }, totalRequested: 5, isTinyRescan: false }))`);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.type, '大 rescan + 無 cache hit → success').toBe('success');
  expect(r.msg).toContain('5');

  await page.close();
});

test('Layer 13b 守門：isTinyRescan=true 但有失敗 → error 不被 silent 蓋', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`JSON.stringify(window.__SK._pickRescanToast({ done: 0, failedCount: 1, pageUsage: null, totalRequested: 1, isTinyRescan: true }))`);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.type, '失敗時即使 tiny 也應 error，不被 silent 蓋').toBe('error');

  await page.close();
});

test('Layer 13b 守門：isTinyRescan=undefined（舊 caller) → 走原邏輯', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 不傳 isTinyRescan，有 cache hit → silent(v1.9.8 原行為保留）
  const r1Result = await evaluate(`JSON.stringify(window.__SK._pickRescanToast({ done: 3, failedCount: 0, pageUsage: { cacheHits: 1 }, totalRequested: 3 }))`);
  const r1 = typeof r1Result === 'string' ? JSON.parse(r1Result) : r1Result;
  expect(r1.type, '有 cache hit + 沒 isTinyRescan → silent(v1.9.8 行為）').toBe('silent');

  // 不傳 isTinyRescan，沒 cache hit → success(v1.9.8 原行為）
  const r2Result = await evaluate(`JSON.stringify(window.__SK._pickRescanToast({ done: 3, failedCount: 0, pageUsage: { cacheHits: 0 }, totalRequested: 3 }))`);
  const r2 = typeof r2Result === 'string' ? JSON.parse(r2Result) : r2Result;
  expect(r2.type, '沒 cache hit + 沒 isTinyRescan → success').toBe('success');

  await page.close();
});
