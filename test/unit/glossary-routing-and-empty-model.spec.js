// Unit test:術語表抽取訊息類型路由(SK.getGlossaryExtractType)+ 自訂 Provider
//             extractGlossary 對空 model 的處理
//
// 為什麼這條 spec 存在:
//   1. content.js 兩處 EXTRACT_GLOSSARY dispatch 之前寫死 Gemini-only,設成 openai-compat
//      引擎時仍要使用者填 Gemini Key 才能跑術語表(PR #33 原始 bug)。v1.8.50+ 收斂到
//      SK.getGlossaryExtractType(content-ns.js)單一資料源,鎖兩 case 確保不回退。
//   2. background.js handleTranslateCustom 之前提早擋空 customProvider.model,讓本機
//      llama.cpp / Ollama 設定失敗(adapter 本來就支援空 model 對齊 server 預設)。
//      這條 spec 同時鎖 lib/openai-compat.js 兩條 path(translateChunk + extractGlossary)
//      在空 model 下都「不送 body.model 欄位」。
//
// SANITY 紀錄(已驗證):
//   - 把 helper openai-compat case 改成 'EXTRACT_GLOSSARY','engine=openai-compat' 對齊
//     spec fail。
//   - 把 lib/openai-compat.js extractGlossary 內 `if (model) body.model = model` 改成
//     永遠 `body.model = model`,「extractGlossary 空 model 不送 model 欄位」case fail。
//
// 對應 PR:#33(自訂 Provider glossary routing + 空 model 驗證移除)
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

// 重複 content-ns.js 的 SK.getGlossaryExtractType 邏輯,跟下方對齊 spec 鎖住字面同步。
function getGlossaryExtractType(engine) {
  if (engine === 'openai-compat') return 'EXTRACT_GLOSSARY_CUSTOM';
  return 'EXTRACT_GLOSSARY';
}

const cases = [
  { engine: undefined,        expected: 'EXTRACT_GLOSSARY' },
  { engine: null,             expected: 'EXTRACT_GLOSSARY' },
  { engine: 'gemini',         expected: 'EXTRACT_GLOSSARY' },
  // Google MT 不支援 LLM 抽術語表任務,fallback Gemini(已知 trade-off,
  // 主翻譯走 Google MT 但要術語表的使用者必須額外填 Gemini Key)
  { engine: 'google',         expected: 'EXTRACT_GLOSSARY' },
  { engine: 'openai-compat',  expected: 'EXTRACT_GLOSSARY_CUSTOM' },
];

for (const c of cases) {
  test(`engine=${String(c.engine)} → ${c.expected}`, () => {
    expect(getGlossaryExtractType(c.engine)).toBe(c.expected);
  });
}

test('content-ns.js SK.getGlossaryExtractType 內容跟 spec inline 邏輯一致', () => {
  const src = fs.readFileSync('shinkansen/content-ns.js', 'utf8');
  const m = src.match(/SK\.getGlossaryExtractType\s*=\s*function\s+getGlossaryExtractType\s*\(engine\)\s*\{([\s\S]*?)\n  \};/);
  expect(m, 'content-ns.js 找不到 SK.getGlossaryExtractType 定義').toBeTruthy();
  const nsBody = m[1].replace(/\s+/g, ' ').trim();
  const inlineSrc = getGlossaryExtractType.toString();
  const inlineBody = inlineSrc.slice(inlineSrc.indexOf('{') + 1, inlineSrc.lastIndexOf('}'))
    .replace(/\s+/g, ' ').trim();
  expect(nsBody).toBe(inlineBody);
});

// ── 空 model 行為:translateChunk 跟 extractGlossary 都必須對齊 ─────────────
// 我們不直接 import lib/openai-compat.js(避免拉 chrome.* / fetch 依賴),
// 改用 grep-based 結構檢查確認兩處 build body 邏輯都用 `if (model) body.model = model;`
// pattern,任一處被改回「永遠送 model 欄位」立刻 fail。
test('lib/openai-compat.js translateChunk 空 model 不送 body.model 欄位', () => {
  const src = fs.readFileSync('shinkansen/lib/openai-compat.js', 'utf8');
  // 抓 translateChunk 函式 body
  const m = src.match(/async\s+function\s+translateChunk\s*\([\s\S]*?\)\s*\{([\s\S]*?)\n\}/);
  expect(m, 'translateChunk 不存在').toBeTruthy();
  const body = m[1];
  expect(body).toMatch(/if\s*\(\s*model\s*\)\s*body\.model\s*=\s*model\s*;/);
  // 不應該有「永遠送 model」的反模式(允許註解內提及)
  const codeOnly = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(codeOnly).not.toMatch(/\bbody\.model\s*=\s*model\s*\|\|\s*['"]/);
});

// 用 brace counter 抓 function body — 比 regex pattern 對 closing brace 穩。
function extractFunctionBody(src, startMarkerRe) {
  const m = src.match(startMarkerRe);
  if (!m) return null;
  // 從 match 結尾繼續找第一個 `{`,用 brace counter 找對應 closing
  const startIdx = src.indexOf('{', m.index + m[0].length - 1);
  if (startIdx === -1) return null;
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx + 1, i);
    }
  }
  return null;
}

test('lib/openai-compat.js extractGlossary 空 model 不送 body.model 欄位', () => {
  const src = fs.readFileSync('shinkansen/lib/openai-compat.js', 'utf8');
  const body = extractFunctionBody(src, /export\s+async\s+function\s+extractGlossary\s*\(/);
  expect(body, 'extractGlossary 不存在或結構變了').toBeTruthy();
  expect(body).toMatch(/if\s*\(\s*model\s*\)\s*body\.model\s*=\s*model\s*;/);
});

// ── background.js handleTranslateCustom 不應在空 model 時 throw ────────────
test('background.js handleTranslateCustom 不再提早擋空 customProvider.model', () => {
  const src = fs.readFileSync('shinkansen/background.js', 'utf8');
  const body = extractFunctionBody(src, /async\s+function\s+handleTranslateCustom\s*\(/);
  expect(body, 'handleTranslateCustom 不存在或結構變了').toBeTruthy();
  // baseUrl 必填仍應在(adapter 沒它沒辦法呼叫)
  expect(body).toMatch(/if\s*\(\s*!cp\.baseUrl\s*\)\s*throw/);
  // model 必填驗證應該已移除(若回退會 fail)
  expect(body).not.toMatch(/if\s*\(\s*!cp\.model\s*\)\s*throw/);
});
