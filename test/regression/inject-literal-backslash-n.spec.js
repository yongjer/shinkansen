// Regression: literal-backslash-n (對應 v1.4.6 修的「Gemini 輸出字面 \n 導致兩個可見字元殘留 DOM」bug)
//
// Fixture: test/regression/fixtures/li-strong-br.html（重用）
// 結構: <li><strong>タイトル</strong><br>\n本文</li>
//
// Bug 根因（v1.4.5 以前）:
//   Gemini 有時把換行指令解讀為「輸出字面 \n（反斜線 + n，0x5C 0x6E）」，
//   而非真正換行符（U+000A）。
//   deserializeWithPlaceholders → pushText 用 clean.includes('\n') 偵測換行，
//   字面 \n（兩字元）無法觸發這個判斷，直接被包成文字節點，
//   導致 \n 以兩個可見字元殘留在 DOM 文字裡。
//
// v1.4.6 修法:
//   deserializeWithPlaceholders 在 normalizeLlmPlaceholders 之後、
//   collapseCjkSpacesAroundPlaceholders 之前，加一步：
//   translation.replace(/\\n/g, '\n')
//   把字面 \n（兩字元）轉換為真正換行符（0x0A），再繼續後續流程。
//
// Canned response 中的 \\n 是字面「反斜線 + n」，模擬 Gemini 的問題輸出。
//
// SANITY 紀錄（已驗證）：移除 deserializeWithPlaceholders 中的 /\\n/g replace 步驟，
//   hasLiteralN=true（DOM 出現字面 "\n" 字串）+ brCount=0，斷言 1 fail。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE_HTML = 'li-strong-br';       // 重用已有的 HTML fixture
const FIXTURE_RESPONSE = 'literal-backslash-n'; // 含字面 \n 的 canned response
const TARGET_SELECTOR = 'li#target';

test('literal-backslash-n: Gemini 輸出字面 \\n 應被轉換為真正換行符（還原為 <br>）', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE_RESPONSE);

  // 確認 canned response 含字面 \n（兩字元：0x5C 0x6E）
  expect(
    translation.includes('\\n'),
    'canned response 應含字面 \\n（反斜線 + n）',
  ).toBe(true);
  // 且不含真正換行符（0x0A）——確保是字面版本
  expect(
    translation.includes('\n'),
    'canned response 不應含真正換行符（測試是否真的是字面版）',
  ).toBe(false);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 跑 testInject（canned response 含字面 \n，模擬 Gemini 問題輸出）
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  expect(injectResult.slotCount).toBe(1);

  // 讀取注入後 DOM 狀態
  const after = await page.evaluate((sel) => {
    const li = document.querySelector(sel);
    if (!li) return null;
    const brs = Array.from(li.querySelectorAll('br'));
    const strong = li.querySelector('strong');
    const textPieces = [];
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.replace(/^\s+|\s+$/g, '');
      if (t) textPieces.push(t);
    }
    return {
      brCount: brs.length,
      strongText: strong ? strong.textContent.trim() : null,
      textPieces,
      liInnerHTMLPreview: li.innerHTML.replace(/\s+/g, ' ').slice(0, 300),
    };
  }, TARGET_SELECTOR);

  expect(after, 'li#target 應該存在').not.toBeNull();

  // 斷言 1: 字面 \n 應被轉換為 <br>，不可殘留「\n」可見字串
  const hasLiteralN = after.textPieces.some(t => t.includes('\\n'));
  expect(
    hasLiteralN,
    `DOM 內不應出現字面 \\n 字串，實際 textPieces: ${JSON.stringify(after.textPieces)}\nDOM: ${after.liInnerHTMLPreview}`,
  ).toBe(false);

  // 斷言 2: <br> 應存在（字面 \n → 真正換行符 → parseSegment → <br>）
  expect(
    after.brCount,
    `li 內 <br> 數量應 >= 1，實際 ${after.brCount}\nDOM: ${after.liInnerHTMLPreview}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 3: <strong> 標題應正確
  expect(after.strongText).toBe('能走得更遠的距離');

  // 斷言 4: 內文應存在
  expect(
    after.textPieces.some(t => t.includes('身體負擔減輕後')),
    `內文應含「身體負擔減輕後」，實際: ${JSON.stringify(after.textPieces)}`,
  ).toBe(true);

  await page.close();
});
