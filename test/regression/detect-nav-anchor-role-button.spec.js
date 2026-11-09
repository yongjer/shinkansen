// Regression: v1.8.60 — `<a role="button">` 有真實 href 時不算互動 widget,nav LI
// 不被 isInteractiveWidgetContainer 整顆 SKIP。
//
// 修法:`isInteractiveWidgetContainer` 計算 buttons 時,對 `<a role="button">`
// 額外檢查 href:有實 href(非 '#' / 'javascript:' / 空)→ 視為 navigation link 跳過;
// 否則視為真 widget(SPA dropdown / accordion 等)維持 skip。
//
// 真實 case:upmedia.mg 主選單 swiper carousel 結構,LI > A href="/tw/project/..."
// role="button" 短文字(美伊開戰 / 最新 / 等)。target=de/en 時這些短中文 nav 應被收
// 進候選翻譯;target=zh-TW 仍走 isAlreadyInTarget 跳過(那是另一條規則)。
//
// SANITY 紀錄(已驗證 2026-05-08):把 isInteractiveWidgetContainer 內 anchor-href
// 例外整段刪掉(還原 v1.8.59 行為)→ #nav-real-link / #nav-also-real-link 斷言 fail
// (LI 仍被 widget skip)。還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'nav-li-anchor-role-button';

async function loadAndCollect(page, localServer, target) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#control-article', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.STATE.targetLanguage = '${target}'`);
  const result = await evaluate(`
    JSON.stringify(window.__SK.collectParagraphs().map(u => ({
      tag: u.el?.tagName,
      id: u.el?.id || (u.el?.querySelector?.('a')?.parentElement?.id) || '',
      text: (u.el?.textContent || '').trim(),
    })))
  `);
  return JSON.parse(result);
}

test('target=de:有實 href 的 <a role="button"> nav LI 進候選', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer, 'de');
  const texts = units.map(u => u.text);
  expect(texts, 'control 段應被收(walker 正常)').toContain(
    '這是一段對照用的內文,確保 walker 在此 fixture 上正常工作,長度應 > 20 字元',
  );
  expect(texts.some(t => t.includes('美伊開戰')), '美伊開戰 LI 應進候選(href 是真 navigation)').toBe(true);
  expect(texts.some(t => t.includes('最新')), '最新 LI 應進候選').toBe(true);
});

test('target=de:href="#" / "javascript:" / 空 href 的 <a role="button"> 仍被視為真 widget 跳過', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer, 'de');
  const texts = units.map(u => u.text);
  expect(texts.some(t => t === '展開選單'), 'href="#" 應被 widget skip').toBe(false);
  expect(texts.some(t => t === '折疊'), 'href="javascript:" 應被 widget skip').toBe(false);
  expect(texts.some(t => t === '無 href'), '空 href 應被 widget skip').toBe(false);
});

test('target=zh-TW:有實 href 的 nav LI 仍被 isAlreadyInTarget 跳過(繁中跳繁中)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer, 'zh-TW');
  const texts = units.map(u => u.text);
  // zh-TW target 下,nav LI 內容已是繁中 → isCandidateText reject(不是 widget skip 失效)
  expect(texts.some(t => t.includes('美伊開戰')), 'zh-TW target 應走 isAlreadyInTarget 跳過').toBe(false);
});
