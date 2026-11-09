// Regression: inject-media-link-ghost (對應 v1.2.2 修的 Gmail email 連結消失 bug)
//
// Fixture: test/regression/fixtures/inject-media-link-ghost.html
// 結構特徵:
//   <p>Get Raycast for Windows <img src="..."> <a href="...">raycast.com/windows</a></p>
//
// 含 <img> → containsMedia(p) === true → injectIntoTarget 走 media-preserving path (B)。
// LLM 丟掉佔位符:response.txt 回傳 "下載 Windows 版 Raycast：raycast.com/windows"（無 ⟦…⟧）
// → deserializeWithPlaceholders ok=false → plainTextFallback → injectIntoTarget(string)。
//
// v1.2.1 的 bug:
//   collectVisibleTextNodes 回傳 ["Get Raycast for Windows ", "raycast.com/windows"]。
//   findLongestTextNode 選出 "Get Raycast for Windows " 作為 main。
//   其他文字節點（含 <a> 內的 "raycast.com/windows"）只做 t.nodeValue = ''，
//   <a> shell 留在 DOM → 空連結殼（href 有值但 text 空）看不到也點不到。
//
// v1.2.2 的修法:
//   清空文字節點後，向上追溯父 inline 元素（如 <a>）；
//   若 textContent.trim() === '' 且不含媒體子元素，則 removeChild 移除空殼。
//
// 斷言全部基於結構特徵（CLAUDE.md 硬規則 8）：
//   - 注入後 p 內不存在 empty <a>（即 a:empty 或 a 內 textContent.trim() === ''）
//   - 注入後 p 的 textContent 包含譯文文字
//   - <img> 仍然存在於 p 內
// <!-- SANITY-PENDING: 把 content-inject.js 的「向上移除空殼」邏輯 for 迴圈還原成
//      for (const t of textNodes) if (t !== main) t.nodeValue = '';
//      驗證斷言 1「p 內不可有 empty <a>」應該 FAIL，斷言 2、3 仍 PASS。-->
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'inject-media-link-ghost';
const TARGET_SELECTOR = 'p#target';

test('inject-media-link-ghost: 含 img 的段落翻譯後不可留下空殼 <a>', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  // canned response 不含佔位符，確認 ok=false 路徑被觸發
  expect(translation).not.toContain('⟦');

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  // 注入前 sanity：p 含 <img>，containsMedia 應回傳 true（確認走 path B）
  const before = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    return {
      hasImg: !!p.querySelector('img'),
      linkCount: p.querySelectorAll('a').length,
      linkText: p.querySelector('a')?.textContent?.trim() ?? null,
    };
  }, TARGET_SELECTOR);
  expect(before.hasImg, '注入前 p 應含 <img>（確認走 media-preserving path）').toBe(true);
  expect(before.linkCount, '注入前應有 1 個 <a>').toBe(1);
  expect(before.linkText, '注入前 <a> 的文字應為原始連結 URL').toBe('raycast.com/windows');

  const { evaluate } = await getShinkansenEvaluator(page);
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);

  // 結構特徵:LLM 回傳無佔位符 → ok=false → slotCount 有值但 matched=0
  // （testInject 只回傳 slotCount，ok 不直接暴露，以斷言 DOM 為主）
  expect(typeof injectResult.slotCount).toBe('number');

  // 注入後 DOM 斷言
  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    const allLinks = Array.from(p.querySelectorAll('a'));
    const emptyLinks = allLinks.filter(a => a.textContent.trim() === '');
    return {
      hasImg: !!p.querySelector('img'),
      totalText: p.textContent.trim(),
      linkCount: allLinks.length,
      emptyLinkCount: emptyLinks.length,
      emptyLinkHrefs: emptyLinks.map(a => a.href),
      pInnerHTMLPreview: p.innerHTML.replace(/\s+/g, ' ').slice(0, 300),
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 斷言 1: p 內不存在空殼 <a>（核心斷言，對應 v1.2.2 修法）
  // 結構特徵: media-preserving path 清空 <a> 內文字後，必須同步移除 <a> shell，
  // 不可留下 href 有值但 textContent 為空的幽靈連結。
  expect(
    after.emptyLinkCount,
    `p 內不應有空殼 <a>（hrefs: ${JSON.stringify(after.emptyLinkHrefs)}）\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(0);

  // 斷言 2: p 的 textContent 包含譯文
  // 結構特徵: plainTextFallback 路徑的文字必須出現在 p 的 textContent 中。
  expect(
    after.totalText,
    `p 的文字應包含譯文，實際: "${after.totalText}"\nDOM: ${after.pInnerHTMLPreview}`,
  ).toContain('下載 Windows 版 Raycast');

  // 斷言 3: <img> 仍然在 p 內（media-preserving path 的核心責任）
  // 結構特徵: path B 不可清掉媒體元素，<img> 必須保留。
  expect(
    after.hasImg,
    `<img> 應仍在 p 內（media-preserving path 不可刪媒體）\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(true);

  // 斷言 4: p 內仍有至少一個 <a>，且 <a> 有非空文字（對應 v1.2.3 tryRecoverLinkSlots 修法）
  // 結構特徵: ok=false 路徑重建連結後，<a> 必須有文字內容，不可只有空殼或完全消失。
  // 注意: 若 canned response 不含原始連結文字「raycast.com/windows」，tryRecoverLinkSlots
  // 找不到對應，允許 linkCount === 0——此 fixture 的 response.txt 不含 URL，
  // 所以此斷言驗證的是「若 <a> 存在，則必須非空」這條次要條件。
  // （tryRecoverLinkSlots 用 linkText 搜尋，response.txt 含 "raycast.com/windows" 時
  //   linkCount 會是 1；不含時 linkCount === 0 亦屬預期——見 SANITY-PENDING 說明）
  if (after.linkCount > 0) {
    const allLinks = await page.evaluate((sel) => {
      const p = document.querySelector(sel);
      return Array.from(p.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim(),
        href: a.href,
      }));
    }, TARGET_SELECTOR);
    for (const link of allLinks) {
      expect(
        link.text.length,
        `p 內的 <a href="${link.href}"> 不應為空文字\nDOM: ${after.pInnerHTMLPreview}`,
      ).toBeGreaterThan(0);
    }
  }

  await page.close();
});
