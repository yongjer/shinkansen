// Regression: v1.2.42 字幕批次串流注入（各批 .then 立刻寫入 captionMap）
//
// 驗證 translateWindowFrom 的 _runBatch 使用 .then() 串流回呼：
// 每批 sendMessage resolve 後立刻寫入 captionMap 並呼叫 replaceSegmentEl，
// 不等其他批次完成。若退回「Promise.all 後統一 inject」的舊模式，
// 快的批次會被慢的批次綁住，captionMap 要等最慢的那批才會有任何內容。
//
// 結構通則 / 測法：
//   - 17 rawSegments → 切成 3 批 [1, 12, 4]（v1.9.19 BATCH=12）（firstBatchSize = 1）
//   - Mock sendMessage 以「批次內容長度」決定延遲：
//       batch 0（1 texts）→ 10ms
//       batch 1（12 texts）→ 50ms（v1.9.19 BATCH=12）
//       batch 2（4 texts）→ 500ms
//   - 呼叫 translateYouTubeSubtitles() 不等它 resolve，wait 200ms 後檢查
//     captionMap 狀態：
//       batch 0（10ms 完成）→ 1 條 entries
//       batch 1（~60ms 完成）→ 12 條 entries
//       batch 2（~510ms 完成）→ 尚未完成
//     → 200ms 時 captionMap.size 應為 1 + 12 = 13
//
// 串流注入失效時（例如改回 `const results = await Promise.all(...); for (r of results) inject(r)`）：
//   - 200ms 時 Promise.all 還在等 batch 2（500ms），沒有任何 inject 發生過（batch 0 sequential 除外）
//   - captionMap 只有 batch 0 的 1 條，size = 1 < 13 → 測試 fail
//
// SANITY CHECK 已完成（2026-04-16，Claude Code 端）：
//   把 `_runBatch` 裡 .then 的 inject 改成只回傳 res，並在 Promise.all 之後
//   for 迴圈 inject，200ms 時 captionMap.size 降到 1，測試正確 fail；還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

test('youtube-streaming-inject: 各批 .then 應立刻寫入 captionMap（不等最慢批次）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // Mock：依 texts.length 決定延遲
  //   1 條（batch 0）→ 10ms；8 條 → 依序 batch 1 = 50ms、batch 2 = 500ms
  await evaluate(`
    window.__batchCallSeq = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        const seq = window.__batchCallSeq++;
        // batch 0（seq=0, texts=1）→ 10ms
        // batch 1（seq=1, texts=12）→ 50ms（v1.9.19 BATCH=12）
        // batch 2（seq=2, texts=4）→ 500ms
        const delay = seq === 0 ? 10 : seq === 1 ? 50 : 500;
        await new Promise(r => setTimeout(r, delay));
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

  // 17 條 rawSegments → 切成 3 批
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
  `);

  // 不 await —— 讓 translateYouTubeSubtitles 在背景跑
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);

  // 200ms 後：batch 0（10ms）與 batch 1（~60ms）應已 inject，batch 2（~510ms）尚未
  await page.waitForTimeout(200);

  const mid = await evaluate(`({
    captionMapSize: window.__SK.YT.captionMap.size,
    batchCalls: window.__batchCallSeq,
  })`);

  // batch 0 = 1 entries, batch 1 = 12 entries → 串流下應 = 13（v1.9.19 BATCH=12）
  // 若非串流（inject 被集中在 Promise.all 之後）→ 只有 batch 0 = 1
  expect(
    mid.captionMapSize,
    `200ms 時 captionMap 應含 batch 0 + batch 1 的 13 條 entries（實際：${mid.captionMapSize}；若 < 13 代表 batch 1 的 inject 被 batch 2 拖住）`,
  ).toBeGreaterThanOrEqual(13);

  // 等 batch 2 結束，確認 final state
  await page.waitForTimeout(500);

  const final = await evaluate(`window.__SK.YT.captionMap.size`);
  expect(final, `全部批次完成後 captionMap 應有 17 條 entries`).toBe(17);

  await page.close();
});
