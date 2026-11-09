// Regression: SPA observer widget loop（v1.2.1）
//
// 驗證 content-spa.js 的 spaObserverSeenTexts Set 去重邏輯：
// 當頁面有一個 setInterval 每秒重設 widget DOM 時，SPA observer 的
// spaObserverRescan() 不應無限觸發——文字相同的 unit 第二次進來時應該
// 被 seenTexts 過濾掉，translateUnits 呼叫次數應 ≤ 2。
//
// 觸發條件（結構通則）：
//   - 頁面有正文 + 一個 setInterval 每秒重設 innerHTML 的 widget
//   - widget 的文字節點不變（相同 textContent），只是 DOM 重建
//   - MutationObserver 持續偵測到 childList 變動，觸發 debounce rescan
//
// 如果 spaObserverSeenTexts 失效，translateUnits 會在 4s 內被呼叫 4 次以上。
// 正確行為：首次翻譯 + 最多 1 次 rescan（共 ≤ 2 次 translateUnits 呼叫）。
//
// SANITY CHECK 已完成（2026-04-16）：
//   移除 seenTexts 過濾後，translateUnits 在 4.5s 內被呼叫 4 次（> 2），測試正確 fail。
//   還原過濾後，呼叫次數回到 1，測試 pass。
//
//   注意：測試在 evaluate 裡把 SPA_OBSERVER_DEBOUNCE_MS 縮短為 200ms，
//   讓 debounce 在兩次 setInterval（1000ms）之間就觸發。若不縮短，
//   兩者同為 1000ms 會讓 debounce 永遠被重設，rescan 永不執行，sanity check 就看不出差異。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'spa-widget-loop';

test('spa-observer-widget-loop: widget 週期性重設 DOM 不應讓 translateUnits 無限呼叫', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-content', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // ── 步驟 0: 縮短 debounce 為 200ms
  // 原始值是 1000ms，與 fixture setInterval（也是 1000ms）同步，
  // 會導致 debounce 永遠被 setInterval 重設、rescan 永不觸發。
  // 縮短為 200ms 後，debounce 在兩次 setInterval 之間就能觸發（1000ms > 200ms）。
  await evaluate(`window.__SK.SPA_OBSERVER_DEBOUNCE_MS = 200`);

  // ── 步驟 1: 在 isolated world 安裝 translateUnits spy
  // 替換 SK.translateUnits，計算被呼叫次數，並回傳假成功結果讓流程正常走完
  await evaluate(`
    (() => {
      window.__translateUnitsCallCount = 0;
      window.__SK.translateUnits = async function(units, opts) {
        window.__translateUnitsCallCount++;
        // 模擬翻譯：把 units 一一注入假譯文，讓 seenTexts 可以正確登記
        for (const unit of units) {
          try {
            window.__shinkansen.testInject(unit.el || unit.startNode?.parentElement, '（已翻譯）');
          } catch (_) {}
        }
        // 呼叫進度 callback 讓 toast 正常更新
        if (opts?.onProgress) opts.onProgress(units.length, units.length);
        return { done: units.length, total: units.length, failures: [], pageUsage: {}, rpdWarning: false };
      };
    })()
  `);

  // ── 步驟 2: 模擬初始翻譯完成
  // 設 STATE.translated = true 並啟動 SPA observer
  await evaluate(`
    (() => {
      window.__SK.STATE.translated = true;
      window.__SK.startSpaObserver();
    })()
  `);

  // ── 步驟 3: 等待 4.5 秒
  // widget setInterval 每秒觸發一次，在這段時間會觸發約 4 次 MutationObserver
  // 若 seenTexts 失效，translateUnits 會被呼叫 4+ 次
  await page.waitForTimeout(4500);

  // ── 斷言: translateUnits 呼叫次數應 ≤ 2
  // 首次進入 rescan：widget 文字是新的，翻譯 1 次（呼叫 1）
  // 後續 rescan：widget 文字已在 seenTexts，全部過濾，translateUnits 不再被呼叫
  // 容許 ≤ 2 以應對 debounce 邊界情況（兩個相鄰 mutation 在 debounce window 內）
  const callCount = await evaluate('window.__translateUnitsCallCount');
  expect(
    callCount,
    `translateUnits 在 4.5s 內被呼叫了 ${callCount} 次，應 ≤ 2（seenTexts 去重失效）`
  ).toBeLessThanOrEqual(2);

  await page.close();
});
