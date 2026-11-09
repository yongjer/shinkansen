'use strict';

/**
 * 2026-07-08 code review：clearDocTranslationCache 的 key 比對 regex 失效。
 *
 * 背景：舊 regex `/_doc(_m|$)/` 假設 '_doc' 後面必接 '_m<model>'，但
 * buildCacheKeySuffix（background.js）的組裝順序是
 * cacheTag → '_g<hash>' → '_b<hash>' → '_m<model>' → '_lang' → '_t'。
 * zh-TW 預設使用者有 26 條 forbiddenTerms → doc key 實際長相是
 * `tc_<sha1>_doc_b<hash>_m<model>_t1.00` —— '_doc' 後接 '_b' 不是 '_m'，
 * regex 不命中 → 按「清除所有文件翻譯記憶」實際清 0 筆且無錯誤，改完 doc
 * prompt / 術語表後舊快取照樣命中吐 stale 譯文。修法：改錨定 sha1 後 tag 段的
 * `/^tc_[0-9a-f]{40}(?:_oc)?_doc(?:_|$)/`。
 *
 * 測試手法：cache.js 是 ES module，用 vm sandbox 跑 source（strip import/export，
 * 注入假 browser.storage.local），直接呼叫 clearDocTranslationCache 驗清除集合。
 *
 * 訊號層界定：驗「key 比對規則對各種 suffix 組合的選取正確性」，不驗真實 Chrome
 * storage 的 get(null)/remove 行為，也不驗 buildCacheKeySuffix 端的組裝（那由
 * cache-key-suffix-single-source.test.cjs 鎖）。兩端若未來改組裝順序，本檔的
 * fake key 樣本要跟著 buildCacheKeySuffix 對齊。
 *
 * SANITY 紀錄（已驗證，2026-07-08）：
 *   - 暫時把 cache.js 的 regex 改回 `/_doc(_m|$)/` →「_doc_b 帶 forbiddenTerms
 *     hash 的 entry 有被清」「_oc_doc 也清」兩條 fail；還原 → pass
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCacheModule(fakeStore) {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../shinkansen/lib/cache.js'),
    'utf-8'
  );
  const stripped = src
    .replace(/^import\s+[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(const|let)\s+/gm, 'var ')
    .replace(/^export\s+(function|async\s+function)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+default\s+/gm, '');
  const removed = [];
  const browserStub = {
    storage: {
      local: {
        async get(arg) {
          if (arg === null) return { ...fakeStore };
          return {};
        },
        async remove(keys) {
          removed.push(...(Array.isArray(keys) ? keys : [keys]));
        },
        async set() {},
        async getBytesInUse() { return 0; },
      },
      onChanged: { addListener() {} },
    },
  };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Promise, Date, Number, String,
    Object, Array, Math, JSON, TextEncoder,
    browser: browserStub,
    debugLog: async () => {},
    crypto: { subtle: { digest: async () => new ArrayBuffer(20) } },
  });
  vm.runInNewContext(stripped, ctx, { filename: 'cache.js' });
  return { ctx, removed };
}

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('clearDocTranslationCache key 比對（2026-07-08 regex 修正）', () => {
  test('帶 _b / _g hash 的 _doc entry 要被清（zh-TW 預設 forbiddenTerms 場景）', async () => {
    const { ctx, removed } = loadCacheModule({
      [`tc_${SHA}_doc_b1a2b3c4d5e6_mgemini-3-flash-lite_t1.00`]: 'x',
      [`tc_${SHA2}_doc_gaabbccddeeff_mgemini-3-flash_t0.20`]: 'x',
    });
    const n = await ctx.clearDocTranslationCache();
    expect(n).toBe(2);
    expect(removed).toHaveLength(2);
  });

  test('_oc_doc（自訂 provider 文件路徑）也清', async () => {
    const { ctx, removed } = loadCacheModule({
      [`tc_${SHA}_oc_doc_b1a2b3c4d5e6_mhash_model`]: 'x',
    });
    const n = await ctx.clearDocTranslationCache();
    expect(n).toBe(1);
    expect(removed).toEqual([`tc_${SHA}_oc_doc_b1a2b3c4d5e6_mhash_model`]);
  });

  test('非 doc entry 不誤清（網頁 / 字幕 / glossary / model 名含 _doc 的邊角）', async () => {
    const { ctx, removed } = loadCacheModule({
      [`tc_${SHA}_mgemini-3-flash`]: 'x',            // 網頁翻譯
      [`tc_${SHA}_yt_mgemini-3-flash-lite`]: 'x',    // 字幕
      [`tc_${SHA}_oc_yt_mhash_model`]: 'x',          // 自訂字幕
      [`gloss_${SHA}`]: 'x',                          // glossary（非 tc_ 前綴）
      // model 名經 sanitize 後含 "_doc_" 的病態 case：tag 段錨定必須不命中
      [`tc_${SHA}_mmy_doc_model`]: 'x',
    });
    const n = await ctx.clearDocTranslationCache();
    expect(n).toBe(0);
    expect(removed).toHaveLength(0);
  });

  // v2.0.11 EPUB：bookgloss_<書指紋> 是全書術語表持久化 key，屬文件翻譯 cache
  // 範疇，「清除所有文件翻譯記憶」要一併清；gloss_（頁面/單輪抽取快取）不受影響
  test('bookgloss_ 前綴（EPUB 全書術語表）一併清，gloss_ 不誤清', async () => {
    const { ctx, removed } = loadCacheModule({
      [`bookgloss_${SHA}`]: { glossary: [], updatedAt: 0 },
      [`gloss_${SHA}`]: 'x',
    });
    const n = await ctx.clearDocTranslationCache();
    expect(n).toBe(1);
    expect(removed).toEqual([`bookgloss_${SHA}`]);
  });
});
