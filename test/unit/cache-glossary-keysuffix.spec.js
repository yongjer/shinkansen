// Unit test: cache.js 的 keySuffix 參數（v0.70 regression）
//
// 驗證 getBatch/setBatch 的 keySuffix 參數正確分區快取。
// 同一段原文在有術語表 vs 無術語表時應該分開快取，
// 否則啟用術語表後仍會拿到舊（無術語表版本的）翻譯。
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage.local（in-memory）──────────────────────
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys === null) return { ...store };
        if (typeof keys === 'string') keys = [keys];
        const result = {};
        for (const k of keys) {
          if (k in store) result[k] = store[k];
        }
        return result;
      },
      set: async (items) => { Object.assign(store, items); },
      remove: async (keys) => {
        if (typeof keys === 'string') keys = [keys];
        for (const k of keys) delete store[k];
      },
    },
  },
};

// cache.js 無外部 import，只依賴 chrome.storage.local + crypto.subtle（Node 18+ 內建）
const { getBatch, setBatch, hashText } = await import('../../shinkansen/lib/cache.js');

function clearStore() {
  for (const k of Object.keys(store)) delete store[k];
}

test.beforeEach(() => { clearStore(); });

test.describe('cache keySuffix 分區', () => {
  test('same text + same suffix → cache hit', async () => {
    await setBatch(['hello'], ['你好'], '_gABCD');
    const result = await getBatch(['hello'], '_gABCD');
    expect(result[0]).toBe('你好');
  });

  test('same text + different suffix → cache miss', async () => {
    await setBatch(['hello'], ['你好'], '_gABCD');
    const noSuffix = await getBatch(['hello']);
    expect(noSuffix[0]).toBeNull();
    const diffSuffix = await getBatch(['hello'], '_gXYZW');
    expect(diffSuffix[0]).toBeNull();
  });

  test('no suffix vs with suffix → independent entries coexist', async () => {
    await setBatch(['hello'], ['你好（無術語表）']);
    await setBatch(['hello'], ['你好（有術語表）'], '_g1234');

    expect((await getBatch(['hello']))[0]).toBe('你好（無術語表）');
    expect((await getBatch(['hello'], '_g1234'))[0]).toBe('你好（有術語表）');
  });

  test('partial cache hit across multiple texts', async () => {
    await setBatch(['a', 'b'], ['甲', '乙']);
    const result = await getBatch(['a', 'c', 'b']);
    expect(result).toEqual(['甲', null, '乙']);
  });

  test('empty array → empty result', async () => {
    expect(await getBatch([])).toEqual([]);
  });

  test('hashText produces consistent 40-char hex SHA-1', async () => {
    const h1 = await hashText('test');
    const h2 = await hashText('test');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{40}$/);
    expect(await hashText('other')).not.toBe(h1);
  });
});
