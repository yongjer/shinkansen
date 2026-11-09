// Regression: 非 HTML 文件 gate（對應 v1.10.59 修的
// 「在 RSS/XML feed 上 content-toast.js 第 9 行 toastHost.style.cssText 丟
//   Uncaught TypeError: Cannot set properties of undefined」bug）
//
// Fixture: test/regression/fixtures/non-html-document.xml（以 application/xml 送出，
//   Chrome 解析成 XML 文件；root <rss> 的 namespaceURI 為 null，非 XHTML）
// 結構：被 Chrome 直接渲染的 RSS/Atom/純 XML feed —— document 不是 HTMLDocument，
//   documentElement.namespaceURI !== 'http://www.w3.org/1999/xhtml'
// Bug：XML 文件的 createElement('div') 產出 namespace=null 的通用 Element，沒有
//   .style / attachShadow 等 HTMLElement 能力，content-toast.js 一進門就 throw，
//   整條 content script 中斷。
// 修法：content-ns.js 加 _sk_isNonHtmlDocument() gate（結構性通則：root namespace
//   非 XHTML 即視為非 HTML 文件 → SK.disabled = true），跟 iframe gate 同一層。
//
// SANITY 紀錄（已驗證）：把 content-ns.js 的
//   `else if (_sk_isCurrentFrameDisabled() || _sk_isNonHtmlDocument(document))`
//   改回 `else if (_sk_isCurrentFrameDisabled())`，跑本 spec 第 1 條（pageerror 應為空）
//   會 fail（捕到 "Cannot set properties of undefined (setting 'cssText')"），且
//   disabled 斷言也 fail（SK 完整初始化、disabled=false）；還原後兩條皆 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('non-html-document: RSS/XML feed 上 content script 不 throw 且 SK.disabled', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();

  // 真實路徑驗證的 ground truth：content script 在 XML 文件上拋的是 Uncaught
  // TypeError，會以 pageerror 事件浮出。修好後這裡應該完全沒有錯誤。
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));

  await page.goto(`${localServer.baseUrl}/non-html-document.xml`, {
    waitUntil: 'domcontentloaded',
  });
  // 給 content script 注入 + 執行的時間
  await page.waitForTimeout(800);

  // 斷言 1：沒有任何 uncaught error（尤其 cssText TypeError）
  expect(
    pageErrors,
    `XML 文件上 content script 不應 throw，但捕到：${pageErrors.join(' | ')}`
  ).toEqual([]);

  // 斷言 2：gate 生效 —— SK 是 disabled stub，沒有完整初始化
  // window.__SK 在 content script isolated world，必走 CDP evaluator（main world 看不到）
  const { evaluate } = await getShinkansenEvaluator(page);
  const skState = await evaluate(`(() => ({
    hasSK: !!window.__SK,
    disabled: !!(window.__SK && window.__SK.disabled),
    hasState: !!(window.__SK && window.__SK.STATE),
  }))()`);
  expect(skState.disabled, 'XML 文件上 SK.disabled 應為 true').toBe(true);
  expect(skState.hasState, 'XML 文件上不應建立完整命名空間（無 SK.STATE）').toBe(false);

  await page.close();
});
