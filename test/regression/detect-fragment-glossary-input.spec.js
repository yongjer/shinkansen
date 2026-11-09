// Regression: detect-fragment-glossary-input (v1.10.46 批次 1-6)
//
// Bug:fragment unit 的 shape 是 {kind:'fragment', el, startNode, endNode},從未有
// parent 欄位,但兩處讀 `unit.parent`:
//   1. content-detect.js extractGlossaryInput——fragment 全被 `if (!el) continue` 跳過,
//      不貢獻術語表抽取輸入(fragment 為主的頁面術語表品質劣化)
//   2. content.js translateUnits preSerialized——fragment 估 0 字,批次數估算失真
// 修法:兩處改讀 unit.el。
//
// 本 spec 鎖 1(使用者可見 harm):collectParagraphs 產出的 fragment unit 文字
// 必須出現在 extractGlossaryInput 結果內。
// 2 的估算失真共用同一根因同一修法,僅 log/估算層,不另立 spec。
//
// Fixture 復用 include-selector-seen-dedup.html(card/note/hatnote 三段都是
// walker inlineMixedFragment 抽出的 fragment unit)。
//
// SANITY 紀錄(已驗證,2026-06-11):
//   暫時把 extractGlossaryInput 的 `const el = unit.el` 改回 `const el = unit.kind ===
//   'fragment' ? unit.parent : unit.el`(bug 原狀)→ 「fragment 文字應出現在術語表輸入」
//   斷言 fail(三段 fragment 文字全缺)→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'include-selector-seen-dedup';

test('fragment unit 必須貢獻 extractGlossaryInput 輸入(unit.el,不是不存在的 unit.parent)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#card-detail-text', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const raw = await evaluate(`
    (() => {
      const units = window.__SK.collectParagraphs();
      const fragmentCount = units.filter(u => u.kind === 'fragment').length;
      const input = window.__SK.extractGlossaryInput(units);
      return JSON.stringify({ fragmentCount, input });
    })()
  `);
  const { fragmentCount, input } = JSON.parse(raw);

  // 前提:fixture 確實產出 fragment unit(防 fixture 結構漂移造成假綠)
  expect(fragmentCount, 'fixture 應產出 fragment unit').toBeGreaterThanOrEqual(3);

  // 核心:fragment unit 的文字(首句)必須進術語表輸入
  expect(input).toContain('An English card description');
  expect(input).toContain('A note element with sufficiently long');
  expect(input).toContain('This hatnote also contains');
});
