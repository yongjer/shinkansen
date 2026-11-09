// Unit test: custom-provider 文件翻譯 cache key 與 glossary helper 重構
//
// 為什麼有這條:
//   1. v1.9.x 新增 TRANSLATE_DOC_BATCH_CUSTOM 後，文件翻譯會套用
//      translateDoc.temperature 到 custom provider 路徑。
//   2. 若 _oc_doc cache key 沒把 temperature 帶進去，使用者改文件翻譯溫度後會直接
//      命中舊快取，看不到設定生效。
//   3. 同次修改把 fixedGlossary + articleGlossary override 邏輯抽成 shared helper，
//      避免 Gemini / custom provider 兩條 path 再次分叉。
//
// v1.10.53 更新:v1.10.46「cache key 單一資料源收斂」把 suffix 組裝抽成共用
//   buildCacheKeySuffix(temperature 改以 docTemperature 參數傳入、handleTranslateCustom
//   只負責在 cacheTag==='_oc_doc' 時把 cp.temperature 餵進去)。本測試原本 grep
//   handleTranslateCustom 內聯的 cp.temperature 寫法,重構後對不上 → 改驗新的兩段事實:
//   (a) handleTranslateCustom 在 _oc_doc 時把 cp.temperature 當 docTemperature 傳入;
//   (b) buildCacheKeySuffix 把 docTemperature 以 _t<temp> 併進 suffix。功能不變。
//
// SANITY 紀錄(已驗證):
//   - 移除 buildCacheKeySuffix 的 `_t' + docTemperature.toFixed(2)` 後,第 1 條會 fail。
//   - 把 handleTranslate / handleTranslateCustom 改回各自內嵌 glossary merge 後,
//     第 2 條會 fail。

import { test, expect } from '@playwright/test';
import fs from 'node:fs';

function extractFunctionBody(src, startMarkerRe) {
  const match = src.match(startMarkerRe);
  if (!match) return null;
  const startIdx = src.indexOf('{', match.index + match[0].length - 1);
  if (startIdx === -1) return null;
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx + 1, i);
    }
  }
  return null;
}

test('background.js: handleTranslateCustom 對 _oc_doc cache key 納入 temperature', () => {
  const src = fs.readFileSync('shinkansen/background.js', 'utf8');
  // (a) handleTranslateCustom 在 _oc_doc 時把 cp.temperature 當 docTemperature 餵進共用 builder
  const custom = extractFunctionBody(src, /async\s+function\s+handleTranslateCustom\s*\(/);
  expect(custom, 'handleTranslateCustom 不存在或結構變了').toBeTruthy();
  expect(custom).toMatch(/docTemperature\s*:\s*cacheTag\s*===\s*['"]_oc_doc['"]\s*\?\s*cp\.temperature/);
  // (b) 共用的 buildCacheKeySuffix 把 docTemperature 以 _t<temp> 併進 suffix
  // （buildCacheKeySuffix 用解構參數 ({...}),extractFunctionBody 的「第一個 { = body」假設
  //   會抓到參數列而非 body,故此段直接對整檔 grep——_t + docTemperature.toFixed 全檔僅此一處）
  expect(src).toMatch(/function\s+buildCacheKeySuffix\s*\(/);
  expect(src).toMatch(/suffix\s*\+=\s*['"]_t['"]\s*\+\s*docTemperature\.toFixed\(2\)/);
});

test('background.js: Gemini / custom 兩條翻譯 path 共用 glossary helper', () => {
  const src = fs.readFileSync('shinkansen/background.js', 'utf8');
  expect(src).toMatch(/function\s+buildFixedGlossaryEntries\s*\(/);
  expect(src).toMatch(/function\s+preferArticleGlossaryEntries\s*\(/);
  expect(src).toMatch(/async\s+function\s+handleTranslate\s*\([\s\S]*?buildFixedGlossaryEntries\s*\(/);
  expect(src).toMatch(/async\s+function\s+handleTranslate\s*\([\s\S]*?preferArticleGlossaryEntries\s*\(/);
  expect(src).toMatch(/async\s+function\s+handleTranslateCustom\s*\([\s\S]*?buildFixedGlossaryEntries\s*\(/);
  expect(src).toMatch(/async\s+function\s+handleTranslateCustom\s*\([\s\S]*?preferArticleGlossaryEntries\s*\(/);
});
