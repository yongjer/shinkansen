// Regression: options 頁 iOS / 窄視窗閱讀性（v1.10.22.x）。
//
// Bug:options.html 沒有 viewport meta（popup 在 v1.10.22 加了，options 漏了），
// iOS Safari 用 ~980px 桌面虛擬 viewport 渲染，720px container 整頁等比縮小到
// 不可讀。加 meta 後 layout viewport 變 ~390pt，原本 720px 版面下不會暴露的
// 橫向溢出點（usage 四卡 grid / model-pricing 固定欄 / .triple 三欄 /
// pagination min-width 等）需由 options.css 末段窄版 media query 收掉。
// 順帶修同輪發現的既有 bug：.usage-pagination 的 display: flex 蓋掉 UA
// [hidden] { display: none }，≤1 頁時死按鈕照樣顯示（v1.6.5 同 pattern）。
//
// 訊號層次：本 spec 驗（a）viewport meta 存在（b）390px 寬逐 tab 無橫向溢出
// （c）pagination 按鈕沒被擠成逐字直排（d）1280px 桌面版面不受 media query 影響
// （e）grid 內元件最小可用寬度——（b）的 scrollWidth 只抓「撐爆 document」級溢出，
// 抓不到「grid 把元件壓扁但整體沒溢出」級的視覺壞（實測：拿掉 model-pricing
// 窄版規則後 1fr 縮成 18px、第一個 input 被壓到 ~18px 寬，scrollWidth 仍 390），
// 所以（e）直接斷言元件 bounding width 下限（f）[hidden] 的 pagination 真的隱藏。
// UI 語言鎖 zh-TW：headless Chromium navigator.language=en-US 會套 en dict,
// 「Previous」是單字不會逐字直排，（c）測不到 CJK 逐字折行這個症狀。
// 不驗：iOS WebKit 對 viewport meta 的實際縮放行為（desktop Chromium 忽略
// viewport meta，這層只能 iOS Simulator / 真機驗，見 tools/probe-options-rwd.js
// 註解）、16px input 防 focus-zoom 規則的 iOS 實際行為（body.runtime-ios 只在
// iOS build 生效）。
//
// SANITY 紀錄（已驗證 2026-06-07）：
//   1. 拿掉 options.html viewport meta →（a）fail（locator 等不到 meta）；還原 → pass。
//   2. comment 掉窄版 .model-pricing-row 三欄規則 →（e）fail（第一個計價 input
//      width 18 < 60）；comment 掉 .usage-summary 兩欄規則 →（e）fail（summary
//      card width 81 < 120）；comment 掉 .usage-pagination 窄版三條 →（c）fail
//      （zh-TW「上一頁」逐字直排 height 80 ≥ 50）；comment 掉
//      .usage-pagination[hidden] 規則 →（f）fail。各自還原 → 全綠。
//   註：最初 SANITY 試過只靠（b）抓 CSS 規則移除，結果 grid 元件被壓扁時
//   scrollWidth 不變、（b）不會 fail ——（e）就是補這層 missing check 加的。

import { test, expect } from '../fixtures/extension.js';

const TABS = ['settings', 'youtube', 'gemini', 'custom-provider', 'glossary', 'forbidden', 'usage', 'log'];

async function setUiZhTW(context) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async () => {
    await chrome.storage.sync.set({ uiLanguage: 'zh-TW' });
  });
}

test('options 頁有 viewport meta，390px 寬逐 tab 無橫向溢出、元件不被壓扁', async ({ context, extensionId }) => {
  await setUiZhTW(context);
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('.tab-bar');
  // 等 zh-TW dict applyI18n 完成（手動儲存按鈕已移除改自動存檔，sentinel 改用「介面語言」標題）
  await expect(page.locator('[data-i18n="options.uiLanguage.heading"]')).toHaveText('介面語言');

  // （a）viewport meta 存在且為 device-width（iOS 縮放修正的根本）
  const viewportMeta = await page.getAttribute('meta[name="viewport"]', 'content');
  expect(viewportMeta).toContain('width=device-width');

  // （b）8 個 tab 都沒有橫向溢出
  for (const tab of TABS) {
    await page.click(`.tab-btn[data-tab="${tab}"]`);
    await page.waitForTimeout(200);
    const { scrollWidth, vw } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      vw: window.innerWidth,
    }));
    expect(scrollWidth, `tab "${tab}" 在 390px 寬出現橫向溢出`).toBeLessThanOrEqual(vw + 1);
  }

  // （f）無資料（≤1 頁）時 options.js 設 hidden → pagination 必須真的隱藏
  //     （display: flex 蓋掉 UA [hidden] 的既有 bug）
  await page.click('.tab-btn[data-tab="usage"]');
  await expect(page.locator('.usage-pagination')).toBeHidden();

  // （c）pagination 按鈕維持單行（被 .usage-page-info min-width 200px 擠壓時
  //     zh-TW「上一頁」會逐字直排，高度爆到 ~80px）。fresh profile 沒有用量
  //     資料、pagination 被 hidden，先手動解除才能量版面（只驗 CSS 排版層，
  //     不驗資料邏輯）
  await page.evaluate(() => { document.querySelector('.usage-pagination').hidden = false; });
  const prevBtnBox = await page.locator('.usage-pagination button').first().boundingBox();
  expect(prevBtnBox.height, 'pagination 按鈕被擠成逐字直排').toBeLessThan(50);
  await page.evaluate(() => { document.querySelector('.usage-pagination').hidden = true; });

  // （e）grid 元件最小可用寬度（scrollWidth 抓不到「壓扁但沒溢出」，見頂部註解）
  //     用量彙總卡：2×2 時每卡 ~173px；退回四欄會壓到 ~80px
  const cardBox = await page.locator('.usage-summary .summary-card').first().boundingBox();
  expect(cardBox.width, 'usage 彙總卡被壓扁（窄版 2×2 規則失效）').toBeGreaterThanOrEqual(120);
  //     Gemini per-model 計價 input：三等欄時 ~100px；退回桌面固定欄會把 1fr 壓到 ~18px
  await page.click('.tab-btn[data-tab="gemini"]');
  const priceInputBox = await page.locator('.model-pricing-row input').first().boundingBox();
  expect(priceInputBox.width, '計價 input 被壓扁（窄版 model-pricing 規則失效）').toBeGreaterThanOrEqual(60);
});

test('1280px 桌面版面不受窄版 media query 影響', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('.tab-bar');

  // container 維持 720px 置中卡片版面（margin auto + padding 32；
  // content-box 720 + padding 64 = border-box 784）
  const box = await page.locator('.container').boundingBox();
  expect(Math.round(box.width)).toBe(784);
  const padding = await page.locator('.container').evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(padding).toBe('32px');

  // usage 彙總卡維持四欄
  await page.click('.tab-btn[data-tab="usage"]');
  const cols = await page.locator('.usage-summary').evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length
  );
  expect(cols).toBe(4);
});
