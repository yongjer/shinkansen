// 驛傳 e2e fixture：載入 shinkansen/ 擴充功能（Chrome 原生 --headless=new，service worker 才會跑），
// 並提供本機 HTTP server（測試頁 + 模擬的 DeepLX 端點），整個測試不連外。
import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const EXTENSION_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shinkansen');

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head>
<body><main><article>
<h1>The relay runners</h1>
<p>Ekiden is a long-distance relay race that started in Japan more than a century ago.</p>
<p>Each runner carries a sash and hands it to the next runner at the relay station.</p>
<p>Spectators line the roads for hours to cheer for their favourite university teams.</p>
</article></main></body></html>`;

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekiden-pw-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      locale: 'en-US',
      args: [
        ...(process.env.EKIDEN_HEADED === '1' ? [] : ['--headless=new']),
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  // 本機 server：GET /article.html 測試頁；POST /deeplx 模擬 DeepLX（回「譯：」+ 原文）
  // eslint-disable-next-line no-empty-pattern
  localServer: async ({}, use) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/article.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(ARTICLE);
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/deeplx')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const j = JSON.parse(body || '{}');
          requests.push({ headers: req.headers, body: j });
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ code: 200, data: `譯：${j.text}` }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    await use({ baseUrl: `http://127.0.0.1:${port}`, requests });
    await new Promise((r) => server.close(r));
  },
});

export const expect = test.expect;

/** 在頁面的擴充功能 isolated world（名稱 = 擴充功能名稱）裡執行程式碼。 */
export async function isolatedEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  const deadline = Date.now() + 10_000;
  let ctx = null;
  while (!ctx && Date.now() < deadline) {
    ctx = contexts.find((c) => c.auxData?.type === 'isolated' && /Ekiden/i.test(c.name || ''));
    if (!ctx) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ctx) throw new Error(`isolated world not found: ${contexts.map((c) => c.name).join(', ')}`);
  return async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
}
