// Regression: sticky cross-tab inheritance（v1.4.11 跨 tab sticky 翻譯，v1.4.12 改存 preset slot）
//
// 驗證 shinkansen/background.js 的 stickyTabs Map + `chrome.tabs.onCreated` 繼承邏輯：
// 使用者在 tab A 翻譯後，透過 `window.open` / `target="_blank"` / Cmd+Click 開新 tab B
// → B 會帶 `openerTabId = A.id` → background `onCreated` listener 把 A 的 slot 套給 B
// → B 的 content script 初始化送 `STICKY_QUERY` → 背景回 `shouldTranslate=true, slot=N`
// → content.js 呼叫 `handleTranslatePreset(N)` 自動翻譯。
//
// 策略：不跑完整翻譯流程（避免依賴 mock Gemini API）。直接用 STICKY_SET 訊息把 tab A
// 塞進 stickyTabs Map，再觀察新 tab 的 STICKY_QUERY 回應。這驗證到的正是 cross-tab
// bug surface：`onCreated` listener 對 `openerTabId` 的繼承邏輯。
//
// 兩個 test：
//   (1) 有 opener（window.open）→ 新 tab 繼承 slot
//   (2) 每個 tab 的 sticky 獨立：A 送 STICKY_CLEAR 不影響 B
//
// 「無 opener 不繼承」的情境（真實 Chrome：Ctrl+T 打網址、bookmark、外部 app 開）
// 無法在 Playwright 穩定模擬——`context.newPage()` 會把最近 active tab 設成 opener，
// 與真實手動開新 tab 行為不同。此條結構性保護由 background.js `onCreated` listener 內
// `if (openerId == null) return;` 的 guard 提供，不另寫 regression（若要鎖死，走 jest-unit
// 直接 mock tabs API 與 Map 狀態驗 guard 邏輯會更乾淨）。
//
// SANITY 紀錄（已驗證）：把 background.js `onCreated` listener 的繼承主體
// `stickyTabs.set(tab.id, slot); await persistStickyTabs();` 整段註解掉後，
// test (1) fail（新 tab 的 STICKY_QUERY 回 shouldTranslate=false）。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const SLOT = 2;  // 用 slot 2 (Flash) 測試

// 共用：在指定 page 的 isolated world 送 runtime message，回傳結果
// 用 WeakMap 快取 evaluator：每次 getShinkansenEvaluator 會開新 CDP session 並 wait 500ms，
// 多次 message 重複開會大幅拖慢測試，一個 page 快取一個 evaluator 即可。
const _evalCache = new WeakMap();
async function sendMessageFrom(page, msg) {
  let evaluate = _evalCache.get(page);
  if (!evaluate) {
    evaluate = (await getShinkansenEvaluator(page)).evaluate;
    _evalCache.set(page, evaluate);
  }
  // 包 async IIFE：Runtime.evaluate 的 awaitPromise 只等「表達式本身就是 promise」的情況，
  // 單獨的 `await` 在 top level 會是 syntax error。
  return JSON.parse(
    await evaluate(`(async () => JSON.stringify(await chrome.runtime.sendMessage(${JSON.stringify(msg)})))()`)
  );
}

// 共用：輪詢 STICKY_QUERY 等最多 timeout ms 讓 onCreated listener 完成
async function waitForStickyQuery(page, expectTranslate, timeoutMs = 3000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await sendMessageFrom(page, { type: 'STICKY_QUERY' });
      if (last?.shouldTranslate === expectTranslate) return last;
    } catch (_) { /* page might not be ready yet */ }
    await page.waitForTimeout(100);
  }
  return last;
}

test('sticky-cross-tab: tab A 有 sticky + window.open → tab B 繼承同一 slot', async ({
  context,
  localServer,
}) => {
  // Page A goto fixture (任意有 content script 的頁面即可)
  const pageA = await context.newPage();
  await pageA.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
  await pageA.waitForSelector('#target', { timeout: 10_000 });

  // Page A 送 STICKY_SET 把自己塞進 stickyTabs Map
  const setResp = await sendMessageFrom(pageA, { type: 'STICKY_SET', payload: { slot: SLOT } });
  expect(setResp?.ok, 'STICKY_SET 應成功').toBe(true);

  // Sanity: Page A 的 STICKY_QUERY 應回 shouldTranslate=true, slot=SLOT
  const queryA = await sendMessageFrom(pageA, { type: 'STICKY_QUERY' });
  expect(queryA?.shouldTranslate, 'Page A 設完 sticky 後自己 query 應 true').toBe(true);
  expect(queryA?.slot, 'Page A 的 sticky slot').toBe(SLOT);

  // Page A 觸發 window.open 開 Page B，同時等 context 送出 'page' event
  const pageBPromise = context.waitForEvent('page');
  await pageA.evaluate((url) => { window.open(url, '_blank'); },
    `${localServer.baseUrl}/br-paragraph.html`);
  const pageB = await pageBPromise;
  await pageB.waitForLoadState('domcontentloaded');
  await pageB.waitForSelector('#target', { timeout: 10_000 });

  // 輪詢等待 background 的 onCreated listener 完成繼承
  const queryB = await waitForStickyQuery(pageB, true);

  // 核心斷言：Page B 繼承 sticky
  expect(
    queryB?.shouldTranslate,
    `Page B（有 opener）應繼承 sticky，實際 ${JSON.stringify(queryB)}`,
  ).toBe(true);
  expect(
    queryB?.slot,
    `Page B 應繼承同一 slot (${SLOT})，實際 ${JSON.stringify(queryB)}`,
  ).toBe(SLOT);

  await pageB.close();
  await pageA.close();
});

test('sticky-cross-tab: tab A STICKY_CLEAR 不影響 tab B（per-tab 獨立）', async ({
  context,
  localServer,
}) => {
  const pageA = await context.newPage();
  await pageA.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
  await pageA.waitForSelector('#target', { timeout: 10_000 });

  await sendMessageFrom(pageA, { type: 'STICKY_SET', payload: { slot: SLOT } });

  // 開 Page B 繼承
  const pageBPromise = context.waitForEvent('page');
  await pageA.evaluate((url) => { window.open(url, '_blank'); },
    `${localServer.baseUrl}/br-paragraph.html`);
  const pageB = await pageBPromise;
  await pageB.waitForLoadState('domcontentloaded');
  await pageB.waitForSelector('#target', { timeout: 10_000 });
  const queryBInit = await waitForStickyQuery(pageB, true);
  expect(queryBInit?.shouldTranslate, 'sanity: Page B 一開始應繼承 sticky').toBe(true);

  // Page A 送 STICKY_CLEAR（模擬按快捷鍵還原原文的情境）
  const clearResp = await sendMessageFrom(pageA, { type: 'STICKY_CLEAR' });
  expect(clearResp?.ok).toBe(true);

  // Page A 自己的 query 應變 false
  const queryAAfter = await sendMessageFrom(pageA, { type: 'STICKY_QUERY' });
  expect(
    queryAAfter?.shouldTranslate,
    `Page A 送 STICKY_CLEAR 後自己應為 false，實際 ${JSON.stringify(queryAAfter)}`,
  ).toBe(false);

  // Page B 仍應保留 sticky（per-tab 獨立）
  const queryBAfter = await sendMessageFrom(pageB, { type: 'STICKY_QUERY' });
  expect(
    queryBAfter?.shouldTranslate,
    `Page B 不應被 Page A 的 CLEAR 影響（per-tab 獨立），實際 ${JSON.stringify(queryBAfter)}`,
  ).toBe(true);
  expect(queryBAfter?.slot).toBe(SLOT);

  await pageB.close();
  await pageA.close();
});
