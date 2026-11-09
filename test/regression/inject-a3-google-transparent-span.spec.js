// Regression: v1.9.31 — Google MT + 單語覆蓋 + framework-managed element 結構
// (X tweet「@mention 推文含 URL」)出現 dual sibling wrapper bug。
//
// Fixture: test/regression/fixtures/inject-a3-google-transparent-span.html
//
// 結構特徵(不綁站名):
//   Google MT serializer 對 SPAN 一律透明展開、對 A anchor 走 paired marker shallow
//   clone — deserialize 後 SPAN.class wrapper 不存在、A 內部結構全丟(只剩翻完純 text)。
//   Layer A3 strict alignment:
//     - source preservable SPAN.class wrapper → extractA3Seq 視為 inline
//     - source A.url(含 SPAN/text/SPAN/SPAN 視覺片段)→ inline
//     - tgt 端 SPAN 透明 → text;A.url 內結構消失 → 純 text
//     型別 / 結構雙重不符 → strict alignment fail → framework-managed fallback dual
//     sibling wrapper(違反 §15 single 原地替換)。
//
// 修法兩塊(v1.9.31):
//   1. content-serialize.js serializeNodeIterableForGoogle:對「含 element child 的 A」
//      走 atomic 【*N】 deep clone(本來走 paired marker shallow clone)。deserialize
//      時 A 內部結構完整保留。
//   2. content-inject.js collectA3Mutations:strict 失敗時加 SPAN-unwrap fallback —
//      extractA3SeqSpanUnwrapped 對 SPAN 一律透明展開(對齊 serializer 設計),A / B
//      / I / STRONG 等 semantic inline 維持 opaque。
//
// 對齊結果(src/tgt 兩端 SPAN-unwrap 後):
//   [text(主文), inline(A.url), inline(A.mention)] = 3 items 對齊
//   → mutate src 主文 text node nodeValue → single 覆蓋成立。
//
// 真實 case:@stevesi Soma tweet(2026-05-20 Chrome for Claude probe 驗證)
//   <div data-testid="tweetText">
//     <span class="...">S. 'Soma' Somasegar, 1966-2026: Microsoft and...</span>
//     <a class="...">
//       <span>https://</span>geekwire.com/...<span>主體</span><span>…</span>
//     </a>
//     <span class="..."> </span>
//     <div><span><a href="/user/">@GeekWire</a></span></div>
//   </div>
// 修法前 Google MT 翻完該推文出現 SHINKANSEN-TRANSLATION sibling wrapper(視覺雙語)。
//
// SANITY 紀錄(已驗證 2026-05-20):
//   - 暫拿掉 content-serialize.js 對 A 含 element child 的 atomic 分支 → spec fail
//     (A 走 paired marker shallow clone,deserialize 後 A 內 SPAN 消失,urlFragsCount=0
//     + urlFrag0_sameRef=false)→ 還原 atomic 分支 → pass。
//   - 暫拿掉 content-inject.js collectA3Mutations 的 SPAN-unwrap fallback → spec fail
//     (src SPAN.main vs tgt text 型別不符,return false → injectDual → wrapper_present
//     = true)→ 還原 SPAN-unwrap fallback → pass。
//   - 兩塊修法缺一不可(atomic 解 A 結構保留問題,SPAN-unwrap 解 SPAN.main wrapper 對齊
//     問題)。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-google-transparent-span';
const TARGET_SELECTOR = '#tweet';

test('v1.9.31 atomic A + SPAN-unwrap:Google MT + framework 段落 → nodeValue mutate 不 fallback dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 強制 framework-managed 走 nodeValue mutate path(對應真實 X / React SPA)
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 紀錄 inject 前的 node ref + structure
  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    window.__probeBefore = {
      tt,
      mainSpan: tt.querySelector('.text-main'),
      mainTextNode: tt.querySelector('.text-main').firstChild,
      urlAnchor: tt.querySelector('.url-link'),
      urlFrag1: tt.querySelector('.url-frag-1'),
      urlFrag2: tt.querySelector('.url-frag-2'),
      urlFrag3: tt.querySelector('.url-frag-3'),
      mentionAnchor: tt.querySelector('.mention-anchor'),
    };
  }, TARGET_SELECTOR);

  // 走 Google MT serializer 抽 source text + slots(模擬真實 Google MT 路徑)
  // 然後 restoreGoogleTranslateMarkers 後丟給 injectTranslation
  const injectResult = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);
      // 模擬 Google MT 翻譯結果(原 inline marker 保留,SPAN 文字翻成中文)
      const fakeGoogleMTOutput = sourceText
        .replace(
          'This is a long prose paragraph that simulates a Twitter tweet body with enough characters to look real.',
          '這是一段模擬 Twitter 推文內文的長篇文字,字數足以看起來像真的。'
        );
      const restored = window.__SK.restoreGoogleTranslateMarkers(fakeGoogleMTOutput);
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, restored, slots);
      return {
        sourceText,
        slotCount: slots.length,
        slotKinds: slots.map(s => s.atomic ? 'atomic' : (s.reuseNode ? 'reuse' : 'paired')),
      };
    })()
  `);

  // v1.9.31:A.url 含 element child(SPAN/SPAN/SPAN)→ 走 atomic;A.mention 內單 text
  // → 走 paired marker(可翻 inner text)
  expect(injectResult.slotCount, '應產 2 slot(A.url + A.mention)').toBe(2);
  expect(injectResult.slotKinds[0], 'A.url 應走 atomic(deep clone 保結構)').toBe('atomic');
  expect(injectResult.slotKinds[1], 'A.mention 應走 paired marker(內單 text 可翻)').toBe('paired');

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const mainSpan = tt.querySelector('.text-main');
    const urlAnchor = tt.querySelector('.url-link');
    const urlFrag1 = tt.querySelector('.url-frag-1');
    const urlFrag2 = tt.querySelector('.url-frag-2');
    const urlFrag3 = tt.querySelector('.url-frag-3');
    const mentionAnchor = tt.querySelector('.mention-anchor');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      mainSpan_sameRef: mainSpan === p.mainSpan,
      mainTextNode_sameRef: mainSpan?.firstChild === p.mainTextNode,
      mainTextNode_value: mainSpan?.firstChild?.nodeValue,
      urlAnchor_sameRef: urlAnchor === p.urlAnchor,
      urlFrag1_sameRef: urlFrag1 === p.urlFrag1,
      urlFrag2_sameRef: urlFrag2 === p.urlFrag2,
      urlFrag3_sameRef: urlFrag3 === p.urlFrag3,
      // 真實 X URL anchor 內含 4 child(SPAN/text/SPAN/SPAN),fixture 也模擬此結構。
      // atomic deep clone 後 anchor 內部結構完整保留,4 個 children 都還在。
      urlAnchorChildCount: urlAnchor?.childNodes.length,
      mentionAnchor_sameRef: mentionAnchor === p.mentionAnchor,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tweet element ref 保留').toBe(true);
  expect(result.mainSpan_sameRef, '主 SPAN ref 保留(framework 安全)').toBe(true);
  expect(result.mainTextNode_sameRef, '主 SPAN text node ref 保留(透過 nodeValue mutate)').toBe(true);
  expect(result.mainTextNode_value, '主文已替換為中文').toContain('模擬');
  expect(result.urlAnchor_sameRef, 'URL anchor ref 保留(click 安全)').toBe(true);
  // atomic deep clone 後 anchor 內部結構完整保留:SPAN("https://")、text("example.com/")、
  // SPAN("article/2026")、SPAN("…")四個 children。注意 clone 後 ref 跟原本不同(deep
  // clone 出新 node),但結構同構。原 element ref 在 source DOM 上仍存在(沒被 detach)。
  expect(result.urlAnchorChildCount, 'A.url 內 4 個 children 完整保留(atomic deep clone)').toBe(4);
  expect(result.urlFrag1_sameRef, 'A.url 內 SPAN.url-frag-1 ref 保留(原 DOM 沒動)').toBe(true);
  expect(result.urlFrag2_sameRef, 'A.url 內 SPAN.url-frag-2 ref 保留').toBe(true);
  expect(result.urlFrag3_sameRef, 'A.url 內 SPAN.url-frag-3 ref 保留').toBe(true);
  expect(result.mentionAnchor_sameRef, 'mention anchor ref 保留').toBe(true);
  expect(result.tt_has_nodeValueMutated, '走 Layer A3 nodeValue mutate path').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual sibling').toBe(false);
  expect(result.wrapper_present, '不應產生 SHINKANSEN-TRANSLATION sibling wrapper(單語覆蓋成立)').toBe(false);

  await page.close();
});
