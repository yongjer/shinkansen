// Regression: placeholder-empty-slots-leak（2026-07-02 修的「佔位符 ⟦N⟧ 漏進可見 DOM」bug）
//
// Fixture: test/regression/fixtures/placeholder-empty-slots-leak.html
// 結構：一個純文字、無 inline 子元素的 <p> → serializeWithPlaceholders 產出 slots = []。
// Bug：no-slots 注入路徑（element replaceTextInPlace / fragment / dual / framework nvMutate）
//      都不經 deserializeWithPlaceholders,不會消耗佔位符。剝佔位符原本全掛在 slots>0 分支,
//      一旦「帶佔位符譯文 + 空 slots」配對出現（真實成因:framework re-render 後某段內容
//      搬進純文字元素、重新序列化成空 slots,卻命中一份帶佔位符的 tc_ 快取譯文——快取存的
//      是未反序列化的原始 API 輸出）,佔位符就被原封寫進 textContent 被使用者看到。
// 修法：injectTranslation 入口對「空 slots」統一 stripStrayPlaceholderMarkers,把
//      「placeholders ⟺ slots」不變量在注入端強制成立而非假設成立(content-inject.js)。
//
// 訊號層界定：本 spec 驗「空 slots + 帶佔位符譯文 → 注入後可見文字無 ⟦⟧」這條注入端不變量。
//      不驗「framework re-render 實際會不會製造這種配對」(那是 SPA guard / cache 層,harness
//      的 React reflow 模擬不出真實 NYT 時序,見對應除錯紀錄)。
//
// SANITY 紀錄（已驗證）：把 content-inject.js injectTranslation 入口那段
//      「(!slots || slots.length === 0) → stripStrayPlaceholderMarkers」註解掉 →
//      核心斷言 hasOpenBracket / hasCloseBracket 由 false 變 true(⟦⟧ 洩漏) → spec fail;
//      還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import {
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'placeholder-empty-slots-leak';
const TARGET_SELECTOR = 'p#target';

// 模擬 tc_ 快取值：帶巢狀佔位符的原始 API 譯文（⟦0⟧…⟦/0⟧ 圖說本文 + ⟦1⟧⟦2⟧…⟦/2⟧…⟦/1⟧
// 圖片來源巢狀結構）。純文字元素的 slots=[],這些佔位符沒有對應 slot → 正是解耦情境。
const TRANSLATION =
  '⟦0⟧位於英格蘭的工廠。⟦/0⟧⟦1⟧⟦2⟧圖片來源……⟦/2⟧某攝影師⟦/1⟧';

test('placeholder-empty-slots-leak: 空 slots + 帶佔位符譯文 → 可見文字不得洩漏 ⟦⟧', async ({
  context,
  localServer,
}) => {
  // canned 譯文確實含成對佔位符
  expect(TRANSLATION.includes('⟦')).toBe(true);
  expect(TRANSLATION.includes('⟧')).toBe(true);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 前置：確認這個純文字元素序列化成「空 slots」（bug 觸發的必要條件）
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { slots } = window.__shinkansen.serialize(el);
      return { slotCount: slots.length };
    })())
  `);
  expect(JSON.parse(serialized).slotCount).toBe(0);

  // 注入帶佔位符的譯文（走 no-slots 路徑）
  await runTestInject(evaluate, TARGET_SELECTOR, TRANSLATION);

  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    return {
      text: p.textContent,
      hasOpenBracket: p.textContent.includes('⟦'),
      hasCloseBracket: p.textContent.includes('⟧'),
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 核心斷言：佔位符不得漏進可見文字
  expect(
    after.hasOpenBracket,
    `p#target 不該含 ⟦ (U+27E6)，實際文字: ${JSON.stringify(after.text)}`,
  ).toBe(false);
  expect(
    after.hasCloseBracket,
    `p#target 不該含 ⟧ (U+27E7)，實際文字: ${JSON.stringify(after.text)}`,
  ).toBe(false);

  // 半截標記（/0、/1、/2）也不得殘留
  expect(after.text.includes('/0')).toBe(false);
  expect(after.text.includes('/1')).toBe(false);
  expect(after.text.includes('/2')).toBe(false);

  // 譯文主體（剝掉佔位符後的中文）仍在
  expect(after.text.includes('位於英格蘭的工廠')).toBe(true);
  expect(after.text.includes('圖片來源')).toBe(true);

  await page.close();
});
