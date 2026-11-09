// Unit test: packChunks 分批上限可由使用者設定帶入(v1.10.46 批次 5-3)
//
// 原 bug:packChunks 寫死 DEFAULT_UNITS_PER_BATCH(20)/ DEFAULT_CHARS_PER_BATCH(3500),
// 使用者在 options 調高 maxUnitsPerBatch 後 content 端分批生效,但 gemini.js /
// openai-compat.js 的 translateBatch 在 adapter 端用 packChunks 重切蓋掉 →
// >20 段的設定無效且無提示。
//
// 修法:packChunks 收 opts {maxUnits, maxChars},兩個 adapter call site 帶
// settings.maxUnitsPerBatch / settings.maxCharsPerBatch;opts 缺漏或非法 fallback 預設。
//
// 兩層驗證:
//   1. packChunks 純函式行為(opts 生效 / 非法值 fallback / 預設不變)
//   2. adapter 接線:translateBatch(gemini)帶 maxUnitsPerBatch=30 的 settings 後,
//      21 段只打 1 次 fetch(原本 2 次)——驗「設定真的傳到 packChunks」那條 path
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 gemini.js call site 的 opts 拿掉(改回
// packChunks(texts))→「21 段 + maxUnitsPerBatch=30 → 1 次 fetch」case fail(2 次)→
// 還原 → pass。
import { test, expect } from '@playwright/test';

// stub chrome storage(gemini.js → logger.js → storage.js 需要)
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync: { get: async () => ({}), remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

const { packChunks } = await import('../../shinkansen/lib/system-instruction.js');
const { translateBatch } = await import('../../shinkansen/lib/gemini.js');

const DELIMITER = '\n<<<SHINKANSEN_SEP>>>\n';

test.describe('packChunks opts 行為', () => {
  const shortTexts = (n) => Array.from({ length: n }, (_, i) => `t${i}`);

  test('不帶 opts 維持預設(21 段 → 20+1 兩個 chunk)', () => {
    const chunks = packChunks(shortTexts(21));
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({ start: 0, end: 20, chars: expect.any(Number) });
  });

  test('maxUnits=30 生效(21 段 → 1 個 chunk)', () => {
    const chunks = packChunks(shortTexts(21), { maxUnits: 30 });
    expect(chunks.length).toBe(1);
  });

  test('maxUnits=5 生效(12 段 → 3 個 chunk)', () => {
    const chunks = packChunks(shortTexts(12), { maxUnits: 5 });
    expect(chunks.length).toBe(3);
  });

  test('maxChars 生效(每段 100 字,maxChars=250 → 每 chunk 最多 2 段)', () => {
    const texts = Array.from({ length: 4 }, () => 'x'.repeat(100));
    const chunks = packChunks(texts, { maxChars: 250 });
    expect(chunks.length).toBe(2);
    expect(chunks[0].end - chunks[0].start).toBe(2);
  });

  test('單段超過 maxChars → 自成一個 chunk(行為與預設一致)', () => {
    const texts = ['x'.repeat(300), 'short'];
    const chunks = packChunks(texts, { maxChars: 250 });
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({ start: 0, end: 1 });
  });

  test('非法 opts(NaN / 0 / 負數 / undefined)fallback 預設 20 段', () => {
    for (const bad of [NaN, 0, -5, undefined, 'big']) {
      const chunks = packChunks(shortTexts(21), { maxUnits: bad });
      expect(chunks.length, `maxUnits=${bad} 應 fallback 20`).toBe(2);
    }
  });
});

test.describe('adapter 接線:settings.maxUnitsPerBatch 傳到 packChunks', () => {
  const SETTINGS_BASE = {
    apiKey: 'test-key',
    maxRetries: 0,
    geminiConfig: {
      model: 'gemini-3-flash-preview',
      serviceTier: 'DEFAULT',
      temperature: 0.3,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192,
      systemInstruction: 'translate to zh-TW',
    },
  };
  const TEXTS = Array.from({ length: 21 }, (_, i) => `Sentence number ${i}.`);

  function makeCountingFetch() {
    const counter = { calls: 0 };
    counter.fn = async (url, opts) => {
      counter.calls++;
      const body = JSON.parse(opts.body);
      const joined = body.contents[0].parts[0].text;
      const parts = joined.split(DELIMITER);
      const translated = parts.map((p) => `譯${p}`).join(DELIMITER);
      return new Response(JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: translated }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return counter;
  }

  test('maxUnitsPerBatch=30 → 21 段 1 次 fetch;未設定 → 2 次(預設 20 重切)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const c1 = makeCountingFetch();
      globalThis.fetch = c1.fn;
      const res1 = await translateBatch(TEXTS, { ...SETTINGS_BASE, maxUnitsPerBatch: 30, maxCharsPerBatch: 20000 });
      expect(c1.calls).toBe(1);
      expect(res1.translations.length).toBe(21);

      const c2 = makeCountingFetch();
      globalThis.fetch = c2.fn;
      const res2 = await translateBatch(TEXTS, SETTINGS_BASE);
      expect(c2.calls).toBe(2);
      expect(res2.translations.length).toBe(21);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
