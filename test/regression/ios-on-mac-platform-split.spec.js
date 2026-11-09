// Regression: iOS build 跑在 macOS 時尊重 macOS 特性(SPEC-PRIVATE §26;lib/platform.js)
//
// 背景:iOS build(IS_IOS_BUILD=true)可透過 Apple Silicon Mac 的「iPhone 與 iPad
// App 在 Mac 上執行」裝進 macOS。這時 IS_IOS_BUILD 仍是 true,但執行環境是 macOS
// Safari —— 必須尊重 macOS 特性(popup 不放大、快速鍵提示用鍵盤、不顯示四指 tap
// 說明)。先前 bug:所有 iOS 處理都掛在 IS_IOS_BUILD 一個旗標上 → Mac 上 popup 被
// zoom 1.5 撐過大(Jimmy 真機回報)。
//
// 修法(build 屬性 vs 平台屬性分離):
//   - body.runtime-ios(IS_IOS_BUILD 一律加,不論 host OS):**build 屬性** ——
//     隱藏 PDF 入口(translate-doc/ 被 strip)
//   - body.runtime-ios-touch(IS_IOS_BUILD && isTouchScreenDevice() 才加):
//     **平台屬性** —— popup 放大、四指 tap 說明
//   - isTouchScreenDevice() = navigator.maxTouchPoints >= 1(Mac 無觸控 = 0,
//     真 iPhone / iPad = 5)
//
// 本 spec 鎖的訊號層次(CLAUDE.md 工作流原則 3):
//   驗(a)real render:popup body 只加 runtime-ios(模擬 iOS build 跑在 Mac)時
//   **不** zoom + PDF 按鈕仍隱藏;加 runtime-ios-touch 才 zoom。(b)isTouchScreenDevice()
//   依 maxTouchPoints 的判定。(c)source forcing function:CSS 放大規則掛在
//   runtime-ios-touch、PDF 隱藏掛在 runtime-ios、popup.js / options.js gate 在
//   isTouchScreenDevice()。
//   不驗:真實 macOS Safari(iPhone App on Mac)的 maxTouchPoints / popover 渲染
//   (Chromium 無法模擬;真機 / Mac 驗收)、iOS WebKit 實際 zoom 渲染(sim 驗,
//   SPEC-PRIVATE §26.7)。
//
// SANITY 紀錄(已驗證 2026-06-08):
//   1. 把 popup.css 放大規則的 selector 從 runtime-ios-touch 改回 runtime-ios →
//      test (a)「只加 runtime-ios 不 zoom」fail(computed zoom 1.35);還原 → pass。
//   2. 把 lib/platform.js 改成 `return true` → test (b) maxTouchPoints=0 應為
//      false 的 case fail;還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';

// ── (a) real render:runtime-ios 單獨(= iOS build 跑在 Mac)不放大 ──────────
test('只加 runtime-ios（iOS build 跑在 Mac）：popup 不 zoom，但 PDF 入口仍隱藏', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 440, height: 956 }); // 寬 viewport,若誤套放大會是 1.35
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.evaluate(() => document.body.classList.add('runtime-ios'));

  const r = await page.evaluate(() => ({
    zoom: getComputedStyle(document.body).zoom,
    pdfBtn: getComputedStyle(document.getElementById('translate-doc-btn')).display,
  }));
  // 不放大:zoom 為 'normal' 或 '1'(視瀏覽器 serialize),解析為數值應 = 1
  const zoomNum = r.zoom === 'normal' ? 1 : parseFloat(r.zoom);
  expect(zoomNum).toBeCloseTo(1, 3);
  // build 屬性保留:PDF 入口隱藏(translate-doc/ 被 strip)
  expect(r.pdfBtn).toBe('none');
});

test('加 runtime-ios-touch（真觸控裝置）：popup 放大到固定 1.35', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 440, height: 956 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.evaluate(() => document.body.classList.add('runtime-ios-touch'));
  // v1.10.35 起固定放大檔 1.35（對齊 JRead,取代舊 JS innerWidth/280≈1.5 / CSS 1.435）
  const zoom = await page.evaluate(() => getComputedStyle(document.body).zoom);
  expect(parseFloat(zoom)).toBeCloseTo(1.35, 3);
});

// ── (b) isTouchScreenDevice() 依 maxTouchPoints 判定 ──────────────────────
test('isTouchScreenDevice()：maxTouchPoints 0 → false（Mac）、5 → true（iPhone/iPad）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  const mac = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    const m = await import('/lib/platform.js');
    return m.isTouchScreenDevice();
  });
  expect(mac).toBe(false);

  const touch = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    const m = await import('/lib/platform.js');
    return m.isTouchScreenDevice();
  });
  expect(touch).toBe(true);
});

// ── (c) source forcing function ───────────────────────────────────────────
test('source 結構：放大掛 runtime-ios-touch、PDF 隱藏掛 runtime-ios、gate 在 isTouchScreenDevice', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  const fetchText = (p) => page.evaluate(async (path) => (await fetch(path)).text(), p);

  const popupCss = await fetchText('popup.css');
  // 放大規則掛 runtime-ios-touch（v1.10.35 起固定 zoom 1.35）
  expect(popupCss).toMatch(/body\.runtime-ios-touch\s*\{[^}]*zoom:\s*1\.35/);
  // PDF 隱藏仍掛 runtime-ios（build 屬性）
  expect(popupCss).toMatch(/body\.runtime-ios\s+#translate-doc-btn\s*\{\s*display:\s*none/);

  const popupJs = await fetchText('popup.js');
  expect(popupJs).toContain("import { isTouchScreenDevice } from '../lib/platform.js'");
  // zoom / shortcut hint gate 在 isTouchScreenDevice()
  expect(popupJs).toMatch(/isTouchScreenDevice\(\)/);

  const optionsCss = await fetchText('../options/options.css');
  expect(optionsCss).toMatch(/body\.runtime-ios-touch\s+\.ios-only\s*\{\s*display:\s*block/);

  const optionsJs = await fetchText('../options/options.js');
  expect(optionsJs).toContain("import { isTouchScreenDevice } from '../lib/platform.js'");
});
