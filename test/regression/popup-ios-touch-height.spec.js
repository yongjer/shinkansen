// Regression / forcing function: iOS 觸控版 popup(runtime-ios-touch)的垂直節奏必須壓到
// 兩個情境的可見上限內(SPEC-PRIVATE §26)。
//
// 情境 1(v1.10.37)— iPad mini 直立 popover:觸控版把桌面 ~600px 上限調校過的版面整體
//   zoom 放大,YouTube 頁多三列(YouTube 字幕翻譯 / 字幕雙語對照 / 字幕大小)全展開後
//   scaled 高度 ~629px,超過 iPad mini 直立 popover 上限 → footer(設定 + 操作提示)被切。
//
// 情境 2(v1.10.41)— iPhone sheet:Safari 把 popup 當底部 sheet 呈現,開啟時停在較矮的
//   detent(可手動上拉但 footer 在摺線下)。已翻譯 active 狀態(顯示原文 + 編輯譯文 + 累計列)
//   在 zoom ~1.5 下高度超出開啟 detent 約一個 footer → 底部「設定 / 快速切換」看不到。
//   iPhone sheet detent 高度由 Safari 決定、網頁端無 API 控制 → 唯一解是把版面壓矮。
//
// 修法:popup.css 只壓 body.runtime-ios-touch 的垂直節奏(header / main / button.primary /
//   button.secondary / .row / .display-mode-row / .cache-row / .status / footer 的
//   margin / padding),不動字級(zoom / --sk-fz 保留 → 可讀性不變),水平 16px 不動
//   (保對齊 grid,CLAUDE.md §1)。
//
// 訊號層次(CLAUDE.md 工作流原則 §3):
//   驗:加上 runtime-ios + runtime-ios-touch(CSS fallback zoom 1.35)後,兩種全展開狀態的
//       真實 rendered 高度壓在保守門檻內 —— YouTube 頁全展開 ≤ 550px、非 YouTube 已翻譯
//       active 狀態 ≤ 450px。門檻設在「字型 settle 後穩態值」(YT ~538 / 非 YT ~438)之上
//       留邊:Chromium 首次 paint 用 fallback 字型會偏矮 ~19px,穩態(系統字型 resolve 後,
//       同真機)才是準的,門檻照穩態抓。
//   不驗:iPhone sheet 開啟 detent / iPad mini popover 的逐 px 上限——Chromium ≠ WebKit、
//       模擬器也重現不了 iOS sheet sizing(SPEC-PRIVATE §11 盲區)。本條只鎖「我們的觸控版
//       版面高度有壓進保守門檻」,真機 footer 不被切的最終驗收靠 Jimmy 實機(zoom 真機
//       ~1.5,本 spec @1.35,只當 regression 防回退,非絕對 detent 量尺)。
//   也不驗:welcome-banner / update-banner 兩條一次性提示橫幅(非穩態設定面板)。
//
// SANITY 紀錄(已驗證 2026-06-09):
//   暫時把修法 block 的 header padding 改回 10px + button.secondary margin/padding 還原(等同
//   未壓)→ 非 YT active 穩態量到 ~482px > 450 fail;還原壓縮值 → ~438px pass。

import { test, expect } from '../fixtures/extension.js';

// 觸控版在 @media (min-width: 350px) 走 width:auto(max 480),給足寬度量自然高度
const VIEWPORT_W = 480;
// YouTube 頁實際多出的三列(非 Drive——YT vs Drive 互斥,不疊算)
const YT_ROW_IDS = ['yt-subtitle-row', 'bilingual-row', 'yt-caption-size-row'];

test('iOS 觸控版 popup YouTube 頁全展開高度 ≤ 550px(壓在 iPad mini popover 上限下)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: VIEWPORT_W, height: 1200 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  const height = await page.evaluate((ids) => {
    // 模擬 iOS 觸控 build:popup.js 在 IS_IOS_BUILD + 觸控裝置時掛這兩個 class,
    // 測試 build(chrome)IS_IOS_BUILD=false 不會自動掛 → 手動加以重現觸控版面
    document.body.classList.add('runtime-ios', 'runtime-ios-touch');
    // 一次性提示橫幅(升級歡迎 / 有新版)非穩態設定面板,本條不驗 → 量測前強制隱藏,
    // 避免 popup.js init 偶發 un-hide 造成 flaky
    ['welcome-banner', 'update-banner'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    // 快取 / 累計列文字由 popup.js 非同步填(讀 storage / IndexedDB),量測時可能還停在
    // 「讀取中⋯」或已填真值 → 高度會抖。釘成真機代表字串(單行,實機就一行),去掉 race
    document.getElementById('cache-info').textContent = '快取:2346 段 / 391.1 KB';
    document.getElementById('usage-info').textContent = '累計:NT$ 19.6 / 638.0K tokens';
    document.getElementById('edit-btn').hidden = false; // 已翻譯 active 狀態
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
    });
    return Math.round(document.body.getBoundingClientRect().height);
  }, YT_ROW_IDS);

  expect(height).toBeLessThanOrEqual(550);
});

test('iOS 觸控版 popup 非 YouTube 已翻譯 active 狀態高度 ≤ 450px(iPhone sheet 開啟 detent 內)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: VIEWPORT_W, height: 1200 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  const height = await page.evaluate(() => {
    document.body.classList.add('runtime-ios', 'runtime-ios-touch');
    // 一次性提示橫幅(升級歡迎 / 有新版)非穩態設定面板,本條不驗 → 量測前強制隱藏,
    // 避免 popup.js init 偶發 un-hide 造成 flaky
    ['welcome-banner', 'update-banner'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    // 快取 / 累計列文字由 popup.js 非同步填(讀 storage / IndexedDB),量測時可能還停在
    // 「讀取中⋯」或已填真值 → 高度會抖。釘成真機代表字串(單行,實機就一行),去掉 race
    document.getElementById('cache-info').textContent = '快取:2346 段 / 391.1 KB';
    document.getElementById('usage-info').textContent = '累計:NT$ 19.6 / 638.0K tokens';
    // 已翻譯狀態:translate-btn 變「顯示原文」、edit-btn(編輯譯文)顯示;快取 + 累計 + 狀態列
    // 預設都在。非 YouTube 頁 → 不 un-hide YT 三列
    document.getElementById('edit-btn').hidden = false;
    return Math.round(document.body.getBoundingClientRect().height);
  });

  expect(height).toBeLessThanOrEqual(450);
});
