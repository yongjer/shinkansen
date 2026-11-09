// Unit test: P1 (v1.8.59) detectDefaultTargetLanguage(navigator.language → target)
//
// Q3 拍板規則:
//   zh-TW / zh-Hant / zh-HK    → 'zh-TW'(同繁體圈,zh-HK 雖港式詞彙不同但比 zh-CN/en 接近)
//   其他 zh-*(zh-CN / zh-Hans / zh-SG)→ 'zh-CN'
//   else                          → 'en'
import { test, expect } from '@playwright/test';

// Mock chrome.storage(getEffective* 不讀,但 storage.js import compat.js)
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync:  { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const { detectDefaultTargetLanguage } = await import('../../shinkansen/lib/storage.js');

const cases = [
  // → zh-TW
  ['zh-TW',     'zh-TW'],
  ['zh-Hant',   'zh-TW'],
  ['zh-Hant-TW','zh-TW'],
  ['zh-HK',     'zh-TW'],
  ['zh-Hant-HK','zh-TW'],
  // → zh-CN(其他 zh-*)
  ['zh-CN',     'zh-CN'],
  ['zh-Hans',   'zh-CN'],
  ['zh-Hans-CN','zh-CN'],
  ['zh-SG',     'zh-CN'],
  ['zh',        'zh-CN'],   // 泛中文也走 zh-CN(下游可手動切)
  // → en
  ['en',        'en'],
  ['en-US',     'en'],
  ['en-GB',     'en'],
  // → ja / ko / es / fr / de(P1 v1.8.59 後加入)
  ['ja',        'ja'],
  ['ja-JP',     'ja'],
  ['ko',        'ko'],
  ['ko-KR',     'ko'],
  ['es',        'es'],
  ['es-ES',     'es'],
  ['es-MX',     'es'],
  ['fr',        'fr'],
  ['fr-FR',     'fr'],
  ['fr-CA',     'fr'],
  ['de',        'de'],
  ['de-DE',     'de'],
  ['de-AT',     'de'],
  // → en(其他不在支援清單的語言)
  ['it',        'en'],
  ['pt-BR',     'en'],
  ['ru',        'en'],
];

// Node 環境下 globalThis.navigator 是 readonly(只有 getter),用 defineProperty 強制覆寫
function setNavigator(language) {
  Object.defineProperty(globalThis, 'navigator', {
    value: language === undefined ? undefined : { language },
    writable: true,
    configurable: true,
  });
}

test.describe('P1: detectDefaultTargetLanguage(navigator.language) 推導', () => {
  for (const [navLang, expected] of cases) {
    test(`navigator.language='${navLang}' → '${expected}'`, () => {
      setNavigator(navLang);
      expect(detectDefaultTargetLanguage()).toBe(expected);
    });
  }

  test('navigator 不存在(SW 邊界場景)→ fallback en', () => {
    setNavigator(undefined);
    expect(detectDefaultTargetLanguage()).toBe('en');
  });

  test('navigator.language 大小寫不影響(內部 toLowerCase)', () => {
    setNavigator('ZH-TW');
    expect(detectDefaultTargetLanguage()).toBe('zh-TW');
    setNavigator('zh-hk');
    expect(detectDefaultTargetLanguage()).toBe('zh-TW');
    setNavigator('EN-us');
    expect(detectDefaultTargetLanguage()).toBe('en');
  });
});

// SANITY 紀錄(已驗證):
//   把 detectDefaultTargetLanguage 內 zh-tw / zh-hant / zh-hk 的判斷拿掉(只剩 zh → zh-CN)
//   → 'zh-TW' / 'zh-Hant' / 'zh-HK' 三 case 都會回 'zh-CN' fail。還原後 pass。
