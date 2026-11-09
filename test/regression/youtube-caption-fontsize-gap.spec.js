// Regression: v1.10.26 ASR 字幕字體大小在「人聲停止 / 無字幕空窗」時走樣（暴增）
//
// 背景（使用者回報）：影片繼續播但人聲停止時，自動生成翻譯字幕（ASR overlay）還在，
//   但字體大小走樣——設定 50% 的人看到字突然跳成「目測比 100% 還大」。
//
// Root cause：ASR overlay 每次 _updateOverlay 用 _readNativeCaptionFontSize() 即時讀
//   原生 .ytp-caption-segment 的 computed font-size 寫進 --sk-cue-size。人聲停止時
//   YouTube 把原生 caption（.ytp-caption-segment / .caption-window）從 DOM 移除（無字幕
//   空窗），但我們的 overlay 因「中文閱讀時間補償」延長 endMs 還在顯示譯文。這段空窗期
//   _readNativeCaptionFontSize() 讀不到原生元素 → 掉到 fallback `video.offsetHeight × 0.045`，
//   這個值約等於 YouTube 預設 100% 字幕大小，完全忽略使用者的字幕大小設定 → 字暴增。
//
// 修法（結構性，CLAUDE.md §8）：原生字幕字體大小是「單一事實」，來源元素短暫消失時
//   保留上次讀到的有效值（_lastGoodCaptionFontSize），不用無視使用者設定的影片高度
//   啟發式重算。影片高度啟發式只在「從沒讀到過任何原生字幕」的首次 fallback 才用。
//
// 驗證（fixture：seg font-size:32px、video 高 450 → 啟發式 round(450×0.045)=20px）：
//   1. 有 segment 時讀到 32（真實使用者設定值），並把它 cache 起來
//   2. 移除 segment + caption-window（模擬人聲停止空窗）後再讀 → 仍回 32（沿用 cache），
//      不是 20（影片高度啟發式）
//   3. reset cache + 無任何原生元素（從沒讀過）→ 才回 20（首次 fallback 啟發式）
//
// SANITY CHECK（已驗證）：把 _readNativeCaptionFontSize 內
//   `if (_lastGoodCaptionFontSize > 0) return _lastGoodCaptionFontSize;` 整行 comment 掉
//   → case 2 讀到 20（啟發式）而非 32 → fail。還原修法 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-caption-fontsize-gap';
const SEG_FONT_SIZE = 32;       // fixture inline style
const HEURISTIC_FONT_SIZE = 20; // round(450 × 0.045)

test('youtube-caption-fontsize-gap：人聲停止空窗期沿用上次字體大小，不掉回影片高度啟發式', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK._resetCaptionFontSizeCache();`);

  // case 1：有 segment → 讀到真實 32，並 cache
  const withSeg = await evaluate(`window.__SK._readNativeCaptionFontSize();`);
  expect(withSeg).toBe(SEG_FONT_SIZE);

  // case 2：模擬人聲停止——YouTube 移除原生 caption-window（含 segment）後再讀
  const inGap = await evaluate(`
    document.querySelector('.caption-window').remove();
    window.__SK._readNativeCaptionFontSize();
  `);
  // 沿用 cache 的 32，不是掉回影片高度啟發式 20
  expect(inGap).toBe(SEG_FONT_SIZE);
  expect(inGap).not.toBe(HEURISTIC_FONT_SIZE);

  // case 3：reset cache + 從沒讀過任何原生字幕 → 才用影片高度啟發式
  const firstFallback = await evaluate(`
    window.__SK._resetCaptionFontSizeCache();
    window.__SK._readNativeCaptionFontSize();
  `);
  expect(firstFallback).toBe(HEURISTIC_FONT_SIZE);
});
