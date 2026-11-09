// Regression: nav-content (對應 v1.0.15 移除 <nav> 硬排除)
//
// Fixture: test/regression/fixtures/nav-content.html
// 結構特徵:
//   <nav> 內含趨勢文章連結、麵包屑導覽 → 應被偵測為翻譯單位
//   <div role="navigation"> 內含相關文章段落 → 應被偵測為翻譯單位
//   <main> 內正常段落 → 應被偵測
//   <footer>（站底，非 main/article 內）→ 應被排除
//
// v1.0.14 以前的 bug:
//   SEMANTIC_CONTAINER_EXCLUDE_TAGS 含 'NAV'，EXCLUDE_ROLES 含 'navigation'，
//   導致所有 <nav> 和 role="navigation" 內的文字一律被跳過。
//   Engadget 上方的 Trending bar 和麵包屑因此不會被翻譯。
//
// v1.0.15 修法:
//   從 SEMANTIC_CONTAINER_EXCLUDE_TAGS 移除 'NAV'，
//   從 EXCLUDE_ROLES 移除 'navigation'，
//   移除 isContentNav() 函式及其在 isInsideExcludedContainer() 中的呼叫。
//   導覽區域的翻譯品味判斷交給 Gemini system prompt。
//
// v1.0.16 補充:
//   獨立 <a> 的最短文字門檻從 12 提高至 20 字元，
//   因此麵包屑短連結（如 "Computing"、"Laptops"）正確地不被偵測。
//
// 斷言基於 HTML5 語意元素（nav、footer、main），不綁站點，符合硬規則 8。
// SANITY 紀錄(已驗證):將 'NAV' 加回 SEMANTIC_CONTAINER_EXCLUDE_TAGS → 「nav 內的文字應被偵測」斷言 fail(麵包屑 / 趨勢連結消失)。還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'nav-content';

test('nav-content: nav 內的文字應被偵測為翻譯單位', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  // 等 main 內的段落出現（確認 fixture 載入完成）
  await page.waitForSelector('main p', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  const previews = units.map((u) => u.textPreview || '');

  // 斷言 1: nav Trending 連結文字應被偵測到
  const hasTrending = previews.some((p) => p.includes('Auto Show') || p.includes('EV roundup'));
  expect(hasTrending, '應偵測到 nav 內的 Trending 連結文字').toBe(true);

  // 斷言 2: nav 麵包屑短連結（< 20 字元）不應被偵測（v1.0.16 anchor 門檻）
  const hasBreadcrumb = previews.some((p) => p.includes('Computing') || p.includes('Laptops'));
  expect(hasBreadcrumb, '麵包屑短連結不應被偵測（v1.0.16 anchor 門檻 20 字元）').toBe(false);

  // 斷言 3: role="navigation" 內的段落應被偵測到
  const hasRelated = previews.some((p) => p.includes('Related articles'));
  expect(hasRelated, '應偵測到 role="navigation" 內的段落文字').toBe(true);

  // 斷言 4: main 內正常段落仍正常偵測
  const hasMain = previews.some((p) => p.includes('normal article paragraph'));
  expect(hasMain, '正常段落應被偵測').toBe(true);

  // 斷言 5: 站底 footer（不在 main/article 內）不應被偵測
  const hasFooter = previews.some((p) => p.includes('Copyright') || p.includes('All rights reserved'));
  expect(hasFooter, '站底 footer 的文字不應被偵測').toBe(false);

  await page.close();
});
