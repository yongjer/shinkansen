// Regression: marker-cjk-spaces（對應 v2.0.53 修的「譯文 CJK 字間莫名出現空格」bug）
//
// Fixture: test/regression/fixtures/orphan-placeholder.html（共用 HTML）
// Canned response: test/regression/fixtures/marker-cjk-spaces.response.txt
//
// 結構通則:
//   模型偶發在「每個」佔位符標記前後都塞空格（日文書實測:
//   「⟦0⟧ 兩個男人…稍微 ⟦/0⟧ ⟦1⟧ 歪 ⟦/1⟧ ⟦2⟧ 著頭…」），反序列化後空格進了
//   text node，畫面出現「稍微 歪 著頭」這種 CJK 間空格。
//   舊 collapseCjkSpacesAroundPlaceholders 只蓋「標記外側貼 CJK」四種窄形態，
//   漏接標記內側與標記串之間。
//   修法（通則）：兩個 CJK 字元之間只隔著標記與空白時，空白全是模型幻覺
//  （CJK 內部無空格語意）——標記保留、[ \t] 移除；字串頭尾的標記串同理。
//   刻意不動 \n（<br> 語意）與 CJK/拉丁邊界空格（中英空格合法排版）。
//
// Canned response 每個標記前後都帶空格:
//   "江戶，又稱為 ⟦0⟧ 江戶 ⟦/0⟧ ，是 ⟦1⟧ 東京 ⟦/1⟧ （日本首都）的舊稱。"
//
// 斷言: 注入後 p#target 的 textContent 完全無空格（全 CJK 句），且 <a>/<i>
//        正常還原、內文無前後空格。
//
// SANITY 紀錄（已驗證）：暫時在 content-serialize.js
// collapseCjkSpacesAroundPlaceholders 的「標記串通用收斂」三條 replace 前
// 提早 return →「textContent 不得含空格」斷言 fail（實際
// "江戶，又稱為  江戶  ，是  東京  （日本首都）的舊稱。"——標記兩側空格在
// 標記移除後合併成雙空格殘留）→ 還原 → pass。translate.js 端
// collapseCjkPlaceholderSpaces 另以 no-op 破壞驗證 unit spec（2 fail → 還原綠）。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE_HTML = 'orphan-placeholder'; // 共用同一份 HTML
const FIXTURE_RESPONSE = 'marker-cjk-spaces';
const TARGET_SELECTOR = 'p#target';

test('marker-cjk-spaces: 模型在標記前後塞空格時 CJK 譯文不得殘留空格', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE_RESPONSE);
  // canned response 每個標記前後都有空格
  expect(translation.includes(' ⟦0⟧ ')).toBe(true);
  expect(translation.includes(' ⟦/1⟧ ')).toBe(true);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await runTestInject(evaluate, TARGET_SELECTOR, translation);

  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    return {
      text: p.textContent,
      aText: p.querySelector('a') ? p.querySelector('a').textContent : null,
      iText: p.querySelector('i') ? p.querySelector('i').textContent : null,
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 核心斷言：全 CJK 句注入後不得殘留任何空格
  expect(
    /[ \t]/.test(after.text),
    `CJK 譯文不得含空格，實際: ${JSON.stringify(after.text)}`,
  ).toBe(false);
  expect(after.text).toBe('江戶，又稱為江戶，是東京（日本首都）的舊稱。');

  // inline 元素正常還原且內文無前後空格
  expect(after.aText).toBe('江戶');
  expect(after.iText).toBe('東京');

  await page.close();
});
