// Regression: bracket-alias (v0.93 修正)
//
// Fixture: test/regression/fixtures/orphan-placeholder.html (共用 HTML)
// Canned response: test/regression/fixtures/bracket-alias.response.txt
//
// 結構通則:
//   LLM 有時會把佔位符括號 ⟦⟧ (U+27E6/U+27E7) 替換成外觀相似但
//   Unicode 不同的字元 ❰❱ (U+2770/U+2771)，導致 parseSegment regex
//   完全認不出標記，整串標記洩漏至可見 DOM。
//   normalizeLlmPlaceholders 必須先把替代字元還原成標準 ⟦⟧，
//   之後反序列化管線才能正常運作。
//
// Canned response 用 ❰❱ 取代 ⟦⟧:
//   "江戶，又稱為❰0❱江戶❰/0❱，是❰1❱東京❰/1❱（日本首都）的舊稱。"
//
// 斷言: 注入後的 p#target 不含 ❰ (U+2770) 或 ❱ (U+2771)，
//        也不含 ⟦ (U+27E6) 或 ⟧ (U+27E7)。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE_HTML = 'orphan-placeholder'; // 共用同一份 HTML
const FIXTURE_RESPONSE = 'bracket-alias';
const TARGET_SELECTOR = 'p#target';

test('bracket-alias: LLM 把 ⟦⟧ 替換成 ❰❱ 時標記不可洩漏至可見 DOM', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE_RESPONSE);
  // canned response 含 ❰❱ (U+2770/U+2771)，不含 ⟦⟧ (U+27E6/U+27E7)
  expect(translation.includes('\u2770')).toBe(true);
  expect(translation.includes('\u2771')).toBe(true);
  expect(translation.includes('\u27E6')).toBe(false);
  expect(translation.includes('\u27E7')).toBe(false);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 用 canned response 注入
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);

  // 斷言 a: 注入後 p#target 不含任何 placeholder 括號（原版或替代版）
  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    const text = p.textContent;
    return {
      text,
      has27E6: text.includes('\u27E6'), // ⟦
      has27E7: text.includes('\u27E7'), // ⟧
      has2770: text.includes('\u2770'), // ❰
      has2771: text.includes('\u2771'), // ❱
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 核心斷言: 四種括號字元都不洩漏
  expect(
    after.has27E6,
    `不該含 ⟦ (U+27E6)，實際: ${JSON.stringify(after.text)}`,
  ).toBe(false);
  expect(
    after.has27E7,
    `不該含 ⟧ (U+27E7)，實際: ${JSON.stringify(after.text)}`,
  ).toBe(false);
  expect(
    after.has2770,
    `不該含 ❰ (U+2770)，實際: ${JSON.stringify(after.text)}`,
  ).toBe(false);
  expect(
    after.has2771,
    `不該含 ❱ (U+2771)，實際: ${JSON.stringify(after.text)}`,
  ).toBe(false);

  // 斷言 b: 譯文主體出現在 p 內
  expect(after.text.includes('江戶')).toBe(true);
  expect(after.text.includes('日本首都')).toBe(true);

  await page.close();
});

// SANITY 紀錄(已驗證):此 spec 實際上由「兩層防禦」共同把關 ❰❱ 不洩漏:
//   (1) normalizeLlmPlaceholders 把 ❰❱ 替換成 ⟦⟧(讓 deserializer 認得)
//   (2) stripStrayPlaceholderMarkers 在 deserializer fallback 時把 ❰❱ ⟦⟧ 全清掉
// 只破壞 (1) → spec 仍 pass(走到 fallback,(2) 把字元清掉);
// 只破壞 (2) → spec 仍 pass((1) 已先把 ❰❱ 轉成 ⟦⟧,deserializer 正常解析無殘留);
// 兩條同時破壞 → spec fail(❰❱ 殘留可見)。雙層保險是設計上的冗餘,各自獨立修法。
