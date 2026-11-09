// Unit test: P1 (v1.8.59) getEffective*Prompt factory
//
// 驗證 lib/storage.js 的 5 個 getEffective*Prompt 函式行為:
//   1. userOverride 為空 / trim 後等於對應 zh-TW DEFAULT.trim() → 視為「未客製化」,走 target 預設
//      target='zh-TW' → 回原 DEFAULT_*_PROMPT(維持 v1.8.58 之前行為)
//      target='zh-CN' / 'en' → 回 UNIVERSAL_*_PROMPT.replace('{targetLanguage}', LANG_LABELS[t])
//   2. userOverride 非空且非 zh-TW DEFAULT → 直接 return userOverride(尊重使用者客製化)
//   3. ASR 路徑沒有 user override 入口(background.js 寫死),userOverride 永遠 ''
//
// 設計目的:既有使用者升級不需 storage migration,saved 仍是 zh-TW DEFAULT_*_PROMPT 字面值
// 會被視為「未客製」,target 切換立刻反映。
import { test, expect } from '@playwright/test';

// Mock chrome.storage.local(getEffective* 不讀 storage,但 storage.js import compat.js)
const store = {};
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync:  { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_DOC_SYSTEM_PROMPT,
  DEFAULT_GLOSSARY_PROMPT,
  DEFAULT_SUBTITLE_SYSTEM_PROMPT,
  DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT,
  UNIVERSAL_SYSTEM_PROMPT,
  UNIVERSAL_DOC_SYSTEM_PROMPT,
  UNIVERSAL_GLOSSARY_PROMPT,
  UNIVERSAL_SUBTITLE_SYSTEM_PROMPT,
  UNIVERSAL_ASR_SUBTITLE_SYSTEM_PROMPT,
  LANG_LABELS,
  getEffectiveSystemPrompt,
  getEffectiveDocSystemPrompt,
  getEffectiveGlossaryPrompt,
  getEffectiveSubtitleSystemPrompt,
  getEffectiveAsrSubtitleSystemPrompt,
} = await import('../../shinkansen/lib/storage.js');

test.describe('P1: getEffectiveSystemPrompt(target, userOverride)', () => {
  test('target=zh-TW + userOverride="" → DEFAULT_SYSTEM_PROMPT(zh-TW 完整 prompt)', () => {
    expect(getEffectiveSystemPrompt('zh-TW', '')).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(getEffectiveSystemPrompt('zh-TW', undefined)).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(getEffectiveSystemPrompt('zh-TW', null)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('target=zh-TW + userOverride=DEFAULT_SYSTEM_PROMPT → 視為未客製,仍回 DEFAULT', () => {
    // 既有 zh-TW 使用者升級後 saved.systemInstruction = 舊 DEFAULT_SYSTEM_PROMPT 字面值
    // → 必須視為「未客製」(行為不變),不該被當成「使用者客製過」
    expect(getEffectiveSystemPrompt('zh-TW', DEFAULT_SYSTEM_PROMPT)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('target=zh-TW + userOverride="custom" → 直接回 "custom"(尊重客製化)', () => {
    expect(getEffectiveSystemPrompt('zh-TW', '我自訂的 prompt')).toBe('我自訂的 prompt');
  });

  test('target=zh-CN + userOverride="" → UNIVERSAL 注入後字面值', () => {
    const result = getEffectiveSystemPrompt('zh-CN', '');
    expect(result).toContain(LANG_LABELS['zh-CN']);
    // 不再含 {targetLanguage} 模板字串
    expect(result).not.toContain('{targetLanguage}');
    // universal prompt 不含 zh-TW 特有的「台灣慣用語」字串
    expect(result).not.toContain('台灣慣用語');
  });

  test('target=zh-CN + userOverride=DEFAULT_SYSTEM_PROMPT → 視為未客製,自動切到 zh-CN universal', () => {
    // 關鍵 case:既有 zh-TW 使用者切 target 到 zh-CN,saved 仍是 zh-TW DEFAULT
    // → 應該視為「未客製」,自動切到 zh-CN universal
    const result = getEffectiveSystemPrompt('zh-CN', DEFAULT_SYSTEM_PROMPT);
    expect(result).toContain(LANG_LABELS['zh-CN']);
    expect(result).not.toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('target=zh-CN + userOverride="自訂" → 直接回自訂(target 變更也尊重)', () => {
    expect(getEffectiveSystemPrompt('zh-CN', '我自訂的 prompt')).toBe('我自訂的 prompt');
  });

  test('target=en + userOverride="" → UNIVERSAL 注入 English label', () => {
    const result = getEffectiveSystemPrompt('en', '');
    expect(result).toContain('English');
    expect(result).not.toContain('{targetLanguage}');
  });

  test('target=en + userOverride=DEFAULT → 視為未客製,自動切到 en universal', () => {
    const result = getEffectiveSystemPrompt('en', DEFAULT_SYSTEM_PROMPT);
    expect(result).toContain('English');
    expect(result).not.toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

test.describe('P1: 其他 4 個 getEffective*Prompt 行為一致', () => {
  test('Doc:target=zh-TW 走 DEFAULT_DOC,target=zh-CN 走 UNIVERSAL_DOC', () => {
    expect(getEffectiveDocSystemPrompt('zh-TW', '')).toBe(DEFAULT_DOC_SYSTEM_PROMPT);
    const cn = getEffectiveDocSystemPrompt('zh-CN', '');
    expect(cn).toContain(LANG_LABELS['zh-CN']);
    expect(cn).not.toContain('{targetLanguage}');
  });

  test('Glossary:target=zh-TW 走 DEFAULT_GLOSSARY,target=en 走 UNIVERSAL_GLOSSARY', () => {
    expect(getEffectiveGlossaryPrompt('zh-TW', '')).toBe(DEFAULT_GLOSSARY_PROMPT);
    const en = getEffectiveGlossaryPrompt('en', '');
    expect(en).toContain('English');
    expect(en).not.toContain('{targetLanguage}');
    // universal glossary prompt 不含 zh-TW 特有的「台灣通行譯名」
    expect(en).not.toContain('台灣通行譯名');
  });

  test('Subtitle:target=zh-CN 走 UNIVERSAL_SUBTITLE 注入後', () => {
    const cn = getEffectiveSubtitleSystemPrompt('zh-CN', '');
    expect(cn).toContain(LANG_LABELS['zh-CN']);
    expect(cn).not.toContain('{targetLanguage}');
  });

  test('ASR:target=zh-TW 走 DEFAULT_ASR(無 user override 入口),sourceLanguage 預設 en 替換成「英文」', () => {
    // v1.9.18 起 ASR prompt 加 {sourceLanguage} placeholder;預設 source='en' 走「英文」label。
    const tw = getEffectiveAsrSubtitleSystemPrompt('zh-TW');
    expect(tw).not.toContain('{sourceLanguage}');
    expect(tw).toContain('專業的英文 ASR');
    expect(tw).toContain('英文 YouTube 自動字幕');
  });

  test('ASR:target=zh-TW + sourceLanguage=ja → 注入「日文」,prompt 無「{sourceLanguage}」/「英文」殘留', () => {
    const ja = getEffectiveAsrSubtitleSystemPrompt('zh-TW', 'ja');
    expect(ja).not.toContain('{sourceLanguage}');
    expect(ja).toContain('專業的日文 ASR');
    expect(ja).toContain('日文 YouTube 自動字幕');
    // Critical rules 不能寫死「保留英文」(舊版會讓 Gemini 看到「保留英文」+ 日文 input 拒譯)
    expect(ja).not.toContain('保留英文');
  });

  test('ASR:target=en 走 UNIVERSAL_ASR 注入 English', () => {
    const en = getEffectiveAsrSubtitleSystemPrompt('en');
    expect(en).toContain('English');
    expect(en).not.toContain('{targetLanguage}');
    expect(en).not.toContain('{sourceLanguage}');
  });

  test('ASR:target=en + sourceLanguage=ja → universal prompt 注入「Japanese」', () => {
    const en = getEffectiveAsrSubtitleSystemPrompt('en', 'ja');
    expect(en).toContain('translating Japanese ASR');
    expect(en).not.toContain('{sourceLanguage}');
  });
});

test.describe('P1: edge cases', () => {
  test("未知 target 視為 fallback 'en' label(防禦不認識的值)", () => {
    const result = getEffectiveSystemPrompt('xx-YY', '');
    expect(result).toContain('English');
  });

  test('userOverride 是純空白 → 視為空,走 target 預設', () => {
    expect(getEffectiveSystemPrompt('zh-TW', '   ')).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(getEffectiveSystemPrompt('zh-TW', '\n\n')).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

test.describe("P1: target-language reinforcement(對應 Gemini Flash 短輸入服從度不穩)", () => {
  // 末尾 append 一條用 target language 寫的 task reinforcement(不用 ALL CAPS,平實表述),
  // double-tap 提高 LLM 對短輸入服從度。只 SYSTEM 跟 DOC 主翻譯加;GLOSSARY/SUBTITLE/ASR 不加。

  test('target=zh-CN + saved="" → effective 末尾含「请将输入文本翻译成简体中文」reinforcement', () => {
    const eff = getEffectiveSystemPrompt('zh-CN', '');
    expect(eff).toContain('请将输入文本翻译成简体中文');
    expect(eff).toContain('使用中国地区的用词习惯');
    expect(eff).not.toContain('大陸');
    expect(eff).not.toContain('大陆');
  });

  test('target=en + saved="" → effective 末尾含「Translate the input text into English」reinforcement', () => {
    const eff = getEffectiveSystemPrompt('en', '');
    expect(eff).toContain('Translate the input text into English');
    expect(eff).toContain('regardless of the source language');
  });

  test('target=zh-TW → 不 append reinforcement(走原 DEFAULT 已含完整規則)', () => {
    const eff = getEffectiveSystemPrompt('zh-TW', '');
    expect(eff).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(eff).not.toContain('请将输入文本翻译');
  });

  test('target=zh-CN + 客製化 saved → 不 append reinforcement(尊重使用者)', () => {
    const customized = '我自訂的 prompt 內容,完全自己寫';
    expect(getEffectiveSystemPrompt('zh-CN', customized)).toBe(customized);
  });

  test('GLOSSARY / SUBTITLE / ASR 不 append reinforcement(避免干擾 JSON / 段對齊指示)', () => {
    expect(getEffectiveGlossaryPrompt('zh-CN', '')).not.toContain('请将输入文本翻译');
    expect(getEffectiveSubtitleSystemPrompt('en', '')).not.toContain('regardless of the source language');
    expect(getEffectiveAsrSubtitleSystemPrompt('en')).not.toContain('regardless of the source language');
  });

  // P1 v1.8.59:5 個新 target language 的 reinforcement 文字驗證(用該目標語言寫的 task instruction)
  test('target=ja → universal 注入 Japanese label + 末尾日文 reinforcement', () => {
    const eff = getEffectiveSystemPrompt('ja', '');
    expect(eff).toContain('Japanese (日本語)');
    expect(eff).toContain('入力テキストを日本語に翻訳');
    expect(eff).toContain('原文がどの言語であっても');
  });

  test('target=ko → universal 注入 Korean label + 末尾韓文 reinforcement', () => {
    const eff = getEffectiveSystemPrompt('ko', '');
    expect(eff).toContain('Korean (한국어)');
    expect(eff).toContain('입력 텍스트를 한국어로 번역');
  });

  test('target=es → universal 注入 Spanish label + 末尾西文 reinforcement', () => {
    const eff = getEffectiveSystemPrompt('es', '');
    expect(eff).toContain('Spanish (español)');
    expect(eff).toContain('Traduzca el texto de entrada al español');
  });

  test('target=fr → universal 注入 French label + 末尾法文 reinforcement', () => {
    const eff = getEffectiveSystemPrompt('fr', '');
    expect(eff).toContain('French (français)');
    expect(eff).toContain('Traduisez le texte d');  // d'entrée 含撇號跨匹配,簡化用 d
    expect(eff).toContain('en français');
  });

  test('target=de → universal 注入 German label + 末尾德文 reinforcement', () => {
    const eff = getEffectiveSystemPrompt('de', '');
    expect(eff).toContain('German (Deutsch)');
    expect(eff).toContain('Übersetzen Sie den Eingabetext ins Deutsche');
  });
});

test.describe("P1: 歷史 prompt 字面值 normalize(v1.8.58 → v1.8.59 升級無痛)", () => {
  // v1.8.59 把 DEFAULT_SYSTEM_PROMPT 內 3 處「中國大陸」改成「中國」。
  // 既有 zh-TW 使用者升級後 saved 仍是舊版字面值(含「中國大陸」)── 必須 normalize 後
  // 視為「未客製」,否則 hint 會誤啟「你已客製化此 prompt」(實際上他們從未動過)。

  // 模擬 v1.8.58 之前的舊版 DEFAULT_SYSTEM_PROMPT 字面值(含「中國大陸用語」)
  const LEGACY_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT.replaceAll('中國', '中國大陸');

  test('saved=v1.8.58 字面值(含「中國大陸用語」)→ 視為未客製,target=zh-TW 仍走當前 DEFAULT', () => {
    expect(getEffectiveSystemPrompt('zh-TW', LEGACY_SYSTEM_PROMPT)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('saved=v1.8.58 字面值 + target=zh-CN → 視為未客製,自動切到 zh-CN universal', () => {
    const result = getEffectiveSystemPrompt('zh-CN', LEGACY_SYSTEM_PROMPT);
    expect(result).toContain(LANG_LABELS['zh-CN']);
    expect(result).not.toBe(LEGACY_SYSTEM_PROMPT);
  });

  test('真客製化(改了正文文字)→ 即使含「中國」字也視為客製,直接 return', () => {
    const customized = DEFAULT_SYSTEM_PROMPT + '\n\n額外規則:翻譯時請特別注意醫學術語';
    expect(getEffectiveSystemPrompt('zh-TW', customized)).toBe(customized);
    expect(getEffectiveSystemPrompt('zh-CN', customized)).toBe(customized);
  });
});

test.describe('v1.10.46: saved=「某 target 注入後的 effective default」必須視為未客製(語言凍結 bug)', () => {
  // Bug 重現:options.js 儲存設定時把 textarea 字面值寫進 systemInstruction,而 textarea
  // 內容是「當前 target 的 effective default」(universal prompt 注入語言 label + reinforcement)。
  // 修前 _buildEffective 只比對 zh-TW 版 DEFAULT → saved 被當客製 → 之後切 target 永遠
  // 翻成舊語言,直到再開 options 重存。

  test('saved=ja effective default + target=en → 回 en universal,不凍結在日文', () => {
    const savedJa = getEffectiveSystemPrompt('ja', '');  // = options.js 對 ja 使用者存進去的字面值
    const effEn = getEffectiveSystemPrompt('en', savedJa);
    expect(effEn).toContain('Translate the input text into English');
    expect(effEn).not.toContain('入力テキストを日本語に翻訳');
    expect(effEn).not.toContain('Japanese (日本語)');
  });

  test('saved=en effective default + target=zh-TW → 回 DEFAULT_SYSTEM_PROMPT', () => {
    const savedEn = getEffectiveSystemPrompt('en', '');
    expect(getEffectiveSystemPrompt('zh-TW', savedEn)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('saved=zh-CN effective default + target=zh-CN → 行為不變(仍回 zh-CN effective)', () => {
    const savedCn = getEffectiveSystemPrompt('zh-CN', '');
    expect(getEffectiveSystemPrompt('zh-CN', savedCn)).toBe(savedCn);
  });

  test('saved=ja effective default 再加使用者改動 → 視為客製,直接 return saved', () => {
    const customized = getEffectiveSystemPrompt('ja', '') + '\n\n追加の独自ルール';
    expect(getEffectiveSystemPrompt('en', customized)).toBe(customized);
  });

  test('Doc / Glossary / Subtitle 同 pattern:saved=ja effective + target=en 不凍結', () => {
    const docJa = getEffectiveDocSystemPrompt('ja', '');
    expect(getEffectiveDocSystemPrompt('en', docJa)).toContain('Translate the input text into English');
    const gloJa = getEffectiveGlossaryPrompt('ja', '');
    const gloEn = getEffectiveGlossaryPrompt('en', gloJa);
    expect(gloEn).toContain('English');
    expect(gloEn).not.toContain('Japanese (日本語)');
    const subJa = getEffectiveSubtitleSystemPrompt('ja', '');
    const subEn = getEffectiveSubtitleSystemPrompt('en', subJa);
    expect(subEn).toContain('English');
    expect(subEn).not.toContain('Japanese (日本語)');
  });
});

// SANITY 紀錄(已驗證,2026-06-11):
//   v1.10.46 describe 採「先寫 spec 重現紅燈 → 修法 → 綠燈」流程:修法
//   (_isAnyTargetDefault 擴大未客製判定)套用前,「saved=ja effective + target=en」
//   「saved=en effective + target=zh-TW」「Doc/Glossary/Subtitle 同 pattern」3 條 fail
//   (effective prompt 凍結在日文 reinforcement 字面值);套用後 35 條全綠。

// SANITY 紀錄(已驗證):
//   把 _normalizePromptForComparison 內 `.replace(/中國大陸/g, '中國')` 那行拿掉
//   → 「saved=v1.8.58 字面值 → 視為未客製」case 全 fail(strict equality 比對失敗,
//      legacy saved 被當客製,target=zh-TW return legacy 字面值,target=zh-CN return legacy)。
//   還原後 pass。

// SANITY 紀錄(已驗證):
//   把 _buildEffective 內的「treatedAsUnchanged」判定強制 false
//   (`const treatedAsUnchanged = false;`)→
//   - test「target=zh-TW + userOverride=DEFAULT」會 fail(因為會 return userOverride 字面值,
//     而 expect 等於 DEFAULT_SYSTEM_PROMPT 仍對 ── 但實作 `return userOverride` 跟 `return DEFAULT` 表面值相同;
//     此 sanity case 測不出問題,改測下面這條)
//   - test「target=zh-CN + userOverride=DEFAULT_SYSTEM_PROMPT」會 fail
//     (return DEFAULT_SYSTEM_PROMPT 字面值,不會切到 zh-CN universal,expect contains LANG_LABELS['zh-CN'] 失敗)
//   還原後全部 pass。
