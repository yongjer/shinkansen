// Regression: doc-batch-bisect（對應 v2.0.53 加的「失敗批對切重試」）
//
// Bug 背景：日文書實測 950 段失敗——850 段逾時 + 100 段 PROHIBITED_CONTENT。
// Google 過濾器通常只被批內一兩段觸發，卻讓整批（50 段）陣亡；逾時同理，
// 縮小批次（輸出減半）常能通過。舊行為：批次層失敗一律整批標 failed。
// 修法：translateSubChunk 依 response.errorCode 分流——可對切碼（timeout /
// readTimeout / blocked / empty* / customEmptyContent）遞迴切半重送（長度 1
// 自然收斂），把觸發段隔離、救回其餘段；不可對切碼（network / apiKeyMissing
// 等縮批也不會好的）維持整批 failed，避免故障時 2N-1 次請求雪崩。
//
// SANITY 紀錄（已驗證）：暫時在 translate.js 的 `if (blocks.length >= 2 &&
// BISECTABLE_CODES.has(code))` 前加 `false &&` →「timeout 全批失敗 → 對切後
// 全數救回」與「PROHIBITED_CONTENT 隔離」兩個 case fail（整批 failed、無追加
// 請求）→ 還原 → 4 case 全綠。
import { test, expect } from '@playwright/test';

// ── Mock chrome（同 doc-batch-lang-mismatch-retry.spec.js 形狀）──
let storedKeys = {};
globalThis.window = globalThis.window || {};
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({ targetLanguage: 'zh-TW' }), set: async () => {}, remove: async () => {} },
    local: {
      get: async () => ({ ...storedKeys }),
      set: async (obj) => { Object.assign(storedKeys, obj); },
      remove: async (keys) => { [].concat(keys).forEach((k) => delete storedKeys[k]); },
    },
  },
  runtime: {},
};

const { translateDocument } = await import('../../shinkansen/translate-doc/translate.js');

const ZH = [
  '下車時，我注意到雪花正在飄落，天色沉得像要壓下來。',
  '我站在路肩仰望天空，庄內平原籠罩在低垂的厚雲之下。',
  '今天太陽同樣整日未曾露臉，白天的氣溫也幾乎沒有回升。',
  '風從河口的方向吹來，帶著融雪前特有的濕冷氣味。',
];

function makeDoc(n = 4) {
  const blocks = ZH.slice(0, n).map((t, i) => ({
    blockId: `b${i}`, type: 'paragraph', plainText: `src${i}`, epubSerializedText: `src${i}`,
  }));
  return { kind: 'epub', meta: { filename: 'x.epub' }, pages: [{ pageIndex: 0, blocks }] };
}

// 依呼叫序回應；記錄每次批次呼叫的 texts 長度
function mockBackground(responses) {
  const batchSizes = [];
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'LOG_USAGE') return { ok: true };
    batchSizes.push(msg.payload.texts.length);
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra batch call');
    return typeof r === 'function' ? r(msg) : r;
  };
  return batchSizes;
}

const ok = (texts) => ({ result: texts, usage: { inputTokens: 10, outputTokens: 5, billedCostUSD: 0.001 } });
const fail = (code, msg) => ({ ok: false, error: msg, errorCode: code });

test.describe('translateDocument 對切重試', () => {
  test.beforeEach(() => { storedKeys = {}; });

  test('timeout 全批失敗 → 對切成兩半、全數救回', async () => {
    const doc = makeDoc(4);
    const batchSizes = mockBackground([
      fail('timeout', '網路錯誤：逾時(120000ms)'),
      ok(ZH.slice(0, 2)),
      ok(ZH.slice(2, 4)),
    ]);
    const summary = await translateDocument(doc, { engine: 'gemini' });
    expect(batchSizes).toEqual([4, 2, 2]);
    expect(summary.failedBlocks).toBe(0);
    expect(doc.pages[0].blocks.every((b) => b.translationStatus === 'done')).toBe(true);
    // 成功 sub-batch 的 usage 都有記帳（兩批 × 10 input）
    expect(summary.cumulativeInputTokens).toBe(20);
  });

  test('PROHIBITED_CONTENT（emptyContent）→ 遞迴隔離觸發段、其餘救回', async () => {
    const doc = makeDoc(4);
    // 4 段失敗 → [b0,b1] 失敗 → b0 成功、b1 失敗（長度 1 不可再切 → failed）
    // → [b2,b3] 成功。呼叫序：4 → 2 → 1 → 1 → 2
    const batchSizes = mockBackground([
      fail('emptyContent', 'Gemini 回傳空內容（finishReason: PROHIBITED_CONTENT）。'),
      fail('emptyContent', 'Gemini 回傳空內容（finishReason: PROHIBITED_CONTENT）。'),
      ok(ZH.slice(0, 1)),
      fail('emptyContent', 'Gemini 回傳空內容（finishReason: PROHIBITED_CONTENT）。'),
      ok(ZH.slice(2, 4)),
    ]);
    const summary = await translateDocument(doc, { engine: 'gemini' });
    expect(batchSizes).toEqual([4, 2, 1, 1, 2]);
    expect(summary.failedBlocks).toBe(1);
    const blocks = doc.pages[0].blocks;
    expect(blocks[0].translationStatus).toBe('done');
    expect(blocks[1].translationStatus).toBe('failed');
    expect(blocks[1].translationError).toContain('PROHIBITED_CONTENT');
    expect(blocks[2].translationStatus).toBe('done');
    expect(blocks[3].translationStatus).toBe('done');
  });

  test('不可對切的錯誤碼（network）→ 整批 failed、不追加請求', async () => {
    const doc = makeDoc(4);
    const batchSizes = mockBackground([
      fail('network', '網路錯誤：Failed to fetch'),
    ]);
    const summary = await translateDocument(doc, { engine: 'gemini' });
    expect(batchSizes).toEqual([4]);
    expect(summary.failedBlocks).toBe(4);
    expect(doc.pages[0].blocks.every((b) => b.translationStatus === 'failed')).toBe(true);
  });

  test('沒帶 errorCode 的失敗（舊版背景 / 未知錯誤）→ 不對切、整批 failed', async () => {
    const doc = makeDoc(2);
    const batchSizes = mockBackground([
      { ok: false, error: 'something exploded' },
    ]);
    const summary = await translateDocument(doc, { engine: 'gemini' });
    expect(batchSizes).toEqual([2]);
    expect(summary.failedBlocks).toBe(2);
    expect(doc.pages[0].blocks[0].translationError).toBe('something exploded');
  });
});
