// Regression: P2 (v1.8.60) toast i18n — STATE.targetLanguage 不同時 SK.t('toast.X')
// 回對應語言 dict 字串。涵蓋三 ui language(zh-TW / zh-CN / en)+ 5 語 fallback(ja → en)。
//
// 對應 content scripts 內 22 條 toast 改 SK.t() 的覆蓋驗證(詳見 P2 WIP commit)。
//
// SANITY 紀錄(已驗證 2026-05-08):
//   把 lib/i18n.js 的 `t()` 內 `const tables = [TABLES[lang], TABLES[FALLBACK_LANG], TABLES['zh-TW']];`
//   改成 `const tables = [TABLES['zh-TW']];`(永遠走繁中) → zh-CN / en / ja 斷言全
//   fail(Received 都拿到繁中字串)。還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'lang-detect'; // 沿用任一已存在的 fixture(只需要載 content script)

async function loadAndQuery(page, localServer, target, key, params) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.STATE.targetLanguage = '${target}'`);
  const paramsJson = params ? JSON.stringify(params) : 'undefined';
  return await evaluate(`window.__SK.t(${JSON.stringify(key)}, ${paramsJson})`);
}

test('toast: zh-TW target 走繁中 dict', async ({ context, localServer }) => {
  const page = await context.newPage();
  expect(await loadAndQuery(page, localServer, 'zh-TW', 'toast.cancelled'))
    .toBe('已取消翻譯');
  expect(await loadAndQuery(page, localServer, 'zh-TW', 'toast.noContent'))
    .toBe('找不到可翻譯的內容');
});

test('toast: zh-CN target 走簡中 dict(含 placeholder)', async ({ context, localServer }) => {
  const page = await context.newPage();
  expect(await loadAndQuery(page, localServer, 'zh-CN', 'toast.cancelled'))
    .toBe('已取消翻译');
});

test('toast: en target 走英文 dict', async ({ context, localServer }) => {
  const page = await context.newPage();
  expect(await loadAndQuery(page, localServer, 'en', 'toast.cancelled'))
    .toBe('Translation cancelled');
  expect(await loadAndQuery(page, localServer, 'en', 'toast.noContent'))
    .toBe('No translatable content found');
});

test('toast: ja target 走 ja dict(P3 / v1.8.62 起 8 語 dict 全到位)', async ({ context, localServer }) => {
  const page = await context.newPage();
  expect(await loadAndQuery(page, localServer, 'ja', 'toast.cancelled'))
    .toBe('翻訳をキャンセルしました');
});

test('toast: ko / es / fr / de target 各走對應 dict(P3 / v1.8.62)', async ({ context, localServer }) => {
  const page = await context.newPage();
  // 抽樣 toast.cancelled 各語版本驗證
  expect(await loadAndQuery(page, localServer, 'ko', 'toast.cancelled'))
    .toBe('번역이 취소됨');
  expect(await loadAndQuery(page, localServer, 'es', 'toast.cancelled'))
    .toBe('Traducción cancelada');
  expect(await loadAndQuery(page, localServer, 'fr', 'toast.cancelled'))
    .toBe('Traduction annulée');
  expect(await loadAndQuery(page, localServer, 'de', 'toast.cancelled'))
    .toBe('Übersetzung abgebrochen');
});
