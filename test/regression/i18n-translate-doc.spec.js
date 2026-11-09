// Regression: v1.8.64 translate-doc UI i18n — PDF 文件翻譯 reader 介面 i18n 化
//
// 涵蓋:
//   1. translate-doc/index.html 載入後 data-i18n 元素被 applyI18n 替換成 dict 值
//   2. 切 uiLanguage → reader UI 即時 reapply(subscribeUiLanguageChange callback)
//   3. data-i18n-attr-* / data-i18n-html 兩種 hook 都有效
//
// SANITY 紀錄(已驗證):把 translate-doc/index.js 的 initI18n() 整段 await applyI18n
//   call 註解 → 切 uiLanguage 後文字仍維持 zh-TW 預設,「切 en → 文字英文」斷言 fail。

import { test, expect } from '../fixtures/extension.js';

async function setUi(context, ui) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async (u) => {
    await chrome.storage.sync.set({ uiLanguage: u });
  }, ui);
}

test('translate-doc index.html 依 uiLanguage 載入對應 dict', async ({ context, extensionId }) => {
  await setUi(context, 'zh-TW');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`);
  await page.waitForSelector('[data-i18n="doc.header"]');

  // zh-TW 載入確認
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('翻譯文件（beta）');
  await expect(page.locator('[data-i18n="doc.upload.dropzone.title"]')).toHaveText('拖放文件至此');
  await expect(page.locator('[data-i18n="doc.upload.constraint.value"]')).toHaveText('PDF 50 頁 / 10 MB・EPUB 100 MB');

  // 切 en → 文字立即更新
  await setUi(context, 'en');
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('Translate Document (beta)');
  await expect(page.locator('[data-i18n="doc.upload.dropzone.title"]')).toHaveText('Drop a document here');

  // 切 ja → 同樣 reapply
  await setUi(context, 'ja');
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('文書を翻訳（beta）');
  await expect(page.locator('[data-i18n="doc.upload.dropzone.title"]')).toHaveText('ここに文書をドロップ');

  await page.close();
});

test('translate-doc data-i18n-attr-* / data-i18n-html 正確 apply', async ({ context, extensionId }) => {
  await setUi(context, 'en');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`);
  await page.waitForSelector('[data-i18n="doc.header"]');
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('Translate Document (beta)');

  // data-i18n-attr-aria-label(dropzone)
  const aria = await page.locator('#dropzone').getAttribute('aria-label');
  expect(aria).toBe('Drop or pick a document');

  // data-i18n-attr-title(button title)
  const title = await page.locator('#extract-glossary-btn').getAttribute('title');
  expect(title).toContain('glossary');

  // data-i18n-html(edit help 段含 <strong> / <code>)。v2.0.11 起 EPUB 預覽提示
  // 也用 .edit-help class(純 data-i18n),鎖 [data-i18n-html] 屬性選對象
  const editHelp = await page.locator('.edit-help[data-i18n-html]').first().innerHTML();
  expect(editHelp).toContain('<strong>');
  expect(editHelp.toLowerCase()).toContain('bold');

  await page.close();
});

test('translate-doc preset modal 動態 t() 字串依 uiLanguage 切(SK.STATE.uiLanguage 修補)', async ({ context, extensionId }) => {
  // Regression(v1.8.64 內部 hotfix):initI18n 沒寫 window.__SK.STATE.uiLanguage,
  // 動態 t() 呼叫(例 PRESET_DISPLAY 的 main / alt 名)走 _readCurrentTarget fallback
  // 'zh-TW' → 在 en UI 仍顯示「主要預設」。修法:initI18n 同步寫 STATE.uiLanguage,
  // subscribe callback 也更新。本 spec 鎖死此行為。
  await setUi(context, 'en');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`);
  await page.waitForSelector('[data-i18n="doc.header"]');
  // 等 initI18n 跑完(applyI18n 把 doc.header 換成 en)
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('Translate Document (beta)');

  // 點「Translation settings」開 modal,觀察 preset 名稱
  // 觸發 openSettingsDialog:其透過 openSettingsDialog -> renderPresetList 動態 t() 名
  await page.evaluate(() => {
    document.getElementById('translate-settings-dialog').showModal();
  });
  // 直接呼叫 module 內的 openSettingsDialog 比較難(沒 export),改驗 i18n.t 自身
  // 用 SK.STATE.uiLanguage 推導(這是 fix 點)
  const dynamicResult = await page.evaluate(() => {
    return {
      stateLang: window.__SK?.STATE?.uiLanguage,
      mainPresetName: window.__SK.i18n.t('doc.settings.preset.main'),
      altPreset2Name: window.__SK.i18n.t('doc.settings.preset.alt', { n: 2 }),
    };
  });
  expect(dynamicResult.stateLang, 'initI18n 應寫 SK.STATE.uiLanguage').toBe('en');
  expect(dynamicResult.mainPresetName, '動態 t() 應走 en dict').toBe('Main preset');
  expect(dynamicResult.altPreset2Name).toBe('Preset 2');

  // 切 ja → STATE 更新 + t() 跟著切
  await setUi(context, 'ja');
  // wait for subscribe callback to fire
  await expect.poll(async () => {
    return await page.evaluate(() => window.__SK?.STATE?.uiLanguage);
  }).toBe('ja');
  const afterSwitch = await page.evaluate(() => {
    return {
      mainPresetName: window.__SK.i18n.t('doc.settings.preset.main'),
    };
  });
  expect(afterSwitch.mainPresetName, '切 ja 後動態 t() 應走 ja dict').toBe('メイン preset');

  await page.close();
});

test('translate-doc settings.html 依 uiLanguage 載入對應 dict', async ({ context, extensionId }) => {
  await setUi(context, 'zh-TW');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/settings.html`);
  await page.waitForSelector('h1 span[data-i18n="doc.settingsPage.title"]');

  await expect(page.locator('h1 [data-i18n="doc.settingsPage.title"]')).toHaveText('文件翻譯設定');
  await expect(page.locator('[data-i18n="doc.settingsPage.section.quality.title"]')).toHaveText('翻譯品質');

  // 切 ko → reapply
  await setUi(context, 'ko');
  await expect(page.locator('h1 [data-i18n="doc.settingsPage.title"]')).toHaveText('문서 번역 설정');
  await expect(page.locator('[data-i18n="doc.settingsPage.section.quality.title"]')).toHaveText('번역 품질');

  await page.close();
});
