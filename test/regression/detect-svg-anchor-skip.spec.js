// Regression: detect-svg-anchor-skip（對應 code review 2026-07-08 R5(a),dev tail 2.0.7.1 修）
//
// Fixture: test/regression/fixtures/detect-svg-anchor-skip.html
// 結構：inline <svg> 內含 <a href><text>…</text></a>(SVGAElement)+ HTML leaf <a> 對照組。
// Bug:leaf-anchor 補抓用 scopeRoot.querySelectorAll('a')，也會匹配 SVG <a>。
//     SVG 元素沒有 innerText，收進 unit 後 translateUnits 序列化 `el.innerText.trim()`
//     直接 TypeError → 整頁翻譯失敗（probe 實測重現）。
// 修法（content-detect.js leaf-anchor 補抓）:`if (!(a instanceof HTMLElement)) return;`
//     ——非 HTML 元素本就不該走 HTML 注入路徑，結構性排除，不綁站點。
//
// 本 spec 鎖的訊號層（CLAUDE.md 工作流原則 §3）:
//   驗「偵測端不把 SVG <a> 收進 units」這一層。content.js 序列化端另有
//   `innerText ?? textContent` 兜底（防其他來源的非 HTML unit），該防禦層本 spec 不驗
//   (translateUnits 的序列化 map 是內部閉包，無法單獨驅動；偵測端擋掉後正常路徑
//   到不了該兜底）。
//
// SANITY 紀錄（已驗證，2026-07-08）：把 content-detect.js leaf-anchor 補抓的
//   `if (!(a instanceof HTMLElement)) return;` 註解掉 → 「SVG <a> 不應進 units」
//   斷言 fail（svgAnchorCollected=true、allUnitsAreHtml=false）。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-svg-anchor-skip';

test('detect-svg-anchor-skip: SVG <a> 不進候選、HTML leaf <a> 照常補抓', async ({
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
      const svgAnchor = document.querySelector('#svg-anchor');
      const htmlAnchor = document.querySelector('#html-anchor');
      return {
        unitCount: units.length,
        svgAnchorCollected: units.some(u => u.el === svgAnchor),
        htmlAnchorCollected: units.some(u => u.el === htmlAnchor),
        // 整體防線：所有 element unit 的 el 必須是 HTMLElement（序列化走 innerText 的前提）
        allUnitsAreHtml: units.every(u =>
          u.kind !== 'element' || (u.el instanceof HTMLElement)
        ),
        leafContentAnchor: stats.leafContentAnchor || 0,
        stats,
      };
    })()
  `);

  // 斷言 1（核心）:SVG <a> 不應進 units
  expect(
    result.svgAnchorCollected,
    `SVG <a> 不應被 leaf-anchor 補抓收進 units\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(false);

  // 斷言 2（整體防線）:element unit 全部是 HTMLElement
  expect(
    result.allUnitsAreHtml,
    '所有 element unit 的 el 應為 HTMLElement（否則序列化 innerText 會 TypeError）',
  ).toBe(true);

  // 斷言 3（對照組，防假綠）:HTML leaf <a> 應照常被補抓 → 證明 leaf-anchor 路徑有跑到
  expect(
    result.htmlAnchorCollected,
    `對照組 HTML leaf <a> 應被補抓（leafContentAnchor=${result.leafContentAnchor}）`,
  ).toBe(true);

  await page.close();
});
