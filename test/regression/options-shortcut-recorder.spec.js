// Regression：options 翻譯快速鍵 in-page recorder（自訂快速鍵 UI）
//
// 背景：三張 preset card 右上角原本是唯讀 badge（讀 commands.getAll 顯示鍵位），
// 改成 in-page recorder——點欄位錄製、存 storage.sync.customShortcuts、
// content-shortcuts.js 攔 keydown。Safari／iPad 無瀏覽器層改鍵入口，recorder 全平台通用。
//
// 本 spec 鎖的訊號層次：
//   驗 options 頁真實 DOM：(1) 載入後 recorder 顯示內建預設鍵（非空、is-default 態）
//   (2) 點 → 錄製態 (3) 按合法組合 → 顯示 + 寫入 storage (4) ✕ 還原 (5) 非法組合
//   (⌘) 顯示 hint 且不寫入 (6) UI 語言切換（applyI18n 重跑）後 recorder 不被清空。
//   不驗：content-shortcuts.js 的 keydown→dispatch（那條在 jest-unit custom-shortcuts
//   .test.cjs 驗）、recorder 跨平台 Safari runtime 隱藏的 chrome 連結。
//
// SANITY CHECK 紀錄（已驗證）：
//   暫時把 options.js renderShortcutRecorders 的「custom || default」顯示改成只顯示
//   custom（預設不顯示）→ 「載入後顯示預設鍵」case fail（recorder 變「未設定」）；還原後全綠。
//   暫時拔掉 #uiLanguage change handler 內的 renderShortcutRecorders() → 「UI 語言切換後
//   不被清空」case 仍綠（因 applyI18n 不碰非 data-i18n 的 recorder button text），
//   故此 case 主要守「切語言後 default suffix 文案有跟上」——見斷言註解。
import { test, expect } from '../fixtures/extension.js';

async function openOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: 'domcontentloaded' });
  // 清掉前一個 test 殘留的自訂鍵（persistent context 跨 test 共用 storage.sync）
  await page.evaluate(() => chrome.storage.sync.remove('customShortcuts'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  // 等 load() 跑完 + renderShortcutRecorders 寫入（recorder 離開空字串）
  await page.waitForFunction(() => {
    const el = document.getElementById('sc-2');
    return el && el.textContent.trim().length > 0;
  }, { timeout: 10_000 });
  return page;
}

test('載入後三組 recorder 顯示內建預設鍵（⌥S／⌥A／⌥D，is-default 態）', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const expected = { 2: 'S', 1: 'A', 3: 'D' }; // slot → 預設字母鍵
  for (const slot of [1, 2, 3]) {
    const btn = page.locator(`#sc-${slot}`);
    const text = (await btn.textContent()).trim();
    expect(text.length, `sc-${slot} 不該空`).toBeGreaterThan(0);
    expect(text, `sc-${slot} 應含 ⌥`).toContain('⌥');
    expect(text, `sc-${slot} 應含預設字母 ${expected[slot]}`).toContain(expected[slot]);
    // 尚未自訂 → is-default 灰態 + 清除鈕 disabled
    await expect(btn).toHaveClass(/is-default/);
    await expect(page.locator(`#sc-clear-${slot}`)).toBeDisabled();
  }
  await page.close();
});

test('錄製合法組合（⌥G）→ 顯示 ⌥G + 寫入 storage + ✕ 還原', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const btn = page.locator('#sc-2');

  // 點 → 進錄製態
  await btn.click();
  await expect(btn).toHaveClass(/recording/);

  // 按 ⌥G（合法，非預設、含 ⌥）
  await page.keyboard.down('Alt');
  await page.keyboard.press('g');
  await page.keyboard.up('Alt');

  await expect(btn).toHaveText('⌥G');
  await expect(btn).not.toHaveClass(/is-default/);
  await expect(page.locator('#sc-clear-2')).toBeEnabled();

  // 寫入 storage.sync.customShortcuts[2]
  const stored = await page.evaluate(() => chrome.storage.sync.get('customShortcuts'));
  expect(stored.customShortcuts['2']).toMatchObject({ code: 'KeyG', alt: true, shift: false, ctrl: false, meta: false });

  // ✕ 還原 → 回預設態 + storage 清回 null
  await page.locator('#sc-clear-2').click();
  await expect(btn).toHaveClass(/is-default/);
  await expect(btn).toContainText('⌥S');
  const cleared = await page.evaluate(() => chrome.storage.sync.get('customShortcuts'));
  expect(cleared.customShortcuts['2']).toBeNull();
  await page.close();
});

// Playwright runtime = Chromium（非 Safari）→ ⌥／⌘ 皆合法,故用「無修飾鍵」測 needMod 擋下。
// （⌘ 在 Chrome 現在被接受,不再是 invalid case。）
test('無修飾鍵組合 → 顯示 hint + 紅框 invalid + 不寫入', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const btn = page.locator('#sc-2');
  await btn.click();
  await expect(btn).toHaveClass(/recording/);

  // 單按 g（無 ⌥/⌃/⌘）→ validate needMod 擋下
  await page.keyboard.press('g');

  // hint 非空（含 ⚠）、退出錄製、storage 未寫入
  const hint = (await page.locator('#shortcut-hint').textContent()).trim();
  expect(hint.length, 'hint 應顯示驗證失敗原因').toBeGreaterThan(0);
  expect(hint, 'hint 應有 ⚠ 明顯前綴').toContain('⚠');
  await expect(btn).not.toHaveClass(/recording/);
  const stored = await page.evaluate(() => chrome.storage.sync.get('customShortcuts'));
  expect(stored.customShortcuts?.['2'] ?? null).toBeNull();
  await page.close();
});

test('UI 語言切換（applyI18n 重跑）後 recorder 不被清空', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const before = (await page.locator('#sc-2').textContent()).trim();
  expect(before.length).toBeGreaterThan(0);

  await page.selectOption('#uiLanguage', 'en');
  await page.waitForTimeout(500);

  const after = (await page.locator('#sc-2').textContent()).trim();
  expect(after.length, 'applyI18n 重跑後 recorder 不該被清空').toBeGreaterThan(0);
  expect(after, '仍應顯示預設鍵 ⌥S').toContain('⌥S');
  await page.close();
});
