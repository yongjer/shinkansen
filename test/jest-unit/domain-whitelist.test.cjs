'use strict';

/**
 * Regression: 自動翻譯網站名單(domainRules.whitelist)的網域正規化 + 比對
 *
 * 起因：使用者在 options「自動翻譯網站」貼完整網址 `https://stratechery.com/`,
 * 但 content-spa.js 比對的是 location.hostname(`stratechery.com`),協定與尾斜線
 * 讓 exact-match 永遠不命中 → 自動翻譯不觸發。修法是把比對規則收斂到單一來源
 * lib/domain-utils.js,normalizeDomainEntry 將任意輸入形式正規化成純主機名。
 *
 * 涵蓋訊號層（CLAUDE.md 工作流原則 §3）:
 *   1. 純函式層(lib/domain-utils.js):normalizeDomainEntry 把協定 / 路徑 / query /
 *      hash / 尾斜線 / 埠號 / www. / 萬用字元前綴各種輸入收斂；matchDomain 的命中規則
 *
 * 不驗（明示 missing 層）:
 *   - content-spa.js isDomainWhitelisted 讀 storage → 呼叫 matchDomain 的串接:屬真實
 *     content world + location.hostname 綁定,fixture 無法改 hostname → 此層歸人眼 / 實機
 *
 * SANITY 紀錄（已驗證）:
 *   - 把 normalizeDomainEntry 去協定那行 `s = s.replace(/^[a-z]...:\/\//, '')` 註解掉
 *     → 「https://stratechery.com/ 命中 stratechery.com」斷言 fail；還原 → pass
 */

const path = require('path');
const { normalizeDomainEntry, matchDomain } = require(
  path.join(__dirname, '../../shinkansen/lib/domain-utils.js')
);

describe('normalizeDomainEntry', () => {
  test('完整網址收斂成純主機名', () => {
    expect(normalizeDomainEntry('https://stratechery.com/')).toBe('stratechery.com');
    expect(normalizeDomainEntry('http://stratechery.com')).toBe('stratechery.com');
    expect(normalizeDomainEntry('https://stratechery.com/2024/article?x=1#h')).toBe('stratechery.com');
  });

  test('裸網域 / 尾斜線 / 空白 / 大小寫', () => {
    expect(normalizeDomainEntry('stratechery.com')).toBe('stratechery.com');
    expect(normalizeDomainEntry('stratechery.com/')).toBe('stratechery.com');
    expect(normalizeDomainEntry('  Stratechery.COM  ')).toBe('stratechery.com');
    expect(normalizeDomainEntry('stratechery.com.')).toBe('stratechery.com');
  });

  test('埠號移除', () => {
    expect(normalizeDomainEntry('https://example.com:8080/path')).toBe('example.com');
  });

  test('萬用字元前綴保留', () => {
    expect(normalizeDomainEntry('*.culpium.com')).toBe('*.culpium.com');
    expect(normalizeDomainEntry('https://*.culpium.com/')).toBe('*.culpium.com');
  });

  test('空 / null 回空字串', () => {
    expect(normalizeDomainEntry('')).toBe('');
    expect(normalizeDomainEntry(null)).toBe('');
    expect(normalizeDomainEntry('   ')).toBe('');
  });
});

describe('matchDomain', () => {
  test('使用者貼整段網址也能命中（本次 bug 主場景）', () => {
    expect(matchDomain('stratechery.com', ['https://stratechery.com/'])).toBe(true);
    expect(matchDomain('stratechery.com', ['stratechery.com/'])).toBe(true);
    expect(matchDomain('stratechery.com', ['stratechery.com'])).toBe(true);
  });

  test('www. 兩邊互通', () => {
    expect(matchDomain('www.culpium.com', ['culpium.com'])).toBe(true);
    expect(matchDomain('culpium.com', ['www.culpium.com'])).toBe(true);
    expect(matchDomain('culpium.com', ['https://www.culpium.com/'])).toBe(true);
  });

  test('一般網域不誤命中子網域', () => {
    expect(matchDomain('sub.stratechery.com', ['stratechery.com'])).toBe(false);
    expect(matchDomain('notstratechery.com', ['stratechery.com'])).toBe(false);
  });

  test('萬用字元命中自身與所有子網域', () => {
    expect(matchDomain('culpium.com', ['*.culpium.com'])).toBe(true);
    expect(matchDomain('a.culpium.com', ['*.culpium.com'])).toBe(true);
    expect(matchDomain('a.b.culpium.com', ['*.culpium.com'])).toBe(true);
    expect(matchDomain('culpiumxcom', ['*.culpium.com'])).toBe(false);
  });

  test('空名單 / 空 hostname 不命中', () => {
    expect(matchDomain('stratechery.com', [])).toBe(false);
    expect(matchDomain('', ['stratechery.com'])).toBe(false);
    expect(matchDomain('stratechery.com', ['  ', ''])).toBe(false);
  });
});
