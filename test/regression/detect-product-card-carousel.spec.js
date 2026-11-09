/**
 * product-card-carousel — Amazon JP carousel 商品卡片偵測/注入 regression
 *
 * bug 症狀:Amazon 產品卡片翻譯後 rating / badge / price rows 全消失,只剩標題和圖片。
 *
 * 根因:
 *   LI(BLOCK_TAGS_SET 元素)包裹整張產品卡 [LI > SPAN > DIV > A(img) + A(title) +
 *   DIV.a-row(rating) + DIV.a-row(badge) + DIV.a-row(price)]。
 *   containsBlockDescendant(LI) 回 false(DIV 不在 BLOCK_TAGS_SET,只在 CONTAINER_TAGS),
 *   且 mediaCardSkip 只檢查 CONTAINER_TAGS 直接子元素(LI 的直接子是 SPAN 不命中)。
 *   LI 通過所有 guard → FILTER_ACCEPT → 整張卡序列化成單一 segment。
 *   注入時 LI 含 <img> → path(B) media-preserving 觸發 → 清空所有文字節點(只留最長)→
 *   empty-shell removal 逐層清掉空容器 → 三個 DIV.a-row 全部被移除。
 *
 * 修法:
 *   mediaCardSkip 條件從「直接子有 CONTAINER_TAG」擴展為「含 CONTAINER_TAG 後代」。
 *   條件仍需同時滿足:非 heading + 含 img/picture/video + directTextLength < 20。
 *   結構性通則(§8):描述「block 元素含媒體 + 含 container 結構後代 + 無直接文字」
 *   = 媒體卡片 pattern,不綁站點。
 *
 * SANITY 紀錄(已驗證):
 *   還原修法(mediaCardSkip 條件移除 querySelector CONTAINER_TAG_SELECTOR 分支)→
 *   LI 被 collectParagraphs 整顆接受為 element unit → testInject 後
 *   div.a-row count 從 3 變 0 → 斷言 fail;還原後 pass。
 */
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'product-card-carousel';

test('product card: rating / badge / price rows survive after translation', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 1. LI 不該被整顆接受為 element unit
  const liAccepted = await evaluate(`
    (() => {
      try {
        const results = window.__SK.collectParagraphs(document.body);
        return results.some(u => u.kind === 'element' && u.el?.tagName === 'LI');
      } catch (e) { return { error: e.message }; }
    })()
  `);
  expect(liAccepted, 'LI should NOT be accepted as a single element unit').toBe(false);

  // 1b. title-link <a> 不該被補抓(內含 DIV.truncation 有 line-clamp CSS)
  const titleLinkAccepted = await evaluate(`
    (() => {
      const results = window.__SK.collectParagraphs(document.body);
      return results.some(u => u.kind === 'element' && u.el?.classList?.contains('title-link'));
    })()
  `);
  expect(titleLinkAccepted, 'title-link <a> should NOT be captured (contains DIV)').toBe(false);

  // 2. 注入前 3 個 div.a-row 存在
  const beforeRowCount = await evaluate(`document.querySelectorAll('.card > .a-row').length`);
  expect(beforeRowCount).toBe(3);

  // 3. 模擬注入(只對 element unit)
  await evaluate(`
    (() => {
      const results = window.__SK.collectParagraphs(document.body);
      for (const unit of results) {
        if (unit.kind !== 'element' || !unit.el) continue;
        try {
          window.__shinkansen.testInject(unit.el, 'TR: ' + (unit.el.textContent||'').trim().substring(0, 20));
        } catch (e) {}
      }
    })()
  `);

  // 4. 注入後 3 個 div.a-row 仍存在
  const afterRowCount = await evaluate(`document.querySelectorAll('.card > .a-row').length`);
  expect(afterRowCount, 'all 3 div.a-row containers must survive translation').toBe(3);

  // 5. 卡片仍有 5 個直接子元素
  const afterChildCount = await evaluate(`document.querySelector('.card').childElementCount`);
  expect(afterChildCount, 'card should still have 5 children').toBe(5);
});
