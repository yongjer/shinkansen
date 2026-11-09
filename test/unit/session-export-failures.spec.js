// Regression: session-export-failures（對應 v2.0.52「session 匯出檔無法診斷翻譯
// 失敗」改進）
//
// Bug／限制：exportEpubSession 只存 done blocks（raw/plain/edited），失敗 block
// 連狀態、錯誤訊息、原文都不進檔——拿到 session 檔只能從 blockId 缺席反推
//「哪個範圍失敗」，無法診斷原因（實例：50 段語言驗證失敗批，檔內零線索）。
// 修法：epub-session-db.js 新增 collectSessionFailures，匯出檔以獨立 `failures`
// 欄帶 blockId / 章節 / 錯誤訊息 / 原文；不混進 blocks map（hydrate 把 blocks 的
// 存在視為 done，混放會把失敗段當譯文灌回），匯入端不 hydrate（失敗是暫態）。
//
// SANITY 紀錄（已驗證）：暫時把 collectSessionFailures 改成 `return []` →
//「failed block 進 failures 欄」斷言收到空陣列 fail → 還原 → pass。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const {
  collectSessionBlocks,
  collectSessionFailures,
  hydrateSessionBlocks,
} = await import('../../shinkansen/translate-doc/epub-session-db.js');

function makeDoc() {
  return {
    chapters: [
      {
        index: 6,
        title: '背向故鄉',
        blocks: [
          { blockId: 'c6-b0', translationStatus: 'done', translationRaw: '第一章', translation: '第一章', editedHtml: null, plainText: '一章' },
          { blockId: 'c6-b1', translationStatus: 'failed', translationError: '譯文語言與目標語言不符，自動重試一次仍失敗，請重新翻譯', plainText: '「秘書役ならときどきやってるわ」' },
          { blockId: 'c6-b2', translationStatus: 'pending', plainText: '空が一層暗くなってきた。' },
          { blockId: 'c6-b3', translationStatus: 'failed', translationError: 'no response', plainText: '首が落ちていた。' },
        ],
      },
    ],
  };
}

test.describe('collectSessionFailures', () => {
  test('failed block 進 failures 欄（blockId / 章節 / 錯誤 / 原文），其他狀態不收', () => {
    const failures = collectSessionFailures(makeDoc());
    expect(failures).toEqual([
      {
        blockId: 'c6-b1', chapterIndex: 6, chapterTitle: '背向故鄉',
        error: '譯文語言與目標語言不符，自動重試一次仍失敗，請重新翻譯',
        source: '「秘書役ならときどきやってるわ」',
      },
      {
        blockId: 'c6-b3', chapterIndex: 6, chapterTitle: '背向故鄉',
        error: 'no response',
        source: '首が落ちていた。',
      },
    ]);
  });

  test('全部成功時 failures 為空陣列', () => {
    const doc = makeDoc();
    doc.chapters[0].blocks.forEach((b) => { b.translationStatus = 'done'; });
    expect(collectSessionFailures(doc)).toEqual([]);
  });

  test('failures 與 blocks 分離：failed block 不進 blocks map、hydrate 不受影響', () => {
    const doc = makeDoc();
    const blocks = collectSessionBlocks(doc);
    expect(Object.keys(blocks)).toEqual(['c6-b0']); // 只有 done
    // 模擬匯入:hydrate 只認 blocks,失敗診斷欄不會把失敗段灌成 done
    const fresh = makeDoc();
    fresh.chapters[0].blocks.forEach((b) => {
      b.translation = null; b.translationRaw = null; b.editedHtml = null;
      b.translationStatus = 'pending'; b.translationError = null;
    });
    const restored = hydrateSessionBlocks(fresh, blocks);
    expect(restored).toBe(1);
    expect(fresh.chapters[0].blocks[1].translationStatus).toBe('pending');
  });
});

test.describe('exportEpubSession 接線（source 斷言）', () => {
  test('index.js 匯出 payload 含 failures: collectSessionFailures(...)', () => {
    const src = readFileSync(new URL('../../shinkansen/translate-doc/index.js', import.meta.url), 'utf-8');
    expect(src).toMatch(/failures: collectSessionFailures\(currentDoc\)/);
  });
});
