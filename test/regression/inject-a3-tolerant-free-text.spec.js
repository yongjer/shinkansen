// Regression: inject-a3-tolerant-free-text (Flash Lite 譯文重組)
//
// Fixture: test/regression/fixtures/inject-a3-tolerant-free-text.html
// 結構特徵:source 是純 inline 序列(中間沒夾 text),target deserialize 後在 inline
// 之間多了 free text node(LLM 重組句序時把原 placeholder 內文字搬到 placeholder 之間)。
//
// 對應真實案例(@jsnell 2026-05-20 + Gemini Flash Lite):
//   source extractA3Seq:[inline, inline, inline, inline] = 4
//   target extractA3Seq:[inline, inline, text(" 撰寫的"), inline, inline] = 5
//   原本 length 不符 → A3 alignment fail → fallback dual sibling(違反 §15)
//
// 修法:source 是純 inline 時,寬容對齊 — target 兩 inline 之間的 free text 吸收進
// 下一個 inline 的 leading,合進該 inline mutate 的 newValue。
//
// SANITY 紀錄(已驗證):暫拿掉 tolerant path → 本 spec fail(source middle SPAN text
// 不含「撰寫的」leading + dual sibling wrapper 出現)→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-tolerant-free-text';
const TARGET_SELECTOR = '#target';

test('A3 寬容對齊:LLM 把 free text 放 placeholder 外 → 吸收進下一個 inline leading', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefix = tt.querySelector('.prefix');
    const middle = tt.querySelector('.middle');
    const a = tt.querySelector('a.url');
    window.__before = {
      tt, prefix, prefixText: prefix.firstChild,
      middle, middleText: middle.firstChild,
      a,
    };
  }, TARGET_SELECTOR);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefix = tt.querySelector('.prefix');
    const middle = tt.querySelector('.middle');
    const a = tt.querySelector('a.url');
    const p = window.__before;
    return {
      tt_sameRef: tt === p.tt,
      prefix_sameRef: prefix === p.prefix,
      prefixText_sameRef: prefix.firstChild === p.prefixText,
      prefix_value: prefix.firstChild?.nodeValue,
      middle_sameRef: middle === p.middle,
      middleText_sameRef: middle.firstChild === p.middleText,
      middle_value: middle.firstChild?.nodeValue,
      a_sameRef: a === p.a,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tt ref 保留').toBe(true);
  expect(result.prefix_sameRef, 'prefix SPAN ref 保留(framework fiber 安全)').toBe(true);
  expect(result.prefixText_sameRef, 'prefix text node ref 保留(nvMutate)').toBe(true);
  expect(result.prefix_value, 'prefix mutate 為「由 」').toBe('由 ');
  expect(result.middle_sameRef, 'middle SPAN ref 保留').toBe(true);
  expect(result.middleText_sameRef, 'middle text node ref 保留').toBe(true);
  expect(result.middle_value, 'middle 結合「 撰寫的」+「《...》今天正式出版...」 leading').toContain('撰寫的');
  expect(result.middle_value, 'middle 也含書名').toContain('《Steve Jobs in Exile》');
  expect(result.a_sameRef, 'A.url ref 保留').toBe(true);
  expect(result.tt_has_nodeValueMutated, '走 nvMutate path').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual').toBe(false);
  expect(result.wrapper_present, '不應 inject sibling wrapper(§15)').toBe(false);

  await page.close();
});
