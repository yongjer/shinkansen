// Regression: v1.8.40 prioritizeUnits tier 0 邊界從 score>=5 降到 score>=1
//
// Fixture: test/regression/fixtures/translate-priority-tier-0-medium-score.html
// 結構特徵:`<main>` 內含 H1 / H2 / H3 + 「中等 score 內文 P 段」(textLen ~100,
// 0-1 commas → score 1-3) + 「極短 byline P」(score < 1)。模擬 Medium 文章常見結構。
//
// v1.7.2-v1.8.39 行為(score>=5 邊界):H tag +5 boost 讓所有 H 段自動 tier 0,
// 但中等 score P 段(score 1-5)被推到 tier 1 → prioritize 後排在 H 段之後 →
// 使用者看到 H1/H2/H3 全部先翻完,內文段才陸續出現,體感「heading 與內文斷層」
// (實測 Medium 1988 stealth aircraft 文章「In 1988, I was obsessed」(score 3.15)
// 被排到 prioIdx 28,H3 副標卻在 prioIdx 2)
//
// v1.8.40 修法:tier 0 內邊界 score >= 5 降到 score >= 1
//   tier 0 = main/article 內 + score >= 1(article 內幾乎所有非極短雜訊段)
//   tier 1 = main/article 內 + score < 1(極短 byline / metadata)
//
// 預期(本 fixture):
//   - byline-noise (P, "Member-only", textLen 11, 0 commas → score 0.11) → tier 1
//   - 其他 6 段(H1/H2/H3 + 三段中等 P)全部 tier 0
//   - tier 0 內按 DOM 順序排:H1 → H2 → medium-p-1 → medium-p-2 → H3 → long-p-after-h3
//   - **medium-p-1 跟 medium-p-2 必須排在 H3 之前**(這是 v1.8.40 的核心保證)
//
// SANITY CHECK 紀錄(已驗證,2026-05-04):
//   暫時把邊界改回 score >= 5(舊行為)→ medium-p-1 / medium-p-2(score < 5)
//   被推到 tier 1 → prioritize 後排到 H3 之後 → 第三點 assertion fail。還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-tier-0-medium-score';

test('priority-tier-0-medium-score: 中等 score (1-5) P 段必須排在後續 heading 之前(保 DOM 順序)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const before = SK.collectParagraphs();
      const after = SK.prioritizeUnits(before);
      const idOf = (u) => u.el?.id || null;
      return JSON.stringify({
        before: before.map(idOf),
        after: after.map(idOf),
      });
    })()
  `);
  const { before, after } = JSON.parse(result);

  // 1. 極短雜訊「Member-only」(score 0.11 < 1)應排到後面(tier 1)
  const bylineIdx = after.indexOf('byline-noise');
  const h1Idx = after.indexOf('article-h1');
  expect(bylineIdx, 'byline-noise 應出現').toBeGreaterThanOrEqual(0);
  expect(h1Idx, 'article-h1 應出現').toBeGreaterThanOrEqual(0);
  expect(
    bylineIdx,
    `byline-noise(score < 1,tier 1)應排在 article-h1(tier 0)之後`,
  ).toBeGreaterThan(h1Idx);

  // 2. 中等 score P 段(medium-p-1 / medium-p-2)必須是 tier 0 → 排在 H3 之前
  //    這是 v1.8.40 修法的核心:不再因為 H3 自動 tier 0 + 中等 P 跌到 tier 1 而錯位
  const mediumP1Idx = after.indexOf('medium-p-1');
  const mediumP2Idx = after.indexOf('medium-p-2');
  const h3Idx = after.indexOf('article-h3-section');
  expect(mediumP1Idx, 'medium-p-1 應出現').toBeGreaterThanOrEqual(0);
  expect(mediumP2Idx, 'medium-p-2 應出現').toBeGreaterThanOrEqual(0);
  expect(h3Idx, 'article-h3-section 應出現').toBeGreaterThanOrEqual(0);
  expect(
    mediumP1Idx,
    `medium-p-1(中等 score P,DOM 在 H3 之前)應排在 article-h3-section 之前(v1.8.40 邊界 score>=1 保證)`,
  ).toBeLessThan(h3Idx);
  expect(
    mediumP2Idx,
    `medium-p-2(中等 score P,DOM 在 H3 之前)應排在 article-h3-section 之前`,
  ).toBeLessThan(h3Idx);

  // 3. tier 0 內 stable sort 保 DOM 順序:H1 → H2 → medium-p-1 → medium-p-2 → H3 → long-p
  //    對應 fixture DOM 順序(byline-noise tier 1 排到後面,從 array 移除後檢查 tier 0 順序)
  const expectedTier0Order = [
    'article-h1',
    'article-subtitle',
    'medium-p-1',
    'medium-p-2',
    'article-h3-section',
    'long-p-after-h3',
  ];
  const tier0Actual = after.filter(id => expectedTier0Order.includes(id));
  expect(
    tier0Actual,
    `tier 0 內應按 DOM 順序排(stable sort),實際 after=${JSON.stringify(after)}`,
  ).toEqual(expectedTier0Order);

  await page.close();
});
