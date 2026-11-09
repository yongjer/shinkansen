// Regression: v1.8.61 — `<a role="button" aria-haspopup="true">` 是 dropdown trigger,
// 即使 href 是真 URL 也維持 widget skip,LI 整顆不被收進候選翻譯。
//
// 真實 case:upmedia.mg 主選單(11 個 nav-item dropdown LI)結構為
//   <li class="nav-item dropdown">
//     <a role="button" aria-haspopup="true" href="/tw/international">國際</a>
//     <div class="dropdown-menu"><a class="dropdown-item">時事</a>...(9 條)</div>
//   </li>
// v1.8.60 鬆綁讓「`<a role="button">` 有真實 href」全部放行 → 整顆 LI 進翻譯流程
// → inject 譯文時 .dropdown-menu 嵌套結構被破壞 → 全部子項平鋪展開亂版
// (德文版 target=de probe-upmedia-dropdown2.js 2026-05-08 dump 證實 11 個 LI 都被收)。
//
// 修法:isInteractiveWidgetContainer 內 v1.8.60 anchor-href 例外多檢查 aria-haspopup
// — 為 'true' / 'menu' / 'listbox' 等非 'false' / 非空值時視為 popup trigger
// 不放行,維持 widget skip。Bootstrap / Headless UI / Reach UI 共用此 ARIA 屬性,
// 屬結構性通則不是站點特判。
//
// SANITY 紀錄(已驗證 2026-05-08):把修法 isPopupTrigger 條件刪掉(還原 v1.8.60
// 行為)→ aria-haspopup LI 仍會被收進候選 → 「dropdown LI 不被收」斷言 fail。
// 還原修法 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'nav-li-aria-haspopup-dropdown';

async function loadAndCollect(page, localServer, target) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#control-article', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.STATE.targetLanguage = '${target}'`);
  const result = await evaluate(`
    JSON.stringify(window.__SK.collectParagraphs().map(u => ({
      tag: u.el?.tagName,
      id: u.el?.id || '',
      cls: (u.el?.className || '').toString().slice(0, 40),
      text: (u.el?.textContent || '').trim().slice(0, 60),
    })))
  `);
  return JSON.parse(result);
}

test('target=de:含 aria-haspopup="true" 的 dropdown LI 不被收(避免破壞嵌套 .dropdown-menu)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer, 'de');
  const ids = units.map(u => u.id);

  // 控制組:control-article 仍被收(walker 正常工作)
  expect(ids, 'control 段應被收(walker 正常)').toContain('control-article');

  // 主斷言:含 aria-haspopup="true" + dropdown-menu 嵌套的 LI 整顆不該進候選
  expect(ids, 'aria-haspopup LI #1 不該被收').not.toContain('dropdown-li-1');
  expect(ids, 'aria-haspopup LI #2 不該被收').not.toContain('dropdown-li-2');

  // 譯文路徑也不能透過 textContent 含「國際」「焦點」等找到 dropdown LI
  // (這些 LI 內 textContent 會包含整批 dropdown-item 子項,長度遠 > 30)
  const dropdownTexts = units.filter(u =>
    u.text.includes('國際') && u.text.includes('時事') && u.text.includes('講武堂'),
  );
  expect(dropdownTexts.length, '不該有 unit 同時含父選單 + 子項(代表 LI 整顆被收)').toBe(0);
});

test('target=de:對照組純 nav link(無 aria-haspopup)維持 v1.8.60 鬆綁,可被收', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer, 'de');
  const texts = units.map(u => u.text);
  // 「關於我們」是無 aria-haspopup 的 <a role="button" href="/tw/about">,v1.8.60
  // 鬆綁應放行收進來;若沒收則表示 v1.8.61 收緊範圍過頭(誤殺 v1.8.60 case)。
  expect(texts.some(t => t.includes('關於我們')), '無 aria-haspopup 的純 nav link 應仍被收(v1.8.60 行為保留)').toBe(true);
});
