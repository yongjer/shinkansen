// Unit test: logger sanitize 大 payload 截斷路徑(v1.10.46 批次 2-7)
//
// 原 bug:lib/logger.js sanitize 對 JSON.stringify 後 > 3000 字的 data 做
// `JSON.parse(s.slice(0, 3000) + '…(截斷)')`——切到 3000 字的 JSON 字串幾乎必為
// 非法 JSON,parse throw → 走 catch 回 `String(data)` = "[object Object]"。
// 結果:所有大 payload(YT rawNormTexts dump、packBatches detail 等)在設定頁
// Log 分頁全部變成無資訊的 "[object Object]"。
//
// 修法:不再 re-parse,直接回 `{ _truncated: true, originalLength, preview }`,
// 保留可讀前 3000 字。
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 sanitize 截斷分支改回
// `JSON.parse(s.slice(0, 3000) + '…(截斷)')` → 「大 payload 應回 preview 物件」
// 與「不得退化成 [object Object]」兩 case fail → 還原 → pass。
import { test, expect } from '@playwright/test';

// stub chrome storage(logger import storage.js 需要)
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync: { get: async () => ({}), remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

const { debugLog, getLogs, clearLogs } = await import('../../shinkansen/lib/logger.js');

test.beforeEach(() => clearLogs());

test('大 payload(stringify > 3000 字)→ data 回 _truncated preview 物件,保留可讀前段', () => {
  const big = { items: Array.from({ length: 500 }, (_, i) => `segment-${i}-${'x'.repeat(20)}`) };
  debugLog('info', 'translate', 'big payload test', big);
  const { logs } = getLogs();
  const entry = logs[logs.length - 1];
  expect(entry.data).toEqual(expect.objectContaining({ _truncated: true }));
  expect(typeof entry.data.preview).toBe('string');
  expect(entry.data.preview.length).toBe(3000);
  expect(entry.data.preview).toContain('segment-0');
  expect(entry.data.originalLength).toBeGreaterThan(3000);
});

test('大 payload 不得退化成 "[object Object]"(原 bug 症狀)', () => {
  const big = { blob: 'y'.repeat(10_000) };
  debugLog('warn', 'api', 'big blob test', big);
  const { logs } = getLogs();
  const entry = logs[logs.length - 1];
  // 原 bug:sanitize 截斷分支 JSON.parse throw → catch 回 String(data) 字串
  expect(typeof entry.data).not.toBe('string');
  expect(entry.data.preview).toContain('yyyy');
});

test('小 payload(< 3000 字)行為不變:深拷貝原物件', () => {
  const small = { a: 1, b: ['x', 'y'], c: { nested: true } };
  debugLog('info', 'cache', 'small payload test', small);
  const { logs } = getLogs();
  const entry = logs[logs.length - 1];
  expect(entry.data).toEqual(small);
  expect(entry.data._truncated).toBeUndefined();
});

test('不可序列化 payload(循環參照)仍走 String fallback,不 throw', () => {
  const cyc = { name: 'loop' };
  cyc.self = cyc;
  expect(() => debugLog('info', 'system', 'cyclic test', cyc)).not.toThrow();
  const { logs } = getLogs();
  const entry = logs[logs.length - 1];
  expect(typeof entry.data).toBe('string');
});
