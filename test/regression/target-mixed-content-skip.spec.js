// Regression: P1 (v1.8.59) mixed-content fragment 抽取路徑也走 target-aware skip
//
// Bug 來源:Jimmy 實測 https://www.upmedia.mg/tw/focus/society/258166 target=en,
// 內文翻成英文但「標題沒翻」── 標題結構是 `<h1>...<span>...</span>...</h1>` 屬於
// mixed-content,走 fragment 抽取路徑,該路徑寫死 `SK.isTraditionalChinese(trimmed)`
// 跳「已是繁中」── 對 target=en 第一次翻譯時誤把繁中標題當「已是 target」直接跳。
//
// 修法:`content-detect.js` line 332 改成 `SK.isAlreadyInTarget(trimmed, target)` ──
// target 從 STATE 讀,跟 isCandidateText 一致。
//
// 設計目的(原 v1.2.0):fragment 注入後父元素不帶 data-shinkansen-translated,
// SPA observer rescan 看到譯文 textContent 會無限迴圈;此檢查跳「已是 target 語言」的
// fragment(已翻譯,不該再收)。原邏輯只考慮 target=zh-TW,P1 多 target 後要 generalize。

// SANITY-PENDING: 把 content-detect.js line 332 的判定改回
// `SK.isTraditionalChinese(trimmed)`(寫死 zh-TW),target=en 跑時 trad-mixed-heading
// 跟 trad-mixed-paragraph 兩個繁中 mixed-content 段落會被誤跳,斷言 fail。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'target-mixed-content';

async function loadAndCollect(page, localServer, target) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.STATE.targetLanguage = '${target}'`);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphs())
  `);
  const units = JSON.parse(result);
  return units.filter((u) => u.id).map((u) => u.id);
}

test('target=en: 繁中 mixed-content 標題 / 段落都進候選(本 bug 修復點)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  const ids = await loadAndCollect(page, localServer, 'en');

  expect(ids, '繁中 mixed-content 標題 #trad-mixed-heading 應進候選(target=en)').toContain('trad-mixed-heading');
  expect(ids, '繁中 mixed-content 段落 #trad-mixed-paragraph 應進候選').toContain('trad-mixed-paragraph');
  expect(ids, '繁中純文字段落 #trad-plain 應進候選').toContain('trad-plain');
  expect(ids, '英文 mixed-content 標題 #en-mixed-heading 應被跳(target=en 已是英文)').not.toContain('en-mixed-heading');
  expect(ids, '英文純文字段落 #en-plain 應被跳(target=en 已是英文)').not.toContain('en-plain');
});

test('target=zh-TW: 繁中 mixed-content 段落都被跳(維持 v1.8.58 行為)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  const ids = await loadAndCollect(page, localServer, 'zh-TW');

  expect(ids, '繁中 mixed-content 標題 #trad-mixed-heading 應被跳').not.toContain('trad-mixed-heading');
  expect(ids, '繁中 mixed-content 段落 #trad-mixed-paragraph 應被跳').not.toContain('trad-mixed-paragraph');
  expect(ids, '繁中純文字段落 #trad-plain 應被跳').not.toContain('trad-plain');
  expect(ids, '英文 mixed-content 標題 #en-mixed-heading 應進候選').toContain('en-mixed-heading');
  expect(ids, '英文純文字段落 #en-plain 應進候選').toContain('en-plain');
});

test('target=zh-CN: 繁中 / 英文都進候選(都不是簡中)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  const ids = await loadAndCollect(page, localServer, 'zh-CN');

  expect(ids, '繁中 mixed-content 標題應進候選(target=zh-CN 要把繁中翻簡中)').toContain('trad-mixed-heading');
  expect(ids, '繁中 mixed-content 段落應進候選').toContain('trad-mixed-paragraph');
  expect(ids, '英文 mixed-content 標題應進候選(target=zh-CN 要翻英文成簡中)').toContain('en-mixed-heading');
});

// SANITY 紀錄(已驗證):
//   把 content-detect.js line 332 的判定改回
//   `SK.isTraditionalChinese(trimmed)` 寫死 zh-TW →
//   - target=en case 「繁中 mixed-content 應進候選」三條斷言全 fail(被誤跳)
//   - target=zh-CN case 「繁中 mixed-content 應進候選」兩條斷言 fail
//   還原後三 case 都 pass。
