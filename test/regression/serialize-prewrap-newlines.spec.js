// Regression: serialize 對 white-space: pre-wrap 內 textNode \n 必須保留(轉 \n via  sentinel)
//
// Bug:Twitter / Reddit / Threads / Mastodon / Discord web 等 React 站用
//   <SPAN>multi\nline\ntext</SPAN> + white-space: pre-wrap
// 顯示換行(完全不用 <br>)。Shinkansen 兩條 serialize 路徑(serializeNodeIterableForGoogle
// + serializeNodeIterable)的 normalize 都先 /\s+/g collapse 再轉 BR sentinel,但 BR sentinel
// 只在 child.tagName === 'BR' 才加,textNode 內的 \n 沒被轉 sentinel → 被 \s+ 壓成 space →
// 送 LLM/Google MT 的 text 失去原始換行 → 譯文回來連成一行,使用者看到的譯文沒折行。
// 真實案例:Magnolia1234B 的 release tweet 翻完一行接一行,跟原文截然不同視覺。
//
// 修法:加 shouldPreserveTextNewlines(el):父 element 的 effective white-space 是
// pre / pre-wrap / pre-line / break-spaces 時,textNode 內 \n 改成  sentinel,跟 BR 共用
// 後續 normalize pipeline,deserialize 時還原為 <br>。其餘 white-space (normal / nowrap)
// 維持原行為(瀏覽器視覺也會 collapse,沒必要保留)。
//
// SANITY 紀錄(已驗證):暫時把 shouldPreserveTextNewlines 一律 return false → spec
// 「pre-wrap 含 \n 應保留 \n in serialized text」 fail(serialized text 沒 \n);還原 fix → 全綠。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'serialize-prewrap-newlines';

test('shouldPreserveTextNewlines:pre-wrap → true,normal → false', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prewrap-tweet', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const pw = document.querySelector('#prewrap-tweet');
      const nm = document.querySelector('#normal-tweet');
      return {
        prewrap: SK._shouldPreserveTextNewlines(pw),
        normal: SK._shouldPreserveTextNewlines(nm),
        nullArg: SK._shouldPreserveTextNewlines(null),
      };
    })()
  `);
  expect(result.prewrap, 'white-space:pre-wrap 應 return true').toBe(true);
  expect(result.normal, 'white-space:normal 應 return false').toBe(false);
  expect(result.nullArg, 'null arg 應 return false').toBe(false);

  await page.close();
});

test('serializeForGoogleTranslate:pre-wrap 內 textNode \\n 應保留為 \\n', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prewrap-tweet', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const pw = document.querySelector('#prewrap-tweet');
      const { text } = SK.serializeForGoogleTranslate(pw);
      return {
        text,
        newlineCount: (text.match(/\\n/g) || []).length,
        // 沒有 \\u0001 殘留(已被 normalize 轉成 \\n)
        sentinelLeft: (text.match(/\\u0001/g) || []).length,
      };
    })()
  `);
  // fixture 內 SPAN 含 2 個 \n(三行 → 兩個換行)
  expect(result.newlineCount, 'serialized text 應保留 2 個 \\n').toBe(2);
  expect(result.sentinelLeft, '不應殘留 \\u0001 sentinel').toBe(0);
  expect(result.text, 'serialized text 應為三行原文').toContain('First line of tweet');
  expect(result.text, 'serialized text 應為三行原文').toContain('Second line of tweet');
  expect(result.text, 'serialized text 應為三行原文').toContain('Third line of tweet');

  await page.close();
});

test('serializeForGoogleTranslate:white-space:normal 應維持原行為(\\n collapse 為 space)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#normal-tweet', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const nm = document.querySelector('#normal-tweet');
      const { text } = SK.serializeForGoogleTranslate(nm);
      return {
        text,
        newlineCount: (text.match(/\\n/g) || []).length,
      };
    })()
  `);
  // white-space:normal 下,瀏覽器原本就會把 \n collapse 為 space,序列化也維持此行為
  expect(result.newlineCount, 'normal 模式下 \\n 應被 collapse 為 space').toBe(0);

  await page.close();
});

test('serializeForGoogleTranslate:傳統 BR 路徑沒被破壞(\\n 數應對應 BR 數)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#br-tweet', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const br = document.querySelector('#br-tweet');
      const { text } = SK.serializeForGoogleTranslate(br);
      return {
        text,
        newlineCount: (text.match(/\\n/g) || []).length,
      };
    })()
  `);
  // fixture 含 2 個 BR → 應 2 個 \n
  expect(result.newlineCount, 'BR 路徑應產生 2 個 \\n').toBe(2);
  expect(result.text, 'serialized text 應含三段內容').toContain('Line A');
  expect(result.text, 'serialized text 應含三段內容').toContain('Line B');
  expect(result.text, 'serialized text 應含三段內容').toContain('Line C');

  await page.close();
});

test('serializeWithPlaceholders(Gemini path):pre-wrap 內 textNode \\n 應保留', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prewrap-tweet', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const pw = document.querySelector('#prewrap-tweet');
      const span = pw.querySelector('span');
      const ws = window.getComputedStyle(pw).whiteSpace;
      const wsSpan = window.getComputedStyle(span).whiteSpace;
      const shouldPreserve = SK._shouldPreserveTextNewlines(pw);
      const rawTextContent = span.firstChild ? span.firstChild.nodeValue : null;
      const rawNewlinesInText = rawTextContent ? (rawTextContent.match(/\\n/g) || []).length : 0;
      const { text } = SK.serializeWithPlaceholders(pw);
      return {
        wsParent: ws, wsSpan,
        shouldPreserve,
        rawTextContent: rawTextContent ? rawTextContent.slice(0, 100) : null,
        rawNewlinesInText,
        text,
        newlineCount: (text.match(/\\n/g) || []).length,
      };
    })()
  `);
  expect(result.shouldPreserve, 'pre-wrap 應 hint preserveNewlines').toBe(true);
  expect(result.rawNewlinesInText, 'fixture 內 textContent 原本應有 2 個 \\n').toBe(2);
  expect(result.newlineCount, 'Gemini path serialized text 應保留 2 個 \\n').toBe(2);

  await page.close();
});
