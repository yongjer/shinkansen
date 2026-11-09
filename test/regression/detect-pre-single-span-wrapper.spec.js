// Regression: issue #50 — <pre><span style="...">純文字</span></pre> 必須被偵測
//
// Fixture: test/regression/fixtures/pre-single-span-wrapper.html
//
// 問題：asuswrt-merlin.net/changelog-3006 用 `<pre><span style="font-size:12px;">
// 整段純文字</span></pre>` 結構控字級，被 content-detect.js 規則 (b）「pre 子全是
// span 且無 prose inline → 視為語法高亮 skip」誤殺，整篇 changelog 不翻。
//
// 修法：規則 (b) 收緊，要求 ≥2 個 span 才當語法高亮（真高亮每個 token 包一 span,
// 單一 span 是 font/style wrapper）。對 GitHub PrettyLights / hljs / prism / shiki
// 等真高亮場景無影響（都 ≥2 spans）。
//
// SANITY 紀錄（已驗證）：把規則 (b) 還原成 `spanCount >= 1`,case A 斷言「單 span
// pre 必須被偵測」fail（候選為 0）。還原為 `spanCount >= 2` → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'pre-single-span-wrapper';
const FONT_WRAPPER_SELECTOR = 'pre#font-wrapper-pre';
const SYNTAX_HIGHLIGHT_SELECTOR = 'pre#syntax-highlight-pre';

test('issue #50: 單 span wrapper 的 <pre> 必須被偵測；≥2 span 的真語法高亮仍被跳過', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(FONT_WRAPPER_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units } = JSON.parse(result);

  // Case A：單 span wrapper pre 必須被偵測（textPreview 含 changelog 特徵字串）
  const fontWrapperUnit = units.find((u) =>
    (u.textPreview || '').includes('Asuswrt-Merlin')
  );
  expect(
    fontWrapperUnit,
    `應偵測到 #font-wrapper-pre（單 span wrapper)，實際 units: ${JSON.stringify(units.map(u => u.tag + ':' + (u.textPreview || '').substring(0, 30)))}`
  ).toBeDefined();

  // Case B：真語法高亮（≥2 spans）必須被跳過（textPreview 不含 console.log)
  const syntaxHighlightUnit = units.find((u) =>
    (u.textPreview || '').includes('console.log')
  );
  expect(
    syntaxHighlightUnit,
    `≥2 span 的真語法高亮 pre 應被跳過，實際偵測到含 console.log 的 unit: ${syntaxHighlightUnit ? JSON.stringify(syntaxHighlightUnit) : 'none'}`
  ).toBeUndefined();

  await page.close();
});
