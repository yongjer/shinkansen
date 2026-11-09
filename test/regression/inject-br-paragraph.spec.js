// Regression: wiki-br-as-paragraph (對應 v0.50/v0.51 修的 <br><br> 段落分隔流程)
//
// Fixture: test/regression/fixtures/br-paragraph.html
// 結構: <div>段 1<br><br>段 2<br><br>段 3</div>,沒有 preservable inline。
//
// 這條測試同時驗證 serializer 與 injector 兩端:
//   a. serializer 必須把 <br> 留成 \n (而不是被 /\s+/g normalize 吃成 space)
//   b. injector 收到含 \n 的譯文時,必須走 buildFragmentFromTextWithBr
//      把 \n 反向還原成真正的 <br> 元素
//
// v0.49 之前的 bug:serialize 把 BR 隱含的換行用 /\s+/g 收成單一 space →
// LLM 收到一行文字 → 譯文也是一行 → 三段擠成一坨。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'br-paragraph';
const TARGET_SELECTOR = 'div#target';

test('wiki-br-as-paragraph: <br><br> 段落分隔在 serialize/inject 兩端都要正確還原', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  // 確認 fixture response 真的含 \n\n (兩段分隔)
  expect(translation.split('\n\n').length).toBe(3);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 斷言 a: serializer 必須產出含 \n 的 text
  // 結構特徵:BR 不該被 /\s+/g 收成 space,sentinel + 兩階段 normalize
  // 必須讓 \n 留下來。
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const { text, slots } = window.__shinkansen.serialize(el);
      return { text, slotCount: slots.length };
    })())
  `);
  const { text: sourceText, slotCount } = JSON.parse(serialized);
  expect(slotCount).toBe(0);
  expect(
    sourceText.includes('\n'),
    `序列化後的 text 應含 \\n (BR sentinel),實際: ${JSON.stringify(sourceText)}`,
  ).toBe(true);
  // 應有兩段 \n 分隔 (3 段內容)
  expect(sourceText.split('\n').filter(s => s.trim()).length).toBe(3);

  // 跑 testInject
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  expect(injectResult.slotCount).toBe(0);

  // 斷言 b: 注入後 DOM 仍有 <br> 元素 (\n 還原回 <br>)
  const after = await page.evaluate((sel) => {
    const div = document.querySelector(sel);
    if (!div) return null;
    const brs = Array.from(div.querySelectorAll('br'));
    // 蒐集 div 下所有 text node 的內容,維持文件順序
    const textPieces = [];
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (t) textPieces.push(t);
    }
    return {
      brCount: brs.length,
      textPieces,
      divInnerHTMLPreview: div.innerHTML.replace(/\s+/g, ' ').slice(0, 300),
    };
  }, TARGET_SELECTOR);

  expect(after, 'div#target 應該存在').not.toBeNull();

  // 斷言 1: <br> 數量 > 0 (核心:\n 真的還原成 <br> 而不是被當文字)
  expect(
    after.brCount,
    `div 內 <br> 數量應 > 0,實際 ${after.brCount}\nDOM: ${after.divInnerHTMLPreview}`,
  ).toBeGreaterThan(0);

  // 斷言 2: 譯文應有三段 (對應原本的 \n\n × 2)
  expect(after.textPieces.length).toBe(3);

  // 斷言 3: 三段譯文順序正確、文字正確
  expect(after.textPieces[0]).toBe('歡迎使用 Claude Code。');
  expect(after.textPieces[1]).toBe('這封信會帶你走過基本的安裝步驟。');
  expect(after.textPieces[2]).toBe('完成之後,你就能在終端機裡開始使用 Claude。');

  await page.close();
});
