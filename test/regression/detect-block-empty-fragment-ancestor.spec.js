// Regression: block-empty-fragment-ancestor
//
// 對應 v1.10.4 修的「Amazon 評論卡片 review body 漏偵測」bug。
//
// 結構: LI > SPAN.a-list-item > DIV > DIV > H5(title) + DIV > SPAN.review-body > SPAN(body+BR)
//
// Bug:
//   LI 是 BLOCK_TAGS_SET 元素,containsBlockDescendant(LI) = true(有 H5)。
//   walker 進入 block 分支的 containsBlockDescendant 路徑,呼叫
//   extractInlineFragments(LI)。LI 唯一的直接子 SPAN.a-list-item 自身含
//   block 子孫(H5) → isInlineRunNode 回 false → extractInlineFragments
//   產出 0 個 fragment。但 fragmentExtracted.add(LI) 在 fragment 生成前就執行了,
//   導致 walker 後續訪問 body 內層 SPAN 時 hasAncestorExtracted 找到 LI →
//   Case E 被擋 → review body 永遠不被偵測。
//
// 修法:
//   extractInlineFragments 後檢查 frags.length > 0 才 add fragmentExtracted。
//   0 fragment 時不 add → hasAncestorExtracted 找不到 LI → Case E 正常收集
//   body SPAN(直接文字 + BR + 無非 BR element 子)。
//
// SANITY 紀錄(已驗證):
//   還原修法(extractInlineFragments 前無條件 fragmentExtracted.add) →
//   bodyCollected = false、斷言 fail;還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE_HTML = 'block-empty-fragment-ancestor';

test('review card: H5 title + body span inside LI with empty fragment extraction both collected', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-review', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-review');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const elements = units.filter(u => u.kind === 'element');
      const fragments = units.filter(u => u.kind === 'fragment');

      const h5Collected = elements.some(u =>
        u.el.tagName === 'H5' && u.el.textContent.includes('レビュータイトル')
      );
      const bodyCollected = elements.some(u =>
        u.el.tagName === 'SPAN' && u.el.textContent.includes('重宝している')
      );

      return {
        totalUnits: units.length,
        elementCount: elements.length,
        fragmentCount: fragments.length,
        h5Collected,
        bodyCollected,
        stats,
      };
    })()
  `);

  expect(result.h5Collected, 'H5 title should be collected by walker').toBe(true);
  expect(result.bodyCollected, 'review body SPAN should be collected by Case E').toBe(true);
  expect(result.totalUnits).toBeGreaterThanOrEqual(2);
});

test('review card with longer body: body span with multiple BRs also collected', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-long', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-long');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const elements = units.filter(u => u.kind === 'element');

      const bodyCollected = elements.some(u =>
        u.el.tagName === 'SPAN' && u.el.textContent.includes('コスパが良すぎる')
      );

      return {
        totalUnits: units.length,
        bodyCollected,
        stats,
      };
    })()
  `);

  expect(result.bodyCollected, 'longer review body with multiple BRs should be collected').toBe(true);
});

test('histogram row: complex flex LI with short text should NOT be collected as whole unit', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-histogram', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-histogram');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);

      const liCollected = units.some(u =>
        u.kind === 'element' && u.el.tagName === 'LI'
      );

      return {
        totalUnits: units.length,
        liCollected,
        shortBlockComplexSkip: stats.shortBlockComplexSkip || 0,
      };
    })()
  `);

  expect(result.liCollected, 'histogram LI should NOT be collected as whole unit').toBe(false);
  expect(result.shortBlockComplexSkip).toBeGreaterThanOrEqual(1);
  expect(result.totalUnits, 'no units should be collected from histogram area').toBe(0);
});
