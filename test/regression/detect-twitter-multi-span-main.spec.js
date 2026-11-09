// Regression: twitter-multi-span-main-tweet Case F
// (block container 含 ≥ 3 個 inline-style 直接子 + wrapper SPAN → 各 leaf SPAN 獨立成 unit)
//
// Fixture: test/regression/fixtures/twitter-multi-span-main-tweet.html
// 結構: <div data-testid="tweetText" lang="zh">
//         <span>第一句</span>
//         <div style="inline-flex"><span><a>@mention</a></span></div>
//         <span>                                         ← wrapper SPAN
//           <span>段1</span><span class="r-b88u0q">段2</span>...
//         </span>
//       </div>
//
// Bug:整顆 tweetText 通過 walker 所有 check → FILTER_ACCEPT 成 element unit。
// 注入 framework-managed branch tryInjectNodeValueMutate 走 A3 segment fallback
// catch-all,把整段譯文塞給 ss[0]、其餘 text node 設 "",實測 SPAN[2] 內 7 子 SPAN
// 沒被 mutate,但 outer 仍被打 translated attribute → SPA 不再 retry → 主文 95%
// 內文留簡中。
//
// 修法 Case F:加 multi-segment block 進 widgetRejectedBlocks + 主動收集 descendant
// leaf SPAN 各成 unit(繞過 20 字短文 guard,multi-segment 結構 implies prose 上下文)
// + FILTER_SKIP block 自己不當 unit。每個 leaf SPAN 變單 text-node unit,
// mutate path 對單 text node case 對齊穩定。
//
// stats.multiSegmentInlineBlock 計數 forcing function:counter 名綁 Case F 語意,
// 實作若退回原路徑或刪掉整條 if 都會讓 counter 歸零。
//
// SANITY 紀錄(已驗證 2026-05-22):暫時把 content-detect.js Case F 整段(從註解
// 「Case F (v1.10.1)」到對應 `return NodeFilter.FILTER_SKIP;`)註解掉/刪除 →
// 「Case F 觸發 + descendant leaf 都被收」斷言 fail(units 內找不到 SPAN[2] 內的
// 子 SPAN,multiSegmentInlineBlock=0)。還原 → pass。
// 負向對照 reply-single-span / wikipedia-style-p / nested-block 在修法前後都 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'twitter-multi-span-main-tweet';

test('Case F: X 主推文 multi-span 結構應觸發 + 各 leaf SPAN 獨立成 unit', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-main-tweet', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-main-tweet');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const tweetText = root.querySelector('[data-testid="tweetText"]');

      // 收所有 unit 內 element 的 textContent 預覽
      const unitTexts = units.map(u => {
        if (u.kind === 'fragment') {
          let t = '';
          let n = u.startNode;
          while (n) {
            t += n.textContent || '';
            if (n === u.endNode) break;
            n = n.nextSibling;
          }
          return { kind: 'fragment', text: t.slice(0, 60) };
        }
        return { kind: 'element', text: (u.el.textContent || '').slice(0, 60) };
      });

      // 期望 8 個 leaf SPAN 都被收(SPAN[0] + SPAN[2] 7 子 SPAN)
      const hasFirstSentence = units.some(u => u.kind === 'element' &&
        (u.el.textContent || '').includes('新的 Antigravity 2.0 爛到不行'));
      const hasShortQuote = units.some(u => u.kind === 'element' &&
        (u.el.textContent || '').includes('你们抄得太明显了'));
      const hasMidPara = units.some(u => u.kind === 'element' &&
        (u.el.textContent || '').includes('之前大家还愿意相信'));
      const hasTailPara = units.some(u => u.kind === 'element' &&
        (u.el.textContent || '').includes('他现在甚至更相信Cursor'));

      // tweetText DIV 自己不應被當 unit(已 FILTER_SKIP)
      const tweetTextAsUnit = units.find(u => u.kind === 'element' && u.el === tweetText);

      return {
        unitCount: units.length,
        unitTexts,
        multiSegmentInlineBlock: stats.multiSegmentInlineBlock || 0,
        hasFirstSentence,
        hasShortQuote,
        hasMidPara,
        hasTailPara,
        tweetTextAsUnitFound: !!tweetTextAsUnit,
        stats,
      };
    })()
  `);

  // 斷言 1:Case F 觸發
  expect(
    result.multiSegmentInlineBlock,
    `Case F 應觸發 ≥ 1 次,實際 ${result.multiSegmentInlineBlock}\nstats=${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2:首句 SPAN[0] 被收
  expect(
    result.hasFirstSentence,
    `首句 SPAN[0]「新的 Antigravity 2.0 爛到不行」應被收\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // 斷言 3:短文 r-b88u0q SPAN(< 20 字)被收 — 證明繞過 20 字短文 guard
  expect(
    result.hasShortQuote,
    `短文 r-b88u0q SPAN「你们抄得太明显了」(< 20 字)應被收,Case F 必須繞過 leaf-content-span 20 字 guard\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // 斷言 4:中段正文 SPAN 被收
  expect(
    result.hasMidPara,
    `中段正文 SPAN「之前大家还愿意相信」應被收\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // 斷言 5:尾段 SPAN 被收
  expect(
    result.hasTailPara,
    `尾段 SPAN「他现在甚至更相信Cursor」應被收\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // 斷言 6:tweetText DIV 自己不被當 unit(FILTER_SKIP 生效)
  expect(
    result.tweetTextAsUnitFound,
    `tweetText DIV 自己不應出現在 units(Case F 應 FILTER_SKIP 它)\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(false);

  await page.close();
});

test('Case F 擴充:mention-only-div(無 wrapper SPAN,僅 inline-flex DIV)應觸發 + leaf SPAN 被收', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-mention-only-div', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-mention-only-div');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const tweetText = root.querySelector('[data-testid="tweetText"]');

      const unitTexts = units.map(u => {
        if (u.kind === 'fragment') {
          let t = '';
          let n = u.startNode;
          while (n) {
            t += n.textContent || '';
            if (n === u.endNode) break;
            n = n.nextSibling;
          }
          return { kind: 'fragment', text: t.slice(0, 60) };
        }
        return { kind: 'element', text: (u.el.textContent || '').slice(0, 60), tag: u.el.tagName };
      });

      const hasVoice = units.some(u => u.kind === 'element' &&
        (u.el.textContent || '').includes('Let your voice'));
      const hasFeatures = units.some(u => u.kind === 'element' &&
        (u.el.textContent || '').includes('New conversational'));
      const hasTail = units.some(u => u.kind === 'element' &&
        (u.el.textContent || '').includes('and Keep so you can'));

      const tweetTextAsUnit = units.find(u => u.kind === 'element' && u.el === tweetText);
      const allAreSpan = units.every(u => u.kind === 'element' && u.el.tagName === 'SPAN');

      return {
        unitCount: units.length,
        unitTexts,
        multiSegmentInlineBlock: stats.multiSegmentInlineBlock || 0,
        hasVoice,
        hasFeatures,
        hasTail,
        tweetTextAsUnitFound: !!tweetTextAsUnit,
        allAreSpan,
        stats,
      };
    })()
  `);

  // Case F 觸發(inline-flex DIV 有 children → wrapperChildCount >= 1)
  expect(
    result.multiSegmentInlineBlock,
    `Case F 應觸發(inline-flex DIV wrapper),實際 ${result.multiSegmentInlineBlock}\nstats=${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  // leaf SPAN "Let your voice..." 被收
  expect(
    result.hasVoice,
    `leaf SPAN「Let your voice」應被收\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // leaf SPAN "New conversational features..." 被收
  expect(
    result.hasFeatures,
    `leaf SPAN「New conversational」應被收\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // leaf SPAN "and Keep so you can..." 被收
  expect(
    result.hasTail,
    `leaf SPAN「and Keep so you can」應被收\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // tweetText DIV 不當 unit
  expect(
    result.tweetTextAsUnitFound,
    `tweetText DIV 自己不應出現在 units\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(false);

  // 所有 unit 都是 SPAN(leaf SPAN 拆分)
  expect(
    result.allAreSpan,
    `所有 unit 都應是 leaf SPAN,實際 units=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  await page.close();
});

test('Case F + URL anchor 排除:長 URL anchor 不該被 leaf-content-anchor 獨立收', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-mention-with-url', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-mention-with-url');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);

      const unitTexts = units.map(u => ({
        kind: u.kind,
        tag: u.el?.tagName || 'fragment',
        text: (u.el?.textContent || '').slice(0, 60)
      }));

      const hasAnchorUnit = units.some(u =>
        u.kind === 'element' && u.el.tagName === 'A');

      const allAreSpan = units.every(u =>
        u.kind === 'element' && u.el.tagName === 'SPAN');

      return {
        unitCount: units.length,
        unitTexts,
        multiSegmentInlineBlock: stats.multiSegmentInlineBlock || 0,
        hasAnchorUnit,
        allAreSpan,
        leafContentAnchor: stats.leafContentAnchor || 0,
      };
    })()
  `);

  // Case F 不應觸發:A 是語意 inline(PRESERVE_INLINE_TAGS),不算結構 wrapper。
  // SPAN + A + SPAN 結構走 INCLUDE_BY_SELECTOR 當整個 element unit 更合理
  // (保留 URL 作為翻譯 slot,而非拆成獨立 leaf 丟失 link context)。
  expect(
    result.multiSegmentInlineBlock,
    `Case F 不應觸發(A 是語意 inline 不算 wrapper),實際 ${result.multiSegmentInlineBlock}`,
  ).toBe(0);

  // tweetText DIV 被 INCLUDE_BY_SELECTOR 收為一個 unit
  const hasDivUnit = result.unitTexts.some(u => u.tag === 'DIV');
  expect(
    hasDivUnit,
    `tweetText DIV 應被收為 unit\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  await page.close();
});

test('Case F 負向對照:reply 單一 SPAN 結構(子 < 3)不應觸發', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-reply-single-span', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-reply-single-span');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        multiSegmentInlineBlock: stats.multiSegmentInlineBlock || 0,
      };
    })()
  `);

  // reply 結構 directChildren=1 < 3 → Case F 不該命中
  expect(
    result.multiSegmentInlineBlock,
    `reply 單 SPAN 結構(子=1)不應觸發 Case F,實際 ${result.multiSegmentInlineBlock}`,
  ).toBe(0);
});

test('Case F 負向對照:Wikipedia P 段(無 wrapper SPAN)不應觸發', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-wikipedia-style-p', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-wikipedia-style-p');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        multiSegmentInlineBlock: stats.multiSegmentInlineBlock || 0,
      };
    })()
  `);

  // P 含 A / EM / STRONG 但無 wrapper SPAN → Case F 條件 (4) 失敗
  expect(
    result.multiSegmentInlineBlock,
    `Wikipedia P 段(無 wrapper SPAN)不應觸發 Case F,實際 ${result.multiSegmentInlineBlock}`,
  ).toBe(0);
});

test('Case F 負向對照:block container 含 block 子(子非全 inline)不應觸發', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-nested-block', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-nested-block');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        multiSegmentInlineBlock: stats.multiSegmentInlineBlock || 0,
      };
    })()
  `);

  // 含 block 子 → allInline=false → Case F 條件 (3) 失敗
  expect(
    result.multiSegmentInlineBlock,
    `含 block 子的 container 不應觸發 Case F,實際 ${result.multiSegmentInlineBlock}`,
  ).toBe(0);
});
