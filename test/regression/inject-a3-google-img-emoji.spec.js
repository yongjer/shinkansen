// Regression: v1.9.31 IMG atomic + extractA3Seq IMG inline + segment catch-all。
//
// Fixture: test/regression/fixtures/inject-a3-google-img-emoji.html
//
// 結構特徵(不綁站名):X / Twitter 用 IMG render emoji,Google MT serializer 原本對
// IMG 透明 walk(IMG 無 children → 不加任何 token),IMG 在送 Google API 的 text
// 流中消失,deserialize 後 tgt 也沒 IMG。src/tgt seq 邊界錯位 → segment catch-all
// 把 tgt 全塞 ss[0] → emoji 全跑到段尾(視覺仍雙語式)。
//
// 修法(三塊缺一不可):
//   1. content-serialize.js:Google MT serializer 對 IMG 走 atomic 【*N】 deep clone。
//   2. content-inject.js extractA3Seq / extractA3SeqSpanUnwrapped:IMG 視為 inline
//      atomic({type:'inline', tag:'IMG'})。
//   3. content-inject.js segment fallback:catch-all 處理 N-to-M text segment。
//
// 真實 case:@thomaspaulmann Gemini 3.5 Flash tweet(2026-05-20 Chrome for Claude probe):
//   src structure:[SPAN.intro, DIV(@raycast), SPAN(":\n\n"), IMG, SPAN(line1\n), IMG,
//     SPAN(line2\n), IMG, SPAN(line3\n\nEnjoy!)]
//
// SANITY 紀錄(已驗證 2026-05-20):
//   - 拿掉 content-serialize.js IMG atomic 分支 → spec fail(IMG slot=0 預期 4)。
//   - 拿掉 extractA3Seq IMG inline → spec fail(IMG seq 不算 token,segment 對齊
//     把 emoji 兩側 text 合一段)。
//   - 拿掉 segment catch-all N-to-M → 最後一段 ss=1 ts=2 走原 1-to-N branch 過,
//     但其他結構稍變則 fail。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-google-img-emoji';
const TARGET_SELECTOR = '#tweet';

test('v1.9.31 IMG atomic + segment fallback:Google MT + IMG emoji 推文 → nodeValue mutate 不 fallback dual', async ({
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
      intro: tt.querySelector('.intro'),
      introText: tt.querySelector('.intro').firstChild,
      emoji1: tt.querySelector('.emoji-1'),
      emoji2: tt.querySelector('.emoji-2'),
      emoji3: tt.querySelector('.emoji-3'),
      mention: tt.querySelector('.mention-anchor'),
    };
  }, TARGET_SELECTOR);

  const injectResult = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);
      // fake Google MT 翻譯:主文 + 每行 prose 都翻成中文,atomic / paired marker 保留
      let fake = sourceText
        .replace('Gemini 3.5 Flash is now available in', 'Gemini 3.5 Flash 現已在')
        .replace(':', '中可用:')
        .replace('Better at following instructions', '更好地遵循指示')
        .replace('4x faster than previous models', '比以前的型號快 4 倍')
        .replace('Sharper multi-modal reasoning', '更清晰的多模態推理')
        .replace('Enjoy!', '享受吧!');
      const restored = window.__SK.restoreGoogleTranslateMarkers(fake);
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, restored, slots);
      return {
        sourceText,
        fake,
        slotCount: slots.length,
        slotKinds: slots.map(s => s.atomic ? 'atomic' : (s.reuseNode ? 'reuse' : 'paired')),
      };
    })()
  `);

  // 預期 slot:1 mention paired + 3 IMG atomic = 4
  expect(injectResult.slotCount, '應產 4 slot(@mention paired + 3 IMG atomic)').toBe(4);
  const atomicCount = injectResult.slotKinds.filter(k => k === 'atomic').length;
  expect(atomicCount, '3 個 IMG 應走 atomic deep clone').toBe(3);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const intro = tt.querySelector('.intro');
    const emoji1 = tt.querySelector('.emoji-1');
    const emoji2 = tt.querySelector('.emoji-2');
    const emoji3 = tt.querySelector('.emoji-3');
    const mention = tt.querySelector('.mention-anchor');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      intro_sameRef: intro === p.intro,
      introText_sameRef: intro?.firstChild === p.introText,
      introText_value: intro?.firstChild?.nodeValue || '',
      emoji1_sameRef: emoji1 === p.emoji1,
      emoji2_sameRef: emoji2 === p.emoji2,
      emoji3_sameRef: emoji3 === p.emoji3,
      emojiCount: tt.querySelectorAll('img').length,
      mention_sameRef: mention === p.mention,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
      // 整段 textContent 含中文 + emoji 位置(視覺驗證)
      ttText: tt.textContent || '',
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tweet element ref 保留').toBe(true);
  expect(result.intro_sameRef, 'intro SPAN ref 保留').toBe(true);
  expect(result.introText_sameRef, 'intro text node ref 保留').toBe(true);
  expect(result.introText_value, 'intro 主文翻譯').toContain('Gemini');
  expect(result.introText_value, 'intro 主文含「現已在」').toContain('現已在');
  expect(result.emoji1_sameRef, 'emoji-1 IMG ref 保留(atomic 不動 source)').toBe(true);
  expect(result.emoji2_sameRef, 'emoji-2 IMG ref 保留').toBe(true);
  expect(result.emoji3_sameRef, 'emoji-3 IMG ref 保留').toBe(true);
  expect(result.emojiCount, '3 個 IMG 全部仍在 source DOM').toBe(3);
  expect(result.mention_sameRef, '@mention anchor ref 保留').toBe(true);
  expect(result.tt_has_nodeValueMutated, '走 Layer A3 nodeValue mutate path').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual sibling').toBe(false);
  expect(result.wrapper_present, '不應產生 SHINKANSEN-TRANSLATION sibling wrapper').toBe(false);
  // 視覺驗證:中文 prose 跟 emoji 交錯出現(emoji 邊界保留)
  expect(result.ttText, '中文 prose 含「更好地遵循指示」').toContain('更好地遵循指示');
  expect(result.ttText, '中文 prose 含「比以前的型號快 4 倍」').toContain('比以前的型號快 4 倍');
  expect(result.ttText, '中文 prose 含「更清晰的多模態推理」').toContain('更清晰的多模態推理');
  expect(result.ttText, '中文 prose 含「享受吧」').toContain('享受吧');

  await page.close();
});
