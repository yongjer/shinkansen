// Regression: inject-nodevalue-mutate (v1.9.27 Layer A1)
//
// Fixture: test/regression/fixtures/inject-nodevalue-mutate.html
// 結構特徵：framework-managed element + single text node source。對應 Immersive
// Translate SR() 對 single text node 場景的處理：不動 element 結構，只改 text
// node nodeValue，保 framework DOM ref。
//
// 對應 SPEC-PRIVATE §25.6 Option A Layer A1 實作。Chrome for Claude 在真實
// X 推文 (2026-05-19) probe 確認：
//   - tweetText 初翻前是「1 SPAN 1 text node」結構
//   - nodeValue mutate 後 click show more 仍能 expand(React fiber 完整）
//
// SANITY 紀錄：暫拿掉 tryInjectNodeValueMutate dispatch → spec 應 fail
// (fallback dual,wrapper sibling 出現）→ 還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-nodevalue-mutate';
const TARGET_SELECTOR = '#target';

test('inject-nodevalue-mutate: framework-managed element 走 nodeValue mutate 不動 DOM 結構', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // Mock isFrameworkManaged 回 true(fixture Chromium 不是 React，沒 __reactFiber$ expando)
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 抓 inject 前 text node ref + span ref
  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const span = tt.querySelector('span');
    const textNode = span.firstChild;
    window.__probeBefore = { tt, span, textNode, textNode_value: textNode.nodeValue };
  }, TARGET_SELECTOR);

  // testInject 走 framework-managed → tryInjectNodeValueMutate
  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const span = tt.querySelector('span');
    const textNode = span?.firstChild;
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      span_present: !!span,
      span_sameRef: span === p.span,
      span_count: tt.querySelectorAll('span').length,
      textNode_present: !!textNode,
      textNode_sameRef: textNode === p.textNode,
      textNode_value: textNode?.nodeValue,
      tt_has_nodeValueMutated_attr: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_translated_attr: tt.hasAttribute('data-shinkansen-translated'),
      tt_has_dualSource_attr: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
      tt_textContent_isChinese: /[一-鿿]/.test(tt.textContent),
    };
  }, TARGET_SELECTOR);

  // 核心斷言：DOM 結構不變
  expect(result.tt_sameRef, 'tt element ref 應保留').toBe(true);
  expect(result.span_count, 'span 數量應為 1（原結構不動）').toBe(1);
  expect(result.span_sameRef, 'span 物件 ref 應保留').toBe(true);
  expect(result.textNode_sameRef, 'text node 物件 ref 應保留（React fiber identity)').toBe(true);
  // text node value 變中文
  expect(result.textNode_value, 'text node nodeValue 應為中文譯文').toContain('原創');
  expect(result.tt_textContent_isChinese).toBe(true);
  // attribute mark
  expect(result.tt_has_nodeValueMutated_attr, '應 mark data-shinkansen-nodevalue-mutated').toBe(true);
  expect(result.tt_has_translated_attr, '應 mark data-shinkansen-translated（複用 skip 邏輯）').toBe(true);
  expect(result.tt_has_dualSource_attr, '不應走 dual fallback（沒 dual-source attribute)').toBe(false);
  // 沒 sibling wrapper（不走 dual)
  expect(result.wrapper_present, '不應 inject shinkansen-translation sibling wrapper').toBe(false);

  // STATE.nodeValueMutateBackup 應有 entry
  const backupSize = await evaluate(`window.__SK.STATE.nodeValueMutateBackup?.size ?? -1`);
  expect(Number(backupSize), 'STATE.nodeValueMutateBackup 應含 1 個 entry').toBe(1);

  // restorePage 還原驗證
  await evaluate(`window.__shinkansen.testRestorePage?.() ?? null`);
  const afterRestore = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const textNode = tt.querySelector('span')?.firstChild;
    return {
      textNode_value: textNode?.nodeValue,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      isEnglish: /[A-Za-z]/.test(textNode?.nodeValue || ''),
      isChineseGone: !/[一-鿿]/.test(textNode?.nodeValue || ''),
    };
  }, TARGET_SELECTOR);

  expect(afterRestore.isEnglish, 'restorePage 後 text node 還原為英文').toBe(true);
  expect(afterRestore.isChineseGone, 'restorePage 後沒中文殘留').toBe(true);
  expect(afterRestore.tt_has_nodeValueMutated, 'restorePage 後 attribute 應移除').toBe(false);

  await page.close();
});

test('inject-nodevalue-mutate 守門：含 placeholder slots → fallback 走 dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // tryInjectNodeValueMutate 對 slots > 0 應 return false
  const result = await evaluate(`
    (() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      // fake slots（模擬有 inline element placeholder 場景）
      const fakeSlots = [{ nodeType: 1, tagName: 'A' }];
      return window.__SK.tryInjectNodeValueMutate?.(el, '中文', fakeSlots);
    })()
  `);
  expect(String(result), '有 slots 時應 fallback（回 false)').toBe('false');
});

test('inject-nodevalue-mutate Case 2:single source text node + 含 \\n 譯文 → mutate work(\\n 保留）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const ok = window.__SK.tryInjectNodeValueMutate(el, '第一段\\n第二段', []);
      const tn = el.querySelector('span')?.firstChild;
      return { ok, nodeValue: tn?.nodeValue };
    })()
  `);
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  expect(parsed.ok, 'single text node 含 \\n 譯文應 mutate(layer A2)').toBe(true);
  expect(parsed.nodeValue, 'text node nodeValue 應含完整譯文與 \\n').toBe('第一段\n第二段');
});

test('inject-nodevalue-mutate Case 3:multi source text nodes + N == chunks → 1:1 配對 mutate', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 動態改 fixture target 變成 3 個 span 各含 1 text node（模擬 X 推文 multi SPAN 結構）
  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    tt.innerHTML = '<span>段一英文</span><span>段二英文</span><span>段三英文</span>';
  }, TARGET_SELECTOR);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const ok = window.__SK.tryInjectNodeValueMutate(el, '段一中文\\n段二中文\\n段三中文', []);
      const spans = Array.from(el.querySelectorAll('span'));
      return {
        ok,
        values: spans.map(s => s.firstChild?.nodeValue),
        spanCount: spans.length,
      };
    })()
  `);
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  expect(parsed.ok, 'N == M (3 nodes / 3 chunks) 應 1:1 配對 mutate').toBe(true);
  expect(parsed.spanCount, 'SPAN 結構不應動').toBe(3);
  expect(parsed.values, '每個 SPAN text node 應對應 1 個中文 chunk').toEqual(['段一中文', '段二中文', '段三中文']);
});

test('inject-nodevalue-mutate Case 3 守門：N != chunks → fallback', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    tt.innerHTML = '<span>段一</span><span>段二</span>';  // N=2
  }, TARGET_SELECTOR);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      // 譯文切出 3 chunks → 2 != 3 不配對
      return window.__SK.tryInjectNodeValueMutate(el, '一\\n二\\n三', []);
    })()
  `);
  expect(String(result), 'N != M 應 fallback（回 false)').toBe('false');
});
