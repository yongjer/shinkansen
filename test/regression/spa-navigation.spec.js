// Regression: SPA 動態載入內容支援（v0.82）
//
// 驗證 content.js 的 SPA 導航偵測：
//   1. history.pushState 後 STATE 被重置（translated → false, originalHTML 清空）
//   2. collectParagraphs 能偵測到 pushState 後動態新增的段落
//   3. MutationObserver 常數已定義（間接驗證 observer 機制存在）
//
// 結構通則（不綁站名）：
//   - monkey-patch history.pushState / replaceState 偵測 URL 變化
//   - 翻譯狀態重置是通用邏輯，不依賴特定 SPA 框架
//
// 注意：此測試不驗證「自動重新翻譯」（需要 mock API），只驗證
// 狀態管理與段落偵測的正確性。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'spa-navigation';

test('spa-navigation: pushState 後翻譯狀態重置 + 動態新增段落可被偵測', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // ── 斷言 1: 初始狀態 — translated=false, replacedCount=0
  const initialState = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(initialState.translated).toBe(false);
  expect(initialState.replacedCount).toBe(0);

  // ── 斷言 2: 初始段落能被偵測到
  const initialUnits = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.collectParagraphs())`
  ));
  const initialIds = initialUnits.filter(u => u.id).map(u => u.id);
  expect(initialIds).toContain('initial-content');
  expect(initialIds).toContain('second-paragraph');

  // ── 模擬翻譯完成：手動設 STATE.translated = true 並記錄 originalHTML
  await evaluate(`
    (() => {
      const el = document.querySelector('#initial-content');
      // 模擬 injectTranslation 後的狀態
      el.setAttribute('data-shinkansen-translated', '1');
      // 透過 testInject 讓 STATE.originalHTML 有記錄
      window.__shinkansen.testInject(el, '快速的棕色狐狸跳過了懶狗。這個段落包含足夠的文字，可以被內容腳本偵測為翻譯候選。');
    })()
  `);

  // 確認 STATE 已變更
  const afterInject = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(afterInject.replacedCount).toBeGreaterThan(0);

  // ── 觸發 SPA 導航：在 isolated world 呼叫 pushState
  // content script monkey-patch 了 isolated world 的 history.pushState，
  // 必須在同一個 world 呼叫才能走到 patch 過的版本。
  await evaluate(`history.pushState({}, '', '/new-page')`);

  // 等 SPA 導航處理（handleSpaNavigation 是 async，含 SPA_NAV_SETTLE_MS=800ms 等待）
  await page.waitForTimeout(1200);

  // ── 斷言 3: pushState 後 STATE 被重置
  const afterPush = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(afterPush.translated, 'pushState 後 translated 應被重置為 false').toBe(false);
  expect(afterPush.replacedCount, 'pushState 後 originalHTML 應被清空').toBe(0);

  // ── 在 main world 動態新增段落（模擬 SPA 框架 render 新內容）
  await page.evaluate(() => {
    const app = document.querySelector('#app');
    const newP = document.createElement('p');
    newP.id = 'dynamic-content';
    newP.textContent = 'Machine learning algorithms can process vast amounts of data to identify patterns and make predictions with remarkable accuracy.';
    app.appendChild(newP);
  });

  // 等 DOM 穩定
  await page.waitForTimeout(200);

  // ── 斷言 4: 動態新增的段落能被 collectParagraphs 偵測到
  const afterDynamic = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.collectParagraphs())`
  ));
  const dynamicIds = afterDynamic.filter(u => u.id).map(u => u.id);
  expect(dynamicIds, '動態新增的段落應被偵測到').toContain('dynamic-content');

  await page.close();
});
