// Regression: options forbiddenTerms「未客製不物化」(對應 SPEC-PRIVATE §29.1-3,
// dev tail 2.0.9.1 修，2026-07-09)
//
// Bug:options 任一 autosave 都把整包 settings(含禁用詞表)寫進 storage.sync ——
//   即使使用者從沒碰過該表，預設 25 條也被「物化」寫死。一旦寫入，getSettings
//  「未寫入才依 target 給預設」永遠走不到：切 target 到 en/zh-CN 後 prompt 仍帶
//   zh-TW 替換規則、預設表未來更新使用者也吃不到。另 target 切換 listener 只改 UI
//   不寫 storage(desync)。
// 修法(options.js):
//   1. isForbiddenTermsDefaultFor(terms, tl, defaults) target-aware 未客製判斷
//      (zh-TW 空表 = 刻意停用 = 已客製；非 zh-TW 空表 = 預設)
//   2. save()：判定未客製 → 不寫 key + storage.sync.remove 回收既有物化殘留
//   3. _syncForbiddenTermsToTarget(newTl, oldTl)：以「舊 target 預設」判未客製，
//      未客製時同步 remove key(修 desync + 立即回收)
//
// 本 spec 鎖的訊號層：真 options 頁 + 真 chrome.storage.sync，驗「autosave 後 storage
//   實際 key 狀態」與「target 切換後 UI 表格 + storage 狀態」。不驗翻譯 runtime 拿
//   settings 後的 prompt 組裝層(getSettings fallback 邏輯由既有
//   i18n-forbidden-target-aware.spec.js 鎖)。
//
// SANITY 紀錄(已驗證，2026-07-09):
//   ① 把 save() 的「未客製 → delete key + remove」區塊註解掉 → case 1(不物化)與
//      case 2(殘留回收)fail(storage 出現 / 殘留 forbiddenTerms key)。還原 → pass。
//   ② 把 _syncForbiddenTermsToTarget 判斷改用 newTl(拿掉 oldTl 參數語意)→ case 5
//      fail(en→zh-TW 空表被誤判「zh-TW 刻意停用」不給預設，rows 停在 0)。還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { DEFAULT_FORBIDDEN_TERMS } from '../../shinkansen/lib/storage.js';

async function getSw(context) {
  return context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
}
async function setStorage(context, data) {
  const sw = await getSw(context);
  await sw.evaluate(async (d) => { await chrome.storage.sync.set(d); }, data);
}
async function clearStorage(context) {
  const sw = await getSw(context);
  await sw.evaluate(async () => { await chrome.storage.sync.clear(); });
}
async function getSyncStorage(context) {
  const sw = await getSw(context);
  return sw.evaluate(async () => await chrome.storage.sync.get(null));
}

// 觸發一次「跟禁用詞無關」的 autosave：改 Gemini service tier(tab 層級 delegated
// change → markDirty → 600ms debounce → save())。#serviceTier 在非作用中分頁
// (display:none)無法用 selectOption 點，改 JS 設值 + dispatch change(bubbles 照樣
// 到達 delegated listener，與真實使用者改值走同一條 markDirty 路徑)
async function triggerUnrelatedAutosave(page) {
  await page.evaluate(() => {
    const el = document.getElementById('serviceTier');
    el.value = 'FLEX';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1500); // 600ms debounce + save 寫入餘裕
}

async function openOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');
  await page.waitForTimeout(500); // 等 load() 跑完
  return page;
}

test('case 1: zh-TW 未客製 → 無關設定 autosave 後 storage 不出現 forbiddenTerms key', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-TW' });
  const page = await openOptions(context, extensionId);

  // 表格顯示預設(UI 正常)，但 autosave 不得把它物化進 storage
  const rows = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rows, '前置：zh-TW 未客製應顯示預設清單').toBe(DEFAULT_FORBIDDEN_TERMS.length);

  await triggerUnrelatedAutosave(page);
  const stored = await getSyncStorage(context);
  expect(stored.geminiConfig?.serviceTier, '前置：autosave 確實有發生').toBe('FLEX');
  expect('forbiddenTerms' in stored, '未客製的預設表不得被 autosave 物化寫入 storage').toBe(false);
  await page.close();
});

test('case 2: 既有物化殘留(target=en + 預設 25 條)→ autosave 時回收移除', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, {
    targetLanguage: 'en',
    forbiddenTerms: DEFAULT_FORBIDDEN_TERMS.map(t => ({ ...t })),
  });
  const page = await openOptions(context, extensionId);

  await triggerUnrelatedAutosave(page);
  const stored = await getSyncStorage(context);
  expect('forbiddenTerms' in stored, '等於預設的物化殘留應在 autosave 時被回收(remove)').toBe(false);
  await page.close();
});

test('case 3: zh-TW 刻意清空(停用黑名單)→ autosave 後空表保留，不被回收也不被填回預設', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-TW', forbiddenTerms: [] });
  const page = await openOptions(context, extensionId);

  const rows = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rows, '前置：停用狀態表格應為空').toBe(0);

  await triggerUnrelatedAutosave(page);
  const stored = await getSyncStorage(context);
  expect(Array.isArray(stored.forbiddenTerms), 'zh-TW 空表(停用)必須仍寫入 storage').toBe(true);
  expect(stored.forbiddenTerms.length, '停用空表不得被填回預設').toBe(0);
  await page.close();
});

test('case 4: 使用者客製內容 → autosave 照寫進 storage', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'zh-TW' });
  const page = await openOptions(context, extensionId);

  // 改第一列替換詞(input 事件走 tab 層級 delegated markDirty；表格在非作用中分頁，
  // 同 triggerUnrelatedAutosave 用 JS 設值 + dispatch)
  await page.evaluate(() => {
    const input = document.querySelector('#forbidden-terms-tbody tr:first-child .ft-replacement');
    input.value = '客製替換詞';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1500);

  const stored = await getSyncStorage(context);
  expect(Array.isArray(stored.forbiddenTerms), '客製後必須寫入 storage').toBe(true);
  expect(
    stored.forbiddenTerms.some(t => t.replacement === '客製替換詞'),
    '客製的替換詞必須在寫入內容中',
  ).toBe(true);
  await page.close();
});

test('case 5: popup 切 target(en→zh-TW，未客製)→ 表格切成預設清單且 storage 無 key(desync 修復)', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { targetLanguage: 'en' });
  const page = await openOptions(context, extensionId);

  const rowsBefore = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rowsBefore, '前置：en 未客製表格為空').toBe(0);

  // 模擬 popup 寫 targetLanguage → options 的 storage.onChanged listener 反應
  await setStorage(context, { targetLanguage: 'zh-TW' });
  await page.waitForTimeout(800);

  const rowsAfter = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rowsAfter, 'en→zh-TW 未客製(舊 target 空表=預設)應切成預設清單').toBe(DEFAULT_FORBIDDEN_TERMS.length);
  const stored = await getSyncStorage(context);
  expect('forbiddenTerms' in stored, '未客製切 target 不得物化，storage 應無 key').toBe(false);
  await page.close();
});

test('case 6: 物化殘留(zh-TW + 預設 25 條)→ popup 切到 en，表格清空且殘留 key 被回收', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, {
    targetLanguage: 'zh-TW',
    forbiddenTerms: DEFAULT_FORBIDDEN_TERMS.map(t => ({ ...t })),
  });
  const page = await openOptions(context, extensionId);

  await setStorage(context, { targetLanguage: 'en' });
  await page.waitForTimeout(800);

  const rowsAfter = await page.locator('#forbidden-terms-tbody tr').count();
  expect(rowsAfter, 'zh-TW→en 未客製(等於預設)應清空表格').toBe(0);
  const stored = await getSyncStorage(context);
  expect('forbiddenTerms' in stored, '切 target 時物化殘留應被回收(remove)').toBe(false);
  await page.close();
});
