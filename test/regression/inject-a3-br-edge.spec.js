// Regression: inject-a3-br-edge (X tweet 段落 blank line 保留)
//
// Fixture: test/regression/fixtures/inject-a3-br-edge.html
// 結構特徵:source SPAN 內單一 text node 含「\n\nEnd : )\n\n」(\n 在首尾)+
// parent DIV white-space:pre-wrap 讓 serializer preserveNewlines。
// deserialize 後 target SPAN 是 [BR, BR, text, BR, BR] — BR 在 container 邊緣。
//
// 修法前:extractA3Seq drop BR 後 target seq.length === 1,special case 條件
// 「targetSeq.length > 1」不過 → 走 normal flow → source text mutate 成
// 「結束 : )」漏掉 \n\n → X tweet 段落 blank line 全壞(@YoinkApp probe 2026-05-20)。
// 修法後:special case 加 targetContainerHasBr() 路徑,length=1 但 container
// 有 BR + source 含 \n → 走 targetContainerToText 還原 \n。
//
// SANITY 紀錄(已驗證):暫拿掉 targetContainerHasBr 路徑 → 本 spec fail
//   (mutate 結果不含 \n)→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-br-edge';
const TARGET_SELECTOR = '#target';

test('A3 BR-at-edge:source \\n 在首尾 + target BR 在 container 邊緣 → mutate 保留 \\n', async ({
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
    const prefixSpan = tt.querySelector('.prefix');
    const tailSpan = tt.querySelector('.tail');
    window.__probeBefore = {
      tt,
      prefixSpan,
      prefixText: prefixSpan.firstChild,
      tailSpan,
      tailText: tailSpan.firstChild,
      tailText_orig: tailSpan.firstChild.nodeValue,
    };
  }, TARGET_SELECTOR);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefixSpan = tt.querySelector('.prefix');
    const tailSpan = tt.querySelector('.tail');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      prefixSpan_sameRef: prefixSpan === p.prefixSpan,
      tailSpan_sameRef: tailSpan === p.tailSpan,
      tailText_sameRef: tailSpan.firstChild === p.tailText,
      tailText_value: tailSpan.firstChild?.nodeValue,
      tailSpan_children_count: tailSpan.children.length, // BR 結構不應跑進來
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tt ref 保留').toBe(true);
  expect(result.tailSpan_sameRef, 'tail SPAN ref 保留(framework fiber 安全)').toBe(true);
  expect(result.tailText_sameRef, 'tail text node ref 保留(nodeValue mutate path)').toBe(true);
  expect(result.tailText_value, 'tail text mutate 為譯文').toContain('結束 : )');
  expect(result.tailText_value, 'tail text 開頭 \\n\\n 保留').toMatch(/^\n\n/);
  expect(result.tailText_value, 'tail text 結尾 \\n\\n 保留').toMatch(/\n\n$/);
  expect(result.tailSpan_children_count, 'tail SPAN 內仍應 0 個子 element(走 mutate 不重建)').toBe(0);
  expect(result.tt_has_nodeValueMutated, '走 nodeValue mutate').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual').toBe(false);
  expect(result.wrapper_present, '不應 inject sibling wrapper').toBe(false);

  // ─── Phase 2: restore + re-inject → 同 fixture 兩輪結果應一致 ───
  // 對應 @YoinkApp 真實案例:第一次翻譯格式正確,還原原文後第二次翻譯段落 \n\n 跑掉
  await evaluate(`window.__shinkansen.testRestorePage?.()`);
  const restored = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const tailSpan = tt.querySelector('.tail');
    const tailText = tailSpan?.firstChild;
    return {
      tailText_value: tailText?.nodeValue,
      tailSpan_children_count: tailSpan?.children.length,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
    };
  }, TARGET_SELECTOR);
  expect(restored.tailText_value, '還原後 tail 文字回到原文 \\n\\nEnd : )\\n\\n').toBe('\n\nEnd : )\n\n');
  expect(restored.tt_has_nodeValueMutated, '還原後 attribute 應清').toBe(false);

  // 重新抓 testInject 入口的 source ref(restorePage 後 innerHTML 重 parse,元素 ref 可能換)
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);
  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const second = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const tailSpan = tt.querySelector('.tail');
    return {
      tailText_value: tailSpan?.firstChild?.nodeValue,
      tailSpan_children_count: tailSpan?.children.length,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);
  expect(second.tailText_value, '第二次翻譯 tail text 也應保留 \\n\\n').toMatch(/^\n\n結束 : \)\n\n$/);
  expect(second.tailSpan_children_count, '第二次翻譯後 tail SPAN 仍 0 個子 element').toBe(0);
  expect(second.tt_has_nodeValueMutated, '第二次翻譯走 nodeValue mutate').toBe(true);
  expect(second.tt_has_dualSource, '第二次翻譯不應 fallback dual').toBe(false);
  expect(second.wrapper_present, '第二次翻譯不應 inject sibling wrapper').toBe(false);

  await page.close();
});
