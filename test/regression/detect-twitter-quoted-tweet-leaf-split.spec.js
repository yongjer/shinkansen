// Regression: twitter-quoted-tweet-leaf-split (v1.10.1)
// INCLUDE_BY_SELECTOR scope 內全-leaf-SPAN 拆 leaf 邏輯。
//
// Fixture: test/regression/fixtures/twitter-quoted-tweet-leaf-split.html
// 結構: <div data-testid="tweetText" lang="en" style="display: flow-root">
//         <span>One fun thing about owning...</span>
//         <span>https://example.com/...</span>
//       </div>
//
// Bug:跟主推文 Case F(walker 內 multi-segment block 拆 leaf)不同,quoted tweet
// 只有 2 個 leaf SPAN(無 wrapper / mention),Case F 條件(>= 3 子 + wrapper SPAN)
// 都不符,FILTER_SKIP 後由 INCLUDE_BY_SELECTOR 把整顆 tweetText 抓成 element unit。
// X 是 framework-managed → v1.9.27 fallback A1 tryInjectNodeValueMutate 對 2 個
// visible text node 配對失敗 → A2 injectDual append wrapper sibling。結果:原英文
// 留著 + 中文 wrapper 在 tweetText 的同層 sibling DIV,違反 §15。
//
// 修法:INCLUDE_BY_SELECTOR scope 內加結構判斷 — 命中 element 若是 block-displayed
// (含 flow-root) + 直接子 >= 2 + 全 leaf SPAN with text >= 2 字,拆 leaf 各成
// element unit + fragmentExtracted.add(el) 防整顆再 push。每個 leaf 是 single
// text node → A1 nodeValue mutate 成功 → single 視覺。
//
// stats.includeSelectorLeafSplit 計數 forcing function:counter 名綁此 path 語意,
// 實作若退回原路徑或刪掉整段 if 都會讓 counter 歸零。
//
// SANITY 紀錄(已驗證 2026-05-22):暫時把 content-detect.js INCLUDE_BY_SELECTOR
// scope 內「v1.10.1: INCLUDE_BY_SELECTOR scope 內全 leaf SPAN 直接子」整段註解掉
// → 正向斷言(includeSelectorLeafSplit >= 1、內文 SPAN + URL SPAN 拆出獨立 unit、
// tweetText 不被當 unit)全 fail。還原 → pass。負向對照在修法前後都 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'twitter-quoted-tweet-leaf-split';

test('quoted tweet leaf-split: flow-root + 2 leaf SPAN 應拆 leaf 各成 unit', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-quoted-tweet', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-quoted-tweet');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const tweetText = root.querySelector('[data-testid="tweetText"]');

      const unitTexts = units.map(u => {
        if (u.kind === 'fragment') return { kind: 'fragment' };
        return {
          kind: 'element',
          tag: u.el.tagName,
          text: (u.el.textContent || '').slice(0, 60),
        };
      });

      const hasInnerText = units.some(u => u.kind === 'element' &&
        u.el.tagName === 'SPAN' &&
        (u.el.textContent || '').includes('One fun thing about owning'));
      const hasUrlText = units.some(u => u.kind === 'element' &&
        u.el.tagName === 'SPAN' &&
        (u.el.textContent || '').includes('example.com'));
      const tweetTextAsUnit = units.find(u => u.kind === 'element' && u.el === tweetText);

      return {
        unitCount: units.length,
        unitTexts,
        includeSelectorLeafSplit: stats.includeSelectorLeafSplit || 0,
        hasInnerText,
        hasUrlText,
        tweetTextAsUnitFound: !!tweetTextAsUnit,
        stats,
      };
    })()
  `);

  // 斷言 1:新 path 觸發
  expect(
    result.includeSelectorLeafSplit,
    `INCLUDE_BY_SELECTOR leaf split 應觸發 >= 1 次,實際 ${result.includeSelectorLeafSplit}\nstats=${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2:內文 SPAN 拆出獨立 unit
  expect(
    result.hasInnerText,
    `內文 leaf SPAN「One fun thing about owning」應拆出獨立 unit\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // 斷言 3:URL SPAN 也拆出獨立 unit
  expect(
    result.hasUrlText,
    `URL leaf SPAN「example.com」也應拆出獨立 unit\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // 斷言 4:tweetText DIV 自己不應被當 unit(拆 leaf 後 fragmentExtracted 應擋住)
  expect(
    result.tweetTextAsUnitFound,
    `tweetText DIV 自己不應出現在 units(拆 leaf 後 fragmentExtracted 應擋住整顆 push)\nunits=${JSON.stringify(result.unitTexts)}`,
  ).toBe(false);

  await page.close();
});

test('負向對照:single-leaf-span(directChildren=1)不觸發拆 leaf', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-single-leaf-span', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-single-leaf-span');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        includeSelectorLeafSplit: stats.includeSelectorLeafSplit || 0,
      };
    })()
  `);

  // directChildren = 1 < 2 → 不觸發
  expect(
    result.includeSelectorLeafSplit,
    `single-leaf-span(directChildren=1)不應觸發拆 leaf,實際 ${result.includeSelectorLeafSplit}`,
  ).toBe(0);
});

test('負向對照:mixed-children(SPAN+DIV 混合)不觸發拆 leaf', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-mixed-children', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-mixed-children');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        includeSelectorLeafSplit: stats.includeSelectorLeafSplit || 0,
      };
    })()
  `);

  // 含 DIV 子 → directChildren.every(SPAN) 失敗 → 不觸發
  expect(
    result.includeSelectorLeafSplit,
    `mixed-children(含 DIV 子)不應觸發拆 leaf,此場景由 walker Case F 處理,實際 ${result.includeSelectorLeafSplit}`,
  ).toBe(0);
});

test('負向對照:wrapper-span(SPAN 含 element child)不觸發拆 leaf', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-wrapper-span', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-wrapper-span');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        includeSelectorLeafSplit: stats.includeSelectorLeafSplit || 0,
      };
    })()
  `);

  // 含 element child 的 SPAN → directChildren.every(children.length === 0) 失敗 → 不觸發
  expect(
    result.includeSelectorLeafSplit,
    `wrapper-span(SPAN 含 element child)不應觸發拆 leaf,此場景由 walker Case F 處理,實際 ${result.includeSelectorLeafSplit}`,
  ).toBe(0);
});

test('負向對照:一般 DIV 不在 INCLUDE_BY_SELECTOR scope 不觸發拆 leaf', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-leaf-span-not-in-include', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-leaf-span-not-in-include');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        includeSelectorLeafSplit: stats.includeSelectorLeafSplit || 0,
      };
    })()
  `);

  // 一般 DIV 不在 INCLUDE_BY_SELECTOR scope → 此新 path 不觸發。
  // 證明結構通則的爆炸半徑被 selector list 限縮住。
  expect(
    result.includeSelectorLeafSplit,
    `一般 DIV(不在 INCLUDE_BY_SELECTOR scope)不應觸發拆 leaf,實際 ${result.includeSelectorLeafSplit}`,
  ).toBe(0);
});
