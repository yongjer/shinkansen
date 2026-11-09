// Regression: inject-lazy-media-placeholder
//
// Fixture: test/regression/fixtures/inject-lazy-media-placeholder.html
// 結構特徵:
//   <a id="target" href="...">
//     <div class="img-placeholder"><div></div><div></div></div>  ← 空結構占位子(lazy-load image 容器)
//     <div class="title">Does iPhone need its own MacBook Neo moment? - 9to5Mac</div>
//   </a>
//
// 真實案例:X(Twitter)URL card preview — `<a>` 包 `<div>`(lazy-load 圖片占位子,有 children
// 但 IMG 還沒進來,textContent="")+ 標題 DIV。
//
// Bug(修法前):
//   injectIntoTarget 看到 containsMedia(<a>)=false(IMG 還沒 lazy-load,querySelector('img')
//   為空),且 !isHeading、hasContainerChild=true(DIV 是 CONTAINER)→ 走 (A) clean-slate,
//   清掉 `<a>` 所有 children,只剩翻完的標題文字。之後 SPA framework lazy-load 圖片時,placeholder
//   容器已被清掉,圖片永遠載不進來 → 大圖預覽完全消失,只剩細長的標題框。
//
// 修法:
//   injectIntoTarget 加 hasEmptyPlaceholderChild 偵測(target 直屬有 element child 自身有
//   children 但無 text)+ 把 (B) 守門擴成 (containsMedia OR hasEmptyPlaceholderChild)+
//   增加 hasEmptyPlaceholderChild 作為 hasContainerChild 例外。
//   走 (B) media-preserving 路徑:findLongestTextNode 找到 title text → 只替換 title,
//   placeholder DIV 完整保留 → 後續 lazy-load 圖片可塞進占位子。
//
// canned response 是純文字(無 slot),deserialize 走「ok=false」→ 走 plainTextFallback → 經
// injectIntoTarget(target, cleanedText)。修法後 (B) 命中,target 內 placeholder DIV 不動,
// title DIV 的文字被換成譯文。
//
// 斷言全部基於結構特徵(CLAUDE.md 硬規則 8):
//   1. 注入後 target 應有 2 個 element children(placeholder DIV + title DIV 都還在)
//   2. placeholder DIV(target.children[0])應仍有 children(空結構占位子保留)
//   3. title DIV(target.children[1])應含譯文文字
//   4. target.textContent 應含譯文文字
//
// SANITY 紀錄(已驗證):
//   暫時還原 injectIntoTarget 的 hasEmptyPlaceholderChild 守門(回到僅 containsMedia 判斷)
//   → 斷言 1「target 應有 2 個 element children」會 FAIL(走 (A) clean-slate 把 placeholder
//   清掉,target 只剩翻完的文字 text node,0 個 element children)。
//   還原修法 → 全部 PASS。

import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'inject-lazy-media-placeholder';
const TARGET_SELECTOR = 'a#target';

test('inject-lazy-media-placeholder: lazy-load 圖片占位 DIV 在 inject 後必須保留', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  // 注入前 sanity
  const before = await page.evaluate((sel) => {
    const a = document.querySelector(sel);
    return {
      childrenCount: a.children.length,
      placeholderChildren: a.children[0]?.children.length,
      placeholderTextLen: (a.children[0]?.textContent || '').trim().length,
      titleText: a.children[1]?.textContent?.trim(),
    };
  }, TARGET_SELECTOR);
  expect(before.childrenCount, '注入前 target 應有 2 個 children').toBe(2);
  expect(before.placeholderChildren, '注入前 placeholder DIV 應有 2 個內層 children').toBe(2);
  expect(before.placeholderTextLen, '注入前 placeholder DIV 文字長度應為 0').toBe(0);
  expect(before.titleText, '注入前 title DIV 應為英文標題').toContain('MacBook Neo moment');

  const { evaluate } = await getShinkansenEvaluator(page);
  await runTestInject(evaluate, TARGET_SELECTOR, translation);

  // 注入後 DOM 斷言
  const after = await page.evaluate((sel) => {
    const a = document.querySelector(sel);
    if (!a) return null;
    return {
      childrenCount: a.children.length,
      childrenTags: Array.from(a.children).map(c => c.tagName),
      placeholderChildren: a.children[0]?.children.length,
      placeholderTextLen: (a.children[0]?.textContent || '').trim().length,
      titleText: a.children[1]?.textContent?.trim(),
      fullText: (a.textContent || '').trim(),
      hasTranslatedAttr: a.hasAttribute('data-shinkansen-translated'),
      innerHTMLPreview: a.innerHTML.replace(/\s+/g, ' ').slice(0, 300),
    };
  }, TARGET_SELECTOR);

  expect(after, 'a#target 應該存在').not.toBeNull();

  // 斷言 1: 注入後 target 應有 2 個 element children(核心斷言 — bug 是清成 0 個)
  expect(
    after.childrenCount,
    `target 應有 2 個 element children(placeholder + title);實際 ${after.childrenCount}` +
    `\nDOM: ${after.innerHTMLPreview}`,
  ).toBe(2);

  // 斷言 2: placeholder DIV(target.children[0])應仍有內層 children
  expect(
    after.placeholderChildren,
    `placeholder DIV 應仍有 2 個內層 children(lazy-load 容器保留);實際 ${after.placeholderChildren}` +
    `\nDOM: ${after.innerHTMLPreview}`,
  ).toBe(2);

  // 斷言 3: title DIV 應含譯文文字
  expect(
    after.titleText,
    `title DIV 應含譯文文字\nDOM: ${after.innerHTMLPreview}`,
  ).toContain('iPhone 需要自己的 MacBook Neo 時刻嗎');

  // 斷言 4: target.textContent 應含譯文文字
  expect(
    after.fullText,
    `target 內譯文應包含「iPhone 需要自己的 MacBook Neo 時刻嗎」\nDOM: ${after.innerHTMLPreview}`,
  ).toContain('iPhone 需要自己的 MacBook Neo 時刻嗎');

  await page.close();
});
