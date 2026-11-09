// Regression: v1.9.31 segment fallback「Google MT 短 metadata 連接詞合併翻譯」case。
//
// Fixture: test/regression/fixtures/inject-a3-google-drops-connector.html
//
// 結構特徵(不綁站名):src tweetText 含「主文 + URL + 短連接詞(by/at/via) + @mention」。
// Google MT 翻譯時把「 by 」這類短連接詞跟主文一起翻譯,deserialize 後 tgt 結構
// 「中間 text segment」消失:src 4 items vs tgt 3 items strict / SPAN-unwrap 對齊
// 長度不符 → 原本 fallback dual。
//
// 修法:segment fallback 對「src text 段落有內容 + tgt text 段落空」case,當 src 全部
// text 加總 ≤ 12 字時容忍 mutate 為 ""(視覺接受失去連接詞,符合 Google MT 翻譯結果)。
//
// 真實 case:@9to5toys iPad Air tweet(2026-05-20 Chrome for Claude probe):
//   src structure:[SPAN.main, A.url, SPAN(" by "), DIV(SPAN(A.justinkahnmusic))]
//   tgt structure:[text(中文主文 40), A.url, A.mention] — 中間 " by " 消失。
//   src SpanU 4 vs tgt SpanU 3 → segment 對齊 ss=[" by "] vs ts=[] → mutate to ""。
//
// SANITY 紀錄(已驗證 2026-05-20):暫拿掉 segment fallback「ts.length===0 && ss<=12」
// 分支 → spec fail(src 段落有內容但 tgt 空 → segOk=false → injectDual)→ 還原 →
// pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-google-drops-connector';
const TARGET_SELECTOR = '#tweet';

test('v1.9.31 segment fallback:Google MT 把 " by " 合進主文翻譯 → src 連接詞 mutate to "" 不 fallback dual', async ({
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
      url: tt.querySelector('.url-link'),
      byConnector: tt.querySelector('.by-connector'),
      byTextNode: tt.querySelector('.by-connector').firstChild,
      mention: tt.querySelector('.mention-anchor'),
    };
  }, TARGET_SELECTOR);

  // 模擬 Google MT 把 " by " 跟主文一起翻譯(中文版去掉 by 連接詞)。
  // sourceText 結構 ~= "Now even lower: ...today 【*0】 by 【1】@justinkahnmusic【/1】"
  // fake output 主文翻譯 + atomic / paired marker 保留 + by 消失
  const injectResult = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);
      // 把主文 prose 換成中文,然後把 " by " connector 抹掉
      let fake = sourceText
        .replace('Now even lower: Giant $400 price drop hits this 1TB M3 iPad Air today',
                 '現在甚至更低:今天這款 1TB M3 iPad Air 大幅降價 400 美元');
      // 把「 by 」拿掉(Google MT 合併翻譯後沒這個連接詞)
      fake = fake.replace(/\\s*by\\s*/, '');
      const restored = window.__SK.restoreGoogleTranslateMarkers(fake);
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, restored, slots);
      return { sourceText, fake, slotCount: slots.length };
    })()
  `);

  expect(injectResult.slotCount, '應產 2 slot(A.url atomic + A.mention paired)').toBe(2);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const mainSpan = tt.querySelector('.text-main');
    const url = tt.querySelector('.url-link');
    const byConnector = tt.querySelector('.by-connector');
    const mention = tt.querySelector('.mention-anchor');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      mainTextNode_sameRef: mainSpan?.firstChild === p.mainTextNode,
      mainTextNode_value: mainSpan?.firstChild?.nodeValue || '',
      url_sameRef: url === p.url,
      byConnector_sameRef: byConnector === p.byConnector,
      byTextNode_sameRef: byConnector?.firstChild === p.byTextNode,
      byTextNode_value: byConnector?.firstChild?.nodeValue || '',
      mention_sameRef: mention === p.mention,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tweet element ref 保留').toBe(true);
  expect(result.mainTextNode_sameRef, '主 SPAN text node ref 保留').toBe(true);
  expect(result.mainTextNode_value, '主文已翻譯成中文').toContain('降價');
  expect(result.url_sameRef, 'URL anchor ref 保留(atomic)').toBe(true);
  expect(result.byConnector_sameRef, 'by-connector SPAN ref 保留').toBe(true);
  expect(result.byTextNode_sameRef, 'by-connector text node ref 保留').toBe(true);
  expect(result.byTextNode_value, '"by" connector text 被 mutate 為 ""(Google MT 合併翻譯)').toBe('');
  expect(result.mention_sameRef, 'mention anchor ref 保留').toBe(true);
  expect(result.tt_has_nodeValueMutated, '走 Layer A3 nodeValue mutate path').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual sibling').toBe(false);
  expect(result.wrapper_present, '不應產生 SHINKANSEN-TRANSLATION sibling wrapper').toBe(false);

  await page.close();
});
