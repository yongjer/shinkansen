'use strict';

/**
 * v1.10.46 批次 1-1 / 1-2（code review 2026-06-11）：background.js 兩條快取正確性修復。
 *
 * 1-1: handleTranslateStream 寫 cache 前必須檢查 result.hadMismatch。
 *   translateBatchStream 設計上不做逐段 fallback（gemini.js 註解），mismatch 時
 *   translations 是「錯位陣列」——以 texts[i]→translations[i] 配對寫進 tc_<sha1> 會
 *   永久污染快取，之後 cache hit 直接回錯譯。
 *
 * 1-2: glossaryKeySuffix / cacheKeySuffix 的 '_g<hash>' 必須用 `+=` 附加，不可 `=` 覆蓋。
 *   `=` 會把起始的 cacheTag（'_yt' / '_doc' / '_gt'）吃掉 →
 *   _doc 翻譯幾乎必帶 glossary → key 失去 '_doc' 標記 → clearDocTranslationCache() 的
 *   /_doc(_m|$)/ 漏清；字幕開固定術語表時 '_yt' 消失，與網頁翻譯撞 key。
 *   handleTranslateCustom 一直是 `+=`（正確），Gemini 非 streaming / streaming 兩條是
 *   手抄 drift（批次 5-1 會收斂成單一資料源，本 spec 先鎖住三條全 `+=`）。
 *
 * 為什麼是 source 斷言而非行為測試（訊號層次，CLAUDE.md 工作流原則 §3；
 * 同 alarm-dispatcher.test.cjs 前例）：
 *   background.js 是 ES module，module top-level 大量 side effect + 依賴 browser global，
 *   jest cjs 環境無法 representatively 載入整個 SW；handleTranslate* 皆非 export。
 *   本 spec 鎖「結構性事實」：
 *     1. streaming cache write 的 if 條件含 !result.hadMismatch
 *     2. 全檔沒有任何「suffix 變數 = '_g'」的覆蓋式賦值；'_g' 組裝點全部是 +=
 *   它「不鎖」mismatch 真的發生時 translations 確實錯位、以及 cache key 在真實
 *   翻譯流程的端到端組裝結果——那要真 SW 環境。
 *
 * SANITY 紀錄（已驗證，2026-06-11）：
 *   - 暫時把 streaming 寫 cache 的 `!result.hadMismatch && ` 拿掉 → 1-1 斷言 fail；還原 → pass
 *   - 暫時把 handleTranslate 的 `glossaryKeySuffix += '_g'` 改回 `=` → 1-2 斷言 fail；還原 → pass
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/background.js'),
  'utf-8'
);

describe('1-1: streaming mismatch 譯文不得寫快取', () => {
  test('streaming cache write 條件含 !result.hadMismatch', () => {
    expect(SRC).toMatch(
      /if \(!result\.hadMismatch && result\.translations && result\.translations\.length > 0\)/
    );
  });

  test('streaming 路徑仍有 cache 寫回（防修成「整段刪掉」的假綠）', () => {
    expect(SRC).toMatch(/streaming batch cache write/);
  });
});

describe("1-2: '_g<hash>' 一律 += 附加，不得 = 覆蓋 cacheTag", () => {
  test("全檔沒有覆蓋式賦值 `<suffix 變數> = '_g'`", () => {
    // 捕捉任何 `xxxSuffix = '_g'`（覆蓋）；合法寫法是 `xxxSuffix += '_g'`。
    // 負向後行斷言排除 +=（match[1] 取變數名以便 fail 時印出位置）。
    const overwrite = SRC.match(/(\w*[Ss]uffix)\s*=\s*'_g'/g) || [];
    const violations = overwrite.filter((s) => !s.includes('+='));
    expect(violations).toEqual([]);
  });

  test("'_g' 組裝點唯一（buildCacheKeySuffix 單一資料源），且是 +=", () => {
    // v1.10.46 批次 5-1：三條路徑收斂成 buildCacheKeySuffix，全檔只剩一個 '_g' 組裝點。
    const appends = SRC.match(/\w+ \+= '_g' \+ fullHash\.slice\(0, 12\)/g) || [];
    expect(appends.length).toBe(1);
  });

  test('三條翻譯路徑都呼叫 buildCacheKeySuffix（不得回退手抄）', () => {
    const calls = SRC.match(/await buildCacheKeySuffix\(\{/g) || [];
    expect(calls.length).toBe(3);
  });
});
