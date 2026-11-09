// Regression: pre-no-code (對應 v1.0.8 修的 <pre> 條件排除 + widget 豁免)
//
// Fixture: test/regression/fixtures/pre-no-code.html
// 結構特徵（雙層修正，都是通用規則）:
//   1. <pre> 不含 <code> 子元素 → 應被偵測為翻譯單位
//      <pre> 含 <code> 子元素 → 應被跳過（程式碼區塊）
//   2. <pre> 內含 <button>more</button> → 不應觸發 isInteractiveWidgetContainer
//      PRE 的 HTML 語意是文字容器，button 是次要控制項，不是 CTA
//
// v1.0.7 以前的 bug:
//   (a) <pre> 在 HARD_EXCLUDE_TAGS 一律跳過
//   (b) 即使移除 HARD_EXCLUDE，PRE 內的 button 會觸發 isInteractiveWidgetContainer
//       （textLen < 300），PRE 仍被 REJECT
//
// v1.0.8 修法:
//   (a) PRE 從 HARD_EXCLUDE_TAGS 移除，加入 BLOCK_TAGS，含 <code> 才 REJECT
//   (b) PRE 豁免 isInteractiveWidgetContainer 檢查
//
// 斷言基於結構特徵（有無 <code>、PRE 語意），不綁站點，符合硬規則 8。
// SANITY 紀錄(已驗證):把 'PRE' 加回 HARD_EXCLUDE_TAGS → 「#comment-pre 必須被偵測」斷言 fail。還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'pre-no-code';
const COMMENT_PRE_SELECTOR = 'pre#comment-pre';
const CODE_PRE_SELECTOR = 'pre#code-pre';

test('pre-no-code: 不含 <code> 的 <pre> 必須被偵測為翻譯單位', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(COMMENT_PRE_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  // 斷言 1: #comment-pre（不含 code 的 PRE）必須被偵測到
  const preUnits = units.filter((u) => u.tag === 'PRE');
  expect(
    preUnits.length,
    `應有至少 1 個 tag=PRE 的翻譯單位（不含 code 的 <pre>），實際 ${preUnits.length}。units: ${JSON.stringify(units.map(u => u.tag + ':' + (u.textPreview || '').substring(0, 40)))}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2: #comment-pre 的 textPreview 包含留言文字
  const commentUnit = preUnits.find((u) =>
    (u.textPreview || '').includes('art industry')
  );
  expect(commentUnit, '應偵測到含 "art industry" 的 PRE 單位').toBeDefined();

  // 斷言 3: #code-pre（含 code 的 PRE）不應被偵測到
  const codePreUnits = units.filter((u) =>
    (u.textPreview || '').includes('console.log')
  );
  expect(
    codePreUnits.length,
    `含 <code> 的 <pre> 不應被偵測（應有 0 個含 console.log 的 unit），實際 ${codePreUnits.length}`,
  ).toBe(0);

  await page.close();
});

test('pre-no-code: 不含 <code> 的 <pre> 注入譯文後文字正確替換', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(COMMENT_PRE_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 注入譯文到 #comment-pre
  await runTestInject(evaluate, COMMENT_PRE_SELECTOR, translation);

  // 斷言: PRE 的文字內容已被替換為中文譯文
  const injectedText = await evaluate(`
    document.querySelector(${JSON.stringify(COMMENT_PRE_SELECTOR)}).textContent.trim()
  `);
  expect(injectedText).toContain('藝術產業');

  // 斷言: #code-pre 沒被動到
  const codeText = await evaluate(`
    document.querySelector(${JSON.stringify(CODE_PRE_SELECTOR)}).textContent.trim()
  `);
  expect(codeText).toContain('console.log');

  await page.close();
});
