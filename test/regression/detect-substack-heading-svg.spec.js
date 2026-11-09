// Regression: substack-heading-svg (v1.4.22 SVG icon 不該觸發 media-card skip)
//
// Fixture: test/regression/fixtures/substack-heading-svg.html
//
// Bug（v1.4.20 / v1.4.21）：v1.4.20 新增的 mediaCardSkip 用 SK.containsMedia 判斷媒體，
// 而 containsMedia 涵蓋 img/picture/video/svg/canvas/audio——導致 Substack
// 「H2 > div.anchor > svg + 直接文字」的標題也被當成媒體卡片 FILTER_SKIP，
// 整個 H2 從來沒成翻譯單元，頁面標題保持英文。
//
// 修法（v1.4.22）：把 mediaCardSkip 的判斷從
//   `SK.containsMedia(el)`
// 窄化為
//   `el.querySelector('img, picture, video')`
// 只收「功能性媒體」（真實內容圖片/影片），排除 svg/canvas/audio——後三者常是
// 裝飾性 icon，誤判成卡片會把真正的標題/段落整段漏翻。
//
// SANITY 紀錄（已驗證）：把 content-detect.js 的判斷還原為 `SK.containsMedia(el)`
// 後，正向 test 兩個斷言（H2 應被偵測 + mediaCardSkip 不該命中）都 fail
// （H2 被 SVG 觸發舊條件 FILTER_SKIP）；換回窄化判斷後全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'substack-heading-svg';

test('H2 含 SVG icon + div.anchor + 直接文字（Substack-style）應被偵測為 element unit', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-substack-heading', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-substack-heading');
      const h2 = root.querySelector('h2');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const hasH2Unit = units.some(u => u.kind === 'element' && u.el === h2);
      const h2UnitText = hasH2Unit
        ? (units.find(u => u.el === h2).el.innerText || '').trim()
        : null;
      return {
        unitCount: units.length,
        hasH2Unit,
        h2UnitText,
        mediaCardSkip: stats.mediaCardSkip || 0,
        stats,
      };
    })()
  `);

  // 斷言 1：H2 應被收為 element unit（原 bug：被 mediaCardSkip 攔掉）
  expect(
    result.hasH2Unit,
    `H2 應被偵測為 element unit。unitCount=${result.unitCount} h2UnitText=${JSON.stringify(result.h2UnitText)} stats=${JSON.stringify(result.stats)}`,
  ).toBe(true);

  // 斷言 2：mediaCardSkip 不該命中（SVG 不該觸發媒體卡片判定）
  expect(
    result.mediaCardSkip,
    `SVG 不該觸發 mediaCardSkip，實際 ${result.mediaCardSkip}，stats=${JSON.stringify(result.stats)}`,
  ).toBe(0);

  // 斷言 3：H2 單元的文字應包含預期標題內容（sanity）
  expect(result.h2UnitText).toContain('Real Substack Heading');

  await page.close();
});
