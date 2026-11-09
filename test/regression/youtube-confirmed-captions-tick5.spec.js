// Regression: v1.10.46 批次 3-4 — bridge 確認有字幕後 tick5 不取消 → preroll 廣告期誤報「沒有字幕」
//
// 痛點：queryAndDecide 的 has-captions 分支只 showWaitingStatus 就 return,
// tick5Handle 只在 no-captions 分支被 clear——preroll 廣告期播放器還沒發 timedtext XHR,
// 5 秒一到照樣彈「本影片未提供 CC 字幕」error toast（明明 bridge 已確認有字幕軌）。
//
// 修法位置：shinkansen/content-youtube.js
//   1. has-captions 分支設 captionsConfirmedByBridge
//   2. tick5 命中 captionsConfirmedByBridge → 不彈 toast、維持等待狀態，
//      改排 _scheduleMwebCcRetry 有界重試（每 3s 催一次 forceSubtitleReload，上限 20 次）
//      + 65s 最後檢查收尾（retry 預算用完仍沒字幕才彈 toast，不讓等待狀態掛死）
//   3. 有界重試平台共用：桌面 .ytp-subtitles-button 路徑各分支結尾也排 _scheduleMwebCcRetry
//
// 反向保護：bridge 沒回應 / 確認沒字幕的 toast 行為由既有
// youtube-no-subtitle-toast.spec.js / youtube-no-caption-tracks.spec.js 鎖住。
//
// SANITY 紀錄（已驗證，2026-06-11）:
//   暫時把 tick5 的 `if (captionsConfirmedByBridge)` 分支註解掉 → 5s 後照樣彈
//   subtitleNotAvailable toast → case 1 fail。還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';
const VIDEO_ID = 'testABC1234';

test('youtube-confirmed-captions-tick5: bridge 確認有字幕 → 5s 後不彈「沒有字幕」toast，維持等待 + 排有界重試', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=${VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 跳過 caption track chooser（它走同一條 bridge，會把測試訊號攪在一起）
  await evaluate(`chrome.storage.sync.set({ ytSubtitle: { preferOriginalTrack: false } })`);

  // toast spy（toast shadow DOM 是 closed mode，讀不到內文，攔 SK.showToast 呼叫）
  await evaluate(`
    window.__toastCalls = [];
    window.__SK.showToast = (kind, msg, opts) => { window.__toastCalls.push({ kind, msg }); };
    chrome.runtime.sendMessage = async function() { return { ok: true }; };
  `);

  // bridge responder：回「有字幕軌」（isolated world 同世界 dispatch,detail 可讀）
  await evaluate(`
    window.addEventListener('shinkansen-yt-query-player-response', () => {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('shinkansen-yt-player-response', {
          detail: {
            videoId: '${VIDEO_ID}',
            playerResponseAvailable: true,
            captionTracks: [{ languageCode: 'en' }],
          },
        }));
      }, 0);
    });
  `);

  await evaluate(`window.__SK.translateYouTubeSubtitles()`);

  // 等超過 tick5（5s）再驗
  await page.waitForTimeout(6000);

  const r = await evaluate(`
    (() => {
      const statusEl = document.getElementById('__sk-yt-caption-status');
      return {
        active: window.__SK.YT.active,
        rawSegments: window.__SK.YT.rawSegments.length,
        toastCalls: window.__toastCalls,
        statusText: statusEl ? statusEl.textContent : null,
        retryScheduled: !!window.__SK.YT._mwebCcRetryTimer || (window.__SK.YT._mwebCcRetries || 0) > 0,
      };
    })()
  `);

  expect(r.active, '翻譯流程應仍啟動').toBe(true);
  expect(r.rawSegments, '本測試不餵字幕資料，rawSegments 應為 0').toBe(0);

  const noAvailToast = r.toastCalls.find(c => /未提供 CC 字幕|no CC subtitles/i.test(c.msg || ''));
  expect(
    noAvailToast,
    `bridge 已確認有字幕，5s 後不得誤報「沒有字幕」。實際 toast 呼叫： ${JSON.stringify(r.toastCalls)}`,
  ).toBeUndefined();

  expect(r.statusText, '等待狀態應維持顯示（不被 tick5 收掉）').toBe('等待字幕資料…');
  expect(r.retryScheduled, '有界 CC retry 應已排程（繼續催播放器發 timedtext XHR）').toBe(true);

  await page.close();
});
