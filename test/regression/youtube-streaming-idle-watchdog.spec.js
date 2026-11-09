// Regression: v1.10.46 批次 3-2 — streaming batch 0 donePromise 無 watchdog
//
// 痛點：first_chunk 之前有 3s fallback，但 first_chunk 之後 `await stream.donePromise`
// 沒有任何 timeout——SW 中途死亡（iOS 有實證）時 STREAMING_DONE / ERROR 永不到，
// donePromise 永久 pending → 該 windowStartMs 永久留在 translatingWindows →
// seek 回此視窗到 reload 前都空白（per-window 防重入鎖死）。
//
// 修法位置：shinkansen/content-youtube.js _runBatch0Streaming
//   - idle watchdog：每收到本 stream 任何訊息重置計時（STREAM_IDLE_TIMEOUT_MS 20s,
//     SK._streamIdleTimeoutMs 為 spec 縮短逾時的 override seam)
//   - 逾時 reject donePromise → 呼叫端既有 mid-failure catch 走 non-streaming fallback
//   - DONE / ERROR / ABORTED / cleanup 都清計時器
//
// 驗證方式：isolated world 內包一層 chrome.runtime.onMessage.addListener 捕捉
// streaming listener，手動餵 STREAMING_FIRST_CHUNK 後「斷訊」（模擬 SW 死亡）,
// 驗 watchdog 逾時 → fallback 批次送出 → 視窗正常收尾（translatingWindows 清空 +
// translatedWindows 標記 + captionMap 有譯文）。
//
// 訊號層界定：本 spec 驗「斷訊後的恢復路徑」完整走通；不驗真實 SW 被 OS 回收的
// 觸發層（harness 殺不掉 SW，該層靠 iOS 實機體感）。
//
// SANITY 紀錄（已驗證，2026-06-11）:
//   暫時把 `_resetIdleWatchdog` 改成 no-op（開頭 return）→ 斷訊後 donePromise
//   永久 pending → fallback 永不觸發 → case 1 fail（視窗收尾斷言失敗）。還原 pass。
//   另：本 spec 初版同時暴露既有 bug——streaming 成功路徑在 settled 後提前 return,
//   跳過底部 epilogue → streaming 視窗永遠不進 translatedWindows（seek-back 整批重送）。
//   v1.10.46 一併移除該提前 return,case 1 / case 2 的「translatedWindows 標記」斷言
//   即鎖此修法。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';
const VIDEO_ID = 'testABC1234';

const JSON3_SINGLE = JSON.stringify({
  events: [{ tStartMs: 0, segs: [{ utf8: 'hello world' }] }],
});

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=${VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 捕捉 streaming listener（content script 動態註冊）+ mock sendMessage。
  // fixture 只 1 條字幕 → batches = [1 unit]，沒有 batch 1+ →
  // 任何 TRANSLATE_SUBTITLE_BATCH 呼叫都只可能是 batch 0 的 non-streaming fallback。
  await evaluate(`
    window.__capturedListeners = [];
    (() => {
      const ev = chrome.runtime.onMessage;
      const origAdd = ev.addListener.bind(ev);
      ev.addListener = (fn) => { window.__capturedListeners.push(fn); return origAdd(fn); };
    })();
    window.__streamIds = [];
    window.__fallbackCalls = 0;
    window.__abortCalls = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
        window.__streamIds.push(msg.payload.streamId);
        return { started: true };
      }
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__fallbackCalls++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return { ok: true, result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
      }
      if (msg && msg.type === 'STREAMING_ABORT') { window.__abortCalls++; return { ok: true }; }
      return { ok: true };
    };
    window.__SK._streamIdleTimeoutMs = 400; // 縮短 watchdog 逾時讓測試快速
    window.__SK.YT.active = true;
  `);
  return { page, evaluate };
}

function dispatchCaptions() {
  return `
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en',
        responseText: ${JSON.stringify(JSON3_SINGLE)},
      }
    }));
  `;
}

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

test.describe('youtube-streaming-idle-watchdog', () => {
  test('case 1: first_chunk 後斷訊（SW 死亡）→ watchdog 逾時 → non-streaming fallback 完整收尾', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(dispatchCaptions());
    expect(await waitFor(page, evaluate, `window.__streamIds.length > 0`), 'streaming 請求應送出').toBe(true);

    // 餵 first_chunk 後就「斷訊」——沒有 SEGMENT / DONE / ERROR
    await evaluate(feedStreamMessage(`'STREAMING_FIRST_CHUNK'`, `{}`));

    // watchdog（400ms）逾時 → donePromise reject → mid-failure catch → fallback 批次
    expect(
      await waitFor(page, evaluate, `window.__fallbackCalls > 0`),
      'watchdog 逾時後應觸發 non-streaming fallback（無 watchdog 時 donePromise 永久 pending）',
    ).toBe(true);

    // 視窗應正常收尾：不留 translatingWindows、標 translatedWindows、譯文進 captionMap
    expect(
      await waitFor(page, evaluate, `window.__SK.YT.translatingWindows.size === 0 && window.__SK.YT.translatedWindows.has(0)`),
      '視窗應正常收尾（translatingWindows 清空 + translatedWindows 標記）',
    ).toBe(true);
    const trans = await evaluate(`window.__SK.YT.captionMap.get('hello world') ?? ''`);
    expect(trans, 'fallback 譯文應寫入 captionMap').toBe('[ZH] hello world');

    await page.close();
  });

  test('case 2: 正常 stream(SEGMENT + DONE)→ watchdog 不誤觸發，不走 fallback', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(dispatchCaptions());
    expect(await waitFor(page, evaluate, `window.__streamIds.length > 0`), 'streaming 請求應送出').toBe(true);

    await evaluate(feedStreamMessage(`'STREAMING_FIRST_CHUNK'`, `{}`));
    await evaluate(feedStreamMessage(`'STREAMING_SEGMENT'`, `{ segmentIdx: 0, translation: '你好世界' }`));
    await evaluate(feedStreamMessage(`'STREAMING_DONE'`, `{ hadMismatch: false, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } }`));

    expect(
      await waitFor(page, evaluate, `window.__SK.YT.translatedWindows.has(0)`),
      '正常 stream 應完成視窗',
    ).toBe(true);

    // 等超過 watchdog 逾時（400ms）再驗：DONE 後 watchdog 已清，不得誤觸發 fallback
    await page.waitForTimeout(800);
    expect(await evaluate(`window.__fallbackCalls`), '正常完成不得走 fallback').toBe(0);
    const trans = await evaluate(`window.__SK.YT.captionMap.get('hello world') ?? ''`);
    expect(trans, 'streaming 譯文應寫入 captionMap').toBe('你好世界');

    await page.close();
  });
});
