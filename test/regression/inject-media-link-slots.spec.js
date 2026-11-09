// Regression: inject-media-link-slots (對應 v1.2.4 修的根本原因)
//
// Fixture: test/regression/fixtures/inject-media-link-slots.html
// 結構特徵:
//   <p><img data-emoji="🤏"> Dhruv's been having fun with this little <a href="...">Kodak Charmera</a> keychain.</p>
//
// 含 <img>（emoji）且含 <a>（品牌連結）。
// canned response 保留佔位符: "Dhruv 最近都在玩這款 ⟦0⟧Kodak Charmera⟦/0⟧ 鑰匙圈相機。"
//
// v1.2.3 的 bug（根本原因）:
//   content.js translateUnits 序列化時，containsMedia(el) === true 的元素
//   直接回傳 { text: el.innerText.trim(), slots: [] }，
//   <a> 完全不被序列化成佔位符 ⟦0⟧...⟦/0⟧。
//   LLM 收到純文字（無佔位符），回傳純文字譯文。
//   injectTranslation 走 replaceTextInPlace → injectIntoTarget(string) → path B，
//   "Kodak Charmera" 文字節點被清空，<a> shell 被 v1.2.2 的邏輯移除。
//   結果：連結消失，只剩純文字譯文。
//
// v1.2.4 的修法:
//   移除 content.js 中 `if (SK.containsMedia(el)) return { text, slots: [] }` 早返回，
//   讓含媒體元素的段落也走 hasPreservableInline → serializeWithPlaceholders，
//   <a> 被正常序列化為 ⟦0⟧Kodak Charmera⟦/0⟧ 送給 LLM。
//   LLM 保留佔位符 → deserializeWithPlaceholders ok=true → fragment 有 <a> → 注入成功。
//
// 斷言全部基於結構特徵（CLAUDE.md 硬規則 8）：
//   - 注入後 p 內存在 <a>，且 <a> 有非空文字（連結被保留）
//   - 注入後 p 的 textContent 包含 "Kodak Charmera"（連結文字本身也在）
//   - <img> 仍然存在於 p 內（media-preserving path 不可刪圖片）
//
// <!-- SANITY-PENDING: 在 content.js translateUnits 的序列化邏輯中，
//      還原「if (SK.containsMedia(el)) return { text: el.innerText.trim(), slots: [] };」，
//      驗證斷言 1「p 內應有非空 <a>」應該 FAIL（連結消失），斷言 2、3 仍 PASS。-->
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'inject-media-link-slots';
const TARGET_SELECTOR = 'p#target';

test('inject-media-link-slots: 含 img 的段落翻譯後 <a> 連結應被保留', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  // canned response 含佔位符，確認走 ok=true 路徑
  expect(translation).toContain('⟦0⟧');
  expect(translation).toContain('⟦/0⟧');

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  // 注入前 sanity：p 含 <img> 與 <a>
  const before = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    return {
      hasImg: !!p.querySelector('img'),
      linkCount: p.querySelectorAll('a').length,
      linkText: p.querySelector('a')?.textContent?.trim() ?? null,
    };
  }, TARGET_SELECTOR);
  expect(before.hasImg, '注入前 p 應含 <img>').toBe(true);
  expect(before.linkCount, '注入前應有 1 個 <a>').toBe(1);
  expect(before.linkText, '注入前 <a> 的文字應為 "Kodak Charmera"').toBe('Kodak Charmera');

  const { evaluate } = await getShinkansenEvaluator(page);
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);

  // canned response 含佔位符 → slotCount >= 1
  expect(injectResult.slotCount, 'slotCount 應 >= 1（<a> 應被序列化為 slot）').toBeGreaterThanOrEqual(1);

  // 注入後 DOM 斷言
  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    const allLinks = Array.from(p.querySelectorAll('a'));
    return {
      hasImg: !!p.querySelector('img'),
      totalText: p.textContent.trim(),
      linkCount: allLinks.length,
      links: allLinks.map(a => ({ text: a.textContent.trim(), href: a.href })),
      pInnerHTMLPreview: p.innerHTML.replace(/\s+/g, ' ').slice(0, 300),
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 斷言 1: p 內存在 <a> 且文字非空（核心斷言，對應 v1.2.4 修法）
  // 結構特徵: 含媒體元素的段落序列化必須保留 <a> 為 slot，注入後連結不可消失。
  expect(
    after.linkCount,
    `p 內應有 1 個 <a>（連結被保留）\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(1);

  if (after.linkCount > 0) {
    expect(
      after.links[0].text,
      `<a> 的文字應為 "Kodak Charmera"\nDOM: ${after.pInnerHTMLPreview}`,
    ).toBe('Kodak Charmera');
  }

  // 斷言 2: p 的 textContent 包含 "Kodak Charmera"
  expect(
    after.totalText,
    `p 的文字應包含 "Kodak Charmera"\nDOM: ${after.pInnerHTMLPreview}`,
  ).toContain('Kodak Charmera');

  // 斷言 3: <img> 仍然在 p 內（media-preserving path 不可刪媒體）
  expect(
    after.hasImg,
    `<img> 應仍在 p 內\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(true);

  await page.close();
});
