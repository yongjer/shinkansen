// Regression: extract-page-html（送 Instapaper 的 legacy fallback 路徑）
//
// v1.10.55 起送 Instapaper 主路徑改用 Readability（見 extract-readability-instapaper.spec.js）;
// 本 spec 鎖 SK.extractPageHtmlLegacy —— Readability 抽不到（罕見結構 / 未載入）時的
// fallback「整頁 documentElement strip」。fallback 仍須乾淨（無腳本 / 媒體 / UI 噪音）
// 且完整（正文 + dual wrapper），並保留舊的去重標題 / 譯文標題行為。
//
// Fixture: test/regression/fixtures/extract-page-html.html
// 結構特徵（通用，不綁站點）:
//   - <script> / <style> / <link> / <noscript> = 技術性節點 → 剝除
//   - <iframe> / <video> = 媒體嵌入 → 剝除（下游 reader 會把影片嵌入升級成主要內容，
//     把整篇文章丟掉；實測 Christie's 文章內嵌 Brightcove iframe 被 Instapaper 抽成
//     播放器 UI + 影片檔名標題，19K 字文章全失）
//   - #shinkansen-toast-host / #shinkansen-dual-style = 擴充注入的 UI chrome → 剝除
//   - <article> 正文 + <shinkansen-translation> 譯文 wrapper = 內容 → 保留
//
// 驗 SK.extractPageHtml(document):送 Instapaper 的 HTML 必須乾淨（無腳本 / 無媒體嵌入 /
// 無 UI 噪音）又完整（正文與譯文都在），且帶回 url / title。
//
// 標題:single mode 不動 <head><title>，譯文標題在已就地翻譯的 <h1>。pickExtractTitle
//   優先取 main/article/第一個 <h1>，沒 h1 才退回 document.title。
//
// SANITY 紀錄（已驗證）:
//   1) STRIP_FOR_EXTRACT 改成空 selector（'#__none__'）→「html 不含 SHOULD_NOT_APPEAR /
//      TOAST_UI_NOISE / VIDEO_PLAYER_NOISE」斷言 fail（腳本 / toast host / 影片嵌入殘留）→ 還原後 pass。
//   2) pickExtractTitle 的 `if (h1text) return h1text` 改成 `return doc.title`（故意退回原文）
//      →「title 必須是 已翻譯的文章標題、不可是 擷取測試頁標題」斷言 fail → 還原後 pass。
//   3) 拿掉 extractPageHtml 內「移除與 title 重複的主 h1」那段 → 「html 不含 id="headline" /
//      不含 <h1」斷言 fail（body 主標題殘留 → reader 重複標題）→ 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'extract-page-html';

test('extract-page-html: 剝除腳本 / UI chrome，保留正文與譯文 wrapper', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const result = JSON.parse(await evaluate(`
    JSON.stringify(window.__SK.extractPageHtmlLegacy(document))
  `));

  // 標題取「譯文標題」= 已就地翻譯的 <h1>，而非 <head><title>（single mode 不動 title）。
  // fixture 的 <title> 是「擷取測試頁標題」、<h1> 是「已翻譯的文章標題」，必須拿 h1。
  expect(result.title).toBe('已翻譯的文章標題');
  expect(result.title).not.toBe('擷取測試頁標題');     // 不可退回原文 <title>
  expect(result.url).toContain(`${FIXTURE}.html`);

  // clone 的 <head><title> 也被改寫成譯文標題（下游從 content 抽標題也拿到譯文）
  expect(result.html).toContain('<title>已翻譯的文章標題</title>');

  const html = result.html;
  // 剝除:腳本內容、style、link、noscript、toast host、dual style
  expect(html).not.toContain('SHOULD_NOT_APPEAR');     // <script> 內容
  expect(html).not.toContain('PAGE_SCRIPT_RAN');
  expect(html).not.toContain('TOAST_UI_NOISE');        // #shinkansen-toast-host
  expect(html).not.toContain('shinkansen-toast-host');
  expect(html).not.toContain('shinkansen-dual-style');
  expect(html).not.toContain('should-be-stripped.css'); // <link>
  expect(html).not.toContain('請啟用 JavaScript');       // <noscript>
  expect(html).not.toContain('.x { color: red; }');      // <style>
  // 媒體嵌入：iframe / video → 剝除（下游 reader 會把影片升級成主要內容）
  expect(html).not.toContain('VIDEO_PLAYER_NOISE');      // <iframe> 內容
  expect(html).not.toContain('brightcove.net');          // <iframe src>
  expect(html).not.toContain('VIDEO_TAG_NOISE');         // <video>
  expect(html).not.toContain('<iframe');
  expect(html).not.toContain('<video');

  // 去重複標題：body 內與 title 同字的主 <h1> 必須被移除（下游 reader 另外渲染 title，
  // 否則出現重複標題），但 title 參數 + <head><title> 仍保有譯文標題（上方已驗）。
  expect(html).not.toContain('id="headline"');           // body 的主標題 h1 已移除
  expect(html).not.toContain('<h1');                     // fixture 僅一個 h1 = 標題，移除後無殘留

  // 保留:正文 + 譯文 wrapper
  expect(html).toContain('這是文章正文的譯文段落');
  expect(html).toContain('shinkansen-translation');      // dual wrapper tag 保留
  expect(html).toContain('這是雙語對照的譯文 wrapper 內容');
  // 是完整 HTML 文件
  expect(html).toContain('<!DOCTYPE html>');

  await page.close();
});
