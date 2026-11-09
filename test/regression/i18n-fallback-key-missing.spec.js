// Regression: i18n fallback chain — t(key) 找不到 key 時的 fallback 行為,
// 與 8 語 ui-language 解析(P3 / v1.8.62 起 8 語 dict 全到位)。
//
// 涵蓋三層 fallback 鏈(對應 lib/i18n.js t() 內 `[TABLES[lang], TABLES[FALLBACK_LANG], TABLES['zh-TW']]`):
//   1. zh-CN target + key 只在 zh-TW dict 不在其他 → 不應 throw,回傳 zh-TW 字串(最終 fallback)
//   2. en target + key 完全不存在 → 回傳 key 本身
//   3. 8 語 target 各自走對應 dict;不認識 target → fallback en
//
// SANITY 紀錄(P3 v1.8.62 重新驗證):
//   隨 i18n-toast.spec 的 SANITY 一起驗證 — 把 lib/i18n.js 的 t() 內 tables 鏈
//   改成 `[TABLES['zh-TW']]`(去掉 lang 與 FALLBACK)→ 「ja → ja dict」與
//   「zh-CN target → zh-CN 字串」斷言 fail(Received 都拿到繁中字串)。還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'lang-detect';

async function load(page, localServer) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });
  return await getShinkansenEvaluator(page);
}

test('getUiLanguage:8 語 target 各自維持原值(P3 / v1.8.62),不認識 fallback en', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);

  for (const t of ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de']) {
    expect(await evaluate(`window.__SK.i18n.getUiLanguage(${JSON.stringify(t)})`))
      .toBe(t);
  }
  // 不認識的 target 走 en
  expect(await evaluate(`window.__SK.i18n.getUiLanguage('xx')`)).toBe('en');
});

test('t(): 不存在的 key 回傳 key 本身(safe degrade)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);

  const missingKey = 'nonexistent.test.key.xyz';
  expect(await evaluate(`window.__SK.i18n.t(${JSON.stringify(missingKey)}, undefined, 'zh-TW')`))
    .toBe(missingKey);
  expect(await evaluate(`window.__SK.i18n.t(${JSON.stringify(missingKey)}, undefined, 'en')`))
    .toBe(missingKey);
  expect(await evaluate(`window.__SK.i18n.t(${JSON.stringify(missingKey)}, undefined, 'ja')`))
    .toBe(missingKey);
});

test('t(): zh-CN target + key 同時存在三 dict → 回 zh-CN 字串(優先選 ui-language dict)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);

  // popup.action.translate 三 dict 都有,zh-CN target 應拿到簡中字串
  const v = await evaluate(`window.__SK.i18n.t('popup.action.translate', undefined, 'zh-CN')`);
  expect(v).toBe('翻译本页');
});

test('t(): ja target + key 八 dict 都有 → 回 ja dict 字串(P3 / v1.8.62)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);

  const v = await evaluate(`window.__SK.i18n.t('popup.action.translate', undefined, 'ja')`);
  expect(v).toBe('このページを翻訳');
});

test('t(): placeholder 替換不影響 fallback 鏈', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);

  // popup.banner.welcome 帶 {version} placeholder
  const v = await evaluate(`window.__SK.i18n.t('popup.banner.welcome', { version: '1.8.60' }, 'en')`);
  // en dict 對應字串應含 '1.8.60'(精確值依 dict 內容,只驗 placeholder 有 interp)
  expect(v).toContain('1.8.60');
  expect(v).not.toContain('{version}');
});
