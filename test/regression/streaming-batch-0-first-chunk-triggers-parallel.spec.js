// Regression: v1.8.0 streaming batch 0 — first_chunk 抵達後同步 dispatch batch 1+
//
// 鎖兩件事:
//   1. batch 0 走 TRANSLATE_BATCH_STREAM 訊息(不是 TRANSLATE_BATCH)
//   2. SW 回 STREAMING_FIRST_CHUNK 後,batch 1+ 在 < 100ms 內被 dispatch(同步並行)
//
// Mock 策略:
//   - 監聽 browser.runtime.onMessage.addListener,把所有 content.js 註冊的 listener 存到 array
//   - mock browser.runtime.sendMessage:
//     - TRANSLATE_BATCH_STREAM:回 { started: true } + 200ms 後手動 fire STREAMING_FIRST_CHUNK 給 listeners
//     - TRANSLATE_BATCH:記錄呼叫時間
//   - 驗證:
//     * batch 0 用 STREAM 訊息送(callTimes 內 streamCount === 1)
//     * 200ms 之前 TRANSLATE_BATCH 不該被送(因為 first_chunk 還沒到)
//     * 200ms 之後 batch 1 / batch 2 在 < 100ms 內同步送出(first_chunk 觸發並行)
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 content.js runBatch0Streaming 的 firstChunkOrTimeout 改成 always
//   { kind: 'failed' } → 走 fallback,batch 0 用 TRANSLATE_BATCH 而非 STREAM →
//   streamCount=0 fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('streaming-batch-0-first-chunk-triggers-parallel: batch 0 走 STREAM,first_chunk 後 batch 1+ 同步 dispatch', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    window.__streamCount = 0;
    window.__batchCallTimes = [];
    window.__startTime = 0;
    window.__streamId = null;

    // 收集 onMessage listener,讓 spec 可手動 fire STREAMING_* 訊息
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
      return { maxConcurrentBatches: 10, maxUnitsPerBatch: 10, maxCharsPerBatch: 100000 };
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        window.__streamCount += 1;
        window.__streamId = msg.payload.streamId;
        // 200ms 後 fire STREAMING_FIRST_CHUNK 給 content.js listener,
        // 接著 50ms 後 fire STREAMING_DONE(讓 streaming 完成,主流程 await 解開)
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId: window.__streamId } });
          }
          setTimeout(() => {
            for (const fn of window.__listeners) {
              fn({ type: 'STREAMING_DONE', payload: {
                streamId: window.__streamId,
                usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0 },
                totalSegments: 25,
                hadMismatch: false,
                finishReason: 'STOP',
              } });
            }
          }, 50);
        }, 200);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        return { ok: true, aborted: false };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCallTimes.push(performance.now() - window.__startTime);
        await new Promise(r => setTimeout(r, 100));
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

  // 45 fake units → batch 0=25(streaming) + batch 1=10 + batch 2=10
  await evaluate(`
    (() => {
      const root = document.createElement('div');
      root.id = '__fake-root';
      for (let i = 0; i < 45; i++) {
        const p = document.createElement('p');
        p.textContent = 'fake unit ' + i + ' here we have some text to translate';
        root.appendChild(p);
      }
      document.body.appendChild(root);
      window.__fakeUnits = Array.from(root.children).map(el => ({ kind: 'element', el }));
      window.__startTime = performance.now();
      window.__translatePromise = window.__SK.translateUnits(window.__fakeUnits).catch(e => null);
      return null;
    })()
  `);

  // 改用 page-side polling 取代 page.waitForTimeout 寫死毫秒——避免高負載下 SW
  // cold-start latency 把 100ms / 300ms wait 推爆。Atomic snapshot:在 streamCount=1
  // 的同一個 microtask 內讀 batchCount,避免「等 streamCount → 回 spec → 再讀 batchCount」
  // 之間 first_chunk 的 200ms 計時器搶先 fire 造成誤判。
  const atStreamSent = await evaluate(`
    new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__streamCount === 1) {
          resolve({ streamCount: window.__streamCount, batchCount: window.__batchCallTimes.length });
        } else if (Date.now() - start > 5000) {
          reject(new Error('waited 5s for streamCount === 1'));
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    })
  `);
  expect(atStreamSent.streamCount, 'batch 0 應走 STREAM 訊息(STREAM 計數 = 1)').toBe(1);
  expect(atStreamSent.batchCount, 'first_chunk 之前 TRANSLATE_BATCH 不該被送').toBe(0);

  // 等 batch 1 + batch 2 都 dispatch 出去(first_chunk 200ms timer fire 後 SK 會
  // 同步並行送)。Atomic resolve 拿到當下 batchCallTimes,不再寫死等 300ms。
  const result = await evaluate(`
    new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__batchCallTimes.length >= 2) {
          resolve({
            streamCount: window.__streamCount,
            batchCallTimes: window.__batchCallTimes.slice(),
            batchCount: window.__batchCallTimes.length,
          });
        } else if (Date.now() - start > 5000) {
          reject(new Error('waited 5s for batchCount >= 2'));
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    })
  `);

  expect(result.batchCount, '應送 2 筆 TRANSLATE_BATCH(batch 1 + batch 2)').toBe(2);

  const [t1, t2] = result.batchCallTimes;

  // batch 1 應在 first_chunk(~200ms)後立刻送 → > 180ms
  expect(t1, `batch 1 應在 first_chunk 後送(預期 > 180ms,實際 ${t1.toFixed(1)}ms)`).toBeGreaterThan(180);
  // batch 1 跟 batch 2 應同步並行 dispatch(差距 < 50ms)
  const gap12 = t2 - t1;
  expect(gap12, `batch 1/2 應同步並行 dispatch(差 < 50ms,實際 ${gap12.toFixed(1)}ms)`).toBeLessThan(50);

  await page.close();
});
