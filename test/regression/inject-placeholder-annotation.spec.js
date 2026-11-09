// Regression: placeholder-annotation (對應 v1.4.5 修的「Gemini 在佔位符內插入多餘描述文字」bug)
//
// Fixture: test/regression/fixtures/placeholder-annotation.html
// 結構: <li><strong>ファーストエイド用品（絆創膏、鎮痛剤...）</strong><br>\n本文</li>
//
// Bug 根因（v1.4.4 以前）:
//   Gemini 在翻譯含醫藥相關 slot 時，把 ⟦0⟧ 輸出成 ⟦0 drug⟧、⟦/0⟧ 輸出成 ⟦/0 drug⟧。
//   normalizeLlmPlaceholders 只處理前後空白，無法識別 ⟦0 drug⟧。
//   stripStrayPlaceholderMarkers 剝除 ⟦ ⟧ 後，「0 drug」/「/0 drug」裸字串殘留 DOM。
//
// v1.4.5 修法:
//   normalizeLlmPlaceholders 加一條 regex 偵測「數字後有空白 + 非空白文字」，
//   自動清除多餘描述：⟦0 drug⟧ → ⟦0⟧、⟦/0 drug⟧ → ⟦/0⟧。
//
// Canned response 中的 ⟦0 drug⟧ 和 ⟦/0 drug⟧ 模擬 Gemini 的問題輸出。
//
// SANITY 紀錄（已驗證）：移除 v1.4.5 新增 regex 後，textPieces 變成
//   ["0 drug救急醫護用品（OK 繃、鎮痛劑、布質膠帶等）/0 drug\n最低限度的急救應對基本裝備。..."]，
//   斷言 1（hasDrug 應為 false）失敗。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'placeholder-annotation';
const TARGET_SELECTOR = 'li#target';

test('placeholder-annotation: Gemini 在佔位符內插入多餘描述（⟦0 drug⟧）後不可殘留裸字串', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  // 確認 canned response 含有問題的 ⟦0 drug⟧ 和 ⟦/0 drug⟧
  expect(translation).toContain('⟦0 drug⟧');
  expect(translation).toContain('⟦/0 drug⟧');

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 確認序列化正常產出 slot
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const { text, slots } = window.__shinkansen.serialize(el);
      return { text, slotCount: slots.length };
    })())
  `);
  const { slotCount } = JSON.parse(serialized);
  expect(slotCount).toBe(1); // <strong> → 1 個 slot

  // 跑 testInject（canned response 含 ⟦0 drug⟧，模擬問題輸出）
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  expect(injectResult.slotCount).toBe(1);

  // 讀取注入後 DOM 狀態
  const after = await page.evaluate((sel) => {
    const li = document.querySelector(sel);
    if (!li) return null;
    const strong = li.querySelector('strong');
    // 收集所有 text node 內容
    const textPieces = [];
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.replace(/^\s+|\s+$/g, '');
      if (t) textPieces.push(t);
    }
    return {
      strongText: strong ? strong.textContent.trim() : null,
      textPieces,
      liInnerHTMLPreview: li.innerHTML.replace(/\s+/g, ' ').slice(0, 400),
    };
  }, TARGET_SELECTOR);

  expect(after, 'li#target 應該存在').not.toBeNull();

  // 斷言 1: DOM 內不應出現裸字串 "drug"（核心 bug：⟦0 drug⟧ 的多餘描述不可洩漏）
  const hasDrug = after.textPieces.some(t => t.includes('drug'));
  expect(
    hasDrug,
    `DOM 內不應出現 "drug" 裸字串，實際 textPieces: ${JSON.stringify(after.textPieces)}\nDOM: ${after.liInnerHTMLPreview}`,
  ).toBe(false);

  // 斷言 2: <strong> 應存在且文字為翻譯後的標題（不含 "0 drug" 前綴）
  expect(
    after.strongText,
    '<strong> 應存在且含中文標題',
  ).toBe('救急醫護用品（OK 繃、鎮痛劑、布質膠帶等）');

  // 斷言 3: 內文應正確出現（排版沒被破壞）
  expect(
    after.textPieces.some(t => t.includes('最低限度的急救')),
    `內文應含「最低限度的急救」，實際 textPieces: ${JSON.stringify(after.textPieces)}`,
  ).toBe(true);

  await page.close();
});
