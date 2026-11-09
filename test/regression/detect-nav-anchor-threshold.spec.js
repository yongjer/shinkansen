// Regression: nav-anchor-threshold (對應 v1.0.16 anchor 偵測門檻提高至 20 字元)
//
// Fixture: test/regression/fixtures/nav-anchor-threshold.html
// 結構: <nav> 內的獨立 <a>（無 <li> 包裹）走 anchor 偵測路徑
//
// 結構通則 (不綁站名): <nav> 內的獨立 <a> 元素（無 block 祖先）走 anchor 偵測路徑,
// 門檻 20 字元以下直接跳過。即使超過 20 字的 nav label 也不應被翻譯——
// 但更長的 label 由 system prompt 決定是否跳過。此測試鎖死 < 20 字元的硬排除。
// <li> 內的 <a> 走 walker 偵測路徑（透過 <li> block 進入）,不受此門檻影響。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'nav-anchor-threshold';

test('nav-anchor-threshold: 獨立 <a> 短於 20 字元不被偵測,<li> 內 <a> 仍被偵測', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav#main-nav', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphs())
  `);
  const units = JSON.parse(result);
  const paths = units.map((u) => u.selectorPath || '');

  // 斷言 1: 正常 article 段落仍被偵測
  const controlUnit = units.find((u) => /#control-article/.test(u.selectorPath || ''));
  expect(controlUnit, '正常 #control-article 段落應該被收').toBeDefined();

  // 斷言 2: 主選單裡 < 20 字元的獨立 <a> 都不被偵測
  // （更長的 label 由 system prompt 決定,不在此測試鎖死範圍）
  const navIds = ['nav-short', 'nav-medium', 'nav-long-13', 'nav-long-15'];
  for (const id of navIds) {
    const found = paths.some((p) => new RegExp(`#${id}`).test(p));
    expect(
      found,
      `主選單 #${id} 不應被偵測為翻譯單位,但出現在 units 裡`,
    ).toBe(false);
  }

  // 斷言 3: <li> 內的 <a>（走 walker 路徑）仍被偵測
  const trendingUnit = units.find((u) => /#trending-item/.test(u.selectorPath || ''));
  expect(
    trendingUnit,
    `<li> 內的 #trending-item 應該被收（走 walker 路徑,不受 anchor 門檻影響）`,
  ).toBeDefined();

  await page.close();
});
