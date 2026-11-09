// Regression: v2.0.6 修的「翻譯後媒體群組(頭像列)結構被拍平、尺寸爆大」bug。
//
// Fixture: test/regression/fixtures/inject-textless-block-media-group.html
// 結構(不綁站點):容器直屬有「text『阅读』+ <span>數字 + block-level(display:flex)
//   媒體群組 <div class="media-group"><span><img>×5</span></div>」。媒體(IMG)沒 class /
//   width 屬性,尺寸只靠祖先範圍後代選擇器 `.media-group img { width:18px }` 撐。
// Bug:media-group 是 DIV(不在 BLOCK_TAGS_SET)、無 block 後代(只有 span+img)→
//   isInlineRunNode 誤判為 true → extractInlineFragments 把它併進 inline run →
//   fragment 序列化把 IMG 當 atomic slot deep clone、把 .media-group / span 包裹層當
//   透明容器拍平 → injectFragmentTranslation clean-rebuild 成扁平 IMG siblings →
//   `.media-group img` 祖先鏈斷 → IMG 失去 18px 尺寸,回退成 fallback `img{110px}`(頭像爆大)。
// 修法(結構性通則 §8):isInlineRunNode 對「無文字 + 含媒體 + block-level display」的
//   容器回 false(SK.isTextlessBlockMediaGroup)→ 當 run breaker、留在原 DOM 不動,
//   fragment 只翻真正的文字。行內 emoji(display:inline 的 <span><img></span>)不受影響。
//
// SANITY 紀錄(已驗證 2026-07-07):把 content-ns.js isInlineRunNode 內
//   `if (SK.isTextlessBlockMediaGroup(child)) return false;` 註解掉 → media-group 被
//   併進 fragment 翻譯 → 注入後 `.media-group` 消失、`.media-group img` count 變 0、
//   IMG computed width 變 110px → 三條斷言全 fail → 還原該行 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-textless-block-media-group';

test('textless block media group: 翻譯後頭像列結構存活、尺寸不爆', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target .media-group img', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 走真實路徑:collectParagraphs → 逐 unit serialize → 假翻譯(只把中文「阅读」→「閱讀」,
  // 保留一切佔位符 marker)→ injectTranslation(fragment 走 injectFragmentTranslation)。
  const injected = await evaluate(`
    (() => {
      const SK = window.__SK;
      const units = SK.collectParagraphs(document.body, {});
      const mine = units.filter(u => u.el && u.el.id === 'target');
      let injectedCount = 0;
      for (const unit of mine) {
        const { text, slots } = unit.kind === 'fragment'
          ? SK.serializeFragmentWithPlaceholders(unit)
          : SK.serializeWithPlaceholders(unit.el);
        const fake = text.replace('阅读', '閱讀');
        SK.injectTranslation(unit, fake, slots);
        injectedCount++;
      }
      return { unitCount: units.length, mineCount: mine.length, injectedCount };
    })()
  `);
  expect(injected.mineCount, '#target 至少產出一個翻譯單位').toBeGreaterThan(0);

  // 斷言:媒體群組結構完整存活(未被拍平),IMG 仍受祖先範圍 CSS 管轄(18px 不爆)。
  const after = await page.evaluate(() => {
    const group = document.querySelectorAll('.media-group');
    const groupImgs = document.querySelectorAll('.media-group img');
    const firstImg = groupImgs[0];
    return {
      groupCount: group.length,
      groupImgCount: groupImgs.length,
      firstImgWidth: firstImg ? getComputedStyle(firstImg).width : null,
      targetText: document.querySelector('#target').textContent.replace(/\s+/g, ' ').trim(),
    };
  });

  expect(after.groupCount, '.media-group wrapper 未被拍平').toBe(1);
  expect(after.groupImgCount, '5 個頭像 IMG 仍在 .media-group 內').toBe(5);
  expect(after.firstImgWidth, 'IMG 仍受 .media-group img 祖先 CSS 管轄(18px,非爆大 110px)').toBe('18px');
  // 文字仍被翻譯(「阅读」→「閱讀」)
  expect(after.targetText, '容器文字已翻譯').toContain('閱讀');

  await page.close();
});
