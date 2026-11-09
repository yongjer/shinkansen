// Regression: gdoc-url-parsing (對應 v1.0.7 Google Docs 偵測導向 mobilebasic)
//
// 不需要 fixture HTML——這是純函式測試，只驗證 URL 解析邏輯。
// 使用任意 regression fixture 頁面載入 content script，然後呼叫
// window.__shinkansen.testGoogleDocsUrl() 傳入各種 URL 字串。
//
// 結構通則：Google Docs 編輯頁 URL 的 pathname 格式為
// /document/d/<docId>/(edit|preview|view)，mobilebasic 版為
// /document/d/<docId>/mobilebasic。解析必須正確辨識這些模式。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('gdoc-url-parsing: 正確辨識 Google Docs editor / mobilebasic / 非 Docs URL', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  // 用任意 fixture 載入 content script
  await page.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 測試用 helper
  async function checkUrl(url) {
    const raw = await evaluate(
      `JSON.stringify(window.__shinkansen.testGoogleDocsUrl(${JSON.stringify(url)}))`,
    );
    return JSON.parse(raw);
  }

  // ── 編輯頁 URL（isEditor = true）──
  const edit = await checkUrl('https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit');
  expect(edit.isEditor, '/edit 應是 editor').toBe(true);
  expect(edit.isMobileBasic, '/edit 不是 mobilebasic').toBe(false);
  expect(edit.mobileBasicUrl).toBe('https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/mobilebasic');

  const preview = await checkUrl('https://docs.google.com/document/d/abc123/preview');
  expect(preview.isEditor, '/preview 應是 editor').toBe(true);

  const view = await checkUrl('https://docs.google.com/document/d/abc123/view');
  expect(view.isEditor, '/view 應是 editor').toBe(true);

  // ── mobilebasic URL（isMobileBasic = true）──
  const mobile = await checkUrl('https://docs.google.com/document/d/abc123/mobilebasic');
  expect(mobile.isEditor, '/mobilebasic 不是 editor').toBe(false);
  expect(mobile.isMobileBasic, '/mobilebasic 應被辨識').toBe(true);
  expect(mobile.mobileBasicUrl).toBe('https://docs.google.com/document/d/abc123/mobilebasic');

  // ── 非 Google Docs URL（全部 false）──
  const other = await checkUrl('https://www.google.com/search?q=test');
  expect(other.isEditor, '非 Docs URL').toBe(false);
  expect(other.isMobileBasic).toBe(false);
  expect(other.mobileBasicUrl).toBeNull();

  // ── Google Docs 但不是文件頁（例如首頁）──
  const docsHome = await checkUrl('https://docs.google.com/document/');
  expect(docsHome.isEditor, 'Docs 首頁不是 editor').toBe(false);
  expect(docsHome.mobileBasicUrl).toBeNull();

  // ── 帶 query string 和 hash 的 edit URL ──
  const editWithQuery = await checkUrl('https://docs.google.com/document/d/abc123/edit?usp=sharing#heading=h.abc');
  expect(editWithQuery.isEditor, '/edit?... 應是 editor').toBe(true);
  expect(editWithQuery.mobileBasicUrl).toBe('https://docs.google.com/document/d/abc123/mobilebasic');

  await page.close();
});
