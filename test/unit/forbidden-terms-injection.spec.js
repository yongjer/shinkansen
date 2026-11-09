// Unit test: 中國用語黑名單注入到 systemInstruction（v1.5.6 regression）
//
// 驗證 translateBatch 在 forbiddenTerms 非空時，會把黑名單以
// <forbidden_terms_blacklist> XML 區塊注入到送往 Gemini 的 systemInstruction
// 末端，且每條規則以「禁用詞 → 替換詞」單行格式列出。
//
// 為什麼放在 test/unit/ 而不是 test/regression/：跟 system-instruction-ordering
// 與 cache-glossary-keysuffix 同類，是直接 mock fetch + import lib module 的純邏
// 輯 unit test，不需要 Playwright extension fixture。
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage（gemini.js → logger.js → storage.js 的依賴鏈）──
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

// ── Mock fetch：攔截 Gemini API 呼叫，記錄 request body ──
let capturedBodies = [];
globalThis.fetch = async (_url, options) => {
  capturedBodies.push(JSON.parse(options.body));
  // v1.10.53: 回真實 Response —— gemini.js fetchWithRetry 成功路徑 v1.10.46 起會
  // await resp.text() 再 new Response 重建,手搓物件缺 .text() 會炸「resp.text is not a function」。
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
    model: 'gemini-3-flash-preview',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: BASE_SYSTEM,
  },
  maxRetries: 0,
};

const FORBIDDEN_SAMPLE = [
  { forbidden: '視頻', replacement: '影片', note: '' },
  { forbidden: '軟件', replacement: '軟體', note: '' },
  { forbidden: '數據', replacement: '資料', note: '' },
];

function lastSystemInstruction() {
  return capturedBodies.at(-1).systemInstruction.parts[0].text;
}

test.beforeEach(() => { capturedBodies = []; });

test.describe('forbidden-terms 注入到 systemInstruction', () => {
  test('forbiddenTerms 非空 → systemInstruction 含 <forbidden_terms_blacklist> 區塊與全部對映', async () => {
    await translateBatch(
      ['Some video software data text'],
      settings,
      null, // glossary
      null, // fixedGlossary
      FORBIDDEN_SAMPLE,
    );
    const sys = lastSystemInstruction();

    expect(sys).toContain('<forbidden_terms_blacklist>');
    expect(sys).toContain('</forbidden_terms_blacklist>');
    expect(sys).toContain('視頻 → 影片');
    expect(sys).toContain('軟件 → 軟體');
    expect(sys).toContain('數據 → 資料');
    // 黑名單區塊必須在最末端（高於 fixedGlossary 也高於自動 glossary 的位置）
    const blockStart = sys.indexOf('<forbidden_terms_blacklist>');
    const baseStart = sys.indexOf(BASE_SYSTEM);
    expect(blockStart).toBeGreaterThan(baseStart);
  });

  test('forbiddenTerms 空陣列 → systemInstruction 不含黑名單區塊', async () => {
    await translateBatch(['Some text'], settings, null, null, []);
    const sys = lastSystemInstruction();
    expect(sys).not.toContain('<forbidden_terms_blacklist>');
  });

  test('forbiddenTerms undefined / null → 不影響既有行為', async () => {
    await translateBatch(['Some text'], settings, null, null, undefined);
    const sys = lastSystemInstruction();
    expect(sys).not.toContain('<forbidden_terms_blacklist>');
  });

  // ── 替換詞可留空（v1.10.60）：只填禁用詞 → 列入「禁用（未指定替換詞）」區，
  //     由 LLM 自行改寫，不可輸出「詞 → 」這種空替換對照 ──
  test('替換詞留空 → 列入「未指定替換詞」區，不產生「→ 空字串」對照', async () => {
    await translateBatch(
      ['這部電影好看到沒有之一'],
      settings,
      null,
      null,
      [{ forbidden: '沒有之一', replacement: '', note: '' }],
    );
    const sys = lastSystemInstruction();

    expect(sys).toContain('<forbidden_terms_blacklist>');
    expect(sys).toContain('未指定替換詞');
    expect(sys).toContain('沒有之一');
    // 絕不可出現「沒有之一 → 」這種以空字串為替換詞的對照行
    expect(sys).not.toContain('沒有之一 → ');
    expect(sys).not.toMatch(/沒有之一\s*→\s*(\n|$)/);
    // 全留空時不該出現「禁用 → 必須改用」對照段標題
    expect(sys).not.toContain('禁用 → 必須改用');
  });

  test('混合（有替換詞 + 留空）→ 兩段同時出現，各歸各區', async () => {
    await translateBatch(
      ['video 沒有之一'],
      settings,
      null,
      null,
      [
        { forbidden: '視頻', replacement: '影片', note: '' },
        { forbidden: '沒有之一', replacement: '', note: '' },
      ],
    );
    const sys = lastSystemInstruction();

    expect(sys).toContain('禁用 → 必須改用');     // 對照段
    expect(sys).toContain('視頻 → 影片');          // 有替換詞 → 對照段
    expect(sys).toContain('未指定替換詞');         // 留空段
    expect(sys).toContain('沒有之一');             // 留空段列出禁用詞
    expect(sys).not.toContain('沒有之一 → ');      // 留空詞不進對照段
  });

  test('黑名單區塊放在 fixedGlossary 之後（最末端，最高顯著性）', async () => {
    await translateBatch(
      ['Some text'],
      settings,
      null,
      [{ source: 'AI', target: '人工智慧' }],
      FORBIDDEN_SAMPLE,
    );
    const sys = lastSystemInstruction();

    const fgPos = sys.indexOf('使用者指定的固定術語表');
    const blPos = sys.indexOf('<forbidden_terms_blacklist>');
    expect(fgPos).toBeGreaterThan(-1);
    expect(blPos).toBeGreaterThan(-1);
    expect(blPos).toBeGreaterThan(fgPos);
  });
});

// SANITY 紀錄（已在 Claude Code 端驗證）：
//   把 lib/gemini.js buildEffectiveSystemInstruction 的條件
//     `if (forbiddenTerms && forbiddenTerms.length > 0)` 強制改成 `if (false)`
//   → test #1 fail（systemInstruction 不含 <forbidden_terms_blacklist> 標籤）
//     test #4 fail（找不到黑名單區塊）
//   還原後三條 pass。
//
// SANITY 紀錄（v1.10.60「替換詞可留空」，已在 Claude Code 端驗證）：
//   把 system-instruction.js 留空分支 `else { bannedOnly.push(forbidden); }`
//   改成 `else { mappedLines.push(`${forbidden} → ${replacement}`); }`（退回舊行為）
//   → 「替換詞留空」與「混合」兩條 fail（出現「沒有之一 → 」空替換對照、缺「未指定替換詞」段）
//   還原後全部 pass。
