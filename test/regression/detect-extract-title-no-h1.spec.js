// Regression: 送 Instapaper 的標題在「整頁沒有 <h1>」時必須抓到內容區譯文標題
//
// Bug（cage 實測 stratechery.com 週報頁,2026-06-18）:該頁 h1 數 = 0,文章主標是
// <main> 內第一個 <h2>（CMS 常把主標放 h2.post-title 而非 h1）。舊 pickExtractTitle
// 只查 h1 → 找不到 → fallback 到 document.title（single mode 不動 <head>,永遠原文）
// → 送到 Instapaper 的標題是未翻譯的英文原文。
//
// 修法（content-ns.js SK.pickExtractTitle,結構性通則非站點特判,§8）:
//   1. 內容區（main/article）內 <h1>
//   2. 內容區內第一個 <h2>–<h6>（排除 nav/footer）← 本 bug 命中這層
//   3. 任一 <h1>（沒 main/article 容器時）
//   4. 退回 document.title
//
// Fixture: extract-title-no-h1.html —— 無任何 <h1>,主標是 <main> 內 <h2>,
//   header/nav 與 footer 各有一個 heading（不可被誤選為主標）。
//
// SANITY 紀錄（已驗證）:把修法後的「內容區第一個 h2-h6」迴圈整段刪掉(只留 h1 + 退回
//   document.title)→ 「無 h1 時抓 main 內 h2 譯文標題」斷言 fail（退回英文原文 title）→ 還原 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'extract-title-no-h1';

test('無 h1 時:pickExtractTitle 抓 main 內第一個 h2 譯文標題,不退回原文 title', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const title = await evaluate(`window.__SK.pickExtractTitle(document)`);
  expect(title).toBe('譯文文章主標題');
  // 不可退回 <head><title>（原文）
  expect(title).not.toContain('Original English Title');
  // 不可選到 header/nav 的導覽標題或 footer 標題
  expect(title).not.toBe('上一篇文章導覽標題');
  expect(title).not.toBe('頁尾標題（不是文章主標）');
});

test('內容區有 <h1> 時仍優先取 h1（即使頁面別處有 banner h1）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 在 header（banner）塞一個站名 h1、在 main 塞文章 h1 → 必須取 main 的 h1
  const title = await evaluate(`
    (function () {
      const hdr = document.querySelector('header');
      const bannerH1 = document.createElement('h1');
      bannerH1.textContent = '站名 Banner H1';
      hdr.appendChild(bannerH1);

      const main = document.querySelector('main');
      const articleH1 = document.createElement('h1');
      articleH1.textContent = '內容區文章 H1 標題';
      main.insertBefore(articleH1, main.firstChild);

      const t = window.__SK.pickExtractTitle(document);
      articleH1.remove();
      bannerH1.remove();
      return t;
    })()
  `);
  expect(title).toBe('內容區文章 H1 標題');
});
