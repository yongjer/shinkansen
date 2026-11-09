// Unit test: chrome.storage 配額滿 LRU 淘汰（v0.85 regression）
//
// 驗證 cache.js 的 LRU 淘汰機制：
//   1. setBatch 存的值為 { v, t } 結構
//   2. getBatch 讀到舊格式（純字串）正常回傳
//   3. getBatch 命中時更新時間戳
//   4. safeStorageSet 遇 QUOTA_BYTES 錯誤 → 觸發 evictOldest → 重試成功
//   5. evictOldest 按時間戳升序淘汰（t=0 的舊格式最先被淘汰）
//   6. getGlossary / setGlossary 使用 { v, t } 結構
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage.local（帶 in-memory store）────────
let store = {};
let setCallCount = 0;
let removedKeys = [];
// 可選：模擬配額滿（第一次 set 拋錯，之後正常）
let quotaErrorOnNextSet = false;
// H3 race 模擬:設成某 key 時,evictOldest 的「remove 前重讀候選」那次陣列 get
// 會先把該 key 的 timestamp 灌成最新(模擬 snapshot 之後被 flushTouches / setBatch
// touch),用來驗證修法會跳過已被 touch 的 entry。null = 不注入。
let injectTouchKeyOnReRead = null;

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: {
      get: async (keys) => {
        if (keys === null) {
          // get(null) → 回傳所有 entries
          return { ...store };
        }
        // 陣列 get(候選 keys) = evictOldest 的 remove 前重讀。在回傳前注入「被 touch」
        if (injectTouchKeyOnReRead && Array.isArray(keys) && keys.includes(injectTouchKeyOnReRead)
            && store[injectTouchKeyOnReRead]) {
          // 換成新物件(不動 snapshot 持有的舊 reference),t 設成最新
          store[injectTouchKeyOnReRead] = { ...store[injectTouchKeyOnReRead], t: 9_999_999_999 };
        }
        const result = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          if (k in store) result[k] = store[k];
        }
        return result;
      },
      set: async (items) => {
        setCallCount++;
        if (quotaErrorOnNextSet) {
          quotaErrorOnNextSet = false;
          throw new Error('QUOTA_BYTES quota exceeded');
        }
        Object.assign(store, items);
      },
      remove: async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          removedKeys.push(k);
          delete store[k];
        }
      },
    },
  },
};

const { getBatch, setBatch, hashText, getGlossary, setGlossary } =
  await import('../../shinkansen/lib/cache.js');

test.beforeEach(() => {
  store = {};
  setCallCount = 0;
  removedKeys = [];
  quotaErrorOnNextSet = false;
  injectTouchKeyOnReRead = null;
});

test.describe('v0.85 LRU 快取值結構', () => {
  test('setBatch 存的值為 { v, t } 結構', async () => {
    await setBatch(['hello'], ['你好']);
    const hash = await hashText('hello');
    const key = `tc_${hash}`;
    const entry = store[key];
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('v', '你好');
    expect(entry).toHaveProperty('t');
    expect(typeof entry.t).toBe('number');
    expect(entry.t).toBeGreaterThan(0);
  });

  test('getBatch 讀到新格式 { v, t } → 回傳 v', async () => {
    await setBatch(['world'], ['世界']);
    const results = await getBatch(['world']);
    expect(results).toEqual(['世界']);
  });

  test('getBatch 讀到舊格式（純字串）→ 正常回傳', async () => {
    const hash = await hashText('legacy');
    store[`tc_${hash}`] = '舊格式純字串';
    const results = await getBatch(['legacy']);
    expect(results).toEqual(['舊格式純字串']);
  });

  test('getBatch 未命中 → 回傳 null', async () => {
    const results = await getBatch(['not-cached']);
    expect(results).toEqual([null]);
  });

  test('getBatch 命中後更新時間戳（fire-and-forget set 呼叫）', async () => {
    await setBatch(['test'], ['測試']);
    const hash = await hashText('test');
    const key = `tc_${hash}`;
    const origT = store[key].t;

    // 稍等一下確保 Date.now() 會不同
    await new Promise(r => setTimeout(r, 5));
    await getBatch(['test']);

    // fire-and-forget set 是非同步的，等一下讓它完成
    await new Promise(r => setTimeout(r, 10));
    expect(store[key].t).toBeGreaterThanOrEqual(origT);
  });
});

test.describe('v0.85 配額滿 LRU 淘汰', () => {
  test('safeStorageSet 遇 QUOTA_BYTES 錯誤 → 淘汰後重試成功', async () => {
    // 先塞一些舊快取
    const hash1 = await hashText('old1');
    const hash2 = await hashText('old2');
    store[`tc_${hash1}`] = { v: '舊翻譯1', t: 1000 };
    store[`tc_${hash2}`] = { v: '舊翻譯2', t: 2000 };

    // 第一次 set 會拋 QUOTA_BYTES
    quotaErrorOnNextSet = true;

    // setBatch 內部會觸發 safeStorageSet → evictOldest → 重試
    await setBatch(['new'], ['新翻譯']);

    // 驗證淘汰有發生（至少刪了一些 key）
    expect(removedKeys.length).toBeGreaterThan(0);

    // 重試後新值應該寫入成功
    const newHash = await hashText('new');
    expect(store[`tc_${newHash}`]).toBeDefined();
    expect(store[`tc_${newHash}`].v).toBe('新翻譯');
  });

  test('evictOldest 按時間戳升序淘汰（t=0 舊格式最先被淘汰）', async () => {
    // 舊格式（純字串，t=0）和新格式混合
    const hashA = await hashText('a');
    const hashB = await hashText('b');
    const hashC = await hashText('c');
    store[`tc_${hashA}`] = '舊格式A';                        // t=0（最舊）
    store[`tc_${hashB}`] = { v: '新格式B', t: 5000 };       // t=5000
    store[`tc_${hashC}`] = { v: '新格式C', t: Date.now() }; // 最新

    quotaErrorOnNextSet = true;
    await setBatch(['d'], ['D翻譯']);

    // 舊格式 A（t=0）應該最先被淘汰
    expect(removedKeys).toContain(`tc_${hashA}`);
  });
});

test.describe('LRU 淘汰 race 防護(code review 2026-06-09 H3)', () => {
  // SANITY 紀錄(已驗證):把 cache.js evictOldest 的「remove 前重讀候選比對 t」整段
  // 改回直接 remove(toRemove)→ 本 spec fail(被 touch 的 A 仍被刪);還原 → pass。
  test('evictOldest snapshot 後被 touch 的 entry 不應被誤刪', async () => {
    const hashA = await hashText('race-a');
    const hashB = await hashText('race-b');
    const hashC = await hashText('race-c');
    // A 最舊(會排第一個淘汰),但會在 snapshot 之後被 touch
    store[`tc_${hashA}`] = { v: '舊A', t: 1000 };
    store[`tc_${hashB}`] = { v: '舊B', t: 2000 };
    store[`tc_${hashC}`] = { v: '舊C', t: 3000 };

    // 模擬:evictOldest 重讀候選時,A 已被 flushTouches 灌成最新 timestamp
    injectTouchKeyOnReRead = `tc_${hashA}`;

    quotaErrorOnNextSet = true;
    await setBatch(['race-d'], ['D譯']);

    // A 在 snapshot 後變最熱 → 修法應跳過,不在淘汰名單
    expect(removedKeys).not.toContain(`tc_${hashA}`);
    // B / C 沒被 touch,正常淘汰(至少其一被刪,證明淘汰本身有跑)
    expect(removedKeys.length).toBeGreaterThan(0);
  });
});

test.describe('v0.85 術語表快取 LRU', () => {
  test('setGlossary 存 { v, t } 結構', async () => {
    const glossary = [{ source: 'AI', target: '人工智慧' }];
    await setGlossary('abc123', glossary);
    const entry = store['gloss_abc123'];
    expect(entry).toBeDefined();
    expect(entry.v).toEqual(glossary);
    expect(typeof entry.t).toBe('number');
  });

  test('getGlossary 讀新格式 { v, t } → 回傳 v', async () => {
    store['gloss_xyz'] = { v: [{ source: 'B', target: '乙' }], t: Date.now() };
    const result = await getGlossary('xyz');
    expect(result).toEqual([{ source: 'B', target: '乙' }]);
  });

  test('getGlossary 讀舊格式（純 Array）→ 正常回傳', async () => {
    store['gloss_old'] = [{ source: 'C', target: '丙' }];
    const result = await getGlossary('old');
    expect(result).toEqual([{ source: 'C', target: '丙' }]);
  });

  test('getGlossary 不存在 → 回傳 null', async () => {
    const result = await getGlossary('nonexistent');
    expect(result).toBeNull();
  });
});
