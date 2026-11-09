// Regression: 翻譯中按快速鍵取消（abort）後 icon badge 紅點必須清掉
//
// 真實 bug（Jimmy 回報，2026-06-05）：啟動整頁翻譯 → 翻譯中按快速鍵取消 →
// 頁面正確還原為原文、popup 顯示「就緒」，但 toolbar icon 右上角紅點殘留，
// 看起來像「目前正在翻譯」。
//
// 根因：translatePage / translatePageGoogle 開始時送 SET_BADGE_TRANSLATED
// 點亮紅點；翻譯完成後的還原走 restorePage() 有送 CLEAR_BADGE，但翻譯中
// abort 走的共用 helper restoreOriginalHTMLAndReset()（Gemini + Google 兩個
// abort call site 共用）只還原 DOM + 重置 STATE，漏送 CLEAR_BADGE。
//
// 修法（content.js restoreOriginalHTMLAndReset）：helper 尾端補
// SK.safeSendMessage({ type: 'CLEAR_BADGE' })——helper 語意即「頁面回到原文
// 狀態」，badge 跟著清是結構性通則，一次覆蓋兩個 abort call site。
//
// 本 spec 驗的訊號層次：content script → background 的 CLEAR_BADGE 訊息有送出
// （mock chrome.runtime.sendMessage 攔截）。不驗 background 端 setBadgeText
// 實際生效（browser.action 在 Playwright 內無法從 content 端觀察），該層由
// background.js CLEAR_BADGE handler（既有路徑，restorePage 同一條）覆蓋。
//
// SANITY CHECK 紀錄（已驗證，2026-06-05）：把 restoreOriginalHTMLAndReset 內
// CLEAR_BADGE 那行註解掉 → clearBadgeCount 斷言 fail（0 !== >=1）；還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('badge-clear-on-abort: 翻譯中 abort → CLEAR_BADGE 必須送出（紅點不殘留）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // mock 訊息層：攔 badge 訊息計數；TRANSLATE_BATCH_STREAM 故意不 fire DONE
  // （維持翻譯中），STREAMING_ABORT 回 STREAMING_ABORTED 解開主流程 donePromise。
  await evaluate(`
    window.__setBadgeCount = 0;
    window.__clearBadgeCount = 0;
    window.__streamId = null;

    window.__listeners = [];
    const origAdd = browser.runtime.onMessage.addListener.bind(browser.runtime.onMessage);
    const origRemove = browser.runtime.onMessage.removeListener.bind(browser.runtime.onMessage);
    browser.runtime.onMessage.addListener = (fn) => { window.__listeners.push(fn); return origAdd(fn); };
    browser.runtime.onMessage.removeListener = (fn) => {
      const i = window.__listeners.indexOf(fn);
      if (i >= 0) window.__listeners.splice(i, 1);
      return origRemove(fn);
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'SET_BADGE_TRANSLATED') {
        window.__setBadgeCount += 1;
        return { ok: true };
      }
      if (msg && msg.type === 'CLEAR_BADGE') {
        window.__clearBadgeCount += 1;
        return { ok: true };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        window.__streamId = msg.payload.streamId;
        // 100ms 後 fire FIRST_CHUNK，但不 fire DONE → 翻譯持續 in-flight
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId: window.__streamId } });
          }
        }, 100);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_ABORTED', payload: { streamId: window.__streamId } });
          }
        }, 5);
        return { ok: true };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        // 後續 batch 假延遲，讓 abort 有時間視窗
        await new Promise(r => setTimeout(r, 300));
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

  // 走真實 translatePage 入口（不是直接呼叫 translateUnits）——badge 的
  // SET / CLEAR 都掛在這條主流程上
  await evaluate(`
    window.__translatePromise = window.__SK.translatePage()
      .then(() => { window.__translateDone = true; })
      .catch(() => { window.__translateDone = true; });
    null
  `);

  // 輪詢等翻譯進入 in-flight（SET_BADGE_TRANSLATED 已送 + abortController 已建立）
  {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const ready = await evaluate(
        `window.__setBadgeCount > 0 && !!window.__SK.STATE.abortController`,
      );
      if (ready) break;
      await page.waitForTimeout(50);
    }
  }

  const beforeAbort = await evaluate(`({
    setBadgeCount: window.__setBadgeCount,
    clearBadgeCount: window.__clearBadgeCount,
    translating: window.__SK.STATE.translating,
  })`);
  expect(beforeAbort.setBadgeCount, '翻譯開始應送 SET_BADGE_TRANSLATED').toBeGreaterThanOrEqual(1);
  expect(beforeAbort.translating, '應處於翻譯中').toBe(true);
  expect(beforeAbort.clearBadgeCount, 'abort 前不應有 CLEAR_BADGE').toBe(0);

  // 模擬「翻譯中按快速鍵取消」：再呼叫一次 translatePage → 命中
  // `if (STATE.translating) { abort(); return; }` 分支（真實快速鍵同一條 path）
  await evaluate(`window.__SK.translatePage(); null`);

  // 輪詢等 abort 路徑跑完（restoreOriginalHTMLAndReset → CLEAR_BADGE）
  {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const done = await evaluate(`window.__translateDone === true`);
      if (done) break;
      await page.waitForTimeout(50);
    }
  }

  const afterAbort = await evaluate(`({
    clearBadgeCount: window.__clearBadgeCount,
    translating: window.__SK.STATE.translating,
    translated: window.__SK.STATE.translated,
    translateDone: window.__translateDone,
  })`);

  expect(afterAbort.translateDone, 'translatePage promise 應解開（主流程不卡）').toBe(true);
  expect(afterAbort.translating, 'abort 後不應仍在翻譯中').toBe(false);
  expect(afterAbort.translated, 'abort 後不應標記為已翻譯').toBe(false);
  expect(
    afterAbort.clearBadgeCount,
    `abort 取消後必須送 CLEAR_BADGE 清紅點（實際 ${afterAbort.clearBadgeCount} 次）`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});
