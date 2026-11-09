// Regression: v1.9.31 LLM path 對 IMG emoji 推文必須維持透明對齊(不誤算 IMG 為 inline)。
//
// Fixture: test/regression/fixtures/inject-a3-llm-img-emoji.html
//
// 結構特徵(不綁站名):X / Twitter 純 SPAN + IMG 交錯結構(沒 anchor)。LLM Gemini
// path serializer 對 SPAN paired marker shallow clone、對 IMG 透明走 walk children
// (沒 token)→ 翻完 deserialize tgt 全 SPAN 沒 IMG。
//
// v1.9.31 加 IMG inline atomic 修法(extractA3Seq 對 IMG push inline)若無條件啟用,
// LLM path src 端會多 IMG inline tokens 而 tgt 沒對應 → 長度不符 strict / SPAN-unwrap
// / segment 全 fail → fallback dual sibling。破壞原本 work 的 LLM path 對齊。
//
// 修法:collectA3Mutations 入口看 tgt 是否含 IMG element,動態決定 imgIsInline mode。
//   - tgt 含 IMG(Google MT IMG atomic deserialize 後)→ imgIsInline=true → src/tgt
//     兩端 IMG 都算 inline 對齊
//   - tgt 沒 IMG(LLM Gemini path)→ imgIsInline=false → src IMG 透明展開,維持
//     原本對齊邏輯
//
// 真實 case:@nandoprince93 Apple Vision Pro tweet(2026-05-20 Chrome for Claude probe):
//   src structure:[SPAN.main(\n\n), IMG×6 跟 SPAN×6 交錯]
//
// SANITY 紀錄(已驗證 2026-05-20):暫拿掉 imgIsInline 動態判斷,把 extractA3Seq IMG
// inline 強制 true → spec fail(src 多 6 IMG inline tokens,tgt 沒對應 → 長度不符
// → fallback dual)→ 還原動態判斷 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-llm-img-emoji';
const TARGET_SELECTOR = '#tweet';

test('v1.9.31 LLM path IMG 透明:Gemini + IMG emoji 推文 → nodeValue mutate 不 fallback dual', async ({
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
      s1: tt.querySelector('.s1'),
      s1Text: tt.querySelector('.s1').firstChild,
      s2: tt.querySelector('.s2'),
      emoji1: tt.querySelector('.emoji-1'),
      emoji5: tt.querySelector('.emoji-5'),
    };
  }, TARGET_SELECTOR);

  // 模擬 LLM Gemini serializer + 翻譯
  const injectResult = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeWithPlaceholders(el);
      // fake Gemini 翻譯:把每段 SPAN 內 text 翻成中文,paired marker 保留
      let fake = sourceText
        .replace('The more I use the Apple Vision Pro, the more it genuinely feels like technology from the future.',
                 '我越是使用 Apple Vision Pro,就越覺得這簡直是來自未來的科技。')
        .replace('Spatial computing used to be something we only dreamed about', '空間運算曾幾何時僅存在於我們的夢想中')
        .replace('Giant floating displays anywhere you want', '隨處可見的巨大懸浮螢幕')
        .replace('Immersive environments that completely transform a space', '能徹底重塑空間感的沉浸式環境')
        .replace('Eye tracking plus gestures still feels like magic', '眼球追蹤加手勢操作簡直神到不行')
        .replace('Spatial photos and videos that make you feel like you are reliving the memory in real life',
                 '空間照片與影片,讓人感覺像是在現實生活中重溫記憶');
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, fake, slots);
      return {
        slotCount: slots.length,
        slotKinds: slots.map(s => s.atomic ? 'atomic' : (s.reuseNode ? 'reuse' : 'paired')),
      };
    })()
  `);

  // LLM serializer 對 6 個 SPAN 走 paired marker,IMG 透明 → 6 slot
  expect(injectResult.slotCount, '6 SPAN paired marker slot(IMG 透明)').toBe(6);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const s1 = tt.querySelector('.s1');
    const s2 = tt.querySelector('.s2');
    const emoji1 = tt.querySelector('.emoji-1');
    const emoji5 = tt.querySelector('.emoji-5');
    const p = window.__probeBefore;
    return {
      tt_sameRef: tt === p.tt,
      s1Text_value: s1?.firstChild?.nodeValue || '',
      s2_text: s2?.textContent || '',
      emoji1_sameRef: emoji1 === p.emoji1,
      emoji5_sameRef: emoji5 === p.emoji5,
      emojiCount: tt.querySelectorAll('img').length,
      tt_has_nodeValueMutated: tt.hasAttribute('data-shinkansen-nodevalue-mutated'),
      tt_has_dualSource: tt.hasAttribute('data-shinkansen-dual-source'),
      wrapper_present: !!document.querySelector('shinkansen-translation'),
      ttText: tt.textContent || '',
    };
  }, TARGET_SELECTOR);

  expect(result.tt_sameRef, 'tweet element ref 保留').toBe(true);
  expect(result.s1Text_value, '主文翻譯成中文').toContain('Apple Vision Pro');
  expect(result.s1Text_value, '主文含「越是使用」').toContain('越是使用');
  expect(result.s2_text, 's2 翻譯').toContain('空間運算');
  expect(result.emoji1_sameRef, 'emoji-1 IMG ref 保留').toBe(true);
  expect(result.emoji5_sameRef, 'emoji-5 IMG ref 保留').toBe(true);
  expect(result.emojiCount, '5 個 IMG 全在 source DOM').toBe(5);
  expect(result.tt_has_nodeValueMutated, '走 Layer A3 nodeValue mutate path(不 dual)').toBe(true);
  expect(result.tt_has_dualSource, '不應 fallback dual sibling').toBe(false);
  expect(result.wrapper_present, '不應產生 SHINKANSEN-TRANSLATION sibling wrapper').toBe(false);
  // 各段 prose 都被翻譯
  expect(result.ttText, '隨處可見的巨大懸浮螢幕').toContain('隨處可見的巨大懸浮螢幕');
  expect(result.ttText, '能徹底重塑空間感的沉浸式環境').toContain('能徹底重塑空間感的沉浸式環境');
  expect(result.ttText, '眼球追蹤').toContain('眼球追蹤');
  expect(result.ttText, '空間照片').toContain('空間照片');

  await page.close();
});
