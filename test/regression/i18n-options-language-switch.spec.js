// Regression: P2 (v1.8.60) options UI i18n — 切換 uiLanguage(透過 options 內
// #uiLanguage <select>)後 options 頁面文字即時 reapply。
//
// v1.8.60 改寫:UI 語系從 targetLanguage 解綁,改用獨立 #uiLanguage picker。
// 本 spec 改用 #uiLanguage 操作;#targetLanguage 切換不影響 UI(由
// i18n-ui-language-pref.spec.js 驗證解耦)。
//
// 對應規則:CLAUDE.md §16(雙語檔同步)+ SPEC §3.10「UI Localization」(P2)。
//
// SANITY 紀錄(已驗證 2026-05-08):
//   options.js 同時在 (a)#uiLanguage change handler 內,(b)init 內
//   subscribeUiLanguageChange callback 內呼叫 applyI18n;只 disable (a)spec 仍綠
//   (因為 storage write → onChanged → (b)reapply)。兩條都 disable 才 fail
//   (Expected「界面语言」/ Received「介面語言」)。還原兩條 → 全綠。
//   （2026-06-22:手動儲存按鈕移除改自動存檔，sentinel 從 options.action.save 改成
//    options.uiLanguage.heading「介面語言」。）
//
// SANITY 紀錄 2(tab-bar wrap,2026-05-08):把 options.css 的 .tab-bar
// `flex-wrap: wrap` comment 掉 → 「最後一個 tab(Debug)應折行到第二列」
// 斷言 fail(Received lastTop == firstTop,即 nowrap 一列爆出框)。還原 → pass。

import { test, expect } from '../fixtures/extension.js';

async function setUi(context, ui) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async (u) => {
    await chrome.storage.sync.set({ uiLanguage: u });
  }, ui);
}

test('options 載入後依 uiLanguage 切 dict + #uiLanguage 切換時即時 reapply', async ({ context, extensionId }) => {
  await setUi(context, 'zh-TW');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');
  // 等 init() applyI18n 完成（手動儲存按鈕已移除改自動存檔，sentinel 改用「介面語言」標題）
  await expect(page.locator('[data-i18n="options.uiLanguage.heading"]')).toHaveText('介面語言');

  // 從 picker 切 zh-CN(同時觸發 storage write + applyI18n reapply)
  await page.selectOption('#uiLanguage', 'zh-CN');
  await expect(page.locator('[data-i18n="options.uiLanguage.heading"]')).toHaveText('界面语言');

  // 切 en
  await page.selectOption('#uiLanguage', 'en');
  await expect(page.locator('[data-i18n="options.uiLanguage.heading"]')).toHaveText('Interface language');

  // 切 'auto' → headless chromium navigator.language=en → en dict
  await page.selectOption('#uiLanguage', 'auto');
  await expect(page.locator('[data-i18n="options.uiLanguage.heading"]')).toHaveText('Interface language');

  // v1.8.60 修補:en label 較長 → tab-bar 必須 flex-wrap 讓 tab 折行
  // (不可只靠水平捲軸,使用者看不出來「右邊還有 tab」),且最後一個 tab(Debug)
  // 必須在第二列 visible(top 比第一列大)。
  const wrapInfo = await page.evaluate(() => {
    const bar = document.querySelector('.tab-bar');
    const tabs = Array.from(bar.querySelectorAll('.tab-btn'));
    return {
      flexWrap: getComputedStyle(bar).flexWrap,
      firstTop: tabs[0].getBoundingClientRect().top,
      lastTop: tabs[tabs.length - 1].getBoundingClientRect().top,
    };
  });
  expect(wrapInfo.flexWrap, 'tab-bar flex-wrap 必須為 wrap').toBe('wrap');
  expect(wrapInfo.lastTop, 'en label 太長,最後一個 tab(Debug)應折行到第二列(top > 第一個 tab top)')
    .toBeGreaterThan(wrapInfo.firstTop);
});
