// Regression: vbulletin-author（對應 v1.4.17 修的「vBulletin 論壇討論串列表翻譯後
// 作者 ID 消失」bug）
//
// Fixture: test/regression/fixtures/vbulletin-author.html
// 結構（sanitized forumdisplay 列表每列的 thread title cell）:
//   <td id="target">
//     <div><a id="thread-title">英文標題</a></div>
//     <div class="smallfont">by <span id="author">作者ID</span></div>
//   </td>
//
// Bug 根因（v1.4.16 以前的 collectParagraphs）:
//   TD 沒有 BLOCK_TAGS_SET 後代 → 整個 TD 被當成一個翻譯單元。Gemini 翻完 thread
//   title 後 slot（作者 SPAN）被丟掉，injectIntoTarget 的 clean-slate 路徑把 TD
//   整個清空 → 作者 DIV/SPAN 隨之被抹掉 → 作者 ID 消失。
//
// v1.4.17 修法（content-detect.js → collectParagraphs acceptNode）:
//   block element 若有 CONTAINER_TAGS 直屬子容器 + 容器內有直屬 <A>，改為只捕捉
//   <A> 連結本身，block 本體 FILTER_SKIP。TD 結構不會被 clean-slate 碰到。
//
// 斷言走結構（不綁 class / id / site）:
//   (1) A#thread-title 被偵測為翻譯單元
//   (2) TD#target 不被偵測為 element 單元（核心 regression）
//   (3) skipStats.skipBlockWithContainer >= 1
//   (4) skipStats.blockContainerLink >= 1
//
// SANITY 紀錄（已驗證）：把 content-detect.js 新加的 v1.4.17 區塊（lines 257-289）
// 整段註解掉後，本 spec 在「TD#target 不應被偵測為 element 單元」與「A#thread-title
// 應被偵測」兩條斷言同時 fail（TD 走原本的 FILTER_ACCEPT 被捕捉成 element 單元，
// A 因為 hasBlockAncestor=true 也不會被 leaf-content-anchor pass 接走）。還原修法
// 後 spec pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'vbulletin-author';
const TD_SELECTOR = 'td#target';
const A_SELECTOR = 'a#thread-title';

test('vbulletin-author: block element 含 CONTAINER_TAGS 子容器 + 直屬 <A> 時只捕捉 A，block 本體不成為翻譯單元', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TD_SELECTOR, { timeout: 10_000 });
  await page.waitForSelector(A_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  const unitsPreview = JSON.stringify(
    units.map((u) => ({ kind: u.kind, tag: u.tag, id: u.id, preview: (u.textPreview || '').slice(0, 60) })),
    null,
    2,
  );

  // 斷言 1（核心）：A#thread-title 被偵測為翻譯單元
  const titleUnit = units.find((u) => u.kind === 'element' && u.tag === 'A' && u.id === 'thread-title');
  expect(
    titleUnit,
    `A#thread-title 應被偵測為翻譯單元，實際 units=\n${unitsPreview}`,
  ).toBeDefined();

  // 斷言 2（核心）：TD#target 不被偵測為 element 單元
  // Bug 版本下，TD 會被 walker FILTER_ACCEPT 成一個 element 單元（作者 DIV/SPAN 隨之
  // 被 clean-slate 抹掉）。修法後 TD 應 FILTER_SKIP，不進 units。
  const tdElementUnit = units.find((u) => u.kind === 'element' && u.tag === 'TD' && u.id === 'target');
  expect(
    tdElementUnit,
    `TD#target 不應被偵測為 element 單元（核心 regression），實際 units=\n${unitsPreview}`,
  ).toBeUndefined();

  // 斷言 3：新計數器 skipBlockWithContainer 至少命中 1 次
  expect(
    skipStats.skipBlockWithContainer || 0,
    `skipStats.skipBlockWithContainer 應 >= 1，實際 ${skipStats.skipBlockWithContainer || 0}\nskipStats=${JSON.stringify(skipStats)}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 4：新計數器 blockContainerLink 至少命中 1 次（A 有被捕捉）
  expect(
    skipStats.blockContainerLink || 0,
    `skipStats.blockContainerLink 應 >= 1，實際 ${skipStats.blockContainerLink || 0}\nskipStats=${JSON.stringify(skipStats)}`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});
