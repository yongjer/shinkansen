// Regression: orphan-placeholder-markers (v0.92 修正)
//
// Fixture: test/regression/fixtures/orphan-placeholder.html
// 結構: <p>...文字...<a>連結</a>...文字...<i>斜體</i>...文字...</p>
//
// 結構通則:
//   LLM 有時會丟掉佔位符的開頭 ⟦ (U+27E6)，只保留結尾 ⟧ (U+27E7)，
//   導致 orphan ⟧ 或半截標記 /N⟧ 殘留在翻譯後的 DOM 文字中。
//   stripStrayPlaceholderMarkers 必須在剝除完整 ⟦...⟧ 標記之後，
//   再清除所有殘留的孤立 ⟦ 或 ⟧ 字元。
//
// Canned response 刻意模擬 LLM 丟掉 ⟦ 的典型失誤:
//   "江戶，又稱為0⟧江戶⟧/0⟧，是1⟧東京⟧/1⟧（日本首都）的舊稱。"
//   其中 0⟧、⟧/0⟧、1⟧、⟧/1⟧ 都是缺少 ⟦ 的半截標記。
//
// 斷言: 注入後的 p#target 內容不含任何 ⟦ 或 ⟧ 字元。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'orphan-placeholder';
const TARGET_SELECTOR = 'p#target';

test('orphan-placeholder: LLM 丟掉 ⟦ 時 ⟧ 不可洩漏至可見 DOM', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  // canned response 確實含有 orphan ⟧ (U+27E7)
  expect(translation.includes('\u27E7')).toBe(true);
  // 但不含完整的 ⟦...⟧ 配對 (模擬 LLM 全部丟掉 ⟦)
  expect(translation.includes('\u27E6')).toBe(false);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 先確認序列化產出了兩個 slot (a + i)
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const { text, slots } = window.__shinkansen.serialize(el);
      return { text, slotCount: slots.length };
    })())
  `);
  const { text: sourceText, slotCount } = JSON.parse(serialized);
  expect(slotCount).toBe(2);
  expect(sourceText.includes('\u27E6')).toBe(true); // 序列化有 ⟦
  expect(sourceText.includes('\u27E7')).toBe(true); // 和 ⟧

  // 用 canned response 注入 (會走 deserialize fallback 因為配對全失敗)
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);

  // 斷言 a: 注入後 p#target 的 textContent 不含任何 ⟦ 或 ⟧
  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    return {
      text: p.textContent,
      hasOpenBracket: p.textContent.includes('\u27E6'),
      hasCloseBracket: p.textContent.includes('\u27E7'),
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 核心斷言: 沒有 ⟦ 或 ⟧ 洩漏
  expect(
    after.hasOpenBracket,
    `p#target 不該含 ⟦ (U+27E6)，實際文字: ${JSON.stringify(after.text)}`,
  ).toBe(false);
  expect(
    after.hasCloseBracket,
    `p#target 不該含 ⟧ (U+27E7)，實際文字: ${JSON.stringify(after.text)}`,
  ).toBe(false);

  // 斷言 b: 譯文主體（中文）出現在 p 內
  expect(after.text.includes('江戶')).toBe(true);
  expect(after.text.includes('日本首都')).toBe(true);

  // 斷言 c: /0⟧、/1⟧ 等半截標記不在文字中
  expect(after.text.includes('/0')).toBe(false);
  expect(after.text.includes('/1')).toBe(false);

  await page.close();
});

// <!-- SANITY-PENDING: 把 stripStrayPlaceholderMarkers 的第二步和第三步註解掉，
//      只保留第一步（剝除完整 ⟦...⟧），此 spec 應該 fail（⟧ 會洩漏） -->
