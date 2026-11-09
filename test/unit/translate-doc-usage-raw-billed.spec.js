// Unit test: translate-doc usage raw / billed 分開累計(§27 批次 4-6)
//
// Bug:translateDocument 用 `cumulativeInputTokens += usage.billedInputTokens ||
// usage.inputTokens` 起累計就丟掉 raw → LOG_USAGE 的 inputTokens 恆等
// billedInputTokens,「inputTokens vs billedInputTokens 差距」對帳維度永遠零折扣;
// 且 `||` 在 billedInputTokens === 0(全 cache hit / 全免費)時 fallback 到 raw,
// 語意相反。translateSingleBlock(retry 路徑)同病。
// 修法:raw / billed 各自累計,`??` 取代 `||`。
//
// 訊號層界定:本 spec 驗「translate.js 累計與 LOG_USAGE payload 組裝」這層
// (stub chrome.runtime.sendMessage);不驗 background 端 usage-db 實際入帳。
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 translateDocument 累計改回
// `usage.billedInputTokens || usage.inputTokens` 單變數混寫 → 「raw 與 billed
// 分開記」「billed=0 不得 fallback」斷言 fail;translateSingleBlock 的 LOG_USAGE
// payload 改回舊 `||` 寫法 → retry 斷言 fail。還原 → 全部 pass。

import { test, expect } from '@playwright/test';

function makeDoc(blockCount = 1) {
  return {
    meta: { filename: 'sample.pdf' },
    pages: [{
      blocks: Array.from({ length: blockCount }, (_, i) => ({
        blockId: `b${i}`,
        type: 'paragraph',
        plainText: `Hello world ${i}`,
        linkUrls: [],
      })),
    }],
  };
}

function stubChrome(usage, calls) {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        calls.push(msg);
        if (msg.type === 'TRANSLATE_DOC_BATCH') {
          return { result: msg.payload.texts.map(() => '譯文'), usage };
        }
        if (msg.type === 'LOG_USAGE') return undefined;
        throw new Error(`unexpected message: ${msg.type}`);
      },
    },
  };
}

test.describe('translate-doc usage raw/billed 分開累計', () => {
  test('raw 與 billed 分開記:LOG_USAGE 的 inputTokens 是 raw,billedInputTokens 是折扣後', async () => {
    const calls = [];
    stubChrome({ inputTokens: 1000, billedInputTokens: 250, outputTokens: 5, billedCostUSD: 0.01, cacheHits: 0 }, calls);
    const { translateDocument } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}u1`);
    const summary = await translateDocument(makeDoc());

    const logUsage = calls.find((c) => c.type === 'LOG_USAGE');
    expect(logUsage.payload.inputTokens).toBe(1000);
    expect(logUsage.payload.billedInputTokens).toBe(250);
    expect(summary.cumulativeInputTokens).toBe(1000);
    expect(summary.cumulativeBilledInputTokens).toBe(250);
  });

  test('billedInputTokens === 0 是合法值,不得 || fallback 成 raw', async () => {
    const calls = [];
    stubChrome({ inputTokens: 500, billedInputTokens: 0, outputTokens: 5, billedCostUSD: 0, cacheHits: 1 }, calls);
    const { translateDocument } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}u2`);
    const summary = await translateDocument(makeDoc());

    const logUsage = calls.find((c) => c.type === 'LOG_USAGE');
    expect(logUsage.payload.inputTokens).toBe(500);
    expect(logUsage.payload.billedInputTokens).toBe(0);
    expect(summary.cumulativeBilledInputTokens).toBe(0);
  });

  test('translateSingleBlock(retry)同樣 raw / billed 分開記', async () => {
    const calls = [];
    stubChrome({ inputTokens: 100, billedInputTokens: 30, outputTokens: 3, billedCostUSD: 0.001, cacheHits: 0 }, calls);
    const { translateSingleBlock } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}u3`);
    const block = { blockId: 'b1', type: 'paragraph', plainText: 'Hello', linkUrls: [] };
    const r = await translateSingleBlock(block, {});

    expect(r.ok).toBe(true);
    const logUsage = calls.find((c) => c.type === 'LOG_USAGE');
    expect(logUsage.payload.inputTokens).toBe(100);
    expect(logUsage.payload.billedInputTokens).toBe(30);
  });
});
