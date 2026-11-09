// Regression: v1.9.16 翻譯目標語言 picker 從 options 搬到 popup。
//
// 行為通則:
//   1. popup 打開時 #targetLanguage 反映 storage.sync.targetLanguage(損壞值走 DEFAULT)
//   2. picker change → 立刻寫 storage.sync.targetLanguage(不需按「儲存」)
//   3. 重開 popup → 新值仍在 picker
//   4. options 不再有 #targetLanguage element(已搬走)
//
// SANITY 紀錄(已驗證 2026-05-14):
//   把 popup.js 的 `$('targetLanguage').addEventListener('change', ...)` handler 整段 comment 掉
//   → 「change 後 storage 應更新」斷言 fail(storage 仍是初始 zh-TW)。還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';

async function setStorage(context, data) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async (d) => {
    await chrome.storage.sync.set(d);
  }, data);
}

async function getStorage(context, key) {
  const sw = context.serviceWorkers()[0];
  return sw.evaluate(async (k) => {
    const r = await chrome.storage.sync.get(k);
    return r[k];
  }, key);
}

async function clearStorage(context) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
  });
}

test('popup #targetLanguage 載入時反映 storage.sync.targetLanguage', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'ja' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#targetLanguage');
  // 等 init() 跑完把 storage 值寫進 picker
  await expect(page.locator('#targetLanguage')).toHaveValue('ja');
});

test('popup #targetLanguage change → 立刻寫 storage.sync.targetLanguage', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-TW' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#targetLanguage');
  await expect(page.locator('#targetLanguage')).toHaveValue('zh-TW');

  await page.selectOption('#targetLanguage', 'en');
  // change handler 是 async,等寫 storage
  await page.waitForFunction(async () => {
    const r = await chrome.storage.sync.get('targetLanguage');
    return r.targetLanguage === 'en';
  }, null, { timeout: 5_000 });

  const stored = await getStorage(context, 'targetLanguage');
  expect(stored, 'storage 應同步成 en').toBe('en');
});

test('options 不再有 #targetLanguage element(已搬到 popup)', async ({ context, extensionId }) => {
  await clearStorage(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');

  const exists = await page.locator('#targetLanguage').count();
  expect(exists, 'options 內不該再有 #targetLanguage element').toBe(0);
});
