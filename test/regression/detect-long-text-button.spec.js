// Regression: detect-long-text-button
//
// Fixture: test/regression/fixtures/detect-long-text-button.html
// 結構特徵:
//   <button><span>完整問句(CJK)</span></button>  — CJK >= 3 字
//   <button>報告する</button>                     — CJK 4 字
//   <button>送信</button>                         — CJK 2 字(< 3,跳過)
//   <button>Reply</button>                        — non-CJK 5 字(< 8,跳過)
//
// 修法前 bug:
//   BUTTON 在 HARD_EXCLUDE_TAGS 一刀切 FILTER_REJECT,所有 <button> 內文字
//   完全不被偵測。Amazon Rufus 建議問題 pill / 「カートに入れる」等因此漏翻。
//
// 修法:
//   acceptNode 在 HARD_EXCLUDE 之前加 BUTTON 分流:CJK >= 3 字 / non-CJK >= 8 字
//   → FILTER_SKIP 放行;門檻以下 → REJECT。walker 後段補抓 BUTTON 內 leaf SPAN。
//
// 斷言基於 textContent 長度 + CJK/non-CJK 區分(結構性通則),符合 §6 / §8。
//
// SANITY 紀錄(已驗證):
//   1. 拿掉 acceptNode 的 BUTTON 分流 + 補抓路徑 → spec fail
//   2. 還原 → pass。極短按鈕不受影響(0 個偵測)
import { test, expect } from '../fixtures/extension.js';
import {
  getShinkansenEvaluator,
} from './helpers/run-inject.js';

const FIXTURE = 'detect-long-text-button';

test('BUTTON(CJK >= 3 / non-CJK >= 8)內的文字應被偵測為段落', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.pill-button', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units } = JSON.parse(result);

  // 斷言 1: CJK >= 3 字按鈕內的文字應被偵測
  // 3 個 pill-button + 1 個 question-chip + 2 個 commerce + 2 個 review-actions
  const buttonUnits = units.filter((u) => {
    const preview = (u.textPreview || '');
    return preview.includes('オーブンで使用')
      || preview.includes('長さがあります')
      || preview.includes('聞いてください')
      || preview.includes('電子レンジ')
      || preview.includes('カートに入れる')
      || preview.includes('購入オプション')
      || preview.includes('参考になった')
      || preview.includes('報告する');
  });
  expect(
    buttonUnits.length,
    `CJK >= 3 BUTTON 內容應被偵測,實際 ${buttonUnits.length} 個。units: ${JSON.stringify(units.map((u) => u.tag + ':' + (u.textPreview || '').substring(0, 60)))}`,
  ).toBeGreaterThanOrEqual(8);

  // 斷言 2: 極短 CJK(< 3 字)/ 短 non-CJK(< 8 字)不應被偵測
  const shortButtonUnits = units.filter((u) => {
    const preview = (u.textPreview || '');
    return preview === '送信'
      || preview === '取消'
      || preview === 'OK'
      || preview === 'Reply'
      || preview === 'Follow';
  });
  expect(
    shortButtonUnits.length,
    `極短 BUTTON 不應被偵測,實際 ${shortButtonUnits.length} 個`,
  ).toBe(0);

  // 斷言 3: 控制組——一般段落仍正常偵測
  const articleUnits = units.filter((u) =>
    (u.textPreview || '').includes('一般的な説明文')
    || (u.textPreview || '').includes('商品レビュー'),
  );
  expect(
    articleUnits.length,
    `<p> 段落仍應正常偵測,實際 ${articleUnits.length}`,
  ).toBeGreaterThanOrEqual(2);

  await page.close();
});
