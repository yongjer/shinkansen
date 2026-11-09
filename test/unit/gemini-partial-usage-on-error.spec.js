// Unit test: translateBatch 多 chunk 中途 throw,已付費 usage 附在 error 上(v1.10.46 批次 2-5)
//
// 原 bug:translateBatch 的 sequential chunk loop 任一 chunk throw → 整個 promise
// reject → content 端收到 error 不會發 LOG_USAGE → 前面已成功(已付費)的 chunk
// token 永遠漏記 usage-db,對帳系統性低估。
//
// 修法(gemini.js):chunk loop 與 translateChunk 逐段 fallback loop 都在 throw 前
// 把累積 usage 掛在 err.usage;background handleTranslate catch 後用 err.usage 直接
// 寫 usage-db(partialFailure: true)再 rethrow(那半邊由
// test/jest-unit/limiter-init-lock-partial-usage.test.cjs 以 source 斷言鎖)。
//
// Mock 策略:替換 globalThis.fetch。21 段短文字 → packChunks 切成 20+1 兩個 chunk;
// 第 1 次 fetch 回正確段數 + usageMetadata,第 2 次 fetch reject(網路錯誤),
// settings.maxRetries=0 讓 retry 立即放棄。
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 translateBatch chunk loop 的
// try/catch(err.usage 附掛)拿掉(改回裸 await translateChunk)→
// 「err.usage 應含 chunk 1 已付費 token」case fail(err.usage undefined)→ 還原 → pass。
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

const { translateBatch } = await import('../../shinkansen/lib/gemini.js');

const DELIMITER = '\n<<<SHINKANSEN_SEP>>>\n';

const SETTINGS = {
  apiKey: 'test-key',
  maxRetries: 0, // fetch 失敗立即放棄,不退避重試(測試提速)
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

// 21 段短文字 → packChunks(MAX_UNITS_PER_CHUNK=20)切成 [0,20) + [20,21) 兩個 chunk
const TEXTS = Array.from({ length: 21 }, (_, i) => `Sentence number ${i}.`);

function makeFetchMock({ failOnCall }) {
  let call = 0;
  return async (url, opts) => {
    call++;
    if (call === failOnCall) {
      const err = new Error('network down');
      throw err;
    }
    const body = JSON.parse(opts.body);
    const joined = body.contents[0].parts[0].text;
    const parts = joined.split(DELIMITER);
    const translated = parts.map(p => `譯${p}`).join(DELIMITER);
    return new Response(JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: translated }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('2-5: chunk 2 失敗 → reject 的 error 帶 err.usage = chunk 1 已付費 token', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock({ failOnCall: 2 });
  try {
    let caught = null;
    try {
      await translateBatch(TEXTS, SETTINGS);
    } catch (err) {
      caught = err;
    }
    expect(caught, 'translateBatch 應 reject').not.toBeNull();
    expect(caught.usage, 'err.usage 應含 chunk 1 已付費 token').toBeTruthy();
    expect(caught.usage.inputTokens).toBe(100);
    expect(caught.usage.outputTokens).toBe(50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2-5: 第 1 個 chunk 就失敗 → err.usage 為全 0(沒付過費)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock({ failOnCall: 1 });
  try {
    let caught = null;
    try {
      await translateBatch(TEXTS, SETTINGS);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.usage).toBeTruthy();
    expect(caught.usage.inputTokens).toBe(0);
    expect(caught.usage.outputTokens).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2-5: 全部成功時行為不變(translations 對齊 + usage 累加,error 路徑零干擾)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock({ failOnCall: -1 });
  try {
    const res = await translateBatch(TEXTS, SETTINGS);
    expect(res.translations.length).toBe(21);
    expect(res.translations.every(t => typeof t === 'string' && t.length > 0)).toBe(true);
    expect(res.usage.inputTokens).toBe(200); // 2 chunks × 100
    expect(res.usage.outputTokens).toBe(100);
    expect(res.hadMismatch).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
