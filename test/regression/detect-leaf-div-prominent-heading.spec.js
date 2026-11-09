// Regression: v1.8.61 — leaf DIV/SPAN 短文字(< 20 字)的 visual prominent
// heading 例外:display 為 block 系列 + font-size >= 24px 才放行進候選翻譯,
// 跟 timestamp / author / inline counter 雜訊明確分開。
//
// 真實 case:upmedia.mg 首頁「編輯部推薦」section 標題(2026-05-08 截圖)
//   <div class="sel-tit2 clearfix">編輯部推薦</div>
// DIV / 5 字 / 48px / display:block / 無 child → 原本走 leaf DIV 補抓 path,
// 但 textLen < 20 hard skip 永久不翻。
//
// 修法:content-detect.js 補抓 leaf DIV/SPAN 改成 textLen < 2 才直接 skip,
// 2-19 字必須 display 為 block 系列 + font-size >= 24px。對應結構性通則
//(visual prominence),不靠 class 黑白名單。
//
// SANITY 紀錄(已驗證 2026-05-08):把修法 height/visual prominence 條件刪掉,
// 改回 textLen < 20 → return,「編輯部推薦」斷言 fail。還原修法 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'leaf-div-prominent-heading';

async function loadAndCollect(page, localServer, target = 'de') {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#control-article', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.STATE.targetLanguage = '${target}'`);
  const result = await evaluate(`
    JSON.stringify(window.__SK.collectParagraphs().map(u => ({
      tag: u.el?.tagName,
      id: u.el?.id || '',
      text: (u.el?.textContent || '').trim().slice(0, 50),
    })))
  `);
  return JSON.parse(result);
}

test('leaf DIV 48px / block / 5 字短中文 → 應被收(對應 upmedia.mg 編輯部推薦)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer);
  const ids = units.map(u => u.id);
  expect(ids, '#prominent-48px(48px 大字 block heading)應被收').toContain('prominent-48px');
});

test('leaf DIV 24px / block / 短字 → 應被收(剛好閾值)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer);
  const ids = units.map(u => u.id);
  expect(ids, '#medium-24px(24px 剛好閾值)應被收').toContain('medium-24px');
});

test('leaf DIV 20px / block / 短字 → 不應被收(低於 24px 閾值)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer);
  const ids = units.map(u => u.id);
  expect(ids, '#below-threshold(20px 低於閾值)不應被收').not.toContain('below-threshold');
});

test('inline 短字 → 不應被收(排除 author / counter 雜訊)', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer);
  const ids = units.map(u => u.id);
  expect(ids, '#inline-author(span 18px inline)不應被收').not.toContain('inline-author');
});

test('block 但 font-size 18px(< 24)→ 不應被收', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer);
  const ids = units.map(u => u.id);
  expect(ids, '#inline-author-block(block 但 18px)不應被收').not.toContain('inline-author-block');
});

test('14px timestamp / block → 不應被收', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer);
  const ids = units.map(u => u.id);
  expect(ids, '#timestamp(14px timestamp)不應被收').not.toContain('timestamp');
});

test('既有行為:>= 20 字長 leaf DIV 不受新邏輯影響', async ({ context, localServer }) => {
  const page = await context.newPage();
  const units = await loadAndCollect(page, localServer);
  const ids = units.map(u => u.id);
  expect(ids, '#long-content(20+ 字)應被收(不受 visual prominence 限制)').toContain('long-content');
  expect(ids, 'control-article(P 段 walker 主路徑)應被收').toContain('control-article');
});
