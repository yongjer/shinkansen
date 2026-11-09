// Regression: inject-a3-extract-criteria-align (CLAUDE.md §15 + §5 單一資料源)
//
// Fixture: test/regression/fixtures/inject-a3-extract-criteria-align.html
// 結構特徵:tweetText 內含 SPAN(" ") spacer — has class 但內容 " " 跨不過
// serializer 的 hasSubstantiveContent([A-Za-z0-9 + CJK])檢查。
// 對應真實 X 推文 (@YoinkApp probe 2026-05-20):tweetText 內混 SPAN.r-18u37iz
// hashtag wrapper(有實質)+ SPAN(" ") spacer(無實質)。
//
// 修法前:extractA3Seq 只看「SPAN + class」就視為 inline → source seq 帶
// inline、target seq deserialize 後是 text(serializer 視為透明)→ type 不符
// → fallback dual sibling(違反 §15)。
// 修法後:extractA3Seq 直接呼叫 SK.isPreservableInline,跟 serializer 同一
// 條 source of truth(CLAUDE.md §5)→ non-substantive SPAN 兩邊一致視為透明 →
// alignment 通過,走 nodeValue mutate。
//
// SANITY 紀錄(已驗證):暫把 extractA3Seq 改回手寫 isInline(只看 SPAN+class)
//   → 本 spec fail(type 不符 fallback dual)→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-extract-criteria-align';
const TARGET_SELECTOR = '#target';

test('A3 extract criteria align:source SPAN(" ") 視為透明 → 與 target text 對齊不 fallback dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefixSpan = tt.querySelector('.prefix');
    const hashtagWraps = tt.querySelectorAll('.hashtag-wrap');
    const hashtagLinks = tt.querySelectorAll('.hashtag-link');
    const spacers = tt.querySelectorAll('.spacer');
    const a = tt.querySelector('a.url');
    window.__probeBefore = {
      tt,
      prefixSpan,
      prefixText: prefixSpan.firstChild,
      hashtagWrap0: hashtagWraps[0],
      hashtagWrap1: hashtagWraps[1],
      hashtagLink0: hashtagLinks[0],
      hashtagLink1: hashtagLinks[1],
      spacer0: spacers[0],
      spacer1: spacers[1],
      a,
    };
  }, TARGET_SELECTOR);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefixSpan = tt.querySelector('.prefix');
    const hashtagWraps = tt.querySelectorAll('.hashtag-wrap');
    const hashtagLinks = tt.querySelectorAll('.hashtag-link');
    const spacers = tt.querySelectorAll('.spacer');
    const a = tt.querySelector('a.url');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      prefixSpan_sameRef: prefixSpan === p.prefixSpan,
      prefixText_value: prefixSpan?.firstChild?.nodeValue,
      hashtagWrap0_sameRef: hashtagWraps[0] === p.hashtagWrap0,
      hashtagWrap1_sameRef: hashtagWraps[1] === p.hashtagWrap1,
      hashtagLink0_sameRef: hashtagLinks[0] === p.hashtagLink0,
      hashtagLink1_sameRef: hashtagLinks[1] === p.hashtagLink1,
      spacer0_sameRef: spacers[0] === p.spacer0,
      spacer1_sameRef: spacers[1] === p.spacer1,
      a_sameRef: a === p.a,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tt element ref 保留').toBe(true);
  expect(result.prefixSpan_sameRef, 'prefix SPAN ref 保留').toBe(true);
  expect(result.prefixText_value, 'prefix mutate 為中文').toContain('Yoink 給');
  expect(result.hashtagWrap0_sameRef, 'hashtag-wrap[0] SPAN ref 保留').toBe(true);
  expect(result.hashtagWrap1_sameRef, 'hashtag-wrap[1] SPAN ref 保留').toBe(true);
  expect(result.hashtagLink0_sameRef, 'hashtag-link[0] A ref 保留(click handler 安全)').toBe(true);
  expect(result.hashtagLink1_sameRef, 'hashtag-link[1] A ref 保留').toBe(true);
  expect(result.spacer0_sameRef, 'spacer SPAN[0] ref 保留(透明遞迴後仍存活)').toBe(true);
  expect(result.spacer1_sameRef, 'spacer SPAN[1] ref 保留').toBe(true);
  expect(result.a_sameRef, 'A.url ref 保留').toBe(true);
  expect(result.tt_has_nodeValueMutated, '走 nodeValue mutate').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual').toBe(false);
  expect(result.wrapper_present, '不應 inject sibling wrapper').toBe(false);

  await page.close();
});
