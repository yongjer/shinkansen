'use strict';

/**
 * v1.9.17 regression: isDomainWhitelisted www.* 前綴互通
 *
 * Bug:使用者在「自動翻譯指定網站」輸入裸 domain `culpium.com`,
 *   實際造訪 `www.culpium.com` 時 `hostname === pattern` 不成立 → 不觸發。
 *
 * 修法(`shinkansen/content-spa.js` `SK.isDomainWhitelisted`):
 *   exact-match 分支兩邊都 strip 開頭 `www.` 後再比。要匹配所有子網域請
 *   用 `*.culpium.com`(現有 wildcard 語法保持不變)。
 *
 * 測試策略:
 *   直接 call `SK.isDomainWhitelisted()` 觀察回傳值,不走 translatePage,
 *   繞過同檔案 `whitelist-auto-translate.test.cjs` 對 translatePage harness
 *   的 pre-existing 限制(SK.t 未被 mock)。
 *
 * SANITY 紀錄(已驗證 2026-05-14):
 *   暫時把 `content-spa.js` 修法還原成 `return hostname === pattern;`,
 *   本檔的 4 條正向 case(www. 前綴互通 / 大小寫 normalize)會 fail,
 *   還原修法後全綠。負向 case(evil.medium.com 不誤命中 / evil.com 不命中)
 *   不論修法都過,僅驗證裸 domain pattern 不會被擴解。
 */

const { JSDOM } = require('jsdom');
const path = require('path');
const fs = require('fs');

function loadContentScripts() {
  const root = path.join(__dirname, '..', '..', 'shinkansen');
  const files = ['content-ns.js', 'lib/domain-utils.js', 'content-toast.js', 'content-detect.js',
                 'content-serialize.js', 'content-inject.js', 'content-spa.js'];
  return files.map(f => fs.readFileSync(path.join(root, f), 'utf8'));
}

const SCRIPTS = loadContentScripts();

function makeEnv(url, storageData) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body></body></html>',
    { url, runScripts: 'dangerously', pretendToBeVisual: true }
  );
  const win = dom.window;
  win.chrome = {
    runtime: {
      sendMessage: () => Promise.resolve({}),
      getManifest: () => ({ version: '1.9.17' }),
      onMessage: { addListener: () => {} },
    },
    storage: {
      sync: {
        get: (keys) => {
          if (typeof keys === 'string') return Promise.resolve({ [keys]: storageData[keys] });
          if (Array.isArray(keys)) {
            const result = {};
            keys.forEach(k => { if (k in storageData) result[k] = storageData[k]; });
            return Promise.resolve(result);
          }
          if (typeof keys === 'object' && keys !== null) {
            const result = {};
            Object.keys(keys).forEach(k => {
              result[k] = k in storageData ? storageData[k] : keys[k];
            });
            return Promise.resolve(result);
          }
          return Promise.resolve(storageData);
        },
      },
      onChanged: { addListener: () => {} },
    },
  };
  for (const code of SCRIPTS) {
    try { win.eval(code); } catch (_) { /* 某些子模組 init 會 throw 在純 JSDOM 沒問題,忽略 */ }
  }
  return { win, cleanup() { win.close(); } };
}

async function isMatch(url, whitelist) {
  const env = makeEnv(url, { domainRules: { whitelist } });
  try {
    return await env.win.__SK.isDomainWhitelisted();
  } finally {
    env.cleanup();
  }
}

describe('v1.9.17: isDomainWhitelisted www.* 前綴互通', () => {
  test('pattern `medium.com` 命中 hostname `www.medium.com`', async () => {
    expect(await isMatch('https://www.medium.com/article', ['medium.com'])).toBe(true);
  });

  test('pattern `www.medium.com` 命中 hostname `medium.com`', async () => {
    expect(await isMatch('https://medium.com/article', ['www.medium.com'])).toBe(true);
  });

  test('pattern 含大寫 `Medium.COM` 命中 lower-case hostname', async () => {
    expect(await isMatch('https://medium.com/article', ['Medium.COM'])).toBe(true);
  });

  test('pattern `WWW.Medium.com` 命中 hostname `medium.com`', async () => {
    expect(await isMatch('https://medium.com/article', ['WWW.Medium.com'])).toBe(true);
  });

  test('裸 domain pattern 不誤命中其他子網域(該用 *.medium.com)', async () => {
    expect(await isMatch('https://evil.medium.com/page', ['medium.com'])).toBe(false);
  });

  test('完全不相關 domain 不命中', async () => {
    expect(await isMatch('https://evil.com/page', ['medium.com'])).toBe(false);
  });

  test('精確 match 仍 work(無 www. 前綴)', async () => {
    expect(await isMatch('https://medium.com/article', ['medium.com'])).toBe(true);
  });

  test('wildcard `*.example.com` 仍命中子網域(不受 www. 規則影響)', async () => {
    expect(await isMatch('https://blog.example.com/post', ['*.example.com'])).toBe(true);
  });

  test('wildcard `*.example.com` 仍命中 example.com 本身', async () => {
    expect(await isMatch('https://example.com/', ['*.example.com'])).toBe(true);
  });

  test('空白名單 → 不命中', async () => {
    expect(await isMatch('https://medium.com/article', [])).toBe(false);
  });
});
