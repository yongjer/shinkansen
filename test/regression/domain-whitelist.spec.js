// Regression（真實路徑層）: 自動翻譯網站名單比對 — 使用者貼完整網址也要命中
//
// 起因：使用者在 options「自動翻譯網站」填 `https://stratechery.com/`(完整網址)無效,
// 必須填裸網域 `stratechery.com`。root cause:content-spa.js 比對的是 location.hostname,
// 協定 + 尾斜線讓 exact-match 永不命中。修法把比對收斂到 lib/domain-utils.js 的
// normalizeDomainEntry + matchDomain 單一來源,並由 content-spa.js isDomainWhitelisted 委派。
//
// 本 spec 驗「真實路徑層」（jest-unit/domain-whitelist.test.cjs 驗純函式層）:
//   載入真實 extension → 改 storage.sync.domainRules.whitelist → 在 isolated world 呼叫
//   window.__SK.isDomainWhitelisted()，驗證它讀 storage + 走 matchDomain + 比對
//   location.hostname(=127.0.0.1)整條串接正確。
//
// SANITY CHECK 已完成:
//   把 content-spa.js isDomainWhitelisted 內 matchDomain 呼叫換成舊的 raw String() 比對
//   → 「http://127.0.0.1/ 完整網址命中」斷言 fail；還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'domain-whitelist';

async function checkWhitelist(evaluate, whitelist) {
  const expr = `
    (async () => {
      await browser.storage.sync.set({
        domainRules: { whitelist: ${JSON.stringify(whitelist)} }
      });
      return window.__SK.isDomainWhitelisted();
    })()
  `;
  return evaluate(expr);
}

test('domain-whitelist: 完整網址 / 裸網域 / 尾斜線形式都命中 host 127.0.0.1，他站不命中', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 本次 bug 主場景：完整網址形式
  expect(await checkWhitelist(evaluate, ['http://127.0.0.1/'])).toBe(true);
  // 含路徑 / query 也要命中
  expect(await checkWhitelist(evaluate, ['http://127.0.0.1/some/path?x=1'])).toBe(true);
  // 裸 host
  expect(await checkWhitelist(evaluate, ['127.0.0.1'])).toBe(true);
  // 他站不命中
  expect(await checkWhitelist(evaluate, ['https://stratechery.com/'])).toBe(false);
  // 空名單不命中
  expect(await checkWhitelist(evaluate, [])).toBe(false);
});
