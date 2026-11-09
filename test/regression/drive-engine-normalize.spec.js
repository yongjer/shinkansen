// Regression: Drive viewer engine 支援 openai-compat(不再 silently fallback Gemini)
//
// 背景:v1.9.6 之前 content-drive.js 的 _engine 解析只認 'google',其餘(含
// 'openai-compat')一律強制收歛到 'gemini'。使用者把 popup engine 設成 openai-compat
// 想用自己的 OpenAI 規格 API → Drive 影片字幕被 Gemini 翻(吃 Gemini key)→ 沒設
// Gemini key 時 Drive 字幕整批 fail,使用者沒有任何 UX 反饋為什麼。
//
// 修法:
//   1. 新增 _normalizeDriveEngine(v) 把原值轉成三選一:'google' / 'openai-compat' / 'gemini'
//   2. 設定載入 + storage onChange handler 都改走這條
//   3. dispatch switch 加 'openai-compat' → 走新的 _runOneBatchCustom
//   4. background.js 加 TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM handler(cache key '_oc_drive_yt_asr')
//
// 本檔驗:
//   - SK._driveNormalizeEngine 存在且對三類輸入回對應值
//   - 未知值 / undefined / null fallback 'gemini'
//
// 不在本檔驗(需真實 Drive viewer 環境):
//   - _runOneBatchCustom 對 batch 送出 TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM 的細節
//     (定義在 gate `location.hostname === 'drive.google.com'` 後,localServer 不會載入)
//   - 整支 worker dispatch 流程(同上,gate 之後)
//   這部分由 code review + Jimmy 在 Drive viewer 真實驗收 cover。
//
// SANITY 紀錄(已驗證):暫時把 _normalizeDriveEngine 的 'openai-compat' 分支拿掉
// → spec「openai-compat → openai-compat」fail(回傳 'gemini');還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('SK._driveNormalizeEngine 存在', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const has = await evaluate(`typeof window.__SK._driveNormalizeEngine`);
  expect(has, 'SK._driveNormalizeEngine 應為 function').toBe('function');

  await page.close();
});

test('SK._driveNormalizeEngine:三類有效值都對映回自己', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const fn = window.__SK._driveNormalizeEngine;
      return {
        gemini: fn('gemini'),
        google: fn('google'),
        openaiCompat: fn('openai-compat'),
      };
    })()
  `);
  expect(r.gemini).toBe('gemini');
  expect(r.google).toBe('google');
  expect(r.openaiCompat, 'openai-compat 不再 silently fallback gemini').toBe('openai-compat');

  await page.close();
});

test('SK._driveNormalizeEngine:未知值 / undefined / null / 空字串都 fallback gemini', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const fn = window.__SK._driveNormalizeEngine;
      return {
        unknown: fn('whatever'),
        und: fn(undefined),
        nul: fn(null),
        empty: fn(''),
      };
    })()
  `);
  expect(r.unknown).toBe('gemini');
  expect(r.und).toBe('gemini');
  expect(r.nul).toBe('gemini');
  expect(r.empty).toBe('gemini');

  await page.close();
});
