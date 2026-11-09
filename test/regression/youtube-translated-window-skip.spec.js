// Regression: v1.2.48 translatedWindows Set 跳過判斷
//
// 驗證 translateWindowFrom 對「已翻過視窗」的早期返回邏輯：
// 同一個 windowStartMs 第二次被呼叫時（例如向後 seek 回已翻範圍），
// 應在 content-youtube.js 約 L376 的 `if (YT.translatedWindows.has(windowStartMs)) return;`
// 早期返回，絕不能再送 TRANSLATE_SUBTITLE_BATCH。
//
// 觸發條件（結構通則）：
//   - YT.active = true、YT.rawSegments 有內容（seek handler 才會處理）
//   - 第一次 translateWindowFrom(0) 完成 → YT.translatedWindows.add(0)
//   - video 再次 dispatch 'seeked'，currentTime = 0（落在同一視窗）
//     → onVideoSeeked 重新呼叫 translateWindowFrom(0) → 應跳過
//
// 如果 v1.2.48 修正失效（translatedWindows.has 檢查被移除 / 誤改），
// 第二次 seek 會重複送出 TRANSLATE_SUBTITLE_BATCH，batch 計數會增加。
//
// SANITY CHECK 已完成（2026-04-16，Claude Code 端）：
//   註解掉 content-youtube.js 的 `if (YT.translatedWindows.has(windowStartMs)) return;`，
//   batch 計數在 seek 後從 1 變 2，測試正確 fail；還原後計數維持不變，測試 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-translated-window-skip';

test('youtube-translated-window-skip: 對已翻譯視窗第二次 seek 不應再送 TRANSLATE_SUBTITLE_BATCH', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 讓 content-youtube.js 內部 guard（isYouTubePage）通過
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // Mock chrome.runtime.sendMessage：
  //   - TRANSLATE_SUBTITLE_BATCH → 回傳 canned 翻譯並計數
  //   - 其他（LOG_USAGE 等）→ 回傳 { ok: true }，不計入 batchCount
  await evaluate(`
    window.__batchCount = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__batchCount++;
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

  // 塞入 fake 字幕段落（都落在 window 0：0–30000ms）
  await evaluate(`
    window.__SK.YT.rawSegments = [
      { startMs: 1000, endMs: 3000, text: 'hello',  normText: 'hello',  groupId: null },
      { startMs: 5000, endMs: 7000, text: 'world',  normText: 'world',  groupId: null },
    ];
  `);

  // 驅動第一次翻譯：
  //   translateYouTubeSubtitles() → attachVideoListener（掛上 seeked listener）
  //     → await translateWindowFrom(0) → 送 TRANSLATE_SUBTITLE_BATCH
  //     → 完成後 YT.translatedWindows.add(0)
  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(500);

  const afterFirst = await evaluate(`({
    batchCount: window.__batchCount,
    translated: Array.from(window.__SK.YT.translatedWindows),
    active: window.__SK.YT.active,
  })`);

  expect(afterFirst.active, 'YT.active 應為 true').toBe(true);
  expect(
    afterFirst.batchCount,
    '第一次翻譯應送出至少 1 筆 TRANSLATE_SUBTITLE_BATCH',
  ).toBeGreaterThanOrEqual(1);
  expect(
    afterFirst.translated,
    'translatedWindows 應包含已翻過的視窗 0',
  ).toContain(0);

  const countAfterFirst = afterFirst.batchCount;

  // Dispatch seeked 事件（currentTime 仍為 0 → 落在同一個已翻視窗）
  //   onVideoSeeked → translateWindowFrom(0) → L376 早期返回（不送 API）
  await evaluate(`
    const video = document.querySelector('video');
    video.currentTime = 0;
    video.dispatchEvent(new Event('seeked'));
  `);
  await page.waitForTimeout(300);

  const afterSeek = await evaluate(`window.__batchCount`);

  expect(
    afterSeek,
    `seek 回已翻視窗後 batchCount 不應增加（first: ${countAfterFirst}, after-seek: ${afterSeek}）`,
  ).toBe(countAfterFirst);

  await page.close();
});
