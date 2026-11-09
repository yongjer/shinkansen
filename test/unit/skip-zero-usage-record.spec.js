// Unit test: shouldSkipUsageRecord 過濾(v1.8.39)
//
// 整頁本地 cache 全命中、沒打 API 的紀錄(token / chars / cost 全為 0)
// 對使用者沒有資訊價值,只塞滿用量列表。background.js 的 LOG_USAGE handler
// 在寫入 IndexedDB 之前用 shouldSkipUsageRecord 把這類紀錄過濾掉。
//
// SANITY: 暫時把 shouldSkipUsageRecord 改成永遠回 false,本 spec 應該全部 fail。
// 還原後 pass。

import { test, expect } from '@playwright/test';

// 不需要 mock chrome.storage / fetch / IndexedDB,純函式測試。
const { shouldSkipUsageRecord } = await import('../../shinkansen/lib/usage-db.js');

test.describe('shouldSkipUsageRecord', () => {
  test('全零 token + 零 cost → 跳過', () => {
    const record = {
      url: 'https://example.com',
      title: 'Example',
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      billedInputTokens: 0,
      billedCostUSD: 0,
      cacheHits: 5,        // 本地 cache hit 數可以 > 0
      segments: 5,
      durationMs: 12,
      timestamp: Date.now(),
      engine: 'gemini',
    };
    expect(shouldSkipUsageRecord(record)).toBe(true);
  });

  test('inputTokens > 0 → 不跳過', () => {
    const record = {
      inputTokens: 100,
      outputTokens: 0,
      billedCostUSD: 0,
      chars: 0,
    };
    expect(shouldSkipUsageRecord(record)).toBe(false);
  });

  test('outputTokens > 0 → 不跳過', () => {
    expect(shouldSkipUsageRecord({
      inputTokens: 0,
      outputTokens: 50,
      billedCostUSD: 0,
      chars: 0,
    })).toBe(false);
  });

  test('billedCostUSD > 0 → 不跳過', () => {
    expect(shouldSkipUsageRecord({
      inputTokens: 0,
      outputTokens: 0,
      billedCostUSD: 0.0001,
      chars: 0,
    })).toBe(false);
  });

  test('Google Translate 用 chars 計費,chars > 0 → 不跳過', () => {
    expect(shouldSkipUsageRecord({
      inputTokens: 0,
      outputTokens: 0,
      billedCostUSD: 0,
      chars: 1234,
      engine: 'google',
    })).toBe(false);
  });

  test('YouTube subtitle 紀錄即使全零也不跳過(走 upsert 累計路徑)', () => {
    expect(shouldSkipUsageRecord({
      source: 'youtube-subtitle',
      videoId: 'abc123',
      inputTokens: 0,
      outputTokens: 0,
      billedCostUSD: 0,
      chars: 0,
    })).toBe(false);
  });

  test('null / undefined record → 跳過(防呆)', () => {
    expect(shouldSkipUsageRecord(null)).toBe(true);
    expect(shouldSkipUsageRecord(undefined)).toBe(true);
  });

  test('字串 "0" 也視為 0', () => {
    expect(shouldSkipUsageRecord({
      inputTokens: '0',
      outputTokens: '0',
      billedCostUSD: '0',
      chars: '0',
    })).toBe(true);
  });

  test('缺欄位 → 視為 0,跳過', () => {
    expect(shouldSkipUsageRecord({
      url: 'https://example.com',
      timestamp: Date.now(),
    })).toBe(true);
  });
});
