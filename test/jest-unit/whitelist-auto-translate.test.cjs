'use strict';

/**
 * v1.1.2+v1.1.4 regression: 白名單自動翻譯
 *
 * Bug #1（v1.1.2 前）：白名單自動翻譯只在 SPA 導航時觸發，
 *   首次載入不會自動翻譯白名單網域。
 *
 * Bug #2（v1.1.2 修完後）：`autoTranslate` 被當成全域開關，
 *   打勾後所有網站都自動翻譯，而非只翻白名單網域。
 *
 * 修法（v1.1.4）：isDomainWhitelisted() helper + 首次載入和
 *   SPA 導航都改為 `autoTranslate && isDomainWhitelisted()` 雙重檢查。
 *
 * 測試策略：
 *   isDomainWhitelisted() 內部依賴 chrome.storage.sync.get，
 *   透過 create-env 的 chrome mock 注入不同的 domainRules，
 *   再觀察初始載入時是否觸發 translatePage。
 *   translatePage 的標誌是它會呼叫 storage.sync.get(null) (v1.1.9 合併讀取)。
 */

const { createEnv, waitForCondition } = require('./helpers/create-env.cjs');

describe('v1.1.2+v1.1.4: 白名單自動翻譯', () => {
  let env;

  afterEach(() => {
    if (env) { env.cleanup(); env = null; }
  });

  /**
   * Helper：建立環境並設定 chrome.storage.sync.get 的回應。
   * content.js 載入後會立刻執行首次載入的自動翻譯檢查。
   */
  function createEnvWithStorage(url, storageData) {
    // 先建立 JSDOM + chrome mock，但還不載入 content scripts
    // createEnv 會立刻 eval 全部檔案，所以我們自建 env + 用 helper 的 contentScriptCodes
    const { JSDOM } = require('jsdom');
    const { contentScriptCodes } = require('./helpers/create-env.cjs');

    const dom = new JSDOM(
      '<!DOCTYPE html><html><head></head><body><p>Hello world test paragraph.</p></body></html>',
      { url, runScripts: 'dangerously', pretendToBeVisual: true }
    );
    const win = dom.window;

    const chromeMock = {
      runtime: {
        sendMessage: jest.fn().mockImplementation(() => Promise.resolve({})),
        getManifest: jest.fn().mockReturnValue({ version: '1.1.8' }),
        onMessage: { addListener: jest.fn() },
      },
      storage: {
        sync: {
          get: jest.fn().mockImplementation((keys) => {
            // 根據請求的 key 回傳對應的 storage 資料
            if (typeof keys === 'string') {
              return Promise.resolve({ [keys]: storageData[keys] });
            }
            if (Array.isArray(keys)) {
              const result = {};
              keys.forEach(k => { if (k in storageData) result[k] = storageData[k]; });
              return Promise.resolve(result);
            }
            // keys 是物件（帶預設值）
            if (typeof keys === 'object' && keys !== null) {
              const result = {};
              Object.keys(keys).forEach(k => {
                result[k] = k in storageData ? storageData[k] : keys[k];
              });
              return Promise.resolve(result);
            }
            return Promise.resolve(storageData);
          }),
        },
        onChanged: { addListener: jest.fn() },
      },
    };
    win.chrome = chromeMock;
    for (const code of contentScriptCodes) win.eval(code);

    return {
      dom, window: win, document: win.document, chrome: chromeMock,
      shinkansen: win.__shinkansen,
      cleanup() { win.close(); },
    };
  }

  // ── 精確比對 ──────────────────────────────────────────
  test('autoTranslate ON + 網域命中白名單（精確比對）→ 首次載入觸發翻譯', async () => {
    env = createEnvWithStorage('https://medium.com/some-article', {
      autoTranslate: true,
      domainRules: { whitelist: ['medium.com'] },
    });

    // translatePage 被呼叫的標誌：storage.sync.get(null) (v1.1.9 合併讀取)
    const triggered = await waitForCondition(() => {
      return env.chrome.storage.sync.get.mock.calls.some(
        ([keys]) => keys === null
      );
    }, { timeout: 3000 });
    expect(triggered).toBe(true);
  });

  // ── 萬用字元比對 ──────────────────────────────────────
  test('autoTranslate ON + 萬用字元白名單 *.example.com 命中子網域 → 觸發翻譯', async () => {
    env = createEnvWithStorage('https://blog.example.com/post', {
      autoTranslate: true,
      domainRules: { whitelist: ['*.example.com'] },
    });

    const triggered = await waitForCondition(() => {
      return env.chrome.storage.sync.get.mock.calls.some(
        ([keys]) => keys === null
      );
    }, { timeout: 3000 });
    expect(triggered).toBe(true);
  });

  // ── 萬用字元：根域名也命中 ─────────────────────────────
  test('autoTranslate ON + *.example.com 也命中 example.com 本身 → 觸發翻譯', async () => {
    env = createEnvWithStorage('https://example.com/', {
      autoTranslate: true,
      domainRules: { whitelist: ['*.example.com'] },
    });

    const triggered = await waitForCondition(() => {
      return env.chrome.storage.sync.get.mock.calls.some(
        ([keys]) => keys === null
      );
    }, { timeout: 3000 });
    expect(triggered).toBe(true);
  });

  // ── 網域不命中 ────────────────────────────────────────
  test('autoTranslate ON + 網域不在白名單 → 不觸發翻譯', async () => {
    env = createEnvWithStorage('https://evil.com/page', {
      autoTranslate: true,
      domainRules: { whitelist: ['medium.com'] },
    });

    // 負向測試：等足夠時間讓首次載入邏輯跑完
    await new Promise(r => setTimeout(r, 1500));

    const hasTranslateCall = env.chrome.storage.sync.get.mock.calls.some(
      ([keys]) => keys === null
    );
    expect(hasTranslateCall).toBe(false);
  });

  // ── autoTranslate 關閉 ────────────────────────────────
  test('autoTranslate OFF + 網域在白名單 → 不觸發翻譯', async () => {
    env = createEnvWithStorage('https://medium.com/article', {
      autoTranslate: false,
      domainRules: { whitelist: ['medium.com'] },
    });

    await new Promise(r => setTimeout(r, 1500));

    const hasTranslateCall = env.chrome.storage.sync.get.mock.calls.some(
      ([keys]) => keys === null
    );
    expect(hasTranslateCall).toBe(false);
  });

  // ── 白名單為空 ────────────────────────────────────────
  test('autoTranslate ON + 白名單為空 → 不觸發翻譯', async () => {
    env = createEnvWithStorage('https://medium.com/article', {
      autoTranslate: true,
      domainRules: { whitelist: [] },
    });

    await new Promise(r => setTimeout(r, 1500));

    const hasTranslateCall = env.chrome.storage.sync.get.mock.calls.some(
      ([keys]) => keys === null
    );
    expect(hasTranslateCall).toBe(false);
  });
});
