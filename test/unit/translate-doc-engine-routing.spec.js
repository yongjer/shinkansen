// Unit test: translate-doc engine routing
//
// 目標:
//   1. 沒帶 engine / engine='gemini' 時，仍走既有 TRANSLATE_DOC_BATCH。
//   2. engine='openai-compat' 時，才切到 TRANSLATE_DOC_BATCH_CUSTOM。
//   3. LOG_USAGE 的 engine 欄位要跟實際 dispatch path 一致。
//
// 這條主要是保護「加 custom provider 後不要把 Gemini 文件翻譯路徑帶壞」。

import { test, expect } from '@playwright/test';

function makeDoc() {
  return {
    meta: { filename: 'sample.pdf' },
    pages: [{
      blocks: [{
        blockId: 'b1',
        type: 'paragraph',
        plainText: 'Hello world',
        linkUrls: [],
      }],
    }],
  };
}

test.describe('translate-doc engine routing', () => {
  test('translateDocument 預設仍走 Gemini handler', async () => {
    const calls = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          calls.push(msg);
          if (msg.type === 'TRANSLATE_DOC_BATCH') {
            return {
              result: ['你好世界'],
              usage: { inputTokens: 10, outputTokens: 5, cacheHits: 0 },
            };
          }
          if (msg.type === 'LOG_USAGE') return undefined;
          throw new Error(`unexpected message: ${msg.type}`);
        },
      },
    };

    const { translateDocument } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}a`);
    const summary = await translateDocument(makeDoc());

    expect(summary.failedBlocks).toBe(0);
    expect(calls[0].type).toBe('TRANSLATE_DOC_BATCH');
    expect(calls[1].type).toBe('LOG_USAGE');
    expect(calls[1].payload.engine).toBe('gemini');
  });

  test('translateDocument 在 openai-compat 時切 custom handler', async () => {
    const calls = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          calls.push(msg);
          if (msg.type === 'TRANSLATE_DOC_BATCH_CUSTOM') {
            return {
              result: ['你好世界'],
              usage: { inputTokens: 10, outputTokens: 5, cacheHits: 0 },
            };
          }
          if (msg.type === 'LOG_USAGE') return undefined;
          throw new Error(`unexpected message: ${msg.type}`);
        },
      },
    };

    const { translateDocument } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}b`);
    const summary = await translateDocument(makeDoc(), { engine: 'openai-compat' });

    expect(summary.failedBlocks).toBe(0);
    expect(calls[0].type).toBe('TRANSLATE_DOC_BATCH_CUSTOM');
    expect(calls[1].type).toBe('LOG_USAGE');
    expect(calls[1].payload.engine).toBe('openai-compat');
  });

  test('translateSingleBlock 預設仍走 Gemini handler', async () => {
    const calls = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          calls.push(msg);
          if (msg.type === 'TRANSLATE_DOC_BATCH') {
            return {
              result: ['你好世界'],
              usage: { inputTokens: 3, outputTokens: 2, cacheHits: 0 },
            };
          }
          if (msg.type === 'LOG_USAGE') return undefined;
          throw new Error(`unexpected message: ${msg.type}`);
        },
      },
    };

    const { translateSingleBlock } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}c`);
    const block = makeDoc().pages[0].blocks[0];
    const result = await translateSingleBlock(block);

    expect(result.ok).toBe(true);
    expect(calls[0].type).toBe('TRANSLATE_DOC_BATCH');
    expect(calls[1].payload.engine).toBe('gemini');
  });

  test('translateSingleBlock 在 openai-compat 時切 custom handler', async () => {
    const calls = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          calls.push(msg);
          if (msg.type === 'TRANSLATE_DOC_BATCH_CUSTOM') {
            return {
              result: ['你好世界'],
              usage: { inputTokens: 3, outputTokens: 2, cacheHits: 0 },
            };
          }
          if (msg.type === 'LOG_USAGE') return undefined;
          throw new Error(`unexpected message: ${msg.type}`);
        },
      },
    };

    const { translateSingleBlock } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}d`);
    const block = makeDoc().pages[0].blocks[0];
    const result = await translateSingleBlock(block, { engine: 'openai-compat' });

    expect(result.ok).toBe(true);
    expect(calls[0].type).toBe('TRANSLATE_DOC_BATCH_CUSTOM');
    expect(calls[1].payload.engine).toBe('openai-compat');
  });

  // v1.9.6: Google MT 沒文件翻譯 handler（沒 batch-aware marker / glossary 注入機制），
  // 必須早期 throw / reject，避免 silent fall-through 跑 Gemini 用錯 key / 錯 model。
  // UI 層（index.js startTranslate）在更早攔下並顯示提示，這層是防禦深度。
  //
  // SANITY 紀錄（已驗證）：移除 translate.js 內 engine === 'google' 兩處 guard 後，
  // 下面 2 條 case 會 fail（translateDocument 改 fall through 跑 chrome.runtime.sendMessage，
  // translateSingleBlock 改回 ok:true）。還原後 2 條全 pass。

  test('translateDocument: engine="google" 早期 throw，不送任何訊息', async () => {
    const calls = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          calls.push(msg);
          return { result: ['x'], usage: { inputTokens: 0, outputTokens: 0, cacheHits: 0 } };
        },
      },
    };

    const { translateDocument } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}e`);
    await expect(translateDocument(makeDoc(), { engine: 'google' }))
      .rejects.toThrow(/Google Translate/);
    expect(calls.length).toBe(0); // 早期 throw，不該送出任何 chrome.runtime.sendMessage
  });

  test('translateSingleBlock: engine="google" 回傳 ok:false，不送任何訊息', async () => {
    const calls = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          calls.push(msg);
          return { result: ['x'], usage: { inputTokens: 0, outputTokens: 0, cacheHits: 0 } };
        },
      },
    };

    const { translateSingleBlock } = await import(`../../shinkansen/translate-doc/translate.js?cb=${Date.now()}f`);
    const block = makeDoc().pages[0].blocks[0];
    const result = await translateSingleBlock(block, { engine: 'google' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Google Translate/);
    expect(calls.length).toBe(0);
  });
});
