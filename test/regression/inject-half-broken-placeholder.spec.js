// Regression: inject-half-broken-placeholder(2026-07-20 修的「輕量模型半殘佔位符
// → inline 連結消失」bug,使用者回報 The Verge Installer 段落 gemini-3.1-flash-lite
// 翻譯後 9 顆連結消失、gemini-3-flash-preview 正常)
//
// Fixture: test/regression/fixtures/inject-half-broken-placeholder.html
// 結構:prose <p> 內嵌 <a><strong><em>…</em></strong><strong>…</strong></a> 三層巢狀
//      連結(序列化成 ⟦0⟧⟦1⟧⟦2⟧…⟦/2⟧⟦/1⟧⟦3⟧…⟦/3⟧⟦/0⟧)+ 第二顆 <a><strong>。
// Bug:輕量模型對高密度巢狀標記常「開了忘記關」(⟦0⟧⟦3⟧ 在、⟦/3⟧⟦/0⟧ 沒輸出)或
//      「關了忘記開」(⟦/3⟧ 在、⟦3⟧ 沒輸出)。半殘 token 被 stripStrayPlaceholderMarkers
//      當 stray 剝掉 → <a>/<strong> 整顆從譯文消失(文字還在、連結不見)。
//      真 API probe(tools/probe-verge-marker-survival.mjs)實測 lite 6/8 輪半殘、
//      preview 0/8;兩種形狀(open 無 close / close 無 open)都真實出現。
// 修法:SK.repairHalfBrokenPlaceholders(content-serialize.js)——確定性補標記:
//      open 無 close → 往後掃(跳過完整子配對)在子句標點 / 外層 close 前補 ⟦/N⟧;
//      close 無 open → 往回掃在最近標記 token / 子句標點後補 ⟦N⟧。只插標記不動文字。
//
// 訊號層界定:本 spec 驗「半殘佔位符譯文 → 注入後連結存活 + 無標記洩漏」這條
//      deserialize 修復不變量(canned 半殘譯文取自真 API 實測形狀)。不驗「模型多常
//      產生半殘」(那是 LLM 行為層,由 probe 手動量測)。
//
// SANITY 紀錄(已驗證):把 deserializeWithPlaceholders 內
//      「translation = SK.repairHalfBrokenPlaceholders(translation, slots)」註解掉 →
//      A 型連結數 2→1(第一顆 <a> 整顆消失)fail;B 型 a0StrongTexts 2 顆→1 顆
//      (內層 strong shell 遺失)fail;還原後 3/3 pass。對照組不依賴修復層,破壞
//      狀態下照常 pass(它驗的是 no-op 不變量,非 SANITY 判別項)。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-half-broken-placeholder';
const TARGET_SELECTOR = 'p#target';

// 序列化結構(先於各 case 驗證,fixture 改動時這裡會先炸):
//   ⟦0⟧=A ⟦1⟧=STRONG ⟦2⟧=EM ⟦3⟧=STRONG ⟦4⟧=A ⟦5⟧=STRONG
const EXPECTED_SLOT_COUNT = 6;

// A 型(open 無 close):⟦0⟧⟦3⟧ 開了,⟦/3⟧⟦/0⟧ 沒輸出(lite 真實形狀:中文重組把
// 片語拉長後忘記收尾;修復應在「書。」的句號前補 ⟦/3⟧⟦/0⟧)
const BROKEN_TYPE_A =
  '從 ⟦0⟧⟦1⟧⟦2⟧《大西洋月刊》⟦/2⟧⟦/1⟧⟦3⟧ 的夏季書單買了根本讀不完的書。之後看了 ⟦4⟧⟦5⟧Maxinomics⟦/5⟧⟦/4⟧ 的影片。下週再聊。';

// B 型(close 無 open):⟦/3⟧ 在但 ⟦3⟧ 沒輸出(修復應在 ⟦/1⟧ 之後補 ⟦3⟧)
const BROKEN_TYPE_B =
  '從 ⟦0⟧⟦1⟧⟦2⟧《大西洋月刊》⟦/2⟧⟦/1⟧ 的夏季書單⟦/3⟧⟦/0⟧ 買了根本讀不完的書。之後看了 ⟦4⟧⟦5⟧Maxinomics⟦/5⟧⟦/4⟧ 的影片。下週再聊。';

// 對照組:完好配對(修復層必須是 no-op,不得動完好譯文)
const CLEAN =
  '從 ⟦0⟧⟦1⟧⟦2⟧《大西洋月刊》⟦/2⟧⟦/1⟧⟦3⟧ 的夏季書單⟦/3⟧⟦/0⟧ 買了根本讀不完的書。之後看了 ⟦4⟧⟦5⟧Maxinomics⟦/5⟧⟦/4⟧ 的影片。下週再聊。';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  // 前置:序列化結構如預期(slot index 對映 canned 譯文的前提)
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text, slots } = window.__shinkansen.serialize(el);
      return { slotCount: slots.length, text };
    })())
  `);
  const { slotCount, text } = JSON.parse(serialized);
  expect(slotCount, `fixture 序列化 slot 數應為 ${EXPECTED_SLOT_COUNT},實際 ${slotCount}(fixture 或 serializer 變了,canned 譯文 index 需重對)`)
    .toBe(EXPECTED_SLOT_COUNT);
  expect(text).toContain('⟦0⟧⟦1⟧⟦2⟧');
  return { page, evaluate };
}

async function dumpTarget(page) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return {
      text: (el.textContent || '').trim(),
      aCount: el.querySelectorAll('a').length,
      aTexts: [...el.querySelectorAll('a')].map((a) => (a.textContent || '').trim()),
      aHrefs: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      a0StrongTexts: [...(el.querySelector('a')?.querySelectorAll('strong') || [])]
        .map((s) => (s.textContent || '').trim()),
      hasMarkerLeak: /[⟦⟧]/.test(el.textContent || ''),
    };
  }, TARGET_SELECTOR);
}

test('half-broken A 型(open 無 close):連結存活、文字零遺失、無標記洩漏', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer);
  await runTestInject(evaluate, TARGET_SELECTOR, BROKEN_TYPE_A);
  const d = await dumpTarget(page);

  // 核心:兩顆 <a> 都活著(修復前:0 和 3 半殘 → 第一顆 <a> 整顆消失)
  expect(d.aCount, `連結應存活 2 顆,實際 ${d.aCount}(${JSON.stringify(d.aTexts)})`).toBe(2);
  expect(d.aHrefs[0]).toBe('https://links.example/reading-list');
  expect(d.aTexts[0]).toContain('《大西洋月刊》');
  expect(d.aTexts[1]).toBe('Maxinomics');
  // 文字零遺失(修復只插標記不動文字)
  expect(d.text).toContain('的夏季書單買了根本讀不完的書');
  expect(d.text).toContain('下週再聊');
  expect(d.hasMarkerLeak).toBe(false);
  // 修復退化上限:連結範圍最多到子句標點,句號後的文字不得被包進連結
  expect(d.aTexts[0]).not.toContain('之後看了');
  await page.close();
});

test('half-broken B 型(close 無 open):open 補在前一標記後,巢狀內文完整', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer);
  await runTestInject(evaluate, TARGET_SELECTOR, BROKEN_TYPE_B);
  const d = await dumpTarget(page);

  expect(d.aCount, `連結應存活 2 顆,實際 ${d.aCount}(${JSON.stringify(d.aTexts)})`).toBe(2);
  // B 型可精準還原:⟦3⟧ 補在 ⟦/1⟧ 後 → <a> 內文 =《大西洋月刊》+ 的夏季書單
  expect(d.aTexts[0]).toBe('《大西洋月刊》的夏季書單');
  expect(d.aHrefs[0]).toBe('https://links.example/reading-list');
  // 關鍵判別:內層 <strong>(slot 3)shell 必須被還原——外層 ⟦0⟧ 配對完好時,
  // 沒修復也能保住 <a>,遺失的是這顆 <strong>(的夏季書單失去粗體)
  expect(d.a0StrongTexts, `a[0] 內 strong 應 2 顆,實際 ${JSON.stringify(d.a0StrongTexts)}`)
    .toEqual(['《大西洋月刊》', '的夏季書單']);
  expect(d.text).toContain('買了根本讀不完的書');
  expect(d.hasMarkerLeak).toBe(false);
  await page.close();
});

test('對照組:完好配對譯文不受修復層影響', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer);
  // repairHalfBrokenPlaceholders 對完好輸入必須是 no-op
  const repaired = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { slots } = window.__shinkansen.serialize(el);
      return window.__SK.repairHalfBrokenPlaceholders(${JSON.stringify(CLEAN)}, slots);
    })()
  `);
  expect(repaired).toBe(CLEAN);

  await runTestInject(evaluate, TARGET_SELECTOR, CLEAN);
  const d = await dumpTarget(page);
  expect(d.aCount).toBe(2);
  expect(d.aTexts[0]).toBe('《大西洋月刊》的夏季書單');
  expect(d.hasMarkerLeak).toBe(false);
  await page.close();
});
