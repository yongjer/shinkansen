// Unit test: 術語表抽取用量寫進 IndexedDB(source='glossary')(v1.9.1)
//
// 對應 PENDING_REGRESSION.md 條目「術語表抽取用量寫進 IndexedDB」。
// 過去 handleExtractGlossary / handleExtractGlossaryCustomProvider 只走 addUsage
// 寫 storage.local 累計值,不進 IndexedDB → options 用量明細永遠不含術語表費用。
// v1.9.1 拔掉 addUsage 後補上 usageDB.logTranslation 寫入,record.source='glossary'。
//
// 本檔做 static check,讀 background.js 抽出兩條 glossary handler 函式 body,
// 驗:
//   - 函式存在(可被找到)
//   - 函式 body 內呼叫 usageDB.logTranslation
//   - record 物件帶 source: 'glossary'(讓 options renderTable 標 [術語表] 標籤)
//   - record schema 對齊 LOG_USAGE / Google Translate path 的欄位(url / engine /
//     model / inputTokens / outputTokens / billedInputTokens / billedCostUSD / timestamp)
//
// SANITY 紀錄(已驗證):暫時把 handleExtractGlossary 內的 usageDB.logTranslation
// 拿掉,對應 spec fail;還原後全綠。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * 從 source 抽出某 top-level function 的完整定義(含 body),用 brace 平衡計數。
 * 處理 string literal / line comment / block comment 內的 `{}` 不算 brace,
 * 比「找下一個 function 開頭」更可靠(尤其對檔內最後一個 function 而言)。
 */
function extractFunctionBody(src, fnName) {
  const startRe = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;
  const afterStart = startMatch.index + startMatch[0].length;
  const bodyOpen = src.indexOf('{', afterStart);
  if (bodyOpen === -1) return null;

  let depth = 1;
  let i = bodyOpen + 1;
  let inString = null;     // null | "'" | '"' | '`'
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (src[i - 1] === '*' && ch === '/') inBlockComment = false;
    } else if (inString) {
      if (ch === '\\') { i += 2; continue; }    // skip escape
      if (ch === inString) inString = null;
    } else {
      if (ch === '/' && src[i + 1] === '/') { inLineComment = true; i += 2; continue; }
      if (ch === '/' && src[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; }
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    i++;
  }
  return src.slice(startMatch.index, i);
}

test.describe('handleExtractGlossary(Gemini): 寫入 IndexedDB with source=glossary', () => {
  const bg = readFile('shinkansen/background.js');
  const body = extractFunctionBody(bg, 'handleExtractGlossary');

  test('handleExtractGlossary 函式可被找到', () => {
    expect(body).not.toBeNull();
    expect(body.length).toBeGreaterThan(100); // 不是空殼
  });

  test('呼叫 usageDB.logTranslation(寫入 IndexedDB)', () => {
    expect(body).toMatch(/usageDB\.logTranslation\s*\(/);
  });

  test('record 帶 source: \'glossary\'(讓 options renderTable 標籤)', () => {
    expect(body).toMatch(/source:\s*['"]glossary['"]/);
  });

  test('record 帶 url 欄位(對齊 LOG_USAGE schema,從 sender.tab.url 取)', () => {
    expect(body).toMatch(/url:\s*sender\?\.tab\?\.url/);
  });

  test('record 帶 engine: \'gemini\'(明確標翻譯引擎)', () => {
    expect(body).toMatch(/engine:\s*['"]gemini['"]/);
  });

  test('record 帶 model 欄位(用 glossary 自己的 model;預設 Flash Lite)', () => {
    expect(body).toMatch(/model:\s*glossaryModel/);
  });

  test('record 帶 billedCostUSD 計費欄位(讓 options 顯示費用)', () => {
    expect(body).toMatch(/billedCostUSD/);
  });

  test('只在 usage > 0 時寫入(全 cache hit 場景不寫空 record)', () => {
    // 寫入應該包在 if (usage.inputTokens > 0 || usage.outputTokens > 0) 內
    // 避免 cache hit 路徑(early return 不會跑到這)外的零用量假資料
    // 寫入應該包在 if (usage.inputTokens > 0 || usage.outputTokens > 0) 內,
    // 避免 cache hit 路徑(early return)外的零用量假資料。距離限制放寬到 1000
    // 字元(實際 body 內 record 物件展開後約 600-700 字)
    expect(body).toMatch(/if\s*\(\s*usage\.inputTokens\s*>\s*0[\s\S]{0,80}usage\.outputTokens\s*>\s*0[\s\S]{0,1000}usageDB\.logTranslation/);
  });
});

test.describe('handleExtractGlossaryCustomProvider(OpenAI-compat): 寫入 IndexedDB with source=glossary', () => {
  const bg = readFile('shinkansen/background.js');
  const body = extractFunctionBody(bg, 'handleExtractGlossaryCustomProvider');

  test('handleExtractGlossaryCustomProvider 函式可被找到', () => {
    expect(body).not.toBeNull();
    expect(body.length).toBeGreaterThan(100);
  });

  test('呼叫 usageDB.logTranslation', () => {
    expect(body).toMatch(/usageDB\.logTranslation\s*\(/);
  });

  test('record 帶 source: \'glossary\'', () => {
    expect(body).toMatch(/source:\s*['"]glossary['"]/);
  });

  test('record 帶 engine: \'openai-compat\'', () => {
    expect(body).toMatch(/engine:\s*['"]openai-compat['"]/);
  });

  test('record 帶 model 欄位,空時 fallback \'<server-default>\'', () => {
    // customProvider model 可空(本機 llama.cpp / Ollama),fallback 標 placeholder
    // 避免空字串污染 options 用量明細的 model filter / chart group
    expect(body).toMatch(/cp\.model\s*\|\|\s*['"]<server-default>['"]/);
  });

  test('用 cachedRate 算 billedInputTokens(跟 customProvider 主路徑一致,各家折扣不同)', () => {
    // OpenAI / Anthropic / DeepSeek 的 cache 命中折扣率不同。v1.9.2 起改走
    // resolveCustomProviderCachedRate(cp) — 先讀 cp.cachedDiscount 使用者設定,沒填時
    // 再 fallback baseUrl 自動推導(getCustomCacheHitRate)。整條路徑核心是 cachedRate 變數
    // 進到 billedInputTokens 與 computeBilledCostUSD,而非硬編碼 0.25。
    expect(body).toMatch(/resolveCustomProviderCachedRate\s*\(\s*cp\s*\)/);
  });

  test('只在 usage > 0 時寫入', () => {
    // 寫入應該包在 if (usage.inputTokens > 0 || usage.outputTokens > 0) 內,
    // 避免 cache hit 路徑(early return)外的零用量假資料。距離限制放寬到 1000
    // 字元(實際 body 內 record 物件展開後約 600-700 字)
    expect(body).toMatch(/if\s*\(\s*usage\.inputTokens\s*>\s*0[\s\S]{0,80}usage\.outputTokens\s*>\s*0[\s\S]{0,1000}usageDB\.logTranslation/);
  });
});
