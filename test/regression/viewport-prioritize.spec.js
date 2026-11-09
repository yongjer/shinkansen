// Regression: viewport-prioritize (v1.9.27 Layer 11)
//
// prioritizeUnits 加 secondary sort by 距 viewport 距離。同 tier 內 viewport
// 內優先，外按近遠 ASC。對 X / Reddit / Threads / Wikipedia 長頁面捲動時譯文
// 先準備好。
//
// SANITY 紀錄：暫拿掉 viewport secondary sort → 兩 unit 順序按 DOM(top → far)
// 同（因 spec fixture top 仍在前）。改用 inverted fixture(far 先 top 後）能
// 驗證 reorder。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('viewport-prioritize: 同 tier 內 viewport 內段落 sort 在 viewport 外段落之前', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${localServer.baseUrl}/viewport-prioritize.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#top', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 反序輸入 unit 列表：far 先 top 後。
  // 若 prioritizeUnits 走 viewport 距離 secondary sort → top 排前 far 排後
  // （同 tier,top viewport 距離 0、far 距離 ~2384)
  const result = await evaluate(`
    (() => {
      const top = document.querySelector('#top p');
      const far = document.querySelector('#far p');
      const units = [
        { kind: 'element', el: far },
        { kind: 'element', el: top },
      ];
      const sorted = window.__SK.prioritizeUnits(units);
      return sorted.map(u => u.el.parentElement.id);
    })()
  `);
  const order = typeof result === 'string' ? JSON.parse(result) : result;
  expect(order, 'sort 後 top 應在 far 之前（viewport 內優先）').toEqual(['top', 'far']);

  // 第二輪：scroll 到 far 在 viewport 內，sort 後 far 應排前 top
  await page.evaluate(() => window.scrollTo(0, 2200));
  await page.waitForTimeout(200);

  const result2 = await evaluate(`
    (() => {
      const top = document.querySelector('#top p');
      const far = document.querySelector('#far p');
      const units = [
        { kind: 'element', el: top },
        { kind: 'element', el: far },
      ];
      const sorted = window.__SK.prioritizeUnits(units);
      return sorted.map(u => u.el.parentElement.id);
    })()
  `);
  const order2 = typeof result2 === 'string' ? JSON.parse(result2) : result2;
  expect(order2, 'scroll 後 far 在 viewport 內，應排前 top').toEqual(['far', 'top']);

  await page.close();
});
