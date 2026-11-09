// Regression: bbcode-div-text (對應 v1.4.7 + v1.4.9 修的「XenForo BBCode DIV 文字漏翻」bug)
//
// Fixture: test/regression/fixtures/bbcode-div-text.html
//
// Case A (v1.4.7) — 有 block 子孫（UL/LI）:
//   結構: <div class="bbWrapper">intro text<br>Pros:<ul><li>...</li></ul>Overall...</div>
//   Bug：DIV 不在 BLOCK_TAGS_SET，collectParagraphs walker 直接 FILTER_SKIP，
//        containsBlockDescendant / extractInlineFragments 都沒被呼叫。
//   修法：非 BLOCK_TAGS_SET 分支若有直接 TEXT 子節點 + block 子孫，
//        補做 extractInlineFragments，把文字抽成 fragment。
//
// Case B (v1.4.9) — 純文字 + BR（無 block 子孫）:
//   結構: <div class="bbWrapper">段落一<br><br>段落二</div>
//   Bug：containsBlockDescendant = false，v1.4.7 不涵蓋；v1.4.8 試過 else 分支
//        但太寬鬆，誤抓 leaf-content-div / nav 短連結 / 麵包屑（3 條既有 spec）。
//   修法：4 個條件全成立才匹配——
//     (1) tag in CONTAINER_TAGS（DIV/SECTION/ARTICLE/MAIN/ASIDE，排除 inline）
//     (2) 至少有一個直接 <br> 子元素（排除 leaf-content-div 純文字 DIV）
//     (3) 直接 TEXT 總長度 >= 20 字（排除短連結 / 麵包屑）
//     (4) isCandidateText 通過（>= 2 字、非繁中、含字母）
//
// SANITY 紀錄（已驗證）：
//   - Case A：移除 v1.4.7 補做 extractInlineFragments 那段 → fragmentCount=0、斷言 fail
//   - Case B：移除 v1.4.9 else if 整段 → containerWithBr=0、斷言 fail
//   兩者還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE_HTML = 'bbcode-div-text';

test('bbcode-div-text Case A: 有 block 子孫的 bbWrapper intro 文字應被偵測為 fragment', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-a', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-a');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      const elements = units.filter(u => u.kind === 'element');
      const hasIntroFrag = fragments.some(f =>
        (f.el ? f.el.textContent : '').includes('1700 SQFT')
      );
      return {
        fragmentCount: fragments.length,
        elementCount: elements.length,
        hasIntroFrag,
        stats,
      };
    })()
  `);

  // 斷言 1: intro 文字應被偵測為 fragment
  expect(
    result.hasIntroFrag,
    `Case A: intro 段落應被偵測為 fragment，fragmentCount=${result.fragmentCount}\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(true);

  // 斷言 2: LI 仍被正常偵測為 element
  expect(
    result.elementCount,
    `Case A: 應有 >= 2 個 element unit（LI），實際 ${result.elementCount}`,
  ).toBeGreaterThanOrEqual(2);

  await page.close();
});

test('bbcode-div-text Case B: 純文字 + BR 的 bbWrapper 應被偵測為 element 單元', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-b', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-b');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const elements = units.filter(u => u.kind === 'element');
      const hasVacuumedEl = elements.some(u =>
        (u.el ? u.el.textContent : '').includes('Vacuumed another area')
      );
      return {
        elementCount: elements.length,
        hasVacuumedEl,
        containerWithBr: stats.containerWithBr || 0,
        stats,
      };
    })()
  `);

  // 斷言 1: bbWrapper 純文字段落應被偵測為 element
  expect(
    result.hasVacuumedEl,
    `Case B: bbWrapper 純文字應被偵測為 element 單元，elementCount=${result.elementCount}\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(true);

  // 斷言 2: containerWithBr 計數應 >= 1（forcing function：v1.4.9 邏輯被觸發過）
  expect(
    result.containerWithBr,
    `Case B: containerWithBr 計數應 >= 1，實際 ${result.containerWithBr}`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});
