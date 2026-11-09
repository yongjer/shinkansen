// Regression: inject-a3-inline-opaque (CLAUDE.md §15 single 原地替換)
//
// Fixture: test/regression/fixtures/inject-a3-inline-opaque.html
// 結構特徵:framework-managed 段落含 preservable A,A 內含 SPAN.tail-ellipsis
// (extractA3Seq 視為 inline 但 serializer 因 hasSubstantiveContent fail 不視為
// preservable)。對應 X 推文 tweetText > A.url > [SPAN.head, text, SPAN.tail-…]。
//
// 修法前:A3 在 A 內部遞迴對齊長度不符 return false → 整段 fallback dual
// sibling wrapper(違反 §15)。
// 修法後:collectA3Mutations 視 inline element 為 opaque placeholder,內部對齊
// 失敗只跳過該 inline 內 mutations,不讓外層 alignment 整段 fail。
//
// SANITY 紀錄(已驗證):暫拿掉 collectA3Mutations 內 inline opaque fallback
//   (改回 `if (!innerOk) return false`)→ 本 spec fail(走 fallback dual,
//   shinkansen-translation wrapper 出現)→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-inline-opaque';
const TARGET_SELECTOR = '#target';

test('A3 inline opaque:source A 內 SPAN.tail 不被 serialize → 仍走 nodeValue mutate 不 fallback dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // Mock isFrameworkManaged 回 true(讓 framework-managed branch 觸發)
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 抓 inject 前 A + 內部 SPAN ref + text node ref
  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefixSpan = tt.querySelector('.text-prefix');
    const prefixText = prefixSpan.firstChild;
    const a = tt.querySelector('a.url-link');
    const headSpan = a.querySelector('.url-head');
    const tailSpan = a.querySelector('.url-tail');
    window.__probeBefore = { tt, prefixSpan, prefixText, a, headSpan, tailSpan };
  }, TARGET_SELECTOR);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefixSpan = tt.querySelector('.text-prefix');
    const prefixText = prefixSpan?.firstChild;
    const a = tt.querySelector('a.url-link');
    const headSpan = a?.querySelector('.url-head');
    const tailSpan = a?.querySelector('.url-tail');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      prefixSpan_sameRef: prefixSpan === p.prefixSpan,
      prefixText_sameRef: prefixText === p.prefixText,
      prefixText_value: prefixText?.nodeValue,
      a_sameRef: a === p.a,
      headSpan_sameRef: headSpan === p.headSpan,
      tailSpan_sameRef: tailSpan === p.tailSpan,
      tailSpan_textContent: tailSpan?.textContent,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_translated: tt.hasAttribute('data-shinkansen-translated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  // 核心斷言:外層 prefix 走 mutate、A 保 ref 原樣不動、不 fallback dual
  expect(result.tt_sameRef, 'tt element ref 保留').toBe(true);
  expect(result.prefixSpan_sameRef, 'prefix SPAN ref 保留').toBe(true);
  expect(result.prefixText_sameRef, 'prefix text node ref 保留').toBe(true);
  expect(result.prefixText_value, 'prefix text mutate 為中文譯文').toContain('你好世界');
  expect(result.a_sameRef, 'A element ref 保留(framework click handler 完整)').toBe(true);
  expect(result.headSpan_sameRef, 'A 內 head SPAN ref 保留').toBe(true);
  expect(result.tailSpan_sameRef, 'A 內 tail SPAN ref 保留(opaque, 未動)').toBe(true);
  expect(result.tailSpan_textContent, 'tail SPAN 內容保留原 …').toBe('…');
  expect(result.tt_has_nodeValueMutated, '走 Layer A3 nodeValue mutate path').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual').toBe(false);
  expect(result.wrapper_present, '不應 inject sibling shinkansen-translation wrapper(§15)').toBe(false);

  // restorePage 還原驗證
  await evaluate(`window.__shinkansen.testRestorePage?.()`);
  const afterRestore = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefixText = tt.querySelector('.text-prefix')?.firstChild;
    return {
      value: prefixText?.nodeValue,
      isEnglish: /Hello/.test(prefixText?.nodeValue || ''),
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
    };
  }, TARGET_SELECTOR);
  expect(afterRestore.isEnglish, 'restorePage 還原為英文').toBe(true);
  expect(afterRestore.tt_has_nodeValueMutated, 'attribute 應移除').toBe(false);

  await page.close();
});
