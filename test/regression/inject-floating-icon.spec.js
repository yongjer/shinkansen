// Regression: inject-floating-icon（懸浮翻譯控制按鈕的接線正確性）
//
// Fixture: test/regression/fixtures/floating-icon.html
// 結構：最小頁面，懸浮 icon 不依賴頁面 DOM，只要 content script 注入即建立
//   SK._floating（Shadow DOM host + pointer 狀態機）。
//
// 驗的是「接線正確」這一層（content script isolated world 真實注入後）：
//   1. 短按 = popupButtonSlot 對應 preset（單一資料源，與 popup 工具列按鈕同 key）
//   2. 長按選單由 translatePresets / DEFAULT_PRESETS 建出三列，slot 1/2/3，點任一列
//      路由到對應 slot 並收選單
//   3. resolveEnabled：非 boolean（未設過）→ 一律預設開啟（不分平台），明確
//      設過則尊重 boolean 值
// 不驗：pointer 事件實體手勢消歧（門檻計時）/ 拖移吸附的視覺座標（那層需實機，
//   harness pointer 模擬與真機觸控時序不同）。
//
// SANITY 紀錄（已驗證）：把 handleShortPress 內 `slot = pickPopupSlot(popupButtonSlot)`
//   暫時改成寫死 `slot = 2` → 「短按路由到 popupButtonSlot=3」斷言 fail（收到 2）→
//   還原 → pass。另把 buildMenu 的 `[1,2,3].map` 暫改成 `[1,2]` → 「選單三列」斷言
//   fail（只 2 列）→ 還原 → pass。
// SANITY 紀錄（大小 / 選單透明度，已驗證）：把 applySize 的 `iconSize = (v===16||v===24||v===32)?v:24`
//   暫改成永遠 16 → 「大小切換」medium/large.icon 斷言 fail（收到 16）→ 還原 → pass。
//   把 openMenu 的 `host.style.opacity='1'` 暫拿掉 → 「長按選單期間降透明度」
//   menuShown 斷言 fail（收到 0.5）→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'floating-icon';

// 列印 / 存 PDF 隱藏懸浮按鈕（對應 v2.0.2 修的「Google 試算表列印印出懸浮按鈕」bug）。
// host 是 position:fixed 元素，沒 @media print 規則會被印進輸出。修法在 Shadow DOM
// stylesheet 加 `@media print { :host { display:none !important } }`（!important 蓋 inline
// display:block）。用 page.emulateMedia 切 print media，驗 host computed display 變 none、
// 切回 screen 還原成 block（不影響正常顯示）。
//
// SANITY 紀錄（已驗證）：把 content-floating-icon.js CSS 內
//   `@media print { :host { display: none !important; } }` 暫拿掉 → printDisplay 斷言
//   fail（print media 下仍是 block）→ 還原 → pass。
test('floating icon: 列印 / 存 PDF 時隱藏（@media print），正常顯示不受影響', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK._floating.applyEnabled(true)`); // 桌面 build 預設關，先開啟

  const readDisplay = () => evaluate(`getComputedStyle(window.__SK._floating.host).display`);

  await page.emulateMedia({ media: 'screen' });
  expect(await readDisplay()).toBe('block'); // 螢幕上正常顯示

  await page.emulateMedia({ media: 'print' });
  expect(await readDisplay()).toBe('none');  // 列印時隱藏，不印進輸出

  await page.emulateMedia({ media: 'screen' });
  expect(await readDisplay()).toBe('block'); // 列印完還原顯示

  await page.close();
});

test('floating icon: 短按走 popupButtonSlot、長按選單三列路由正確、平台預設分流', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // content script 注入後 SK._floating 應存在（top frame 才建立）
  const hasFloating = await evaluate(`typeof window.__SK._floating === 'object' && !!window.__SK._floating`);
  expect(hasFloating).toBe(true);

  // (3) resolveEnabled：未設過（非 boolean）→ 一律預設開啟（不分平台）
  const resolved = await evaluate(`(() => {
    const f = window.__SK._floating;
    return {
      iosBuild: window.__SK.IS_IOS_BUILD === true,
      whenUnset: f.resolveEnabled(undefined),
      whenNull: f.resolveEnabled(null),
      whenTrue: f.resolveEnabled(true),
      whenFalse: f.resolveEnabled(false),
    };
  })()`);
  expect(resolved.iosBuild).toBe(false);          // 測試載入的是桌面 build
  expect(resolved.whenUnset).toBe(true);          // 未設過 → 一律預設開啟
  expect(resolved.whenNull).toBe(true);
  expect(resolved.whenTrue).toBe(true);           // 明確設過 → 尊重設定
  expect(resolved.whenFalse).toBe(false);

  // (1) 短按路由：popupButtonSlot=3 → handleTranslatePreset(3)
  const shortPress = await evaluate(`(async () => {
    const f = window.__SK._floating;
    await browser.storage.sync.set({ popupButtonSlot: 3 });
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot) => { calls.push(slot); };
    try {
      await f.handleShortPress();
    } finally {
      window.__SK.handleTranslatePreset = orig;
    }
    return calls;
  })()`);
  expect(shortPress).toEqual([3]);

  // 短按冷卻（2026-07-08）：400ms 內的第二次短按被忽略（快速連點第二下會被 toggle
  // 語意解讀成 abort，體感「按了沒反應」——同 popup v1.8.20 雙擊防護語意）。
  // 單一 evaluate 內連按兩次，避免跨 CDP 呼叫的時間差造成 flaky
  const rapidDoublePress = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f._resetShortPressCooldown();
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot) => { calls.push(slot); };
    try {
      await f.handleShortPress();
      await f.handleShortPress(); // 緊接第二次 → 冷卻擋下
    } finally {
      window.__SK.handleTranslatePreset = orig;
    }
    return calls;
  })()`);
  expect(rapidDoublePress.length).toBe(1);

  // 短按 fallback：popupButtonSlot 非法值 → slot 2（與 lib/storage.js pickPopupSlot 對齊）
  const shortPressFallback = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f._resetShortPressCooldown(); // 測試 seam：驗路由不驗冷卻，重置後才能再觸發
    await browser.storage.sync.set({ popupButtonSlot: 999 });
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot) => { calls.push(slot); };
    try {
      await f.handleShortPress();
    } finally {
      window.__SK.handleTranslatePreset = orig;
      await browser.storage.sync.remove('popupButtonSlot');
    }
    return calls;
  })()`);
  expect(shortPressFallback).toEqual([2]);

  // (2) 長按選單：建出三列、slot 1/2/3，點 slot-1 列 → handleTranslatePreset(1) + 收選單
  const menu = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applyEnabled(true);   // 桌面 build 預設關（display:none），openMenu 會早退；先開啟
    await f.openMenu();
    const items = Array.from(f.menuEl.querySelectorAll('.menu-item[data-slot]'));
    const slots = items.map((el) => Number(el.dataset.slot));
    const shown = f.isMenuOpen();
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot) => { calls.push(slot); };
    try {
      items.find((el) => el.dataset.slot === '1').click();
    } finally {
      window.__SK.handleTranslatePreset = orig;
    }
    return { count: items.length, slots, shown, calls, openAfterClick: f.isMenuOpen() };
  })()`);
  expect(menu.shown).toBe(true);
  expect(menu.count).toBe(3);
  expect(menu.slots).toEqual([1, 2, 3]);
  expect(menu.calls).toEqual([1]);         // 點 slot-1 列 → 路由到 slot 1
  expect(menu.openAfterClick).toBe(false); // 點選單列後收起

  await page.close();
});

// 第二層：真實 pointer 手勢 + 視覺 render（不是只測內部 handler）。
// Playwright page.mouse 產生真實 pointer 事件 → 驗 pointer 狀態機端到端：
// 短按 → handleTranslatePreset、長按 → 開選單、拖到左半 → 吸附左緣。
// 並截圖確認 icon 真的 render 出來（Shadow DOM host + icon-128.png via WAR）。
test('floating icon: 真實 pointer 手勢（短按 / 長按 / 拖移吸附）+ 視覺 render', async ({
  context,
  localServer,
}, testInfo) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 開啟 icon（桌面 build 預設關）+ 裝 handleTranslatePreset 記錄器
  await evaluate(`(() => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    f.applyPos({ edge: 'right', offsetY: 0.5 });
    window.__SK._fabCalls = [];
    window.__SK.handleTranslatePreset = (slot) => { window.__SK._fabCalls.push(slot); };
  })()`);

  // icon 中心座標（host 在 isolated world，main world 量不到，走 evaluate）
  const rect = await evaluate(`(() => {
    const r = window.__SK._floating.host.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  expect(rect.w).toBeGreaterThan(0); // host 真的有版面（render 出來）

  // 視覺 ground truth：截圖 + Read（§11）
  const shotPath = testInfo.outputPath('floating-icon-rendered.png');
  await page.screenshot({ path: shotPath });

  // 短按：down → 立刻 up（< 長按門檻、無位移）→ handleTranslatePreset(預設 slot 2)
  await page.mouse.move(rect.cx, rect.cy);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const afterTap = await evaluate(`JSON.stringify(window.__SK._fabCalls)`);
  expect(JSON.parse(afterTap)).toEqual([2]); // popupButtonSlot 未設 → fallback 2

  // 長按：down → 壓住超過門檻（500ms）→ 開選單（不放開即觸發）
  await evaluate(`window.__SK._fabCalls = []`);
  await page.mouse.move(rect.cx, rect.cy);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const menuOpen = await evaluate(`window.__SK._floating.isMenuOpen()`);
  await page.mouse.up();
  expect(menuOpen).toBe(true);
  await evaluate(`window.__SK._floating.closeMenu()`);

  // 拖移吸附：在 icon 上 down → 拖到視窗左半 → up → pos.edge 吸到 left
  await page.mouse.move(rect.cx, rect.cy);
  await page.mouse.down();
  await page.mouse.move(rect.cx - 50, rect.cy, { steps: 3 }); // 先超過拖移門檻進拖移模式
  await page.mouse.move(120, 300, { steps: 5 });             // 拖到左半
  await page.mouse.up();
  const posAfterDrag = await evaluate(`JSON.stringify(window.__SK._floating.getPos())`);
  expect(JSON.parse(posAfterDrag).edge).toBe('left');

  await page.close();
});

test('floating icon: 大小切換（16 / 24 / 32）+ 長按選單期間降透明度', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    f.applyPos({ edge: 'right', offsetY: 0.5 });
  })()`);

  // (1) 大小切換：16 小 / 24 中 / 32 大，三檔 footprint 各自遞增、icon 邊長對得上
  const sizes = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applySize(16);
    const small = { icon: f.getIconSize(), w: f.host.getBoundingClientRect().width };
    f.applySize(24);
    const medium = { icon: f.getIconSize(), w: f.host.getBoundingClientRect().width };
    f.applySize(32);
    const large = { icon: f.getIconSize(), w: f.host.getBoundingClientRect().width };
    return { small, medium, large };
  })()`);
  expect(sizes.small.icon).toBe(16);
  expect(sizes.medium.icon).toBe(24);
  expect(sizes.large.icon).toBe(32);
  expect(sizes.medium.w).toBeGreaterThan(sizes.small.w);  // 24 的 footprint 比 16 大
  expect(sizes.large.w).toBeGreaterThan(sizes.medium.w);  // 32 又比 24 大

  // 非法值 fallback 回預設 24（中）；明確選 16（小）不被 fallback 吃掉（上面 small.icon 已驗 16）
  const fallback = await evaluate(`(() => { window.__SK._floating.applySize(999); return window.__SK._floating.getIconSize(); })()`);
  expect(fallback).toBe(24);

  // (6) 長按選單期間降透明度：設使用者透明度 0.5 → 平時 host.opacity=0.5；
  //     開選單時拉到 1（讓使用者看清選單）；收選單還原 0.5
  const opacity = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applyOpacity(0.5);
    const idle = f.getOpacity();
    await f.openMenu();
    const menuShown = f.getOpacity();
    f.closeMenu();
    const afterClose = f.getOpacity();
    return { idle, menuShown, afterClose };
  })()`);
  expect(opacity.idle).toBe('0.5');       // 平時 = 使用者設定值
  expect(opacity.menuShown).toBe('1');    // 選單開啟 → 全不透明
  expect(opacity.afterClose).toBe('0.5'); // 收起 → 還原使用者設定值

  await page.close();
});

// 角落禁制區只針對 iPadOS：iPadOS 視窗右下角是縮放拖曳把手、上方角落是系統手勢區，
// 按鈕停太靠近角落會被 OS 攔走觸控而拖不出來。渲染時把 top 夾離上下角落 CORNER_DEADZONE_PX；
// iPhone 與桌面瀏覽器不夾角落（沒有 iPad 的視窗縮放角／系統手勢角問題）。三層驗：
// (A) 純函式 cornerClampTop 夾邊邏輯；(B) isIPadOSEnv 平台判斷各 UA 分支；(C) 真實 render
// path——setIPadOSForTest 覆寫 iPadOS 旗標後 applyPos 寫進 host.style.top 的實際值（實機
// Chromium maxTouchPoints=0，故走覆寫；驗到「修法實際生效那條 path」而非只測純函式）。
//
// SANITY 紀錄（已驗證）：把 cornerClampTop 的 iPadOS 分支 `return Math.max(minTop,...)` 暫改成
//   `return Math.max(0, Math.min(maxFree, top))`（等同不夾角落）→ ipadFlushBottom 斷言
//   fail（收到 668 而非 624）、整合 ipadTop 斷言 fail（收到 668px）→ 還原 → pass。
test('floating icon: iPadOS 角落禁制區（不卡視窗縮放角；iPhone/桌面不夾）', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // (A) 純函式：H=700、hit=32 → free=668、D=44。iPadOS 夾離上下角落，iPhone/桌面只夾可視範圍。
  const pure = await evaluate(`(() => {
    const f = window.__SK._floating;
    const H = 700, hit = 32, free = H - hit;
    return {
      D: f.CORNER_DEADZONE_PX,
      deskFlushBottom: f.cornerClampTop(free, H, hit, false),  // 非 iPadOS 貼底不夾 → free
      deskOver: f.cornerClampTop(9999, H, hit, false),         // 超出 → free
      deskNeg: f.cornerClampTop(-50, H, hit, false),           // 負 → 0
      ipadFlushBottom: f.cornerClampTop(free, H, hit, true),   // iPadOS 貼底 → free - D
      ipadFlushTop: f.cornerClampTop(0, H, hit, true),         // iPadOS 貼頂 → D
      ipadMid: f.cornerClampTop(300, H, hit, true),            // 中段不變
      tinyCenter: f.cornerClampTop(0, 80, 32, true),           // 視窗太矮夾不出安全區 → 置中
    };
  })()`);
  expect(pure.D).toBe(44);
  expect(pure.deskFlushBottom).toBe(668);
  expect(pure.deskOver).toBe(668);
  expect(pure.deskNeg).toBe(0);
  expect(pure.ipadFlushBottom).toBe(624);    // 668 - 44
  expect(pure.ipadFlushTop).toBe(44);
  expect(pure.ipadMid).toBe(300);
  expect(pure.tinyCenter).toBe(24);          // round((80-32)/2)

  // (B) isIPadOSEnv 平台判斷：iPad / iPadOS 桌面模式(Macintosh + 觸控) → true；
  //     iPhone / Android / 桌面 Mac(無觸控) → false。只有 iPad 有視窗縮放角問題。
  const plat = await evaluate(`(() => {
    const f = window.__SK._floating;
    const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    const IPADOS_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36';
    const DESKTOP_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    return {
      ipad: f.isIPadOSEnv(IPAD, 5),                  // 真 iPad → true
      ipadDesktopMode: f.isIPadOSEnv(IPADOS_DESKTOP, 5), // iPadOS 桌面模式偽裝 Mac 但有觸控 → true
      iphone: f.isIPadOSEnv(IPHONE, 5),              // iPhone → false
      android: f.isIPadOSEnv(ANDROID, 5),            // Android → false
      desktopMac: f.isIPadOSEnv(DESKTOP_MAC, 0),     // 桌面 Mac 無觸控 → false
      macUaNoTouch: f.isIPadOSEnv(IPADOS_DESKTOP, 0),// Macintosh UA 但無觸控 → false
    };
  })()`);
  expect(plat.ipad).toBe(true);
  expect(plat.ipadDesktopMode).toBe(true);
  expect(plat.iphone).toBe(false);
  expect(plat.android).toBe(false);
  expect(plat.desktopMac).toBe(false);
  expect(plat.macUaNoTouch).toBe(false);

  // (C) 真實 render path：setIPadOSForTest 覆寫 iPadOS 旗標 → applyPos 渲染 host top
  const render = await evaluate(`(() => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    f.applySize(16);                          // 釘住 hit = 16 + padding = 32
    const H = window.innerHeight;
    const hit = f.host.getBoundingClientRect().height;
    // 非 iPadOS（iPhone/桌面）：預設右下角 offsetY=1 → 貼底（free），不夾角落
    f.setIPadOSForTest(false);
    f.applyPos({ edge: 'right', offsetY: 1 });
    const deskTop = f.getTop();
    // iPadOS：同樣 offsetY=1 → 夾到 free - D（儘量靠底但不進右下角縮放區）
    f.setIPadOSForTest(true);
    f.applyPos({ edge: 'right', offsetY: 1 });
    const ipadTop = f.getTop();
    // iPadOS + 拖到頂 offsetY=0 → 夾到 D，不進頂角
    f.applyPos({ edge: 'right', offsetY: 0 });
    const ipadTopEdge = f.getTop();
    f.setIPadOSForTest(false);                // 還原（本 test 結束，避免殘留）
    return { H, hit, deskTop, ipadTop, ipadTopEdge, D: f.CORNER_DEADZONE_PX };
  })()`);
  const free = render.H - render.hit;
  expect(render.deskTop).toBe(free + 'px');                 // 非 iPadOS 貼底
  expect(render.ipadTop).toBe(free - render.D + 'px');      // iPadOS 夾離底角
  expect(render.ipadTopEdge).toBe(render.D + 'px');         // iPadOS 夾離頂角

  await page.close();
});

// 長按選單「功能選單」→ 在頁內用 iframe 載入真正的 popup.html?panel=1 當浮層。
// 驗:(1) 選單有「功能選單」item、label 取自 i18n 字典(非寫死、非漏翻 raw key)、不算進 preset 列;
//     (2) 點它 → 浮層 iframe 開啟、src 指向 popup/popup.html?panel=1 的 extension URL;
//     (3) closeFeaturePanel 收掉浮層。popup.js 端 ?panel=1 → 關閉改 postMessage 收浮層的
//     end-to-end(真 popup 按關閉 → 浮層收掉)需實機/整合,harness 驗到「iframe 正確掛上 + src 正確」。
//
// SANITY 紀錄(已驗證):把 buildMenu 末段 `menuEl.appendChild(featureItem)` 暫拿掉 →
//   「功能選單 item 存在」斷言 fail(exists=false)→ 還原 → pass。
test('floating icon: 長按選單「功能選單」叫出 popup 浮層（頁內 iframe）', async ({ context, localServer }, testInfo) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // (1) 開選單 → 找「功能選單」item（label 與 SK.t 同源比較，免綁特定語系）
  const item = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    await f.openMenu();
    const el = f.menuEl.querySelector('.menu-item.feature');
    const expectLabel = (typeof window.__SK.t === 'function') ? window.__SK.t('floating.featureMenu') : null;
    return {
      exists: !!el,
      label: el ? el.querySelector('.label').textContent : null,
      expectLabel,
      presetCount: f.menuEl.querySelectorAll('.menu-item[data-slot]').length,
    };
  })()`);
  expect(item.exists).toBe(true);
  expect(item.label).toBe(item.expectLabel);            // 用 i18n 字典值
  expect(item.label && item.label.length).toBeGreaterThan(0);
  expect(item.label).not.toBe('floating.featureMenu');  // 非漏翻 raw key
  expect(item.presetCount).toBe(3);                     // 功能選單不算進 preset 列

  // (2) 點「功能選單」→ 開浮層 iframe，src 指向 popup.html?panel=1
  const opened = await evaluate(`(() => {
    const f = window.__SK._floating;
    f.menuEl.querySelector('.menu-item.feature').click();
    return { open: f.isPanelOpen(), src: f.getPanelFrameSrc() };
  })()`);
  expect(opened.open).toBe(true);
  expect(opened.src).toMatch(/\/popup\/popup\.html\?panel=1$/);
  expect(/^(chrome|moz|safari-web)-extension:\/\//.test(opened.src)).toBe(true);

  // 視覺 ground truth：等 iframe 載入真實 popup，截圖（§11）
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('floating-feature-panel.png') });

  // (3) 浮層 iframe 寬度收緊到 popup 內容寬（issue 1：外框左右寬度與內容相符）。
  //     popup.js（?panel=1）load 後 postMessage 內容寬（桌面 body 280px）→ 外層把 iframe
  //     寬度設成該值，消除原本 min(94vw,360px) 外框比內容寬的左右白邊。
  const sized = await evaluate(`(() => window.__SK._floating.getPanelFrameSize())()`);
  expect(sized).toBeTruthy();
  const panelW = parseInt(sized.w, 10);
  expect(panelW).toBeGreaterThanOrEqual(260);   // 收緊到 popup 內容寬附近
  expect(panelW).toBeLessThanOrEqual(300);       // 不再是 360 外框寬

  // (4) 收浮層
  const closed = await evaluate(`(() => { window.__SK._floating.closeFeaturePanel(); return window.__SK._floating.isPanelOpen(); })()`);
  expect(closed).toBe(false);

  await page.close();
});

// issue 3:disable → 重新 enable 時按鈕回到預設位置（escape hatch，比照 JRead v0.8.161）。
// 初始載入不重置（尊重 storage 存的位置）；只有 false→true 轉移才 applyPos(null)+persist。
//
// SANITY 紀錄（已驗證）：把 applyEnabled 的 `if (lastEnabled === false && enabled === true)`
//   區塊暫拿掉 → 「reenable 回預設」斷言 fail（位置仍是自訂 left/0.3）→ 還原 → pass。
test('floating icon: disable → 重新 enable 回預設位置、初始載入不重置', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`(async () => {
    const f = window.__SK._floating;
    // 模擬初始載入：enable + 套用 storage 存的自訂位置（lastEnabled 從 null → true，不重置）
    f.applyEnabled(true);
    f.applyPos({ edge: 'left', offsetY: 0.3 });
    const afterInit = f.getPos();
    // disable → re-enable：false→true 轉移應重置回預設（右下角 edge=right, offsetY=1）
    f.applyEnabled(false);
    f.applyEnabled(true);
    const afterReenable = f.getPos();
    const stored = await browser.storage.sync.get('floatingIconPos');
    return { afterInit, afterReenable, stored: stored.floatingIconPos };
  })()`);

  // 初始載入套自訂位置後不被重置（尊重 storage）
  expect(result.afterInit).toEqual({ edge: 'left', offsetY: 0.3 });
  // disable→enable 後回預設右下角，且 persist 進 storage
  expect(result.afterReenable).toEqual({ edge: 'right', offsetY: 1 });
  expect(result.stored).toEqual({ edge: 'right', offsetY: 1 });

  await page.close();
});

// issue 6:長按選單選引擎 → force 重譯（不先還原原文）。短按維持 toggle（force=false）。
// 驗的是「接線層」：選單列 click 路由到 handleTranslatePreset(slot, {force:true})、
// 短按路由到 (slot, {force:false})。force 觸發後 content.js 內「已譯→還原後 fall through 重譯」
// 那層走真實翻譯，屬整合路徑（harness 不灌真 API），這裡鎖 force 旗標確實有帶到。
//
// SANITY 紀錄（已驗證）：把 buildMenu 的 `runPreset(p.slot, true)` 暫改回 `runPreset(p.slot)` →
//   menuForce 斷言 fail（收到 force=false）→ 還原 → pass。
test('floating icon: 選單選引擎帶 force 重譯、短按維持 toggle', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 選單列 click → handleTranslatePreset(slot, {force:true})
  const menuForce = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    await f.openMenu();
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot, opts) => { calls.push({ slot, force: !!(opts && opts.force) }); };
    try {
      f.menuEl.querySelector('.menu-item[data-slot="2"]').click();
    } finally {
      window.__SK.handleTranslatePreset = orig;
    }
    return calls;
  })()`);
  expect(menuForce).toEqual([{ slot: 2, force: true }]);

  // 短按 → handleTranslatePreset(slot, {force:false})（toggle 語意不變）
  const shortToggle = await evaluate(`(async () => {
    const f = window.__SK._floating;
    await browser.storage.sync.set({ popupButtonSlot: 1 });
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot, opts) => { calls.push({ slot, force: !!(opts && opts.force) }); };
    try {
      await f.handleShortPress();
    } finally {
      window.__SK.handleTranslatePreset = orig;
      await browser.storage.sync.remove('popupButtonSlot');
    }
    return calls;
  })()`);
  expect(shortToggle).toEqual([{ slot: 1, force: false }]);

  await page.close();
});

// 長按選單「啟動 / 關閉字幕翻譯」列（只在 YouTube 影片頁出現）。
// 驗：(1) 非 YouTube 頁不出現此列；(2) YouTube 頁未翻時出現、label = ytSubtitleOn、
//     點它 → SK.translateYouTubeSubtitles（不碰 stopYouTubeTranslation）+ 收選單；
//     (3) YouTube 頁已翻（YT.active=true）時 label = ytSubtitleOff、點它 →
//     SK.stopYouTubeTranslation；(4) 此列不算進 preset 列、功能選單仍在。
// label 與 SK.t 同源比較，免綁特定語系；真實觸發字幕翻譯屬整合路徑（harness 不灌真
// 字幕），這裡鎖「接線層」路由到正確 YT 函式 + 依 active 狀態決定 label/動作。
//
// SANITY 紀錄（已驗證）：把 buildMenu 內 `if (typeof SK.isYouTubePage === 'function' &&
//   SK.isYouTubePage())` 暫改成 `if (false)` → 「YouTube 頁有字幕列」斷言 fail（exists=false）
//   → 還原 → pass。把 toggleYtSubtitle 內 active 分支對調（active→translate、else→stop）→
//   「已翻點列走 stop」斷言 fail（收到 translate）→ 還原 → pass。
test('floating icon: YouTube 影片頁長按選單「啟動 / 關閉字幕翻譯」列', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // (1) 非 YouTube 頁（isYouTubePage=false）：字幕列不出現
  const nonYt = await evaluate(`(async () => {
    const f = window.__SK._floating;
    window.__SK.isYouTubePage = () => false;
    f.applyEnabled(true);
    await f.openMenu();
    const el = f.menuEl.querySelector('.menu-item.yt-subtitle');
    f.closeMenu();
    return { exists: !!el };
  })()`);
  expect(nonYt.exists).toBe(false);

  // (2) YouTube 頁、未翻（YT.active=false）：字幕列出現、label=ytSubtitleOn、
  //     點它 → translateYouTubeSubtitles（不碰 stop）+ 收選單，preset 仍 3 列、功能選單仍在
  const notActive = await evaluate(`(async () => {
    const f = window.__SK._floating;
    window.__SK.isYouTubePage = () => true;
    window.__SK.YT = { active: false };
    const calls = { translate: 0, stop: 0 };
    window.__SK.translateYouTubeSubtitles = () => { calls.translate++; return Promise.resolve(); };
    window.__SK.stopYouTubeTranslation = () => { calls.stop++; };
    await f.openMenu();
    const el = f.menuEl.querySelector('.menu-item.yt-subtitle');
    const label = el ? el.querySelector('.label').textContent : null;
    const expectLabel = window.__SK.t('floating.ytSubtitleOn');
    const presetCount = f.menuEl.querySelectorAll('.menu-item[data-slot]').length;
    const hasFeature = !!f.menuEl.querySelector('.menu-item.feature');
    el.click();
    return { exists: !!el, label, expectLabel, presetCount, hasFeature, calls, openAfterClick: f.isMenuOpen() };
  })()`);
  expect(notActive.exists).toBe(true);
  expect(notActive.label).toBe(notActive.expectLabel);
  expect(notActive.label).not.toBe('floating.ytSubtitleOn');   // 非漏翻 raw key
  expect(notActive.presetCount).toBe(3);                        // 字幕列不算進 preset
  expect(notActive.hasFeature).toBe(true);                      // 功能選單仍在
  expect(notActive.calls).toEqual({ translate: 1, stop: 0 });   // 未翻 → 啟動
  expect(notActive.openAfterClick).toBe(false);                 // 點列後收選單

  // (3) YouTube 頁、已翻（YT.active=true）：label=ytSubtitleOff、點它 → stopYouTubeTranslation
  const active = await evaluate(`(async () => {
    const f = window.__SK._floating;
    window.__SK.isYouTubePage = () => true;
    window.__SK.YT = { active: true };
    const calls = { translate: 0, stop: 0 };
    window.__SK.translateYouTubeSubtitles = () => { calls.translate++; return Promise.resolve(); };
    window.__SK.stopYouTubeTranslation = () => { calls.stop++; };
    await f.openMenu();
    const el = f.menuEl.querySelector('.menu-item.yt-subtitle');
    const label = el ? el.querySelector('.label').textContent : null;
    const expectLabel = window.__SK.t('floating.ytSubtitleOff');
    el.click();
    return { label, expectLabel, calls };
  })()`);
  expect(active.label).toBe(active.expectLabel);
  expect(active.label).not.toBe('floating.ytSubtitleOff');
  expect(active.calls).toEqual({ translate: 0, stop: 1 });      // 已翻 → 關閉

  await page.close();
});
