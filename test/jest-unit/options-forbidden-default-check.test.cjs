'use strict';

/**
 * SPEC-PRIVATE §29.1-3「options forbiddenTerms 物化」修法的純函式層(dev tail 2.0.9.1,2026-07-09):
 *   isForbiddenTermsDefaultFor(terms, tl, defaults) —— 判斷禁用詞表是否「視為未客製」。
 *
 * 語意(target-aware):
 *   - 任何 target：逐條等於 defaults → 未客製(autosave 物化殘留可回收)
 *   - 非 zh-TW target：空表 = 該 target 預設 → 未客製
 *   - zh-TW target：空表 = 使用者刻意清空(停用黑名單，v1.5.6 語意)→ 已客製
 *
 * 測試手法：options.js 依賴 DOM + browser globals 無法整檔載入 → brace counting 抽出
 *   isForbiddenTermsDefaultFor 函式本體(同 options-reset-preserve-instapaper 手法),
 *   純函式直接驅動。
 *
 * 訊號層界定：驗「未客製判斷」的決策表；save() 端「判定成立 → delete key + storage.remove」
 *   的接線與 target 切換 listener 由 test/regression/options-forbidden-no-materialize.spec.js
 *   走真 options 頁驗。
 *
 * SANITY 紀錄(已驗證，2026-07-09)：把 `if (terms.length === 0) return tl !== 'zh-TW';`
 *   改回舊版 `if (terms.length === 0) return true;` →「zh-TW 空表 = 已客製」case fail。
 *   還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/options/options.js'),
  'utf-8'
);

function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
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

const fnSrc = extractFn('isForbiddenTermsDefaultFor');
// eslint-disable-next-line no-new-func
const isForbiddenTermsDefaultFor = new Function(`return (${fnSrc})`)();

const DEFAULTS = [
  { forbidden: '視頻', replacement: '影片', note: '' },
  { forbidden: '軟件', replacement: '軟體', note: '' },
  { forbidden: '網絡', replacement: '網路', note: 'network' },
];

describe('isForbiddenTermsDefaultFor(target-aware 未客製判斷)', () => {
  test('zh-TW + 逐條等於預設 → 未客製(true)', () => {
    const terms = DEFAULTS.map(t => ({ ...t }));
    expect(isForbiddenTermsDefaultFor(terms, 'zh-TW', DEFAULTS)).toBe(true);
  });

  test('zh-TW + 空表 → 已客製(false，刻意清空 = 停用黑名單必須寫入)', () => {
    expect(isForbiddenTermsDefaultFor([], 'zh-TW', DEFAULTS)).toBe(false);
  });

  test('zh-TW + 改過一筆 replacement → 已客製(false)', () => {
    const terms = DEFAULTS.map(t => ({ ...t }));
    terms[1] = { ...terms[1], replacement: '軟體工具' };
    expect(isForbiddenTermsDefaultFor(terms, 'zh-TW', DEFAULTS)).toBe(false);
  });

  test('zh-TW + 多一筆 → 已客製(false)', () => {
    const terms = [...DEFAULTS.map(t => ({ ...t })), { forbidden: '信息', replacement: '資訊', note: '' }];
    expect(isForbiddenTermsDefaultFor(terms, 'zh-TW', DEFAULTS)).toBe(false);
  });

  test('en + 空表 → 未客製(true，空表即該 target 預設)', () => {
    expect(isForbiddenTermsDefaultFor([], 'en', DEFAULTS)).toBe(true);
  });

  test('en + 逐條等於 zh-TW 預設 → 未客製(true，物化殘留切走 target 後可回收)', () => {
    const terms = DEFAULTS.map(t => ({ ...t }));
    expect(isForbiddenTermsDefaultFor(terms, 'en', DEFAULTS)).toBe(true);
  });

  test('zh-CN + 自訂一筆 → 已客製(false)', () => {
    expect(isForbiddenTermsDefaultFor([{ forbidden: 'A', replacement: 'B', note: '' }], 'zh-CN', DEFAULTS)).toBe(false);
  });

  test('note 欄差異不影響判斷(只比 forbidden/replacement)', () => {
    const terms = DEFAULTS.map(t => ({ ...t, note: '使用者自己加的備註' }));
    expect(isForbiddenTermsDefaultFor(terms, 'zh-TW', DEFAULTS)).toBe(true);
  });

  test('非陣列 → false(防禦)', () => {
    expect(isForbiddenTermsDefaultFor(null, 'zh-TW', DEFAULTS)).toBe(false);
    expect(isForbiddenTermsDefaultFor(undefined, 'en', DEFAULTS)).toBe(false);
  });
});
