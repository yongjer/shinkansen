// Regression: spa-observer-fast-host (v1.9.27 Layer 13 — 預設關)
//
// SK.getObserverTiming(hostname) per-host debounce/maxWait 機制,架構保留但 FAST_HOSTS 暫空。
//
// v1.9.27 兩次嘗試都沒救 Finding 3 X 串尾 stall(SPEC-PRIVATE §25.20.5 + §25.20.9):
//   1. debounce 250/maxWait 500:連續 mutation 各觸發迷你 batch,toast 18s 體感差,revert
//   2. debounce 1000/maxWait 500:over-fire 沒發生但 stall 沒解(2/2 runs 仍 100%)
//
// Root cause:不在 timing,在 detect 路徑(SPA observer 第一輪 mount 後沒抓到該 tweet,
// 後續 rescan 補但 > 3s window)。正解需 IntersectionObserver rootMargin pre-scan(下輪)。
//
// 本 spec 驗:
// 1. 常數有定義且 FAST_HOSTS 預設空 → 所有真實 host 回 default
// 2. 若未來 FAST_HOSTS 加值 → 該 host 回 fast(白箱驗,確保未來 enable 對映正確)
// SANITY:暫拿掉 FAST_HOSTS 命中比對 → 仍空名單仍 default → spec 仍 pass(因 FAST_HOSTS 空)
// 改用「加 host 進 FAST_HOSTS 後預期 fast」測 SANITY。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('Layer 13:常數有定義且 FAST_HOSTS 預設空,所有真實 host 回 default', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const consts = await evaluate(`JSON.stringify({fast_deb: window.__SK.SPA_OBSERVER_FAST_DEBOUNCE_MS, fast_mw: window.__SK.SPA_OBSERVER_FAST_MAX_WAIT_MS, default_deb: window.__SK.SPA_OBSERVER_DEBOUNCE_MS, default_mw: window.__SK.SPA_OBSERVER_MAX_WAIT_MS, hosts_len: window.__SK.SPA_OBSERVER_FAST_HOSTS.length})`);
  const c = typeof consts === 'string' ? JSON.parse(consts) : consts;
  expect(c.default_deb).toBe(1000);
  expect(c.default_mw).toBe(2000);
  expect(c.fast_deb, 'fast debounce 同 default(架構保留)').toBe(1000);
  expect(c.fast_mw, 'fast maxWait 500ms 常數仍定義').toBe(500);
  expect(c.hosts_len, 'v1.9.27 FAST_HOSTS 暫空(兩次嘗試都未解 Finding 3)').toBe(0);

  const cases = ['x.com', 'twitter.com', 'threads.net', 'reddit.com', 'mastodon.social', 'medium.com', 'nytimes.com'];
  for (const host of cases) {
    const result = await evaluate(`JSON.stringify(window.__SK.getObserverTiming(${JSON.stringify(host)}))`);
    const timing = typeof result === 'string' ? JSON.parse(result) : result;
    expect(timing.profile, `host=${host} 應為 default(FAST_HOSTS 空)`).toBe('default');
    expect(timing.debounce).toBe(1000);
    expect(timing.maxWait).toBe(2000);
  }
  await page.close();
});

test('Layer 13:若未來 FAST_HOSTS 加值,該 host 回 fast(白箱驗:臨時注入名單)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const orig = [...SK.SPA_OBSERVER_FAST_HOSTS];
      SK.SPA_OBSERVER_FAST_HOSTS.push('x.com', 'twitter.com');
      try {
        const r1 = SK.getObserverTiming('x.com');
        const r2 = SK.getObserverTiming('mobile.twitter.com');
        const r3 = SK.getObserverTiming('medium.com');
        return JSON.stringify({r1, r2, r3});
      } finally {
        SK.SPA_OBSERVER_FAST_HOSTS.length = 0;
        for (const h of orig) SK.SPA_OBSERVER_FAST_HOSTS.push(h);
      }
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.r1.profile, 'x.com 加進 FAST_HOSTS 後應 fast').toBe('fast');
  expect(r.r1.maxWait, 'fast maxWait 500ms').toBe(500);
  expect(r.r2.profile, 'mobile.twitter.com 命中 endsWith(.twitter.com)').toBe('fast');
  expect(r.r3.profile, '不在名單的 medium.com 維持 default').toBe('default');
  await page.close();
});

test('Layer 13:空 hostname 走 default', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  for (const empty of ['', null, undefined]) {
    const arg = empty === undefined ? 'undefined' : JSON.stringify(empty);
    const result = await evaluate(`JSON.stringify(window.__SK.getObserverTiming(${arg}))`);
    const timing = typeof result === 'string' ? JSON.parse(result) : result;
    expect(timing.profile, `empty=${arg} 應 default`).toBe('default');
  }
  await page.close();
});
