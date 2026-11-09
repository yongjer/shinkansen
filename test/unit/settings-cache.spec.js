// Unit test: lib/storage.js getSettingsCached(v1.8.14 settings cache)
//
// 原 bug(v1.8.13 review B2+B3):
//   - logger.js debugLog 每筆都呼 getSettings() → 翻譯量大時每秒上百次
//     storage.sync.get(null) + storage.local.get IPC + 完整深 merge
//   - background.js LOG_USAGE handler 每筆 await getSettings() 解析 model →
//     YouTube 一支影片上百筆 batch,每筆都重讀整份 settings
//
// 修法:lib/storage.js 加 getSettingsCached() promise cache + storage.onChanged
// invalidate;logger.js debugLog 與 background.js LOG_USAGE handler 都改用
// cached 版本。SW 重啟後 module 重 init,cache 自然從零開始。
//
// SANITY 已驗(2026-04-28):
//   把 getSettingsCached body 改回 `return getSettings()` (不 cache),
//   "100 次呼叫只該觸發 1 次 storage.sync.get" test fail。還原後 pass。

import { test, expect } from '@playwright/test';

// 用 dynamic import + globalThis mock 模擬 chrome.storage,避免動 production code
test('getSettingsCached: 100 次呼叫只該觸發 1 次 storage.sync.get(同 cache)', async () => {
  // 計數器:統計 storage.sync.get 與 storage.local.get 被呼叫幾次
  let syncGetCalls = 0;
  let localGetCalls = 0;

  // Mock chrome.storage(必須在 import storage.js 之前掛上)
  const mockSettings = { debugLog: false, geminiConfig: { model: 'gemini-flash' } };
  globalThis.chrome = {
    storage: {
      sync: {
        get: async () => { syncGetCalls++; return mockSettings; },
        remove: async () => {},
      },
      local: {
        get: async () => { localGetCalls++; return {}; },
      },
      onChanged: {
        addListener: () => {},
      },
    },
  };

  // dynamic import(每次 test 重 import 不可行,因為 ES module 有 cache;
  // 改成手動 reset module-scope cache 變數的方法不 portable)
  // 用 cache-busting query string 強制重 import → 拿到全新 module instance
  const { getSettingsCached } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now()
  );

  // 100 次連續呼叫
  for (let i = 0; i < 100; i++) {
    await getSettingsCached();
  }

  expect(
    syncGetCalls,
    `100 次 getSettingsCached 應只觸發 1 次 storage.sync.get(實際:${syncGetCalls})`,
  ).toBe(1);

  expect(
    localGetCalls,
    `100 次 getSettingsCached 應只觸發 ≤ 2 次 storage.local.get(apiKey + customProvider apiKey,實際:${localGetCalls})`,
  ).toBeLessThanOrEqual(2);
});

test('getSettingsCached: storage.onChanged 觸發後應 invalidate 重新讀', async () => {
  let syncGetCalls = 0;
  let onChangedListener = null;

  const mockSettings = { debugLog: false, geminiConfig: { model: 'gemini-flash' } };
  globalThis.chrome = {
    storage: {
      sync: {
        get: async () => { syncGetCalls++; return mockSettings; },
        remove: async () => {},
      },
      local: {
        get: async () => ({}),
      },
      onChanged: {
        addListener: (cb) => { onChangedListener = cb; },
      },
    },
  };

  const { getSettingsCached } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now()
  );

  await getSettingsCached();
  await getSettingsCached();
  expect(syncGetCalls, '兩次連續呼叫應只觸發 1 次').toBe(1);

  // 模擬使用者改 storage(例:options 頁存設定)
  expect(onChangedListener, 'storage.onChanged listener 應已綁上').not.toBeNull();
  onChangedListener({}, 'sync');

  // invalidate 後再次呼叫應重新讀
  await getSettingsCached();
  expect(syncGetCalls, 'onChanged 後應重新觸發 1 次 → 共 2 次').toBe(2);
});

// ── v1.10.46(批次 2-6):invalidator 過濾無關的 local 高頻寫入 ──
//
// 原 bug:onChanged listener 任何變動都 invalidate。翻譯期間 logger persistLog
// (yt_debug_log,高頻)與 tc_* 快取 flush 都寫 storage.local → cache 被自己的
// log 寫入持續打穿,翻譯熱路徑的實際命中率近零(v1.8.14 的初衷整個失效)。
//
// 修法:只在 area==='sync',或 local 且 changes 含 apiKey / customProviderApiKey
// 時才 invalidate(getSettings 的資料來源只有這些)。
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 listener 的過濾條件拿掉(改回無條件
// invalidate)→「yt_debug_log / tc_* 寫入不得 invalidate」case fail → 還原 → pass。

function makeChromeMock() {
  const state = { syncGetCalls: 0, listener: null };
  globalThis.chrome = {
    storage: {
      sync: {
        get: async () => { state.syncGetCalls++; return { debugLog: false, geminiConfig: { model: 'gemini-flash' } }; },
        remove: async () => {},
      },
      local: { get: async () => ({}) },
      onChanged: { addListener: (cb) => { state.listener = cb; } },
    },
  };
  return state;
}

test('2-6: local 的 yt_debug_log / tc_* 寫入不得 invalidate settings cache', async () => {
  const state = makeChromeMock();
  const { getSettingsCached } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now() + '-filter1'
  );

  await getSettingsCached();
  expect(state.syncGetCalls).toBe(1);

  // 翻譯期間的高頻 local 寫入(logger persistLog / cache flush)
  state.listener({ yt_debug_log: { newValue: [] } }, 'local');
  await getSettingsCached();
  state.listener({ tc_abc123: { newValue: 'x' }, tc_def456: { newValue: 'y' } }, 'local');
  await getSettingsCached();

  expect(
    state.syncGetCalls,
    'yt_debug_log / tc_* 的 local 寫入不該 invalidate(翻譯熱路徑會把 cache 打穿)',
  ).toBe(1);
});

test('2-6: local 的 apiKey / customProviderApiKey 變動仍要 invalidate', async () => {
  const state = makeChromeMock();
  const { getSettingsCached } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now() + '-filter2'
  );

  await getSettingsCached();
  state.listener({ apiKey: { newValue: 'new-key' } }, 'local');
  await getSettingsCached();
  expect(state.syncGetCalls, 'apiKey 變動應 invalidate').toBe(2);

  state.listener({ customProviderApiKey: { newValue: 'cp-key' } }, 'local');
  await getSettingsCached();
  expect(state.syncGetCalls, 'customProviderApiKey 變動應 invalidate').toBe(3);
});

test('2-6: sync 任何變動仍要 invalidate(設定頁存設定)', async () => {
  const state = makeChromeMock();
  const { getSettingsCached } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now() + '-filter3'
  );

  await getSettingsCached();
  state.listener({ tier: { newValue: 'tier2' } }, 'sync');
  await getSettingsCached();
  expect(state.syncGetCalls, 'sync 變動應 invalidate').toBe(2);
});
