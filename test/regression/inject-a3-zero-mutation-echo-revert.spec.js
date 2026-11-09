// Regression: inject-a3-zero-mutation-echo-revert（對應 v2.0.65 修的
// 「整段被單一 preservable SPAN wrapper 包住 + LLM 弄壞佔位符巢狀 → 好譯文
// 被假 echo 沖回原文、永遠顯示原文」bug)
//
// Fixture: test/regression/fixtures/inject-a3-zero-mutation-echo-revert.html
// 結構：framework-managed li > SPAN.wrapper(preservable, slot 0)>
//   [STRONG(“), A>STRONG（標題）, STRONG(.”), text, EM, text]
// Bug:A3 頂層 SPAN↔SPAN 1:1 對齊 strictOk，但 wrapper 內部不同構（LLM 只回
//   0/1/2 三對佔位符且巢狀錯）→ opaque inline 內部失敗不致命（v1.9.31）→
//   mutations 收集到 0 條仍 return true → 零寫入 → caller echo 偵測誤判
//   「模型 echo」→ 沖回原文 + 標已翻，譯文靜默丟棄。
// 修法：tryInjectNodeValueMutate A3 分支 aligned 後 mutations.length === 0
//   → return false（零寫入不算注入成功），流進 A3.5 flatten 完整注入譯文。
//
// SANITY 紀錄（已驗證）：暫時把 content-inject.js A3 分支的
// `if (mutations.length === 0) return false;` 註解掉 → 「譯文注入後含中文」
// 「不得殘留英文原文」斷言 fail（textContent 仍為英文原文）→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-zero-mutation-echo-revert';
const TARGET_SELECTOR = '#target';

test('A3 aligned 但零 mutation：不得假 echo 沖回原文，譯文須經 fallback 注入', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // Mock isFrameworkManaged 回 true（觸發 framework-managed A1/A3/A3.5 branch）
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 前置確認：serializer 對 fixture 的 slot 配置符合 bug 鏈假設
  // (slot 0 = SPAN wrapper 包整段 → 譯文的 ⟦0⟧ 會對到整個 wrapper)
  const serialized = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text, slots } = window.__SK.serializeWithPlaceholders(el);
      return { text, slotCount: slots.length, slot0Tag: slots[0] && slots[0].tagName };
    })()
  `);
  expect(serialized.slot0Tag, 'slot 0 應為 SPAN wrapper（整段包住的結構前提）').toBe('SPAN');
  expect(serialized.text.startsWith('⟦0⟧'), 'serialized text 以 ⟦0⟧ 開頭').toBe(true);
  expect(serialized.text.endsWith('⟦/0⟧'), 'serialized text 以 ⟦/0⟧ 結尾').toBe(true);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);

  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return {
      text: el.textContent,
      hasTranslated: el.hasAttribute('data-shinkansen-translated'),
      hasNvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      hasDualSource: el.hasAttribute('data-shinkansen-dual-source'),
      wrapperPresent: !!document.querySelector('shinkansen-translation'),
      aRefPresent: !!el.querySelector('a[href*="example.com"]'),
    };
  }, TARGET_SELECTOR);

  // 核心斷言：譯文必須真的進 DOM，不得被假 echo 沖回原文
  expect(result.text, '譯文注入後含中文').toContain('佔位符巢狀壞掉如何搞垮注入');
  expect(result.text, '不得殘留英文原文（假 echo 沖回的症狀）').not.toContain('How Placeholder Nesting Broke Injection');
  expect(result.hasTranslated, '標記已翻').toBe(true);
  // A3.5 flatten 走 nodeValue mutate，元素結構（含 A ref）保留
  expect(result.hasNvMutated, '走 nodeValue mutate 路徑（A3.5 flatten）').toBe(true);
  expect(result.aRefPresent, 'A element 結構保留（flatten 只動 text node）').toBe(true);
  expect(result.wrapperPresent, '不應 inject sibling wrapper(§15 single)').toBe(false);

  await page.close();
});
