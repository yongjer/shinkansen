// Unit / regression test: 送到 Instapaper 一併上傳文章摘要
//
// 驗三層:
//   1. buildInstapaperPayload(lib/instapaper.js):description 有值 → payload.description
//      帶 trim 後字串;空 / 空白 / undefined → 不帶 description key（best-effort 降級的載體）
//   2. summarizeArticle(lib/gemini.js):mock fetch 驗
//      - 成功回應 → 回 summary 文字
//      - 缺 text / apiKey / model → 不打 fetch、回 ''（gate 短路）
//      - !ok / 網路錯誤 → 回 ''（best-effort 不 throw,呼叫端照常送書籤）
//      - 輸入超長 → 截斷到 MAX_SUMMARY_INPUT_CHARS(成本上限,CLAUDE.md §4)
//      - systemInstruction 帶入目標語言 label（摘要使用翻譯目標語言）
//   3. background.js source 結構:摘要固定走 flash-lite（最便宜,需求第 3 條 + §17）,
//      generateInstapaperSummary gate 在 instapaperSummaryEnabled + 有 apiKey
//
// 本層不驗:真實 Gemini 摘要品質 / 真實 Instapaper 端是否顯示 description（受 mock 限制,
// 真實送出需手動驗一次）。
//
// SANITY 紀錄（已驗證）:
//   - buildInstapaperPayload 把 `if (trimmed) payload.description = trimmed` 改成
//     無條件 `payload.description = description` → 「空白 description 不帶 key」case fail;還原 pass。
//   - summarizeArticle 把 `clean.slice(0, MAX_SUMMARY_INPUT_CHARS)` 的 slice 拿掉 →
//     「超長輸入截斷」case fail;還原 pass。
//   - background.js 把 INSTAPAPER_SUMMARY_MODEL 改成非 flash-lite → 「flash-lite」case fail;還原 pass。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Mock chrome.storage（gemini.js → logger.js 載入需要）──────────
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const { buildInstapaperPayload } = await import('../../shinkansen/lib/instapaper.js');
const { summarizeArticle } = await import('../../shinkansen/lib/gemini.js');

// ── 1. buildInstapaperPayload description ────────────────────────
test.describe('buildInstapaperPayload description 欄位', () => {
  test('description 有值 → payload.description 帶 trim 後字串', () => {
    const p = buildInstapaperPayload({ url: 'https://x.com', title: 'T', html: '<p>h</p>', description: '  摘要內容  ' });
    expect(p.description).toBe('摘要內容');
  });

  test('description 為空字串 / 純空白 / undefined → 不帶 description key', () => {
    for (const d of ['', '   ', undefined, null]) {
      const p = buildInstapaperPayload({ url: 'https://x.com', title: 'T', html: '<p>h</p>', description: d });
      expect('description' in p, `description=${JSON.stringify(d)} 不該帶 key`).toBe(false);
    }
  });

  test('沒帶 description 參數時行為與舊版一致（只有 url/title/content）', () => {
    const p = buildInstapaperPayload({ url: 'https://x.com', title: 'T', html: '<p>h</p>' });
    expect(p).toEqual({ url: 'https://x.com', title: 'T', content: '<p>h</p>' });
  });
});

// ── 2. summarizeArticle 行為 ─────────────────────────────────────
let lastBody = null;
function mockSummaryResponse(text, { ok = true, status = 200, throwNetwork = false } = {}) {
  globalThis.fetch = async (_url, options) => {
    lastBody = JSON.parse(options.body);
    if (throwNetwork) throw new Error('network down');
    return {
      ok,
      status,
      json: async () => ok
        ? {
            candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30 },
          }
        : { error: { message: `HTTP ${status}` } },
    };
  };
}

const BASE = { apiKey: 'test-key', model: 'gemini-3.1-flash-lite', targetLangLabel: 'Traditional Chinese (Taiwan conventions)' };

test.describe('summarizeArticle 行為', () => {
  test('成功回應 → 回 summary 文字', async () => {
    mockSummaryResponse('這是三到四句的摘要。');
    const { summary } = await summarizeArticle({ ...BASE, text: '一篇很長的文章內容……' });
    expect(summary).toBe('這是三到四句的摘要。');
  });

  test('缺 text / apiKey / model → 不打 fetch、回 ""（gate 短路）', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
    expect((await summarizeArticle({ ...BASE, text: '' })).summary).toBe('');
    expect((await summarizeArticle({ ...BASE, text: '   ' })).summary).toBe('');
    expect((await summarizeArticle({ ...BASE, apiKey: '', text: 'x' })).summary).toBe('');
    expect((await summarizeArticle({ ...BASE, model: '', text: 'x' })).summary).toBe('');
    expect(fetchCalled, '空 gate 不該打 fetch').toBe(false);
  });

  test('!ok 回應 → best-effort 回 ""（不 throw）', async () => {
    mockSummaryResponse('', { ok: false, status: 500 });
    const r = await summarizeArticle({ ...BASE, text: 'x'.repeat(50) });
    expect(r.summary).toBe('');
  });

  test('網路錯誤 → best-effort 回 ""（不 throw）', async () => {
    mockSummaryResponse('', { throwNetwork: true });
    const r = await summarizeArticle({ ...BASE, text: 'x'.repeat(50) });
    expect(r.summary).toBe('');
  });

  test('超長輸入截斷到 12000 字元（成本上限）', async () => {
    mockSummaryResponse('summary');
    await summarizeArticle({ ...BASE, text: 'a'.repeat(20000) });
    const userText = lastBody.contents[0].parts[0].text;
    expect(userText.length).toBe(12000);
  });

  test('systemInstruction 帶入目標語言 label（摘要使用翻譯目標語言）', async () => {
    mockSummaryResponse('summary');
    await summarizeArticle({ ...BASE, targetLangLabel: 'Japanese (日本語)', text: 'hello world' });
    const sys = lastBody.systemInstruction.parts[0].text;
    expect(sys).toContain('Japanese (日本語)');
  });
});

// ── 3. background.js source 結構（gate + flash-lite）─────────────
const BG_SRC = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/background.js'), 'utf-8');

test.describe('background generateInstapaperSummary', () => {
  test('摘要固定走最便宜的 flash-lite（需求第 3 條 + CLAUDE.md §17）', () => {
    expect(BG_SRC).toMatch(/INSTAPAPER_SUMMARY_MODEL\s*=\s*'gemini-3\.1-flash-lite'/);
    // §17:不可出現 2.5 系列
    expect(BG_SRC).not.toMatch(/gemini-2\.5/);
  });

  test('gate:未啟用 instapaperSummaryEnabled 或無 apiKey 直接回 ""', () => {
    const fnStart = BG_SRC.indexOf('async function generateInstapaperSummary');
    expect(fnStart, '找不到 generateInstapaperSummary').toBeGreaterThan(-1);
    const fnBody = BG_SRC.slice(fnStart, fnStart + 1200);
    expect(fnBody).toMatch(/instapaperSummaryEnabled\s*!==\s*true/);
    expect(fnBody).toMatch(/if\s*\(\s*!apiKey\s*\)\s*return\s*''/);
  });
});

// ── 4. 製作摘要中狀態提示（popup status + Alt+I content toast）────
test.describe('摘要進行中的狀態提示', () => {
  const POPUP_SRC = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/popup/popup.js'), 'utf-8');
  const CONTENT_SRC = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/content.js'), 'utf-8');

  test('popup 摘要前顯示 instapaper.summarizing 狀態', () => {
    expect(POPUP_SRC).toMatch(/t\(\s*'instapaper\.summarizing'\s*\)/);
  });

  test('Alt+I content toast 支援 summarizing → instapaper.summarizing（loading）', () => {
    expect(CONTENT_SRC).toMatch(/summarizing:\s*\{\s*kind:\s*'loading',\s*key:\s*'instapaper\.summarizing'\s*\}/);
    expect(BG_SRC).toMatch(/toast\(\s*'summarizing'\s*\)/);
  });
});
