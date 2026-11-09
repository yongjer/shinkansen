// Regression: v1.2.7 YouTube 字幕即時翻譯（on-the-fly）MutationObserver 流程
//
// 驗證 startCaptionObserver 啟動後：
//   (1) 新加入 DOM 的 `.ytp-caption-segment` 被 MutationObserver 偵測到
//   (2) replaceSegmentEl 對快取未命中且 config.onTheFly = true 的字幕加入 pendingQueue
//   (3) 300ms setTimeout 後 flushOnTheFly 送出 TRANSLATE_SUBTITLE_BATCH
//   (4) sendMessage resolve 後 captionMap 填入 + DOM element 的 textContent 被替換
//
// 觸發條件（結構通則）：
//   - YT.active = true（translateYouTubeSubtitles 已啟動）
//   - config.onTheFly = true
//   - captionMap 尚無該字幕 key
//   - 新 segment appendChild 至 `.ytp-caption-window-container` 內
//
// 若 v1.2.7 的 observer 流程失效（例如觀察 root 設錯、`replaceSegmentEl` 的
// pendingQueue/flush 連結斷裂、或 onTheFly guard 誤判），測試會在
// sendMessage 計數或 textContent 比對上 fail。
//
// SANITY CHECK 已完成（2026-04-16，Claude Code 端）：
//   把 `startCaptionObserver` 內的 `document.querySelector('.ytp-caption-window-container')`
//   改成 `null`（強制退回 document.body 也不行，直接讓 observe root = undefined 會拋錯），
//   或把 `replaceSegmentEl` 裡 `config.onTheFly` 的 guard 改為永遠 return，
//   sendMessage 計數歸零、span 保持英文，測試正確 fail；還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-onthefly-observer';

test('youtube-onthefly-observer: 新增 caption segment 經 observer → on-the-fly flush → textContent 被替換', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // Mock sendMessage：TRANSLATE_SUBTITLE_BATCH 立即回傳 canned 翻譯
  await evaluate(`
    window.__batchCount = 0;
    window.__lastTexts = null;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__batchCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        window.__lastTexts = texts.slice();
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

  // 啟動：空 rawSegments → 走 else 分支（startCaptionObserver + 等待字幕）
  // translateYouTubeSubtitles 會 reset YT.config = null，所以要先 await 再覆寫 config
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);
  await page.waitForTimeout(100);

  // 啟動 on-the-fly 開關
  //   translateYouTubeSubtitles 已跑過 getYtConfig，YT.config 是物件，加一個欄位即可
  await evaluate(`
    window.__SK.YT.config = { ...(window.__SK.YT.config || {}), onTheFly: true };
  `);

  // 動態插入 caption segment（模擬 YouTube 播放器顯示字幕）
  //   MutationObserver 的 root 是 .ytp-caption-window-container，appendChild 會觸發
  await evaluate(`
    const container = document.querySelector('.ytp-caption-window-container');
    const span = document.createElement('span');
    span.className = 'ytp-caption-segment';
    span.id = 'test-segment';
    span.textContent = 'Hello world';
    container.appendChild(span);
  `);

  // flushOnTheFly 的 setTimeout 是 300ms；等 500ms 涵蓋 flush + sendMessage resolve + DOM 回寫
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    batchCount: window.__batchCount,
    lastTexts: window.__lastTexts,
    captionMapHas: window.__SK.YT.captionMap.has('hello world'),
    captionMapValue: window.__SK.YT.captionMap.get('hello world'),
    segmentText: document.getElementById('test-segment').textContent,
  })`);

  expect(
    result.batchCount,
    '新增 caption segment 觸發 MutationObserver → pendingQueue → flushOnTheFly 應送出 TRANSLATE_SUBTITLE_BATCH',
  ).toBe(1);
  expect(
    result.lastTexts,
    'sendMessage payload 的 texts 應包含 normalize 後的 key（小寫 "hello world"）',
  ).toEqual(['hello world']);
  expect(
    result.captionMapHas,
    '收到譯文後 captionMap 應填入 key',
  ).toBe(true);
  expect(
    result.captionMapValue,
    'captionMap 內容應為 mock 回傳的譯文',
  ).toBe('[ZH] hello world');
  expect(
    result.segmentText,
    'segment 的 textContent 應被替換為譯文',
  ).toBe('[ZH] hello world');

  await page.close();
});
