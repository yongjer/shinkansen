// Regression: displayCues 內出現 undefined / null slot 時不該 throw(v1.9.22)
//
// Bug 紀錄:Chrome for Claude 實機跑 20-iter seek stress,log 看到
//   "asr llm overlay failed: Cannot read properties of undefined (reading 'startMs')"
// 6/20 次。root cause 未完全定位(疑似 race condition / sparse array),但症狀明確:
//   _findActiveCue / _upsertDisplayCue 內 iterate cues 時 c.startMs throw on undefined。
//
// 修法(防禦性):
//   1. _findActiveCue 內 `if (!c) continue;` skip null/undefined slot
//   2. _upsertDisplayCue replaceRange splice loop 內 `c &&` 才比對
//   3. _upsertDisplayCue findIndex callback `c &&` 才比對
//   4. _upsertDisplayCue sort 前過濾掉 falsy 元素(防 sort comparator 對 undefined 行為未定義)
//   5. _runAsrSubBatch 內 subSegs.filter 加 `seg &&` null guard
//
// SANITY:把 _findActiveCue 的 null guard 拔掉 → case 1 fail(throw TypeError)。

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/content-youtube.js'), 'utf-8');

test('case 1: _findActiveCue 內 null guard 存在(`if (!c) continue;`)', () => {
  const fnStart = SRC.indexOf('function _findActiveCue');
  expect(fnStart, 'content-youtube.js 找不到 _findActiveCue').toBeGreaterThan(-1);
  const fnBody = SRC.slice(fnStart, fnStart + 1000);
  expect(
    fnBody,
    '_findActiveCue 缺 null guard(`if (!c) continue;`)— sparse displayCues 會 throw',
  ).toMatch(/if\s*\(\s*!c\s*\)\s*continue/);
});

test('case 2: _upsertDisplayCue replaceRange splice loop 含 c && null guard', () => {
  const fnStart = SRC.indexOf('function _upsertDisplayCue');
  const fnBody = SRC.slice(fnStart, fnStart + 1500);
  // 找 splice loop: for (...; i--) ... cues.splice(i, 1)
  // condition 必含 `c &&`
  expect(
    fnBody,
    '_upsertDisplayCue 的 splice loop 缺 `c &&` null guard',
  ).toMatch(/if\s*\(\s*c\s*&&\s*c\.startMs\s*>\s*startMs[\s\S]{0,80}cues\.splice/);
});

test('case 3: _upsertDisplayCue findIndex callback 含 c && null guard', () => {
  const fnStart = SRC.indexOf('function _upsertDisplayCue');
  const fnBody = SRC.slice(fnStart, fnStart + 1500);
  expect(
    fnBody,
    '_upsertDisplayCue findIndex 缺 `c &&` null guard',
  ).toMatch(/findIndex\s*\(\s*c\s*=>\s*c\s*&&\s*c\.startMs/);
});

test('case 4: _upsertDisplayCue sort 前過濾 falsy 元素', () => {
  const fnStart = SRC.indexOf('function _upsertDisplayCue');
  const fnBody = SRC.slice(fnStart, fnStart + 1500);
  // 找 .filter(c => !!c) 或 .some(c => !c) 模式
  expect(
    fnBody,
    '_upsertDisplayCue sort 前缺 falsy 過濾(防 sort comparator 對 undefined 行為未定義)',
  ).toMatch(/some\s*\(\s*c\s*=>\s*!c\s*\)|filter\s*\(\s*c\s*=>\s*!!c\s*\)/);
});

test('case 5: _runAsrSubBatch subSegs.filter 含 seg && null guard', () => {
  const fnStart = SRC.indexOf('function _runAsrSubBatch');
  const fnBody = SRC.slice(fnStart, fnStart + 3000);
  expect(
    fnBody,
    '_runAsrSubBatch 的 covered.filter 缺 `seg &&` null guard',
  ).toMatch(/subSegs\.filter\s*\(\s*seg\s*=>\s*seg\s*&&\s*seg\.startMs/);
});

test('case 6: fire-and-forget _runAsrWindow catch 帶 stack 便於下次定位', () => {
  // 雖然加了 null guard,但根因仍未定位。stack log 是未來除錯線索。
  // 找實際 SK.sendLog 呼叫(用 sendLog 字串 + asr llm overlay 兩重 anchor 排除註解)
  const callerStart = SRC.indexOf("SK.sendLog('error', 'youtube', 'asr llm overlay failed'");
  expect(callerStart, '應找到 SK.sendLog asr llm overlay failed 呼叫').toBeGreaterThan(-1);
  const block = SRC.slice(callerStart, callerStart + 400);
  expect(
    block,
    'catch 內缺 stack capture(err.stack 截前 5 行)',
  ).toMatch(/err\.stack[\s\S]{0,80}slice\s*\(\s*0\s*,\s*5\s*\)/);
});
