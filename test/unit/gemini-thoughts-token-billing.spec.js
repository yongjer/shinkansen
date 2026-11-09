// Unit test: Gemini 計費 output 計入 thoughtsTokenCount + Gemini 3 不送 topP/topK
// (v1.10.18 regression,對應 GEMINI-COST-DISCREPANCY 調查)
//
// 背景:Gemini 3 是 reasoning 模型,Google 計費 output = candidatesTokenCount(可見譯文)
//   + thoughtsTokenCount(思考過程),兩者在 usageMetadata 是獨立欄位。舊版 outputTokens
//   只讀 candidatesTokenCount → 漏算思考 token,output 單價又是 input 的 6 倍 → 整筆費用
//   被低估到剩 1/2~1/3(實測使用者帳單 ≈ Shinkansen 紀錄的 3 倍)。修法:三個 usage 解析點
//   統一走 parseGeminiUsage(),outputTokens = candidates + thoughts。
//
// 同時驗 buildSamplingFields():Gemini 3 不使用 top-k sampling 且官方建議勿設 topP/topK,
//   故 Gemini 3 模型的 request body 不含 topP/topK;非 Gemini 3 仍帶(相容)。
//
// SANITY 紀錄(已驗證 2026-06-02):
//   暫把 parseGeminiUsage 的 outputTokens 改回 `m.candidatesTokenCount || 0`
//   → 「outputTokens 計入 thoughts」3 條斷言 fail(130 → 50)→ 還原後 pass。
//   暫把 buildSamplingFields 改成永遠 return { topP, topK }
//   → 「Gemini 3 body 不含 topP/topK」斷言 fail → 還原後 pass。
import { test, expect } from '@playwright/test';
import { parseGeminiUsage, buildSamplingFields } from '../../shinkansen/lib/gemini.js';

// ── Mock chrome.storage ──────────────────────────────────────
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

// ── Mock fetch ───────────────────────────────────────────────
let fetchCalls = [];
let fetchResponses = [];

function pushResponse(text, usageMetadata) {
  // v1.10.53: 回真實 Response(gemini.js fetchWithRetry v1.10.46 起 await resp.text() 重建)
  fetchResponses.push(new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

globalThis.fetch = async (_url, options) => {
  fetchCalls.push({ url: _url, body: JSON.parse(options.body) });
  const resp = fetchResponses.shift();
  if (!resp) throw new Error('No more mock responses');
  return resp;
};

const { translateBatch } = await import('../../shinkansen/lib/gemini.js');

function makeSettings(model) {
  return {
    apiKey: 'test-key',
    geminiConfig: {
      model,
      serviceTier: 'DEFAULT',
      temperature: 1.0,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192,
      systemInstruction: '基礎翻譯指令',
    },
    maxRetries: 0,
  };
}

test.beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
});

// ── 純函式:parseGeminiUsage ──────────────────────────────────
test.describe('parseGeminiUsage', () => {
  test('outputTokens = candidatesTokenCount + thoughtsTokenCount', () => {
    const u = parseGeminiUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 80,
      cachedContentTokenCount: 20,
    });
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(130);     // 50 + 80,不是只有 50
    expect(u.thoughtsTokens).toBe(80);
    expect(u.cachedTokens).toBe(20);
  });

  test('thoughtsTokenCount 缺欄位 → 等同舊行為(只算 candidates)', () => {
    const u = parseGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 7 });
    expect(u.outputTokens).toBe(7);
    expect(u.thoughtsTokens).toBe(0);
  });

  test('meta 為 null/undefined → 全 0,不 throw', () => {
    expect(parseGeminiUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtsTokens: 0 });
  });
});

// ── 純函式:buildSamplingFields ───────────────────────────────
test.describe('buildSamplingFields', () => {
  test('Gemini 3 模型 → 不送 topP/topK(空物件)', () => {
    expect(buildSamplingFields('gemini-3-flash-preview', { topP: 0.95, topK: 40 })).toEqual({});
    expect(buildSamplingFields('gemini-3.1-flash-lite', { topP: 0.95, topK: 40 })).toEqual({});
    expect(buildSamplingFields('gemini-3.1-pro-preview', { topP: 0.9, topK: 64 })).toEqual({});
  });

  test('非 Gemini 3 模型 → 仍帶 topP/topK(相容)', () => {
    expect(buildSamplingFields('gemini-2.5-flash', { topP: 0.95, topK: 40 })).toEqual({ topP: 0.95, topK: 40 });
  });
});

// ── 整合:translateBatch 端到端 usage ─────────────────────────
test.describe('translateBatch usage 計入 thoughts', () => {
  test('Gemini 3 單段翻譯:usage.outputTokens 含 thoughtsTokenCount', async () => {
    pushResponse('你好世界', {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 80,
    });
    const { usage } = await translateBatch(['Hello world'], makeSettings('gemini-3-flash-preview'));
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(130);   // 50 + 80
  });

  test('Gemini 3 request body 的 generationConfig 不含 topP/topK', async () => {
    pushResponse('你好世界', { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 });
    await translateBatch(['Hello world'], makeSettings('gemini-3-flash-preview'));
    const gc = fetchCalls.at(-1).body.generationConfig;
    expect(gc.topP).toBeUndefined();
    expect(gc.topK).toBeUndefined();
    expect(gc.temperature).toBe(1.0);
    expect(gc.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  test('非 Gemini 3 模型 request body 仍含 topP/topK', async () => {
    pushResponse('你好世界', { promptTokenCount: 10, candidatesTokenCount: 5 });
    await translateBatch(['Hello world'], makeSettings('gemini-2.5-flash'));
    const gc = fetchCalls.at(-1).body.generationConfig;
    expect(gc.topP).toBe(0.95);
    expect(gc.topK).toBe(40);
  });
});
