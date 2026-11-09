// Regression: doc-batch-lang-mismatch-retry（對應 v2.0.52 修的「EPUB 某批完全
// 沒翻成目標語言」bug）
//
// Bug：模型偶發把「整批」翻成原文語言（實例:日文書某批「譯文」是日文改寫，
// 下一批正常），translate.js 對輸出零驗證直接標 done，且錯譯已被 background 寫進
// tc_ 快取——重翻章節若不清快取會秒回同一批錯譯。
// 修法：batch 級輸出語言驗證（detectDocBatchLangMismatch，字系絕對量 + 佔比雙門檻）
// → 命中先清該批 tc_ 快取再重試一次 → 仍錯標整批 failed（再清一次快取），
// 最壞成本上限 = 該批 2 次 API 呼叫。
//
// SANITY 紀錄（已驗證）：暫時把 translate.js 的
// `if (detectDocBatchLangMismatch(response.result, targetLanguage))` 改成 `if (false)`
// → 「日文輸出 → 重試成功」case 的 sendMessage 次數斷言（預期 2 次 TRANSLATE_DOC_BATCH）
// 收到 1、譯文斷言收到日文 fail → 還原 → pass。
import { test, expect } from '@playwright/test';

// ── Mock chrome ──────────────────────────────────────────────
let storedKeys = {};
let removedKeys = [];
globalThis.window = globalThis.window || {};
globalThis.chrome = {
  storage: {
    // targetLanguage 固定 zh-TW:node 環境沒有 navigator.language,不 mock 會走
    // detectDefaultTargetLanguage() fallback 到 'en',語言驗證方向整個歪掉
    sync:  { get: async () => ({ targetLanguage: 'zh-TW' }), set: async () => {}, remove: async () => {} },
    local: {
      get: async () => ({ ...storedKeys }),
      set: async (obj) => { Object.assign(storedKeys, obj); },
      remove: async (keys) => { removedKeys.push(...[].concat(keys)); [].concat(keys).forEach((k) => delete storedKeys[k]); },
    },
  },
  runtime: {},
};

const {
  translateDocument,
  detectDocBatchLangMismatch,
} = await import('../../shinkansen/translate-doc/translate.js');

// ── detectDocBatchLangMismatch 純函式 ────────────────────────
const JA_BATCH = [
  '車から下りて雪のちらついているのに気づいた。',
  '道路縁に立って空を見上げた。庄内平野は厚く張り巡らされた雲の下にあった。きょうも太陽が一日姿を見せることなく終わり、日中の気温は殆ど上がらなかった。',
];
const ZH_BATCH = [
  '下車時，我注意到雪花正在飄落。',
  '我站在路肩仰望天空。庄內平原籠罩在低垂的厚雲之下。今天太陽同樣整日未曾露臉，白天的氣溫也幾乎沒有回升。',
];

test.describe('detectDocBatchLangMismatch', () => {
  test('zh target + 整批日文輸出 → mismatch', () => {
    expect(detectDocBatchLangMismatch(JA_BATCH, 'zh-TW')).toBe(true);
    expect(detectDocBatchLangMismatch(JA_BATCH, 'zh-CN')).toBe(true);
  });

  test('zh target + 正常繁中輸出 → 不觸發', () => {
    expect(detectDocBatchLangMismatch(ZH_BATCH, 'zh-TW')).toBe(false);
  });

  test('zh target + 譯文合法引用少量假名（書名對照）→ 不觸發', () => {
    const withQuote = [
      '他從書架上取出《挪威的森林》（ノルウェイの森），這本小說是勝又的愛讀書，川口也反覆讀過好幾次。早紀子從山形的大學畢業後，就進了當地的經濟連工作，這份工作算是靠父親的關係安排的。',
    ];
    expect(detectDocBatchLangMismatch(withQuote, 'zh-TW')).toBe(false);
  });

  test('ja target 永不觸發（目標本來就是日文）', () => {
    expect(detectDocBatchLangMismatch(JA_BATCH, 'ja')).toBe(false);
  });

  test('en target + 整批 CJK 輸出 → mismatch；正常英文 → 不觸發', () => {
    expect(detectDocBatchLangMismatch(JA_BATCH, 'en')).toBe(true);
    expect(detectDocBatchLangMismatch(ZH_BATCH, 'en')).toBe(true);
    expect(detectDocBatchLangMismatch(
      ['Stepping off the car, I noticed snow was flurrying down from the heavy sky above the plain.'], 'en',
    )).toBe(false);
  });

  test('短批（<40 字）樣本不足 → 不觸發', () => {
    expect(detectDocBatchLangMismatch(['一章'], 'zh-TW')).toBe(false);
  });
});

// ── translateDocument 整條 retry 流程（mock background）──────
function makeDoc() {
  // TRANSLATABLE_TYPES 含 'paragraph'（block-types.js）
  const blocks = JA_BATCH.map((t, i) => ({
    blockId: `b${i}`, type: 'paragraph', plainText: t, epubSerializedText: t,
  }));
  return { kind: 'epub', meta: { filename: 'x.epub' }, pages: [{ pageIndex: 0, blocks }] };
}

function mockBackground(responses) {
  const calls = [];
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    calls.push(msg);
    if (msg.type === 'LOG_USAGE') return { ok: true };
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra batch call');
    return r;
  };
  return calls;
}

test.describe('translateDocument:語言驗證 + 單次重試', () => {
  test.beforeEach(() => { storedKeys = {}; removedKeys = []; });

  test('首發日文 → 清該批 tc_ 快取 → 重試回繁中 → done', async () => {
    const doc = makeDoc();
    // 先種該批的假快取 key（用 background 同款 sha1 prefix），驗重試前有被清
    const enc = new TextEncoder();
    for (const t of JA_BATCH) {
      const buf = await crypto.subtle.digest('SHA-1', enc.encode(t));
      const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      storedKeys[`tc_${hex}`] = { v: 'bad' };
    }
    const calls = mockBackground([
      { result: JA_BATCH, usage: { inputTokens: 100, outputTokens: 50, billedCostUSD: 0.001 } },
      { result: ZH_BATCH, usage: { inputTokens: 100, outputTokens: 60, billedCostUSD: 0.001 } },
    ]);
    const summary = await translateDocument(doc, { engine: 'gemini' });
    const batchCalls = calls.filter((c) => c.type === 'TRANSLATE_DOC_BATCH');
    expect(batchCalls).toHaveLength(2);
    const blocks = doc.pages[0].blocks;
    expect(blocks.every((b) => b.translationStatus === 'done')).toBe(true);
    expect(blocks[0].translation).toContain('下車時');
    expect(removedKeys.filter((k) => k.startsWith('tc_'))).toHaveLength(2); // 重試前清了該批快取
    expect(summary.failedBlocks).toBe(0);
    // 兩次嘗試的 usage 都要記帳（第一發也是真實花費）
    expect(summary.cumulativeInputTokens).toBe(200);
  });

  test('重試仍日文 → 整批 failed + 快取再清一次（不留錯譯）', async () => {
    const doc = makeDoc();
    mockBackground([
      { result: JA_BATCH, usage: { inputTokens: 100, outputTokens: 50 } },
      { result: JA_BATCH.slice().reverse(), usage: { inputTokens: 100, outputTokens: 50 } },
    ]);
    const summary = await translateDocument(doc, { engine: 'gemini' });
    const blocks = doc.pages[0].blocks;
    expect(blocks.every((b) => b.translationStatus === 'failed')).toBe(true);
    expect(blocks[0].translationError).toBeTruthy();
    expect(summary.failedBlocks).toBe(2);
  });

  test('首發即正常繁中 → 單次呼叫、不清快取', async () => {
    const doc = makeDoc();
    const calls = mockBackground([
      { result: ZH_BATCH, usage: { inputTokens: 100, outputTokens: 60 } },
    ]);
    const summary = await translateDocument(doc, { engine: 'gemini' });
    expect(calls.filter((c) => c.type === 'TRANSLATE_DOC_BATCH')).toHaveLength(1);
    expect(removedKeys).toHaveLength(0);
    expect(summary.failedBlocks).toBe(0);
  });
});
