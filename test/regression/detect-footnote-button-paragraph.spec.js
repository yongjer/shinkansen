// Regression: detect-footnote-button-paragraph(2026-07-09,dev tail 2.0.9.1 修)
//
// Fixture: test/regression/fixtures/detect-footnote-button-paragraph.html
// 結構：prose P(直接文字 >= 100 字)內嵌 bigfoot.js 形狀註腳鈕(div 容器 > 零文字
//   button > svg)+ 對照組卡片式 widget(直接文字趨近 0,LI > spans + Follow button)。
// Bug:bigfoot.js 類註腳 lib 把 <sup><a rel="footnote"> 改造成 <button> 塞進 <p>,
//   isInteractiveWidgetContainer 看到 button 就把整段 P 當互動 widget FILTER_SKIP,
//   段落一個字都不翻(leancrew 真實站點回報 + probe 重現；整頁可見文字 >= 300 的既有
//   逃生口對單一段落搆不到)。
// 修法(結構性通則 §8):widget 容器(工具列 / 卡片 / nav)的文字都住在子元素裡，
//   直接 text node 幾乎為空；prose 段落的正文就是 el 自己的直接 text node。
//   isInteractiveWidgetContainer 加「directTextLength(el) >= 100 → 非 widget」逃生口。
//
// 本 spec 鎖的訊號層：驗偵測端「prose+按鈕段落被收、卡片 widget 仍跳」。注入端按鈕
//   保留另由 inject-icon-button-preserve.spec.js 鎖。
//
// SANITY 紀錄(已驗證，2026-07-09)：把 isInteractiveWidgetContainer 的
//   `if (directTextLength(el) >= 100) return false;` 拿掉 → 「prose-p 必須被收」
//   斷言 fail(interactiveWidget=2、prose-p 不在 units)。還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-footnote-button-paragraph';

test('detect-footnote-button-paragraph: 內嵌註腳鈕的 prose 段落被收，卡片 widget 照舊跳過', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`
    (() => {
      const stats = {};
      const units = window.__SK.collectParagraphs(document.body, stats);
      const proseP = document.getElementById('prose-p');
      const widget = document.getElementById('widget-card');
      return {
        // 前置：按鈕真的在 P 內(防 HTML parser 把 div 拆出 p 的空洞綠燈)
        buttonInsideP: !!proseP.querySelector('button.fn-btn'),
        proseCollected: units.some(u => u.kind === 'element' && u.el === proseP),
        widgetTouched: units.some(u =>
          u.kind === 'element' ? widget.contains(u.el) : !!(u.startNode && widget.contains(u.startNode))),
        interactiveWidget: stats.interactiveWidget || 0,
        stats,
      };
    })()
  `);

  const ctx = `stats: ${JSON.stringify(result.stats)}`;
  // 前置：fixture 的按鈕必須真的在 P 內(HTML parser 會拆靜態 <p><div>,fixture 走
  // script 動態插入；這條 fail 表示 fixture 結構壞了，其他斷言都是空洞綠燈)
  expect(result.buttonInsideP, 'fixture 前置：註腳鈕必須在 P 內').toBe(true);
  // 核心：prose 段落(直接文字 >= 100)不得因內嵌註腳鈕被 widget skip
  expect(result.proseCollected, `內嵌註腳鈕的 prose P 必須整段收進候選\n${ctx}`).toBe(true);
  // 對照組：卡片 widget(直接文字 ~0)維持跳過，逃生口不得誤傷 v0.39 行為
  expect(result.widgetTouched, `卡片式 widget 必須維持跳過\n${ctx}`).toBe(false);
  expect(result.interactiveWidget, `widget 計數應只含卡片(prose P 不再誤計)\n${ctx}`).toBeGreaterThanOrEqual(1);

  await page.close();
});
