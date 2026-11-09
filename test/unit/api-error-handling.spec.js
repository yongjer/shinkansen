// Unit test: API 回應非 JSON / 格式異常防護（v0.84 regression）
//
// 驗證 translateChunk 的三層錯誤防護：
//   1. resp.json() 失敗 → 可讀錯誤（含 HTTP 狀態碼）
//   2. candidates 結構異常 → blockReason / finishReason 對應錯誤訊息
//   3. fetchWithRetry 5xx 重試
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage ──────────────────────────────────────
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let fetchCalls = [];
let fetchResponses = [];

/**
 * 推入一個自訂 fetch response。
 * 若 rawBody 為 object，回傳合法 JSON；若為 string，回傳 raw text（模擬非 JSON）。
 */
function pushRawResponse(status, rawBody, { isJson = true } = {}) {
  fetchResponses.push({
    ok: status >= 200 && status < 300,
    status,
    clone() { return this; },
    json: isJson
      ? async () => (typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody)
      : async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    text: async () => (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)),
  });
}

/** 推入一個正常的翻譯回應 */
function pushOkResponse(text) {
  pushRawResponse(200, {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  });
}

globalThis.fetch = async (_url, options) => {
  fetchCalls.push({ url: _url, body: JSON.parse(options.body) });
  const resp = fetchResponses.shift();
  if (!resp) throw new Error('No more mock responses');
  return resp;
};

const { translateBatch } = await import('../../shinkansen/lib/gemini.js');

const settings = {
  apiKey: 'test-key',
  geminiConfig: {
    model: 'gemini-2.5-flash',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: '翻譯指令',
  },
  maxRetries: 2,
};

test.beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
});

test.describe('v0.84 resp.json() 失敗防護', () => {
  test('API 回傳 HTML（非 JSON）→ 拋出含 HTTP 狀態碼的可讀錯誤', async () => {
    // 用 200 模擬 CDN 回傳 HTML（200 不觸發 5xx 重試，直接進 resp.json()）
    pushRawResponse(200, '<html><body>Service Unavailable</body></html>', { isJson: false });

    const err = await translateBatch(['Hello'], settings).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('非 JSON');
    expect(err.message).toContain('200');
  });
});

test.describe('v0.84 candidates 結構異常防護', () => {
  test('promptFeedback.blockReason → 拋出安全過濾器錯誤', async () => {
    pushRawResponse(200, {
      candidates: [],
      promptFeedback: { blockReason: 'SAFETY' },
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0 },
    });

    const err = await translateBatch(['Hello'], settings).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('blockReason');
    expect(err.message).toContain('SAFETY');
  });

  test('空 candidates + finishReason=SAFETY → 安全過濾器錯誤訊息', async () => {
    pushRawResponse(200, {
      candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: '' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0 },
    });

    const err = await translateBatch(['Hello'], settings).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('安全過濾器');
  });

  test('finishReason=MAX_TOKENS + 無文字 → maxOutputTokens 錯誤', async () => {
    pushRawResponse(200, {
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0 },
    });

    const err = await translateBatch(['Hello'], settings).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('maxOutputTokens');
  });

  test('finishReason=RECITATION → recitation 錯誤訊息', async () => {
    pushRawResponse(200, {
      candidates: [{ finishReason: 'RECITATION', content: { parts: [{ text: '' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0 },
    });

    const err = await translateBatch(['Hello'], settings).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('recitation');
  });

  test('正常 finishReason=STOP + 有文字 → 正常回傳', async () => {
    pushOkResponse('你好');

    const result = await translateBatch(['Hello'], settings);
    expect(result.translations).toEqual(['你好']);
  });
});

test.describe('v0.84 fetchWithRetry 5xx 重試', () => {
  test('HTTP 500 第一次失敗 → 第二次成功 → 回傳正常結果', async () => {
    // 第一次 500
    pushRawResponse(500, { error: { message: 'Internal server error' } });
    // 第二次成功
    pushOkResponse('你好');

    const result = await translateBatch(['Hello'], settings);
    expect(result.translations).toEqual(['你好']);
    expect(fetchCalls).toHaveLength(2);
  });

  test('HTTP 500 連續超過 maxRetries → 拋錯', async () => {
    // maxRetries=2 → 最多 3 次嘗試（initial + 2 retries）
    pushRawResponse(500, { error: { message: 'Internal server error' } });
    pushRawResponse(500, { error: { message: 'Internal server error' } });
    pushRawResponse(500, { error: { message: 'Internal server error' } });

    const err = await translateBatch(['Hello'], settings).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Internal server error');
    expect(fetchCalls).toHaveLength(3);
  });
});
