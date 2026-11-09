// Regression: extract-svg-keep（對應 code review 2026-07-08 R5(c),dev tail 2.0.7.1 修）
//
// Bug:content-ns.js hardenExtractedHtml 的「空殼修剪」KEEP 集合寫大寫 'SVG',
//     但 SVG 元素（SVGElement）的 tagName 是小寫 'svg' → KEEP 永遠比不中 →
//     無文字的 inline SVG 圖（icon / 圖表）整顆被空殼修剪刪掉，送 Instapaper 的
//     擷取 HTML 少圖。MEDIA_SEL 的 querySelector 只查後代，護不住 svg 自身。
// 修法（content-ns.js）:`KEEP.has(node.tagName.toUpperCase())`。
//
// 驅動方式：hardenExtractedHtml 是 SK 上的純函式（htmlString in → htmlString out）,
//   isolated world 直接呼叫，不需專屬 fixture（host 頁重用 extract-page-html.html）。
//
// 本 spec 鎖的訊號層：驗「空殼修剪不刪 inline SVG、且仍會刪真正的空殼」。
//   不驗 Instapaper 上傳端到端（送 Instapaper 需帳號連結，屬 cage 實機驗收層）。
//
// SANITY 紀錄（已驗證，2026-07-08）：把 content-ns.js 空殼修剪的
//   `KEEP.has(node.tagName.toUpperCase())` 改回 `KEEP.has(node.tagName)` →
//   「svg 應保留」斷言 fail（keptSvg=false）。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const HOST_FIXTURE = 'extract-page-html';

test('extract-svg-keep: 空殼修剪保留無文字 inline SVG、仍刪真正空殼', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${HOST_FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const input = [
        '<p>Real paragraph content that must survive hardening.</p>',
        // 無文字 inline SVG（icon / 圖表）:tagName 小寫 'svg',KEEP 未 toUpperCase 時比不中
        '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 0h10v10z"></path></svg>',
        // 圖片包在 wrapper 內：querySelector(MEDIA_SEL) 查得到後代 → 本來就會保留（對照）
        '<div><img src="x.png" alt=""></div>',
        // 真正的空殼：無文字、無媒體 → 應被修剪（證明 prune 有跑到，防假綠）
        '<div id="empty-shell"><span>   </span></div>',
      ].join('');
      const out = window.__SK.hardenExtractedHtml(input, 'Unrelated Title');
      return {
        out,
        keptSvg: out.includes('<svg'),
        keptImg: out.includes('<img'),
        keptParagraph: out.includes('Real paragraph content'),
        removedEmptyShell: !out.includes('empty-shell'),
      };
    })()
  `);

  // 斷言 1（核心）：無文字 inline SVG 應保留
  expect(result.keptSvg, `inline SVG 不應被空殼修剪刪掉\nout: ${result.out}`).toBe(true);

  // 斷言 2（對照）：媒體後代 wrapper 照常保留
  expect(result.keptImg, 'IMG wrapper 應保留').toBe(true);
  expect(result.keptParagraph, '正文段落應保留').toBe(true);

  // 斷言 3（防假綠）：真正的空殼應被修剪 → 證明 prune 路徑有跑到
  expect(result.removedEmptyShell, `空殼 div 應被修剪\nout: ${result.out}`).toBe(true);

  await page.close();
});
