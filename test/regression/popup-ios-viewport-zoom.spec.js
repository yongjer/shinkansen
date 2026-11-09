// Regression: iOS popup viewport / 放大撐滿（v1.10.35 起對齊 JRead 實機驗證做法）
//
// Bug 歷程：
//   1. v1.10.22 前：popup.html 沒 viewport meta → iOS WebKit 用 ~980px 桌面虛擬
//      viewport，固定 280px body 縮在 sheet 左側（SPEC-PRIVATE §26.7）
//   2. v1.10.22〜v1.10.34：加 meta + popup.css `body.runtime-ios-touch` zoom 1.5 /
//      media query 降 1.435；popup.js applyIosZoom 依 innerWidth 動態算 zoom = 寬 / 280
//   3. v1.10.35：上述「固定 280px 窄版面 × zoom 1.5」把內容 ×1.5 撐高,active（已翻譯：
//      顯示原文 + 編輯譯文）狀態在 iPad mini 超過 popover 高度上限 → 出捲軸（Jimmy 實機
//      回報）。改成 JRead 同款：**固定放大檔 zoom 1.35（CSS 全權,不再 JS 算）+ 觸控且
//      viewport 已寬時 width:auto**（版面比 280 寬 → 換行少、內容更矮 → 高度落回 popover
//      上限內,寬度仍撐滿）。popup.js 只剩 --sk-fz 字體微調,不再碰 zoom / width。
//
// 訊號層次（CLAUDE.md 工作流原則 §3）:本 spec 驗（a）popup.html viewport meta 存在
//   （b）popup.css runtime-ios-touch 在真實 render 下：zoom 固定 1.35、寬 viewport 套
//   width:auto（>280、置中、max-width 480）、窄 viewport fallback 回 280px（c）popup.js
//   不再用 JS zoom（無 vw/280、無 style.zoom）、只留 --sk-fz 字體微調。
//   不驗（永久 path B）:iOS WebKit 對 zoom / width:auto / viewport meta 的實際渲染與
//   popover sizing 時序——Chromium ≠ Safari WebKit,只能 iOS Simulator / 真機驗
//   （JRead 已在 Jimmy 多機型實機驗證此 zoom 1.35 + width:auto 做法無捲軸 / 無 wrap）。
//
// SANITY 紀錄（已驗證 2026-06-09）:
//   1. 拿掉 popup.html viewport meta →（a）fail；還原 → pass。
//   2. 把 popup.css `@media (min-width: 350px)` 的 width:auto 改回 width:280px →（b）
//      寬 viewport width 斷言 fail（量到 280 而非 >300）；還原 → pass。
//   3. 在 popup.js 加回 `document.body.style.zoom = String(vw / 280)` →（c）「不再用 JS
//      zoom」斷言 fail；還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';

test('popup.html 有 viewport meta（iOS sheet 縮左修正的根本）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const content = await page.getAttribute('meta[name="viewport"]', 'content');
  expect(content).toContain('width=device-width');
});

test('body.runtime-ios-touch:zoom 固定 1.35;寬 viewport width:auto 撐寬置中、窄 viewport fallback 280px', async ({ context, extensionId }) => {
  const page = await context.newPage();

  // 寬 viewport（iPhone sheet / iPad popover 已定尺寸,≥ 350）:@media 命中 → width:auto
  // 撐滿（量到 > 300,非固定 280）、max-width 480、margin auto 置中。zoom 固定 1.35。
  // 放大規則掛 runtime-ios-touch（真觸控）；iOS build 跑在 Mac 不加 -touch → 不放大。
  await page.setViewportSize({ width: 440, height: 956 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.evaluate(() => document.body.classList.add('runtime-ios-touch'));
  const wide = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return { zoom: s.zoom, width: parseFloat(s.width), maxWidth: s.maxWidth };
  });
  expect(parseFloat(wide.zoom)).toBeCloseTo(1.35, 3);
  expect(wide.width).toBeGreaterThan(300);     // width:auto 撐寬,不再是固定 280
  expect(wide.maxWidth).toBe('480px');         // 過寬 popover 由 max-width 封頂 + margin:0 auto 置中

  // 窄 viewport（popover 尚未定尺寸的早期狀態,< 350）:@media 不命中 → fallback 固定 280px
  // （min-width guard 防早期窄 viewport 觸發 width:auto ↔ 視窗 sizing 循環 + font-boosting）
  await page.setViewportSize({ width: 280, height: 700 });
  const narrow = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return { zoom: s.zoom, width: parseFloat(s.width) };
  });
  expect(parseFloat(narrow.zoom)).toBeCloseTo(1.35, 3);
  expect(narrow.width).toBeCloseTo(280, 0);

  await page.close();
});

test('popup.js 不再用 JS zoom（無 vw/280、無 style.zoom）、只留 --sk-fz 字體微調', async ({ context, extensionId }) => {
  // iOS WebKit 實際渲染 Chromium 驗不到（IS_IOS_BUILD gate + WebKit）,這條鎖 source 結構
  // 當 forcing function：若有人把 JS zoom 加回來（會重蹈 zoom 1.5 撐高出捲軸的覆轍）即 fail。
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const js = await page.evaluate(async () => (await fetch('popup.js')).text());
  const css = await page.evaluate(async () => (await fetch('popup.css')).text());

  // popup.js 不再算 zoom（zoom 全權交給 popup.css）
  expect(js).not.toMatch(/vw \/ 280/);
  expect(js).not.toMatch(/style\.zoom/);
  // 只剩 --sk-fz 字體微調（依 screen 短邊）
  expect(js).toContain("setProperty('--sk-fz'");
  expect(js).toMatch(/Math\.min\(screen\.width/);

  // popup.css 走 JRead 同款:固定 zoom 1.35 + 寬 viewport width:auto
  expect(css).toMatch(/body\.runtime-ios-touch\s*\{[^}]*zoom:\s*1\.35/);
  expect(css).toMatch(/@media \(min-width: 350px\)[\s\S]*?width:\s*auto/);

  await page.close();
});
