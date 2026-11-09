// Regression(對應修「全新安裝術語表設定顯示『關』卻照建」的 bug):
//
// Fixture: test/regression/fixtures/glossary-enabled-default.html
// 結構:最小頁面,只為載入 content script 讓 window.__SK 存在。
//
// Bug:content.js translatePage 讀設定走 `storage.sync.get(null)` 原始讀取,
//   不經 getSettings() 合併預設。原本術語表開關的 fallback 寫死 `glossaryEnabled = true`,
//   只有在 `settings.glossary` 存在時才覆寫成 `gc.enabled !== false`。全新安裝時
//   storage 還沒有 glossary key → settings.glossary 為 undefined → fallback 的 true
//   生效 → 術語表照建。但設定頁(options.js)讀的是合併預設(false),checkbox 顯示「關」,
//   使用者完全看不出來,還會無聲多花 token + 一個 EXTRACT_GLOSSARY 請求。
//   使用者把 toggle 開再關 → 設定頁存檔寫入 glossary{enabled:false} → 之後才正常。
//
// 修法(結構性通則,§5 單一資料源):抽 SK.resolveGlossaryEnabled(settings),
//   fallback 對齊 DEFAULT_SETTINGS.glossary.enabled(false)——settings.glossary 缺失
//   時回 false,而非 true。content.js 改呼叫此 seam,production 與本 spec 同一條邏輯。
//
// 本 spec 鎖的訊號層(CLAUDE.md 工作流原則 §3):
//   驗「resolveGlossaryEnabled 對各種 settings 形狀的判斷正確」——尤其「無 glossary key
//   → false」這條(bug case)。不驗「false 是否真的擋下 EXTRACT_GLOSSARY 訊息」
//   (那是 `if (glossaryEnabled && ...)` 的固有行為,本次未動)。
//
// SANITY CHECK 紀錄(已驗證):
//   把 content-ns.js SK.resolveGlossaryEnabled 的 `if (!gc) return false;` 改回
//   `if (!gc) return true;`(重現舊 bug 的寫死 true)→ 「無 glossary key」case 的
//   `toBe(false)` 斷言 fail。還原後全綠。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('resolveGlossaryEnabled:全新安裝(無 glossary key)應為 false,不無聲建術語表', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/glossary-enabled-default.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const f = window.__SK.resolveGlossaryEnabled;
      return {
        // bug case:全新安裝 storage 無 glossary key
        noKey: f({}),
        // settings 整個 undefined / null(防禦)
        undefinedSettings: f(undefined),
        nullSettings: f(null),
        // 存過檔且明確關閉
        explicitFalse: f({ glossary: { enabled: false } }),
        // 存過檔且明確開啟
        explicitTrue: f({ glossary: { enabled: true } }),
        // glossary 物件存在但沒帶 enabled(維持既有語意:!== false → true)
        objNoEnabled: f({ glossary: { skipThreshold: 1 } }),
      };
    })()
  `);

  // 核心修復點:無 glossary key 必須 false(舊 bug 在此回 true)
  expect(r.noKey, '全新安裝(無 glossary key)應為 false').toBe(false);
  expect(r.undefinedSettings, 'settings=undefined 應為 false').toBe(false);
  expect(r.nullSettings, 'settings=null 應為 false').toBe(false);

  // 既有行為維持不變
  expect(r.explicitFalse, '明確 enabled:false 應為 false').toBe(false);
  expect(r.explicitTrue, '明確 enabled:true 應為 true').toBe(true);
  expect(r.objNoEnabled, 'glossary 物件無 enabled 欄位沿用 !== false 語意 → true').toBe(true);

  await page.close();
});
