// Regression: P1 (v1.8.59) target-aware「源語言已等於目標語言」跳過邏輯
//
// 對應 plan §10 Q5 拍板:`isTraditionalChinese` → `isAlreadyInTarget`,
// 來源語言偵測改成依 STATE.targetLanguage 動態比對。
//
// Fixture: 沿用既有 lang-detect.html(已含繁中 / 簡中 / 英文 / 日文 / 混合段)
// 結構: 同 detect-lang.spec.js 用的 fixture
//
// 行為通則(v1.8.58 之前固定 zh-TW;P1 改成依 STATE.targetLanguage):
//   target='zh-TW' → 跳 'zh-Hant'(維持原行為,detect-lang.spec.js 既有測試涵蓋)
//   target='zh-CN' → 跳 'zh-Hans',繁中 / 英文進候選
//   target='en'    → 跳 'en',繁中 / 簡中進候選

// SANITY 紀錄(已驗證):把 isCandidateText 內 `isAlreadyInTarget(text, target)` 改回
// 硬寫 `isTraditionalChinese(text)` → target=zh-CN 與 target=en 兩條 case fail
// (簡中段 / 英文段被誤跳)。還原 → 全 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'lang-detect';

async function loadAndCollect(page, localServer, target) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 直接設 SK.STATE.targetLanguage(模擬 content.js translatePage 開頭注入)
  await evaluate(`window.__SK.STATE.targetLanguage = '${target}'`);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphs())
  `);
  const units = JSON.parse(result);
  return units.filter((u) => u.id).map((u) => u.id);
}

test('target=zh-TW: 繁中段被跳、簡中 / 英文進候選(維持 v1.8.58 行為)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  const ids = await loadAndCollect(page, localServer, 'zh-TW');

  expect(ids, '繁中段 #trad-chinese 應被跳過(target=zh-TW)').not.toContain('trad-chinese');
  expect(ids, '簡中段 #simplified-chinese 應進候選').toContain('simplified-chinese');
  expect(ids, '英文段 #english 應進候選').toContain('english');
});

test('target=zh-CN: 簡中段被跳、繁中 / 英文進候選', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  const ids = await loadAndCollect(page, localServer, 'zh-CN');

  expect(ids, '簡中段 #simplified-chinese 應被跳過(target=zh-CN)').not.toContain('simplified-chinese');
  expect(ids, '繁中段 #trad-chinese 應進候選(zh-CN target 要把繁中翻成簡中)').toContain('trad-chinese');
  expect(ids, '英文段 #english 應進候選').toContain('english');
});

test('target=en: 英文段被跳、繁中 / 簡中進候選', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  const ids = await loadAndCollect(page, localServer, 'en');

  expect(ids, '英文段 #english 應被跳過(target=en)').not.toContain('english');
  expect(ids, '繁中段 #trad-chinese 應進候選(en target 要翻成英文)').toContain('trad-chinese');
  expect(ids, '簡中段 #simplified-chinese 應進候選').toContain('simplified-chinese');
});

// SANITY 紀錄(已驗證):
//   把 content-detect.js 的 isCandidateText 內
//     `const target = SK.STATE?.targetLanguage || 'zh-TW';
//      if (SK.isAlreadyInTarget(text, target)) return false;`
//   改回 `if (SK.isTraditionalChinese(text)) return false;`(寫死 zh-TW)→
//   - zh-CN target test 的「簡中段該被跳」會 fail(簡中段被收進候選)
//   - en target test 的「英文段該被跳」會 fail(英文段被收進候選)
//   還原後三條都 pass。
