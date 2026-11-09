// Regression: v1.8.53 CLEAR_CACHE 必須同時 reset YT in-memory 翻譯狀態
//
// 痛點:使用者按 popup「清除翻譯快取」後拖進度條到任意位置,期待:
//   1. 看到「翻譯中…」status(代表系統正在重新翻譯)
//   2. 翻譯結果出來
// 實際(v1.8.52 之前):
//   - status 不出現(onSeeked guard `!translatedWindows.has(newWindowStart)` 擋住)
//   - translateWindowFrom 也被同 Set 擋住(line 1785),不重發 API
//   - 字幕保持英文(captionMap 雖在 in-memory 仍有,但若使用者下次 reload 就完全 cache miss)
// 等於「清快取」名實不符。
//
// 修法位置:
//   1. shinkansen/content-youtube.js:新增 SK.YT._resetTranslationStateForCacheClear()
//      清 captionMap / translatedWindows / displayCues / translatedUpToMs /
//      captionMapCoverageUpToMs / _firstCacheHitLogged + hideCaptionStatus + 清 ASR overlay
//      (不清 rawSegments / active / sessionUsage / translatingWindows—讓 session 延續)
//   2. shinkansen/content.js:Debug Bridge CLEAR_CACHE 觸發時呼叫該 helper
//   3. shinkansen/background.js:CLEAR_CACHE handler 完成 storage clear 後 broadcast
//      'YT_RESET_AFTER_CACHE_CLEAR' 給所有 tabs(涵蓋 popup 按鈕直接發訊息的 path)
//   4. shinkansen/content.js:加 message listener 接 'YT_RESET_AFTER_CACHE_CLEAR'
//
// 結構通則:本 spec 鎖「Debug Bridge 觸發 CLEAR_CACHE 後,YT.captionMap /
// translatedWindows / displayCues 必清空」。不依賴 popup UI / chrome.tabs broadcast
// (那條 path 在 Playwright extension fixture 內難模擬,留 manual + e2e gate)。
//
// SANITY CHECK 紀錄(已驗證,2026-05-05):
//   把 SK.YT._resetTranslationStateForCacheClear 改成 noop → spec fail
//   (captionMap.size 仍是 預設值,translatedWindows.size 仍是 預設值)。
//   還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';

test.describe('youtube-clear-cache-resets-memory', () => {
  test('CLEAR_CACHE 後 captionMap / translatedWindows / displayCues 全清空', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

    const { evaluate } = await getShinkansenEvaluator(page);

    // 預先把 in-memory 填得「像有翻過幾個 window」的樣子
    await evaluate(`
      window.__SK.YT.captionMap.set('hello', '哈囉');
      window.__SK.YT.captionMap.set('world', '世界');
      window.__SK.YT.translatedWindows.add(0);
      window.__SK.YT.translatedWindows.add(30000);
      window.__SK.YT.displayCues = [{ startMs: 0, endMs: 3000, text: '哈囉', targetText: '哈囉' }];
      window.__SK.YT.translatedUpToMs = 60000;
      window.__SK.YT.captionMapCoverageUpToMs = 60000;
      window.__SK.YT._firstCacheHitLogged = true;
      // 給 rawSegments / active 設值,驗證它們不被誤清
      window.__SK.YT.rawSegments = [{ text: 'hello', normText: 'hello', startMs: 0 }];
      window.__SK.YT.active = true;
      window.__SK.YT.videoId = 'testABC1234';
    `);

    // 先驗 setup 成功
    const before = await evaluate(`({
      mapSize: window.__SK.YT.captionMap.size,
      windowsSize: window.__SK.YT.translatedWindows.size,
      displayCuesLen: window.__SK.YT.displayCues.length,
      translatedUpToMs: window.__SK.YT.translatedUpToMs,
      coverageMs: window.__SK.YT.captionMapCoverageUpToMs,
      firstHitLogged: window.__SK.YT._firstCacheHitLogged,
      rawCount: window.__SK.YT.rawSegments.length,
      active: window.__SK.YT.active,
      videoId: window.__SK.YT.videoId,
    })`);
    expect(before.mapSize).toBe(2);
    expect(before.windowsSize).toBe(2);
    expect(before.displayCuesLen).toBe(1);
    expect(before.translatedUpToMs).toBe(60000);

    // 觸發 Debug Bridge CLEAR_CACHE(走 content.js handler → 呼叫 reset helper)
    await evaluate(`
      new Promise(r => {
        window.addEventListener('shinkansen-debug-response', e => r(e.detail), { once: true });
        window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: { action: 'CLEAR_CACHE' } }));
        setTimeout(() => r('TIMEOUT'), 3000);
      })
    `);

    // 驗 reset 結果
    const after = await evaluate(`({
      mapSize: window.__SK.YT.captionMap.size,
      windowsSize: window.__SK.YT.translatedWindows.size,
      displayCuesLen: window.__SK.YT.displayCues.length,
      translatedUpToMs: window.__SK.YT.translatedUpToMs,
      coverageMs: window.__SK.YT.captionMapCoverageUpToMs,
      firstHitLogged: window.__SK.YT._firstCacheHitLogged,
      rawCount: window.__SK.YT.rawSegments.length,
      active: window.__SK.YT.active,
      videoId: window.__SK.YT.videoId,
    })`);

    // 應清:翻譯結果 / 已翻 window / display cues / 高水位線 / cache hit log 旗標
    expect(after.mapSize, 'captionMap 應清空').toBe(0);
    expect(after.windowsSize, 'translatedWindows 應清空').toBe(0);
    expect(after.displayCuesLen, 'displayCues 應清空').toBe(0);
    expect(after.translatedUpToMs, 'translatedUpToMs 應歸零').toBe(0);
    expect(after.coverageMs, 'captionMapCoverageUpToMs 應歸零').toBe(0);
    expect(after.firstHitLogged, '_firstCacheHitLogged 應重置').toBe(false);

    // 不該清:rawSegments(captionsXHR 攔截來的原始字幕) / active / videoId
    expect(after.rawCount, 'rawSegments 不該被清(原始字幕資料應保留)').toBe(1);
    expect(after.active, 'active 不該被清(session 應延續)').toBe(true);
    expect(after.videoId, 'videoId 不該被清').toBe('testABC1234');

    await page.close();
  });
});
