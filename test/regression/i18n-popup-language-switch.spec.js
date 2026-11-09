// Regression: P2 (v1.8.60) popup UI i18n — 切換 targetLanguage 後 popup 文字
// 即時 reapply,並對 5 語 fallback target(ja 等)走英文 dict + 顯示 fallback banner。
//
// 對應規則:CLAUDE.md §16(雙語檔同步,本檔驗 dict 三語各自 ship 給 popup)+
// SPEC §3.10「UI Localization」(P2)。
//
// SANITY 紀錄(已驗證 2026-05-08):
//   把 popup.js 的 `I18N.subscribeUiLanguageChange((newUi, newTarget) => { ... applyI18n ... })`
//   callback 內的 `I18N.applyI18n(document, _currentTarget);` 整行 comment 掉 → 切 storage
//   targetLanguage 後 popup 內 data-i18n 文字不會更新 → 「切 zh-CN → 文字立即更新」斷言
//   fail(Expected「显示模式」/ Received「顯示模式」)。還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';

// v1.8.60:UI 語系從 targetLanguage 解綁,改用獨立的 uiLanguage 偏好。
// helper 也跟著改:setUi 寫 uiLanguage(三語其一 / 'auto');setTarget 仍可用,
// 但 popup UI 不再依此切換 — 留作對照組(下方 「target 改不影響 UI」案例會用到)。
async function setUi(context, ui) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async (u) => {
    await chrome.storage.sync.set({ uiLanguage: u });
  }, ui);
}

async function changeUi(context, ui) {
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(async (u) => {
    await chrome.storage.sync.set({ uiLanguage: u });
  }, ui);
}

test('popup 載入後依 uiLanguage 切 dict(zh-TW / zh-CN / en)', async ({ context, extensionId }) => {
  await setUi(context, 'zh-TW');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#translate-btn');

  // 等 applyI18n 跑完(等 textContent 變成 dict 值,而不是 HTML 預設「翻譯本頁」)
  await expect(page.locator('#translate-btn')).toHaveText('翻譯本頁');
  await expect(page.locator('[data-i18n="popup.label.displayMode"]')).toHaveText('顯示模式');

  // 切 zh-CN → 文字立即更新
  await changeUi(context, 'zh-CN');
  await expect(page.locator('#translate-btn')).toHaveText('翻译本页');
  await expect(page.locator('[data-i18n="popup.label.displayMode"]')).toHaveText('显示模式');

  // 切 en → 文字立即更新
  await changeUi(context, 'en');
  await expect(page.locator('#translate-btn')).toHaveText('Translate page');
  await expect(page.locator('[data-i18n="popup.label.displayMode"]')).toHaveText('Display mode');
});

test('popup uiLanguage="auto" + headless chromium → 走 en dict(navigator.language 推導)', async ({ context, extensionId }) => {
  await setUi(context, 'auto');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#translate-btn');

  // headless chromium navigator.language 預設為 en-US(extension fixture 沒指定 --lang),
  // 'auto' → resolveUiLanguage 推導為 en → translate-btn = 'Translate page'
  await expect(page.locator('#translate-btn')).toHaveText('Translate page');
});

test('popup #shortcut-hint(JS 動態設 textContent 的元素)依 target 顯示對應語言', async ({ context, extensionId }) => {
  // v1.8.60 修補:#shortcut-hint 由 refreshShortcutHint() 動態設 textContent,
  // 不掛 data-i18n。原本 init 開頭就呼叫此函式時 _currentTarget 仍是初始 zh-TW,
  // 把繁中「快速切換」字串黏進去,後面 applyI18n 救不回(applyI18n 只掃 data-i18n)。
  // 修法:把 refreshShortcutHint 移到 _currentTarget 從 storage 讀完之後才呼叫。
  //
  // SANITY 紀錄(已驗證 2026-05-08):還原成「init 開頭呼叫 refreshShortcutHint()」→
  // en UI #shortcut-hint 仍含「快速切換」→ 斷言 fail。修正後 → pass。
  await setUi(context, 'en');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#translate-btn');
  await expect(page.locator('#translate-btn')).toHaveText('Translate page');

  // 等 refreshShortcutHint 跑完(timeout 寬一點,因為內部 await chrome.commands.getAll())
  await page.waitForTimeout(500);
  const hintText = await page.locator('#shortcut-hint').textContent();
  // hintText 可能是「⌥S quick toggle」/「No shortcut set」/「」(commands API 失敗時),
  // 但絕不可包含繁中「快速切換」/「未設定快捷鍵」字串。
  expect(hintText, 'en target popup hint 不該夾繁中字串').not.toContain('快速切換');
  expect(hintText, 'en target popup hint 不該夾繁中字串').not.toContain('未設定快捷鍵');
});
