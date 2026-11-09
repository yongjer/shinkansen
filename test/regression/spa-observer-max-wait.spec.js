// Regression: SPA observer maxWait timer
//
// Bug:Twitter / Reddit / Threads / Mastodon 等 virtualized scroll 站,使用者連續
// 滑動期間 mutation 不停進來,純 idle debounce(SPA_OBSERVER_DEBOUNCE_MS=1000)
// 一直被 reset → spaObserverRescan 永遠不 fire → reply 區譯文遲遲不出現
// (使用者要停手 ≥1 秒 + batch 5-10 秒,共 6-11 秒)。
//
// 修法:加 maxWait timer(SPA_OBSERVER_MAX_WAIT_MS=2000),從第一次 arm 起算
// 連續 mutation 也每 2 秒強制 fire 一次 rescan,使用者連續滑也會週期性看到譯文
// 追上。idle / maxWait 哪個先 fire 都 trigger,另一個 cancel。
//
// SANITY 紀錄(已驗證):暫時把 armSpaObserverRescan 內 `if (!spaObserverMaxWaitTimer)`
// 拿掉、改成「每次 arm 都重新 set maxWait」(等同退化成純 debounce 永遠 reset),
// test 「連續 arm,maxWait timer 不應被 reset」 fail;還原 fix → 全綠。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('SPA_OBSERVER_MAX_WAIT_MS 常數值 = 2000(forcing function)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const value = await evaluate(`window.__SK.SPA_OBSERVER_MAX_WAIT_MS`);
  expect(value, 'SPA_OBSERVER_MAX_WAIT_MS 應為 2000ms (idle debounce 1s + maxWait 2s 體感折衷)').toBe(2000);

  await page.close();
});

test('第一次 arm 後 idle + maxWait timer 都 active', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      // 確保乾淨起點
      SK.stopSpaObserver();
      SK.STATE.translated = true;  // 讓 startSpaObserver 不會在第一次 fire 立刻退出
      SK.startSpaObserver();
      const before = SK._spaDebug();
      SK._armSpaObserverRescan();
      const after = SK._spaDebug();
      // 清理 — 避免影響其他 test
      SK.stopSpaObserver();
      SK.STATE.translated = false;
      return { before, after };
    })()
  `);

  expect(result.before.debounceArmed, 'arm 前 idle timer 應未 active').toBe(false);
  expect(result.before.maxWaitArmed, 'arm 前 maxWait timer 應未 active').toBe(false);
  expect(result.after.debounceArmed, 'arm 後 idle timer 應 active').toBe(true);
  expect(result.after.maxWaitArmed, 'arm 後 maxWait timer 應 active').toBe(true);

  await page.close();
});

test('連續 arm:idle timer reset、maxWait timer 不 reset(維持原始 deadline)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 把 maxWait 暫時設小,測試「maxWait deadline 不被 reset」: 第一次 arm 後 200ms 第二次 arm,
  // 再過 80ms(總 280ms,> maxWait 250)maxWait 應 fire(timer 已被 trigger 清掉)。
  // 若 bug — 第二次 arm reset maxWait → 第二次起算 250ms 才 fire → 280ms 時還 armed。
  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      SK.stopSpaObserver();
      SK.STATE.translated = true;
      SK.startSpaObserver();
      const origMaxWait = SK.SPA_OBSERVER_MAX_WAIT_MS;
      const origDebounce = SK.SPA_OBSERVER_DEBOUNCE_MS;
      SK.SPA_OBSERVER_MAX_WAIT_MS = 250;
      SK.SPA_OBSERVER_DEBOUNCE_MS = 5000;  // idle 大到絕對不會在測試期間 fire
      SK._armSpaObserverRescan();
      const t0 = SK._spaDebug();
      await new Promise(r => setTimeout(r, 200));  // 第一次 arm 後 200ms
      SK._armSpaObserverRescan();
      const t200 = SK._spaDebug();
      await new Promise(r => setTimeout(r, 80));   // 總 t=280ms,超過原 maxWait 250
      const t280 = SK._spaDebug();
      // 還原
      SK.SPA_OBSERVER_MAX_WAIT_MS = origMaxWait;
      SK.SPA_OBSERVER_DEBOUNCE_MS = origDebounce;
      SK.stopSpaObserver();
      SK.STATE.translated = false;
      return { t0, t200, t280 };
    })()
  `);

  expect(result.t0.maxWaitArmed, 'arm 後 maxWait 應 active').toBe(true);
  expect(result.t200.maxWaitArmed, '第二次 arm 時 maxWait 仍應 active(沒到 deadline)').toBe(true);
  expect(result.t280.maxWaitArmed, 't=280ms 超過原 maxWait deadline,timer 應已 fire 並 clear').toBe(false);

  await page.close();
});

test('stopSpaObserver 清掉兩個 timer', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK.stopSpaObserver();
      SK.STATE.translated = true;
      SK.startSpaObserver();
      SK._armSpaObserverRescan();
      const armed = SK._spaDebug();
      SK.stopSpaObserver();
      const stopped = SK._spaDebug();
      SK.STATE.translated = false;
      return { armed, stopped };
    })()
  `);

  expect(result.armed.debounceArmed, 'arm 後 idle active').toBe(true);
  expect(result.armed.maxWaitArmed, 'arm 後 maxWait active').toBe(true);
  expect(result.stopped.debounceArmed, 'stop 後 idle 應 clear').toBe(false);
  expect(result.stopped.maxWaitArmed, 'stop 後 maxWait 應 clear').toBe(false);
  expect(result.stopped.observerActive, 'stop 後 observer 應 inactive').toBe(false);

  await page.close();
});
