// Regression: v2.0.61 修的「媒體型自訂元素(web component / AMP 類框架元件)翻譯後消失」bug。
//
// Fixture: test/regression/fixtures/inject-custom-element-media-preserve.html
// 結構(不綁站點,三個 case):
//   1. 人物卡 <div><x-media>(內含框架空殼 sizer + img)</x-media><br><b>×N 文字行</div>
//      —— textBearingChildCount ≥ 2 把 (B) media-preserving 踢掉走 (A) clean slate
//   2. 容器 loose text run 緊鄰 <div class="feat"><x-lazy-img/>圖說文字</div>
//      —— block display + 未升級自訂元素(無子節點無文字)+ 帶圖說 → 舊 isInlineRunNode
//      判 true 被吸進 fragment run,注入時整顆被換成純譯文 text node
//   3. inline run 內 textless inline-level 自訂元素 <x-inline-widget/>
//      —— 舊 serialize 透明展開(不在 PRESERVE_INLINE_TAGS、無 children)→ 從 source
//      流消失,fragment clean-rebuild 後 widget 蒸發
// Bug root cause:自訂元素(tag 含 '-')不被 containsMedia / PRESERVE_INLINE_TAGS 認得,
//   detect / serialize / inject 三層都把它當透明或可拋棄節點。
// 修法(結構性通則 §8,不綁 AMP / 站點):
//   - content-ns.js SK.isMediaLikeElement / SK.containsMediaLike:媒體 / embed / 無文字
//     自訂元素統一判 media-like;SK.isBlockMediaGroup(帶文字版 textless 群組判定)
//     讓 isInlineRunNode 對「block display + 含 media-like」斷 run
//   - content-serialize.js fragment 路徑(imgAsSlot)media-like 元素比照 IMG atomic clone
//   - content-inject.js injectIntoTarget (A) clean slate 改 media-sparing:
//     「自身無文字 + media-like」直屬子節點保留原位
//
// SANITY 紀錄(已驗證 2026-07-20,三層分別破壞):
//   1. isInlineRunNode 的 `if (SK.isBlockMediaGroup(child)) return false;` 註解掉 →
//      fail 在「#host 內至少產出翻譯單位 mineCount > 2」(#feat 被吸進 run,單位切分
//      整個塌掉,只剩 ≤2 個 unit)→ 還原 pass
//   2. serializeNodeIterable imgAsSlot 分支撤回 `SK.isMediaLikeElement(child)` 條件 →
//      fail 在「inline run 內 textless widget 存活」(widget 從 fragment 蒸發)→ 還原 pass
//   3. injectIntoTarget (A) 的 isMediaOnlyNode 改成恆 false(等同無條件 clean slate)→
//      fail 在「#card 的 x-media 自訂元素存活」→ 還原 pass

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-custom-element-media-preserve';

test('custom element media: 翻譯後三種結構的自訂元素都存活', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#card x-media img', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 走真實路徑:collectParagraphs → 逐 unit serialize → 假翻譯(佔位符 marker 全保留,
  // 尾端加「 譯」讓文字必然改變、不觸發 echo 還原)→ injectTranslation。
  const injected = await evaluate(`
    (() => {
      const SK = window.__SK;
      const units = SK.collectParagraphs(document.body, {});
      const mine = units.filter(u => u.el && u.el.closest && u.el.closest('#host'));
      const kinds = [];
      for (const unit of mine) {
        const { text, slots } = unit.kind === 'fragment'
          ? SK.serializeFragmentWithPlaceholders(unit)
          : SK.serializeWithPlaceholders(unit.el);
        kinds.push(unit.kind + ':' + (unit.el.id || unit.el.className || unit.el.tagName));
        SK.injectTranslation(unit, text + ' 譯', slots);
      }
      return { unitCount: units.length, mineCount: mine.length, kinds };
    })()
  `);
  expect(injected.mineCount, '#host 內至少產出翻譯單位').toBeGreaterThan(2);

  const after = await page.evaluate(() => {
    const card = document.querySelector('#card');
    const feat = document.querySelector('#feat');
    return {
      // Case 1:卡片自訂元素整顆存活(含框架內部 sizer 與 img 子樹)
      cardXMedia: document.querySelectorAll('#card x-media').length,
      cardXMediaImg: document.querySelectorAll('#card x-media img').length,
      cardXMediaSizer: document.querySelectorAll('#card x-media x-sizer').length,
      cardText: card ? card.textContent.replace(/\s+/g, ' ').trim() : null,
      // Case 2:圖說群組沒被吸進 fragment run,div 與 lazy 自訂元素都在
      featExists: !!feat,
      featLazyImg: document.querySelectorAll('#feat x-lazy-img').length,
      featText: feat ? feat.textContent.replace(/\s+/g, ' ').trim() : null,
      // Case 3:inline run 內 textless widget 經 fragment rebuild 後存活
      inlineWidget: document.querySelectorAll('#qa x-inline-widget').length,
      qaText: (document.querySelector('#qa')?.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  });

  // Case 1
  expect(after.cardXMedia, '#card 的 x-media 自訂元素存活').toBe(1);
  expect(after.cardXMediaImg, 'x-media 內 img 子樹完整').toBe(1);
  expect(after.cardXMediaSizer, 'x-media 內框架 sizer 子樹完整').toBe(1);
  expect(after.cardText, '#card 文字已注入譯文').toContain('譯');
  // Case 2
  expect(after.featExists, '#feat 圖說群組未被 fragment 整顆吞掉').toBe(true);
  expect(after.featLazyImg, '#feat 內未升級自訂元素存活').toBe(1);
  expect(after.featText, '#feat 圖說文字已注入譯文').toContain('譯');
  // Case 3
  expect(after.inlineWidget, 'inline run 內 textless widget 存活').toBe(1);
  expect(after.qaText, '#qa loose text 已注入譯文').toContain('譯');

  await page.close();
});
