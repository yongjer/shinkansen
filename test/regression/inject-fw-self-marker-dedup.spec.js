// Regression: inject-fw-self-marker-dedup(v1.10.49,對應「原地中文 + 下方另一份
// 不同中文 wrapper」雙重譯文 bug)
//
// Fixture: test/regression/fixtures/inject-fw-self-marker-dedup.html
// 結構:以 <a> 開頭的段落,被翻譯兩次(模擬 SPA rescan 重抓)。v1.10.52 後
// A3.5 anchor gate 放寬,prose 內文連結走 flatten single;要讓第一輪仍掉 dual
// 須用「以 <a> 開頭」結構(第一個可見 text node 在 <a> 內 → gate 不放行)。
// Bug:第一輪掉 dual fallback(元素只標 data-shinkansen-dual-source;detect 層
// 刻意不擋 dual-source),rescan 重翻同元素,framework 分支 dedup 只查祖先 +
// 後代、漏查元素自己 → 第二輪 mutate 寫入 → 雙重譯文(兩輪 API 譯文還不同)。
// 修法(content-inject.js framework 分支):dedup 補查 unit.el 自身三種標記。
//
// SANITY 紀錄(已驗證 2026-06-12):暫時把 framework 分支的 unit.el 自身標記
// 檢查 if block 用 `if (false &&` 關閉 → 兩條 spec 皆 fail(dual-source 元素
// 第二輪被 mutate / nv-mutated 元素第二輪疊出 wrapper)→ 還原 → 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-fw-self-marker-dedup';
const ORIGINAL_TEXT = 'Northwind Labs posted quarterly results that exceeded expectations this year.';
// 第一輪:丟佔位符 → A3 fail;段落以 <a> 開頭(第一個可見 text node 在 <a> 內)
// → A3.5 anchor gate fail → dual
const TRANSLATION_ROUND1 = '本年度業績全面超出預期。';
// 第二輪(模擬 rescan 重翻,LLM 非決定性產出可對齊譯文)→ 沒有 self dedup 時會 mutate
const TRANSLATION_ROUND2 = '⟦0⟧Northwind Labs⟦/0⟧ 公布的季度業績超出了今年的預期。';

test('framework 分支: 元素已標 dual-source 時第二輪 inject 必須 no-op(不疊雙重譯文)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 第一輪:掉 dual fallback
  await runTestInject(evaluate, '#target', TRANSLATION_ROUND1);

  const afterRound1 = await page.evaluate(() => {
    const el = document.querySelector('#target');
    return {
      dualSource: el.hasAttribute('data-shinkansen-dual-source'),
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      wrapperCount: document.querySelectorAll('shinkansen-translation').length,
      text: el.textContent,
    };
  });
  expect(afterRound1.dualSource, '第一輪應掉 dual fallback(前置條件)').toBe(true);
  expect(afterRound1.wrapperCount, '第一輪應產生 1 個 wrapper(前置條件)').toBe(1);
  expect(afterRound1.text, '第一輪後原文保留(前置條件)').toBe(ORIGINAL_TEXT);

  // 第二輪:模擬 rescan 重翻同元素(這輪譯文可對齊,沒有 self dedup 會 mutate)
  await runTestInject(evaluate, '#target', TRANSLATION_ROUND2);

  const afterRound2 = await page.evaluate(() => {
    const el = document.querySelector('#target');
    return {
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      wrapperCount: document.querySelectorAll('shinkansen-translation').length,
      text: el.textContent,
    };
  });
  expect(afterRound2.nvMutated, '第二輪不可 mutate(元素已標 dual-source)').toBe(false);
  expect(afterRound2.text, '第二輪後原文必須維持(不可變成中文疊在 wrapper 上)').toBe(ORIGINAL_TEXT);
  expect(afterRound2.wrapperCount, 'wrapper 維持 1 個(不疊加)').toBe(1);

  await page.close();
});

test('framework 分支: 元素已標 nodevalue-mutated 時第二輪 inject 必須 no-op', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 第一輪:可對齊譯文 → mutate 成功
  await runTestInject(evaluate, '#target', TRANSLATION_ROUND2);
  const afterRound1 = await page.evaluate(() => {
    const el = document.querySelector('#target');
    return {
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      text: el.textContent,
    };
  });
  expect(afterRound1.nvMutated, '第一輪應 mutate 成功(前置條件)').toBe(true);

  // 第二輪:不同譯文重打同元素 → 必須 no-op(不疊 wrapper、不重寫)
  await runTestInject(evaluate, '#target', TRANSLATION_ROUND1);
  const afterRound2 = await page.evaluate(() => {
    const el = document.querySelector('#target');
    return {
      wrapperCount: document.querySelectorAll('shinkansen-translation').length,
      text: el.textContent,
    };
  });
  expect(afterRound2.wrapperCount, '第二輪不可追加 dual wrapper').toBe(0);
  expect(afterRound2.text, '譯文維持第一輪結果').toBe(afterRound1.text);

  await page.close();
});
