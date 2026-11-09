// Regression: v1.8.42 non-ASR 雙語改走獨立 overlay + multi-segment dedup 不殘留
//
// 背景:v1.8.41 之前 non-ASR 雙語把譯文 innerHTML `<br>` 串原文寫進 native segment,
// 2 行英文時譯文擠掉第二行(image 7-8)。v1.8.42 改為走獨立 <shinkansen-yt-overlay>
// shadow DOM,native segment 保留原文不動,overlay .src/.tgt 顯示中英;同時藏 native CC
// (_setAsrHidingMode CSS hide target 上推到 .ytp-caption-window-container 確保
// 所有 caption-window 子節點都被遮)。
//
// 還修了 v1.8.42 一個關鍵 multi-segment dedup bug:
//   - LLM 多段合併翻譯時,captionMap 設 covered[0]=trans, covered[k>=1]=''
//   - 純中文 non-ASR 舊邏輯 `if (cached) _setSegmentText(...)` 把 cached='' 視作 falsy
//     → segment 2 textContent 沒被清空 → 殘留英文(image 13)
//   - 修為 `if (el.textContent !== cached) _setSegmentText(el, cached)`,
//     cached='' 也寫(清空 segment)
//
// 驗證(三個 case + 一個 hide CSS class):
//   1. non-ASR 雙語 cache hit:segment 不動、overlay .src 含原文、.tgt 含譯文
//   2. non-ASR 雙語 multi-segment dedup:seg1 cached=trans / seg2 cached=''
//      → segment textContent 都不變、overlay .src 含 seg1+seg2 原文 join('\n')、
//        .tgt 含一行譯文(僅 seg1 cached 非空)
//   3. 純中文 non-ASR multi-segment dedup:seg1 cached=trans / seg2 cached=''
//      → seg1 textContent = trans、seg2 textContent = '' (這是 v1.8.42 修的關鍵)
//   4. _applyBilingualMode(true) 在 non-ASR 下:player root 加 shinkansen-asr-active
//      class + host 設 bilingual attr(雙語藏 native + overlay 取代視覺位置)
//
// SANITY CHECK(已驗):
//   - case 1 / case 2:把 replaceSegmentEl 內 `if (isBilingual)` 還原成
//     v1.8.41 的 `if (isBilingual && cached) { el.innerHTML = original<br>cached }`
//     → case 1 fail(segment innerHTML 被改成「原文<br>譯文」、overlay 不動)
//     → case 2 fail(seg2 cached='' 走 else if 分支被 _setSegmentText('') 清空,
//                   或 seg1 segment innerHTML 被改)
//   - case 3:把純中文 path 的 `if (el.textContent !== cached)` 還原成
//     `if (cached && el.textContent !== cached)` → seg2 textContent 保留英文 → fail
//   - case 4:_applyBilingualMode 內 `_setAsrHidingMode(shouldHideNative)` 拿掉
//     → player class 沒掛上 → fail

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-bilingual-overlay';
const SEG1_TEXT = 'English line one';
const SEG2_TEXT = 'English line two';
const TRANS_FULL = '完整中文整段譯文';

test('youtube-bilingual-overlay (case 1): non-ASR 雙語 cache hit 不動 segment,overlay 寫入原文+譯文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 設定 non-ASR 雙語 active 狀態 + populate captionMap(seg1 → 完整譯文)
  await evaluate(`
    const SK = window.__SK;
    SK.YT.active = true;
    SK.YT.isAsr = false;
    SK.YT.config = { bilingualMode: true };
    SK.YT.captionMap.clear();
    SK.YT.captionMap.set('english line one', ${JSON.stringify(TRANS_FULL)});
    // 確保 overlay host 存在
    SK._applyBilingualMode(true);
  `);

  // 觸發 cache hit:呼叫 replaceSegmentEl(seg1)
  await evaluate(`window.__SK._replaceSegmentEl(document.getElementById('seg1'));`);

  const r = await evaluate(`
    (() => {
      const seg1 = document.getElementById('seg1');
      const seg2 = document.getElementById('seg2');
      const host = document.querySelector('shinkansen-yt-overlay');
      const srcEl = host?.shadowRoot?.querySelector('.src');
      const tgtEl = host?.shadowRoot?.querySelector('.tgt');
      return {
        seg1Text: seg1.textContent,
        seg1HtmlHasBr: seg1.innerHTML.includes('<br>'),
        seg2Text: seg2.textContent,
        hostBilingualAttr: host?.getAttribute('bilingual'),
        srcText: srcEl?.textContent || '',
        srcHidden: srcEl?.hidden,
        tgtText: tgtEl?.textContent || '',
      };
    })()
  `);

  // segment 不被動(雙語下 native 原文交給 overlay 取代,segment 保留)
  expect(r.seg1Text, 'seg1 textContent 應保留英文,不被改成「原文<br>譯文」').toBe(SEG1_TEXT);
  expect(r.seg1HtmlHasBr, 'seg1 innerHTML 不應含 <br>(舊路徑會 inject「原文<br>譯文」)').toBe(false);
  expect(r.seg2Text, 'seg2 textContent 也應保留英文').toBe(SEG2_TEXT);
  // overlay 顯示中英
  expect(r.hostBilingualAttr, 'host 應有 bilingual="true" attr').toBe('true');
  expect(r.srcHidden, '雙語下 .src 不該 hidden').toBe(false);
  expect(r.srcText, '.src 應含 seg1 原文(seg2 cached=undefined 不收)').toBe(SEG1_TEXT);
  expect(r.tgtText, '.tgt 應含完整譯文').toBe(TRANS_FULL);

  await page.close();
});

test('youtube-bilingual-overlay (case 2): multi-segment dedup,seg2 cached=`` 也不清 segment,overlay .src 收兩行原文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    const SK = window.__SK;
    SK.YT.active = true;
    SK.YT.isAsr = false;
    SK.YT.config = { bilingualMode: true };
    SK.YT.captionMap.clear();
    // multi-segment dedup:seg1 拿到合併譯文,seg2 設空字串
    SK.YT.captionMap.set('english line one', ${JSON.stringify(TRANS_FULL)});
    SK.YT.captionMap.set('english line two', '');
    SK._applyBilingualMode(true);
  `);

  // 兩個 segment 都觸發 replaceSegmentEl
  await evaluate(`
    window.__SK._replaceSegmentEl(document.getElementById('seg1'));
    window.__SK._replaceSegmentEl(document.getElementById('seg2'));
  `);

  const r = await evaluate(`
    (() => {
      const seg1 = document.getElementById('seg1');
      const seg2 = document.getElementById('seg2');
      const host = document.querySelector('shinkansen-yt-overlay');
      const srcEl = host?.shadowRoot?.querySelector('.src');
      const tgtEl = host?.shadowRoot?.querySelector('.tgt');
      return {
        seg1Text: seg1.textContent,
        seg2Text: seg2.textContent,
        srcText: srcEl?.textContent || '',
        srcHasBr: srcEl?.innerHTML.includes('<br>'),
        tgtText: tgtEl?.textContent || '',
      };
    })()
  `);

  // segment 都保留原文(雙語 dedup 第二段不該被 _setSegmentText('') 清掉)
  expect(r.seg1Text, 'seg1 應保留英文').toBe(SEG1_TEXT);
  expect(r.seg2Text, 'seg2 應保留英文(dedup cached=空字串 不該誤清雙語 segment)').toBe(SEG2_TEXT);
  // overlay .src 應含兩行原文(srcBits 收 cached !== undefined 的 segments)
  expect(r.srcText, '.src 應含 seg1 + seg2 原文').toContain(SEG1_TEXT);
  expect(r.srcText, '.src 應含 seg2 原文(這是修 image 14「英文少一行」的關鍵)').toContain(SEG2_TEXT);
  expect(r.srcHasBr, '兩行原文 join(\\n) 寫入後應有 <br>').toBe(true);
  // tgt 只一行(seg2 cached='' 不 push transBits,避免重複)
  expect(r.tgtText, '.tgt 應只含一行譯文(seg2 dedup cached=空字串 不重複)').toBe(TRANS_FULL);

  await page.close();
});

test('youtube-bilingual-overlay (case 3): 純中文 non-ASR multi-segment dedup,seg2 cached=`` 也要清空 segment', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    const SK = window.__SK;
    SK.YT.active = true;
    SK.YT.isAsr = false;
    SK.YT.config = { bilingualMode: false };  // 純中文模式
    SK.YT.captionMap.clear();
    SK.YT.captionMap.set('english line one', ${JSON.stringify(TRANS_FULL)});
    SK.YT.captionMap.set('english line two', '');  // dedup 空字串
  `);

  // 兩個 segment 都觸發 replaceSegmentEl
  await evaluate(`
    window.__SK._replaceSegmentEl(document.getElementById('seg1'));
    window.__SK._replaceSegmentEl(document.getElementById('seg2'));
  `);

  const r = await evaluate(`
    (() => {
      const seg1 = document.getElementById('seg1');
      const seg2 = document.getElementById('seg2');
      return {
        seg1Text: seg1.textContent,
        seg2Text: seg2.textContent,
      };
    })()
  `);

  // 純中文模式:seg1 替換成譯文,seg2 cached='' 也要寫(清空 segment)
  // — 這是 v1.8.42 修的關鍵 bug(image 13:純中文兩行字幕殘留英文第二行)
  expect(r.seg1Text, 'seg1 應被替換成中文譯文').toBe(TRANS_FULL);
  expect(r.seg2Text, 'seg2 應被清空(dedup cached=空字串 也要寫;舊版 if (cached) gate 漏掉)').toBe('');

  await page.close();
});

test('youtube-bilingual-overlay (case 4): _applyBilingualMode(true) 在 non-ASR 下加 hide class + bilingual attr', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    const SK = window.__SK;
    SK.YT.active = true;
    SK.YT.isAsr = false;
    SK.YT.config = { bilingualMode: true };
    SK._applyBilingualMode(true);
  `);

  const r = await evaluate(`
    (() => {
      const player = document.querySelector('.html5-video-player');
      const host = document.querySelector('shinkansen-yt-overlay');
      const styleEl = document.getElementById('shinkansen-asr-hide-css');
      return {
        playerHasAsrClass: player?.classList?.contains('shinkansen-asr-active'),
        hostExists: !!host,
        hostBilingualAttr: host?.getAttribute('bilingual'),
        stylesheetInjected: !!styleEl,
        stylesheetCoversContainer: styleEl?.textContent?.includes('.shinkansen-asr-active .ytp-caption-window-container'),
      };
    })()
  `);

  // truth table:non-ASR + bilingual=true → shouldHideNative=true → 加 class
  expect(r.playerHasAsrClass, 'non-ASR 雙語下 player root 應加 shinkansen-asr-active class(藏 native CC)').toBe(true);
  expect(r.hostExists, '雙語下 _ensureOverlay 應建出 host').toBe(true);
  expect(r.hostBilingualAttr, 'host 應有 bilingual=true attr').toBe('true');
  expect(r.stylesheetInjected, 'hide CSS stylesheet 應被注入').toBe(true);
  expect(r.stylesheetCoversContainer, 'CSS rule 應 target .ytp-caption-window-container(常駐 wrapper)').toBe(true);

  await page.close();
});
