// Regression: inject-nodevalue-mutate-a3 (v1.9.27 Layer A3)
//
// Fixture: test/regression/fixtures/inject-nodevalue-mutate-a3.html
// 結構特徵：framework-managed element + 帶 class SPAN inline + 內部單一 text
// node 含 \n。對應真實 X 推文 tweetText 結構（2026-05-19 probe 確認）。
//
// Layer A3 對 slots > 0 場景遞迴序列配對 + special case 處理 br 還原。
// SANITY 紀錄：暫拿掉 collectA3Mutations 的 special case (single text + multi text)
//   → 主 spec fail（配對失敗，fallback dual)→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-nodevalue-mutate-a3';
const TARGET_SELECTOR = '#target';

test('Layer A3: slots > 0 + 帶 class SPAN + 單 text node 含 \\n → nodeValue mutate work', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // Mock isFrameworkManaged 回 true（讓 layer 4 fallback path 觸發）
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 抓 inject 前 SPAN + text node ref
  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const span = tt.querySelector('span');
    const textNode = span.firstChild;
    window.__probeBefore = { tt, span, textNode };
  }, TARGET_SELECTOR);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const span = tt.querySelector('span');
    const textNode = span?.firstChild;
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      span_sameRef: span === p.span,
      span_count: tt.querySelectorAll('span').length,
      span_classPreserved: span?.classList?.contains('css-styled-class'),
      textNode_sameRef: textNode === p.textNode,
      textNode_value: textNode?.nodeValue,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_translated: tt.hasAttribute('data-shinkansen-translated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
      tt_isChinese: /[一-鿿]/.test(tt.textContent),
    };
  }, TARGET_SELECTOR);

  // 核心斷言：結構保留 + nodeValue mutate
  expect(result.tt_sameRef, 'tt element ref 保留').toBe(true);
  expect(result.span_sameRef, 'SPAN 物件 ref 保留（framework fiber 完整）').toBe(true);
  expect(result.span_count, '原 SPAN 結構不動，仍 1 個').toBe(1);
  expect(result.span_classPreserved, 'SPAN class 保留').toBe(true);
  expect(result.textNode_sameRef, 'text node 物件 ref 保留').toBe(true);
  expect(result.textNode_value, 'text node nodeValue 應為中文譯文（含 \\n 還原）').toContain('提示詞');
  expect(result.textNode_value, 'text node nodeValue 應保留 \\n').toContain('\n');
  expect(result.tt_isChinese).toBe(true);
  expect(result.tt_has_nodeValueMutated, '走 Layer A3 nodeValue mutate path').toBe(true);
  expect(result.tt_has_dualSource, '不應走 dual fallback').toBe(false);
  expect(result.wrapper_present, '不應 inject sibling wrapper').toBe(false);

  // restorePage 還原驗證
  await evaluate(`window.__shinkansen.testRestorePage?.()`);
  const afterRestore = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const textNode = tt.querySelector('span')?.firstChild;
    return {
      value: textNode?.nodeValue,
      isEnglish: /[A-Za-z]/.test(textNode?.nodeValue || ''),
      isChineseGone: !/[一-鿿]/.test(textNode?.nodeValue || ''),
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
    };
  }, TARGET_SELECTOR);
  expect(afterRestore.isEnglish, 'restorePage 還原為英文').toBe(true);
  expect(afterRestore.isChineseGone).toBe(true);
  expect(afterRestore.tt_has_nodeValueMutated, 'attribute 應移除').toBe(false);

  await page.close();
});
