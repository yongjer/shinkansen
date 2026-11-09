// Regression: segment fallback「CJK 語序重排 trailing overflow」case。
//
// Fixture: test/regression/fixtures/inject-a3-google-trailing-overflow.html
//
// 結構特徵（不綁站名）：src 含「主文 SPAN + DIV(SPAN(A.mention))」，mention 在句尾。
// Google MT 翻譯後 CJK 語序把主文拆成「mention 前 + mention + mention 後」三段，
// 而 source 在 mention 後面沒有 text node。
//
// segment fallback 切分後最後一段 src=[] tgt=[text("溢出")] 原本觸發 segOk=false
// → framework-managed fallback dual sibling wrapper（違反 §15 single 原地替換）。
//
// 修法：把溢出文字吸收進前一個有內容的 text segment mutation。
//
// 真實 case：X 推文 "And obviously it was amazing to meet my buddy @vamsibatchuk"
// Google MT 翻譯 "顯然，見到我的好友 @vamsibatchuk 真是太棒了" — mention 後面多出
// 「真是太棒了」溢出文字。
//
// SANITY 紀錄（已驗證 2026-05-26）：暫改 `if (lastProseMutationIdx >= 0)` 為
// `if (false && lastProseMutationIdx >= 0)` → 2 條 spec 皆 fail
// （src 段落空但 tgt 有 → segOk=false → injectDual）→ 還原 → 2 條 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-google-trailing-overflow';
const TARGET_SELECTOR = '#tweet';

test('segment fallback: CJK 語序重排 mention 後多出 text → 吸收進前段 mutation 不 fallback dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    window.__probeBefore = {
      tt,
      mainSpan: tt.querySelector('.text-main'),
      mainTextNode: tt.querySelector('.text-main').firstChild,
      mention: tt.querySelector('.mention-anchor'),
      mentionTextNode: tt.querySelector('.mention-anchor').firstChild,
    };
  }, TARGET_SELECTOR);

  // Google MT 翻譯：主文翻成中文，mention 保留，mention 後面多出「真是太棒了」
  const injectResult = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);
      // 模擬 Google MT 翻譯結果：mention 前 + mention + mention 後（中文語序）
      let fake = sourceText.replace(
        'And obviously it was amazing to meet my buddy',
        '顯然，見到我的好友'
      );
      // 在 mention 的 closing marker 後面加上溢出文字
      fake = fake.replace(/(【\\/\\d+】)$/, '$1 真是太棒了');
      const restored = window.__SK.restoreGoogleTranslateMarkers(fake);
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, restored, slots);
      return { sourceText, fake, restored, slotCount: slots.length };
    })()
  `);

  expect(injectResult.slotCount, '應產 1 slot（A.mention paired）').toBe(1);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const mainSpan = tt.querySelector('.text-main');
    const mention = tt.querySelector('.mention-anchor');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      mainTextNode_sameRef: mainSpan?.firstChild === p.mainTextNode,
      mainTextNode_value: mainSpan?.firstChild?.nodeValue || '',
      mention_sameRef: mention === p.mention,
      mentionTextNode_sameRef: mention?.firstChild === p.mentionTextNode,
      mentionTextNode_value: mention?.firstChild?.nodeValue || '',
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tweet element ref 保留').toBe(true);
  expect(result.mainTextNode_sameRef, '主 SPAN text node ref 保留').toBe(true);
  expect(result.mainTextNode_value, '主文包含翻譯 + 溢出文字').toContain('顯然');
  expect(result.mainTextNode_value, '溢出的「真是太棒了」被吸收進主文 text node').toContain('真是太棒了');
  expect(result.mention_sameRef, 'mention anchor ref 保留').toBe(true);
  expect(result.mentionTextNode_sameRef, 'mention text node ref 保留').toBe(true);
  expect(result.mentionTextNode_value, 'mention 文字不變').toBe('@vamsibatchuk');
  expect(result.tt_has_nodeValueMutated, '走 Layer A3 nodeValue mutate path').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual sibling').toBe(false);
  expect(result.wrapper_present, '不應產生 SHINKANSEN-TRANSLATION sibling wrapper').toBe(false);

  await page.close();
});

test('segment fallback: 多 inline + trailing overflow 也能吸收', async ({
  context,
  localServer,
}) => {
  // 用同一 fixture 但 mock 更複雜的翻譯結果
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 直接用 injectTranslation + 手工 slots 測試 collectA3Mutations
  const result = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);
      // 模擬 Google MT：翻完 mention 後面多短語「呢」（極短溢出）
      let fake = sourceText.replace(
        'And obviously it was amazing to meet my buddy',
        '顯然，見到好友'
      );
      fake = fake.replace(/(【\\/\\d+】)$/, '$1 呢');
      const restored = window.__SK.restoreGoogleTranslateMarkers(fake);
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, restored, slots);
      const mainText = el.querySelector('.text-main')?.firstChild?.nodeValue || '';
      return {
        mainText,
        hasNvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
        hasWrapper: !!document.querySelector('shinkansen-translation'),
      };
    })()
  `);

  expect(result.hasNvMutated, '走 nodeValue mutate').toBe(true);
  expect(result.mainText, '溢出「呢」被吸收進主文').toContain('呢');
  expect(result.hasWrapper, '沒有 dual wrapper').toBe(false);

  await page.close();
});
