// Regression: twitter-interactive-widget-skip (對應 v0.39 互動 widget 容器跳過)
//
// Fixture: test/regression/fixtures/twitter-widget.html
// 結構: <div>...內含 <button>Follow</button>...</div>,innerText 短於 300 字
//
// 結構通則 (不綁站名):block 內含 button 或 role="button" 且文字 < 300 字 →
// 整塊判定為互動 widget 卡片,FILTER_REJECT 跳過,計入 skipStats.interactiveWidget。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'twitter-widget';

test('twitter-interactive-widget-skip: 含 button 的 block 容器必須整塊跳過', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('li#widget', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  // 斷言 1: skipStats.interactiveWidget 命中
  expect(
    skipStats.interactiveWidget || 0,
    `interactiveWidget skip 應 >= 1,實際 ${skipStats.interactiveWidget || 0}\nskipStats: ${JSON.stringify(skipStats)}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2: widget 內部任何元素都不出現在 units 裡
  // (selectorPath 裡若含 #widget 就算被誤收)
  const widgetUnits = units.filter((u) => /#widget/.test(u.selectorPath || ''));
  expect(
    widgetUnits.length,
    `widget 內部不該出現在 units,實際: ${JSON.stringify(widgetUnits)}`,
  ).toBe(0);

  // 斷言 3: 同頁正常 article p 仍被收 (證明只跳 widget,不跳全頁)
  const controlUnit = units.find((u) => /#control/.test(u.selectorPath || ''));
  expect(controlUnit, '正常 #control 段落應該被收').toBeDefined();
  expect(controlUnit.kind).toBe('element');
  expect(controlUnit.textPreview).toContain('normal article paragraph');

  await page.close();
});
