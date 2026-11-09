// Regression: 翻譯中按快速鍵取消 → 按下當下立即還原原文，不等 in-flight 批次
//
// 真實需求（Jimmy，2026-06-05）：原行為按快速鍵取消後跳「取消中」toast，要等
// in-flight 批次回來（非 streaming 批次沒有網路層取消機制，大批次 + 慢模型可能
// 數秒～十幾秒）主流程 unwind 才還原原文，與使用者「按了就該馬上恢復」的期待不符。
//
// 修法（content.js）：
//   1. abortInProgressTranslation() — 三個取消入口（translatePage /
//      translatePageGoogle / handleTranslatePreset）共用：abort() + 立即
//      restoreOriginalHTMLAndReset() + 「已取消」toast + _abortRestoredEarly flag
//   2. 三條注入路徑（Gemini performBatchInject / Google forEach 前 / streaming
//      performInject）注入前檢查 signal.aborted——擋「還原後晚到的批次回應把
//      譯文注回乾淨頁面」（runBatch await 後原本沒有再檢查 aborted）
//   3. 主流程 unwind 的 abort 分支看 flag 去重，不重複 restore / toast
//
// 本 spec 鎖兩個觀察點：
//   A. 取消當下（不等任何延遲）DOM 已還原為原文
//   B. 晚到的 TRANSLATE_BATCH 回應（mock 1500ms 延遲）不再注入，頁面維持原文
//
// SANITY CHECK 紀錄（已驗證，2026-06-05）：
//   Break A：把 abortInProgressTranslation 內 restoreOriginalHTMLAndReset() 註解掉
//     → 斷言 A（取消當下 zhCount=0）fail。還原後 pass。
//   Break B：把 performBatchInject 開頭的 `if (signal?.aborted) return;` 註解掉
//     → 斷言 B（等待 2.5s 後 zhCount 仍為 0）fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('abort-immediate-restore: 取消當下立即還原原文 + 遲到批次不再注入', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // mock 訊息層：
  //   - TRANSLATE_BATCH_STREAM（batch 0）：快速 fire FIRST_CHUNK → 全部 SEGMENT
  //     （'[ZH] ' 前綴）→ DONE，讓 batch 0 譯文真的注入 DOM
  //   - TRANSLATE_BATCH（batch 1+）：1500ms 假延遲 → 取消後才回來的「遲到批次」
  await evaluate(`
    window.__lateBatchReturned = 0;
    window.__listeners = [];
    const origAdd = browser.runtime.onMessage.addListener.bind(browser.runtime.onMessage);
    const origRemove = browser.runtime.onMessage.removeListener.bind(browser.runtime.onMessage);
    browser.runtime.onMessage.addListener = (fn) => { window.__listeners.push(fn); return origAdd(fn); };
    browser.runtime.onMessage.removeListener = (fn) => {
      const i = window.__listeners.indexOf(fn);
      if (i >= 0) window.__listeners.splice(i, 1);
      return origRemove(fn);
    };

    chrome.storage.sync.get = async function(keys) {
      return { maxConcurrentBatches: 1, maxUnitsPerBatch: 10, maxCharsPerBatch: 100000 };
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        const streamId = msg.payload.streamId;
        const texts = msg.payload.texts;
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId } });
          }
          texts.forEach((t, idx) => {
            for (const fn of window.__listeners) {
              fn({ type: 'STREAMING_SEGMENT', payload: { streamId, segmentIdx: idx, translation: '[ZH] ' + t } });
            }
          });
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_DONE', payload: { streamId, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0 }, totalSegments: texts.length, hadMismatch: false } });
          }
        }, 50);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        return { ok: true };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        // 遲到批次：1500ms 後才回（模擬取消時仍 in-flight 的批次）
        await new Promise(r => setTimeout(r, 1500));
        window.__lateBatchReturned += 1;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUSD: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 40 段假內容 → batch 0 (streaming) + 後續 batch（maxUnitsPerBatch=10）
  await evaluate(`
    (() => {
      const root = document.createElement('div');
      root.id = '__fake-root';
      for (let i = 0; i < 40; i++) {
        const p = document.createElement('p');
        p.textContent = 'fake unit ' + i + ' here we have some text to translate';
        root.appendChild(p);
      }
      document.body.appendChild(root);
      return null;
    })()
  `);

  // 走真實 translatePage 入口
  await evaluate(`
    window.__translateDone = false;
    window.__SK.translatePage()
      .then(() => { window.__translateDone = true; })
      .catch(() => { window.__translateDone = true; });
    null
  `);

  // 輪詢等 batch 0 streaming 譯文注入 DOM（idle gate 最長 1500ms fallback）
  {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const injected = await evaluate(
        `document.body.innerText.includes('[ZH]') && window.__SK.STATE.translating === true`,
      );
      if (injected) break;
      await page.waitForTimeout(50);
    }
  }

  const beforeCancel = await evaluate(`({
    zhVisible: document.body.innerText.includes('[ZH]'),
    translating: window.__SK.STATE.translating,
    lateBatchReturned: window.__lateBatchReturned,
  })`);
  expect(beforeCancel.zhVisible, 'batch 0 譯文應已注入').toBe(true);
  expect(beforeCancel.translating, '應處於翻譯中').toBe(true);
  expect(beforeCancel.lateBatchReturned, '遲到批次尚未回應（仍 in-flight）').toBe(0);

  // 取消：翻譯中再呼叫一次 translatePage（同快速鍵路徑），abort 分支在第一個
  // await 之前同步執行 → evaluate 回來時還原應已完成
  await evaluate(`window.__SK.translatePage(); null`);

  // 斷言 A：取消當下（不等遲到批次）DOM 已還原為原文
  const afterCancel = await evaluate(`({
    zhCount: (document.body.innerText.match(/\\[ZH\\]/g) || []).length,
    markedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
    originalHTMLSize: window.__SK.STATE.originalHTML.size,
    translated: window.__SK.STATE.translated,
    lateBatchReturned: window.__lateBatchReturned,
  })`);
  expect(afterCancel.lateBatchReturned, '取消當下遲到批次仍未回應（證明沒等它）').toBe(0);
  expect(afterCancel.zhCount, '取消當下譯文應已全部還原為原文').toBe(0);
  expect(afterCancel.markedCount, '取消當下 data-shinkansen-translated 應全清').toBe(0);
  expect(afterCancel.originalHTMLSize, '取消當下 originalHTML 應已清空').toBe(0);
  expect(afterCancel.translated, '取消後不應標記為已翻譯').toBe(false);

  // 等遲到批次回應 + 主流程 unwind（1500ms 延遲 + 餘裕）
  {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const done = await evaluate(`window.__translateDone === true && window.__lateBatchReturned > 0`);
      if (done) break;
      await page.waitForTimeout(100);
    }
  }

  // 斷言 B：遲到批次回應不得再注入，頁面維持原文
  const afterLateBatch = await evaluate(`({
    zhCount: (document.body.innerText.match(/\\[ZH\\]/g) || []).length,
    markedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
    translating: window.__SK.STATE.translating,
    translateDone: window.__translateDone,
    lateBatchReturned: window.__lateBatchReturned,
  })`);
  expect(afterLateBatch.lateBatchReturned, '遲到批次應已回應').toBeGreaterThanOrEqual(1);
  expect(afterLateBatch.translateDone, '主流程應已 unwind 完成（不卡）').toBe(true);
  expect(afterLateBatch.zhCount, '遲到批次回應不得把譯文注回已還原頁面').toBe(0);
  expect(afterLateBatch.markedCount, '遲到批次不得標記 data-shinkansen-translated').toBe(0);
  expect(afterLateBatch.translating, 'unwind 後 translating 應為 false').toBe(false);

  await page.close();
});
