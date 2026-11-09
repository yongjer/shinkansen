// Regression: stream-idle-web-watchdog(對應 v1.10.53 — 網頁主翻譯路徑補 streaming idle
// watchdog;v1.10.46 只加在 YT 字幕路徑,網頁路徑漏掉,Christie's 拍品專文等長 segment
// 在 flash/flash-lite stall 時「最後一段無法結束」永久卡 translating)
//
// Fixture: test/regression/fixtures/stream-idle-web.html(幾段短 <p> → 只有 batch 0)
// 驗:runBatch0Streaming 收到 STREAMING_FIRST_CHUNK 後「斷訊」(沒有 SEGMENT / DONE /
//   ERROR,模擬 Gemini 中途 stall 或 SW 死亡)→ idle watchdog 逾時 → 送 STREAMING_ABORT
//   止血 + reject donePromise → 呼叫端既有 mid-failure catch 走 non-streaming fallback。
//
// 訊號層界定:本 spec 驗「斷訊後的恢復路徑」(watchdog → abort + fallback);不驗真實
//   Gemini 串流為何 stall / 真實 SW 被 OS 回收的觸發層(harness 模擬不出,靠實機體感)。
//
// SANITY 紀錄(已驗證):把 content.js runBatch0Streaming 的 _resetIdleWatchdog 內
//   setTimeout callback 開頭加 `return;`(watchdog 永不 fire)→ FIRST_CHUNK 後斷訊
//   donePromise 永久 pending → __fallbackCalls 維持 0、__abortCalls 維持 0,斷言 fail
//   → 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'stream-idle-web';

function feedStreamMessage(typeExpr, payloadExpr) {
  return `
    (() => {
      const streamId = window.__streamIds[window.__streamIds.length - 1];
      const message = { type: ${typeExpr}, payload: Object.assign({ streamId }, ${payloadExpr}) };
      window.__capturedListeners.forEach(fn => { try { fn(message); } catch (_) {} });
    })()
  `;
}

async function waitFor(page, evaluate, expr, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expr)) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

test('web streaming idle watchdog: first_chunk 後斷訊 → STREAMING_ABORT + non-streaming fallback', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 捕捉 streaming listener(content script 動態 addListener)+ mock sendMessage
  await evaluate(`
    window.__capturedListeners = [];
    (() => {
      const ev = browser.runtime.onMessage;
      const origAdd = ev.addListener.bind(ev);
      ev.addListener = (fn) => { window.__capturedListeners.push(fn); return origAdd(fn); };
    })();
    window.__streamIds = [];
    window.__fallbackCalls = 0;
    window.__abortCalls = 0;
    browser.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        window.__streamIds.push(msg.payload.streamId);
        return { started: true };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__fallbackCalls++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return { ok: true, translations: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
      }
      if (msg && msg.type === 'STREAMING_ABORT') { window.__abortCalls++; return { ok: true }; }
      return { ok: true };
    };
    window.__SK._streamIdleTimeoutMs = 400; // 縮短 watchdog 逾時讓測試快速
  `);

  // 直接驅動 translateUnits(避開 translatePage 的 settings/glossary/badge 機制)
  await evaluate(`
    (() => {
      const units = window.__SK.collectParagraphs(document.querySelector('#content'), {});
      window.__SK.translateUnits(units, {}); // fire,不 await(靠 watchdog → fallback 收尾)
      return units.length;
    })()
  `);

  // 等 streaming 請求送出
  expect(await waitFor(page, evaluate, `window.__streamIds.length > 0`), 'streaming 請求應送出').toBe(true);

  // 餵 first_chunk(讓主流程走過 first_chunk path,不是 first_chunk timeout fallback)後就斷訊
  await evaluate(feedStreamMessage(`'STREAMING_FIRST_CHUNK'`, `{}`));

  // watchdog(400ms)逾時 → 送 STREAMING_ABORT 止血 + reject donePromise → mid-failure fallback
  expect(
    await waitFor(page, evaluate, `window.__abortCalls > 0`),
    'watchdog 逾時應送 STREAMING_ABORT 止血',
  ).toBe(true);
  expect(
    await waitFor(page, evaluate, `window.__fallbackCalls > 0`),
    'watchdog 逾時後應觸發 non-streaming fallback(無 watchdog 時 donePromise 永久 pending)',
  ).toBe(true);

  await page.close();
});
