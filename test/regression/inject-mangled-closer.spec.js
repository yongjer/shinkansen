// Regression: mangled-closer（對應 v2.0.53 修的「譯文句尾洩漏 /2» 碎片」bug）
//
// Fixture: test/regression/fixtures/orphan-placeholder.html（共用 HTML）
// Canned response: test/regression/fixtures/mangled-closer.response.txt
//
// 結構通則:
//   LLM（日文書實測 gemini-3.5-flash，1700 段中 57 段）會把佔位符閉合標記的
//   ⟧ (U+27E7) 寫成 » (U+00BB)，例 ⟦/1⟧ → ⟦/1»。舊 normalizeLlmPlaceholders
//   只處理整字元替代（❰❱），認不出這種「半壞」標記；stripStrayPlaceholderMarkers
//   的殘留括號清理會削掉 ⟦ 留下「/1»」碎片洩漏至可見 DOM / 純文字譯文。
//   修法：normalizeLlmPlaceholders 尾段加錨定修復——「⟦ + (*/?)數字 + 非 ⟧」
//   pattern 必然是壞標記（⟦ 是協定專用字元），補回 ⟧ 並吃掉 » 等替代閉合字元。
//   修復（而非只清除）讓 deserializer 能正常還原 inline 元素。
//
// Canned response 把 ⟦/1⟧ 寫成 ⟦/1»:
//   "江戶，又稱為⟦0⟧江戶⟦/0⟧，是⟦1⟧東京⟦/1»（日本首都）的舊稱。"
//
// 斷言: 注入後 p#target 無 ⟦⟧❰❱» 殘留、無「/1»」碎片，且 slot 1 的 <i> 元素
//        正常還原（內容「東京」）——證明是「修復後成功反序列化」而非「整段 fallback」。
//
// SANITY 紀錄（已驗證）：暫時把 content-serialize.js normalizeLlmPlaceholders
// 尾段的畸形閉合修復 replace 改成直接 `return s;` →「不該含「/N»」碎片」斷言
// fail（textContent 實際為「江戶，又稱為江戶，是東京/1»（日本首都）的舊稱。」，
// 碎片洩漏且 <i> 遺失）→ 還原修法 → pass。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE_HTML = 'orphan-placeholder'; // 共用同一份 HTML
const FIXTURE_RESPONSE = 'mangled-closer';
const TARGET_SELECTOR = 'p#target';

test('mangled-closer: LLM 把閉合 ⟧ 寫成 » 時標記不洩漏且 inline 元素正常還原', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE_RESPONSE);
  // canned response 含畸形閉合 ⟦/1»，不含完好的 ⟦/1⟧
  expect(translation.includes('⟦/1»')).toBe(true);
  expect(translation.includes('⟦/1⟧')).toBe(false);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await runTestInject(evaluate, TARGET_SELECTOR, translation);

  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    const i = p.querySelector('i');
    return {
      text: p.textContent,
      hasBracket: /[⟦⟧❰❱]/.test(p.textContent),
      hasFragment: /\/?\d+»/.test(p.textContent),
      iText: i ? i.textContent : null,
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 核心斷言 a: 無括號殘留、無「/1»」碎片
  expect(
    after.hasBracket,
    `不該含 ⟦⟧❰❱ 殘留，實際: ${JSON.stringify(after.text)}`,
  ).toBe(false);
  expect(
    after.hasFragment,
    `不該含「/N»」碎片，實際: ${JSON.stringify(after.text)}`,
  ).toBe(false);

  // 核心斷言 b: 畸形標記修復後 deserializer 正常還原 slot 1 的 <i>
  //（只靠 strip 清字元救不回 inline 元素——這條驗的是「修復」不是「清除」）
  expect(
    after.iText,
    `slot 1 的 <i> 應還原且內容為「東京」，實際 DOM: ${JSON.stringify(after.text)}`,
  ).toBe('東京');

  // 斷言 c: 譯文主體完整
  expect(after.text.includes('江戶')).toBe(true);
  expect(after.text.includes('日本首都')).toBe(true);

  await page.close();
});
