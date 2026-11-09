'use strict';

/**
 * L2(a)（code review 2026-06-09）：content-drive.js 的 _runOneBatchGemini 與 _runOneBatchCustom
 * 兩個函式只差「送的 message type」與「log 標籤」，其餘逐字相同。合一成共用核心
 * _runOneBatchLlm(batch, batchIdx, totalBatches, msgType, engineLabel)，Gemini / OpenAI-compat
 * 兩條 dispatch 各自傳對應的 msgType。Google 版（輸入純文字、無 JSON parse、時間戳函式內自算）
 * 結構不同，刻意不折進來。
 *
 * 為什麼是 source 斷言而非行為測試（訊號層次，CLAUDE.md 工作流原則 §3）：
 *   _runOneBatchLlm 在 content-drive.js 的 IIFE 內（掛 window.__SK），要行為測得跑完整
 *   content-script env（safeSendMessage mock + DRIVE state + parseAsrResponse），既有
 *   drive-bilingual-overlay / drive-engine-normalize spec 已覆蓋 overlay / render 正確性。
 *   本次純重構的「唯一真實風險」是合一後兩 engine 不小心都路由到同一個 message type
 *   （Custom 路徑被 Gemini 蓋掉，自訂 Provider 翻譯整條打到錯 handler）。本 spec 就鎖這件事：
 *     1. 舊兩函式已不存在、新核心存在
 *     2. dispatch 的 gemini 分支傳 TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH
 *     3. dispatch 的 openai-compat 分支傳 TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM
 *     4. 兩個 msgType 不相同（防退化成單一 type）
 *   它「不鎖」翻譯結果正確——那走既有 drive integration spec。
 *
 * SANITY 紀錄（已驗證，2026-06-09）：
 *   - 暫時把 openai-compat 分支的 ..._CUSTOM 改成 ...BATCH（跟 gemini 同 type）→ 「兩 msgType
 *     不同」斷言 fail；還原 → pass
 *   - 暫時把 _runOneBatchLlm 改名回 _runOneBatchGemini → 「新核心存在」斷言 fail；還原 → pass
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/content-drive.js'),
  'utf-8'
);

describe('L2(a) drive Gemini+Custom 合一', () => {
  test('舊兩函式已移除，新共用核心 _runOneBatchLlm 存在', () => {
    expect(SRC).not.toMatch(/function\s+_runOneBatchGemini\b/);
    expect(SRC).not.toMatch(/function\s+_runOneBatchCustom\b/);
    expect(SRC).toMatch(/async\s+function\s+_runOneBatchLlm\(batch,\s*batchIdx,\s*totalBatches,\s*msgType,\s*engineLabel\)/);
  });

  test('共用核心送 message 用參數化的 msgType（不寫死單一 type）', () => {
    // _runOneBatchLlm body 內送 message 的 type 是變數 msgType，不是字面值
    expect(SRC).toMatch(/type:\s*msgType/);
  });

  test('Google 版維持獨立（結構不同，刻意不折進來）', () => {
    expect(SRC).toMatch(/async\s+function\s+_runOneBatchGoogle\b/);
  });

  test('dispatch：gemini 分支傳 TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH', () => {
    expect(SRC).toMatch(
      /_runOneBatchLlm\([^)]*'TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH',\s*'gemini'\)/
    );
  });

  test('dispatch：openai-compat 分支傳 TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM', () => {
    expect(SRC).toMatch(
      /_runOneBatchLlm\([^)]*'TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM',\s*'openai-compat'\)/
    );
  });

  test('兩 engine 的 msgType 不相同（防合一退化成單一 type，Custom 被 Gemini 蓋掉）', () => {
    const calls = [...SRC.matchAll(/_runOneBatchLlm\([^)]*'(TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH[A-Z_]*)'/g)]
      .map(m => m[1]);
    expect(calls).toContain('TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH');
    expect(calls).toContain('TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM');
    expect(new Set(calls).size).toBe(2);
  });
});
