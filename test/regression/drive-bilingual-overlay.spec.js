// Regression: v1.8.54 Drive 雙語字幕比照 YouTube ASR 樣式
//
// 背景:v1.8.53 之前 Drive 雙語走「不關 native CC + 我們自己中文 overlay」雙塊分離;
// 字級不一、兩塊黑底,跟 YouTube ASR 雙語(中英共用一塊黑底)視覺不一致。
// v1.8.54 改成:
//   - overlay shadow DOM 從 .cue 單塊改 .cue-block > .src + .tgt(共用黑底)
//   - 雙語也呼叫 unloadModule captions 把 native CC 關掉
//   - rawSegments 存進 DRIVE,_renderActiveCue 用 [entry.startMs, entry.endMs)
//     從 rawSegments 撈對應時段英文 join 寫入 .src
//   - 純中文模式 .src hidden,只寫 .tgt
//
// 這個 spec 驗純函式行為(_renderActiveCue / _findOverlappingSrcText / overlay shadow DOM 結構),
// 不跑 runtime(localServer 主機名 ≠ drive.google.com,gate 之後的 init/listener 不執行)。
//
// 驗證(四個 case):
//   1. overlay shadow DOM 結構:.cue-block 包 .src + .tgt
//   2. 雙語模式 _renderActiveCue:.src 顯示對應時段英文 + .tgt 顯示譯文,兩者都不 hidden
//   3. 純中文模式 _renderActiveCue:.src hidden + .tgt 顯示譯文
//   4. host 加 popover="manual" attr + showPopover()/hidePopover() callable(fullscreen 解法)
//
// SANITY CHECK(已驗):
//   - case 1:把 _ensureOverlay shadow innerHTML 還原成 v1.8.53 的 `<span class="cue">`
//     → query .cue-block / .src / .tgt 都 null → fail
//   - case 2:把 _renderActiveCue 雙語分支拿掉(srcEl 永遠 hidden)→ srcText 為空 / srcHidden=true → fail
//   - case 3:把純中文分支的 srcEl.hidden=true 拿掉(改成 false)→ srcHidden=false → fail
//   - case 4:把 _ensureOverlay 內 setAttribute('popover','manual') 拿掉 → fail

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'drive-bilingual-overlay';
const ENTRY_TGT = '車輛緩慢行駛通過交叉路口';
const SEG1_SRC = 'The vehicle';
const SEG2_SRC = 'slowly drives through';
const SEG3_SRC = 'the intersection';

test('drive-bilingual-overlay (case 1): overlay shadow DOM 結構為 .cue-block > .src + .tgt', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK._driveEnsureOverlay();`);

  const r = await evaluate(`
    (() => {
      const host = document.querySelector('shinkansen-drive-overlay');
      const shadow = host?.shadowRoot;
      const cueBlock = shadow?.querySelector('.cue-block');
      const srcEl = shadow?.querySelector('.src');
      const tgtEl = shadow?.querySelector('.tgt');
      const oldCueEl = shadow?.querySelector('.cue:not(.cue-block)');
      return {
        hostExists: !!host,
        cueBlockExists: !!cueBlock,
        srcExists: !!srcEl,
        tgtExists: !!tgtEl,
        // .src 跟 .tgt 都直接在 .cue-block 內(共用黑底的關鍵)
        srcParentIsCueBlock: srcEl?.parentElement === cueBlock,
        tgtParentIsCueBlock: tgtEl?.parentElement === cueBlock,
        srcInitialHidden: srcEl?.hidden,
        oldCueElExists: !!oldCueEl,
      };
    })()
  `);

  expect(r.hostExists, 'overlay host 應被建出').toBe(true);
  expect(r.cueBlockExists, '.cue-block 應存在(v1.8.54 結構)').toBe(true);
  expect(r.srcExists, '.src 應存在').toBe(true);
  expect(r.tgtExists, '.tgt 應存在').toBe(true);
  expect(r.srcParentIsCueBlock, '.src 父層應為 .cue-block(共用黑底)').toBe(true);
  expect(r.tgtParentIsCueBlock, '.tgt 父層應為 .cue-block(共用黑底)').toBe(true);
  expect(r.srcInitialHidden, '初始 .src 應 hidden(等 _renderActiveCue 雙語才顯示)').toBe(true);
  expect(r.oldCueElExists, 'v1.8.53 的 .cue 單塊不應再存在').toBe(false);

  await page.close();
});

test('drive-bilingual-overlay (case 2): 雙語模式 _renderActiveCue 寫入 .src 英文 + .tgt 譯文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    const SK = window.__SK;
    const DRIVE = SK.DRIVE;
    DRIVE.bilingualMode = true;
    DRIVE.entries = [{ startMs: 1000, endMs: 4000, text: ${JSON.stringify(ENTRY_TGT)} }];
    // raw segments 涵蓋 [1000, 4000) 內三段 — 一個 entry 對多個 raw(Gemini D' 合句路徑)
    DRIVE.rawSegments = [
      { startMs: 1000, text: ${JSON.stringify(SEG1_SRC)} },
      { startMs: 2000, text: ${JSON.stringify(SEG2_SRC)} },
      { startMs: 3000, text: ${JSON.stringify(SEG3_SRC)} },
      // 區間外的 segment 不該被收進 .src
      { startMs: 4500, text: 'out of range' },
    ];
    DRIVE.currentTimeMs = 2500;
    DRIVE.currentEntryIdx = -1;
    SK._driveEnsureOverlay();
    SK._driveRenderActiveCue();
  `);

  const r = await evaluate(`
    (() => {
      const host = document.querySelector('shinkansen-drive-overlay');
      const shadow = host?.shadowRoot;
      const srcEl = shadow?.querySelector('.src');
      const tgtEl = shadow?.querySelector('.tgt');
      return {
        srcText: srcEl?.textContent || '',
        srcHidden: srcEl?.hidden,
        tgtText: tgtEl?.textContent || '',
      };
    })()
  `);

  expect(r.srcHidden, '雙語下 .src 不該 hidden').toBe(false);
  expect(r.srcText, '.src 應含 entry 區間內三段英文 join').toBe(`${SEG1_SRC} ${SEG2_SRC} ${SEG3_SRC}`);
  expect(r.srcText, '.src 不應含區間外 segment').not.toContain('out of range');
  expect(r.tgtText, '.tgt 應含譯文').toBe(ENTRY_TGT);

  await page.close();
});

test('drive-bilingual-overlay (case 3): 純中文模式 _renderActiveCue .src hidden,只寫 .tgt', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    const SK = window.__SK;
    const DRIVE = SK.DRIVE;
    DRIVE.bilingualMode = false;  // 純中文
    DRIVE.entries = [{ startMs: 1000, endMs: 4000, text: ${JSON.stringify(ENTRY_TGT)} }];
    DRIVE.rawSegments = [
      { startMs: 1000, text: ${JSON.stringify(SEG1_SRC)} },
      { startMs: 2000, text: ${JSON.stringify(SEG2_SRC)} },
    ];
    DRIVE.currentTimeMs = 2500;
    DRIVE.currentEntryIdx = -1;
    SK._driveEnsureOverlay();
    SK._driveRenderActiveCue();
  `);

  const r = await evaluate(`
    (() => {
      const host = document.querySelector('shinkansen-drive-overlay');
      const shadow = host?.shadowRoot;
      const srcEl = shadow?.querySelector('.src');
      const tgtEl = shadow?.querySelector('.tgt');
      return {
        srcText: srcEl?.textContent || '',
        srcHidden: srcEl?.hidden,
        tgtText: tgtEl?.textContent || '',
      };
    })()
  `);

  expect(r.srcHidden, '純中文模式 .src 應 hidden').toBe(true);
  expect(r.srcText, '.src 應為空(純中文不寫原文)').toBe('');
  expect(r.tgtText, '.tgt 應含譯文').toBe(ENTRY_TGT);

  await page.close();
});

test('drive-bilingual-overlay (case 4): host 有 popover="manual" attr 且 showPopover 可呼叫(fullscreen 解法)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK._driveEnsureOverlay();`);

  // 模擬 fullscreen 進場:host.showPopover() 應該可呼叫不 throw
  // (popover API Chrome 117+ / Firefox 125+ 支援,Playwright Chromium 一律有)
  const r = await evaluate(`
    (() => {
      const host = document.querySelector('shinkansen-drive-overlay');
      const popoverAttr = host?.getAttribute('popover');
      const showCallable = typeof host?.showPopover === 'function';
      const hideCallable = typeof host?.hidePopover === 'function';
      let showOk = false;
      let hideOk = false;
      try { host.showPopover(); showOk = true; } catch (e) { showOk = String(e?.message || e); }
      try { host.hidePopover(); hideOk = true; } catch (e) { hideOk = String(e?.message || e); }
      return { popoverAttr, showCallable, hideCallable, showOk, hideOk };
    })()
  `);

  expect(r.popoverAttr, 'host 應有 popover="manual" attr(fullscreen 提升 top layer 用)').toBe('manual');
  expect(r.showCallable, 'showPopover 應為 function').toBe(true);
  expect(r.hideCallable, 'hidePopover 應為 function').toBe(true);
  expect(r.showOk, 'showPopover() 應成功 invoke').toBe(true);
  expect(r.hideOk, 'hidePopover() 應成功 invoke').toBe(true);

  await page.close();
});
