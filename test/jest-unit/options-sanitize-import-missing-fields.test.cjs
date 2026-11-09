'use strict';

/**
 * v1.10.46 批次 5-2（code review 2026-06-11）：sanitizeImport 漏欄位修復。
 *
 * 症狀：匯出是 storage.sync.get(null) 全量,但 sanitizeImport 原本漏列
 *   1. customShortcuts（自訂快速鍵三 slot 表）→ 還原備份後自訂快速鍵整個消失且無警告
 *   2. translateDoc.applyFixedGlossary → 文件翻譯「套用固定術語表」開關被默默丟掉
 *
 * 測試手法：options.js 依賴 DOM + browser globals 無法整檔載入 → brace counting 抽出
 * sanitizeImport 函式本體,new Function 注入 stub（_t / TARGET_LANGUAGES / UI_LANGUAGES）
 * 與真 shortcut-utils（有 module.exports,直接 require 當 SC）後呼叫驗行為。
 *
 * 訊號層界定：驗「sanitizeImport 對這兩個欄位的收留／消毒／警告行為」,不驗 import 流程
 * 端到端（storage.sync.set + load() 重綁 UI 要真 options 頁環境）。
 *
 * SANITY 紀錄（已驗證,2026-06-11）：暫時把 options.js 的 customShortcuts 收留區塊
 * 整段移除 → 「合法 customShortcuts 進 clean」case fail；還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/options/options.js'),
  'utf-8'
);
const SC = require('../../shinkansen/lib/shortcut-utils.js');

function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`source 找不到 function ${name}`);
  let i = SRC.indexOf('(', start);
  let parenDepth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '(') parenDepth++;
    else if (SRC[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  let depth = 0;
  i = SRC.indexOf('{', i);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return SRC.slice(start, i + 1);
}

// stub:_t 回 key+vars 方便斷言;語言清單給最小集合
const sanitizeImport = new Function(
  '_t', 'TARGET_LANGUAGES', 'UI_LANGUAGES', 'SC',
  `${extractFn('sanitizeImport')}; return sanitizeImport;`
)(
  (key, vars) => `${key}:${vars && vars.key ? vars.key : ''}`,
  ['zh-TW', 'zh-CN', 'en'],
  ['auto', 'zh-TW', 'en'],
  SC
);

describe('5-2: customShortcuts 匯入收留', () => {
  test('合法 customShortcuts 進 clean,且經 sanitizeTable 消毒（三 slot 齊全）', () => {
    const raw = {
      customShortcuts: {
        1: { code: 'KeyS', alt: true, shift: false, ctrl: false, meta: false },
        2: null,
        // slot 3 缺 → sanitizeTable 補 null
      },
    };
    const { clean, warnings } = sanitizeImport(raw);
    expect(clean.customShortcuts).toEqual({
      1: { code: 'KeyS', alt: true, shift: false, ctrl: false, meta: false },
      2: null,
      3: null,
    });
    expect(warnings).toEqual([]);
  });

  test('髒 slot value（code 非字串）被消毒成 null,不污染 storage', () => {
    const raw = { customShortcuts: { 1: { code: 42, alt: true }, 2: 'garbage', 3: null } };
    const { clean } = sanitizeImport(raw);
    expect(clean.customShortcuts).toEqual({ 1: null, 2: null, 3: null });
  });

  test('customShortcuts 型別整個錯（字串／陣列）→ 跳過 + 警告,不寫 all-null 表蓋掉現值', () => {
    for (const bad of ['x', [1, 2, 3], null]) {
      const { clean, warnings } = sanitizeImport({ customShortcuts: bad });
      expect(clean.customShortcuts).toBeUndefined();
      expect(warnings.some((w) => w.includes('customShortcuts'))).toBe(true);
    }
  });

  test('備份檔沒有 customShortcuts key 時不動它（不寫入、不警告）', () => {
    const { clean, warnings } = sanitizeImport({ autoTranslate: true });
    expect('customShortcuts' in clean).toBe(false);
    expect(warnings).toEqual([]);
  });
});

describe('5-2: translateDoc.applyFixedGlossary 匯入收留', () => {
  test('boolean 值進 clean.translateDoc', () => {
    const { clean, warnings } = sanitizeImport({ translateDoc: { applyFixedGlossary: false } });
    expect(clean.translateDoc).toEqual({ applyFixedGlossary: false });
    expect(warnings).toEqual([]);
  });

  test('非 boolean → 跳過 + 警告', () => {
    const { clean, warnings } = sanitizeImport({ translateDoc: { applyFixedGlossary: 'yes' } });
    expect(clean.translateDoc).toBeUndefined();
    expect(warnings.some((w) => w.includes('translateDoc.applyFixedGlossary'))).toBe(true);
  });

  test('既有欄位不受影響（applyGlossary / systemPrompt 照舊收留）', () => {
    const { clean } = sanitizeImport({
      translateDoc: { applyGlossary: true, systemPrompt: 'p', applyFixedGlossary: true },
    });
    expect(clean.translateDoc).toEqual({ applyGlossary: true, systemPrompt: 'p', applyFixedGlossary: true });
  });
});

// 2026-07-08 code review UI-4：instapaperEnabled / instapaperSummaryEnabled 漏列
// topRules（同 issue #48 / 批次 5-2 的第三次同型漏列）。症狀：開啟 Instapaper 的
// 使用者匯出→匯入備份後兩鍵默默消失,popup「送到 Instapaper」按鈕不見,以為連結壞了。
// SANITY 紀錄（已驗證,2026-07-08）：暫時把 topRules 的 instapaperEnabled 條目移除 →
// 「boolean 進 clean」case fail；還原 → pass。
describe('2026-07-08: instapaper 兩鍵匯入收留', () => {
  test('instapaperEnabled / instapaperSummaryEnabled boolean 進 clean', () => {
    const { clean, warnings } = sanitizeImport({
      instapaperEnabled: true,
      instapaperSummaryEnabled: false,
    });
    expect(clean.instapaperEnabled).toBe(true);
    expect(clean.instapaperSummaryEnabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  test('非 boolean → 跳過 + 警告,不污染 clean', () => {
    const { clean, warnings } = sanitizeImport({ instapaperEnabled: 'yes' });
    expect('instapaperEnabled' in clean).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
