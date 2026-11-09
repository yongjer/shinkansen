// Regression: YouTube SPA 導航後字幕翻譯自動重啟（v1.3.1）
//
// 驗證 content-youtube.js 的 yt-navigate-finish handler：
// 當字幕翻譯原本是啟動狀態（YT.active = true），使用者切換到另一個影片後，
// translateYouTubeSubtitles() 應在 500ms 後自動被呼叫，且 YT.active 應回到 true。
//
// 觸發條件（結構通則）：
//   - YT.active = true（字幕翻譯已啟動）
//   - 頁面 dispatch `yt-navigate-finish` 事件（YouTube SPA 導航完成）
//   - isYouTubePage() 回傳 true（在 /watch 頁面）
//   - wasActive = true → shouldRestart = true → 500ms 後呼叫 translateYouTubeSubtitles
//
// 如果 v1.3.1 修正失效（handler 沒有呼叫 translateYouTubeSubtitles），
// translateCallCount 應為 0，YT.active 應為 false。
//
// SANITY CHECK 已完成（2026-04-16）：
//   移除 yt-navigate-finish handler 裡的 shouldRestart 區塊後，
//   translateCallCount 為 0、YT.active 為 false，測試正確 fail。
//   還原後呼叫次數回到 1，測試 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-spa-navigate';

test('youtube-spa-navigate: yt-navigate-finish 後 translateYouTubeSubtitles 應自動重啟', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-content', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // ── 步驟 1: 覆寫 isYouTubePage → 永遠回傳 true
  // 真實頁面不在 www.youtube.com/watch，所以必須 override 讓 handler 不直接 return
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // ── 步驟 2: 安裝 translateYouTubeSubtitles spy
  // 替換原始函式，記錄呼叫次數並模擬 YT.active = true（真實流程的行為）
  await evaluate(`
    window.__ytTranslateCallCount = 0;
    window.__SK.translateYouTubeSubtitles = async function() {
      window.__ytTranslateCallCount++;
      window.__SK.YT.active = true;
    };
  `);

  // ── 步驟 3: 設 YT.active = true（模擬字幕翻譯已啟動）
  // handler 讀取 wasActive = YT.active，這讓 shouldRestart = true，
  // 不需要依賴 chrome.storage.sync 的 autoTranslate 設定
  await evaluate(`window.__SK.YT.active = true`);

  // ── 步驟 4: dispatch yt-navigate-finish
  // 真實 YouTube SPA 導航時 YouTube 自己 dispatch 此事件
  await evaluate(`window.dispatchEvent(new CustomEvent('yt-navigate-finish'))`);

  // ── 步驟 5: 等待 async handler 執行完 + 500ms setTimeout + 額外安全邊界
  // handler 流程：event → async 讀 storage → shouldRestart = true → setTimeout(500ms) → 呼叫
  await page.waitForTimeout(750);

  // ── 斷言 1: translateYouTubeSubtitles 應被呼叫恰好 1 次
  const callCount = await evaluate('window.__ytTranslateCallCount');
  expect(
    callCount,
    `translateYouTubeSubtitles 應被呼叫 1 次（實際：${callCount} 次）`,
  ).toBe(1);

  // ── 斷言 2: YT.active 應為 true（由 spy 設置，代表重啟成功）
  const active = await evaluate('window.__SK.YT.active');
  expect(
    active,
    'YT.active 應為 true（translateYouTubeSubtitles 已重啟字幕翻譯）',
  ).toBe(true);

  await page.close();
});
