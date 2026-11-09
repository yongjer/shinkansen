// Regression: extract-readability-instapaper（送 Instapaper 改用 Readability 抽正文）
//
// Fixture: test/regression/fixtures/extract-readability-instapaper.html
// 對應真實 bug:readtrung.com Substack 文章送 Instapaper 被內嵌 YouTube 綁架，
// 存下來只剩影片、正文全失（見 PLAN-send-to-instapaper.md）。根因:舊
// extractPageHtml 把整頁 SPA（nav / 訂閱 widget / footer + youtube 嵌入）整坨
// documentElement 送出，下游 readability 鎖到影片塊。修法:用 vendored Readability
// 在 clone 上縮範圍到正文 + JRead 硬化薄層（剝媒體 / 去重標題 / div→p / 空殼）。
//
// 結構特徵（通用、不綁站點）:
//   - <header><nav> / aside.subscribe-widget / <footer> = 站台殼 → Readability 縮範圍丟掉
//   - div.available-content > article = 正文（>200 字觸發 Readability，非 fallback）
//   - .youtube-wrap > iframe(youtube-nocookie) = lite-embed 嵌入 → 剝除
//   - <h1> 與譯文標題同字 = 主標題 → 去重（下游用 title 欄位另渲染）
//   - <title> 是未翻譯原文 → 標題必須改用譯文 <h1>，不可用 Readability 的 <title>
//
// 訊號層次（CLAUDE.md §3）:本 spec 驗「我方送出的 HTML 已縮到正文、無影片嵌入、
//   標題正確」。**不**驗「Instapaper 伺服器 re-parse 後呈現正確」（下游、fixture 測不到）
//   —— 那層由真實 cage 送出驗收。
//
// SANITY 紀錄（已驗證）:
//   1) extractPageHtml 改成直接 return SK.extractPageHtmlLegacy(doc)（舊整頁 strip）
//      → 「html 不含 SITE_NAV_CHROME / SUBSCRIBE_CHROME / FOOTER_CHROME」斷言 fail
//      （整頁殼殘留）→ 還原後 pass。【驗證 Readability 縮範圍是擋影片綁架的關鍵】
//   3) 標題來源改成 parsed.title（Readability 偏好 <title>）→ title 變未翻譯原文
//      「title 必須是譯文 <h1>」斷言 fail → 還原後 pass。【驗證標題改用 h1】
//
// 關於剝 iframe（hardenExtractedHtml 第 1 步）的訊號層次說明:實測本 fixture 拿掉該行
//   spec 仍 pass —— Readability 自己就會把無實質文字的 youtube embed 整塊丟掉（bare
//   .youtube-wrap 低分被 _cleanConditionally 移除，連帶 iframe）。故剝 iframe 是
//   **defense-in-depth**:為「Readability videos regex 會保留、被足量正文包住的 youtube
//   iframe」那種 case 兜底，本 spec 的 <iframe / youtube-nocookie 斷言主要由 Readability
//   自身 + 註解剝除滿足，不是 hardening 剝 iframe 的 forcing function。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'extract-readability-instapaper';
const TRANSLATED_TITLE = 'FIFA 世界盃售票風波完整解析';
const ORIGINAL_TITLE = 'FIFA World Cup Ticketing Fiasco';

test('extract-readability-instapaper: 縮到正文、剝影片嵌入、標題取譯文 h1', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  // Readability 真的有載入（content_scripts 已加 lib/readability.js）
  expect(await evaluate(`typeof window.Readability`)).toBe('function');

  const result = JSON.parse(await evaluate(`
    JSON.stringify(window.__SK.extractPageHtml(document))
  `));
  const html = result.html;

  // 標題:取譯文主 <h1>，不可是未翻譯的 <head><title>
  expect(result.title).toBe(TRANSLATED_TITLE);
  expect(result.title).not.toBe(ORIGINAL_TITLE);
  expect(result.url).toContain(`${FIXTURE}.html`);

  // 是完整 HTML 文件，<title> 也是譯文版（下游從 content 抽標題也拿譯文）
  expect(html).toContain('<!DOCTYPE html>');
  expect(html).toContain(`<title>${TRANSLATED_TITLE}</title>`);

  // 正文留存（Readability 抽到 available-content）
  expect(html).toContain('動態定價策略');
  expect(html).toContain('因凡蒂諾');
  expect(html).toContain('多個球迷組織已發表聲明');

  // 站台殼被 Readability 縮範圍丟掉（這是擋影片綁架的關鍵:降噪到只剩正文）
  expect(html).not.toContain('SITE_NAV_CHROME');
  expect(html).not.toContain('SUBSCRIBE_CHROME');
  expect(html).not.toContain('FOOTER_CHROME');

  // 影片嵌入被剝（核心修法:防下游 re-parse 再被影片綁架）
  expect(html).not.toContain('<iframe');
  expect(html).not.toContain('<video');
  expect(html).not.toContain('youtube-nocookie');

  // 技術性 / 擴充 UI 噪音剝除
  expect(html).not.toContain('SHOULD_NOT_APPEAR');
  expect(html).not.toContain('PAGE_SCRIPT_RAN');
  expect(html).not.toContain('TOAST_UI_NOISE');
  expect(html).not.toContain('shinkansen-toast-host');
  expect(html).not.toContain('請啟用 JavaScript');

  // 去重主標題:body 內與 title 同字的 h1 已移除 → 譯文標題只出現在 <title>（1 次）
  expect(html.split(TRANSLATED_TITLE).length - 1).toBe(1);

  await page.close();
});
