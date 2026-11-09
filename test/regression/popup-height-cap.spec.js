// Regression / forcing function: popup 全展開高度必須壓在瀏覽器 popup 高度上限下
// (v1.10.31,從 JRead 移植的通則)。
//
// 根因:瀏覽器 extension popup 有 ~600px 高度上限(Chrome / Firefox / Safari 通用)。
// popup 把所有「持久設定列」(setting rows + 編輯按鈕)都顯示時若超過此上限,內容
// 會被 clip、出現捲軸。macOS 上用 iOS TestFlight build 跑(iOS app on Mac)時走桌面
// 版面(pointer:fine,非觸控 zoom 版面),桌面版面太高就重現此 bug。
//
// 修法:popup.css 垂直節奏均勻收斂(main 垂直 padding 14→10、.row / .display-mode-row
// margin-top 14→10、.cache-row margin-top 12→10 + padding-top 10→8、.status
// margin-top 10→8),水平方向不動(保對齊 grid)。修前全持久列 589px(貼著上限零
// 餘裕)→ 修後 539px(餘裕 ~51px)。
//
// 訊號層次(CLAUDE.md 工作流原則 §3):
//   驗:所有「持久設定列 + 編輯按鈕」un-hide 後的真實 rendered 高度 ≤ 590px
//       (= 600 上限留 10px 餘裕)。刻意把 yt-subtitle-row 與 drive-subtitle-row
//       (真實情境互斥,YT vs Drive 不同站)兩條都 un-hide,當作保守的過量估計。
//   不驗:welcome-banner / update-banner 兩條「一次性提示橫幅」。它們是暫時、可關閉
//       的通知(非設定面板穩態),且 welcome-banner 含「本版新增」項目列本身就高
//       (~140px),要壓進上限得另外 cap 橫幅內容,屬另一層問題。橫幅顯示期間若疊
//       滿 YT 設定列仍可能超限,那層不在本 forcing function 範圍。
//   也不驗:Chromium ≠ 真實 Safari / WebKit 的 popup 高度上限精確值——這條鎖「我們
//       的版面高度有壓在保守門檻下」,不鎖各瀏覽器上限的逐 px 行為。
//
// SANITY 紀錄(已驗證 2026-06-08):
//   暫時把 popup.css `.row` 的 margin-top 從 10px 放大到 30px → 全持久列 679px > 590
//   斷言 fail;還原 10px → 539px pass。
//   (註:修前完整版面 589px 本身就 ≤ 590,故 SANITY 用「放大某列 margin」製造超限,
//    跟 JRead 的 SANITY 同手法;修法的價值是把 589 貼邊狀態壓出 ~50px 餘裕。)

import { test, expect } from '../fixtures/extension.js';

// popup body 固定桌面寬(popup.css body width: 280px)
const POPUP_WIDTH = 280;
// 所有「持久」條件列 / 按鈕(排除兩條一次性 banner,見上方訊號層次說明)
const PERSISTENT_HIDDEN_IDS = [
  'edit-btn',
  'yt-subtitle-row',
  'drive-subtitle-row',
  'bilingual-row',
  'yt-caption-size-row',
];

test('popup 全展開(所有持久設定列)高度 ≤ 590px,壓在 ~600 上限下', async ({ context, extensionId }) => {
  const page = await context.newPage();
  // viewport 高度給足,確保量到的是內容自然高度而非被 viewport clip
  await page.setViewportSize({ width: POPUP_WIDTH, height: 1200 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  const height = await page.evaluate((ids) => {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
    });
    return document.body.scrollHeight;
  }, PERSISTENT_HIDDEN_IDS);

  expect(height).toBeLessThanOrEqual(590);
});
