// Regression: v1.10.46 批次 3-5 — SPA 假導航 skip path 不重新 attachVideoListener
//
// 痛點：v1.8.68 加的「同 videoId + active → skip reset」guard 的觸發情境
// （player re-mount / quality 切換 / ad break 結束）正是 video element 可能被重建的
// 情境——舊 element 上的 timeupdate / seeked / ratechange 監聽全斷，字幕推進停擺，
// 而 skip path 什麼都不做直接 return。
//
// 修法位置：shinkansen/content-youtube.js _onYtSpaNavigate skip 分支補
// attachVideoListener()（冪等：同 element early return；新 element 換綁 + 解舊綁）。
//
// 重現結構（fixture）:activate 後把 video element 從 DOM 拔掉、插入新 video,
// 再 fire 同 videoId 的 yt-navigate-finish——無修法時 YT.videoEl 停留在 detached
// 舊 element(document.contains = false)，有修法時換綁到新 element。
//
// SANITY 紀錄（已驗證，2026-06-11）:
//   暫時把 skip 分支的 attachVideoListener() 拿掉 → videoElIsCurrent=false /
//   videoElInDocument=false → fail。還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';
const VIDEO_ID = 'testABC1234';

test('youtube-spa-skip-reattach-video: 同 videoId 假導航 skip path 應重新 attach 新 video element', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=${VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 模擬「字幕翻譯已啟動且綁在當前 video」狀態
  await evaluate(`
    const YT = window.__SK.YT;
    YT.active = true;
    YT.videoId = '${VIDEO_ID}';
    YT.videoEl = document.querySelector('video');
  `);

  // player re-mount：舊 video 拔掉、插入新 video
  await evaluate(`
    (() => {
      const old = document.querySelector('video');
      const player = old.parentElement;
      old.remove();
      const fresh = document.createElement('video');
      player.appendChild(fresh);
    })()
  `);

  // 同 videoId 假導航 → skip path
  await evaluate(`window.dispatchEvent(new CustomEvent('yt-navigate-finish'))`);
  await page.waitForTimeout(200);

  const r = await evaluate(`
    (() => {
      const YT = window.__SK.YT;
      return {
        active: YT.active,
        rawCleared: YT.rawSegments.length === 0,
        videoElIsCurrent: YT.videoEl === document.querySelector('video'),
        videoElInDocument: !!YT.videoEl && document.contains(YT.videoEl),
      };
    })()
  `);

  expect(r.active, 'skip path 不得 stop（同 videoId 仍 active）').toBe(true);
  expect(r.videoElIsCurrent, 'YT.videoEl 應換綁到重建後的新 video element').toBe(true);
  expect(r.videoElInDocument, 'YT.videoEl 不得停留在 detached 舊 element').toBe(true);

  await page.close();
});
