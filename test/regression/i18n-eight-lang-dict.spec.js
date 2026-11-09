// Regression: P3 (v1.8.62) UI dict 8 語齊備 — 結構完整性檢查
//
// 涵蓋(對應 lib/i18n.js TABLES + SUPPORTED_UI_LANGS):
//   1. TABLES 必須有 8 entry(zh-TW / zh-CN / en / ja / ko / es / fr / de)
//   2. 8 dict key set 完全對齊 zh-TW source(避免新增 / 移除 key 時某語漏改)
//   3. 8 dict 對應同一 key 的 placeholder({version} / {count} 等)集合一致
//      —— 翻譯時保留 placeholder 不可變動;若 placeholder 變動,t() 內 interp 會失敗
//
// SANITY 紀錄(已驗證):刪 messages_ja 的某 key → spec 1 + 2 同時 fail。還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'lang-detect';

async function load(page, localServer) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });
  return await getShinkansenEvaluator(page);
}

const LANGS = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'];

test('TABLES 8 entry 全齊 + SUPPORTED_UI_LANGS 列出 8 語', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);
  const tables = await evaluate('Object.keys(window.__SK.i18n._tables)');
  expect(tables.sort()).toEqual([...LANGS].sort());
  const supported = await evaluate('window.__SK.i18n._supported');
  expect(supported.sort()).toEqual([...LANGS].sort());
});

test('8 dict key set 完全對齊 zh-TW source(無漏 key、無多 key)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);
  const sourceKeys = await evaluate('Object.keys(window.__SK.i18n._tables["zh-TW"]).sort()');
  for (const lang of LANGS.filter(l => l !== 'zh-TW')) {
    const keys = await evaluate(`Object.keys(window.__SK.i18n._tables[${JSON.stringify(lang)}]).sort()`);
    expect(keys, `${lang} dict key 與 zh-TW source 不一致`).toEqual(sourceKeys);
  }
});

test('8 dict 對應同 key 的 placeholder set 一致(翻譯保留 {name} 不變)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);

  // 抽樣帶 placeholder 的代表 key
  const SAMPLE_KEYS = [
    'popup.banner.welcome',          // {version}
    'popup.banner.updateNoticeVersion', // {newVersion} {currentVersion}
    'popup.cache.value',             // {count} {bytes}
    'popup.usage.value',             // {cost} {tokens}
    'popup.status.editMode',         // {count}
    'popup.status.cacheCleared',     // {count}
    'toast.translateProgress',       // {prefix} {done} {total}
    'options.gemini.cost.estimateGlossary.html',  // {count} {tok} {usd} {usdCache}
    'options.usage.pageInfo',        // {page} {total} {count}
  ];

  for (const key of SAMPLE_KEYS) {
    const sourceStr = await evaluate(`window.__SK.i18n._tables["zh-TW"][${JSON.stringify(key)}]`);
    const sourceSet = new Set([...sourceStr.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
    for (const lang of LANGS.filter(l => l !== 'zh-TW')) {
      const langStr = await evaluate(`window.__SK.i18n._tables[${JSON.stringify(lang)}][${JSON.stringify(key)}]`);
      const langSet = new Set([...langStr.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
      expect([...langSet].sort(), `${lang}.${key}: placeholder 與 zh-TW 不一致`).toEqual([...sourceSet].sort());
    }
  }
});

test('5 新語 dict 抽樣字串非空、非繁中(避免漏翻殘留)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);
  // 抽樣每語的 popup.action.translate(各語應有不同表達)
  const checks = {
    ja: 'このページを翻訳',
    ko: '이 페이지 번역',
    es: 'Traducir página',
    fr: 'Traduire la page',
    de: 'Seite übersetzen',
  };
  for (const [lang, expected] of Object.entries(checks)) {
    const v = await evaluate(`window.__SK.i18n._tables[${JSON.stringify(lang)}]["popup.action.translate"]`);
    expect(v).toBe(expected);
    // 額外保險:不可包含繁中代表字「翻譯本頁」(若殘留即漏翻)
    expect(v).not.toBe('翻譯本頁');
  }
});
