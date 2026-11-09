// Regression: _setOverlayContent 防 TypeError「Cannot read properties of null (reading 'innerHTML')」
//
// Bug(實機紅字 console):
//   _resetTranslationStateForCacheClear(CLEAR_CACHE 後觸發)用
//     overlay.shadowRoot.querySelector('.window').textContent = ''
//   把 .window 下所有子元素(.cue-block 含 .src / .tgt)一起銷毀。下次
//   _setOverlayContent 走 querySelector('.tgt') → null → tgtEl.innerHTML throw。
//
// 修法(雙保險):
//   1. _resetTranslationStateForCacheClear 改呼叫 _setOverlayContent('')(只清 span
//      內容,結構保留)
//   2. _setOverlayContent 內 tgtEl 為 null 時自動 rebuild .cue-block 結構,讓後續寫入
//      不 throw(防範未來其他 path 不小心又把子元素吃掉)
//
// SANITY:把 (1) 還原成 textContent='',觀察:沒 (2) 會 throw;有 (2) 不 throw 但
// log 多出 rebuild path。本 spec 鎖 (2) 是因為 (1) 已 cover 在 _resetTranslationState
// 路徑,(2) 是「外部不論誰把子元素清掉,都不該 crash」的通用防護。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-window-retry';

test('overlay-tgt-null case 1: _resetTranslationStateForCacheClear 後 _setOverlayContent 不 throw', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  // 啟動 ASR 模式 + ensureOverlay 建出 host
  await evaluate(`
    window.__SK.YT.isAsr = true;
    window.__SK.YT.active = true;
    window.__SK.YT.config = { windowSizeS: 30, lookaheadS: 10, bilingualMode: false };
    window.__SK.YT.videoEl = document.querySelector('video');
    // 先寫一筆 cue 進去產生 .tgt 內容
    window.__SK.YT.displayCues = [{ startMs: 0, endMs: 5000, sourceText: 'Hello', targetText: '哈囉' }];
  `);

  // 觸發 _resetTranslationStateForCacheClear(CLEAR_CACHE in-memory reset)
  // 此步驟若回到舊 implementation 會砍掉 .cue-block
  await evaluate(`window.__SK.YT._resetTranslationStateForCacheClear()`);

  // 直接呼叫 _setOverlayContent 模擬下一次 _updateOverlay 寫 overlay 的路徑
  await evaluate(`window.__SK._setOverlayContent('嗨', undefined)`);
  await page.waitForTimeout(100);

  // 驗:沒有 TypeError 被 throw + .tgt 在 shadow DOM 內仍可被 querySelect
  const result = await evaluate(`(() => {
    const host = document.querySelector('shinkansen-yt-overlay');
    if (!host || !host.shadowRoot) return { hasHost: false };
    return {
      hasHost: true,
      hasTgt: !!host.shadowRoot.querySelector('.tgt'),
      hasSrc: !!host.shadowRoot.querySelector('.src'),
      hasWindow: !!host.shadowRoot.querySelector('.window'),
      tgtText: host.shadowRoot.querySelector('.tgt')?.textContent || '',
    };
  })()`);

  expect(result.hasHost, '_setOverlayContent 不該 throw,overlay host 應仍在').toBe(true);
  expect(result.hasWindow, '.window 應仍在').toBe(true);
  expect(result.hasTgt, '★ 核心斷言:reset 後 .tgt 應仍可被 querySelect').toBe(true);
  expect(result.hasSrc, '.src 應仍在').toBe(true);

  await page.close();
});

test('overlay-tgt-null case 2: 外部破壞 .cue-block 後 _setOverlayContent 自動 rebuild', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(`
    window.__SK.YT.isAsr = true;
    window.__SK.YT.active = true;
    window.__SK.YT.config = { windowSizeS: 30, lookaheadS: 10, bilingualMode: false };
    window.__SK.YT.videoEl = document.querySelector('video');
    window.__SK.YT.displayCues = [{ startMs: 0, endMs: 5000, sourceText: 'Hi', targetText: '嗨' }];
  `);

  // 先讓 overlay 寫一次內容(確保 host + cue-block 都建好)
  await evaluate(`window.__SK._setOverlayContent('哈囉', undefined)`);
  await page.waitForTimeout(100);

  // 模擬「外部 path」把 .window 子元素全砍掉(回到 v1.9.21 bug 狀態)
  await evaluate(`
    const host = document.querySelector('shinkansen-yt-overlay');
    const win = host?.shadowRoot?.querySelector('.window');
    if (win) win.textContent = '';
  `);

  // 確認被砍了
  const before = await evaluate(`
    !!document.querySelector('shinkansen-yt-overlay')?.shadowRoot?.querySelector('.tgt')
  `);
  expect(before, 'baseline:外部破壞後 .tgt 應暫時消失').toBe(false);

  // 直接呼叫 _setOverlayContent('嗨') — 模擬 _updateOverlay 找到 cue 後寫 overlay 的路徑
  // (test 環境沒呼 attachVideoListener,timeupdate event 沒 listener;改直接驗 helper)
  await evaluate(`window.__SK._setOverlayContent('嗨', undefined)`);
  await page.waitForTimeout(100);

  // 驗:_setOverlayContent 自動 rebuild .cue-block + .tgt 結構
  const after = await evaluate(`(() => {
    const host = document.querySelector('shinkansen-yt-overlay');
    return {
      hasTgt: !!host?.shadowRoot?.querySelector('.tgt'),
      hasSrc: !!host?.shadowRoot?.querySelector('.src'),
    };
  })()`);

  expect(after.hasTgt, '★ 核心斷言:_setOverlayContent rebuild .tgt 結構').toBe(true);
  expect(after.hasSrc, '_setOverlayContent rebuild .src 結構').toBe(true);

  await page.close();
});
