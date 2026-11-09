'use strict';

/**
 * §27 批次 4-1 / 4-2(code review 2026-06-11):PDF 解析取消與 pdfDoc 洩漏防護。
 *
 * 4-1: parseAbortController 原本從未被賦值(只有宣告 / abort / 清 null)→ 取消鈕
 *   實際停不掉 parse;且 in-flight handleFile 跑完會 showStage('result') 蓋掉取消。
 *   修法:handleFile generation token(myGen / parseGeneration)+ AbortController
 *   真的接進 parsePdf({ signal })。
 *
 * 4-2: analyzeLayout throw 時 rawDoc.pdfDoc 洩漏 — catch 的 releaseCurrentDoc 只
 *   destroy currentPdfDoc(此時還是 null / 舊值);parsePdf page loop 中途非
 *   PdfParseError 例外同樣不 destroy。修法:index.js catch 內補
 *   rawDoc.pdfDoc !== currentPdfDoc 的 closeDocument;pdf-engine.js 把 pdfDoc
 *   開啟後的本體抽 extractRawDoc,parsePdf 包 try/catch 統一 destroy 再 rethrow。
 *
 * 為什麼是 source 斷言而非行為測試(訊號層次,CLAUDE.md 工作流原則 §3;同
 * cache-key-stream-mismatch.test.cjs 前例):
 *   「pdfDoc 有沒有被 destroy」是 PDF.js Worker 內部資源狀態,DOM / spec 觀測不到;
 *   取消的「使用者可見行為」層已由 test/regression/pdf-parse-cancel.spec.js 行為級
 *   驗證(取消後 result 不得蓋回 + 重新上傳正常)。本檔鎖「洩漏防護結構存在」:
 *     1. parsePdf 對 extractRawDoc 包 try/catch 且 catch 內 closeDocument(pdfDoc)
 *     2. page loop 開頭檢查 signal.aborted
 *     3. index.js handleFile 把 signal 傳進 parsePdf
 *     4. index.js catch 內有 rawDoc.pdfDoc !== currentPdfDoc 的補 destroy
 *   它「不鎖」destroy 真的釋放 Worker 記憶體(那是 PDF.js 的事)。
 *
 * SANITY 紀錄(已驗證,2026-06-11):
 *   - 暫時把 parsePdf 的 catch 內 closeDocument(pdfDoc) 拿掉 → 斷言 1 fail;還原 → pass
 *   - 暫時把 index.js catch 的 rawDoc 補 destroy 拿掉 → 斷言 4 fail;還原 → pass
 */

const fs = require('fs');
const path = require('path');

const ENGINE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/translate-doc/pdf-engine.js'),
  'utf-8'
);
const INDEX_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/translate-doc/index.js'),
  'utf-8'
);

describe('4-2: parsePdf 中途 throw 必須 destroy pdfDoc', () => {
  test('parsePdf 對 extractRawDoc 包 try/catch 且 catch 內 closeDocument(pdfDoc)', () => {
    expect(ENGINE_SRC).toMatch(
      /return await extractRawDoc\(pdfDoc, file, onProgress, options\);\s*\n\s*\} catch \(err\) \{\s*\n\s*closeDocument\(pdfDoc\);\s*\n\s*throw err;/
    );
  });

  test('extractRawDoc 內不再有逐分支 pdfDoc.destroy()(統一由 parsePdf catch 釋放)', () => {
    const body = ENGINE_SRC.slice(ENGINE_SRC.indexOf('async function extractRawDoc'));
    const beforeNextFn = body.slice(0, body.indexOf('export async function renderPageToCanvas'));
    expect(beforeNextFn).not.toMatch(/pdfDoc\.destroy\(\)/);
  });

  test('index.js handleFile catch 內補 destroy 未掛上 currentPdfDoc 的 rawDoc.pdfDoc', () => {
    const matches = INDEX_SRC.match(
      /if \(rawDoc && rawDoc\.pdfDoc && rawDoc\.pdfDoc !== currentPdfDoc\) closeDocument\(rawDoc\.pdfDoc\);/g
    ) || [];
    // 取消分支 + 失敗分支各一處
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('4-1: 取消真的接到 parse 流程', () => {
  test('parsePdf page loop 開頭檢查 signal.aborted 並 throw aborted', () => {
    expect(ENGINE_SRC).toMatch(/if \(signal && signal\.aborted\) \{\s*\n\s*throw new PdfParseError\('aborted'/);
  });

  test('handleFile 把 AbortController signal 傳進 parsePdf', () => {
    expect(INDEX_SRC).toMatch(/parseAbortController = new AbortController\(\);/);
    expect(INDEX_SRC).toMatch(/\}, \{ signal: parseSignal \}\);/);
  });

  test('cancel handler 會 ++parseGeneration 讓舊輪丟棄結果', () => {
    const cancelHandler = INDEX_SRC.slice(
      INDEX_SRC.indexOf("$('cancel-btn').addEventListener"),
      INDEX_SRC.indexOf("$('translate-btn').addEventListener")
    );
    expect(cancelHandler).toMatch(/parseGeneration\+\+/);
    expect(cancelHandler).toMatch(/parseAbortController\.abort\(\)/);
  });
});
