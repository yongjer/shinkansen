'use strict';

/**
 * PENDING_REGRESSION 清空（2026-07-02,原 dev tail 1.10.68.1 修,轉 path A）:
 *   「回復預設設定」排除 Instapaper 帳號連結。
 *
 * 症狀:options「回復預設設定」按鈕原本裸 storage.sync.clear(),連 Instapaper 帳號連結
 *   （instapaperToken / instapaperTokenSecret / instapaperUsername,一次性 OAuth 授權）也
 *   一起清掉,使用者得重新輸入密碼連結。帳號連結不該被「回復偏好」清掉。
 *
 * 修在:shinkansen/options/options.js resetSyncPreservingLinks(storage) —— 先讀存
 *   RESET_PRESERVE_KEYS → clear → 只把實際存在的 key 寫回。
 *
 * 測試手法:options.js 依賴 DOM + browser globals 無法整檔載入 → brace counting 抽出
 *   resetSyncPreservingLinks 函式本體 + 從 source 抓 RESET_PRESERVE_KEYS 陣列,new Function
 *   注入後配一個假 storage（記錄 get/clear/set）驅動驗行為。
 *
 * 訊號層界定:驗「保留/還原邏輯對 storage 的呼叫序列正確（clear 後保留連結、清掉其他偏好、
 *   不寫 undefined）」,不驗真 options 頁按鈕在 Chrome/Safari runtime 的端到端行為（要真
 *   options 頁環境 + 真 chrome.storage.sync,harness 到不了）。
 *
 * SANITY 紀錄（已驗證,2026-07-02）:把 options.js 的 resetSyncPreservingLinks 改回裸
 *   `await storage.clear();`（拿掉 preserved 讀存 + 寫回）→「保留 Instapaper 連結」case fail
 *   （三 key 被清光）;還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/options/options.js'),
  'utf-8'
);

// brace counting 抽具名 async function 本體
function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`source 找不到 function ${name}`);
  // 若函式是 async,把前綴 `async ` 一起納入（否則抽出的本體含 await 但非 async 會語法錯）
  if (SRC.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
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

// 從 source 抓 RESET_PRESERVE_KEYS 的陣列字面量,讓 test 跟 production 保留清單自動同步
function extractPreserveKeys() {
  const m = SRC.match(/const RESET_PRESERVE_KEYS\s*=\s*(\[[^\]]*\])/);
  if (!m) throw new Error('source 找不到 RESET_PRESERVE_KEYS');
  return new Function(`return ${m[1]};`)();
}

const RESET_PRESERVE_KEYS = extractPreserveKeys();
const resetSyncPreservingLinks = new Function(
  'RESET_PRESERVE_KEYS',
  `${extractFn('resetSyncPreservingLinks')}; return resetSyncPreservingLinks;`
)(RESET_PRESERVE_KEYS);

// 假 storage:語意對齊 chrome.storage.sync —— get(arrayOfKeys) 只回實際存在的 key;
// clear() 清空;set(obj) 淺合併。並記錄 clear 呼叫次數供斷言。
function makeFakeStorage(initial) {
  let store = { ...initial };
  const calls = { clear: 0, set: 0 };
  return {
    async get(keys) {
      const out = {};
      for (const k of keys) if (k in store) out[k] = store[k];
      return out;
    },
    async clear() {
      calls.clear += 1;
      store = {};
    },
    async set(obj) {
      calls.set += 1;
      Object.assign(store, obj);
    },
    dump: () => ({ ...store }),
    calls,
  };
}

describe('回復預設設定保留 Instapaper 帳號連結', () => {
  test('已連結 Instapaper:clear 後三個帳號 key 保留、其他偏好被清掉', async () => {
    const storage = makeFakeStorage({
      instapaperToken: 'tok-123',
      instapaperTokenSecret: 'sec-456',
      instapaperUsername: 'jimmy@example.com',
      targetLanguage: 'en',
      dualMode: true,
      customShortcuts: { 1: { code: 'KeyS' } },
    });

    await resetSyncPreservingLinks(storage);

    expect(storage.calls.clear).toBe(1);
    expect(storage.dump()).toEqual({
      instapaperToken: 'tok-123',
      instapaperTokenSecret: 'sec-456',
      instapaperUsername: 'jimmy@example.com',
    });
  });

  test('未連結 Instapaper:clear 後 store 全空,不寫回任何 key（不寫 undefined）', async () => {
    const storage = makeFakeStorage({ targetLanguage: 'en', dualMode: true });

    await resetSyncPreservingLinks(storage);

    expect(storage.calls.clear).toBe(1);
    expect(storage.calls.set).toBe(0); // 沒東西可保留 → 不呼叫 set
    expect(storage.dump()).toEqual({});
  });

  test('部分連結（缺 tokenSecret）:只還原實際存在的 key,不塞 undefined 進 store', async () => {
    const storage = makeFakeStorage({
      instapaperToken: 'tok-123',
      instapaperUsername: 'jimmy@example.com',
      targetLanguage: 'zh-CN',
    });

    await resetSyncPreservingLinks(storage);

    const dump = storage.dump();
    expect(dump).toEqual({
      instapaperToken: 'tok-123',
      instapaperUsername: 'jimmy@example.com',
    });
    // 明確驗:缺的那個 key 不會以 undefined 形式存在
    expect('instapaperTokenSecret' in dump).toBe(false);
  });
});
