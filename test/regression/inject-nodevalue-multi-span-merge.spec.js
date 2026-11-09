// Regression: v1.10.4 — Google MT / Gemini + 單語覆蓋 + framework-managed element,
// source text 分散在多個 inline SPAN 內(X quoted tweet 結構)。
//
// tryInjectNodeValueMutate Case 3 原本:
//   chunks = translation.split(/\n+/)  → 1-2 chunks
//   textNodes.length                    → 3 (inline SPAN 分隔)
//   chunks.length !== textNodes.length  → return false → fallback injectDual
//   → single mode 出現 dual sibling wrapper。
//
// 修法: Case 3b: chunks < textNodes 時整段譯文塞第一個 text node,其餘清空。
//
// Fixture: test/regression/fixtures/inject-nodevalue-multi-span-merge.html
//
// SANITY 紀錄(已驗證):
//   - 暫改 Case 3b 的 `chunks.length < textNodes.length` → `false` 強制 skip
//     → 3 條 spec fail(wrapper_present = true / nodeValueMutated = false)
//   - 還原 → 全 pass

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-nodevalue-multi-span-merge';

test('Case 1: 3 text nodes + 1 chunk(no \\n) → nodeValue mutate 不 fallback dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-simple', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await evaluate(`
    (() => {
      const el = document.querySelector('#tweet-simple');
      const { text, slots } = window.__SK.serializeForGoogleTranslate(el);
      const translation = '你好世界,@ProtonVPN 是瑞士的。不會發生。';
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, translation, slots);
    })()
  `);

  const result = await page.evaluate(() => {
    const el = document.querySelector('#tweet-simple');
    const leaves = el.querySelectorAll('.leaf');
    return {
      nodeValueMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      dualSource: el.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
      leaf0_text: leaves[0]?.textContent,
      leaf1_text: leaves[1]?.textContent,
      leaf2_text: leaves[2]?.textContent,
    };
  });

  expect(result.nodeValueMutated, '走 nodeValue mutate path').toBe(true);
  expect(result.dualSource, '不應 fallback dual').toBe(false);
  expect(result.wrapper_present, '不應產生 dual wrapper').toBe(false);
  expect(result.leaf0_text, '第一個 text node 應包含完整譯文').toContain('瑞士');
  expect(result.leaf1_text, '第二個 text node 應清空').toBe('');
  expect(result.leaf2_text, '第三個 text node 應清空').toBe('');

  await page.close();
});

test('Case 2: 3 text nodes + 2 chunks(translation 含 \\n) → nodeValue mutate 不 fallback dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-with-break', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await evaluate(`
    (() => {
      const el = document.querySelector('#tweet-with-break');
      const { text, slots } = window.__SK.serializeForGoogleTranslate(el);
      const translation = '第一段文字。@mention 結尾。\\n第二段在這裡。';
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, translation, slots);
    })()
  `);

  const result = await page.evaluate(() => {
    const el = document.querySelector('#tweet-with-break');
    const leaves = el.querySelectorAll('.leaf');
    return {
      nodeValueMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      dualSource: el.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!el.parentElement.querySelector('shinkansen-translation'),
      leaf0_text: leaves[0]?.textContent,
      leaf1_text: leaves[1]?.textContent,
      leaf2_text: leaves[2]?.textContent,
    };
  });

  expect(result.nodeValueMutated, '走 nodeValue mutate path').toBe(true);
  expect(result.dualSource, '不應 fallback dual').toBe(false);
  expect(result.wrapper_present, '不應產生 dual wrapper').toBe(false);
  expect(result.leaf0_text, '第一個 text node 應包含完整譯文(含 \\n)').toContain('第一段');
  expect(result.leaf0_text, '譯文保留 \\n 段落分隔').toContain('\n');
  expect(result.leaf1_text, '第二個 text node 應清空').toBe('');
  expect(result.leaf2_text, '第三個 text node 應清空').toBe('');

  await page.close();
});

test('Case 3: chunks === textNodes 的原行為不受影響(3 nodes + 3 chunks 仍 1:1 配對)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-simple', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await evaluate(`
    (() => {
      const el = document.querySelector('#tweet-simple');
      const translation = '你好世界,\\n@ProtonVPN\\n 是瑞士的。';
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, translation, []);
    })()
  `);

  const result = await page.evaluate(() => {
    const el = document.querySelector('#tweet-simple');
    const leaves = el.querySelectorAll('.leaf');
    return {
      nodeValueMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      leaf0_text: leaves[0]?.textContent,
      leaf1_text: leaves[1]?.textContent,
      leaf2_text: leaves[2]?.textContent,
    };
  });

  expect(result.nodeValueMutated, '走 nodeValue mutate path').toBe(true);
  expect(result.leaf0_text, '第一個 text node 1:1 配對').toBe('你好世界,');
  expect(result.leaf1_text, '第二個 text node 1:1 配對').toBe('@ProtonVPN');
  expect(result.leaf2_text, '第三個 text node 1:1 配對').toBe(' 是瑞士的。');

  await page.close();
});
