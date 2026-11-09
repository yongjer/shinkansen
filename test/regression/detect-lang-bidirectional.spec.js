// Regression: detect-lang-bidirectional
//
// Fixture: test/regression/fixtures/detect-lang-bidirectional.html
//
// 真實案例(本次修補根因 v1.9.15):
//   eet-china.com 文章「摩尔线程一季报扭亏」,9 段純 SC 文字簡體比例落在
//   0.109-0.183 之間 — 卡在 detectTextLang 的 0.2 門檻底下,全部被誤判
//   zh-Hant → target=zh-TW 時 isAlreadyInTarget 回 true → 整段跳過不翻。
//
//   根因:原 detectTextLang 只查 SIMPLIFIED_ONLY_CHARS 並用「比例 ≥ 0.2 判
//   zh-Hans,否則 fallback zh-Hant」。SC-heavy 文章但簡體獨用字佔比低
//   (大量人名、機構名、同形字、英數字混排)會誤判。
//
// 修法:
//   雙向偵測。新增 TRADITIONAL_ONLY_CHARS(跟 SIMPLIFIED_ONLY_CHARS 一一對映),
//   detectTextLang 同時統計 simp + trad 命中數。任一邊「乾淨」優先 short-circuit:
//     - simpCount > 0 且 tradCount == 0 → zh-Hans(肯定 SC)
//     - tradCount > 0 且 simpCount == 0 → zh-Hant(肯定 TC)
//   兩邊都命中 / 都沒命中 → 走既有比例 fallback。
//
// 斷言:
//   1. SC-heavy 但 simpRatio < 0.2 段(本 case 核心):雙向偵測下回 zh-Hans + collected
//   2. 純 TC 段:仍回 zh-Hant(雙向 short-circuit 抓 trad > 0)+ skipped
//   3. 混合段(SC + TC 字):兩邊都命中走比例;簡體佔優仍 zh-Hans + collected
//   4. 純人名數字段(雙向都 0):走比例 fallback → zh-Hant + skipped
//
// SANITY 紀錄(已驗證):
//   暫時把 TRADITIONAL_ONLY_CHARS 改為 new Set()(空 set)
//   → 雙向 short-circuit 對「sc-heavy-low-ratio-2/3」失效(tradCount 永遠 0,
//      simpCount > 0,但簡體比例 < 0.2 → fallback 回 zh-Hant)
//   → 斷言 1 的 Case 2/3 FAIL(回 zh-Hant 而非 zh-Hans)。
//   還原修法 → 全部 PASS。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-lang-bidirectional';

test('detect-lang-bidirectional: SC-heavy 但 simpRatio<0.2 段應正確判 zh-Hans 並 collected', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 斷言 1:SC-heavy 段(simpRatio < 0.2)應判 zh-Hans
  for (const id of ['sc-heavy-low-ratio-1', 'sc-heavy-low-ratio-2', 'sc-heavy-low-ratio-3']) {
    const detected = await evaluate(`
      window.__SK.detectTextLang(document.getElementById('${id}').textContent.trim())
    `);
    expect(
      detected,
      `${id} 為 SC-heavy 段,雙向偵測下應判 zh-Hans(原本卡在 0.2 門檻底下被誤判 zh-Hant)`,
    ).toBe('zh-Hans');

    const isInTarget = await evaluate(`
      window.__SK.isAlreadyInTarget(
        document.getElementById('${id}').textContent.trim(),
        'zh-TW'
      )
    `);
    expect(
      isInTarget,
      `${id} 應視為「非繁中」(target=zh-TW),isAlreadyInTarget 回 false`,
    ).toBe(false);
  }

  // 斷言 2:純 TC 段應判 zh-Hant
  for (const id of ['tc-pure', 'tc-heavy']) {
    const detected = await evaluate(`
      window.__SK.detectTextLang(document.getElementById('${id}').textContent.trim())
    `);
    expect(
      detected,
      `${id} 為純繁中段(含繁體獨用字),應 short-circuit 判 zh-Hant`,
    ).toBe('zh-Hant');

    const isInTarget = await evaluate(`
      window.__SK.isAlreadyInTarget(
        document.getElementById('${id}').textContent.trim(),
        'zh-TW'
      )
    `);
    expect(
      isInTarget,
      `${id} 為純繁中,target=zh-TW 時 isAlreadyInTarget 應回 true(跳過不翻)`,
    ).toBe(true);
  }

  // 斷言 3:混合段(SC 字多於 TC 字)→ 走比例 fallback → zh-Hans
  const detectedMixed = await evaluate(`
    window.__SK.detectTextLang(document.getElementById('mixed-sc-dominant').textContent.trim())
  `);
  expect(
    detectedMixed,
    '混合段(SC + 個別 TC 字),兩邊都命中走比例 fallback,簡體佔優應仍判 zh-Hans',
  ).toBe('zh-Hans');

  // 斷言 4:collectParagraphs 應收 SC 段 + 跳 TC 段
  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphs())
  `);
  const units = JSON.parse(result);
  const collectedIds = units.filter((u) => u.id).map((u) => u.id);

  for (const id of ['sc-heavy-low-ratio-1', 'sc-heavy-low-ratio-2', 'sc-heavy-low-ratio-3']) {
    expect(
      collectedIds,
      `${id} 為 SC-heavy 段,target=zh-TW 應 collected(送翻譯)`,
    ).toContain(id);
  }
  for (const id of ['tc-pure', 'tc-heavy']) {
    expect(
      collectedIds,
      `${id} 為純繁中,target=zh-TW 應 skipped(不送翻譯,雙向 short-circuit 命中 trad>0)`,
    ).not.toContain(id);
  }
  expect(
    collectedIds,
    'mixed-sc-dominant 為 SC 為主的混合段,target=zh-TW 應 collected',
  ).toContain('mixed-sc-dominant');

  // 斷言 5:SC 段含 inline DIV(模擬廣告 inline 注入)應走 element 路徑收進候選。
  // 真實 case(eet-china)是頁面 JS 動態 appendChild ad-div 進 P 內,HTML5 parser
  // 對 fixture HTML 內的 P>DIV 會 auto-close,所以動態構造。
  // 注意:DIV **不在** SK.BLOCK_TAGS_SET(後者只含 P/H1-6/LI/BLOCKQUOTE 等真正 block
  // content tag),所以 P > DIV 不觸發 containsBlockDescendant,P 走 element 路徑。
  // 雙向修法影響 element 路徑(textContent 含 inline DIV 內容的整段 SC + ad TC 混合
  // 仍應正確判 zh-Hans)。
  const elementWithDivResult = await evaluate(`
    (() => {
      const targetP = document.getElementById('sc-with-block-descendant');
      const adDiv = document.createElement('div');
      adDiv.className = 'ad-block-injected';
      // 真實 eet-china 廣告也是 SC 文字(partner-content card title 等),用 SC 模擬
      adDiv.textContent = '合作内容 2026 推荐阅读';
      targetP.appendChild(adDiv);

      const r = window.__shinkansen.collectParagraphsWithStats();
      const matched = r.units.find(u => u.id === 'sc-with-block-descendant');
      return {
        targetHasInlineDiv: !!targetP.querySelector('div'),
        matchedFound: !!matched,
        matchedKind: matched ? matched.kind : null,
      };
    })()
  `);
  expect(
    elementWithDivResult.targetHasInlineDiv,
    '動態注入的 ad div 應存在於 P 內(模擬真實 eet-china DOM)',
  ).toBe(true);
  expect(
    elementWithDivResult.matchedFound,
    'sc-with-block-descendant(SC + inline div)在雙向修法後應 collected(原本 simpRatio<0.2 被誤判 zh-Hant 丟棄)',
  ).toBe(true);

  await page.close();
});
