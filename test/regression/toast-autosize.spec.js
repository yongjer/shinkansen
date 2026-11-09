// Regression: toast 依內容自動調整寬度（issue 5）
//
// 背景：toast 原本固定 width:280px，短訊息（「已還原原文」等）也佔 280px，常顯得過大。
// 改成 width:max-content + min-width:180px + max-width:min(320px, calc(100vw-40px))：
//   - 短訊息縮到內容寬（但不小於 180px，留住進度條 / timer / 關閉鈕版面）
//   - 長訊息 / detail 撐到上限後改換行（不超過 320px、不溢出視窗）
//
// 驗的是「真實注入的 toast」rendered 寬度（closed shadow，走 SK._getToastRect seam）：
//   1. 短訊息寬度 < 長訊息寬度（會依內容變動，不再是固定 280）
//   2. 寬度夾在 [180, 320] 之間
//
// SANITY 紀錄（已驗證）：把 content-toast.js 的 `width: max-content` 暫改回 `width: 280px`
//   → 「短 < 長」斷言 fail（兩者都 280、相等）→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('toast: 依內容自動調整寬度（短訊息縮、長訊息夾上限）', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/floating-icon.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 短訊息
  const shortW = await evaluate(`(() => {
    window.__SK.showToast('success', '已還原');
    return window.__SK._getToastRect().width;
  })()`);

  // 長訊息 + 長 detail（會撐到 max-width 上限後換行）
  const longW = await evaluate(`(() => {
    window.__SK.showToast('loading', '正在翻譯整頁內容，請稍候片刻不要關閉分頁', {
      detail: '這是一段很長的細節說明文字，用來確認 toast 會在內容很多時撐到寬度上限，而不是維持原本固定的 280px 寬度'
    });
    return window.__SK._getToastRect().width;
  })()`);

  // (1) 寬度依內容變動：短 < 長
  expect(shortW).toBeLessThan(longW);
  // (2) 夾在 [180, 320]（max-width 上限 + min-width 下限）
  expect(shortW).toBeGreaterThanOrEqual(180);
  expect(longW).toBeLessThanOrEqual(320);

  await page.close();
});
