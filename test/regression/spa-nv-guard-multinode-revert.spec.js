// Regression: spa-nv-guard-multinode-revert（2026-07-02 修的「framework 部分重繪把
// nv-mutate 圖說打回原文,guard 沒守住」bug — 真實案例:NYT React 文章 figcaption
// 翻完後滾動/圖片 lazy-load 觸發重繪,圖說卡英文、內文正常）
//
// Fixture: test/regression/fixtures/nv-guard-multinode-revert.html
// 結構:含兩個 text node 的圖說（說明 span + 來源 span），framework-managed。
// Bug:runContentGuardNvMutate 的重套閘門要求「backup node 全部 detach」;framework
//   只重繪「部分」text node（多節點元素常見）時閘門不成立 → sweep 跳過,A4 各 path
//   也不觸發 → 元素卡「標 translated 但顯示原文」。
// 修法:sweep 改以症狀為準——只要元素現在顯示原文（curText === originalText）就重套,
//   不再硬要求 backup node 全 detach（涵蓋全換 / 部分換 / reset 各種重繪變體）。
//
// SANITY 紀錄（已驗證 2026-07-02）：把 runContentGuardNvMutate 的進入閘門從
//   `if (!allDetached && !reverted) continue;` 暫時改回原本的
//   `if (!allDetached) continue;`（只認 backup 全 detach）→ 本 spec 的
//   guardResult 由 1 變 0（部分重繪、來源 span 仍 connected 被跳過）→ 第一條斷言
//   fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'nv-guard-multinode-revert';
const ORIG_CAP = 'A caption sentence that plainly describes the scene shown in the photo.';
// A3 對齊譯文:兩個 slot（兩段 span）各自對應
const TRANSLATION = '⟦0⟧清楚描述照片場景的一句圖說。⟦/0⟧⟦1⟧攝影師姓名/通訊社⟦/1⟧';

test('多節點 nv-mutate 圖說被 framework 部分重繪打回原文 → guard 重套回中文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#cap', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 注入（走 framework nvMutate 路徑）
  await runTestInject(evaluate, '#cap', TRANSLATION);
  const afterInject = await page.evaluate(() =>
    document.querySelector('#cap').textContent);
  expect(/[一-鿿]/.test(afterInject), '注入後應含中文(前置條件)').toBe(true);
  expect(afterInject.includes('⟦'), '注入後不得殘留佔位符').toBe(false);

  // framework「部分重繪」:只把第一個 span 的 text node 換成英文原文（node detach）,
  // 第二個 span 的譯文 node 不動（仍 connected、仍中文）。這是真實 NYT React figcaption
  // 的形——說明 span 被打回英文、來源 span 仍是譯文 → 混合。此時：
  //   - backup 非「全 detach」（第二 node 還連著）→ 舊 sweep 閘門跳過
  //   - curText（英文說明 + 中文來源）!== origText → 舊「全等 origText」判準也不成立
  // → 元素卡「標 translated 但說明回英文」。
  await page.evaluate((orig) => {
    const spans = document.querySelectorAll('#cap span');
    spans[0].firstChild.replaceWith(document.createTextNode(orig));
  }, ORIG_CAP);

  // 跑 guard sweep：應偵測「元素含 backup 原文值(說明段回英文)且沒展開」→ 重套整段譯文。
  const guardResult = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);

  const r = await page.evaluate(() => {
    const el = document.querySelector('#cap');
    return {
      text: el.textContent,
      hasEnglishCaption: /caption sentence that plainly/i.test(el.textContent),
      hasCJK: /[一-鿿]/.test(el.textContent),
      translated: el.hasAttribute('data-shinkansen-translated'),
    };
  });

  expect(guardResult, 'guard 應介入修復 1 個元素').toBeGreaterThanOrEqual(1);
  expect(r.hasEnglishCaption,
    `圖說英文原文不該殘留,實際: ${JSON.stringify(r.text)}`).toBe(false);
  expect(r.hasCJK, '圖說應為中文').toBe(true);

  await page.close();
});
