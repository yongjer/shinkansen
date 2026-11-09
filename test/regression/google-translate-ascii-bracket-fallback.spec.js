// Regression: Google MT 把 CJK 括號【】正規化成 ASCII 括號 []，
// restoreGoogleTranslateMarkers 偵測到 [/N] 或 [*N] pattern 時啟動
// ASCII fallback 把 [N]/[/N]/[*N] 換回 ⟦N⟧/⟦/N⟧/⟦*N⟧。
//
// 真實 case：Amazon.co.jp 商品評論頁，Google MT 翻譯後 57 處 [0]/[/0] marker
// 漏進可見 DOM（字元碼 U+005B/U+005D，ASCII 方括號）。
//
// SANITY 紀錄（已驗證 2026-05-26）：暫拿掉 ASCII fallback if 條件
// → case 2/3/5 fail（[N][/N] 殘留）→ 還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'dual'; // 任意 fixture，只用來拿 __SK

test('restoreGoogleTranslateMarkers: 【】 intact → 正常轉換', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`window.__SK.restoreGoogleTranslateMarkers('翻譯 【0】連結【/0】 更多')`);
  expect(result).toContain('⟦0⟧');
  expect(result).toContain('⟦/0⟧');
  expect(result).not.toContain('【');
  await page.close();
});

test('restoreGoogleTranslateMarkers: 【】 mangled to [] → ASCII fallback 啟動', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`window.__SK.restoreGoogleTranslateMarkers('翻譯 [0]連結[/0] 更多')`);
  expect(result).toContain('⟦0⟧');
  expect(result).toContain('⟦/0⟧');
  expect(result).not.toContain('[0]');
  expect(result).not.toContain('[/0]');
  await page.close();
});

test('restoreGoogleTranslateMarkers: atomic [*N] → fallback 啟動', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`window.__SK.restoreGoogleTranslateMarkers('翻譯 [*0] 更多 [1]內容[/1]')`);
  expect(result).toContain('⟦*0⟧');
  expect(result).toContain('⟦1⟧');
  expect(result).toContain('⟦/1⟧');
  await page.close();
});

test('restoreGoogleTranslateMarkers: 純 [0] 沒有 [/N] → 不啟動 fallback（避免 footnote 誤判）', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`window.__SK.restoreGoogleTranslateMarkers('See reference [0] and [1] for details')`);
  expect(result).toContain('[0]');
  expect(result).toContain('[1]');
  expect(result).not.toContain('⟦');
  await page.close();
});

test('restoreGoogleTranslateMarkers: 混合（部分 【】 + 部分 []）→ 全部轉換', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`window.__SK.restoreGoogleTranslateMarkers('【0】link【/0】 and [1]mention[/1]')`);
  expect(result).toContain('⟦0⟧');
  expect(result).toContain('⟦/0⟧');
  expect(result).toContain('⟦1⟧');
  expect(result).toContain('⟦/1⟧');
  expect(result).not.toContain('【');
  expect(result).not.toContain('[1]');
  await page.close();
});
