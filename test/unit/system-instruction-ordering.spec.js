// Unit test: systemInstruction 建構順序(v0.71 regression + v1.8.39 重排)
//
// 驗證 translateBatch 建構的 effectiveSystem 遵守以下順序:
//   1. 基礎翻譯指令(使用者在設定頁自訂的 systemInstruction)
//   2. 段落分隔規則(若文字含 \n)
//   3. 佔位符規則(若文字含 ⟦⟧)
//   4. fixedGlossary(使用者級固定術語)
//   5. forbiddenTerms(中國用語黑名單)
//   6. 自動 glossary(頁面級術語)
//   7. 多段分隔符規則(本批次包含 N 段,batch 級變動)
//
// v0.70 的 bug:術語表放在佔位符規則前面,稀釋了 LLM 對佔位符的注意力,
// 導致 ⟦*N⟧ 標記洩漏到譯文裡。所以行為規則(換行 / 佔位符)永遠在術語表之前。
//
// v1.8.39 重排:把「本批次包含 N 段」(嵌入 literal N)從第 2 位推到最末,
// glossary 從中間後移,讓 Gemini implicit cache 共享 prefix 從 ~1500 → ~2000 tokens
// (Medium 長文 hit rate 預估 49% → 80%+)。詳見 lib/system-instruction.js jsdoc。
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage（gemini.js → logger.js → storage.js 的依賴鏈）──
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

// ── Mock fetch：攔截 Gemini API 呼叫，記錄 request body ──────
let capturedBodies = [];
globalThis.fetch = async (_url, options) => {
  capturedBodies.push(JSON.parse(options.body));
  // v1.10.53: 回真實 Response(gemini.js fetchWithRetry v1.10.46 起 await resp.text() 重建)
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '翻譯結果' }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { translateBatch } = await import('../../shinkansen/lib/gemini.js');

const BASE_SYSTEM = '基礎翻譯指令';
const settings = {
  apiKey: 'test-key',
  geminiConfig: {
    model: 'gemini-2.5-flash',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: BASE_SYSTEM,
  },
  maxRetries: 0,
};

const GLOSSARY_MARKER = '術語對照表';

/** 從最近一次 fetch 的 request body 取出 systemInstruction 文字 */
function lastSystemInstruction() {
  return capturedBodies.at(-1).systemInstruction.parts[0].text;
}

/**
 * 從第一次 fetch 的 request body 取出 systemInstruction 文字。
 * Multi-segment 測試需用此函式——mock fetch 永遠回單段「翻譯結果」,
 * gemini.js 偵測 multi-segment 結果不對齊會觸發 per-segment fallback 重新呼叫,
 * 把 capturedBodies 最末筆變成單段重試的 body。第一筆才是原本 multi-segment 的請求。
 */
function firstSystemInstruction() {
  return capturedBodies.at(0).systemInstruction.parts[0].text;
}

test.beforeEach(() => { capturedBodies = []; });

test.describe('systemInstruction 建構順序', () => {
  test('placeholder + glossary → placeholder rule before glossary', async () => {
    await translateBatch(
      ['Some ⟦0⟧link text⟦/0⟧ here'],
      settings,
      [{ source: 'Einstein', target: '愛因斯坦' }],
    );
    const sys = lastSystemInstruction();

    const phPos = sys.indexOf('額外規則（極重要，處理佔位符標記）');
    const glPos = sys.indexOf(GLOSSARY_MARKER);
    expect(phPos).toBeGreaterThan(-1);
    expect(glPos).toBeGreaterThan(-1);
    expect(phPos).toBeLessThan(glPos);
  });

  test('newline + glossary → newline rule before glossary', async () => {
    await translateBatch(
      ['First line\nSecond line'],
      settings,
      [{ source: 'Paris', target: '巴黎' }],
    );
    const sys = lastSystemInstruction();

    const nlPos = sys.indexOf('額外規則（段落分隔）');
    const glPos = sys.indexOf(GLOSSARY_MARKER);
    expect(nlPos).toBeGreaterThan(-1);
    expect(glPos).toBeGreaterThan(-1);
    expect(nlPos).toBeLessThan(glPos);
  });

  test('newline + placeholder + glossary → base < newline < placeholder < glossary', async () => {
    await translateBatch(
      ['Line one\n⟦0⟧link⟦/0⟧ here'],
      settings,
      [{ source: 'Tokyo', target: '東京' }],
    );
    const sys = lastSystemInstruction();

    const basePos = sys.indexOf(BASE_SYSTEM);
    const nlPos   = sys.indexOf('額外規則（段落分隔）');
    const phPos   = sys.indexOf('額外規則（極重要，處理佔位符標記）');
    const glPos   = sys.indexOf(GLOSSARY_MARKER);

    expect(basePos).toBe(0);
    expect(nlPos).toBeGreaterThan(basePos);
    expect(phPos).toBeGreaterThan(nlPos);
    expect(glPos).toBeGreaterThan(phPos);
  });

  test('glossary content embedded in system instruction', async () => {
    await translateBatch(
      ['Some text'],
      settings,
      [
        { source: 'Einstein', target: '愛因斯坦' },
        { source: 'Tokyo', target: '東京' },
      ],
    );
    const sys = lastSystemInstruction();
    expect(sys).toContain('Einstein → 愛因斯坦');
    expect(sys).toContain('Tokyo → 東京');
  });

  test('no glossary → no glossary section', async () => {
    await translateBatch(['Some ⟦0⟧link⟦/0⟧ text'], settings);
    expect(lastSystemInstruction()).not.toContain(GLOSSARY_MARKER);
  });

  test('plain text + glossary → only base + glossary (no extra rules)', async () => {
    await translateBatch(
      ['Simple plain text'],
      settings,
      [{ source: 'AI', target: '人工智慧' }],
    );
    const sys = lastSystemInstruction();
    expect(sys).toContain(BASE_SYSTEM);
    expect(sys).toContain(GLOSSARY_MARKER);
    expect(sys).not.toContain('額外規則(段落分隔)');
    expect(sys).not.toContain('額外規則(極重要,處理佔位符標記)');
  });

  // v1.8.39: 新排法的順序鎖死
  // 完整順序:base → newline → placeholder → fixedGlossary → forbiddenTerms → glossary → multi-segment
  // 注意 translateBatch 簽名:(texts, settings, glossary, fixedGlossary, forbiddenTerms)
  // — 後三個是位置參數,不在 settings 裡。

  test('v1.8.39 順序: fixedGlossary 在 forbiddenTerms 之前', async () => {
    await translateBatch(
      ['Plain text'],
      settings,
      null, // glossary
      [{ source: 'GitHub', target: 'GitHub' }],          // fixedGlossary
      [{ forbidden: '視頻', replacement: '影片' }],        // forbiddenTerms
    );
    const sys = lastSystemInstruction();
    const fixedPos = sys.indexOf('使用者指定的固定術語表');
    const forbidPos = sys.indexOf('<forbidden_terms_blacklist>');
    expect(fixedPos).toBeGreaterThan(-1);
    expect(forbidPos).toBeGreaterThan(-1);
    expect(fixedPos).toBeLessThan(forbidPos);
  });

  test('v1.8.39 順序: forbiddenTerms 在 auto glossary 之前', async () => {
    await translateBatch(
      ['Plain text'],
      settings,
      [{ source: 'Tokyo', target: '東京' }],              // glossary
      null,                                              // fixedGlossary
      [{ forbidden: '視頻', replacement: '影片' }],        // forbiddenTerms
    );
    const sys = lastSystemInstruction();
    const forbidPos = sys.indexOf('<forbidden_terms_blacklist>');
    const glPos = sys.indexOf(GLOSSARY_MARKER);
    expect(forbidPos).toBeGreaterThan(-1);
    expect(glPos).toBeGreaterThan(-1);
    expect(forbidPos).toBeLessThan(glPos);
  });

  test('v1.8.39 順序: 多段分隔符規則在最末端(在 glossary 與 forbiddenTerms 之後)', async () => {
    // 多段觸發條件:texts.length > 1
    await translateBatch(
      ['First segment', 'Second segment', 'Third segment'],
      settings,
      [{ source: 'Tokyo', target: '東京' }],
      [{ source: 'GitHub', target: 'GitHub' }],
      [{ forbidden: '視頻', replacement: '影片' }],
    );
    const sys = firstSystemInstruction();
    const segsPos = sys.indexOf('額外規則（多段翻譯分隔符與序號');
    const glPos = sys.indexOf(GLOSSARY_MARKER);
    const forbidPos = sys.indexOf('<forbidden_terms_blacklist>');
    const fixedPos = sys.indexOf('使用者指定的固定術語表');
    expect(segsPos).toBeGreaterThan(-1);
    expect(segsPos).toBeGreaterThan(glPos);
    expect(segsPos).toBeGreaterThan(forbidPos);
    expect(segsPos).toBeGreaterThan(fixedPos);
  });

  test('v1.8.39 順序: 完整 7 段都齊全時的相對位置', async () => {
    await translateBatch(
      ['First\nline with ⟦0⟧link⟦/0⟧', 'Second segment'],
      settings,
      [{ source: 'Tokyo', target: '東京' }],
      [{ source: 'GitHub', target: 'GitHub' }],
      [{ forbidden: '視頻', replacement: '影片' }],
    );
    const sys = firstSystemInstruction();
    const basePos    = sys.indexOf(BASE_SYSTEM);
    const newlinePos = sys.indexOf('額外規則（段落分隔）');
    const phPos      = sys.indexOf('額外規則（極重要，處理佔位符標記）');
    const fixedPos   = sys.indexOf('使用者指定的固定術語表');
    const forbidPos  = sys.indexOf('<forbidden_terms_blacklist>');
    const glPos      = sys.indexOf(GLOSSARY_MARKER);
    const segsPos    = sys.indexOf('額外規則（多段翻譯分隔符與序號');
    // 全部都應該存在
    expect(basePos).toBe(0);
    expect(newlinePos).toBeGreaterThan(-1);
    expect(phPos).toBeGreaterThan(-1);
    expect(fixedPos).toBeGreaterThan(-1);
    expect(forbidPos).toBeGreaterThan(-1);
    expect(glPos).toBeGreaterThan(-1);
    expect(segsPos).toBeGreaterThan(-1);
    // 嚴格遞增
    expect(basePos).toBeLessThan(newlinePos);
    expect(newlinePos).toBeLessThan(phPos);
    expect(phPos).toBeLessThan(fixedPos);
    expect(fixedPos).toBeLessThan(forbidPos);
    expect(forbidPos).toBeLessThan(glPos);
    expect(glPos).toBeLessThan(segsPos);
  });
});
