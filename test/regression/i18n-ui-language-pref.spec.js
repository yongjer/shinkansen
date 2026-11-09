// Regression: P2 (v1.8.60) UI 語系偏好 — 獨立於翻譯目標(targetLanguage)。
//
// SPEC §3.10:`settings.uiLanguage` ∈ {'auto', 'zh-TW', 'zh-CN', 'en'},預設 'auto'。
//   - 'auto' → resolveUiLanguage(navigator.language)推導三語其一
//             (zh-TW/HK/Hant → zh-TW;其他 zh → zh-CN;else → en)
//   - 三語其一 → 直接用該值,不受 navigator.language / targetLanguage 影響
//
// 鎖死的不變式(本檔驗證):
//   1. resolveUiLanguage 純函式邏輯(透過 i18n.getUiLanguage 暴露)
//   2. 使用者在 options 改 #uiLanguage 立刻寫 storage(不等「儲存設定」)
//   3. UI 跟 target 解耦:設 uiLanguage='zh-TW' + target='en' → UI 仍繁中
//   4. 預設 'auto'(無 saved.uiLanguage)= 跟 navigator.language(headless chromium=en)
//
// SANITY 紀錄(已驗證 2026-05-08):把 lib/i18n.js getUiLanguage 內 'auto' 分支改回
// `return FALLBACK_LANG;`(不走 navigator.language)→ 「auto + 瀏覽器中文」應走 zh
// 的斷言會 fail(目前 spec 用 default headless en, 看不到 fail);若把 SUPPORTED 比對拿掉
// 「明確 uiLanguage='zh-TW'」斷言也會 fail。本檔有兩條斷言鎖死兩條路徑。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'lang-detect';

async function load(page, localServer) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });
  return await getShinkansenEvaluator(page);
}

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

test('getUiLanguage("auto") + headless chromium → en(navigator.language 推導)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);
  expect(await evaluate(`window.__SK.i18n.getUiLanguage('auto')`)).toBe('en');
  expect(await evaluate(`window.__SK.i18n.getUiLanguage(undefined)`)).toBe('en');
  expect(await evaluate(`window.__SK.i18n.getUiLanguage(null)`)).toBe('en');
});

test('getUiLanguage(三語其一)→ 直接 return,不走 navigator', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);
  expect(await evaluate(`window.__SK.i18n.getUiLanguage('zh-TW')`)).toBe('zh-TW');
  expect(await evaluate(`window.__SK.i18n.getUiLanguage('zh-CN')`)).toBe('zh-CN');
  expect(await evaluate(`window.__SK.i18n.getUiLanguage('en')`)).toBe('en');
});

test('getUiLanguage(8 語 target)→ 直接回該語(P3 / v1.8.62 起 8 語 dict 全到位)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const { evaluate } = await load(page, localServer);
  // ja / ko / es / fr / de 已加入 SUPPORTED_UI_LANGS → 直接回原值;只有不認識的 'xx' 仍 fallback en
  for (const t of ['ja', 'ko', 'es', 'fr', 'de']) {
    expect(await evaluate(`window.__SK.i18n.getUiLanguage(${JSON.stringify(t)})`))
      .toBe(t);
  }
  expect(await evaluate(`window.__SK.i18n.getUiLanguage('xx')`)).toBe('en');
});

test('options:#uiLanguage picker 切換 → 立刻寫 storage(不等「儲存設定」)', async ({ context, extensionId }) => {
  await clearStorage(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');

  // 切 zh-CN → storage.uiLanguage 立刻為 'zh-CN'(不等 save 按鈕)
  await page.selectOption('#uiLanguage', 'zh-CN');
  await page.waitForTimeout(200);
  const sw = context.serviceWorkers()[0];
  const stored = await sw.evaluate(async () => {
    const r = await chrome.storage.sync.get('uiLanguage');
    return r.uiLanguage;
  });
  expect(stored, 'uiLanguage 應立刻寫進 storage').toBe('zh-CN');
});

test('UI / target 解耦:設 uiLanguage=zh-TW + targetLanguage=en → popup UI 仍繁中', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { uiLanguage: 'zh-TW', targetLanguage: 'en' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#translate-btn');
  // popup UI 跟 uiLanguage = zh-TW(不被 target=en 影響)
  await expect(page.locator('#translate-btn')).toHaveText('翻譯本頁');
});

test('UI / target 解耦:設 uiLanguage=en + targetLanguage=zh-TW → popup UI 仍英文', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { uiLanguage: 'en', targetLanguage: 'zh-TW' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#translate-btn');
  await expect(page.locator('#translate-btn')).toHaveText('Translate page');
});

// v1.9.16:翻譯目標 picker 已搬到 popup,options 改用 storage.onChanged 監聽。
// 「切 target 不影響 UI dict」走「直接寫 storage」模擬 popup 行為。
test('UI / target 解耦:切 targetLanguage(經 storage)不會 reapply UI(uiLanguage=zh-TW 鎖定)', async ({ context, extensionId }) => {
  await clearStorage(context);
  await setStorage(context, { uiLanguage: 'zh-TW' });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#tab-settings');
  // sentinel：手動儲存按鈕已移除改自動存檔，改用「介面語言」標題判斷 UI dict 語系
  await expect(page.locator('[data-i18n="options.uiLanguage.heading"]')).toHaveText('介面語言');

  // 模擬 popup 寫 storage 切 target=en → UI 應仍繁中(uiLanguage 鎖死)
  await setStorage(context, { targetLanguage: 'en' });
  await page.waitForTimeout(300);
  await expect(
    page.locator('[data-i18n="options.uiLanguage.heading"]'),
    'target 切換不該改變 UI dict(因為 uiLanguage 已明確鎖到 zh-TW)',
  ).toHaveText('介面語言');
});
