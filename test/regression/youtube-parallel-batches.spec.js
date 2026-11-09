// Regression: v1.2.41 字幕批次翻譯改為並行（Promise.all）
//
// 驗證 translateWindowFrom 在 batch 0 完成後，batch 1+ 使用 Promise.all 並行送出
// 而非循序 await。測法：
//   - Mock chrome.runtime.sendMessage 每次延遲 100ms 才 resolve
//   - 記錄每次 TRANSLATE_SUBTITLE_BATCH 被「呼叫」的時間戳（非 resolve 時間）
//   - 若 batch 1 與 batch 2 平行送出，兩者呼叫時間應相差 < 50ms
//   - 若退回循序 await，batch 2 會在 batch 1 resolve 後才送出，兩者差 ≥ 100ms
//
// 結構通則：
//   - windowStartMs = 0、video.currentTime = 0 → leadMs = 0 → firstBatchSize = 1
//   - 17 rawSegments 切成 3 批：[1, 12, 4]（v1.9.19 BATCH=12） units
//   - batch 0 由 await 先跑（v1.2.56 暖 cache），然後 batch 1 / batch 2 並行
//
// 若 v1.2.41 失效（Promise.all 被改回 for-await 或 sequential），
// batch 2 的呼叫時間 - batch 1 的呼叫時間 ≈ 100ms（batch 1 的延遲），測試 fail。
//
// SANITY CHECK 已完成（2026-04-16，Claude Code 端）：
//   把 `await Promise.all(batches.slice(1).map(...))` 改成
//   `for (const b of batches.slice(1)) { await _runBatch(...); }` 後，
//   batch 2 - batch 1 時間差從 ~1ms 變成 ~100ms，測試正確 fail；還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-parallel-batches';

test('youtube-parallel-batches: batch 1+ 應並行送出（非循序 await）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // Mock sendMessage：TRANSLATE_SUBTITLE_BATCH 每次延遲 100ms，記錄呼叫時間戳
  await evaluate(`
    window.__callTimes = [];
    window.__startTime = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const callAt = performance.now() - window.__startTime;
        window.__callTimes.push(callAt);
        await new Promise(r => setTimeout(r, 100));
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: {
            inputTokens: 1, outputTokens: 1, cachedTokens: 0,
            billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0,
          },
        };
      }
      return { ok: true };
    };
  `);

  // 塞 17 條 rawSegments（都在 window 0 內：0–30000ms）→ 切成 [1, 12, 4]（v1.9.19 BATCH=12）
  await evaluate(`
    const segs = [];
    for (let i = 0; i < 17; i++) {
      segs.push({
        startMs: i * 1000,
        endMs: (i * 1000) + 800,
        text: 'line ' + i,
        normText: 'line ' + i,
        groupId: null,
      });
    }
    window.__SK.YT.rawSegments = segs;
    window.__startTime = performance.now();
  `);

  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  // 串流跑完 3 批需要：100(batch0) + 100(batch1 & 2 平行) = ~200ms；多等餘裕
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    callTimes: window.__callTimes,
    batches: window.__callTimes.length,
  })`);

  expect(result.batches, '應送出 3 筆 TRANSLATE_SUBTITLE_BATCH（batches [1, 12, 4]（v1.9.19 BATCH=12））').toBe(3);

  const [t0, t1, t2] = result.callTimes;
  const gap12 = t2 - t1;

  // 並行：batch 1 / batch 2 的呼叫時間應該幾乎同時（Promise.all 同步 map）
  // 循序：batch 2 會在 batch 1 resolve（+100ms）後才呼叫 → gap ≥ 100ms
  expect(
    gap12,
    `batch 2 呼叫時間 - batch 1 呼叫時間應 < 50ms（實際：${gap12.toFixed(1)}ms；t0=${t0.toFixed(1)}, t1=${t1.toFixed(1)}, t2=${t2.toFixed(1)}）`,
  ).toBeLessThan(50);

  await page.close();
});
