// Regression: spa-abort-unwind-guard (v1.10.46 批次 1-3)
//
// Fixture: test/regression/fixtures/spa-abort-unwind-guard.html
//
// Bug:SPA 導航打斷翻譯時,resetForSpaNavigation(content-spa.js)abort 舊輪並清掉
// STATE.abortController + originalHTML;但舊輪的 in-flight 批次(最長 90s)settle 回來
// 後走 abort-unwind 分支,無條件 restoreOriginalHTMLAndReset()——此時 STATE.originalHTML
// 裡已是「新頁/新輪」的備份 → 新頁譯文整批被沖回原文 + 跳莫名「已取消」toast。
// _earlyRestoredAborts 只在快速鍵取消時加入,SPA reset 路徑沒加 → 擋不住。
//
// 修法(content.js translatePage + translatePageGoogle 的 unwind 分支):
//   identity guard——只有 `STATE.abortController === myAbortController`(abort 來源
//   沒接手頁面 state)才允許 unwind 還原 + 取消 toast。SPA reset 會把 abortController
//   清 null(或被新輪換掉)→ 舊輪 unwind 變 no-op。
//
// 本 spec 走完整真實路徑:translatePage run1(慢批次 in-flight)→ 模擬 SPA reset
// (與 content-spa.js resetForSpaNavigation 相同的 state 操作)→ run2 快速翻完 →
// run1 批次 settle unwind → 斷言 run2 譯文仍在(沒被沖回原文)。
//
// SANITY 紀錄(已驗證,2026-06-11):
//   暫時把 unwind 分支的 stillOwnsRun 條件改成恆 true(等效拿掉 guard)→
//   「run1 unwind 不得沖掉 run2 譯文」fail(三段 [ZH2] 譯文被 restore 回英文原文)
//   → 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'spa-abort-unwind-guard';

test('SPA reset 打斷後,舊輪 unwind 不得把新輪譯文沖回原文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para-1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock 訊息層:streaming 失敗 → non-streaming TRANSLATE_BATCH。
  // 第 1 次 TRANSLATE_BATCH(run1)delay 3s 模擬 in-flight 慢批次;
  // 之後(run2)立即回 '[ZH2] ' + 原文。
  await evaluate(`
    window.__batchCall = 0;
    chrome.storage.sync.get = async function(keys) {
      return {
        apiKey: 'test-key-not-used',
        glossary: { enabled: false },
        partialMode: { enabled: false, maxUnits: 25 },
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 20,
        maxCharsPerBatch: 100000,
      };
    };
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        return { ok: false, error: 'streaming disabled in test' };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCall++;
        const call = window.__batchCall;
        const texts = (msg.payload && msg.payload.texts) || [];
        const reply = {
          ok: true,
          result: texts.map(t => '[ZH' + call + '] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
        if (call === 1) {
          return new Promise(r => setTimeout(() => r(reply), 3000));
        }
        return reply;
      }
      return { ok: true };
    };
  `);

  // run1:啟動翻譯,批次卡在 3s delay
  await evaluate(`
    window.__run1 = window.__SK.translatePage().catch(e => null); null
  `);
  await page.waitForTimeout(600);

  // 確認 run1 真的在翻譯中(批次已送出、還沒注入)
  const midState = JSON.parse(await evaluate(`
    JSON.stringify({
      translating: window.__SK.STATE.translating,
      batchCall: window.__batchCall,
      para1: document.getElementById('para-1').innerText,
    })
  `));
  expect(midState.translating).toBe(true);
  expect(midState.batchCall).toBe(1);
  expect(midState.para1).not.toContain('[ZH');

  // 模擬 SPA 導航 reset(與 content-spa.js resetForSpaNavigation 相同的 state 操作:
  // abort + 清 translating / abortController / originalHTML / translatedHTML)
  await evaluate(`
    (() => {
      const STATE = window.__SK.STATE;
      if (STATE.translating && STATE.abortController) {
        STATE.abortController.abort();
        STATE.translating = false;
        STATE.abortController = null;
      }
      STATE.originalHTML.clear();
      STATE.translatedHTML.clear();
      STATE.translatedHTMLByText && STATE.translatedHTMLByText.clear && STATE.translatedHTMLByText.clear();
      STATE.originalText && STATE.originalText.clear && STATE.originalText.clear();
      STATE.cache.clear();
      STATE.translated = false;
      return null;
    })()
  `);

  // run2:新一輪翻譯(模擬新頁內容翻譯),批次立即回 → 注入 [ZH2]
  await evaluate(`
    window.__run2 = window.__SK.translatePage().catch(e => null); null
  `);
  await page.waitForTimeout(800);

  const afterRun2 = await evaluate(`document.getElementById('para-1').innerText`);
  expect(afterRun2, 'run2 應已注入譯文').toContain('[ZH2]');

  // 等 run1 慢批次 settle → unwind 分支執行完
  await evaluate(`window.__run1`);
  await page.waitForTimeout(300);

  // 核心斷言:run1 unwind 不得把 run2 譯文沖回原文
  const finalState = JSON.parse(await evaluate(`
    JSON.stringify({
      para1: document.getElementById('para-1').innerText,
      para2: document.getElementById('para-2').innerText,
      para3: document.getElementById('para-3').innerText,
      translated: window.__SK.STATE.translated,
    })
  `));
  expect(finalState.para1, 'run1 unwind 不得沖掉 run2 譯文').toContain('[ZH2]');
  expect(finalState.para2, 'run1 unwind 不得沖掉 run2 譯文').toContain('[ZH2]');
  expect(finalState.para3, 'run1 unwind 不得沖掉 run2 譯文').toContain('[ZH2]');
  expect(finalState.translated, 'STATE.translated 不得被舊輪 unwind 清掉').toBe(true);
});
