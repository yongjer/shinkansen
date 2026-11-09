// fork/engines/lang.js — 驛傳（Ekiden）機器翻譯引擎的語言代碼對映
//
// 上游的 targetLanguage 只有 8 種（zh-TW / zh-CN / en / ja / ko / es / fr / de），
// 各家 MT 服務的代碼寫法不同，集中在這裡對映，引擎模組不各自寫死。

export const TARGET_LANGS = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'];

// 來源語言設定值：'auto' = 交給服務自動偵測
export const SOURCE_LANGS = ['auto', ...TARGET_LANGS];

const MICROSOFT = {
  'zh-TW': 'zh-Hant', 'zh-CN': 'zh-Hans', en: 'en', ja: 'ja', ko: 'ko', es: 'es', fr: 'fr', de: 'de',
};

// DeepL：目標語言要區分變體（EN 單獨當目標已棄用、中文要指定繁簡）；來源語言不分變體
const DEEPL_TARGET = {
  'zh-TW': 'ZH-HANT', 'zh-CN': 'ZH-HANS', en: 'EN-US', ja: 'JA', ko: 'KO', es: 'ES', fr: 'FR', de: 'DE',
};
const DEEPL_SOURCE = {
  'zh-TW': 'ZH', 'zh-CN': 'ZH', en: 'EN', ja: 'JA', ko: 'KO', es: 'ES', fr: 'FR', de: 'DE',
};

// Chrome 內建 Translator API 使用 BCP 47；簡體中文是 'zh'，繁體中文是 'zh-Hant'
const CHROME = {
  'zh-TW': 'zh-Hant', 'zh-CN': 'zh', en: 'en', ja: 'ja', ko: 'ko', es: 'es', fr: 'fr', de: 'de',
};

function pick(table, lang, fallbackLang = 'zh-TW') {
  return table[lang] || table[fallbackLang];
}

export function normalizeTarget(lang) {
  return TARGET_LANGS.includes(lang) ? lang : 'zh-TW';
}

export function normalizeSource(lang) {
  return SOURCE_LANGS.includes(lang) ? lang : 'auto';
}

export const microsoftTarget = (lang) => pick(MICROSOFT, normalizeTarget(lang));
export const microsoftSource = (lang) => (normalizeSource(lang) === 'auto' ? '' : MICROSOFT[lang]);
export const deeplTarget = (lang) => pick(DEEPL_TARGET, normalizeTarget(lang));
export const deeplSource = (lang) => (normalizeSource(lang) === 'auto' ? '' : DEEPL_SOURCE[lang]);
export const chromeTarget = (lang) => pick(CHROME, normalizeTarget(lang));
export const chromeSource = (lang) => (normalizeSource(lang) === 'auto' ? '' : CHROME[lang]);
