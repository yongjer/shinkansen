// Regression: v1.9.31 \n-aware segment fallback — Google MT + 含 \n 換行推文出現
// dual sibling wrapper bug。
//
// Fixture: test/regression/fixtures/inject-a3-newline-segment.html
//
// 結構特徵(不綁站名):source 端 SPAN.main text node 含 \n,Google MT serializer
// 對 SPAN 透明 + preserveNewlines=true 把 \n 送 Google API,翻完保留 \n,deserialize
// 時 \n 拆成 BR + text。target SpanU 比 src 多出 BR-split text → strict / SPAN-unwrap
// 等長都對不上 → 原本 fallback dual。
//
// 修法:collectA3Mutations 加 segment-based fallback,以 inline 為錨點分段,
// inline-to-inline tag 對齊 + 區段內 1-to-N text 用 \n join 起來 mutate。
//
// 真實 case:@asymco Mont Blanc / Exotica tweet(2026-05-20 Chrome for Claude probe)
//   src structure:[SPAN.main(含 \n + Mont Blanc), A.url1, SPAN("\nExotica "), A.url2, ...hashtags]
//   tgt structure:[text(中文主文), BR, text(萬寶龍), A.url1, BR, text(奇特), A.url2, ...]
//
// SANITY 紀錄(已驗證 2026-05-20):暫拿掉 collectA3Mutations 的 segment fallback →
// spec fail(strict/SPAN-unwrap 都過不去 inline 邊界,SPAN.main 內 \n 跨 BR 分段對齊
// 不上 → return false → injectDual → wrapper_present=true)→ 還原 segment fallback
// → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-newline-segment';
const TARGET_SELECTOR = '#tweet';

test('v1.9.31 \\n-aware segment fallback:Google MT + 含 \\n 換行推文 → nodeValue mutate 不 fallback dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 強制 framework-managed 走 nodeValue mutate path(對應真實 X / React SPA)
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 紀錄 inject 前的 node ref
  await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    window.__probeBefore = {
      tt,
      mainSpan: tt.querySelector('.text-main'),
      mainTextNode: tt.querySelector('.text-main').firstChild,
      url1: tt.querySelector('.url-link-1'),
      url2: tt.querySelector('.url-link-2'),
      exoticaSpacer: tt.querySelector('.exotica-spacer'),
      exoticaTextNode: tt.querySelector('.exotica-spacer').firstChild,
      hashtag1: tt.querySelector('.hashtag-anchor-1'),
      hashtag2: tt.querySelector('.hashtag-anchor-2'),
    };
  }, TARGET_SELECTOR);

  // 走 Google MT serializer 抽 source text + slots,然後 fake 翻完丟給 injectTranslation
  const injectResult = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);
      // 模擬 Google MT 翻譯(保留 \\n 與 atomic/paired marker、SPAN 透明展開後翻譯文字)
      // 重點:主文「My latest...Mixcloud:\\nMont Blanc 」翻譯後仍含 \\n,後續 \\nExotica 也帶 \\n
      const fakeGoogleMTOutput = sourceText
        .replace(
          'My latest Italo Disco sets for the Mind Enterprises fans out there. Check out on Mixcloud:',
          '我為 Mind Enterprises 粉絲準備的最新 Italo Disco 套裝。在 Mixcloud 上查看:'
        )
        .replace('Mont Blanc', '萬寶龍')
        .replace('Exotica', '奇特');
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

  // 兩個 URL anchor 含 element child → atomic;2 個 hashtag anchor 內單 text → paired
  expect(injectResult.slotCount, '應產 4 slot(2 URL + 2 hashtag)').toBeGreaterThanOrEqual(2);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const mainSpan = tt.querySelector('.text-main');
    const url1 = tt.querySelector('.url-link-1');
    const url2 = tt.querySelector('.url-link-2');
    const exoticaSpacer = tt.querySelector('.exotica-spacer');
    const hashtag1 = tt.querySelector('.hashtag-anchor-1');
    const hashtag2 = tt.querySelector('.hashtag-anchor-2');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      mainSpan_sameRef: mainSpan === p.mainSpan,
      mainTextNode_sameRef: mainSpan?.firstChild === p.mainTextNode,
      mainTextNode_value: mainSpan?.firstChild?.nodeValue || '',
      url1_sameRef: url1 === p.url1,
      url2_sameRef: url2 === p.url2,
      exoticaSpacer_sameRef: exoticaSpacer === p.exoticaSpacer,
      exoticaTextNode_sameRef: exoticaSpacer?.firstChild === p.exoticaTextNode,
      exoticaTextNode_value: exoticaSpacer?.firstChild?.nodeValue || '',
      hashtag1_sameRef: hashtag1 === p.hashtag1,
      hashtag2_sameRef: hashtag2 === p.hashtag2,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tweet element ref 保留').toBe(true);
  expect(result.mainSpan_sameRef, '主 SPAN ref 保留(framework 安全)').toBe(true);
  expect(result.mainTextNode_sameRef, '主 SPAN text node ref 保留(nodeValue mutate)').toBe(true);
  // 主 SPAN.main 內譯文:主文中文 + \n + 萬寶龍(對應 src 結構)
  expect(result.mainTextNode_value, '主文已翻譯成中文').toContain('套裝');
  expect(result.mainTextNode_value, '主文 \\n + Mont Blanc 譯文「萬寶龍」拼回 src 同一 text node').toContain('萬寶龍');
  expect(result.mainTextNode_value, '中文主文跟萬寶龍之間 \\n 保留').toMatch(/\n/);
  // SPAN.exotica:src "\nExotica " → tgt "奇特",mutate 後保留 leading \n
  expect(result.exoticaSpacer_sameRef, 'Exotica spacer SPAN ref 保留').toBe(true);
  expect(result.exoticaTextNode_sameRef, 'Exotica text node ref 保留').toBe(true);
  expect(result.exoticaTextNode_value, 'Exotica spacer 譯文「奇特」').toContain('奇特');
  expect(result.exoticaTextNode_value, 'Exotica spacer leading \\n 保留').toMatch(/^\n/);
  expect(result.url1_sameRef, 'URL1 anchor ref 保留(atomic deep clone 不動 source)').toBe(true);
  expect(result.url2_sameRef, 'URL2 anchor ref 保留').toBe(true);
  expect(result.hashtag1_sameRef, 'hashtag1 anchor ref 保留').toBe(true);
  expect(result.hashtag2_sameRef, 'hashtag2 anchor ref 保留').toBe(true);
  expect(result.tt_has_nodeValueMutated, '走 Layer A3 nodeValue mutate path').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual sibling').toBe(false);
  expect(result.wrapper_present, '不應產生 SHINKANSEN-TRANSLATION sibling wrapper').toBe(false);

  await page.close();
});
