// Regression: dual-inline-button-preserved（對應 code review 2026-07-08 R3(a),dev tail 2.0.7.1 修）
//
// Fixture: test/regression/fixtures/dual-inline-button-preserved.html
// 結構：段落內 inline <button>（serialize 端走 reuseNode slot 保留 React fiber）。
// Bug:deserializeWithPlaceholders 的 reuseNode 分支「直接搬原 DOM node」，
//     只有標準 single 注入（frag 注回同一 el）可安全 reuse;dual 重建 / echo 比對 /
//     A3 探測這些「frag 不注回原 el」的呼叫點沿用同一路徑，把活的原按鈕 detach 走：
//     - dual：原按鈕被搬進 <shinkansen-translation> wrapper，原段落失去互動按鈕
//     - echo skip：按鈕被搬進用完即丟的比對 frag，從頁面永久消失
// 修法：deserializeWithPlaceholders 加 opts.cloneReuse——非注回原 el 的用途傳 true,
//     reuseNode slot 改 cloneNode(false) 殼重建，不動原 node。
//     （content-inject.js 三個呼叫點傳入；content-serialize.js 實作 clone 分支）
//
// 本 spec 鎖的訊號層：驗「dual 注入 / echo skip 後原段落 BUTTON 仍在原位」的 DOM
//   結構。不驗 clone 按鈕的 React fiber 點擊行為（fixture 無框架；single 路徑的
//   reuse 保 fiber 行為維持原設計，不在本 spec 範圍）。
//
// SANITY 紀錄（已驗證，2026-07-08，兩輪破壞）:
//   1. content-serialize.js parseSegment 的 cloneReuse 分支改 `if (false)`（強制走舊
//      reuse 分支）→ Case 1「原段落應仍含原按鈕」fail。
//   2. 只拿掉 content-inject.js echo 比對呼叫點的 `{ cloneReuse: true }` →
//      Case 1 與 Case 2 各自獨立 fail（dual 注入也先過 echo 比對，共用該呼叫點）。
//   還原後兩 case 皆 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'dual-inline-button-preserved';

test('dual-inline-button-preserved Case 1: dual 注入後原段落 BUTTON 不被搬走', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // dual 正常注入（譯文 != 原文）
  const case1 = await evaluate(`
    (() => {
      const el = document.querySelector('#target-1');
      const btn = document.querySelector('#btn-1');
      // serialize 會產生 ⟦0⟧Show more⟦/0⟧ reuseNode slot；譯文帶同 marker
      const r = window.__shinkansen.testInjectDual(el, '閱讀完整文章⟦0⟧顯示更多⟦/0⟧了解全部細節。');
      const wrapper = el.nextElementSibling && el.nextElementSibling.tagName === 'SHINKANSEN-TRANSLATION'
        ? el.nextElementSibling : null;
      const wrapperBtn = wrapper ? wrapper.querySelector('button') : null;
      return {
        slotCount: r.slotCount,
        wrapperPresent: !!wrapper,
        // 核心：原按鈕（活 node）必須仍在原段落內
        originalBtnInPlace: el.contains(btn),
        originalText: el.textContent,
        // wrapper 內應是 clone（帶譯文文字），且不是原 node
        wrapperBtnText: wrapperBtn ? wrapperBtn.textContent : null,
        wrapperBtnIsOriginal: wrapperBtn === btn,
      };
    })()
  `);

  expect(case1.slotCount, 'Case 1: BUTTON 應產生 1 個 slot').toBe(1);
  expect(case1.wrapperPresent, 'Case 1: dual wrapper 應建立').toBe(true);
  expect(
    case1.originalBtnInPlace,
    `Case 1: 原段落應仍含原按鈕（dual 不動原文的前提）\noriginalText: ${case1.originalText}`,
  ).toBe(true);
  expect(case1.originalText, 'Case 1: 原段落文字應未被動').toContain('Show more');
  expect(case1.wrapperBtnText, 'Case 1: wrapper 內 clone 按鈕應帶譯文').toBe('顯示更多');
  expect(case1.wrapperBtnIsOriginal, 'Case 1: wrapper 內按鈕應是 clone 而非原 node').toBe(false);

  await page.close();
});

test('dual-inline-button-preserved Case 2: echo skip 不吃掉原按鈕', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // echo skip（譯文 == 原文，LLM 照搬）
  const case2 = await evaluate(`
    (() => {
      const el = document.querySelector('#target-2');
      const btn = document.querySelector('#btn-2');
      // 先取 serialize 原文（含 slot marker），原樣當「LLM 照搬」譯文送入 → echo 比對命中
      const { text } = window.__SK.serializeWithPlaceholders(el);
      const r = window.__shinkansen.testInjectDual(el, text);
      const wrapper = el.nextElementSibling && el.nextElementSibling.tagName === 'SHINKANSEN-TRANSLATION'
        ? el.nextElementSibling : null;
      return {
        sourceText: text,
        wrapperPresent: !!wrapper,
        wrapperCached: r.wrapperPresent,
        // 核心：echo 比對的 throwaway frag 不可把原按鈕 detach 走
        originalBtnInPlace: el.contains(btn),
        btnConnected: btn.isConnected,
        echoMarked: el.getAttribute('data-shinkansen-dual-source') === '1',
      };
    })()
  `);

  expect(case2.echoMarked, 'Case 2: echo 應命中（標 dual-source 後 skip）').toBe(true);
  expect(case2.wrapperPresent, 'Case 2: echo skip 不應建 wrapper').toBe(false);
  expect(
    case2.originalBtnInPlace,
    `Case 2: echo skip 後原按鈕應仍在原段落（不可被比對 frag 吃掉）\nbtnConnected: ${case2.btnConnected}`,
  ).toBe(true);
  expect(case2.btnConnected, 'Case 2: 原按鈕應仍連在 document 上').toBe(true);

  await page.close();
});
