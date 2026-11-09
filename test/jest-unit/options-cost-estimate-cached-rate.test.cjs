'use strict';

/**
 * v1.10.46 批次 5-5（code review 2026-06-11）：字幕 prompt 開銷估算的 cache 命中費率。
 *
 * 症狀：options.js 估算 hint 寫死 `fmtUSD(tok, 0.25)`（Gemini 舊制 75% off），
 * 現制 model-pricing.js DEFAULT_GEMINI_CACHED_DISCOUNT = 0.90（命中付 10%）→
 * 顯示高估 2.5 倍；dict 8 語 estimateFooter「命中部分 25% 計費」同步過時。
 *
 * 修法：費率改 `1 - DEFAULT_GEMINI_CACHED_DISCOUNT` 單一資料源,footer 帶 {pct} placeholder。
 *
 * 為什麼是 source 斷言（訊號層次,CLAUDE.md 工作流原則 §3）：該估算函式綁 DOM
 * （hintEl.innerHTML）+ options.js 整檔載入需 browser globals,行為級要真 options 頁。
 * 本 spec 鎖「結構性事實」：
 *   1. options.js 不再有寫死 0.25 的 cache 費率參數
 *   2. cachedRate 從 DEFAULT_GEMINI_CACHED_DISCOUNT 推導
 *   3. i18n.js 的 estimateFooter 8 語全部帶 {pct} placeholder,不殘留寫死的 25%
 * 不鎖:渲染出來的 USD 數字正確性（要真 DOM 環境）。
 *
 * SANITY 紀錄（已驗證,2026-06-11）：暫時把 options.js 的 `fmtUSD(fgTok, cachedRate)`
 * 改回 `fmtUSD(fgTok, 0.25)` → case 1 fail；還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const OPTIONS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/options/options.js'), 'utf-8'
);
const I18N_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/lib/i18n.js'), 'utf-8'
);

describe('5-5: cache 命中費率單一資料源', () => {
  test('options.js 不再寫死 0.25 當 fmtUSD cache 費率', () => {
    expect(OPTIONS_SRC).not.toMatch(/fmtUSD\(\w+, 0\.25\)/);
  });

  test('cachedRate 從 DEFAULT_GEMINI_CACHED_DISCOUNT 推導且有 import', () => {
    expect(OPTIONS_SRC).toMatch(/1 - DEFAULT_GEMINI_CACHED_DISCOUNT/);
    expect(OPTIONS_SRC).toMatch(/import \{[^}]*DEFAULT_GEMINI_CACHED_DISCOUNT[^}]*\} from '\.\.\/lib\/model-pricing\.js'/);
  });

  test('estimateFooter 呼叫帶 pct 參數', () => {
    expect(OPTIONS_SRC).toMatch(/estimateFooter\.html', \{ pct: cachedPct \}/);
  });

  test('i18n estimateFooter 8 語全帶 {pct},不殘留寫死 25%', () => {
    const footerLines = I18N_SRC.split('\n').filter((l) => l.includes('estimateFooter.html'));
    expect(footerLines).toHaveLength(8);
    for (const line of footerLines) {
      expect(line).toContain('{pct}');
      expect(line).not.toMatch(/25\s?%/);
    }
  });
});
