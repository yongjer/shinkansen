// Regression: wiki-sup-reference-atomic (對應 isAtomicPreserve 規則)
//
// Fixture: test/regression/fixtures/wiki-sup-ref.html
// 結構: <p>...文字 1...<sup class="reference"><a>[1]</a></sup>...文字 2...
//        <sup class="reference"><a>[2]</a></sup></p>
//
// 結構通則:
//   sup.reference 命中 isAtomicPreserve → 序列化時整段 deep clone 成 atomic slot,
//   text 用自閉合佔位符 ⟦*N⟧,內部 [N] 文字完全不出現在送 LLM 的字串裡。
//   反序列化時把 ⟦*N⟧ 整段 cloneNode 塞回去 → 連結 + [N] 文字原樣保留。
//
// 為什麼要 atomic:
//   - [N] 是引用編號,翻譯沒意義
//   - LLM 容易把 [1] 誤翻成「[1]」(全形括號) 或「【1】」造成連結文字錯亂
//   - 整段 deep clone 是最簡單可靠的做法
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'wiki-sup-ref';
const TARGET_SELECTOR = 'p#target';

test('wiki-sup-reference-atomic: sup.reference 必須整段 deep clone,內部 [N] 不送 LLM', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  // fixture response 必須含兩個 atomic 佔位符
  expect(translation.includes('⟦*0⟧')).toBe(true);
  expect(translation.includes('⟦*1⟧')).toBe(true);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 斷言 a: 序列化結果應有兩個 atomic slot,且 source text 含 ⟦*0⟧/⟦*1⟧
  // 並且 [1]/[2] 文字完全不出現在 source text (這是 atomic 的核心保證)
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const { text, slots } = window.__shinkansen.serialize(el);
      return { text, slotCount: slots.length };
    })())
  `);
  const { text: sourceText, slotCount } = JSON.parse(serialized);
  expect(slotCount).toBe(2);
  expect(
    sourceText.includes('⟦*0⟧'),
    `source text 應含 ⟦*0⟧ atomic 佔位符,實際: ${JSON.stringify(sourceText)}`,
  ).toBe(true);
  expect(sourceText.includes('⟦*1⟧')).toBe(true);
  expect(
    sourceText.includes('[1]'),
    `source text 不該含 [1] 文字 (應該被 atomic slot 吞掉),實際: ${JSON.stringify(sourceText)}`,
  ).toBe(false);
  expect(sourceText.includes('[2]')).toBe(false);

  // 跑 testInject
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  expect(injectResult.slotCount).toBe(2);

  // 斷言 b: 注入後 sup.reference 仍存在 × 2,內部 <a> 與 [N] 文字原樣保留
  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    const sups = Array.from(p.querySelectorAll('sup.reference'));
    return {
      pText: p.textContent,
      supCount: sups.length,
      sups: sups.map((s) => {
        const a = s.querySelector('a');
        return {
          innerText: s.textContent,
          hasAnchor: !!a,
          anchorText: a ? a.textContent : null,
          anchorHref: a ? a.getAttribute('href') : null,
        };
      }),
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 斷言 1: sup.reference 數量 = 2 (atomic slot 完整還原)
  expect(after.supCount).toBe(2);

  // 斷言 2: 兩個 sup 內部都還有 <a>,且 [1]/[2] 文字完全沒被翻譯動到
  expect(after.sups[0].hasAnchor).toBe(true);
  expect(after.sups[0].anchorText).toBe('[1]');
  expect(after.sups[0].anchorHref).toBe('https://example.com/cite-1');
  expect(after.sups[1].hasAnchor).toBe(true);
  expect(after.sups[1].anchorText).toBe('[2]');
  expect(after.sups[1].anchorHref).toBe('https://example.com/cite-2');

  // 斷言 3: 譯文主體 (中文) 出現在 p 內
  expect(after.pText.includes('江戶曾是日本封建時代的舊都')).toBe(true);
  expect(after.pText.includes('1868 年在明治維新期間正式改名為東京')).toBe(true);

  await page.close();
});
