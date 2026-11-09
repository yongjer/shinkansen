// Regression: SPA observer rescan 純 cache hit 場景應 silent 不顯示「已翻 N 段新內容」
//
// Bug:framework re-render 同一段譯後內容(典型 YouTube hover description)觸發 SPA
// rescan,走 cache 路徑 reapply 譯文(API 0 cost)。但仍跳出「已翻譯 N 段新內容」
// success toast,讓使用者誤以為又花了 token。
//
// 修法:抽 pickRescanToast helper,純 cache hit(pageUsage.cacheHits === done)→ 回
// 'silent',rescan callback 改用 hideToast 把 loading toast 藏掉、不顯示 success toast。
// 失敗或有 API call 的情境維持原 toast。
//
// v1.9.8 放寬:silent 條件從「全部 cache hit」改為「有任何 cache hit」(cacheHits > 0)。
// X / Reddit / Threads / Mastodon 等虛擬化 timeline scroll 場景,fragment unit 不走
// by-text reuse → 每次 rescan 走 cache lookup「大部分 hit + 少數 miss」混合 → 過去
// 行為連續彈 toast 噪音化。只在 cacheHits === 0 全部真翻時才 success toast。
//
// SANITY 紀錄(已驗證):暫時把 isPureCacheHit 條件改成 false(永遠不 silent),
// test 1 (純 cache hit silent) fail;還原後 pass。
//
// v1.9.8 SANITY(已驗證):把 hasAnyCacheHit 條件改成 `pageUsage.cacheHits === done`
// 退回 v1.x 嚴格「全 hit」邏輯 → test 2「混合 silent」fail(decision.type='success')。
// 還原為 `pageUsage.cacheHits > 0 && done > 0` 後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('純 cache hit(cacheHits === done)應 silent,不顯示 success toast', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 1,
      failedCount: 0,
      pageUsage: { cacheHits: 1 },
      totalRequested: 1,
    }))
  `);

  expect(JSON.parse(result)).toEqual({ type: 'silent' });
  await page.close();
});

test('v1.9.8: 混合 cache + API(cacheHits > 0 && < done)也 silent — SPA rescan 被動行為不該 toast 噪音', async ({ context, localServer }) => {
  // 原 v1.x 行為:混合 cacheHits > 0 但 < done → success toast「已翻譯 5 段新內容」。
  // v1.9.8 場景:X / Threads scroll 虛擬化反覆 mount/unmount 同段推文,fragment unit
  // 不走 by-text reuse → 每次 rescan 走 cache lookup hit 大部分 + miss 少數 →
  // 連續彈 toast 噪音化。silent 條件放寬到「有任何 cache hit」覆蓋這類常見場景。
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 5,
      failedCount: 0,
      pageUsage: { cacheHits: 3 },
      totalRequested: 5,
    }))
  `);

  expect(JSON.parse(result)).toEqual({ type: 'silent' });
  await page.close();
});

test('全部 API call(cacheHits=0)應顯示 success toast', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 3,
      failedCount: 0,
      pageUsage: { cacheHits: 0 },
      totalRequested: 3,
    }))
  `);

  expect(JSON.parse(result).type).toBe('success');
  await page.close();
});

test('部分失敗(failedCount > 0)應顯示 error toast,不論是否純 cache hit', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 3,
      failedCount: 2,
      pageUsage: { cacheHits: 3 },
      totalRequested: 5,
    }))
  `);

  const decision = JSON.parse(result);
  expect(decision.type).toBe('error');
  expect(decision.msg).toContain('2 / 5');
  await page.close();
});

test('pageUsage 為 null(極端情境)不應誤判為純 cache hit', async ({ context, localServer }) => {
  // forcing function:防將來 translateUnits 改 API 把 pageUsage 拿掉時,helper 不會
  // 沉默吞掉所有 toast。pageUsage=null → 預設走 success(保留通知,不靜音)
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 1,
      failedCount: 0,
      pageUsage: null,
      totalRequested: 1,
    }))
  `);

  expect(JSON.parse(result).type).toBe('success');
  await page.close();
});
