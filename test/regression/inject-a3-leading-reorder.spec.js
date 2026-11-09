// Regression: inject-a3-leading-reorder(v1.10.49,對應「譯文掉到英文下方」bug 之一)
//
// Fixture: test/regression/fixtures/inject-a3-leading-reorder.html
// 結構:段落以 inline <a> 開頭、開頭沒有 text node(figcaption / credit line 形)。
// Bug:LLM 譯文 CJK 語序重排把時間狀語移到句首 → target 序列開頭多出 source
// 沒有的 text segment → segment fallback 溢出吸收只能「往前吸」,開頭沒有
// prose mutation 可吸 → segOk=false → framework-managed 分支掉 dual visible
// (原文 + 譯文 sibling 並列,違反 §15 single 原地替換)。
// 修法(content-inject.js collectA3Mutations segment fallback):開頭溢出文字
// 暫存 pendingLeadText,「往後」塞進下一個 inline 的內部首個 text mutation。
//
// SANITY 紀錄(已驗證):暫時把 segment fallback 內 `pendingLeadText += ...;
// continue;` 改回 `segOk = false; break;` → 第 1 條 spec fail(nvMutated false +
// wrapper 出現)→ 還原 → 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-leading-reorder';
// LLM 語序重排:時間狀語「1960 年代的」移到第一個 <a> 之前
const TRANSLATION_REORDERED = '1960 年代的 ⟦0⟧Alpha Band⟦/0⟧ 與 ⟦1⟧Beta Group⟦/1⟧（Archive Photo）';

test('segment fallback: 開頭溢出文字往後塞進第一個 inline → 原地 mutate 不掉 dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // inject 前抓 anchor ref,驗 fiber-safe(元素物件不換)
  await page.evaluate(() => {
    const el = document.querySelector('#target');
    window.__probeA1 = el.querySelectorAll('a')[0];
    window.__probeA2 = el.querySelectorAll('a')[1];
  });

  await runTestInject(evaluate, '#target', TRANSLATION_REORDERED);

  const r = await page.evaluate(() => {
    const el = document.querySelector('#target');
    const anchors = el.querySelectorAll('a');
    return {
      text: el.textContent,
      a1Text: anchors[0]?.textContent || '',
      a2Text: anchors[1]?.textContent || '',
      a1SameRef: anchors[0] === window.__probeA1,
      a2SameRef: anchors[1] === window.__probeA2,
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      dualSource: el.hasAttribute('data-shinkansen-dual-source'),
      wrapperPresent: !!document.querySelector('shinkansen-translation'),
    };
  });

  expect(r.nvMutated, '應走 nodeValue mutate 原地替換').toBe(true);
  expect(r.dualSource, '不應標 data-shinkansen-dual-source').toBe(false);
  expect(r.wrapperPresent, '不應出現 shinkansen-translation sibling wrapper').toBe(false);
  expect(r.a1Text, '開頭溢出文字「1960 年代的」應塞進第一個 <a> 內(視覺順序正確)').toContain('1960 年代的');
  expect(r.a1Text, '第一個 <a> 仍含原連結文字').toContain('Alpha Band');
  expect(r.a2Text, '第二個 <a> 連結文字不變').toBe('Beta Group');
  expect(r.a1SameRef, '<a> 物件 ref 應保留(fiber identity)').toBe(true);
  expect(r.a2SameRef, '<a> 物件 ref 應保留(fiber identity)').toBe(true);
  expect(r.text, '中間連接詞應為譯文').toContain('與');
  expect(r.text, '原英文尾段不應殘留').not.toContain(', 1960s (');

  await page.close();
});

test('對照組: 無語序重排的譯文仍走 strict 對齊,連結文字不被加料', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 譯文維持 source 順序(開頭就是 ⟦0⟧)→ 不觸發 pendingLeadText,
  // strict 對齊照常,anchor 文字保持純淨
  await runTestInject(
    evaluate,
    '#target',
    '⟦0⟧Alpha Band⟦/0⟧ 與 ⟦1⟧Beta Group⟦/1⟧，1960 年代（Archive Photo）'
  );

  const r = await page.evaluate(() => {
    const el = document.querySelector('#target');
    const anchors = el.querySelectorAll('a');
    return {
      a1Text: anchors[0]?.textContent || '',
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      wrapperPresent: !!document.querySelector('shinkansen-translation'),
      text: el.textContent,
    };
  });

  expect(r.nvMutated, '應走 nodeValue mutate').toBe(true);
  expect(r.wrapperPresent, '無 dual wrapper').toBe(false);
  expect(r.a1Text, '無重排時第一個 <a> 文字維持原樣(不被 pendingLeadText 加料)').toBe('Alpha Band');
  expect(r.text, '尾段譯文正確').toContain('1960 年代（Archive Photo）');

  await page.close();
});
