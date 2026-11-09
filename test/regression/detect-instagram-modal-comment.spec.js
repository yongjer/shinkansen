// Regression: v1.9.31 — widget-reject block 內藏長文 leaf SPAN 撈不到
//
// Fixture: test/regression/fixtures/instagram-modal-comment.html
// 結構: UL > DIV[role=button] > LI(含 reply / like 真實 button)>
//       嵌套 DIV > SPAN[dir=auto] 留言文字
//
// 結構通則(不綁站名):block tag(LI)在 walker 被 isInteractiveWidgetContainer
// reject(內含真實按鈕),但 leaf SPAN[dir=auto] 是純 prose 應該翻。
// 修法:walker 期間記住所有 widget-reject 的 block 到 widgetRejectedBlocks,
// hasBlockAncestor 走訪時將其視為「不算 block 祖先」,讓 leaf 補抓可以撈出來。
//
// 真實 case:Instagram modal photo viewer(profile grid 點開照片那種 popup,
// URL = /p/<id>/?img_index=N)留言完全翻不到。v1.9.30 之前 standalone URL
// (/<user>/p/<id>/)能翻、modal URL 不能翻,因為 modal 多了 LI + role=button
// wrapper,standalone 是純 DIV 巢狀。
//
// SANITY 紀錄(已驗證 2026-05-20):暫時 revert widgetRejectedBlocks 加入 / 跳過
// 邏輯(把 `&& !widgetRejectedBlocks.has(cur)` 條件刪掉)→ 「Volle Kraft voraus
// 必須被收」斷言 fail(leaf 補抓被 LI block 祖先擋住)。還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'instagram-modal-comment';

test('instagram-modal-comment: widget-reject LI 內的 leaf SPAN 留言必須被偵測', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#comments-root', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  // 斷言 1:控制組 #control-article 仍被收(walker 正常工作)
  const controlUnit = units.find((u) => /#control-article/.test(u.selectorPath || ''));
  expect(controlUnit, '控制組 #control-article 應被收(walker 正常)').toBeDefined();

  // 斷言 2:留言文字 "Volle Kraft voraus" SPAN 必須被收(B 修法生效)
  const comment2 = units.find((u) =>
    (u.textPreview || '').includes('Volle Kraft voraus'),
  );
  expect(
    comment2,
    `留言 "Volle Kraft voraus" 應被偵測(walker reject LI 後 leaf 補抓接住)\n` +
    `實際 units:${JSON.stringify(units.map(u => u.textPreview))}`,
  ).toBeDefined();

  // 斷言 3:同結構長文 "Das sieht sooo gut aus" 也被收(對稱驗第二則留言)
  const comment1 = units.find((u) =>
    (u.textPreview || '').includes('Das sieht sooo gut aus'),
  );
  expect(comment1, '留言 "Das sieht sooo gut aus" 應被偵測').toBeDefined();

  // 斷言 4:LI 仍被 walker 因 widget reject(skipStats.interactiveWidget >= 1)
  // 證明 widget rejection 主邏輯沒被破壞,只是改成「reject + 允許 leaf 補抓進來」
  expect(
    skipStats.interactiveWidget || 0,
    `LI 應仍被 walker widget-reject(skipStats.interactiveWidget >= 1)\n` +
    `skipStats:${JSON.stringify(skipStats)}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 5:按鈕本體文字(Reply / ⋯)不在 units(widget reject 仍正確排除真按鈕)
  const replyUnit = units.find((u) => (u.textPreview || '').trim() === 'Reply');
  expect(replyUnit, 'Reply 按鈕文字不該被收進候選').toBeUndefined();

  // 斷言 6:username SPAN(短文 < 20 字、inline display)仍被 v1.8.61 短文 guard 擋住,
  // 不進候選 — 證明 B 修法只放行長文 leaf,沒把短文 username 一起放行(避免短 username
  // 浪費 LLM call)。
  const userSpan = units.find((u) => (u.textPreview || '').trim() === 'decathlon');
  expect(userSpan, 'username 短文 SPAN(9 字 inline)仍應被 v1.8.61 短文 guard 擋住').toBeUndefined();

  // 斷言 7:reply mixed-inline SPAN(含 @mention anchor + 直接文字)必須被收(walker
  // FILTER_SKIP 入 widget LI → 內部 SPAN 命中 Case D → extractInlineFragments 抽出)。
  // 真實 case:IG modal「查看回覆」展開的 reply,結構是
  //   <span dir="auto"><a>@mention</a>werden sie auch nie machen...</span>
  // SPAN 含 anchor 子非 leaf,leaf 補抓(:not(:has(*)))接不到;必須靠 walker 下去
  // 走 Case D 抽 fragment。若 widget reject 維持 FILTER_REJECT,walker 不下去 → 永遠翻不到。
  const reply = units.find((u) =>
    (u.textPreview || '').includes('werden sie auch nie machen warum braucht'),
  );
  expect(
    reply,
    `reply mixed-inline SPAN 必須被偵測(walker SKIP 入 widget LI 後 Case D 抽 fragment)\n` +
    `實際 units:${JSON.stringify(units.map(u => u.textPreview))}`,
  ).toBeDefined();
  // fragment kind 證明走的是 Case D extractInlineFragments path(非 leaf 補抓)
  expect(reply.kind, 'reply 應為 fragment unit(走 Case D 抽 inline fragment)').toBe('fragment');

  // 斷言 8:短直接文字 reply mixed-inline SPAN(direct text < 20 但總 textContent >= 20)
  // 必須被收 — v1.9.31 Case D 放寬 directTextLength >= 5 AND total textContent >= 20。
  // 真實 case:IG「@xthilox ja wirklich! 🙌😀」這類 anchor + 短直接文字回覆,直接文字 17 字
  // < 20 字原 Case D 擋下,但加上 @xthilox anchor 後總 26 字明顯是 prose 該翻。
  const shortReply = units.find((u) =>
    (u.textPreview || '').includes('ja wirklich'),
  );
  expect(
    shortReply,
    `短直接文字 reply SPAN(direct 17 字 + anchor 共 26 字)必須被偵測\n` +
    `實際 units:${JSON.stringify(units.map(u => u.textPreview))}`,
  ).toBeDefined();
  expect(shortReply.kind, '短 reply 應為 fragment unit(Case D 抽出)').toBe('fragment');

  // 斷言 9 + 10:巢狀 reply 場景 — outer LI 因 textLen >= 300 走 containsBlockDescendant
  // 路徑被加進 fragmentExtracted,但 inner reply SPAN 仍應被 Case D 撈到(block boundary
  // 在 reply LI 切斷,inner SPAN 內容不在 outer LI 的 fragment 範圍內)。
  // 真實 case:IG modal「查看回覆 (10)」展開後,parent comment LI 含 10 個 reply LI,
  // textLen >> 300 → widget reject 不 fire,走 line 815 path → outer LI 加進
  // fragmentExtracted。v1.9.31 修法前 inner reply SPAN 的 Case D 被誤擋,
  // washington / dirk.dee 那種 reply 永遠翻不到。修法後 hasAncestorExtracted 加 block-boundary
  // 邏輯,跨越 inner reply LI 的 block 邊界後 outer LI 不再視為 blocker。
  const nestedReply1 = units.find((u) =>
    (u.textPreview || '').includes('Max agora é brasileiro'),
  );
  expect(
    nestedReply1,
    `巢狀 reply "Max agora é brasileiro" 必須被收(outer LI 雖在 fragmentExtracted 但 block boundary 切開)\n` +
    `實際 units:${JSON.stringify(units.map(u => u.textPreview).slice(0, 30))}`,
  ).toBeDefined();
  expect(nestedReply1.kind, 'nested reply 應為 fragment unit(Case D)').toBe('fragment');

  const nestedReply2 = units.find((u) =>
    (u.textPreview || '').includes('maintaining the power weight ratio'),
  );
  expect(
    nestedReply2,
    `巢狀 reply "maintaining the power weight ratio" 必須被收\n` +
    `實際 units:${JSON.stringify(units.map(u => u.textPreview).slice(0, 30))}`,
  ).toBeDefined();

  await page.close();
});
