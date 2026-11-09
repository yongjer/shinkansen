// Regression: 單一 inline 媒體 wrapper(emoji)的留言被 extractInlineFragments guard 誤殺 (v1.10.15)
//
// Bug(真實頁面驗證):YouTube 含 emoji 的留言整則沒翻,純文字留言正常翻。
// 真實頁面抽樣 40 則:純文字 37/37 翻;含 inline 媒體(emoji img / 時間戳連結)3/3 沒翻。
// 結構:<span>長直接文字<span><img emoji></span>更多直接文字</span> —— 直接文字 >> 20 字,
// emoji wrapper 本身 0 字。
//
// 根因:extractInlineFragments 的 flushRun 有一條 guard
//   if (_elCount === 1 && _wrapperEl.children.length > 0 && trimmed.length >= 100) skip
// 原意:run 是「單一巢狀 wrapper + 長文」(文字都在 wrapper 內巢狀結構,如商品卡)時不抽
// fragment。但它用「整個 run 字數」判斷,沒扣掉「文字其實在直接 text node、wrapper 幾乎沒
// 文字」的情況 → emoji 留言 _elCount===1(emoji wrapper)、總長 >= 100 命中 → 整則丟棄不翻。
//
// 修法:guard 補 `_directTextLen < 20`。只有直接文字微不足道(文字真的在 wrapper 巢狀結構
// 內)才 skip;有實質直接 prose 時 wrapper 只是 inline 媒體 → 照常抽 fragment(保留 img)。
//
// 這條驗:emoji 留言(單一 wrapper + 長直接文字)→ 抽出涵蓋 prose 的 fragment;
//        負向「微量直接文字 + 單一大巢狀 wrapper」→ 仍被 skip(不抽該 run 成 fragment)。
// 不驗:fragment 注入後 img 是否被保留(那條走 inject 路徑,由 §3 媒體保留 + 其他 inject spec 蓋)。
//
// SANITY 紀錄(已驗證):暫時把修法的 `&& _directTextLen < 20` 拿掉(還原舊 guard)→
// emoji-mid / emoji-end 兩條 hasEmojiFrag fail;還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inline-mixed-span';

function fragTextsExpr(rootSel) {
  return `
    (() => {
      const root = document.querySelector('${rootSel}');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      const fragTexts = fragments.map(f => {
        let t = '', n = f.startNode;
        while (n) { t += n.textContent || ''; if (n === f.endNode) break; n = n.nextSibling; }
        return t.trim();
      });
      return { fragmentCount: fragments.length, fragTexts, inlineMixedSpan: stats.inlineMixedSpan || 0 };
    })()
  `;
}

test('emoji 在中間:長直接文字 + 單一 emoji wrapper → 抽出涵蓋 prose 的 fragment', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-emoji-mid', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(fragTextsExpr('#target-emoji-mid'));
  const hasEmojiFrag = r.fragTexts.some(t =>
    t.includes('My last deployment') && t.includes('gave me good use'));
  expect(hasEmojiFrag,
    `emoji 留言應抽出涵蓋前後 prose 的 fragment,fragmentCount=${r.fragmentCount}\nfragTexts=${JSON.stringify(r.fragTexts)}`,
  ).toBe(true);

  await page.close();
});

test('emoji 在尾端:長直接文字 + 尾端單一 emoji wrapper → 抽出 fragment', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-emoji-end', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(fragTextsExpr('#target-emoji-end'));
  const hasEmojiFrag = r.fragTexts.some(t =>
    t.includes('Best advice') && t.includes('every single time'));
  expect(hasEmojiFrag,
    `尾端 emoji 留言應抽出涵蓋 prose 的 fragment,fragmentCount=${r.fragmentCount}\nfragTexts=${JSON.stringify(r.fragTexts)}`,
  ).toBe(true);

  await page.close();
});

test('負向對照:微量直接文字 + 單一大巢狀 wrapper → 該 run 仍被 guard skip(不抽 fragment)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-single-wrapper-tiny-direct', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(fragTextsExpr('#target-single-wrapper-tiny-direct'));
  // 文字都在 wrapper 內巢狀 leaf,outer run 不該被抽成一個含 "Reply:" 前綴的 fragment。
  const hasWrapperRunFrag = r.fragTexts.some(t => t.startsWith('Reply:'));
  expect(hasWrapperRunFrag,
    `微量直接文字 + 單一大巢狀 wrapper 的 run 不該被抽成 fragment,fragTexts=${JSON.stringify(r.fragTexts)}`,
  ).toBe(false);

  await page.close();
});
