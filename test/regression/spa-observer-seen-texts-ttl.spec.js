// Regression: spaObserverSeenTexts TTL(從永久鎖改成冷卻鎖)
//
// Bug:framework(典型 YouTube hover description 觸發 yt-attributed-string re-render)把
// 譯後 element 重新 render 為原文。SPA observer 第 1 次抓到新內容、走 cache hit 救回中文,
// 但 spaObserverSeenTexts 把該段原文永久標記為 seen 之後,後續 hover 全被
// "all units already seen in this session, skipping" 擋下,即便 cache 裡明明有譯文,
// 也不允許再 inject——使用者第 2 次 hover 後永遠是英文。
//
// 修法:把 spaObserverSeenTexts 從 Set<text> 改成 Map<text, lastSeenMs> + TTL。
// TTL 內視為已 seen → skip(防 widget 高頻 burst);TTL 過期允許重 inject。
// Cache 已有譯文,inject 0 API 成本,TTL 過期重 inject 不會爆 cost。
//
// v1.9.8 起 TTL 從 1500 → 30000(30 秒)。原 1.5s 是給 YouTube hover description
// 短時間重 render 設,但 X / Reddit / Threads / Mastodon 等虛擬化 timeline scroll
// 上下間隔常 > 1.5s,過期後同段 fragment 推文(by-text reuse 不收 fragment)反覆
// 進 translateUnitsByProvider → 偶有 cache miss 真打 API + success toast 噪音。
// YouTube hover 場景 30s 內 byText cache 已存,inject 路徑直接 reuse 不依賴 seen-text,
// 行為不變。
//
// SANITY 紀錄(已驗證):暫時把 isSeenTextRecent 改成「永遠 return true 若 has(text)」
// (即還原舊版 Set 永久鎖行為),test 2 (TTL 過期應放行) fail;還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('seenTexts TTL 內第二次出現的同段原文應被 skip', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      // 模擬「同段原文 100ms 內第 N 次出現」場景
      const text = 'sample-text-' + Math.random().toString(36).slice(2);
      const seenMap = SK._spaObserverSeenTexts;
      seenMap.clear();
      const beforeFirst = SK._isSeenTextRecent(text);
      seenMap.set(text, Date.now());
      const afterFirst = SK._isSeenTextRecent(text);
      // 100ms 後再查
      return new Promise(resolve => {
        setTimeout(() => {
          const after100ms = SK._isSeenTextRecent(text);
          resolve({ beforeFirst, afterFirst, after100ms, ttl: SK._SPA_OBSERVER_SEEN_TEXTS_TTL_MS });
        }, 100);
      });
    })()
  `);

  expect(result.beforeFirst, '第一次查 seen 應為 false').toBe(false);
  expect(result.afterFirst, '記錄後馬上查 seen 應為 true').toBe(true);
  expect(result.after100ms, 'TTL(30 秒)內第 N 次查仍應為 true(skip)').toBe(true);
  expect(result.ttl, 'v1.9.8 起 TTL 應為 30000ms(1.5s → 30s 拉長對 SPA scroll virtualization)').toBe(30_000);

  await page.close();
});

test('seenTexts TTL 過期後同段原文應允許重 inject', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 在 isolated world 把 entry 寫成「過期時間」(now - TTL - 100ms),驗 isSeenTextRecent
  // 立刻認定它過期 + 順手 GC 掉。不真的 sleep 2 秒以加快測試。
  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const text = 'expired-text-' + Math.random().toString(36).slice(2);
      const seenMap = SK._spaObserverSeenTexts;
      seenMap.clear();
      const ttl = SK._SPA_OBSERVER_SEEN_TEXTS_TTL_MS;
      const expiredTs = Date.now() - ttl - 100;
      seenMap.set(text, expiredTs);
      const sizeBefore = seenMap.size;
      const recent = SK._isSeenTextRecent(text);
      const sizeAfter = seenMap.size;
      return { recent, sizeBefore, sizeAfter };
    })()
  `);

  expect(result.recent, 'TTL 過期的 entry isSeenTextRecent 應為 false(允許重 inject)').toBe(false);
  expect(result.sizeBefore, 'set 後 size=1').toBe(1);
  expect(result.sizeAfter, '過期 entry 應被順手 GC,size=0').toBe(0);

  await page.close();
});

test('seenTexts.set 第二次寫入應更新 lastSeenMs(滑動視窗)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 同段文字反覆出現 → 每次更新 lastSeenMs → 持續被視為 seen 直到「最後一次出現」過 TTL
  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const text = 'sliding-' + Math.random().toString(36).slice(2);
      const seenMap = SK._spaObserverSeenTexts;
      seenMap.clear();
      const t1 = Date.now() - 800; // 0.8 秒前 set(在 30s TTL 內)
      seenMap.set(text, t1);
      const recentAtBefore = SK._isSeenTextRecent(text);
      // 重 set 為 now → 0.8 秒前的時鐘被覆蓋
      seenMap.set(text, Date.now());
      const lastSeenAfterReset = seenMap.get(text);
      return { recentAtBefore, lastSeenChanged: lastSeenAfterReset !== t1 };
    })()
  `);

  expect(result.recentAtBefore, '0.8 秒前 set 仍在 TTL(30s)內,應 recent=true').toBe(true);
  expect(result.lastSeenChanged, '第二次 set 應覆蓋舊 timestamp(滑動視窗)').toBe(true);

  await page.close();
});
