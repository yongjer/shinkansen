// Regression: gmail-mjml-body-text (對應 v0.49 修的 MJML font-size:0 內文消失 bug)
//
// Fixture: test/regression/fixtures/gmail-mjml-body.html
// 結構:
//   <td font-size:0>
//     <div font-size:16px>Step 1: Install the Claude Code CLI ...</div>
//   </td>
//
// 內層 <div> 沒有 preservable inline 子元素,序列化後 slots = [],
// 走無 slots 路徑 (replaceTextInPlace → resolveWriteTarget + injectIntoTarget)。
//
// v0.48 的 bug:replaceTextInPlace 直接 `el.textContent = translation`,
// 把 td 的所有 children 清掉 → 內層 <div> 消失 → 譯文直接坐在 td 下
// 繼承 font-size:0 → 整段不可見。
//
// v0.49 (後來 v0.55 重構成共用 helper) 的修法:resolveWriteTarget 偵測到
// el 自己 font-size:0,walker descend 找第一個 font-size 正常的非 slot
// 後代,撞到 inner <div> 16px → 用 inner <div> 當寫入目標,clean slate
// 它的 children 後 append 譯文 → div 留下、字體大小留下、文字正確替換。
//
// 斷言全部基於結構特徵 (CLAUDE.md 硬規則 8):
//   - td 內仍有直接子 <div>
//   - inner <div> 的 computed font-size 不是 0px
//   - inner <div> 的 textContent === 譯文
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'gmail-mjml-body';
const TARGET_SELECTOR = 'td#target';

test('gmail-mjml-body-text: font-size:0 td 注入後內層 wrapper 必須保留', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  expect(translation.length).toBeGreaterThan(0);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  // 注入前 sanity:td 自己 computed font-size 應該是 0px (確認 fixture 真的
  // 觸發了 font-size:0 路徑,不是測試的反向 case)
  const before = await page.evaluate((sel) => {
    const td = document.querySelector(sel);
    const innerDiv = td.querySelector(':scope > div');
    return {
      tdFontSize: getComputedStyle(td).fontSize,
      innerDivExists: !!innerDiv,
      innerDivFontSize: innerDiv ? getComputedStyle(innerDiv).fontSize : null,
    };
  }, TARGET_SELECTOR);
  expect(before.tdFontSize).toBe('0px');
  expect(before.innerDivExists).toBe(true);
  expect(before.innerDivFontSize).toBe('16px');

  const { evaluate } = await getShinkansenEvaluator(page);
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  // 純文字內容沒有任何 preservable inline → slot count 0
  expect(injectResult.slotCount).toBe(0);

  // 注入後 DOM 斷言
  const after = await page.evaluate((sel) => {
    const td = document.querySelector(sel);
    if (!td) return null;
    const directDivs = Array.from(td.querySelectorAll(':scope > div'));
    const firstDiv = directDivs[0] || null;
    return {
      directDivCount: directDivs.length,
      firstDivExists: !!firstDiv,
      firstDivFontSize: firstDiv ? getComputedStyle(firstDiv).fontSize : null,
      firstDivText: firstDiv ? firstDiv.textContent.trim() : null,
      tdInnerHTMLPreview: td.innerHTML.replace(/\s+/g, ' ').slice(0, 200),
    };
  }, TARGET_SELECTOR);

  expect(after, 'td#target 應該存在').not.toBeNull();

  // 斷言 1: td 仍有直接子 <div> (沒被 clean-slate 掉)
  // 結構特徵: 注入路徑必須 descend 到 inner wrapper,不能停在 td 自己。
  expect(
    after.directDivCount,
    `td 應有 1 個直接子 <div>,實際 ${after.directDivCount}\nDOM: ${after.tdInnerHTMLPreview}`,
  ).toBe(1);

  // 斷言 2: inner <div> 的 computed font-size 不是 0px (字體大小保留)
  // 這條是 MJML font-size:0 inline-block-gap 技巧的核心:wrapper 必須留下
  // 才能提供真正的字體大小,否則文字會繼承外層 td 的 0px 變不可見。
  expect(
    after.firstDivFontSize,
    `inner <div> font-size 應為 16px,實際 ${after.firstDivFontSize}`,
  ).toBe('16px');

  // 斷言 3: inner <div> 的 textContent === 譯文
  expect(after.firstDivText).toBe(translation);

  await page.close();
});
