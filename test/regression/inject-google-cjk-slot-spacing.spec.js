// Regression: v1.10.4 — Google MT 翻成 CJK 時吃掉 placeholder marker 前後空格,
// 導致譯文跟 URL/mention 視覺黏在一起(「傳聞如下https://…透過@user」)。
//
// 修法:content-serialize.js 新增 SK.ensureCJKSlotSpacing,
// translateUnitsGoogle 路徑 restoreGoogleTranslateMarkers 後呼叫。
// 只對 opening ⟦N⟧ / atomic ⟦*N⟧ 前(CJK→slot)和
// closing ⟦/N⟧ / atomic ⟦*N⟧ 後(slot→CJK)補空格;
// 不動 ⟦N⟧ 後(slot 內容起始)與 ⟦/N⟧ 前(slot 內容結尾)。
//
// Fixture: test/regression/fixtures/inject-google-cjk-slot-spacing.html
//
// SANITY 紀錄(已驗證):
//   - 暫改 SK.ensureCJKSlotSpacing 為 identity function(return s)
//     → 3 條 spec fail(mainText 尾缺空格 / connectorText 首缺空格 / paired 邊界缺空格)
//   - 還原 → 全 pass

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-google-cjk-slot-spacing';
const TARGET_SELECTOR = '#tweet';

test('Google MT CJK↔slot 空格:SK.ensureCJKSlotSpacing 對 atomic + paired 邊界正確補空格', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const fn = window.__SK.ensureCJKSlotSpacing;
      if (!fn) return { error: 'ensureCJKSlotSpacing not found' };
      return {
        // atomic:CJK 直接黏 ⟦*0⟧ → 補空格
        atomicBefore: fn('傳聞如下⟦*0⟧something'),
        // closing atomic → CJK:⟦*0⟧ 直接黏 CJK → 補空格
        atomicAfter: fn('something⟦*0⟧透過'),
        // closing paired → CJK:⟦/0⟧ 直接黏 CJK → 補空格
        closingBefore: fn('text⟦/0⟧更多文字'),
        // CJK → opening paired:CJK 直接黏 ⟦0⟧ → 補空格
        openingAfter: fn('文字⟦0⟧@user⟦/0⟧'),
        // ⟦0⟧ 後接 slot 內容(CJK):不應補空格(slot 內容起始)
        openingInside: fn('⟦0⟧由 ⟦/0⟧'),
        // ⟦/0⟧ 前接 slot 內容(CJK):不應補空格(slot 內容結尾)
        closingInside: fn('⟦0⟧文字⟦/0⟧'),
        // 已有空格不重複
        alreadySpaced: fn('如下 ⟦*0⟧ 透過'),
      };
    })()
  `);

  // 該補空格的場景
  expect(result.atomicBefore, 'CJK→atomic 前補空格').toBe('傳聞如下 ⟦*0⟧something');
  expect(result.atomicAfter, 'atomic→CJK 後補空格').toBe('something⟦*0⟧ 透過');
  expect(result.closingBefore, 'closing→CJK 後補空格').toBe('text⟦/0⟧ 更多文字');
  expect(result.openingAfter, 'CJK→opening 前補空格').toBe('文字 ⟦0⟧@user⟦/0⟧');
  // 不該補空格的場景(slot 內容邊界)
  expect(result.openingInside, 'opening 後不補(slot 內容起始)').toBe('⟦0⟧由 ⟦/0⟧');
  expect(result.closingInside, 'closing 前不補(slot 內容結尾)').toBe('⟦0⟧文字⟦/0⟧');
  // 已有空格不重複
  expect(result.alreadySpaced, '已有空格不重複').toBe('如下 ⟦*0⟧ 透過');

  await page.close();
});

test('Google MT CJK↔slot 空格:真實 fixture 注入後 text node 有空格', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);

      // 模擬 Google MT:CJK 譯文 marker 前後無空格
      let fakeOutput = sourceText
        .replace(/iOS 27 will upgrade the Camera and Photos apps: here's what's rumored/,
          'iOS 27 將升級相機介面和照片應用程式：傳聞如下')
        .replace(/ via /, '透過');

      const restored = window.__SK.restoreGoogleTranslateMarkers(fakeOutput);
      // 走 production path:SK.ensureCJKSlotSpacing
      const spaced = window.__SK.ensureCJKSlotSpacing(restored);
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, spaced, slots);
    })()
  `);

  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const mainSpan = el.querySelector('.main-text');
    const connector = el.querySelector('.connector');
    return {
      mainText: mainSpan?.textContent,
      connectorText: connector?.textContent,
      nodeValueMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  expect(result.nodeValueMutated, '走 nodeValue mutate path').toBe(true);
  expect(result.wrapper_present, '不應產生 dual wrapper').toBe(false);
  expect(result.mainText, '主文結尾必須有空格(CJK→URL 邊界)').toMatch(/如下\s/);
  expect(result.connectorText, '連接詞應含「透過」').toContain('透過');

  await page.close();
});

test('Google MT CJK↔paired slot 邊界:opening/closing 正確區分', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const fn = window.__SK.ensureCJKSlotSpacing;
      // 模擬 LLM tolerant test case 的結構:⟦0⟧由 ⟦/0⟧
      // opening ⟦0⟧ 後接 CJK「由」→ 不應補空格(slot 內容起始)
      const input = '⟦0⟧由 ⟦/0⟧⟦1⟧⟦2⟧@user⟦/2⟧⟦/1⟧ 撰寫的⟦3⟧《Book》⟦/3⟧';
      return { input, output: fn(input) };
    })()
  `);

  // ⟦0⟧ 後接 CJK → 不補(slot 內容起始)
  expect(result.output, 'opening 後 CJK 不補空格').toContain('⟦0⟧由');
  // 「的」前接 ⟦3⟧ → 補空格(CJK→opening 邊界)
  expect(result.output, 'CJK→opening 補空格').toContain('的 ⟦3⟧');

  await page.close();
});
