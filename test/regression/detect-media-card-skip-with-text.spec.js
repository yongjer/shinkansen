// Regression: detect-media-card-skip-with-text
//
// Fixture: test/regression/fixtures/detect-media-card-skip-with-text.html
//
// 真實案例(v1.9.15 修補根因):
//   eet-china.com 文章內 P 結構:
//     P > text("具体而言...") + B*5 + text("，该集群...") + DIV.partner-content
//   原 mediaCardSkip(content-detect.js v1.5.7)三條件:
//     1. not H1-6
//     2. el.querySelector('img, picture, video')(廣告 DIV 內含 img)
//     3. some child is CONTAINER_TAGS(P 直屬有 DIV.partner-content)
//   全命中 → FILTER_SKIP → P 整段純文字永遠不翻,使用者看到 SC 原文。
//
// 修法 v1.9.15:加第 4 條 `directTextLength(el) < 20` 例外。
//   - directTextLength = el 直屬 text node 文字長度總和(現有函式)
//   - eet-china P 直屬有 200+ chars 文字 → 跳過 mediaCardSkip → 走 element 路徑
//   - LI > A.file-preview + DIV.file-content 結構 LI 直屬無 text node,
//     directTextLength=0 仍命中,既有附件卡片偵測不破壞。
//
// 斷言:
//   1. eet-china 風格 P(直屬文字 + 內嵌廣告 DIV)應 collected as element
//   2. LI 附件卡片(無直屬文字)應仍 mediaCardSkip skipped(integer)
//
// SANITY 紀錄(已驗證):
//   暫時把 directTextLength < 20 例外拿掉(回到原 v1.5.7 條件)
//   → article-p-with-inline-ad 命中 mediaCardSkip FILTER_SKIP → 不在 collected
//   → 斷言 1 FAIL(matchedFound=false)
//   還原修法 → 全部 PASS。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-media-card-skip-with-text';

test('detect-media-card-skip-with-text: P 內含實質文字 + 廣告 DIV 應 collected', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#article-p-with-inline-ad', { timeout: 10_000 });
  // 等動態注入廣告 DIV 完成
  await page.waitForFunction(
    () => !!document.querySelector('#article-p-with-inline-ad .partner-content-article'),
    { timeout: 5_000 },
  );

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const r = window.__shinkansen.collectParagraphsWithStats();
      const articleP = r.units.find(u => u.id === 'article-p-with-inline-ad');
      const attachmentLI = r.units.find(u => u.id === 'attachment-card');
      // 確認 DOM 結構符合預期
      const targetP = document.getElementById('article-p-with-inline-ad');
      return {
        articleP_collected: !!articleP,
        articleP_kind: articleP ? articleP.kind : null,
        attachmentLI_collected: !!attachmentLI,
        skipStats: r.skipStats,
        articleP_hasInlineAd: !!targetP.querySelector('.partner-content-article'),
        articleP_hasInlineImg: !!targetP.querySelector('img'),
        articleP_directChildTags: Array.from(targetP.children).map(c => c.tagName).join(','),
      };
    })()
  `);

  // 斷言 1:eet-china 風格 P 應 collected
  expect(
    result.articleP_hasInlineAd,
    '前置條件:fixture 應已動態注入 partner-content-article DIV 進 P',
  ).toBe(true);
  expect(
    result.articleP_hasInlineImg,
    '前置條件:廣告 DIV 內應含 img(觸發 mediaCardSkip 條件 2)',
  ).toBe(true);
  expect(
    result.articleP_collected,
    'P 內含實質文字 + 廣告 DIV 應 collected(v1.9.15 directTextLength>=20 例外),' +
    '原 mediaCardSkip 會誤殺整段',
  ).toBe(true);
  expect(
    result.articleP_kind,
    '此 P 直屬有實質文字 + inline 元素 + 廣告 DIV,應走 element 路徑',
  ).toBe('element');

  // 斷言 2:LI 附件卡片應仍 mediaCardSkip(既有行為不破壞)
  expect(
    result.attachmentLI_collected,
    'LI 附件卡片(無直屬文字)應仍 mediaCardSkip skipped — 既有 v1.4.20 行為',
  ).toBe(false);
  expect(
    (result.skipStats || {}).mediaCardSkip || 0,
    'mediaCardSkip stat 應至少有 1(LI 附件卡片),確認新例外沒讓所有 mediaCardSkip 失效',
  ).toBeGreaterThan(0);

  await page.close();
});
