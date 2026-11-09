// Regression: v1.8.39 translateUnits 段落 hash dedup + broadcast inject
//
// 痛點:Medium 文章 60 張圖每張 alt 都是同字串 "Press enter or click to view image
// in full size",packBatches 把這 60 段切成 3 個 batch 各 20 段重複內容。
// batch 1 浪費整個 API call(~1700 input tokens),batch 2/3 雖然本地 cache 救起來
// 但 batch 1 仍多打。
//
// 修法位置:shinkansen/content.js translateUnits 入口處(serialize 後、packBatches 前)
//   1. build origIndicesByText: Map<text, origIdx[]> 累計同 text 所有原始 index
//   2. dedupedTexts/Units/Slots 只含 unique 子集
//   3. packBatches 收 deduped 子集
//   4. runBatch + STREAMING_SEGMENT 路徑 inject 時 broadcast 到所有 dup 原始位置
//   5. 送 milestone:dedup_done log(original / unique / saved 三欄)
//
// 結構通則:測「同 text 字串只送 API 一次,結果 broadcast 到所有 dup unit」
// 不依賴特定網站結構(本 fixture 模擬 Medium image alt 重複場景但邏輯通用)。
//
// SANITY CHECK 紀錄(已驗證,2026-05-04):
//   把 origIndicesByText broadcast 邏輯改成 single-inject(不展開 dup)→
//   60 個 .duplicate-alt 元素只第 1 個有譯文,其他 59 個維持原文 → spec fail。
//   還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-dedup-broadcast';

test('translate-dedup-broadcast: 60 段重複文字只送 1 段給 API + 結果 broadcast 到所有 dup', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock TRANSLATE_BATCH:每段回 '[ZH] ' + 原文(讓我們能透過 textContent 驗證 inject)
  // streaming 路徑 mock 失敗 → fallback non-streaming(讓 spec 觀察 TRANSLATE_BATCH)
  await evaluate(`
    window.__batchTextsSeen = [];
    window.__batchCallCount = 0;

    chrome.storage.sync.get = async function(keys) {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 20,
        maxCharsPerBatch: 100000,
        partialMode: { enabled: false, maxUnits: 25 },
      };
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        return { ok: false, error: 'streaming disabled in test' };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        return { ok: true, aborted: false };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCallCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        for (const t of texts) window.__batchTextsSeen.push(t);
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: texts.length, outputTokens: texts.length, cachedTokens: 0,
                   billedInputTokens: texts.length, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 直接呼叫 SK.translateUnits(主路徑)
  await evaluate(`
    (() => {
      const units = window.__SK.collectParagraphs();
      window.__totalUnits = units.length;
      window.__translatePromise = window.__SK.translateUnits(units).catch(e => null);
      return null;
    })()
  `);

  // 等翻譯完成(streaming fail → fallback runBatch await,non-streaming 路徑)
  await page.waitForTimeout(1500);

  const result = await evaluate(`({
    totalUnits: window.__totalUnits,
    batchCallCount: window.__batchCallCount,
    uniqueTextsSentCount: new Set(window.__batchTextsSeen).size,
    duplicateTextsSentCount: window.__batchTextsSeen.length,
    duplicateAltCount: document.querySelectorAll('.duplicate-alt').length,
    duplicateAltTranslated: Array.from(document.querySelectorAll('.duplicate-alt')).filter(el => el.textContent.startsWith('[ZH] ')).length,
    uniqueParagraphsTranslated: Array.from(document.querySelectorAll('.unique-p')).filter(el => el.textContent.startsWith('[ZH] ')).length,
  })`);

  // 1. 重複內容只送 1 段(unique texts seen 數 < 全部 dup 段數)
  // fixture 有 60 段 .duplicate-alt + 5 段 .unique-p = 65 段 total
  // dedup 後 unique = 6 段(5 unique + 1 dedup 後的「Press enter...」)
  expect(result.totalUnits, 'collectParagraphs 應抓到 65 段').toBe(65);
  expect(
    result.uniqueTextsSentCount,
    `送給 API 的 unique text 應為 6 段(5 unique + 1 dedup 重複),實際 ${result.uniqueTextsSentCount}`,
  ).toBe(6);
  expect(
    result.duplicateTextsSentCount,
    `送給 API 的總段數應為 6 段(實際 sent),不是 65 段(原始)。實際 ${result.duplicateTextsSentCount}`,
  ).toBe(6);

  // 2. 60 個 .duplicate-alt 元素全部都被 broadcast 譯文
  expect(result.duplicateAltCount, '應有 60 個 .duplicate-alt').toBe(60);
  expect(
    result.duplicateAltTranslated,
    `60 個 .duplicate-alt 應全部被 broadcast 譯文,實際 ${result.duplicateAltTranslated}`,
  ).toBe(60);

  // 3. 5 個 unique 段也都翻完
  expect(
    result.uniqueParagraphsTranslated,
    `5 個 .unique-p 應全部翻完,實際 ${result.uniqueParagraphsTranslated}`,
  ).toBe(5);

  await page.close();
});
