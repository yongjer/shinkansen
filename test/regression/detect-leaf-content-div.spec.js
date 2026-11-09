// Regression: leaf-content-div (對應 v1.0.8 新增的 leaf content DIV 補抓)
//
// Fixture: test/regression/fixtures/leaf-content-div.html
// 結構特徵:
//   CSS-in-JS 框架以 <div> 取代 <p>，walker 的 BLOCK_TAGS 收不到。
//   補抓條件：無 block 祖先 + 無 block 後代 + 文字 >= 20 字。
//
// v1.0.7 以前的 bug: 這類 DIV 被 walker SKIP，內部只有文字節點，
// SHOW_ELEMENT walker 看不到 → 文字永遠不被翻譯。
//
// v1.0.8 修法: 新增 leaf content DIV 補抓 pass。
//
// 斷言基於結構特徵（block 祖先有無、文字長度），不綁站點，符合硬規則 8。
// <!-- SANITY-PENDING: 移除 leaf content DIV 補抓 pass，確認 #deck-div 消失 -->
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'leaf-content-div';
const DECK_SELECTOR = 'div#deck-div';

test('leaf-content-div: 無 block 祖先的純文字 DIV 必須被偵測為翻譯單位', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(DECK_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  // 斷言 1: #deck-div 被偵測到（leafContentDiv stat >= 1）
  expect(
    skipStats.leafContentDiv || 0,
    `應有至少 1 個 leafContentDiv 計數，實際 ${skipStats.leafContentDiv || 0}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2: units 中有 tag=DIV 且包含副標文字
  const divUnits = units.filter((u) => u.tag === 'DIV');
  const deckUnit = divUnits.find((u) =>
    (u.textPreview || '').includes('moral education')
  );
  expect(deckUnit, '應偵測到含 "moral education" 的 DIV 單位').toBeDefined();

  // 斷言 3: #normal-p 也被正常偵測（walker 正規路徑）
  const pUnits = units.filter((u) => u.tag === 'P');
  expect(pUnits.length, '應有至少 1 個 P 單位').toBeGreaterThanOrEqual(1);

  // 斷言 4: #short-div（< 20 字）不應被偵測
  const shortDivUnit = units.find((u) =>
    u.tag === 'DIV' && (u.textPreview || '').includes('Read More')
  );
  expect(shortDivUnit, '"Read More" 短 DIV 不應被偵測').toBeUndefined();

  // 斷言 5: #caption-div（有 SPAN 子元素）不應被偵測，避免破壞 inline 排版
  const captionDivUnit = units.find((u) =>
    u.tag === 'DIV' && (u.textPreview || '').includes('great-grandfathers')
  );
  expect(captionDivUnit, '有子元素的 DIV 不應被 leaf content div 偵測').toBeUndefined();

  await page.close();
});

test('leaf-content-div: 注入譯文後文字正確替換', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(DECK_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await runTestInject(evaluate, DECK_SELECTOR, translation);

  const injectedText = await evaluate(`
    document.querySelector(${JSON.stringify(DECK_SELECTOR)}).textContent.trim()
  `);
  expect(injectedText).toContain('品德教育');

  await page.close();
});
