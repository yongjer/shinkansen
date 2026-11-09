// Regression: spa-prescan-intersection-observer (v1.9.28 Layer 14)
//
// SPEC-PRIVATE §25.20 Finding 3 stall「I love your works ❤」100% × 5/5 的 ship 修法。
// IntersectionObserver `rootMargin:1000px` 觀察 PRESCAN_SELECTORS 命中元素,
// 「即將進 viewport」時走 100ms 微 batch → `triggerSpaObserverRescan`,跳過 SPA
// observer 1s debounce + 2s maxWait。
//
// 走同條 `spaObserverRescan`(by-text reuse / seen-texts TTL / tiny silent /
// 800ms loading delay 全 inherit),不另開 pipeline。
//
// 本 spec 驗:
//   1. PRESCAN_HOSTS 預設 x.com / twitter.com,getPrescanConfig 對 mobile.twitter.com 命中
//   2. getPrescanConfig 對非命中 host(medium.com)回 null
//   3. host 不命中時 startPrescanObserver no-op
//   4. host 命中時 startPrescanObserver 啟動 IO + 初始 observe
//   5. MO 攔後續 mount 進 DOM 的 selector 元素 → IO observed count 增加
//   6. IO isIntersecting:true callback → 100ms 後 triggerSpaObserverRescan 被 call
//   7. 100ms 內多次 IO fire → batch 合成 1 次 rescan(防 over-fire)
//   8. stopSpaObserver 同步 stop prescan(prescanIO disconnect + scheduledTimer 清除)
//
// SANITY 紀錄(已驗證):暫拿掉 100ms batch window(改 0ms 立即 fire) → 連續 3 entry
// 各觸發 1 次 rescan(spec 6 期望 scheduled=1 → 變 scheduled=3 → fail),還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('Layer 14:常數有定義 + 預設 PRESCAN_HOSTS 含 x.com / twitter.com', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const consts = await evaluate(`JSON.stringify({
    batchMs: window.__SK.PRESCAN_BATCH_WINDOW_MS,
    rootMargin: window.__SK.PRESCAN_ROOT_MARGIN,
    hosts: window.__SK.PRESCAN_HOSTS,
    xSelector: window.__SK.PRESCAN_SELECTORS['x.com'],
    twitterSelector: window.__SK.PRESCAN_SELECTORS['twitter.com'],
  })`);
  const c = typeof consts === 'string' ? JSON.parse(consts) : consts;
  expect(c.batchMs, 'batch window 預設 100ms').toBe(100);
  expect(c.rootMargin, 'rootMargin 1000px(POC 實測 IO fire 比 user dwell 早 ~3.3s)').toBe('1000px');
  expect(c.hosts, '預設含 x.com / twitter.com').toEqual(expect.arrayContaining(['x.com', 'twitter.com']));
  expect(c.xSelector, 'x.com selector 含 tweetText + 排除已翻').toContain('tweetText');
  expect(c.xSelector).toContain(':not([data-shinkansen-translated])');
  expect(c.twitterSelector).toBe(c.xSelector);

  await page.close();
});

test('Layer 14:getPrescanConfig 對 subdomain 命中(mobile.twitter.com / www.x.com)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`JSON.stringify({
    xRoot: window.__SK.getPrescanConfig('x.com'),
    xSub: window.__SK.getPrescanConfig('www.x.com'),
    twSub: window.__SK.getPrescanConfig('mobile.twitter.com'),
    medium: window.__SK.getPrescanConfig('medium.com'),
    empty: window.__SK.getPrescanConfig(''),
  })`);
  const parsed = typeof r === 'string' ? JSON.parse(r) : r;
  expect(parsed.xRoot?.matched, 'x.com 命中').toBe('x.com');
  expect(parsed.xSub?.matched, 'www.x.com 命中 endsWith(.x.com)').toBe('x.com');
  expect(parsed.twSub?.matched, 'mobile.twitter.com 命中 endsWith(.twitter.com)').toBe('twitter.com');
  expect(parsed.xRoot?.selector).toContain('tweetText');
  expect(parsed.medium, '非命中 host 回 null').toBeNull();
  expect(parsed.empty, '空 host 回 null').toBeNull();

  await page.close();
});

test('Layer 14:host 不命中 → startPrescanObserver no-op(_prescanDebug.active=false)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 確保 PRESCAN_HOSTS 不含 fixture host(127.0.0.1)
  const result = await evaluate(`
    (() => {
      window.__SK._stopPrescanObserver();
      const before = window.__SK._prescanDebug();
      window.__SK._startPrescanObserver();
      const after = window.__SK._prescanDebug();
      return JSON.stringify({ before, after });
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.before.active, '初始未啟動').toBe(false);
  expect(r.after.active, '非命中 host 不該啟動 IO').toBe(false);
  expect(r.after.observed, '無 element observed').toBe(0);

  await page.close();
});

test('Layer 14:白箱注入命中 host + 預載元素 → startPrescanObserver 啟動 + 初始 observe', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK._stopPrescanObserver();
      // 白箱:把 fixture host 加進 PRESCAN_SELECTORS(同 selector)
      const fixtureHost = location.hostname;
      const origHosts = [...SK.PRESCAN_HOSTS];
      const origSelectorEntry = SK.PRESCAN_SELECTORS[fixtureHost];
      SK.PRESCAN_HOSTS.push(fixtureHost);
      SK.PRESCAN_SELECTORS[fixtureHost] = '[data-testid="tweetText"]';

      // 預先 mount 3 個假 tweetText
      const container = document.createElement('div');
      container.id = '__test_tweet_container__';
      for (let i = 0; i < 3; i++) {
        const t = document.createElement('div');
        t.setAttribute('data-testid', 'tweetText');
        t.textContent = 'tweet ' + i;
        container.appendChild(t);
      }
      document.body.appendChild(container);

      try {
        SK._startPrescanObserver();
        const dbg = SK._prescanDebug();
        return JSON.stringify({ dbg, host: fixtureHost });
      } finally {
        // restore
        SK._stopPrescanObserver();
        SK.PRESCAN_HOSTS.length = 0;
        for (const h of origHosts) SK.PRESCAN_HOSTS.push(h);
        if (origSelectorEntry == null) delete SK.PRESCAN_SELECTORS[fixtureHost];
        else SK.PRESCAN_SELECTORS[fixtureHost] = origSelectorEntry;
        container.remove();
      }
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.dbg.active, 'IO 應啟動').toBe(true);
  expect(r.dbg.observed, '3 個初始 element 被 observe').toBe(3);

  await page.close();
});

test('Layer 14:MO 攔截後續 mount 的命中元素 → observed count 增加', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      SK._stopPrescanObserver();
      const fixtureHost = location.hostname;
      const origHosts = [...SK.PRESCAN_HOSTS];
      const origSelectorEntry = SK.PRESCAN_SELECTORS[fixtureHost];
      SK.PRESCAN_HOSTS.push(fixtureHost);
      SK.PRESCAN_SELECTORS[fixtureHost] = '[data-testid="tweetText"]';
      const container = document.createElement('div');
      container.id = '__test_late_mount__';
      document.body.appendChild(container);

      try {
        SK._startPrescanObserver();
        const before = SK._prescanDebug();

        // 後續 mount 2 個 tweetText
        for (let i = 0; i < 2; i++) {
          const t = document.createElement('div');
          t.setAttribute('data-testid', 'tweetText');
          t.textContent = 'late tweet ' + i;
          container.appendChild(t);
        }
        // 也 mount 1 個非 selector 命中的 element 對照
        const noise = document.createElement('div');
        noise.textContent = 'noise';
        container.appendChild(noise);

        // 等 MO microtask 跑
        await new Promise(r => setTimeout(r, 20));
        const after = SK._prescanDebug();
        return JSON.stringify({ before, after });
      } finally {
        SK._stopPrescanObserver();
        SK.PRESCAN_HOSTS.length = 0;
        for (const h of origHosts) SK.PRESCAN_HOSTS.push(h);
        if (origSelectorEntry == null) delete SK.PRESCAN_SELECTORS[fixtureHost];
        else SK.PRESCAN_SELECTORS[fixtureHost] = origSelectorEntry;
        container.remove();
      }
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.before.observed, '初始無預載 element').toBe(0);
  expect(r.after.observed, '後續 mount 2 個 tweetText 應被 MO 攔到 + observe').toBe(2);

  await page.close();
});

test('Layer 14:IO fire callback → 100ms 後 triggerSpaObserverRescan 被 call', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      SK._stopPrescanObserver();
      const fixtureHost = location.hostname;
      const origHosts = [...SK.PRESCAN_HOSTS];
      const origSelectorEntry = SK.PRESCAN_SELECTORS[fixtureHost];
      SK.PRESCAN_HOSTS.push(fixtureHost);
      SK.PRESCAN_SELECTORS[fixtureHost] = '[data-testid="tweetText"]';

      // stub IntersectionObserver 讓 spec 可控觸發 callback
      const origIO = window.IntersectionObserver;
      let capturedCallback = null;
      const observeCalls = [];
      window.IntersectionObserver = function(cb, opts) {
        capturedCallback = cb;
        return {
          observe(el) { observeCalls.push(el); },
          unobserve(el) {},
          disconnect() {},
        };
      };

      // 預載 1 個 element
      const container = document.createElement('div');
      const t = document.createElement('div');
      t.setAttribute('data-testid', 'tweetText');
      t.textContent = 'trigger me';
      container.appendChild(t);
      document.body.appendChild(container);

      // stub triggerSpaObserverRescan(用 SK.STATE.translated=true + 覆寫 spaObserverRescan)
      let rescanCalls = 0;
      const origRescan = SK._spaObserverRescan_orig || SK.spaObserverRescan;
      SK.STATE.translated = true;  // 讓 schedulePrescanRescan 不被 STATE.translated=false early return 擋住
      // 替換 triggerSpaObserverRescan 行為:不真翻譯,只計數
      // 走偷天換日:把 collectParagraphs stub 成回 [] 讓 spaObserverRescan 早返
      const origCollect = SK.collectParagraphs;
      SK.collectParagraphs = () => { rescanCalls++; return []; };

      try {
        SK._startPrescanObserver();
        // 確認 IO observed
        if (observeCalls.length !== 1) throw new Error('expected 1 observe call, got ' + observeCalls.length);
        if (!capturedCallback) throw new Error('IO callback 未捕獲');

        // 觸發 fake IO entry isIntersecting:true
        capturedCallback([{ isIntersecting: true, target: observeCalls[0] }]);
        const immediately = SK._prescanDebug();

        // 等 batch window(100ms)+ 安全 margin
        await new Promise(r => setTimeout(r, 200));
        const afterBatch = SK._prescanDebug();

        return JSON.stringify({ immediately, afterBatch, rescanCalls });
      } finally {
        SK._stopPrescanObserver();
        window.IntersectionObserver = origIO;
        SK.collectParagraphs = origCollect;
        SK.STATE.translated = false;
        SK.PRESCAN_HOSTS.length = 0;
        for (const h of origHosts) SK.PRESCAN_HOSTS.push(h);
        if (origSelectorEntry == null) delete SK.PRESCAN_SELECTORS[fixtureHost];
        else SK.PRESCAN_SELECTORS[fixtureHost] = origSelectorEntry;
        container.remove();
      }
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.immediately.fires, 'IO fire 計數 +1').toBe(1);
  expect(r.immediately.scheduledTimerArmed, '立即 timer armed').toBe(true);
  expect(r.immediately.scheduled, 'scheduled count +1').toBe(1);
  expect(r.rescanCalls, '100ms 後 rescan 應被 call(collectParagraphs stub 計數)').toBe(1);
  expect(r.afterBatch.scheduledTimerArmed, '100ms 後 timer 已 fire').toBe(false);

  await page.close();
});

test('Layer 14:100ms 內多次 IO fire → batch 合成 1 次 rescan(防 over-fire)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      SK._stopPrescanObserver();
      const fixtureHost = location.hostname;
      const origHosts = [...SK.PRESCAN_HOSTS];
      const origSelectorEntry = SK.PRESCAN_SELECTORS[fixtureHost];
      SK.PRESCAN_HOSTS.push(fixtureHost);
      SK.PRESCAN_SELECTORS[fixtureHost] = '[data-testid="tweetText"]';

      const origIO = window.IntersectionObserver;
      let capturedCallback = null;
      const observeCalls = [];
      window.IntersectionObserver = function(cb, opts) {
        capturedCallback = cb;
        return {
          observe(el) { observeCalls.push(el); },
          unobserve(el) {},
          disconnect() {},
        };
      };

      // 預載 5 個 element
      const container = document.createElement('div');
      for (let i = 0; i < 5; i++) {
        const t = document.createElement('div');
        t.setAttribute('data-testid', 'tweetText');
        t.textContent = 'tweet ' + i;
        container.appendChild(t);
      }
      document.body.appendChild(container);

      SK.STATE.translated = true;
      let rescanCalls = 0;
      const origCollect = SK.collectParagraphs;
      SK.collectParagraphs = () => { rescanCalls++; return []; };

      try {
        SK._startPrescanObserver();
        if (observeCalls.length !== 5) throw new Error('expected 5 observe, got ' + observeCalls.length);

        // 50ms 內連續 fire 5 次 IO callback,每次帶 1 個 entry
        for (let i = 0; i < 5; i++) {
          capturedCallback([{ isIntersecting: true, target: observeCalls[i] }]);
          await new Promise(r => setTimeout(r, 10));
        }
        const after5fires = SK._prescanDebug();

        // 等 batch window 結束
        await new Promise(r => setTimeout(r, 200));
        const final = SK._prescanDebug();

        return JSON.stringify({ after5fires, final, rescanCalls });
      } finally {
        SK._stopPrescanObserver();
        window.IntersectionObserver = origIO;
        SK.collectParagraphs = origCollect;
        SK.STATE.translated = false;
        SK.PRESCAN_HOSTS.length = 0;
        for (const h of origHosts) SK.PRESCAN_HOSTS.push(h);
        if (origSelectorEntry == null) delete SK.PRESCAN_SELECTORS[fixtureHost];
        else SK.PRESCAN_SELECTORS[fixtureHost] = origSelectorEntry;
        container.remove();
      }
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.after5fires.fires, '5 次 fire 都計數').toBe(5);
  expect(r.after5fires.scheduled, '5 次 fire 100ms 內只 schedule 1 次').toBe(1);
  expect(r.rescanCalls, 'rescan 只 call 1 次(batch coalesce)').toBe(1);

  await page.close();
});

test('Layer 14:stopSpaObserver 同步 stop prescan(IO disconnect + scheduledTimer 清除)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      SK._stopPrescanObserver();
      const fixtureHost = location.hostname;
      const origHosts = [...SK.PRESCAN_HOSTS];
      const origSelectorEntry = SK.PRESCAN_SELECTORS[fixtureHost];
      SK.PRESCAN_HOSTS.push(fixtureHost);
      SK.PRESCAN_SELECTORS[fixtureHost] = '[data-testid="tweetText"]';

      const origIO = window.IntersectionObserver;
      let capturedCallback = null;
      let disconnected = false;
      window.IntersectionObserver = function(cb) {
        capturedCallback = cb;
        return {
          observe(el) {},
          unobserve(el) {},
          disconnect() { disconnected = true; },
        };
      };

      try {
        SK._startPrescanObserver();
        const beforeStop = SK._prescanDebug();
        // schedule 一個 timer,讓 stop 也要清掉
        SK.STATE.translated = true;
        capturedCallback([{ isIntersecting: true, target: document.body }]);
        const afterFire = SK._prescanDebug();

        // 走 stopSpaObserver(不是直接 _stopPrescanObserver,驗 lifecycle 接點)
        SK.stopSpaObserver();
        const afterStop = SK._prescanDebug();

        return JSON.stringify({ beforeStop, afterFire, afterStop, disconnected });
      } finally {
        window.IntersectionObserver = origIO;
        SK.STATE.translated = false;
        SK.PRESCAN_HOSTS.length = 0;
        for (const h of origHosts) SK.PRESCAN_HOSTS.push(h);
        if (origSelectorEntry == null) delete SK.PRESCAN_SELECTORS[fixtureHost];
        else SK.PRESCAN_SELECTORS[fixtureHost] = origSelectorEntry;
      }
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(r.beforeStop.active, 'stop 前 IO 活躍').toBe(true);
  expect(r.afterFire.scheduledTimerArmed, 'fire 後 timer armed').toBe(true);
  expect(r.afterStop.active, 'stopSpaObserver 後 IO 停').toBe(false);
  expect(r.afterStop.scheduledTimerArmed, 'stop 後 timer 清除').toBe(false);
  expect(r.disconnected, 'IO.disconnect 被 call').toBe(true);

  await page.close();
});
