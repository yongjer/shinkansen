// Regression: streaming 批次「只補缺的」端到端(對應 v1.10.61 修的效率 bug)
//
// Bug:background.js handleTranslateStream 原本只要這批有一段快取 miss(allHit=false)
//   就把整批 texts 重送 Gemini(含已快取段落)。RSS feed 頂端插入新文章時,新段落落進
//   batch 0(streaming),整批已翻段落會跟著重打 API。
// 修法:已快取段落以原始 index 即刻回推 content,只把 miss 的段落送 translateBatchStream
//   (stream 的 missing-index 經 missingIdxs 表 remap 回原始 index)。
//
// 這條 spec 走「真實 service worker」端到端,不像其他 streaming spec mock 訊息層
// (那些攔在 content 端 chrome.runtime.sendMessage,根本不會進 background)。做法:
//   - 在 SW global 覆寫 fetch,攔 streamGenerateContent,回 canned SSE,並把每次的
//     request body(joined 原文)記進 globalThis.__geminiCalls
//   - 翻一次(4 段全 miss → 1 個 call、4 段) → 改其中 1 段 → 重翻
//   - 斷言:第二次的 Gemini call 只帶「被改的那 1 段」,不是整批 4 段
//
// 驗的訊號層次:真實 background streaming 路徑「實際送給 API 的段落集合」。涵蓋了
// stream-partial-reuse.spec.js(純函式 index 對映單測)驗不到的 wiring 層(handleTranslateStream
// 有沒有正確呼叫 helper、emit 已快取段、只送缺段、用 missingTexts 寫回 cache)。
//
// SANITY 紀錄(已驗證,2026-06-20):
//   把 background.js handleTranslateStream 的 translateBatchStream(missingTexts, ...) 改回
//   translateBatchStream(texts, ...)(即還原成舊「整批重送」行為)→ 第二次斷言
//   (segCount===1)fail,實際 segCount===4。還原修法後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'stream-partial-reuse';
const SEP_RE = /\s*<<<SHINKANSEN_SEP>>>\s*/;

// 取得(或等到)Shinkansen 的 service worker。
async function getServiceWorker(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  return sw;
}

// 在 SW global 安裝 fetch 攔截 + 重置記錄器。每輪翻譯前都呼叫一次:
//   - 一定重置 __geminiCalls(只看本輪送了什麼)
//   - 只在尚未 patch 時包裝 fetch(SW 若 idle 重啟會掉 patch,重啟後此處重新包裝)
async function installGeminiStub(sw) {
  await sw.evaluate(() => {
    globalThis.__geminiCalls = [];
    if (globalThis.__skFetchPatched) return;
    globalThis.__skFetchPatched = true;
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (url, opts) => {
      const u = typeof url === 'string' ? url : (url && url.url) || '';
      if (u.includes('streamGenerateContent')) {
        let joined = '';
        try { joined = JSON.parse(opts.body).contents[0].parts[0].text; } catch (_) { /* ignore */ }
        globalThis.__geminiCalls.push(joined);
        const SEP = /\s*<<<SHINKANSEN_SEP>>>\s*/;
        const DELIM = '\n<<<SHINKANSEN_SEP>>>\n';
        // 每個輸入段落產一段譯文(去掉 «N» marker),段數對齊避免 hadMismatch。
        // v2.0.65:mock 譯文必須含 CJK 字元(≥3)——echo 快取防護對 CJK target 會把
        // 「長拉丁 + 零 CJK」的輸出判定為未翻譯而不寫快取(isSuspectEchoTranslation),
        // 舊 mock '[ZH]'+英文原文 正好落進該判定 → 4 段全不進快取 → round 2 全 miss
        // 重送整批,partial-reuse 斷言炸。加中文前綴讓 mock 譯文擬真(真 zh 譯文必含 CJK)。
        const outText = joined.split(SEP)
          .map((s) => '[ZH]中文譯文 ' + s.replace(/^«\d+»\s*/, ''))
          .join(DELIM);
        const evt = 'data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: outText }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
        }) + '\r\n\r\n';
        const enc = new TextEncoder();
        const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(evt)); c.close(); } });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return realFetch(url, opts);
    };
  });
}

async function readGeminiCalls(sw) {
  return sw.evaluate(() => globalThis.__geminiCalls || []);
}

// 透過 Debug Bridge 在 isolated world 觸發 action(content script 的 listener 在 isolated world)。
function bridge(evaluate, detail) {
  return evaluate(`new Promise((res) => {
    window.addEventListener('shinkansen-debug-response', (e) => res(e.detail), { once: true });
    window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: ${JSON.stringify(detail)} }));
    setTimeout(() => res('TIMEOUT'), 8000);
  })`);
}

// 輪詢直到指定段落注入了 [ZH] 譯文(single mode 會替換 innerHTML,譯文含 mock 前綴)。
async function waitTranslated(page, selector, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(
      (sel) => (document.querySelector(sel)?.textContent || '').includes('[ZH]'),
      selector,
    );
    if (ok) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

test('streaming-batch-partial-reuse: 重翻時只把改過的那段送 Gemini,不重打整批', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const sw = await getServiceWorker(context);
  // 設 apiKey(storage.local 是 v0.62 起的正規位置)+ 預設 engine=gemini → 走 streaming
  await sw.evaluate(async () => { await chrome.storage.local.set({ apiKey: 'TEST_KEY' }); });

  const { evaluate } = await getShinkansenEvaluator(page);

  // ── Round 1:冷快取,4 段全 miss ──────────────────────────
  await bridge(evaluate, { action: 'CLEAR_CACHE' });
  await installGeminiStub(sw);
  await bridge(evaluate, { action: 'TRANSLATE' });
  expect(await waitTranslated(page, '#p1')).toBe(true);
  await waitTranslated(page, '#p4');

  const round1 = await readGeminiCalls(sw);
  // 1 個 streaming call,涵蓋全部 4 段
  expect(round1.length).toBe(1);
  expect(round1[0].split(SEP_RE).length).toBe(4);

  // ── 改其中一段(模擬 feed 多了一篇新文章)──────────────────
  await bridge(evaluate, { action: 'RESTORE' });
  await page.waitForTimeout(300);
  const NEW_P2 = 'A completely different second paragraph about deep ocean exploration and marine biology research today.';
  await page.evaluate((txt) => { document.querySelector('#p2').textContent = txt; }, NEW_P2);

  // ── Round 2:p1/p3/p4 命中、只有 p2 是 miss ──────────────────
  await installGeminiStub(sw); // 重置記錄器(只看本輪)
  await bridge(evaluate, { action: 'TRANSLATE' });
  expect(await waitTranslated(page, '#p2')).toBe(true);
  // 給 cache fast-path 的 3 段一點時間注入(它們不打 API,但會經 idle gate)
  await page.waitForTimeout(300);

  const round2 = await readGeminiCalls(sw);
  // 關鍵斷言:第二輪只送 1 個 call、且只有 1 段(= 被改的 p2),不是整批 4 段
  expect(round2.length).toBe(1);
  const seg = round2[0].split(SEP_RE);
  expect(seg.length).toBe(1);
  expect(round2[0]).toContain('deep ocean exploration');
  // 反向確認:沒有把已快取的 p1/p3/p4 一起重送
  expect(round2[0]).not.toContain('renewable energy');
  expect(round2[0]).not.toContain('solar panel');

  await page.close();
});
