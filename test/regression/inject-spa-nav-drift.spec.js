// Regression: inject-spa-nav-drift（對應 v1.10.57 修的「已翻譯頁面點 url 延伸子孫 url
// 後 Shinkansen 無法判斷分頁是否已翻譯」殭屍狀態 bug）
//
// Fixture: test/regression/fixtures/spa-nav-drift.html
// 結構：一般文章頁多個獨立段落 element，模擬 SPA / 同文件子頁導航時站點保留舊節點。
// Bug：
//   1) toggle / popup 的「翻了沒」只信記憶體 STATE.translated boolean；SPA reset 把它
//      歸零卻留 DOM marker → STATE 說沒翻、畫面是譯文 → popup 顯示錯、toggle 走錯動作。
//   2) resetForSpaNavigation 清掉 originalHTML 等 Map 但不移除仍 connected 節點上的
//      data-shinkansen-translated → 孤兒譯文 → sticky 續翻看到譯文（isAlreadyInTarget
//      全跳）空翻 → STATE.translated 永遠回不來 → 永久殭屍。
// 修法（結構性通則，不綁站點）：
//   A) SK.isPageTranslated() 以 DOM 注入痕跡為單一裁決源，toggle / popup / RESTORE 改讀它。
//   B) resetForSpaNavigation 清 Map 前先還原仍 connected 的 marker 節點（剝回原文）。
//
// SANITY 紀錄（已驗證）：
//   - Part A 斷言：把 content.js GET_STATE 改回 `translated: STATE.translated`、或把
//     content-ns.js 的 isPageTranslated 改成 `return STATE.translated` → 「pageTranslated
//     反映 DOM 而非 raw flag」斷言 fail；還原 → pass。
//   - Part B 斷言：把 content-spa.js resetForSpaNavigation 內的 strip-connected 還原迴圈
//     註解掉 → SPA nav 後 markers 仍 > 0、isPageTranslated 仍 true 斷言 fail；還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'spa-nav-drift';

// 譯文（繁中）—— testInject 直接注入，免打 API。
const TRANS_P1 = '這是回歸測試使用的第一段原始英文內容。';
const TRANS_P2 = '這是回歸測試使用的第二段原始英文內容。';

test('Part A：isPageTranslated 以 DOM marker 為裁決源，raw STATE.translated 漂移也不誤判', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#p1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await runTestInject(evaluate, '#p1', TRANS_P1);

  // 製造殭屍：DOM 有 marker，但把記憶體 raw flag 強制設 false（模擬 SPA reset 後的漂移）
  await evaluate(`window.__shinkansen.setTestState({ translated: false })`);

  const probe = await evaluate(`(() => ({
    rawTranslated: window.__shinkansen.getState().translated,
    pageTranslated: window.__SK.isPageTranslated(),
    domMarkers: document.querySelectorAll('[data-shinkansen-translated]').length,
  }))()`);

  expect(probe.rawTranslated, 'raw STATE.translated 已被設為漂移值 false').toBe(false);
  expect(probe.domMarkers, 'DOM 仍有譯文 marker').toBeGreaterThan(0);
  // 核心：裁決源跟 DOM 走，不被 raw flag 漂移帶偏
  expect(probe.pageTranslated, 'isPageTranslated 必須以 DOM 為準 → true').toBe(true);

  await page.close();
});

test('Part B：SPA 子頁導航 reset 還原仍 connected 的 marker 節點，不留孤兒譯文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#p1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 翻兩段 → DOM 有 marker、STATE.originalHTML 有還原資料
  await runTestInject(evaluate, '#p1', TRANS_P1);
  await runTestInject(evaluate, '#p2', TRANS_P2);
  // 模擬「已翻譯頁面」狀態；關掉 sticky 避免 reset 後 async 續翻打 API（本 spec 無 key）
  await evaluate(`window.__shinkansen.setTestState({ translated: true, stickyTranslate: false })`);

  const before = await evaluate(`(() => ({
    markers: document.querySelectorAll('[data-shinkansen-translated]').length,
    originalHTMLSize: window.__shinkansen.getState().replacedCount,
    p1Text: document.querySelector('#p1').textContent.trim(),
    pageTranslated: window.__SK.isPageTranslated(),
  }))()`);
  expect(before.markers, '翻譯後兩段都有 marker').toBe(2);
  expect(before.pageTranslated, '翻譯後 isPageTranslated=true').toBe(true);
  expect(before.p1Text, 'p1 顯示譯文').toBe(TRANS_P1);

  // 觸發 SPA 子頁導航：在 isolated world 呼叫被 content-spa.js patch 過的 pushState。
  // resetForSpaNavigation 是 handleSpaNavigation 第一個 await 之前的同步段，pushState
  // 回來時 strip 已跑完。
  await evaluate(`history.pushState({}, '', '/child-article'); 'ok'`);

  // 輪詢確認 reset 已套用（同步應已完成，保險起見輪詢）
  const start = Date.now();
  let after = null;
  while (Date.now() - start < 3000) {
    after = await evaluate(`(() => ({
      markers: document.querySelectorAll('[data-shinkansen-translated]').length,
      originalHTMLSize: window.__shinkansen.getState().replacedCount,
      p1Text: document.querySelector('#p1').textContent.trim(),
      pageTranslated: window.__SK.isPageTranslated(),
      url: location.pathname,
    }))()`);
    if (after.markers === 0) break;
    await page.waitForTimeout(50);
  }

  expect(after.url, 'URL 已換到子頁').toBe('/child-article');
  // 核心：reset 後不得留孤兒 marker（殭屍狀態的來源）
  expect(after.markers, 'SPA reset 後殘留 marker 必須為 0').toBe(0);
  expect(after.pageTranslated, 'reset 後 isPageTranslated 與 DOM 一致為 false').toBe(false);
  expect(after.originalHTMLSize, 'reset 後還原資料已清空').toBe(0);
  // 仍 connected 的節點被剝回原文（不是停在中文譯文 → 續翻才不會被 isAlreadyInTarget 跳掉）
  expect(after.p1Text, 'p1 被剝回英文原文').toContain('First paragraph of original English');

  await page.close();
});
