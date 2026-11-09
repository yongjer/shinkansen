'use strict';

/**
 * Regression(code review 2026-06-09 M4,pending queue 補測 2026-06-10):
 *   lib/usage-db.js getDB() singleton 連線失效後自我重建。
 *
 * 背景 bug(潛在,靜默失敗):
 *   getDB() 用 module-level `_dbPromise` cache 唯一連線。瀏覽器在儲存壓力下會強制
 *   關閉 IndexedDB 連線(觸發 db.onclose),或其他 context 升級 DB 時要求本連線關閉
 *   (db.onversionchange)。若 `_dbPromise` 沒在這兩種情況失效,它會 cache 著一條死
 *   連線,後續 db.transaction() 一律丟 InvalidStateError → 所有 usage 寫入靜默失敗,
 *   直到 service worker 重啟才恢復。使用者完全無感(只是對帳數字悄悄少算)。
 *
 * 修法(usage-db.js):req.onsuccess 內對 db 掛
 *   db.onclose        = () => { if (_db === db) { _db = null; _dbPromise = null; } }
 *   db.onversionchange= () => { db.close(); if (_db === db) { _db = null; _dbPromise = null; } }
 *   `_db === db` guard 確保只在「關閉的是當前連線」時失效——避免舊連線晚到的 onclose
 *   把剛重建的新連線誤殺。
 *
 * 本 spec 鎖的訊號層(明確界定,見 CLAUDE.md 工作流原則 §3):
 *   驗「連線失效後的記帳邏輯」——onclose / onversionchange 觸發後 _dbPromise 是否重建、
 *   `_db === db` guard 是否擋掉 stale onclose 誤殺。
 *   不驗(harness 到不了的層):真實瀏覽器在儲存壓力下到底會不會 fire onclose、重建後
 *   的真實 transaction 是否成功——那需要真瀏覽器環境,fake-indexeddb 也模擬不出儲存
 *   壓力驅逐,故不引入該 dep。會 regress 的點正是這段記帳邏輯,所以這層有測試價值。
 *
 * 用假 indexedDB.open 替身(回 req,microtask fire onsuccess 帶全新 fake db),
 * 觀測 openCount + getDB() 回傳的 db 物件 identity 判斷「有沒有重建 / 用的是哪條連線」。
 *
 * SANITY CHECK 紀錄(已驗證,2026-06-10):
 *   把 usage-db.js onclose 的 `if (_db === db)` 改成無條件 null(拿掉 guard)→
 *   stale onclose 測試 fail(db1 晚到的 onclose 把當前 db2 的 _dbPromise 清掉 →
 *   下次 getDB 重開出 db3 ≠ db2)。還原 guard 後 pass。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

// 同 exchange-rate-and-format.test.cjs 的 loadEsmAsSandbox:讀 ES module source、
// 剝掉 import / export keyword,跑進可控 vm context。getDB 是 function declaration
// (非 export),strip 後 hoist 到 context object 上 → ctx.getDB 直接可呼叫。
function loadUsageDb(sandbox) {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../shinkansen/lib/usage-db.js'),
    'utf-8',
  );
  const stripped = src
    .replace(/^import\s+[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(const|let)\s+/gm, 'var ')
    .replace(/^export\s+(function|async\s+function)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout,
    Promise, Date, Number, String, Object, Array, Math, JSON,
    ...sandbox,
  });
  vm.runInNewContext(stripped, ctx, { filename: 'usage-db.js' });
  return ctx;
}

// 假 IndexedDB:每次 open() 產一條全新 fake 連線,microtask fire onsuccess。
// 回傳的 db 物件 identity 讓 spec 分辨「是否同一條連線」。
function makeFakeIndexedDB() {
  const state = { openCount: 0, dbs: [] };
  const indexedDB = {
    open() {
      state.openCount += 1;
      const db = {
        _id: state.openCount,
        _closed: false,
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex: () => {} }),
        close() { this._closed = true; },
        // transaction 這幾條測試用不到(只驗連線重建記帳),留個 stub 不致 throw
        transaction: () => ({ objectStore: () => ({}) }),
        onclose: null,
        onversionchange: null,
      };
      state.dbs.push(db);
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
      // 等 getDB 把 onsuccess 掛上後才 fire
      Promise.resolve().then(() => { if (req.onsuccess) req.onsuccess(); });
      return req;
    },
  };
  return { indexedDB, state };
}

describe('usage-db getDB 連線失效自我重建(M4)', () => {
  test('正常情況:getDB 是 singleton,多次呼叫共用同一條連線', async () => {
    const { indexedDB, state } = makeFakeIndexedDB();
    const ctx = loadUsageDb({ indexedDB });

    const db1 = await ctx.getDB();
    const db1b = await ctx.getDB();

    expect(state.openCount).toBe(1);          // 只開一次
    expect(db1b).toBe(db1);                    // 共用同一連線
  });

  test('onclose 觸發 → 下次 getDB 重建新連線', async () => {
    const { indexedDB, state } = makeFakeIndexedDB();
    const ctx = loadUsageDb({ indexedDB });

    const db1 = await ctx.getDB();
    expect(state.openCount).toBe(1);

    // 模擬瀏覽器強制關閉當前連線
    db1.onclose();

    const db2 = await ctx.getDB();
    expect(state.openCount).toBe(2);           // 重新 open
    expect(db2).not.toBe(db1);                 // 是新連線
  });

  test('onversionchange 觸發 → close 舊連線 + 下次 getDB 重建', async () => {
    const { indexedDB, state } = makeFakeIndexedDB();
    const ctx = loadUsageDb({ indexedDB });

    const db1 = await ctx.getDB();
    db1.onversionchange();

    expect(db1._closed).toBe(true);            // 主動 close 讓升級進行
    const db2 = await ctx.getDB();
    expect(state.openCount).toBe(2);
    expect(db2).not.toBe(db1);
  });

  test('stale onclose 不誤殺新連線(_db === db guard)', async () => {
    const { indexedDB, state } = makeFakeIndexedDB();
    const ctx = loadUsageDb({ indexedDB });

    const db1 = await ctx.getDB();
    db1.onclose();                             // db1 失效
    const db2 = await ctx.getDB();             // 重建出 db2(當前連線)
    expect(state.openCount).toBe(2);

    // db1 的 onclose 晚到再 fire 一次——此時當前連線已是 db2,guard 應擋下
    db1.onclose();

    const db2b = await ctx.getDB();
    expect(state.openCount).toBe(2);           // 不該因 stale onclose 重開
    expect(db2b).toBe(db2);                    // 仍是 db2,沒被誤殺
  });
});
