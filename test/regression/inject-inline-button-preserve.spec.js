// Regression: inline-button-preserve(對應「Medium 留言『more』展開按鈕翻譯後失去連結 / 樣式」bug)
//
// Fixture: test/regression/fixtures/inline-button-preserve.html
// 結構特徵(通用,不綁站名):
//   <p>...Could… <button class="...">more</button></p>
//   (Medium 留言截斷 preview、X / 論壇 read-more、SPA framework client-side 展開 trigger)
//
// 修法前的 bug:
//   content-ns.js 把 BUTTON 列為 HARD_EXCLUDE_TAGS,content-serialize.js 兩個 serializer
//   都先檢查 HARD_EXCLUDE_TAGS 就 continue,inline <button> 整顆被丟掉:
//     - serializer 輸出 text 缺少 <button> 對應 placeholder
//     - slots 不包含 <button>
//     - Gemini 拿不到 button 文字 → 譯文回來沒對應配對標記能還原
//     - 注入後 DOM 內 <button> 完全消失,class 帶 underline / hover affordance 跟著沒了
//
// 修法:
//   1. content-ns.js PRESERVE_INLINE_TAGS 加 BUTTON;hasPreservableInline 對 inline
//      BUTTON 加例外(同 inline CODE)
//   2. serializeNodeIterable + serializeNodeIterableForGoogle 在 HARD_EXCLUDE 檢查前
//      先處理 inline <button>(hasSubstantiveContent 確認含 text)→ paired placeholder
//      ⟦N⟧content⟦/N⟧,slot 存 cloneNode(false) 殼。Walker 入口的 HARD_EXCLUDE 仍擋
//      以 button 為主的 widget 不變,inline 路徑單獨開洞。
//
// 斷言基於結構特徵(段落內 inline element 必須跨翻譯保留),不綁站點/class,符合 §6 / §8。
//
// SANITY 紀錄(已驗證 2026-05-14):
//   1. content-ns.js PRESERVE_INLINE_TAGS 拿掉 BUTTON → hasPreservableInline 對只含
//      <button> 子的 <p> 回 false → translateUnits 走 el.innerText 純文字早返回路徑,
//      serializer 完全沒呼叫 → spec fail
//   2. 還原 PRESERVE_INLINE_TAGS 但 serialize walker 對 BUTTON 例外拿掉 → BUTTON 被
//      HARD_EXCLUDE 跳過,serialize 輸出無 ⟦N⟧/⟦/N⟧ 標記、slots.length === 0 → spec fail
//   3. 還原兩層 → ⟦N⟧/⟦/N⟧ 配對標記出現、slots.length === 1、注入後 <button> 仍在
//      DOM + class 保留 + 內文翻成中文 → pass
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'inline-button-preserve';
const TARGET_SELECTOR = 'p#with-button';

test('inline-button-preserve: 序列化必須把 inline <button> 保成 paired slot', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const originalButton = el.querySelector('button');
      const { text, slots } = window.__shinkansen.serialize(el);
      return JSON.stringify({
        text,
        slotCount: slots.length,
        // reuseNode 結構 {reuseNode, node}:從 node.tagName 取;atomic 從 node.tagName;
        // 純 element shell 從 s.tagName 取。
        slotTags: slots.map((s) => {
          if (!s) return 'null';
          if (s.reuseNode && s.node) return s.node.tagName;
          if (s.atomic && s.node) return s.node.tagName;
          return s.tagName || 'unknown';
        }),
        // 鎖死 React fiber preservation:button slot 必須是 reuseNode + 原 node reference,
        // 不是 cloneNode 出來的新 node。slot.node === 原 DOM 中的 button(同 object identity)。
        buttonSlotIsOriginal: slots.some(
          (s) => s && s.reuseNode && s.node === originalButton,
        ),
      });
    })()
  `);
  const parsed = JSON.parse(result);

  // 斷言 1: text 含配對標記 ⟦N⟧ 與 ⟦/N⟧,代表 <button> 被當成 paired slot
  expect(
    /⟦\d+⟧/.test(parsed.text) && /⟦\/\d+⟧/.test(parsed.text),
    `serialize 輸出應含配對標記 ⟦N⟧/⟦/N⟧,實際 text="${parsed.text}"`,
  ).toBe(true);

  // 斷言 2: slot 數量 = 1(fixture 內 <button> 一個)
  expect(parsed.slotCount, `應有 1 個 slot,實際 ${parsed.slotCount}`).toBe(1);

  // 斷言 3: slot tag 是 BUTTON
  expect(parsed.slotTags).toContain('BUTTON');

  // 斷言 4(v1.9.17 React fiber preservation):button slot 必須持有「原 DOM button
  // node reference」(reuseNode 機制),不是 cloneNode 出來的新 node。若改成 cloneNode,
  // React 私有 key(__reactFiber$ / __reactProps$)會丟失,onClick handler 透過 root
  // delegation 找不到 → 點擊不展開留言。
  expect(
    parsed.buttonSlotIsOriginal,
    'button slot 必須是 reuseNode + 原 DOM node reference(slot.node === 原 button object),' +
      '否則 React fiber 丟失,點擊 button 不會展開',
  ).toBe(true);

  await page.close();
});

test('inline-button-preserve: hasPreservableInline 必須對只含 <button> 的 <p> 回 true(否則生產路徑早返回純文字,跳過 serializer)', async ({
  context,
  localServer,
}) => {
  // 為什麼這條斷言獨立存在(同 inline-code-preserve 第二條 spec 邏輯):
  // translateUnits 在呼叫 serialize 之前會先做 hasPreservableInline 短路檢查,
  // 只含 <button> 的 <p> 若回 false 整顆 element 走 el.innerText.trim() + slots:[]
  // 純文字路徑,前一條 spec(直接呼叫 serialize)偵測不到。必須兩層斷言才能鎖死真實生產路徑。
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const hasInline = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      return window.__SK.hasPreservableInline(el);
    })()
  `);

  expect(
    hasInline,
    'hasPreservableInline 對只含 <button> 子元素的 <p> 必須回 true(否則 translateUnits 早返回純文字 → serializer 完全沒被呼叫到)',
  ).toBe(true);

  await page.close();
});

test('inline-button-preserve: 注入譯文後 <button> 元素 + class 必須保留,內文翻成中文,並維持原 DOM node identity(React fiber)', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 在 inject 前抓原 button reference + 在 button 上掛一個 marker key
  // (模擬 React 私有 __reactFiber$ key 的位置)。inject 後若 marker 還在表示 node identity 保留。
  await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const btn = el.querySelector('button');
      btn.__shinkansenIdentityMarker = 'original-node-marker-v1.9.17';
      window.__SK_test_originalButton = btn;
    })()
  `);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);

  const after = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const btn = el.querySelector('button');
      return JSON.stringify({
        outerHTML: el.outerHTML,
        buttonExists: !!btn,
        buttonClass: btn ? btn.getAttribute('class') : null,
        buttonText: btn ? btn.textContent : null,
        // 鎖死 reuseNode 行為:inject 後 button 必須是原 DOM node,marker 與 reference 都還在。
        // 若退化成 cloneNode,marker 不會 propagate 到新 node,reference 不相等。
        markerStillPresent: btn ? btn.__shinkansenIdentityMarker === 'original-node-marker-v1.9.17' : false,
        sameReference: btn === window.__SK_test_originalButton,
      });
    })()
  `);
  const parsed = JSON.parse(after);

  // 斷言 1: 注入後 DOM 仍有 <button> 元素
  expect(parsed.buttonExists, `注入後 <button> 應存在,outerHTML=${parsed.outerHTML}`).toBe(true);

  // 斷言 2: button 的 class 必須保留(原 fixture 是 "medium-more eb ab ac fh")
  expect(parsed.buttonClass).toContain('medium-more');
  expect(parsed.buttonClass).toContain('eb');

  // 斷言 3: button 內文已翻成中文(「more」→「更多」)
  expect(parsed.buttonText).toContain('更多');

  // 斷言 4: 段落本體也已翻成中文(「Could…」→「或許…」,控制組:inline preserve 不影響整段翻譯)
  expect(parsed.outerHTML).toContain('或許');

  // 斷言 5(v1.9.17 React fiber preservation):注入後 button 必須是 *原 DOM node*
  // (object identity 相同),而非 cloneNode 出來的新 node。模擬 React fiber 透過
  // private key 綁在 node 上的真實 case — marker key 與 reference 都必須保留。
  expect(
    parsed.markerStillPresent,
    'inject 後 button 上的 identity marker 必須保留 — 表示 reuseNode 機制 work,' +
      '原 node 被 detach + re-attach 而非 cloneNode 出新 node。若 fail,React fiber 同樣會丟失,' +
      'button click 透過 root delegation 找不到 onClick → 點擊不展開留言。',
  ).toBe(true);
  expect(
    parsed.sameReference,
    'inject 後 button reference 必須等於原 button(object identity)',
  ).toBe(true);

  await page.close();
});
