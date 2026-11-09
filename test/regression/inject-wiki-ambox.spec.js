// Regression: wiki-ambox-maintenance-warning (對應 v0.51–v0.54 三輪修錯後 v0.54 的真正通則)
//
// Fixture: test/regression/fixtures/wiki-ambox.html
// 結構: <div>...<b>large language model</b>... <b>Please <small>(<a>help improve it</a>)</small></b> ...</div>
//
// 結構特徵 (這才是要鎖死的通則,不是 .ambox class 名):
//   段落內含「巢狀 preservable inline」—— 外層 <b>、中層 <small>、內層 <a>
//   互相包覆。序列化會產生巢狀 slot:
//     ⟦1⟧Please ⟦2⟧(⟦3⟧help improve it⟦/3⟧)⟦/2⟧⟦/1⟧
//   反序列化必須遞迴重建 fragment,把每一層 element 殼 clone 回去。
//
// v0.51–v0.53 都用「Wikipedia 特判 / dedup edge case」想矇過,沒回頭審視
// 通用 inject 路徑。v0.54 的真正修法:replaceNodeInPlace 的 fragment 由
// slots 重建、整段覆蓋,不再做任何 site / class 特判。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'wiki-ambox';
const TARGET_SELECTOR = 'div#target';

test('wiki-ambox-maintenance-warning: 巢狀 preservable inline (B>SMALL>A) 必須遞迴重建', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 斷言 a: 序列化結果應有 4 個 slot (B, B, SMALL, A),且 text 含巢狀佔位符
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const { text, slots } = window.__shinkansen.serialize(el);
      return { text, slotCount: slots.length, slotTags: slots.map(s => s && s.tagName) };
    })())
  `);
  const { text: sourceText, slotCount, slotTags } = JSON.parse(serialized);
  expect(slotCount).toBe(4);
  expect(slotTags).toEqual(['B', 'B', 'SMALL', 'A']);
  // 巢狀結構特徵:⟦1⟧ 內含 ⟦2⟧,⟦2⟧ 內含 ⟦3⟧
  expect(sourceText).toMatch(/⟦1⟧[^⟦]*⟦2⟧[^⟦]*⟦3⟧[^⟦]*⟦\/3⟧[^⟦]*⟦\/2⟧[^⟦]*⟦\/1⟧/);

  // 跑 testInject
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  expect(injectResult.slotCount).toBe(4);

  // 斷言 b: 注入後 DOM 結構對應 slot 巢狀
  const after = await page.evaluate((sel) => {
    const div = document.querySelector(sel);
    if (!div) return null;
    const bs = Array.from(div.querySelectorAll('b'));
    const smalls = Array.from(div.querySelectorAll('small'));
    const anchors = Array.from(div.querySelectorAll('a'));
    // 找出包了 small 的 b (應該是第二個 <b>,即原本的 "Please ..." 整段)
    const bWithSmall = bs.find((b) => b.querySelector('small'));
    const smallInB = bWithSmall ? bWithSmall.querySelector('small') : null;
    const aInSmall = smallInB ? smallInB.querySelector('a') : null;
    // 第一個 <b> (大型語言模型) 應該不含 small
    const bWithoutSmall = bs.find((b) => !b.querySelector('small'));
    return {
      divText: div.textContent,
      bCount: bs.length,
      smallCount: smalls.length,
      anchorCount: anchors.length,
      bWithSmallText: bWithSmall ? bWithSmall.textContent : null,
      bWithoutSmallText: bWithoutSmall ? bWithoutSmall.textContent : null,
      smallText: smallInB ? smallInB.textContent : null,
      anchorText: aInSmall ? aInSmall.textContent : null,
      anchorHref: aInSmall ? aInSmall.getAttribute('href') : null,
      smallParentTag: smallInB ? smallInB.parentElement.tagName : null,
      anchorParentTag: aInSmall ? aInSmall.parentElement.tagName : null,
    };
  }, TARGET_SELECTOR);

  expect(after, 'div#target 應該存在').not.toBeNull();

  // 結構斷言:三層元素殼都還在,層次正確
  expect(after.bCount).toBe(2);
  expect(after.smallCount).toBe(1);
  expect(after.anchorCount).toBe(1);
  // SMALL 的父層必須是 B (而不是 div / 平鋪)
  expect(after.smallParentTag).toBe('B');
  // A 的父層必須是 SMALL
  expect(after.anchorParentTag).toBe('SMALL');

  // 譯文斷言:每層的譯文就位
  expect(after.bWithoutSmallText).toBe('大型語言模型');
  expect(after.anchorText).toBe('協助改進');
  expect(after.anchorHref).toBe('https://example.com/help');
  // SMALL 內含 (協助改進) 三個字
  expect(after.smallText).toBe('(協助改進)');
  // 包 small 的 b 應含「請」前綴 + (協助改進)
  expect(after.bWithSmallText.startsWith('請')).toBe(true);
  expect(after.bWithSmallText.includes('(協助改進)')).toBe(true);

  // div 整段譯文文字應含開頭與結尾
  expect(after.divText.includes('本文可能包含來自')).toBe(true);
  expect(after.divText.includes('驗證內容並移除任何不當素材')).toBe(true);

  await page.close();
});
