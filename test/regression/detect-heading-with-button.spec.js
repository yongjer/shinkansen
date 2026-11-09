// Regression: heading-with-button (對應 v1.0.12 heading 豁免 widget 檢查)
//
// Fixture: test/regression/fixtures/heading-with-button.html
// 結構特徵:
//   heading（H1-H6）內含 <button>（如 Substack 的 anchor link 圖示按鈕），
//   觸發 isInteractiveWidgetContainer（button + textLen < 300），
//   導致標題被 REJECT 不翻譯。
//
// v1.0.11 以前的 bug:
//   isInteractiveWidgetContainer 只豁免 PRE，不豁免 heading。
//   Substack 在每個 h4.header-anchor-post 內嵌入 <button aria-label="Link">，
//   textLen 通常 < 300，widget 檢查命中 → heading 被跳過。
//
// v1.0.12 修法:
//   新增 WIDGET_CHECK_EXEMPT_TAGS 常數，H1-H6 與 PRE 統一豁免。
//   heading 的 HTML 語意就是標題，內部的 button 是輔助控制項不是 CTA。
//
// 斷言基於 HTML 語意（heading tag），不綁站點，符合硬規則 8。
// SANITY 紀錄(已驗證):從 WIDGET_CHECK_EXEMPT_TAGS 移除 'H4' → 「#heading-with-btn 必須被偵測」斷言 fail。還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'heading-with-button';
const HEADING_SELECTOR = 'h4#heading-with-btn';

test('heading-with-button: 含 button 的 H4 必須被偵測為翻譯單位', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(HEADING_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units } = JSON.parse(result);

  // 斷言 1: #heading-with-btn（含 button 的 H4）必須被偵測到
  const headingUnit = units.find((u) =>
    (u.textPreview || '').includes('Imagineering')
  );
  expect(headingUnit, '應偵測到含 "Imagineering" 的 H4 標題').toBeDefined();

  // 斷言 2: #normal-heading（正常 H3）也被偵測到
  const normalHeading = units.find((u) =>
    (u.textPreview || '').includes('Disneyland')  && u.tag === 'H3'
  );
  expect(normalHeading, '正常 H3 標題應被偵測').toBeDefined();

  // 斷言 3: #widget-card（LI 含 Follow button）不應被偵測（真正的 widget）
  const widgetUnit = units.find((u) =>
    (u.textPreview || '').includes('John Doe')
  );
  expect(widgetUnit, '含 Follow button 的 LI widget 不應被偵測').toBeUndefined();

  await page.close();
});

test('heading-with-button: 注入譯文後文字正確替換', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(HEADING_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await runTestInject(evaluate, HEADING_SELECTOR, translation);

  const injectedText = await evaluate(`
    document.querySelector(${JSON.stringify(HEADING_SELECTOR)}).textContent.trim()
  `);
  expect(injectedText).toContain('幻想工程');

  await page.close();
});
