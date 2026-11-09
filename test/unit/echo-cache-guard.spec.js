// Regression: echo-cache-guard（對應 v2.0.52 修的「日文書短感嘆詞永遠不翻」bug）
//
// Bug：模型偶發對批內短句（「えっ？」類感嘆詞）echo 原文不翻，echo 被以
// per-segment tc_ key 寫進快取後,高頻短句在整本書 / 整站每一處命中同一條壞快取,
// 重翻也治不好（真 API probe 實測 gemini-3.5-flash 對新請求 3/3 正確翻「蛤？」——
// 症狀來源是快取,不是模型必然 echo）。
// 修法：cache.setBatch 前過濾「譯文=原文且原文含明確非 target 字系（假名/諺文）」
// 的 segment——結果照樣回給呼叫端顯示,只是不寫快取,下次翻譯自然重試。
// 合法原樣保留（數字 / URL / 英文品牌 / 日文漢字人名）不含這些字系特徵,不受影響。
//
// SANITY 紀錄（已驗證）：暫時把 system-instruction.js isSuspectEchoTranslation
// 改成 `return false` → 「echo 假名感嘆詞」與 filterEchoPairsForCache 過濾斷言 fail
// → 還原 → pass。
//
// v2.0.65 擴充：「拉丁字母長內文未翻」判定（對應「英文段落 echo 寫進快取後
// 該段永遠 cache hit 吐英文」bug，Verge Installer 頁實測：lite 級模型偶發把
// 整段英文內文照抄回來，CJK target 下不含假名/諺文特徵，舊判定放行進快取）。
// 修法：判定做在譯文側且不要求譯文=原文字串相等（cage 實測模型 echo 時會動到
// 佔位符/引號，字串不等但內容照樣是英文，等號 gate 會漏）:CJK target(zh/ja/ko)
// 下，譯文拉丁字母 ≥40、空白分詞 ≥8、CJK 字元 ≤2 → suspect 不寫快取；另加
// v2.0.65 一次性 migration 清既有壞 entry（background.js wiring 斷言見檔尾）。
// SANITY 紀錄（已驗證）：暫時把 isSuspectEchoTranslation 的
// `if (tLatin >= 40 && tWords >= 8 && tCjk <= 2) return true;` 改成 `if (false)`
// → 「zh target：整段英文內文 echo → true」與「echo 變體」斷言 fail(received
// false)→ 還原 → pass。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

globalThis.chrome = {
  storage: {
    sync:  { get: async () => ({}), set: async () => {}, remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const {
  isSuspectEchoTranslation,
  filterEchoPairsForCache,
} = await import('../../shinkansen/lib/system-instruction.js');

test.describe('isSuspectEchoTranslation', () => {
  test('zh target:假名感嘆詞 echo → true（本案例）', () => {
    expect(isSuspectEchoTranslation('「えっ？」', '「えっ？」', 'zh-TW')).toBe(true);
    expect(isSuspectEchoTranslation('「えっ？」', ' 「えっ？」 ', 'zh-CN')).toBe(true);
  });

  test('zh target:合法原樣保留不誤殺（漢字人名 / 數字 / 英文 / URL）', () => {
    expect(isSuspectEchoTranslation('勝又', '勝又', 'zh-TW')).toBe(false);
    expect(isSuspectEchoTranslation('2024', '2024', 'zh-TW')).toBe(false);
    expect(isSuspectEchoTranslation('Taylor Swift', 'Taylor Swift', 'zh-TW')).toBe(false);
    expect(isSuspectEchoTranslation('https://example.com/あ', 'https://example.com/あ', 'zh-TW')).toBe(false); // 假名 <2
  });

  test('有翻譯（譯文 ≠ 原文）→ false', () => {
    expect(isSuspectEchoTranslation('「えっ？」', '「蛤？」', 'zh-TW')).toBe(false);
  });

  test('ja target:假名 echo 合法（目標就是日文）；諺文 echo 仍算錯', () => {
    expect(isSuspectEchoTranslation('「えっ？」', '「えっ？」', 'ja')).toBe(false);
    expect(isSuspectEchoTranslation('안녕하세요', '안녕하세요', 'ja')).toBe(true);
  });

  test('拉丁 target:CJK echo → true', () => {
    expect(isSuspectEchoTranslation('供品不見了。', '供品不見了。', 'en')).toBe(true);
    expect(isSuspectEchoTranslation('Hello world', 'Hello world', 'en')).toBe(false);
  });

  // v2.0.65：拉丁字母長內文 echo（整段英文照抄回來）
  const LONG_EN = 'Chris Lawley shipped his notes-and-tasks app for Apple devices this week, and it goes hard on just showing you what matters right now.';

  test('zh target：整段英文內文 echo → true（本案例）', () => {
    expect(isSuspectEchoTranslation(LONG_EN, LONG_EN, 'zh-TW')).toBe(true);
    expect(isSuspectEchoTranslation(LONG_EN, ` ${LONG_EN} `, 'zh-CN')).toBe(true);
    expect(isSuspectEchoTranslation(LONG_EN, LONG_EN, 'ja')).toBe(true);
  });

  test('zh target:echo 變體（佔位符/引號被動過，字串不等但內容仍是英文）→ true', () => {
    // 模型 echo 時掉佔位符：原文含 ⟦0⟧…⟦/0⟧，回傳沒有 → 字串不等，等號 gate 會漏
    const src = `“How Things Work.” Really good episode of ⟦0⟧Some Show⟦/0⟧ that makes a compelling case about the industry.`;
    const echoNoMarkers = `"How Things Work." Really good episode of Some Show that makes a compelling case about the industry.`;
    expect(isSuspectEchoTranslation(src, echoNoMarkers, 'zh-TW')).toBe(true);
  });

  test('zh target：短英文 / 無空白長 URL / 有翻譯不誤殺', () => {
    // 短句品牌 / 標題（分詞 <8 或拉丁 <40）合法原樣保留
    expect(isSuspectEchoTranslation('Pablo Torre Finds Out', 'Pablo Torre Finds Out', 'zh-TW')).toBe(false);
    // 長 URL 無空白，分詞 =1
    const url = 'https://example.com/some/very/long/path/that/keeps/going/and/going/forever';
    expect(isSuspectEchoTranslation(url, url, 'zh-TW')).toBe(false);
    // 真的有翻譯（譯文 ≠ 原文）
    expect(isSuspectEchoTranslation(LONG_EN, 'Chris Lawley 本週推出了他的 App。', 'zh-TW')).toBe(false);
  });

  test('拉丁 target：英文原文原樣返回不受長內文判定影響（isAlreadyInTarget 層處理）', () => {
    expect(isSuspectEchoTranslation(LONG_EN, LONG_EN, 'en')).toBe(false);
  });
});

test.describe('filterEchoPairsForCache', () => {
  test('echo segment 被剔除,其餘照寫,skipped 計數正確', () => {
    const texts = ['「えっ？」', '「誰かが供え物を食べてしまったの。」', '2024'];
    const translations = ['「えっ？」', '「有人把供品偷吃了。」', '2024'];
    const out = filterEchoPairsForCache(texts, translations, 'zh-TW');
    expect(out.skipped).toBe(1);
    expect(out.texts).toEqual(['「誰かが供え物を食べてしまったの。」', '2024']);
    expect(out.translations).toEqual(['「有人把供品偷吃了。」', '2024']);
  });

  test('falsy translation 跳過但不算 echo skipped', () => {
    const out = filterEchoPairsForCache(['a', 'b'], [null, 'B 譯'], 'zh-TW');
    expect(out.skipped).toBe(0);
    expect(out.texts).toEqual(['b']);
  });
});

test.describe('background.js 三個寫快取點都有接 echo 防護（source 斷言）', () => {
  test('gemini / custom 走 filterEchoPairsForCache,streaming 走 isSuspectEchoTranslation', () => {
    const src = readFileSync(new URL('../../shinkansen/background.js', import.meta.url), 'utf-8');
    // gemini(handleTranslate)+ custom(handleTranslateCustom)各一次 filter 呼叫
    expect((src.match(/filterEchoPairsForCache\(/g) || []).length).toBeGreaterThanOrEqual(2);
    // streaming writable 迴圈逐段判 echo
    expect((src.match(/isSuspectEchoTranslation\(/g) || []).length).toBeGreaterThanOrEqual(1);
    // 防退化:不再存在「未過濾直接 setBatch(missingTexts, fresh」的殘留(Google MT 路徑除外,
    // 該路徑無 LLM echo 問題;它的 setBatch 用 effectiveCacheSuffix 變數名區分)
    expect(src).not.toMatch(/setBatch\(missingTexts, fresh, glossaryKeySuffix\)/);
    expect(src).not.toMatch(/setBatch\(missingTexts, fresh, suffix\)/);
  });

  // v2.0.65：英文段落 echo 壞快取一次性清除 migration wiring
  test('v2.0.65 echo cache migration 接在 sw-init / onStartup / onInstalled 三處', () => {
    const src = readFileSync(new URL('../../shinkansen/background.js', import.meta.url), 'utf-8');
    expect(src).toMatch(/__shinkansen_v2065_echo_cache_cleared/);
    // sw-init + onInstalled + onStartup listener 至少三處呼叫
    expect((src.match(/runV2065EchoCacheClear\(/g) || []).length).toBeGreaterThanOrEqual(4);
    // 走既有一次性全清 API（flag 防重複）
    expect(src).toMatch(/migrateClearTranslationCacheOnce\(V2065_ECHO_CACHE_FLAG\)/);
  });
});
