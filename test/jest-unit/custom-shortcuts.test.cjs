'use strict';

/**
 * Regression: 自訂快速鍵（in-page recorder + content-shortcuts.js keydown 攔截）
 *
 * 涵蓋三層訊號（CLAUDE.md 工作流原則 §3 明示驗哪層、不驗哪層）：
 *   1. 純函式層（lib/shortcut-utils.js）:eventToShortcut / matches / validate /
 *      shortcutEquals / sanitizeTable 的結構性規則
 *   2. Forcing function 層：MANIFEST_DEFAULTS 鏡像必須與 manifest.json commands 的
 *      suggested_key 逐欄一致（改 manifest 沒同步鏡像 → 這條 fail）
 *   3. 真實路徑層（content-shortcuts.js）：在 jsdom 載入 listener,dispatch 真實
 *      keydown → 驗證命中自訂鍵時呼叫 SK.handleTranslatePreset(slot)、非命中不呼叫、
 *      modifier 嚴格比對、storage.onChanged 改鍵即時生效
 *
 * 不驗（明示 missing 層，避免「綠燈 = 沒問題」誤判）:
 *   - 桌面 manifest 預設鍵（browser 層 onCommand）本身——那條不經 content listener,
 *     由 Chrome / Firefox / Safari 各自處理，本 spec 無法觸發
 *   - options recorder 的 DOM 互動（錄製 / ✕ 清除 / hint 顯示）——屬 options.js,
 *     此處只驗共用的 shortcut-utils 驗證邏輯，recorder UI 互動歸 Playwright / 人眼
 *
 * SANITY 紀錄（已驗證）:
 *   - 把 content-shortcuts.js 的 `SC.matches(e, s)` 改成永遠回 false → 「命中呼叫
 *     handleTranslatePreset」斷言 fail；還原 → pass
 *   - 把 shortcut-utils.js validate 的「拒 ⌘」規則拿掉 → 「⌘ 組合被拒」斷言 fail；還原 → pass
 *   - 把 MANIFEST_DEFAULTS slot 2 的 code 改成 'KeyX' → forcing function 斷言 fail；還原 → pass
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SHINKANSEN_DIR = path.resolve(__dirname, '../../shinkansen');
const SC = require(path.join(SHINKANSEN_DIR, 'lib/shortcut-utils.js'));

// ── 1. 純函式層 ──────────────────────────────────────────
describe('shortcut-utils 純函式', () => {
  test('eventToShortcut：一般鍵回完整物件、純 modifier 回 null', () => {
    expect(SC.eventToShortcut({ code: 'KeyG', altKey: true })).toEqual({
      code: 'KeyG', alt: true, shift: false, ctrl: false, meta: false,
    });
    expect(SC.eventToShortcut({ code: 'AltLeft', altKey: true })).toBeNull();
    expect(SC.eventToShortcut({ code: 'ShiftRight', shiftKey: true })).toBeNull();
    expect(SC.eventToShortcut(null)).toBeNull();
  });

  // macifyCommandShortcut：browser.commands 字串在 Mac 顯示成 ⌥ Option（非 Alt）。
  // popup 快速鍵提示用（Jimmy 回報 macOS popup 顯示 "Alt+S" 該是 "⌥S"）。
  test('macifyCommandShortcut：Mac 轉 Mac 符號、非 Mac 原樣', () => {
    // Mac：Alt → ⌥、去掉 +
    expect(SC.macifyCommandShortcut('Alt+S', true)).toBe('⌥S');
    expect(SC.macifyCommandShortcut('Command+S', true)).toBe('⌘S');
    expect(SC.macifyCommandShortcut('Ctrl+Shift+S', true)).toBe('⌃⇧S');
    // Mac：已是符號（Chrome macOS）→ 不變
    expect(SC.macifyCommandShortcut('⌥S', true)).toBe('⌥S');
    // 非 Mac（Windows / Linux）：Alt 就是 Alt，原樣
    expect(SC.macifyCommandShortcut('Alt+S', false)).toBe('Alt+S');
    // 空 / 非字串安全
    expect(SC.macifyCommandShortcut('', true)).toBe('');
    expect(SC.macifyCommandShortcut(undefined, true)).toBe('');
  });

  test('matches：modifier 全欄位嚴格比對（⌥G 不命中 ⌥⇧G）', () => {
    const s = { code: 'KeyG', alt: true, shift: false, ctrl: false, meta: false };
    expect(SC.matches({ code: 'KeyG', altKey: true }, s)).toBe(true);
    expect(SC.matches({ code: 'KeyG', altKey: true, shiftKey: true }, s)).toBe(false);
    expect(SC.matches({ code: 'KeyH', altKey: true }, s)).toBe(false);
    expect(SC.matches({ code: 'KeyG', ctrlKey: true }, s)).toBe(false);
  });

  // 非 Safari（Chrome / Firefox,不傳 requireCtrl）：⌥ / ⌃ / ⌘ 皆可
  test('validate：結構性規則（非 Safari = Chrome）', () => {
    // 拒單鍵 / 只加 shift（必含 ⌥ 或 ⌃ 或 ⌘）
    expect(SC.validate({ code: 'KeyG' }).ok).toBe(false);
    expect(SC.validate({ code: 'KeyG', shift: true }).reason).toBe('shortcut.invalid.needMod');
    // 拒 ESC
    expect(SC.validate({ code: 'Escape', alt: true }).reason).toBe('shortcut.invalid.esc');
    // 拒與內建預設鍵相同（⌥S = slot 2 主要預設）
    const def = SC.validate({ code: 'KeyS', alt: true });
    expect(def.ok).toBe(false);
    expect(def.reason).toBe('shortcut.invalid.isDefault');
    // 合法：⌥ / ⌃ / ⌘ 皆可（Chrome 接受 ⌘——產品需求,雖多數 ⌘ 組合會被瀏覽器攔）
    expect(SC.validate({ code: 'KeyG', alt: true }).ok).toBe(true);
    expect(SC.validate({ code: 'KeyG', ctrl: true }).ok).toBe(true);
    expect(SC.validate({ code: 'KeyG', meta: true }).ok).toBe(true);
  });

  // Safari（Mac / iPad / iPhone,requireCtrl=true）：⌥／⌘ 不傳給網頁,必含 ⌃。
  // 真機 probe 實證:iPad 按 ⌥+鍵／⌘+鍵 網頁完全收不到 keydown,只有 ⌃ 收得到。
  test('validate requireCtrl（Safari）：⌥-only / ⌘-only 擋下、⌃ 放行', () => {
    expect(SC.validate({ code: 'KeyG', alt: true }, { requireCtrl: true }).reason)
      .toBe('shortcut.invalid.safariNeedCtrl');
    expect(SC.validate({ code: 'KeyG', meta: true }, { requireCtrl: true }).reason)
      .toBe('shortcut.invalid.safariNeedCtrl');
    expect(SC.validate({ code: 'KeyG', ctrl: true }, { requireCtrl: true }).ok).toBe(true);
    // ⌃⌥ 並用也放行（有 ⌃ 即可）
    expect(SC.validate({ code: 'KeyG', ctrl: true, alt: true }, { requireCtrl: true }).ok).toBe(true);
    // 非 Safari（不傳 opts）⌥-only 仍合法
    expect(SC.validate({ code: 'KeyG', alt: true }).ok).toBe(true);
  });

  test('sanitizeTable：三 slot 都在、髒值折回 null', () => {
    const t = SC.sanitizeTable({
      2: { code: 'KeyG', alt: true },
      1: { code: 123 },          // code 非字串 → null
      3: 'garbage',              // 非物件 → null
    });
    expect(t[2]).toEqual({ code: 'KeyG', alt: true, shift: false, ctrl: false, meta: false });
    expect(t[1]).toBeNull();
    expect(t[3]).toBeNull();
    // 缺整張表 → 三 slot 全 null
    expect(SC.sanitizeTable(null)).toEqual({ 2: null, 1: null, 3: null });
  });
});

// ── 2. Forcing function:MANIFEST_DEFAULTS 鏡像 vs manifest.json ──
describe('MANIFEST_DEFAULTS 與 manifest.json commands 同步', () => {
  // command id → storage slot（與 background.js COMMAND_ID_TO_SLOT 一致）
  const COMMAND_ID_TO_SLOT = { 0: 2, 1: 1, 3: 3 };

  // "Alt+S" / "Alt+Shift+S" / "Ctrl+Alt+S" → shortcut 物件
  function parseSuggested(str) {
    const parts = str.split('+');
    const key = parts.pop();
    const mods = new Set(parts);
    let code = null;
    if (/^[A-Z]$/.test(key)) code = 'Key' + key;
    else if (/^[0-9]$/.test(key)) code = 'Digit' + key;
    else code = key;
    return {
      code,
      alt: mods.has('Alt') || mods.has('Option'),
      shift: mods.has('Shift'),
      ctrl: mods.has('Ctrl') || mods.has('MacCtrl') || mods.has('Control'),
      meta: mods.has('Command') || mods.has('Meta'),
    };
  }

  test('每組 manifest suggested_key 與鏡像逐欄一致', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(SHINKANSEN_DIR, 'manifest.json'), 'utf-8'));
    const commands = manifest.commands || {};
    for (const [name, def] of Object.entries(commands)) {
      const m = /^translate-preset-(\d+)$/.exec(name);
      if (!m) continue;
      const slot = COMMAND_ID_TO_SLOT[Number(m[1])];
      expect(slot).toBeTruthy();
      const suggested = def.suggested_key?.mac || def.suggested_key?.default;
      const parsed = parseSuggested(suggested);
      expect({ slot, ...SC.MANIFEST_DEFAULTS[slot] }).toEqual({ slot, ...parsed });
    }
  });
});

// ── 3. 真實路徑：content-shortcuts.js keydown 攔截 ──────────
describe('content-shortcuts.js keydown → 本地 dispatch', () => {
  let dom, win, handleTranslatePreset, onChangedHandler, storageValues;

  function loadEnv(customShortcuts) {
    storageValues = { customShortcuts };
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://example.com/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    win = dom.window;
    handleTranslatePreset = jest.fn();
    onChangedHandler = null;
    win.browser = {
      storage: {
        sync: { get: () => Promise.resolve(storageValues) },
        onChanged: { addListener: (fn) => { onChangedHandler = fn; } },
      },
    };
    win.__SK = { handleTranslatePreset, sendLog: () => {} };
    // 載入順序與 manifest 一致：shortcut-utils 先（掛 window.__SKShortcuts），再 content-shortcuts
    win.eval(fs.readFileSync(path.join(SHINKANSEN_DIR, 'lib/shortcut-utils.js'), 'utf-8'));
    win.eval(fs.readFileSync(path.join(SHINKANSEN_DIR, 'content-shortcuts.js'), 'utf-8'));
  }

  // jsdom 沒有原生 ⌥ dead-key，直接派 KeyboardEvent 帶 code + modifier
  function press(code, { alt = false, shift = false, ctrl = false, meta = false } = {}) {
    win.dispatchEvent(new win.KeyboardEvent('keydown', {
      code, altKey: alt, shiftKey: shift, ctrlKey: ctrl, metaKey: meta,
      bubbles: true, cancelable: true,
    }));
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  test('命中自訂鍵 → 呼叫 handleTranslatePreset(slot)', async () => {
    loadEnv({ 2: { code: 'KeyG', alt: true }, 1: null, 3: null });
    await tick(); // 等 storage.get 載入 table
    press('KeyG', { alt: true });
    expect(handleTranslatePreset).toHaveBeenCalledTimes(1);
    expect(handleTranslatePreset).toHaveBeenCalledWith(2);
  });

  test('table 載入前（race）keydown 全放行，不誤觸發', () => {
    loadEnv({ 2: { code: 'KeyG', alt: true }, 1: null, 3: null });
    // 不等 tick:table 還是 null
    press('KeyG', { alt: true });
    expect(handleTranslatePreset).not.toHaveBeenCalled();
  });

  test('modifier 不符 → 不觸發（⌥⇧G 不命中 ⌥G）', async () => {
    loadEnv({ 2: { code: 'KeyG', alt: true }, 1: null, 3: null });
    await tick();
    press('KeyG', { alt: true, shift: true });
    press('KeyG', {}); // 無 modifier
    press('KeyH', { alt: true }); // 別的鍵
    expect(handleTranslatePreset).not.toHaveBeenCalled();
  });

  test('manifest 預設鍵（⌥S）不經 content listener（custom 表沒設時不觸發）', async () => {
    loadEnv({ 2: null, 1: null, 3: null }); // 全沿用預設，custom 表空
    await tick();
    press('KeyS', { alt: true }); // 桌面由 browser onCommand 處理，content listener 應 no-op
    expect(handleTranslatePreset).not.toHaveBeenCalled();
  });

  // macOS Safari 把 ⌥+字母 當特殊字元組字 → keydown 回報 keyCode 229。
  // 含 ⌥/⌃ 時不可套 IME guard,否則 Safari 上所有 ⌥ 自訂鍵永遠觸發不了
  // （Chrome 正常、Safari 全壞的真因）。
  test('macOS Safari：⌥+字母 keyCode 229（Safari 視為組字）仍觸發', async () => {
    loadEnv({ 2: { code: 'KeyG', alt: true }, 1: null, 3: null });
    await tick();
    win.dispatchEvent(new win.KeyboardEvent('keydown', {
      code: 'KeyG', altKey: true, keyCode: 229, bubbles: true, cancelable: true,
    }));
    expect(handleTranslatePreset).toHaveBeenCalledWith(2);
  });

  // 真正的 CJK IME 組字（keyCode 229、無 ⌥/⌃）仍跳過——不誤觸發。
  test('真正 IME 組字（keyCode 229、無修飾鍵）仍跳過', async () => {
    // 設一組無修飾鍵理論上不可能（validate 擋掉），但模擬「listener 收到組字事件」:
    // 用 alt:false 的表項不會 match,且 IME guard 對無修飾鍵仍生效 → 不進比對迴圈。
    loadEnv({ 2: { code: 'KeyG', alt: true }, 1: null, 3: null });
    await tick();
    win.dispatchEvent(new win.KeyboardEvent('keydown', {
      code: 'KeyG', keyCode: 229, bubbles: true, cancelable: true,
    }));
    expect(handleTranslatePreset).not.toHaveBeenCalled();
  });

  test('storage.onChanged 改鍵即時生效（不必 reload）', async () => {
    loadEnv({ 2: { code: 'KeyG', alt: true }, 1: null, 3: null });
    await tick();
    // 改成 slot 1 = ⌃J
    onChangedHandler(
      { customShortcuts: { newValue: { 2: null, 1: { code: 'KeyJ', ctrl: true }, 3: null } } },
      'sync',
    );
    press('KeyG', { alt: true }); // 舊鍵已失效
    press('KeyJ', { ctrl: true }); // 新鍵
    expect(handleTranslatePreset).toHaveBeenCalledTimes(1);
    expect(handleTranslatePreset).toHaveBeenCalledWith(1);
  });
});
