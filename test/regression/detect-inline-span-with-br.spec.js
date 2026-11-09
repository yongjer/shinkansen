// Regression: inline-span-with-br (Case E — inline-style SPAN 容器直接含 text + BR-only)
//
// Fixture: test/regression/fixtures/inline-span-with-br.html
//
// Bug:Goodreads ReviewText 用 <span class="Formatted">句 1<br>句 2<br>句 3</span> 包多段
// 評論文字,直接子節點只有 text + BR(無其他 element)。實測 Goodreads 該頁 12 條 review,
// 4 條走「SPAN + BR + 無非 BR element」這 pattern,collectParagraphs 全部漏抓:
//   Case A 因 !containsBlockDescendant 失敗
//   Case B 因 SPAN 不在 CONTAINER_TAGS 失敗
//   Case C 因 SPAN 不在 CONTAINER_TAGS 失敗
//   Case D 因 !hasDirectNonBrElement 失敗(只有 BR、沒有非 BR element 子)
//   leaf-content-span (span:not(:has(*))) 因 SPAN 有 BR 子失敗
// 沒 BR 的純文字 SPAN 反而被 leaf 補抓救到,有 BR 反而漏 — 結構性 gap。
//
// 修法(Case E):在 acceptNode 的非 BLOCK 分支加第五條 else if,與 Case D 互斥
//(D 要 hasDirectNonBrElement、E 明確 !hasDirectNonBrElement),push { kind: 'element', el }
// 走 Case B 風格的整段 element 注入,讓 BR 透過既有 sentinel 流程序列化。
//
// stats.spanWithBr counter forcing function:counter 名綁定 Case E 語意,實作若刪掉整條
// else if 或退回 Case D 都會讓 counter 歸零。
//
// SANITY 紀錄(已驗證):暫時把 content-detect.js 新增的 Case E else if 整段移除後,
// 第 1 條(target-e 偵測)與第 2 條(spanWithBr >= 1)同時 fail;還原後 pass。
// 負向對照 target-short / target-nested 在修法前後都 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inline-span-with-br';

test('Case E: SPAN 含 text + BR-only 應被偵測為 element 單元', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-e', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-e');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);

      // 找 SPAN.Formatted 是否被收成 element 單元
      const spanUnit = units.find(u =>
        u.kind === 'element' &&
        u.el?.tagName === 'SPAN' &&
        u.el?.classList?.contains('Formatted')
      );

      return {
        unitCount: units.length,
        spanUnitFound: !!spanUnit,
        spanUnitTextHead: spanUnit ? (spanUnit.el.textContent || '').trim().slice(0, 60) : null,
        spanWithBr: stats.spanWithBr || 0,
        inlineMixedSpan: stats.inlineMixedSpan || 0,
        stats,
      };
    })()
  `);

  expect(
    result.spanUnitFound,
    `Case E: span.Formatted 應被收成 element 單元,實際 unitCount=${result.unitCount}\nstats=${JSON.stringify(result.stats)}`,
  ).toBe(true);

  expect(
    result.spanWithBr,
    `Case E: stats.spanWithBr 應 >= 1,實際 ${result.spanWithBr}\nstats=${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  // 譯文應涵蓋四段中至少前兩段文字(確認沒抓到別的 SPAN)
  expect(result.spanUnitTextHead).toContain('Great book');

  await page.close();
});

test('Case E 負向對照:SPAN + BR 但 directTextLength < 20 不應命中', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-short', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-short');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const shortSpanCaught = units.some(u =>
        u.kind === 'element' &&
        u.el?.tagName === 'SPAN' &&
        u.el?.classList?.contains('ShortLabel')
      );
      return {
        unitCount: units.length,
        shortSpanCaught,
        spanWithBr: stats.spanWithBr || 0,
      };
    })()
  `);

  expect(
    result.shortSpanCaught,
    `短文字 SPAN(<20 字)不應被 Case E 命中,unitCount=${result.unitCount} spanWithBr=${result.spanWithBr}`,
  ).toBe(false);

  await page.close();
});

test('Case E 負向對照:巢狀 SPAN(outer Case D > inner would-be Case E)inner 不應重複抽', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-nested', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-nested');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        spanWithBr: stats.spanWithBr || 0,
        inlineMixedSpan: stats.inlineMixedSpan || 0,
      };
    })()
  `);

  // outer SPAN 有 text + br + inner SPAN(非 BR element)→ 走 Case D(inlineMixedSpan >= 1)
  // 並把 outer 加入 fragmentExtracted。inner SPAN 雖結構符合 Case E,
  // 但 hasAncestorExtracted 為 true → 不應命中。spanWithBr 應為 0。
  expect(
    result.spanWithBr,
    `巢狀情境 inner SPAN 不應觸發 Case E(被 outer fragmentExtracted dedup),實際 spanWithBr=${result.spanWithBr}`,
  ).toBe(0);

  await page.close();
});
