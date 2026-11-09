// Regression: spa-bytext-reuse-restore（對應 code review 2026-07-08 R3(f),dev tail 2.0.7.1 修）
//
// Fixture: test/regression/fixtures/spa-bytext-reuse-restore.html
// 結構：一個走正常注入路徑的段落 + 一個模擬 SPA remount 的「全新元素」（同文字、
//       從未翻譯，spaByTextReuse 以 textContent 命中 byText cache 直接覆寫）。
// Bug:spaByTextReuse 覆寫 innerHTML 前不做 SK.snapshotOnce → reuse 注入的元素
//     不在 STATE.originalHTML（restorePage / resetForSpaNavigation 的迭代源）——
//     按還原後該元素殘留殭屍譯文段（其他段都回原文，它還停在譯文）。
// 修法（content-spa.js spaByTextReuse）：覆寫前 `SK.snapshotOnce?.(unit.el)`——
//     此刻 el 顯示的正是 remount 後的原文，快照即真原文。
//
// 本 spec 鎖的訊號層：驗「reuse 注入 → originalHTML 有 entry → RESTORE 後回原文」
//   整條還原路徑。不驗 SPA observer 對 remount 的偵測時序（virtualized remount
//   的 MutationObserver 觸發屬 spa-prescan / spa-navigate 既有 spec 範圍）。
//
// SANITY 紀錄（已驗證，2026-07-08）：把 content-spa.js spaByTextReuse 的
//   `SK.snapshotOnce?.(unit.el)` 註解掉 → 「originalHTML 應有 reuse 元素 entry」
//   與「RESTORE 後應回原文」斷言 fail（殭屍譯文殘留）。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'spa-bytext-reuse-restore';

test('spa-bytext-reuse-restore: by-text reuse 注入有 snapshot,RESTORE 後不殘留殭屍譯文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Step 1：正常路徑翻譯 #p-normal（讓 originalHTML 非空，restorePage 不走殭屍頁
  // 保底 reload);Step 2：種 byText cache + 對 #p-remounted 跑 spaByTextReuse。
  const afterReuse = await evaluate(`
    (() => {
      const pNormal = document.querySelector('#p-normal');
      const pRemounted = document.querySelector('#p-remounted');
      const origHTML = pRemounted.innerHTML;
      const origText = pRemounted.textContent.trim();

      window.__shinkansen.testInject(pNormal, '正常路徑的譯文段落。');

      const STATE = window.__SK.STATE;
      STATE.translatedHTMLByText.set(origText, '<b>先前翻過的譯文</b>（reuse 注入）');
      const { reused, remaining } = window.__SK.spaByTextReuse([
        { kind: 'element', el: pRemounted },
      ]);

      return {
        origHTML,
        reusedCount: reused.length,
        remainingCount: remaining.length,
        injected: pRemounted.textContent.includes('先前翻過的譯文'),
        marked: pRemounted.getAttribute('data-shinkansen-translated') === '1',
        hasSnapshot: STATE.originalHTML.has(pRemounted),
        snapshotIsOriginal: STATE.originalHTML.get(pRemounted) === origHTML,
      };
    })()
  `);

  expect(afterReuse.reusedCount, 'byText cache 命中應走 reuse').toBe(1);
  expect(afterReuse.remainingCount, 'reuse 命中後不應留在 remaining').toBe(0);
  expect(afterReuse.injected, 'reuse 應注入既有譯文').toBe(true);
  expect(afterReuse.marked, 'reuse 注入後應標 data-shinkansen-translated').toBe(true);

  // 斷言（核心 1）：覆寫前有快照原文
  expect(
    afterReuse.hasSnapshot,
    'STATE.originalHTML 應有 reuse 元素 entry（restorePage 的迭代源）',
  ).toBe(true);
  expect(afterReuse.snapshotIsOriginal, '快照內容應為 remount 後的原文').toBe(true);

  // Step 3：走 Debug Bridge RESTORE（真實還原路徑）
  await evaluate(`
    window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: { action: 'RESTORE' } }));
    null
  `);

  // 輪詢等還原完成（以正常路徑段落的標記移除為完成信號——它在 pre/post fix 都會被還原）
  {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const done = await evaluate(
        `!document.querySelector('#p-normal').hasAttribute('data-shinkansen-translated')`,
      );
      if (done) break;
      await page.waitForTimeout(50);
    }
  }

  const afterRestore = await evaluate(`
    (() => {
      const pNormal = document.querySelector('#p-normal');
      const pRemounted = document.querySelector('#p-remounted');
      return {
        normalRestored: pNormal.textContent.includes('normal injection path'),
        remountedText: pRemounted.textContent.trim(),
        remountedRestored: pRemounted.textContent.includes('translated before remounting'),
        remountedMarked: pRemounted.hasAttribute('data-shinkansen-translated'),
      };
    })()
  `);

  expect(afterRestore.normalRestored, '正常路徑段落應回原文').toBe(true);

  // 斷言（核心 2）:reuse 元素 RESTORE 後回原文，不殘留殭屍譯文
  expect(
    afterRestore.remountedRestored,
    `reuse 元素 RESTORE 後應回原文，實際： ${afterRestore.remountedText}`,
  ).toBe(true);
  expect(afterRestore.remountedMarked, 'reuse 元素還原後不應殘留 translated 標記').toBe(false);

  await page.close();
});
