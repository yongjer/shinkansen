// Regression: doc-fetch-timeout-override（對應 v2.0.53 修的「日文書 850 段
// 全因 15s 逾時失敗」bug）
//
// Bug：gemini.js FETCH_TIMEOUT_MS=15s 的假設來自「網頁翻譯每批 ~20 段」；文件
// 翻譯每批可達 50 段長文，gemini-3.5-flash 輸出遠超 15s → 每批 abort 後重試
// 4 次、次次逾時 → 整批 failed。且 abort 掉的請求 Google 端照樣計費（client
// 拿不到 usageMetadata，usage-db / 本書累計費用都記不到）——4 倍計費 0 產出。
// 修法：TRANSLATE_DOC_BATCH* 兩個 handler 帶 120s 覆蓋 + 逾時重試降為 1 次
//（120s 還逾時代表批太大，交 translate-doc 對切重試縮批，不重複燒同尺寸請求）。
//
// 為什麼用 source 結構驗證：background.js 是 SW 入口含大量副作用 import,
// node 直接 import 不可行;handler 內 overrides 組裝是純字面值,結構斷言足以
// 擋「未來重構把覆蓋拔掉」的 regression（同 gemini-fetch-timeout.spec.js 慣例）。
//
// SANITY 紀錄（已驗證）：暫時把 TRANSLATE_DOC_BATCH handler 的
// `overrides.fetchTimeoutMs = ...` / `overrides.timeoutRetries = 1` 兩行註解掉
// →「Gemini 文件 handler 帶覆蓋」case fail → 還原 → 全綠。
// 教訓：斷言必須 `^\s*` 行首錨定 + m flag——第一輪沒錨定時,被註解掉的行
// 仍被 regex 匹配,SANITY 沒咬住,補錨定後才 fail。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BG_PATH = path.resolve(__dirname, '../../shinkansen/background.js');
const SRC = fs.readFileSync(BG_PATH, 'utf-8');

test('DOC_FETCH_TIMEOUT_MS 常數為 120_000', () => {
  expect(
    SRC,
    'background.js 缺 `const DOC_FETCH_TIMEOUT_MS = 120_000`(文件批次逾時放寬常數)',
  ).toMatch(/^\s*const\s+DOC_FETCH_TIMEOUT_MS\s*=\s*120_000\s*;/m);
});

test('TRANSLATE_DOC_BATCH（Gemini）handler 帶 fetchTimeoutMs 覆蓋 + timeoutRetries=1', () => {
  const hStart = SRC.indexOf('TRANSLATE_DOC_BATCH: {');
  expect(hStart, 'background.js 找不到 TRANSLATE_DOC_BATCH handler').toBeGreaterThan(-1);
  const hBody = SRC.slice(hStart, SRC.indexOf('TRANSLATE_DOC_BATCH_CUSTOM: {', hStart));
  // ^\s* 行首錨定:被註解掉的 `// overrides.fetchTimeoutMs = ...` 不得矇混過關
  expect(
    hBody,
    'TRANSLATE_DOC_BATCH 缺 `overrides.fetchTimeoutMs = DOC_FETCH_TIMEOUT_MS`(文件批次會退回 15s 逾時)',
  ).toMatch(/^\s*overrides\.fetchTimeoutMs\s*=\s*DOC_FETCH_TIMEOUT_MS/m);
  expect(
    hBody,
    'TRANSLATE_DOC_BATCH 缺 `overrides.timeoutRetries = 1`(逾時會重試 4 次同尺寸請求,4 倍計費 0 產出)',
  ).toMatch(/^\s*overrides\.timeoutRetries\s*=\s*1/m);
});

test('TRANSLATE_DOC_BATCH_CUSTOM（openai-compat）handler 帶 fetchTimeoutSec 覆蓋（尊重使用者更大值）', () => {
  const hStart = SRC.indexOf('TRANSLATE_DOC_BATCH_CUSTOM: {');
  expect(hStart, 'background.js 找不到 TRANSLATE_DOC_BATCH_CUSTOM handler').toBeGreaterThan(-1);
  // handler body 到下一個 top-level handler key 為止,取 2000 字元足夠
  const hBody = SRC.slice(hStart, hStart + 2000);
  expect(
    hBody,
    'TRANSLATE_DOC_BATCH_CUSTOM 缺 `overrides.fetchTimeoutSec = Math.max(DOC_FETCH_TIMEOUT_MS / 1000, ...)` 覆蓋',
  ).toMatch(/^\s*overrides\.fetchTimeoutSec\s*=\s*Math\.max\(\s*\n?\s*DOC_FETCH_TIMEOUT_MS\s*\/\s*1000/m);
});
