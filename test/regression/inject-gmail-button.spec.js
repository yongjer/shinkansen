// Regression: gmail-button-nested-a (對應 v0.55–v0.58 連續修的 Gmail 按鈕 bug)
//
// Fixture: test/regression/fixtures/gmail-button.html
// 結構特徵:
//   <td font-size:0>
//     <a font-size:18px style="display:inline-block;width:95px;padding:8px 35px">
//       <span>Learn more</span>  <!-- 沒有 class、沒有 style → 不是 preservable -->
//     </a>
//   </td>
//
// Canned LLM 回應: ⟦0⟧深入瞭解⟦/0⟧
//
// v0.58 之前的 bug: resolveWriteTarget 走進 td 後因為 td font-size:0 進入
// descent 路徑找「第一個 font-size 正常的非 slot 元素」,v0.56/v0.57 用
// FILTER_SKIP 跳過 slot <a> 自己但繼續往下走,撞到 SPAN (font-size 18px
// 從 <a> 繼承而來) 把 SPAN 當寫入目標,clean-slate SPAN 後 append 從 slot 0
// 重建的另一個 <a> shell → <td><a><span><a>譯文</a></span></a></td> 雙層巢狀,
// padding/width 雙層套用,按鈕往右凸出 35px。
//
// v0.58 改用 FILTER_REJECT 拒絕整個 slot subtree,強迫 fall through 到 td
// 自己,clean slate td 後 append 單一 <a>,結構正確。
//
// 本測試的斷言全部是「結構特徵」(td 直接子元素數、anchor 數、無巢狀、寬度
// 差),不綁站點 / class name,符合 CLAUDE.md 硬規則 8。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'gmail-button';
const TARGET_SELECTOR = 'td#target';

test('gmail-button-nested-a: TD>A>SPAN 注入後不可形成 <a><a/></a> 雙層巢狀', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  expect(translation).toBe('⟦0⟧深入瞭解⟦/0⟧');

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  // 量測注入前 outer <a> 的寬度,作為「按鈕沒被撐大」斷言的基準
  const beforeWidth = await page.evaluate((sel) => {
    const a = document.querySelector(sel + ' > a');
    return a ? a.getBoundingClientRect().width : null;
  }, TARGET_SELECTOR);
  expect(beforeWidth).not.toBeNull();
  expect(beforeWidth).toBeGreaterThan(0);

  const { evaluate } = await getShinkansenEvaluator(page);

  // 確認跑的是 v0.59+ (testInject 是 v0.59 才有的 API)
  const apiVersion = await evaluate('window.__shinkansen.version');
  expect(apiVersion).toBeTruthy();
  const hasTestInject = await evaluate('typeof window.__shinkansen.testInject === "function"');
  expect(hasTestInject).toBe(true);

  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  // 序列化階段應該抽出 1 個 slot (outer <a>)
  expect(injectResult.slotCount).toBe(1);

  // 注入後 DOM 結構斷言 (在 page main world 跑就行,不需要 isolated world)
  const after = await page.evaluate((sel) => {
    const td = document.querySelector(sel);
    if (!td) return null;
    const directChildElements = Array.from(td.children);
    const allAnchors = td.querySelectorAll('a');
    const onlyAnchor = allAnchors[0] || null;
    return {
      directChildElementCount: directChildElements.length,
      anchorCount: allAnchors.length,
      anchorText: onlyAnchor ? onlyAnchor.textContent.trim() : null,
      anchorWidth: onlyAnchor ? onlyAnchor.getBoundingClientRect().width : null,
      anchorHasNestedAnchor: onlyAnchor ? onlyAnchor.querySelectorAll('a').length > 0 : false,
      tdInnerHTMLPreview: td.innerHTML.replace(/\s+/g, ' ').slice(0, 200),
    };
  }, TARGET_SELECTOR);

  expect(after, 'td#target 應該存在').not.toBeNull();

  // 斷言 1: TD 的直接子元素 count = 1
  // 結構特徵: 整段覆蓋後 td 只該有一個直接子元素 (新的 <a> shell)。
  expect(
    after.directChildElementCount,
    `td 直接子元素應為 1,實際 ${after.directChildElementCount}\nDOM: ${after.tdInnerHTMLPreview}`,
  ).toBe(1);

  // 斷言 2: TD 底下 querySelectorAll('a').length === 1 (絕對禁止巢狀 <a>)
  // 這條是 v0.55–v0.58 連踩三次的核心 bug 訊號。
  expect(
    after.anchorCount,
    `td 底下 <a> 總數應為 1,實際 ${after.anchorCount}\nDOM: ${after.tdInnerHTMLPreview}`,
  ).toBe(1);

  // 斷言 3: 唯一 <a> 的文字為譯文
  expect(after.anchorText).toBe('深入瞭解');

  // 斷言 4: <a> 寬度與注入前差異 < 2px (按鈕沒被 padding/width 雙層套用撐大)
  // v0.58 bug 的視覺症狀就是按鈕從 165px 變成 235px (多出 70px = 2 倍 35px padding)。
  expect(
    Math.abs(after.anchorWidth - beforeWidth),
    `按鈕寬度應與注入前差異 < 2px,實際 before=${beforeWidth} after=${after.anchorWidth}`,
  ).toBeLessThan(2);

  // 斷言 5: 唯一 <a> 內部不可再含 <a> (與斷言 2 互為冗餘檢查,文字描述不同
  // 角度的同一個結構規則,留著當第二道防線)
  expect(after.anchorHasNestedAnchor).toBe(false);

  await page.close();
});
