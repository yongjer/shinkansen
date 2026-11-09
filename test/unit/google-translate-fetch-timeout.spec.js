// Unit test: google-translate _fetchTranslate 必含 15s fetch-level timeout(v1.9.21)
//
// 背景:Google Translate 非官方端點 typical < 1s 回,但偶爾會 hang(連 retry 都沒)。
// 跟 Gemini / OpenAI 對齊 15s。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_PATH = path.resolve(__dirname, '../../shinkansen/lib/google-translate.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf-8');

test('FETCH_TIMEOUT_MS 常數為 15_000', () => {
  expect(
    SRC,
    'google-translate.js 缺 `const FETCH_TIMEOUT_MS = 15_000`',
  ).toMatch(/const\s+FETCH_TIMEOUT_MS\s*=\s*15_000\s*;/);
});

test('_fetchTranslate 內含 AbortController + setTimeout(abort, FETCH_TIMEOUT_MS)', () => {
  const fnStart = SRC.indexOf('async function _fetchTranslate');
  expect(fnStart, 'google-translate.js 找不到 _fetchTranslate').toBeGreaterThan(-1);
  const fnBody = SRC.slice(fnStart, fnStart + 1500);

  expect(fnBody, '缺 AbortController').toMatch(/new\s+AbortController\s*\(\s*\)/);
  expect(
    fnBody,
    '缺 `setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)`',
  ).toMatch(/setTimeout\s*\(\s*\(\s*\)\s*=>\s*controller\.abort\s*\(\s*\)\s*,\s*FETCH_TIMEOUT_MS\s*\)/);
});

test('fetch 帶 `signal: controller.signal`', () => {
  const fnStart = SRC.indexOf('async function _fetchTranslate');
  const fnBody = SRC.slice(fnStart, fnStart + 1500);
  expect(
    fnBody,
    '_fetchTranslate fetch options 缺 `signal: controller.signal`',
  ).toMatch(/signal\s*:\s*controller\.signal/);
});

test('AbortError 轉換成有意義訊息(不裸 throw AbortError)', () => {
  const fnStart = SRC.indexOf('async function _fetchTranslate');
  const fnBody = SRC.slice(fnStart, fnStart + 1500);
  expect(
    fnBody,
    '_fetchTranslate 缺 AbortError → `Google Translate 逾時(...)` 訊息轉換',
  ).toMatch(/err\.name\s*===\s*['"]AbortError['"][\s\S]{0,200}逾時/);
});

// v1.10.46(批次 2-2):timer 涵蓋到 resp.json() 讀完(同 lib/gemini.js 修法,
// fetch resolve 只代表 headers 到,body 中途吊住時 json 讀取可無限 pending)
// SANITY 紀錄(已驗證,2026-06-11):暫時把 try 內 `data = await resp.json()` 改名廢掉
// → 「resp.json() 在 timer 涵蓋內」case fail → 還原 → pass
test('2-2: resp.json() 在 timer 涵蓋內(clearTimeout 走 finally)', () => {
  const fnStart = SRC.indexOf('async function _fetchTranslate');
  const fnBody = SRC.slice(fnStart, fnStart + 1500);
  expect(
    fnBody,
    '_fetchTranslate 缺 `finally { clearTimeout(abortTimer); }`(json 讀完才清 timer)',
  ).toMatch(/finally\s*\{\s*clearTimeout\s*\(\s*abortTimer\s*\)\s*;?\s*\}/);
  // json 讀取必須在 finally 之前(同一 try 區塊內)
  const tryIdx = fnBody.indexOf('data = await resp.json()');
  const finallyIdx = fnBody.indexOf('finally');
  expect(tryIdx, '_fetchTranslate 缺 try 區塊內的 `data = await resp.json()`').toBeGreaterThan(-1);
  expect(tryIdx, 'resp.json() 應在 finally(清 timer)之前').toBeLessThan(finallyIdx);
});
