// Regression: vbulletin-title-div（對應 v1.4.14 修的「vBulletin 論壇貼文翻譯後 HR 跑到標題上方」bug）
//
// Fixture: test/regression/fixtures/vbulletin-title-div.html
// 結構（sanitized forum.miata.net td.alt1）:
//   <td id="target">
//     <div class="smallfont"><strong>英文標題</strong></div>
//     <hr>
//     <div class="postbitcontrol2">內文 ... <img></div>
//   </td>
//
// Bug 根因（v1.4.13 以前的 injectIntoTarget）:
//   (1) TD 沒有 BLOCK_TAGS_SET 後代 → walker FILTER_ACCEPT 整個 TD 為翻譯單元
//   (2) containsMedia(TD) = true（postbitcontrol2 內的 img）→ 走 media-preserving path
//   (3) 把整個 fragment 塞進「最長文字節點」所在的 postbitcontrol2，原本的 smallfont
//       （含空的 STRONG 殼）與 HR 殘留在 postbitcontrol2 上方 → 視覺上 HR 跑到標題之前
//
// v1.4.14 修法（Cowork 端 Chrome MCP 實地診斷，改 content-inject.js → injectIntoTarget）:
//   偵測 target.children 是否含 CONTAINER_TAGS 成員（DIV/SECTION 等）。有則表示
//   文字分散在不同結構子容器，media-preserving 會注入到錯誤位置；改走 clean-slate。
//   clean-slate 清空 TD 後 append deserialize 後的 fragment（STRONG → HR → 內文），
//   順序正確。
//
// 斷言走結構：注入後 STRONG 在 HR 之前（DOM 順序），STRONG 含翻譯標題，HR 存在，
//           body 翻譯出現在 HR 之後。不綁 class / id / site。
//
// SANITY 紀錄（已驗證）：把 content-inject.js injectIntoTarget 的新守衛條件
// 「&& !hasContainerChild」移除後，spec 在「STRONG 必須出現在 HR 之前」這條斷言 fail
// （HR 殘留在 TD 最上方，STRONG 跑去 postbitcontrol2 裡）。還原守衛後 spec pass。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'vbulletin-title-div';
const TARGET_SELECTOR = 'td#target';

test('vbulletin-title-div: TD 含 img 時注入不可走 media-preserving，STRONG 必須在 HR 之前', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  // canned response sanity：含 STRONG slot ⟦0⟧…⟦/0⟧ 與 HR atomic slot ⟦*1⟧
  expect(translation.includes('\u27E60\u27E7')).toBe(true);
  expect(translation.includes('\u27E6/0\u27E7')).toBe(true);
  expect(translation.includes('\u27E6*1\u27E7')).toBe(true);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  // 注入前 sanity：TD 含 img（確認本 fixture 真的會觸發 containsMedia(TD)=true 路徑）
  // 同時 TD 有 CONTAINER_TAGS 直屬子元素（DIV）
  const before = await page.evaluate((sel) => {
    const td = document.querySelector(sel);
    const imgs = td.querySelectorAll('img');
    const directDivs = Array.from(td.children).filter(c => c.tagName === 'DIV');
    return {
      imgCount: imgs.length,
      directDivCount: directDivs.length,
    };
  }, TARGET_SELECTOR);
  expect(before.imgCount, 'fixture 應有 img 以觸發 containsMedia(TD)=true').toBeGreaterThanOrEqual(1);
  expect(before.directDivCount, 'TD 應有直屬 DIV 子元素以觸發 hasContainerChild=true').toBeGreaterThanOrEqual(2);

  const { evaluate } = await getShinkansenEvaluator(page);

  // 跑完整 serialize → inject 路徑
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  // STRONG slot(0) + HR atomic slot(1) = 2
  expect(injectResult.slotCount).toBeGreaterThanOrEqual(2);

  // 注入後 DOM 狀態
  const after = await page.evaluate((sel) => {
    const td = document.querySelector(sel);
    if (!td) return null;
    const strongs = td.querySelectorAll('strong');
    const hrs = td.querySelectorAll('hr');
    const firstStrong = strongs[0] || null;
    const firstHr = hrs[0] || null;
    // DOM 順序：STRONG 必須出現在 HR 之前
    let strongBeforeHr = null;
    if (firstStrong && firstHr) {
      // Node.DOCUMENT_POSITION_FOLLOWING = 4 → hr 在 strong 後面
      strongBeforeHr = !!(firstStrong.compareDocumentPosition(firstHr) & Node.DOCUMENT_POSITION_FOLLOWING);
    }
    return {
      strongCount: strongs.length,
      strongText: firstStrong ? firstStrong.textContent.trim() : null,
      hrCount: hrs.length,
      strongBeforeHr,
      fullText: td.textContent.replace(/\s+/g, ' ').trim(),
      innerHTMLPreview: td.innerHTML.replace(/\s+/g, ' ').slice(0, 400),
    };
  }, TARGET_SELECTOR);

  expect(after, 'td#target 應存在').not.toBeNull();

  // 斷言 1（核心）：STRONG 至少 1 個
  expect(
    after.strongCount,
    `TD 內應有 <strong>（標題），實際 ${after.strongCount}\nDOM: ${after.innerHTMLPreview}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2（核心）：STRONG 的 textContent 為翻譯後的中文標題
  expect(
    after.strongText,
    `<strong> 應含翻譯後中文標題，實際="${after.strongText}"\nDOM: ${after.innerHTMLPreview}`,
  ).toBe('測試標題中文譯文');

  // 斷言 3：HR 仍存在
  expect(
    after.hrCount,
    `TD 內 HR 應仍存在，實際 ${after.hrCount}\nDOM: ${after.innerHTMLPreview}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 4（核心 bug 的 direct assertion）：DOM 順序 STRONG 在 HR 之前
  // 在 buggy media-preserving path 下，STRONG（翻譯版）會塞進 postbitcontrol2 裡面，
  // 原本的 HR 殘留在 postbitcontrol2 上方 → HR 會出現在 STRONG 之前 → strongBeforeHr=false
  expect(
    after.strongBeforeHr,
    `<strong> 必須出現在 <hr> 之前（核心 bug）\nDOM: ${after.innerHTMLPreview}`,
  ).toBe(true);

  // 斷言 5：body 翻譯出現
  expect(
    after.fullText.includes('早安各位'),
    `body 翻譯應出現，實際 fullText="${after.fullText}"`,
  ).toBe(true);

  await page.close();
});
