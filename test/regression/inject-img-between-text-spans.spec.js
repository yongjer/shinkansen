// Regression: inject-img-between-text-spans
//
// Fixture: test/regression/fixtures/inject-img-between-text-spans.html
// 結構特徵:
//   <div id="target">
//     <span>Intro paragraph here.</span>
//     <img alt="🤯">
//     <span>Rest paragraph that is intentionally much longer ...</span>
//   </div>
//
// 真實案例:X(Twitter) 推文 body — `<div data-testid="tweetText">` 內 SPAN+IMG(emoji)+SPAN,
// 推文文字被 emoji image 切成兩個 inline 文字區塊。
//
// Bug(修法前):
//   injectIntoTarget 看到 containsMedia(target)=true、!hasContainerChild(SPAN 不在 CONTAINER_TAGS)、
//   !isHeading,進入 (B) media-preserving。findLongestTextNode 挑 SPAN[1] 內較長的 text node 當 main,
//   loop 清掉 SPAN[0] 的 text node 後 walk-up(v1.2.2 為 Gmail Team Picks 加的空殼移除)把 SPAN[0]
//   整顆移除。fragment 插進 main.parentNode(SPAN[1]),target 最終只剩 [IMG_orig, SPAN[1]]。
//   結果:譯文前段消失,只剩後段 + 一個浮動 IMG。
//
// 修法:
//   injectIntoTarget 加 textBearingChildCount > 1 守門 → 跳過 (B) 走 (A) clean-slate。
//   Clean-slate 把 target 子元素清掉再 append deserialized fragment(SPAN+SPAN),前後段都保留。
//
// 已知 trade-off(本 spec 不驗 IMG 保留):
//   IMG 不在 isAtomicPreserve 名單,serialize 階段就被略過,fragment 內沒有 IMG_clone。
//   走 clean-slate 時 target 既有的 IMG_orig 連同其他 children 一起被清掉,IMG 視覺消失。
//   這是「保前段譯文 vs. 保 IMG」的取捨,前段譯文優先。完整保 IMG 要把 IMG 加進
//   isAtomicPreserve + 在 (B) path 從 fragment 移掉 IMG_clone 避免雙倍,動到範圍較大,
//   待後續評估再做。
//
// canned response 鏡射 source 的 slot 結構(IMG 略過,只剩兩個 SPAN slot):⟦0⟧前段⟦/0⟧⟦1⟧後段⟦/1⟧。
//
// 斷言全部基於結構特徵(CLAUDE.md 硬規則 8):
//   1. slotCount === 2(SPAN×2;IMG 不入 slot)
//   2. target 內譯文必須包含「前段譯文」(不能整顆被刪)— 核心斷言
//   3. target 內譯文必須包含「後段譯文」
//   4. target 應有兩個 SPAN element children(對應兩個 slot 的 deserialized clone)
//
// SANITY 紀錄(已驗證):
//   暫時還原 injectIntoTarget 的 textBearingChildCount 守門(把 `&& textBearingChildCount <= 1` 拿掉)
//   → 斷言 2「target 應含『前段譯文』」會 FAIL(SPAN[0] 被當空殼移除,前段譯文整段不見)。
//   還原修法 → 全部 PASS。

import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'inject-img-between-text-spans';
const TARGET_SELECTOR = 'div#target';

test('inject-img-between-text-spans: IMG 把多個 inline 文字區塊切開時,inject 不可吞掉前段 SPAN', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  // canned response 鏡射 source slot 結構(SPAN×2,IMG 略過),確認走 ok=true 路徑
  expect(translation).toContain('⟦0⟧');
  expect(translation).toContain('⟦/0⟧');
  expect(translation).toContain('⟦1⟧');
  expect(translation).toContain('⟦/1⟧');

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  // 注入前 sanity:target 應有 3 個 children(SPAN, IMG, SPAN)
  const before = await page.evaluate((sel) => {
    const div = document.querySelector(sel);
    return {
      childrenTags: Array.from(div.children).map(c => c.tagName),
      hasImg: !!div.querySelector('img'),
      span0Text: div.children[0]?.textContent?.trim() ?? null,
      span2Text: div.children[2]?.textContent?.trim() ?? null,
    };
  }, TARGET_SELECTOR);
  expect(before.childrenTags, '注入前 target 應有 [SPAN, IMG, SPAN]').toEqual(['SPAN', 'IMG', 'SPAN']);
  expect(before.hasImg, '注入前 target 應含 IMG').toBe(true);
  expect(before.span0Text, '注入前 SPAN[0] 應為「Intro paragraph here.」').toBe('Intro paragraph here.');
  expect(before.span2Text, '注入前 SPAN[2] 應以 "Rest paragraph" 開頭').toMatch(/^Rest paragraph/);

  const { evaluate } = await getShinkansenEvaluator(page);
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);

  // 斷言 1:slotCount 應為 2(IMG 不在 isAtomicPreserve,不入 slot)
  expect(injectResult.slotCount, 'slotCount 應為 2(SPAN×2;IMG 略過)').toBe(2);

  // 注入後 DOM 斷言
  const after = await page.evaluate((sel) => {
    const div = document.querySelector(sel);
    if (!div) return null;
    return {
      childrenTags: Array.from(div.children).map(c => c.tagName),
      fullText: (div.textContent || '').trim(),
      innerHTMLPreview: div.innerHTML.replace(/\s+/g, ' ').slice(0, 400),
    };
  }, TARGET_SELECTOR);

  expect(after, 'div#target 應該存在').not.toBeNull();

  // 斷言 2:target 內譯文必須包含「前段譯文」(核心斷言 — bug 是前段被吞掉)
  expect(
    after.fullText,
    `target 內譯文應包含「前段譯文」(bug:前段 SPAN 被當空殼移除整段消失)` +
    `\nDOM: ${after.innerHTMLPreview}`,
  ).toContain('前段譯文');

  // 斷言 3:target 內譯文必須包含「後段譯文」
  expect(
    after.fullText,
    `target 內譯文應包含「後段譯文」\nDOM: ${after.innerHTMLPreview}`,
  ).toContain('後段譯文');

  // 斷言 4:target 應有兩個 SPAN element children(對應兩個 slot 的 deserialized clone)
  const spanChildren = after.childrenTags.filter(t => t === 'SPAN');
  expect(
    spanChildren.length,
    `target 應有 2 個 SPAN children(slot×2 deserialize 出的 clone);實際 ${spanChildren.length}` +
    `\nDOM: ${after.innerHTMLPreview}`,
  ).toBe(2);

  await page.close();
});
