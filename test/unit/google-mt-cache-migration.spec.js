// Unit test: v1.9.8 migrateClearGoogleMtCacheOnce
//
// 驗證一次性清除 Google MT cache 的 migration helper:
//   (1) 只清 tc_<sha1>_gt[_drive|_yt|_lang*] entry,Gemini / openai-compat /
//       Drive viewer / glossary 等其他 prefix 全部保留
//   (2) flag 設過後不再跑,onStartup / onInstalled / sw-init 三處呼叫只清一次
//   (3) cleared 計數正確、ranMigration 旗標正確
//
// Why scope 只清 _gt:v1.9.8 garbage 只發生在 Google MT 混批路徑,Gemini /
// openai-compat 不受影響。整個 tc_* 一鍵砍會讓使用者 Gemini 已付費翻譯成本
// 白白浪費(cache.js line 451-454 設計意圖)。
//
// Mock 策略:globalThis.chrome = { storage: { local: { get, set, remove } } }
// 用 in-memory store 模擬 chrome.storage.local。compat.js 走 Proxy 每次 access
// 都重讀 globalThis.chrome,所以 spec beforeEach 重設 store 即可隔離。
import { test, expect } from '@playwright/test';

let store = {};

function setupMockChrome() {
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...store };
          if (typeof keys === 'string') return { [keys]: store[keys] };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = store[k];
            return out;
          }
          // object form
          const out = {};
          for (const k of Object.keys(keys)) out[k] = store[k] ?? keys[k];
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete store[k];
        },
      },
    },
  };
}

// dynamic import 之後 compat.js Proxy 每次 access 才解析 globalThis.chrome,
// 所以 mock 必須在 import 前 setup 才能保證 import 時序內 Proxy 看得到。
setupMockChrome();
const { migrateClearGoogleMtCacheOnce } = await import('../../shinkansen/lib/cache.js');

const FLAG = '__shinkansen_v198_google_mt_cache_cleared';
const SHA = 'a'.repeat(40); // 40 hex chars
const SHA2 = 'b'.repeat(40);

test.beforeEach(() => {
  store = {};
});

test('migrateClearGoogleMtCacheOnce: 只清 tc_<sha1>_gt[*] 不動 Gemini / openai-compat cache', async () => {
  // 各 provider 的 cache key shape
  store = {
    // Google MT(應清)
    [`tc_${SHA}_gt`]: { v: 'GT-WEB', t: 1 },
    [`tc_${SHA2}_gt_drive`]: { v: 'GT-DRIVE', t: 1 },
    [`tc_${SHA}_gt_yt`]: { v: 'GT-YT', t: 1 },
    [`tc_${SHA2}_gt_langja`]: { v: 'GT-JA', t: 1 },
    [`tc_${SHA}_gt_drive_langzhCN`]: { v: 'GT-DRIVE-ZHCN', t: 1 },
    // Gemini / openai-compat / 其他 provider(不該動)
    [`tc_${SHA}`]: { v: 'GEMINI-WEB', t: 1 },
    [`tc_${SHA2}_yt`]: { v: 'GEMINI-YT', t: 1 },
    [`tc_${SHA}_doc`]: { v: 'GEMINI-DOC', t: 1 },
    [`tc_${SHA2}_oc_yt`]: { v: 'OPENAI-COMPAT-YT', t: 1 },
    [`tc_${SHA}_yt_asr`]: { v: 'GEMINI-ASR', t: 1 },
    [`tc_${SHA2}_drive_yt_asr`]: { v: 'GEMINI-DRIVE-ASR', t: 1 },
    [`tc_${SHA}_langja`]: { v: 'GEMINI-JA', t: 1 },
    // 非 tc_ prefix(完全不該動)
    [`gloss_${SHA}`]: { v: 'GLOSSARY', t: 1 },
    apiKey: 'AIza...',
    settings: { displayMode: 'single' },
    __cacheVersion: '1.9.7',
  };

  const r = await migrateClearGoogleMtCacheOnce(FLAG);

  expect(r.ranMigration).toBe(true);
  expect(r.cleared).toBe(5); // 5 個 _gt entry

  // _gt entry 全清
  expect(store[`tc_${SHA}_gt`]).toBeUndefined();
  expect(store[`tc_${SHA2}_gt_drive`]).toBeUndefined();
  expect(store[`tc_${SHA}_gt_yt`]).toBeUndefined();
  expect(store[`tc_${SHA2}_gt_langja`]).toBeUndefined();
  expect(store[`tc_${SHA}_gt_drive_langzhCN`]).toBeUndefined();

  // Gemini / openai-compat 等其他 provider cache 全保留
  expect(store[`tc_${SHA}`]).toBeDefined();
  expect(store[`tc_${SHA2}_yt`]).toBeDefined();
  expect(store[`tc_${SHA}_doc`]).toBeDefined();
  expect(store[`tc_${SHA2}_oc_yt`]).toBeDefined();
  expect(store[`tc_${SHA}_yt_asr`]).toBeDefined();
  expect(store[`tc_${SHA2}_drive_yt_asr`]).toBeDefined();
  expect(store[`tc_${SHA}_langja`]).toBeDefined();

  // 非 cache key 完全不動
  expect(store[`gloss_${SHA}`]).toBeDefined();
  expect(store.apiKey).toBe('AIza...');
  expect(store.settings).toEqual({ displayMode: 'single' });
  expect(store.__cacheVersion).toBe('1.9.7');

  // flag 設好
  expect(store[FLAG]).toBe(true);
});

test('migrateClearGoogleMtCacheOnce: flag 已設過 → no-op,cleared=0、ranMigration=false', async () => {
  store = {
    [FLAG]: true,
    [`tc_${SHA}_gt`]: { v: 'GT', t: 1 },
  };

  const r = await migrateClearGoogleMtCacheOnce(FLAG);

  expect(r.ranMigration).toBe(false);
  expect(r.cleared).toBe(0);
  // entry 應該還在(因為跳過 migration)
  expect(store[`tc_${SHA}_gt`]).toBeDefined();
});

test('migrateClearGoogleMtCacheOnce: 沒有任何 _gt entry → cleared=0、ranMigration=true、flag 仍設', async () => {
  store = {
    [`tc_${SHA}`]: { v: 'GEMINI', t: 1 },
    [`tc_${SHA2}_yt`]: { v: 'GEMINI-YT', t: 1 },
  };

  const r = await migrateClearGoogleMtCacheOnce(FLAG);

  expect(r.ranMigration).toBe(true);
  expect(r.cleared).toBe(0);
  expect(store[`tc_${SHA}`]).toBeDefined();
  expect(store[`tc_${SHA2}_yt`]).toBeDefined();
  expect(store[FLAG]).toBe(true);
});

test('migrateClearGoogleMtCacheOnce: 連 sha1 後第一格不是 _gt 不誤刪(forcing function 防 regex 寫鬆)', async () => {
  store = {
    [`tc_${SHA}_yt`]: { v: 'GEMINI-YT', t: 1 },         // sha1 後是 _yt(Gemini)
    [`tc_${SHA2}_oc_yt`]: { v: 'OPENAI-YT', t: 1 },     // sha1 後是 _oc_yt(openai-compat)
    [`tc_${SHA}_yt_gt`]: { v: 'FAKE', t: 1 },           // 假 entry,sha1 後是 _yt 但末尾有 _gt → 不該被誤刪
    [`tc_${SHA2}_gt`]: { v: 'REAL-GT', t: 1 },          // 真 Google MT
  };

  const r = await migrateClearGoogleMtCacheOnce(FLAG);

  expect(r.cleared).toBe(1);
  expect(store[`tc_${SHA}_yt`]).toBeDefined();
  expect(store[`tc_${SHA2}_oc_yt`]).toBeDefined();
  expect(store[`tc_${SHA}_yt_gt`]).toBeDefined(); // 末尾含 _gt 但邊界不對,不清
  expect(store[`tc_${SHA2}_gt`]).toBeUndefined(); // 真 _gt 才清
});

// SANITY check(已驗證):
//   把 cache.js migrateClearGoogleMtCacheOnce 的 gtRe 改為 /_gt/(寬鬆寫法)→
//   第 4 條測試 cleared 變 2(_yt_gt 假 entry 也被掃),斷言 fail。
//   還原為 /^tc_[0-9a-f]{40}_gt/ 後 pass。
