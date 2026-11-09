// Regression: options 頁 + 文件翻譯 settings 頁「自動存檔」(2026-06-22)
//
// 背景:手動「儲存設定」按鈕全部移除,改為任一控制項 input/change → debounce(600ms)
// 後自動 save() 寫 storage。本 spec 驗「真實路徑」:改欄位 → 不點任何按鈕 → 等
// debounce → storage 真的被寫入 + save-bar 顯示綠色「已自動儲存」。
//
// 驗的訊號層次:
//   - 驗:改值 → 自動寫進 chrome.storage.sync(功能行為)
//   - 驗:save-bar 進入 'saved' 態(視覺回饋)
//   - 不驗:debounce 精確時序 / 並發 coalescing(_savePending)邊界 — 那條靠 code review
//
// SANITY 紀錄(已驗證 2026-06-22):
//   把 options.js markDirty 內 scheduleAutoSave() 呼叫暫時註解掉 → 「stored===0.33」
//   斷言 fail(storage 維持舊值,save-bar 不變綠)。還原 → pass。
//   doc 頁同理註解 settings.js 的 scheduleAutoSave() → doc 斷言 fail。

import { test, expect } from '../fixtures/extension.js';

test('options 頁:改參數不點按鈕 → 自動寫 storage + save-bar 變綠', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');

  // 沒有任何手動儲存按鈕存在(語言無關,用 data-i18n count)
  await expect(page.locator('[data-i18n="options.action.save"]')).toHaveCount(0);

  // 切到 Gemini 分頁,改 temperature → 不點任何按鈕
  await page.click('.tab-btn[data-tab="gemini"]');
  await page.waitForSelector('#temperature', { state: 'visible' });
  await page.fill('#temperature', '0.33');
  // 等 debounce(600ms)+ storage write
  await expect.poll(async () =>
    page.evaluate(() => new Promise((r) => chrome.storage.sync.get(['geminiConfig'], (o) => r(o.geminiConfig?.temperature)))),
    { timeout: 5000 },
  ).toBe(0.33);

  // save-bar 應進入 saved 態
  await expect(page.locator('#save-bar')).toHaveClass(/saved/);
});

test('文件翻譯 settings 頁:改參數不點按鈕 → 自動寫 storage', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/settings.html`);
  await page.waitForSelector('#td-temperature');

  // 沒有手動儲存按鈕
  await expect(page.locator('#td-save-btn')).toHaveCount(0);

  await page.fill('#td-temperature', '0.77');
  await expect.poll(async () =>
    page.evaluate(() => new Promise((r) => chrome.storage.sync.get(['translateDoc'], (o) => r(o.translateDoc?.temperature)))),
    { timeout: 5000 },
  ).toBe(0.77);

  await expect(page.locator('#save-bar')).toHaveClass(/saved/);
});
