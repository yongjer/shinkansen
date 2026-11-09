// Regression: detect-lang-simp-coverage
//
// Fixture: test/regression/fixtures/detect-lang-simp-coverage.html
//
// 真實案例(本次修補根因):
//   X 引用文章卡片標題「手冲咖啡进阶指北：冠军参数如何变成你的日常 - 少数派」
//   23 個 CJK 內含 8 個簡中字(冲 进 阶 军 参 数 变 数),
//   原 SIMPLIFIED_ONLY_CHARS set 只有「进 数 变 数」4 字命中,
//   simpCount/cjkCount = 4/23 ≈ 0.17 < 0.2 → detectTextLang 誤判 zh-Hant →
//   target=zh-TW 時 isAlreadyInTarget 回 true → isCandidateText 回 false →
//   整段被跳過,X 引用卡片標題永遠不翻。
//
// 修法:
//   補上「冲 阶 军 参 个 国 几 网 听 觉 实 给 红 终 经 历 论 类 优 报
//   視 业 谢 该 带 怀 紧 创 際 综 钟 销 续 责 资 兴」等常見高頻簡中字到 SIMPLIFIED_ONLY_CHARS,
//   讓 ratio 跨過 0.2 閾值。
//
// 斷言:
//   1. detectTextLang 對「短簡中含 4 個漏掉字」回 'zh-Hans'(核心斷言)
//   2. isAlreadyInTarget(text, 'zh-TW') 回 false(zh-Hans ≠ zh-Hant)
//   3. target=zh-TW 時 collectParagraphs 應收進此段為 candidate
//   4. 對照組短繁中段仍維持 zh-Hant skip(不誤殺,確保補字沒打到繁中)
//   5. 對照組短英文段仍 collected
//
// SANITY 紀錄(已驗證):
//   暫時把補的字段從 SIMPLIFIED_ONLY_CHARS 拿掉(把 '冲阶军参个国几网...' 整段刪除)
//   → 斷言 1「detectTextLang 應回 zh-Hans」會 FAIL(回 zh-Hant,因為命中率掉回 4/23)。
//   還原修法 → 全部 PASS。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-lang-simp-coverage';

test('detect-lang-simp-coverage: 短簡中含常見字應正確偵測為 zh-Hans 且 collected', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 斷言 1: detectTextLang 對短簡中段回 'zh-Hans'
  const detectedSimp = await evaluate(`
    window.__SK.detectTextLang(document.getElementById('short-simp-missed-chars').textContent.trim())
  `);
  expect(
    detectedSimp,
    '短簡中含「冲 阶 军 参」應被偵測為 zh-Hans(原本 4/23 < 0.2 漏判)',
  ).toBe('zh-Hans');

  // 斷言 2: isAlreadyInTarget(zh-TW) 對該段回 false
  const isInTarget = await evaluate(`
    window.__SK.isAlreadyInTarget(
      document.getElementById('short-simp-missed-chars').textContent.trim(),
      'zh-TW'
    )
  `);
  expect(
    isInTarget,
    'target=zh-TW 時 isAlreadyInTarget 對 zh-Hans 內容應回 false',
  ).toBe(false);

  // 斷言 3: collectParagraphs 應收進此段
  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphs())
  `);
  const units = JSON.parse(result);
  const collectedIds = units.filter((u) => u.id).map((u) => u.id);
  expect(
    collectedIds,
    '短簡中段 #short-simp-missed-chars 應被 collectParagraphs 收為 candidate',
  ).toContain('short-simp-missed-chars');

  // 斷言 4: 對照組短繁中應仍 zh-Hant + skip
  const detectedTrad = await evaluate(`
    window.__SK.detectTextLang(document.getElementById('short-trad').textContent.trim())
  `);
  expect(
    detectedTrad,
    '對照組:短繁中段應仍被偵測為 zh-Hant',
  ).toBe('zh-Hant');
  expect(
    collectedIds,
    '對照組:短繁中段 #short-trad 應被 skip(不誤殺)',
  ).not.toContain('short-trad');

  // 斷言 5: 對照組短英文應 collected
  expect(
    collectedIds,
    '對照組:短英文段 #short-en 應被 collected',
  ).toContain('short-en');

  await page.close();
});
