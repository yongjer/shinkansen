// Regression: chunk-lang-fallback（對應 v2.0.52 修的「sub-chunk 整段輸出語言錯 →
// 整批 50 段被標失敗」bug 的 chunk 層自動治癒）
//
// Bug 全貌：日文書某 22 段 sub-chunk 被 gemini-3.1-flash-lite 連兩次輸出成日文改寫
//（同 payload 立即重試高度 sticky），頁面 batch 級語言驗證只能把整批 50 段標失敗
//（好的 28 段 sub-chunk 也陪葬）。persisted log 實證逐段小 payload 能打破 sticky
//（16/16 全成功）。
// 修法：gemini.js / openai-compat.js translateChunk 在「段數對齊但整 chunk 輸出
// 語言錯」時走既有 per-segment fallback（跟 segment count mismatch 同一條），
// 批次自動治癒；頁面 batch 級檢查降級為最後防線。單段 chunk 不驗（逐段 fallback
// 內部呼叫，避免無限遞迴）。
//
// SANITY 紀錄（已驗證）：暫時把 gemini.js 的
// `if (texts.length > 1 && detectOutputLangMismatch(parts, settings.targetLanguage))`
// 改成 `if (false)` → 「日文 chunk → 逐段 fallback」case 的 fetch 次數斷言
//（預期 1+3=4）收到 1、譯文斷言收到日文 fail → 還原 → pass。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    sync:  { get: async () => ({}), set: async () => {}, remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const { DELIMITER } = await import('../../shinkansen/lib/system-instruction.js');
const { translateBatch } = await import('../../shinkansen/lib/gemini.js');

const settings = {
  apiKey: 'test-key',
  targetLanguage: 'zh-TW',
  geminiConfig: {
    model: 'gemini-3.1-flash-lite',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: '翻譯成台灣繁體中文。',
  },
};

// 三段日文原文（多段 chunk）
const JA_TEXTS = [
  '「秘書役ならときどきやってるわ」抑揚のないくすんだ声が答えた。その一言で早紀子がわたしの言葉をどう受け止めていたか明らかになった。',
  '空が一層暗くなってきた。どうやら、この解け残りがそのまま根雪になってしまうようだ。',
  '「仕事を休ませて悪かった」時計を見て言った。去るべき時間がきたことを告げるためだ。',
];
// 模型「日文改寫」輸出（段數對齊、語言錯——重現實際 persisted log 的失敗形態）
const JA_REWRITE = [
  '「秘書みたいなことなら、たまにやってるわ」抑揚のない、くすんだ声でそう返された。その一言で、早紀子がどう受け止めていたのかが明らかになった。',
  '空がいっそう暗くなってきた。どうやらこの解け残りがそのまま根雪になってしまうらしい。',
  '「仕事の邪魔をして悪かったな」時計を見て言った。去るべき時間が来たことを伝えるためだ。',
];
const ZH_SINGLES = [
  '「秘書之類的工作，我偶爾會做喔。」她用毫無起伏的暗啞嗓音回答。',
  '天空變得更加陰暗了。看來這些殘雪會直接積成根雪。',
  '「抱歉害妳請假了。」我看著錶說道，為的是告訴她該離開了。',
];

function geminiJson(text) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 80 },
  };
}

// fetchWithRetry 會用到 resp.text() / headers.get / clone
function mockResp(json) {
  const r = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
  r.clone = () => r;
  return r;
}

// mock fetch：第 1 發（多段）回日文改寫；之後的單段呼叫依 payload 內容回對應繁中
function mockFetch({ singleSegResponder }) {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = body.contents[0].parts[0].text;
    calls.push(input);
    const isMulti = input.includes('<<<SHINKANSEN_SEP>>>');
    const text = isMulti
      ? JA_REWRITE.map((t, i) => `«${i + 1}» ${t}`).join(DELIMITER)
      : singleSegResponder(input);
    return mockResp(geminiJson(text));
  };
  return calls;
}

test.describe('gemini translateChunk:輸出語言錯 → 逐段 fallback 自動治癒', () => {
  test('多段 chunk 回日文改寫（段數對齊）→ 逐段重翻 → 回繁中 + hadMismatch', async () => {
    const calls = mockFetch({
      singleSegResponder: (input) => {
        const idx = JA_TEXTS.findIndex((t) => input.includes(t.slice(0, 12)));
        return ZH_SINGLES[idx] ?? '譯文';
      },
    });
    const res = await translateBatch(JA_TEXTS, settings, null, null, null);
    expect(calls).toHaveLength(1 + 3); // 原始 1 發 + 逐段 3 發
    expect(res.translations).toEqual(ZH_SINGLES);
    expect(res.hadMismatch).toBe(true);
    // 兩層 usage 都要累計（原始那發也付過錢）
    expect(res.usage.inputTokens).toBe(400);
  });

  test('逐段 fallback 內的單段呼叫不再驗語言（不會無限遞迴），日文單段結果照收', async () => {
    // 單段全部回日文——若單段也驗語言會遞迴爆掉；此 case 驗有終止且結果照收
    //（最後防線在 translate-doc 頁 batch 級檢查）
    const calls = mockFetch({ singleSegResponder: () => 'まだ日本語のままです、翻訳されていません。' });
    const res = await translateBatch(JA_TEXTS, settings, null, null, null);
    expect(calls).toHaveLength(1 + 3);
    expect(res.translations).toHaveLength(3);
    expect(res.hadMismatch).toBe(true);
  });

  test('正常繁中輸出 → 單發完成、不觸發 fallback', async () => {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(1);
      const text = ZH_SINGLES.map((t, i) => `«${i + 1}» ${t}`).join(DELIMITER);
      return mockResp(geminiJson(text));
    };
    const res = await translateBatch(JA_TEXTS, settings, null, null, null);
    expect(calls).toHaveLength(1);
    expect(res.translations).toEqual(ZH_SINGLES);
    expect(res.hadMismatch).toBe(false);
  });
});
