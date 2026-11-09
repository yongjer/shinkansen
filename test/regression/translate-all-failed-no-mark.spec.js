// Regression: translate-all-failed-no-mark（對應 code review 2026-07-08 R4(a),dev tail 2.0.7.1 修）
//
// Fixture: 重用 test/regression/fixtures/translate-priority-sort.html（一般多段落頁）
// Bug：全數批次失敗（done=0，典型：API key 沒填 / 失效）仍走成功後流程——
//     標 STATE.translated=true + sticky + rescan + SPA observer:
//     - 下一次快速鍵誤走 restorePage（對乾淨頁跳「已還原」，要按兩次才重翻）
//     - rescan / SPA observer 對注定失敗的頁面反覆重送 API
//     - badge 紅點殘留（run 開頭 SET_BADGE 後沒人清）
// 修法（content.js Gemini 路徑，Google 路徑同修）:
//     `if (done === 0 && failures.length > 0) { CLEAR_BADGE; return; }`
//     在 STATE.translated = true 之前早退。
//
// 本 spec 鎖的訊號層：驗 Gemini 主路徑「全批失敗 → 不標 translated / 送 CLEAR_BADGE /
//   下次快速鍵走重翻不走 restore」整條真實 translatePage 流程（mock 訊息層讓
//   background 全批回 error）。Google 路徑的同款 guard 是同一份事實的鏡像
//   （程式碼同形），本 spec 不重複驅動；streaming batch 0 done 扣回（R4(b)）與
//   crypto.subtle gate(R4(d)）需特定失敗時序，不在本 spec 範圍。
//
// SANITY 紀錄（已驗證，2026-07-08）：把 content.js Gemini 路徑的
//   `if (done === 0 && failures.length > 0)` guard 整段註解掉 →
//   「全批失敗後 STATE.translated 應為 false」「應送 CLEAR_BADGE」
//   「第二次呼叫應重翻（批次計數應增加）」斷言 fail。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('translate-all-failed-no-mark: 全批失敗不標 translated、清 badge、下次快速鍵重翻', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // mock 訊息層：所有翻譯批次回失敗（模擬 API key 沒填 / 失效）;badge 訊息計數
  await evaluate(`
    window.__batchCalls = 0;
    window.__setBadgeCount = 0;
    window.__clearBadgeCount = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'SET_BADGE_TRANSLATED') { window.__setBadgeCount += 1; return { ok: true }; }
      if (msg && msg.type === 'CLEAR_BADGE') { window.__clearBadgeCount += 1; return { ok: true }; }
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        // streaming 起始被拒 → content 端 fallback 對 batch 0 重送 non-streaming
        return { ok: false, started: false, error: 'API key 未設定（test）' };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCalls += 1;
        return { ok: false, error: 'API key 未設定（test）' };
      }
      return { ok: true };
    };
  `);

  // ── 第一輪：走真實 translatePage，全批失敗 ──
  await evaluate(`
    window.__run1Done = false;
    window.__SK.translatePage()
      .then(() => { window.__run1Done = true; })
      .catch(() => { window.__run1Done = true; });
    null
  `);
  {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (await evaluate(`window.__run1Done === true`)) break;
      await page.waitForTimeout(100);
    }
  }

  const afterRun1 = await evaluate(`({
    run1Done: window.__run1Done,
    batchCalls: window.__batchCalls,
    setBadgeCount: window.__setBadgeCount,
    clearBadgeCount: window.__clearBadgeCount,
    translated: window.__SK.STATE.translated,
    markedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
  })`);

  expect(afterRun1.run1Done, '第一輪 translatePage 應完成（不卡死）').toBe(true);
  expect(afterRun1.batchCalls, '應至少送過一個翻譯批次（路徑有跑到）').toBeGreaterThanOrEqual(1);

  // 斷言（核心 1）：全批失敗不標 translated、DOM 無翻譯標記
  expect(afterRun1.translated, '全批失敗後 STATE.translated 應為 false').toBe(false);
  expect(afterRun1.markedCount, '全批失敗後 DOM 不應有 data-shinkansen-translated').toBe(0);

  // 斷言（核心 2）:badge 紅點不殘留（run 開頭 SET 過 → 失敗後必須 CLEAR）
  expect(afterRun1.setBadgeCount, 'run 開頭應送過 SET_BADGE_TRANSLATED').toBeGreaterThanOrEqual(1);
  expect(
    afterRun1.clearBadgeCount,
    `全批失敗後應送 CLEAR_BADGE 清紅點（實際 ${afterRun1.clearBadgeCount} 次）`,
  ).toBeGreaterThanOrEqual(1);

  // ── 第二輪：再按一次快速鍵 → 應走重翻（送新批次），不是 restorePage ──
  await evaluate(`
    window.__run2Done = false;
    window.__batchCallsBeforeRun2 = window.__batchCalls;
    window.__SK.translatePage()
      .then(() => { window.__run2Done = true; })
      .catch(() => { window.__run2Done = true; });
    null
  `);
  {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (await evaluate(`window.__run2Done === true`)) break;
      await page.waitForTimeout(100);
    }
  }

  const afterRun2 = await evaluate(`({
    run2Done: window.__run2Done,
    batchCallsBefore: window.__batchCallsBeforeRun2,
    batchCallsAfter: window.__batchCalls,
  })`);

  expect(afterRun2.run2Done, '第二輪 translatePage 應完成').toBe(true);
  // 斷言（核心 3）：第二次呼叫走重翻（批次計數增加）而非 restorePage（計數不變）
  expect(
    afterRun2.batchCallsAfter,
    `第二次快速鍵應重翻（批次 ${afterRun2.batchCallsBefore} → ${afterRun2.batchCallsAfter}，不變 = 誤走 restorePage）`,
  ).toBeGreaterThan(afterRun2.batchCallsBefore);

  await page.close();
});
