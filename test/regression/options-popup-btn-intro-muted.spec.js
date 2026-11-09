// Regression: options「工具列『翻譯本頁』按鈕」section 的說明段落字體跟其他
// 說明文字不同（Jimmy iOS options 頁回報，桌面同樣存在）。
//
// Root cause：該段落是全 options.html 唯一用 `class="hint"` 的元素，但 `.hint`
// 只在 popup.css 有定義（11px 灰），options.css 沒有 → fallback 成預設字級
// 黑字，跟其他說明文字（`.muted`，12px #86868b）視覺不一致。修法：改用
// `.muted` 跟全頁說明文字同一條 CSS（單一資料源，不在 options.css 另開
// `.hint` 雙實作）。
//
// 訊號層次：本 spec 驗（a）該段落 computed font-size / color 跟既有 `.muted`
// 參照元素完全一致（render 層，class 改名 / CSS 改值都抓得到）（b）options.html
// 內不再有 class="hint"（forcing function:`.hint` 是 popup-only class，
// options.css 未定義，未來誤用會直接 fail）。
// 不驗：iOS WebKit 的實際渲染（同 options-ios-narrow-rwd.spec.js，這層只能
// sim / 真機驗）。
//
// SANITY 紀錄（已驗證 2026-06-07）:
//   把 options.html 該段落 class 改回 "hint" →（a）fail（font-size 16px ≠ 12px）
//   ＋（b）fail；還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';

test('popupBtn intro 段落與其他 .muted 說明文字 computed 樣式一致', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('[data-i18n="options.popupBtn.intro"]');

  const styles = await page.evaluate(() => {
    const pick = (sel) => {
      const cs = getComputedStyle(document.querySelector(sel));
      return { fontSize: cs.fontSize, color: cs.color };
    };
    return {
      intro: pick('[data-i18n="options.popupBtn.intro"]'),
      // 參照：同 settings tab 既有 .muted 說明文字
      ref: pick('[data-i18n="options.domain.autoTranslateSlotHint"]'),
    };
  });
  expect(styles.intro.fontSize).toBe(styles.ref.fontSize);
  expect(styles.intro.color).toBe(styles.ref.color);
});

test('options.html 不使用 popup-only 的 class="hint"', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  const hintCount = await page.locator('.hint').count();
  expect(hintCount).toBe(0);
});
