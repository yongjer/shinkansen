// Regression: code review 2026-06-09 M3 — SK.isFrameworkManaged 只快取 true
//
// 問題:_fwQueryCache 原本對 false 結果也永久快取。若查詢時機早於 React/Vue fiber
// 掛載(streaming hydration),會拿到假陰性 false 並永久記住 → 該 element 後續被框架
// 接管後仍走 single innerHTML 注入,撞 React fiber 孤兒(facebook/react#11538 同類)。
//
// 修法:`if (result) _fwQueryCache.set(el, result)` —— 只快取 true,false 不快取下次重查。
//
// 測法:main world 裝 shinkansen-fw-detect-request 計數器。對同一 element 連呼兩次
// isFrameworkManaged:
//   - plain-el(false):false 不快取 → 兩次都重派 request(計數=2)
//   - react-el(true) :true 有快取 → 第二次走快取不重派(計數=1)
// plain-el 的計數=2 是區分修法的關鍵(bug 時 false 被快取 → 計數=1)。
//
// SANITY 紀錄(已驗證):把 content-ns.js 的 `if (result)` 拿掉(恢復成永遠
// _fwQueryCache.set(el, result))→ 本 spec fail(plain-el 計數變 1);還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('isFrameworkManaged 只快取 true,false 結果不快取會重查', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/fw-detect-cache.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#plain-el', { timeout: 10_000 });

  // main world:給 react-el 掛 React fiber expando(必須在第一次偵測前)+ 裝 request 計數器
  await page.evaluate(() => {
    document.getElementById('react-el').__reactFiber$test = {};
    window.__fwReqByTarget = {};
    window.addEventListener('shinkansen-fw-detect-request', (e) => {
      const id = e.target?.id || '?';
      window.__fwReqByTarget[id] = (window.__fwReqByTarget[id] || 0) + 1;
    }, true);
  });

  const { evaluate } = await getShinkansenEvaluator(page);

  const plain1 = await evaluate(`window.__SK.isFrameworkManaged(document.getElementById('plain-el'))`);
  const plain2 = await evaluate(`window.__SK.isFrameworkManaged(document.getElementById('plain-el'))`);
  const react1 = await evaluate(`window.__SK.isFrameworkManaged(document.getElementById('react-el'))`);
  const react2 = await evaluate(`window.__SK.isFrameworkManaged(document.getElementById('react-el'))`);

  const reqs = await page.evaluate(() => window.__fwReqByTarget);

  expect(plain1).toBe(false);
  expect(plain2).toBe(false);
  expect(react1).toBe(true);
  expect(react2).toBe(true);

  // false 不快取 → 兩次都重查
  expect(reqs['plain-el']).toBe(2);
  // true 有快取 → 第二次不重派 request
  expect(reqs['react-el']).toBe(1);
});
