'use strict';
// resolveGlossaryModel（background.js，2026-07-10）——術語擷取模型解析：
//   glossary.model 有值 → 用它（術語擷取獨立模型）；
//   空字串（「與主翻譯模型相同」）→ 文件翻譯 preset（payload.modelOverride）優先，
//   否則全域 geminiConfig.model（網頁翻譯路徑）。
// 修的 bug：先前空字串一律 fallback 全域模型，文件翻譯用非預設 preset 時
// 「與主翻譯模型相同」對不上實際翻譯模型。
//
// 訊號層：驗解析邏輯本體；「doc 頁 payload 真的帶 preset」由 extractGlossaryForDoc /
// extractGlossaryForBook 的 resolvePreset 就地解析（頁面路徑，本測試不驅動）。
//
// SANITY 紀錄（已驗證）：暫時把 resolveGlossaryModel 的 override 分支拿掉
// （直接 return 全域 model）→「空字串 + preset override」case fail → 還原後 pass
const fs = require('fs');
const path = require('path');

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

const src = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/background.js'), 'utf8');
// eslint-disable-next-line no-eval
const resolveGlossaryModel = eval(`(${extractFunction(src, 'resolveGlossaryModel')})`);

describe('resolveGlossaryModel（術語擷取模型解析）', () => {
  const base = { glossary: { model: '' }, geminiConfig: { model: 'gemini-3-flash-preview' } };

  test('glossary.model 有值 → 優先使用（override 不影響）', () => {
    expect(resolveGlossaryModel(
      { ...base, glossary: { model: 'gemini-3.1-flash-lite' } },
      'gemini-3.5-flash',
    )).toBe('gemini-3.1-flash-lite');
  });

  test('空字串（與主翻譯模型相同）+ 文件 preset override → 用 preset', () => {
    expect(resolveGlossaryModel(base, 'gemini-3.5-flash')).toBe('gemini-3.5-flash');
  });

  test('空字串 + 無 override（網頁翻譯路徑）→ 全域主翻譯模型', () => {
    expect(resolveGlossaryModel(base, undefined)).toBe('gemini-3-flash-preview');
    expect(resolveGlossaryModel(base, null)).toBe('gemini-3-flash-preview');
  });

  test('override 空白字串 / 非字串 → 全域主翻譯模型', () => {
    expect(resolveGlossaryModel(base, '   ')).toBe('gemini-3-flash-preview');
    expect(resolveGlossaryModel(base, 42)).toBe('gemini-3-flash-preview');
  });
});
