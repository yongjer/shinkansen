// Regression: P2 (v1.8.60) 禁用詞清單依 target 給對應預設(對齊 storage.js getSettings()
// 邏輯,修「使用者切到 en/zh-CN 仍看到 25 條中→中對映」UX bug)。
//
// 規格(SPEC §3.9):
//   saved 已寫入 → 完全以 saved 為準
//   saved 未寫入 + target=zh-TW → DEFAULT_FORBIDDEN_TERMS(25 條)
//   saved 未寫入 + target≠zh-TW → 空陣列
//
// 切 target picker 時:目前 forbiddenTerms 「視為未客製」(== DEFAULT 或空)→ 自動切;
// 已客製化 → 不動。
//
// SANITY 紀錄(已驗證 2026-05-08):
//   把 options.js 的 `forbiddenTerms = Array.isArray(saved.forbiddenTerms) ? saved.forbiddenTerms
//     : (s.targetLanguage === 'zh-TW' ? ... : []);` 改回 v1.8.59 的
//   `forbiddenTerms = Array.isArray(s.forbiddenTerms) ? s.forbiddenTerms : DEFAULT_FORBIDDEN_TERMS;`
//   → 「target=en 初始 0 列」斷言 fail(會看到 25 列)。還原 → pass。

import { test, expect } from '../fixtures/extension.js';

async function setStorage(context, data) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async (d) => {
    await chrome.storage.sync.set(d);
  }, data);
}

async function clearStorage(context) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
  });
}

test('target=zh-TW + saved 未寫入 → 載入 DEFAULT_FORBIDDEN_TERMS(25 條)', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-TW' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');
  await page.waitForFunction(() => document.querySelectorAll('#forbidden-terms-tbody tr').length > 0, null, { timeout: 5_000 }).catch(() => {});

  const rowCount = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rowCount, 'zh-TW 應載入 25 條預設禁用詞').toBe(25);
});

test('target=en + saved 未寫入 → 表格空(無 25 條中→中對映)', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'en' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');
  await page.waitForTimeout(500); // 等 load() 跑完

  const rowCount = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rowCount, 'en target 不該載入 zh-TW 中→中禁用詞').toBe(0);
});

test('target=zh-CN + saved 未寫入 → 表格空', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-CN' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');
  await page.waitForTimeout(500);

  const rowCount = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rowCount, 'zh-CN target 不該載入禁用詞(zh-CN 不需要禁用中國用語)').toBe(0);
});

test('saved.forbiddenTerms 已寫入(空陣列)→ 即使 target=zh-TW 也保留空表(尊重使用者明確停用)', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-TW', forbiddenTerms: [] });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');
  await page.waitForTimeout(500);

  const rowCount = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rowCount, '使用者明確 saved 空陣列 → 不該被 DEFAULT 覆蓋').toBe(0);
});

// v1.9.16:翻譯目標 picker 已搬到 popup,options 改用 storage.onChanged 監聽。
// 「切 target → 未客製狀態下禁用詞表自動清空」由 popup 寫 storage 觸發 options 內 reapply。
// 這裡測試走「直接寫 storage」模擬 popup 行為(等同 popup.js 內 targetLanguage change handler 結果)。
test('storage targetLanguage zh-TW → en:未客製狀態下 options 內表格自動清空', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-TW' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');
  await page.waitForFunction(() => document.querySelectorAll('#forbidden-terms-tbody tr').length === 25, null, { timeout: 5_000 });

  // 模擬 popup 寫 storage(等同使用者在 popup 切 target picker)
  await setStorage(context, { targetLanguage: 'en' });
  // 等 onChanged listener 觸發 _syncForbiddenTermsToTarget
  await page.waitForFunction(() => document.querySelectorAll('#forbidden-terms-tbody tr').length === 0, null, { timeout: 5_000 });

  const rowCount = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rowCount, '未客製狀態 target → en → 表格清空').toBe(0);
});

test('storage targetLanguage zh-TW → en:已客製化(改了第一筆)時保留使用者編輯', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-TW' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');
  await page.waitForFunction(() => document.querySelectorAll('#forbidden-terms-tbody tr').length === 25, null, { timeout: 5_000 });

  // 切到禁用詞分頁(input 才 visible 可填)
  await page.click('.tab-btn[data-tab="forbidden"]');
  await page.waitForTimeout(100);

  // 改第一筆 forbidden 欄(讓 forbiddenTerms != DEFAULT)
  const firstInput = page.locator('#forbidden-terms-tbody tr:first-child .ft-forbidden');
  await firstInput.fill('我自訂的禁用詞');
  // 觸發 focusout 讓 readForbiddenTableEntries 同步進記憶體(focusout listener 在 tbody 上)
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(100);

  // 模擬 popup 寫 storage 切 en
  await setStorage(context, { targetLanguage: 'en' });
  await page.waitForTimeout(300);

  const rowCount = await page.locator('#forbidden-terms-tbody tr').count();
  const firstVal = await page.locator('#forbidden-terms-tbody tr:first-child .ft-forbidden').inputValue();
  expect(rowCount, '已客製化 target → en → 不清空').toBe(25);
  expect(firstVal, '使用者編輯應保留').toBe('我自訂的禁用詞');
});
