// Regression: rescan-abort-restore-guard (v1.10.46 批次 2-4)
//
// Fixture: test/regression/fixtures/rescan-abort-restore-guard.html
//
// Bug:rescanTick(content.js)與 spaObserverRescan(content-spa.js)呼叫
// SK.translateUnitsByProvider(newUnits) 不帶 signal → translateUnits 注入前的
// `signal?.aborted` guard(v1.10.20 加的)全是 undefined 放行——使用者還原頁面
// (restorePage)後,晚到的 rescan 批次回應仍把譯文注回乾淨頁面,DOM 帶
// data-shinkansen-translated 但 STATE.translated=false 的殭屍狀態。
//
// 修法:translateUnitsByProvider(兩條 rescan 路徑統一入口)在呼叫端沒自帶 signal
// 時掛上 rescan AbortController(SK.getRescanSignal);restorePage /
// restoreOriginalHTMLAndReset / resetForSpaNavigation 都 abort 它
// (SK.abortRescanRuns)。runWithConcurrency 同輪改收 signal 參數,不再讀全域
// STATE.abortController(跨輪耦合)。
//
// 本 spec 走完整真實路徑:translatePage 翻完 → 加入 late content → 走 rescan 入口
// translateUnitsByProvider(慢批次 in-flight)→ 使用者還原(translatePage toggle →
// restorePage)→ 慢批次 settle → 斷言 late content 沒被注入譯文。
//
// SANITY 紀錄(已驗證,2026-06-11):
//   暫時把 translateUnitsByProvider 的 `if (!opts.signal) opts = {...}` signal
//   wiring 註解掉 → 「還原後晚到的 rescan 批次不得注入」fail(#late 出現 [ZH2]
//   且帶 data-shinkansen-translated)→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'rescan-abort-restore-guard';

test('還原頁面後,晚到的 rescan 批次不得把譯文注回乾淨頁面', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para-1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock 訊息層:streaming 失敗 → non-streaming TRANSLATE_BATCH。
  // 預設立即回 '[ZH1] ';window.__slowMode = true 後改為 delay 2.5s 回 '[ZH2] '
  // (模擬 rescan 的慢批次 in-flight)。
  await evaluate(`
    window.__slowMode = false;
    window.__batchCall = 0;
    chrome.storage.sync.get = async function(keys) {
      return {
        apiKey: 'test-key-not-used',
        glossary: { enabled: false },
        partialMode: { enabled: false, maxUnits: 25 },
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 20,
        maxCharsPerBatch: 100000,
      };
    };
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        return { ok: false, error: 'streaming disabled in test' };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCall++;
        const texts = (msg.payload && msg.payload.texts) || [];
        const tag = window.__slowMode ? '[ZH2] ' : '[ZH1] ';
        const reply = {
          ok: true,
          result: texts.map(t => tag + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
        if (window.__slowMode) {
          return new Promise(r => setTimeout(() => r(reply), 2500));
        }
        return reply;
      }
      return { ok: true };
    };
  `);

  // 第一輪:正常翻完整頁(設定 STATE.translated / translationContext)
  await evaluate(`window.__SK.translatePage()`);
  const afterRun1 = JSON.parse(await evaluate(`
    JSON.stringify({
      translated: window.__SK.STATE.translated,
      para1: document.getElementById('para-1').innerText,
    })
  `));
  expect(afterRun1.translated).toBe(true);
  expect(afterRun1.para1).toContain('[ZH1]');

  // 加入 late content + 切換慢批次模式,走真實 rescan 入口 translateUnitsByProvider
  await evaluate(`
    window.__slowMode = true;
    const zone = document.getElementById('late-zone');
    zone.innerHTML = '<p id="late">This late paragraph appears after the initial translation finished loading.</p>';
    const newUnits = window.__SK.collectParagraphs();
    window.__lateCount = newUnits.length;
    window.__rescan = window.__SK.translateUnitsByProvider(newUnits).catch(e => null);
    null
  `);
  const lateCount = await evaluate(`window.__lateCount`);
  expect(Number(lateCount), 'rescan 應收集到 late content').toBeGreaterThan(0);

  // 慢批次 in-flight 期間,使用者還原頁面(translatePage toggle → restorePage)
  await page.waitForTimeout(400);
  await evaluate(`window.__SK.translatePage()`);
  const afterRestore = JSON.parse(await evaluate(`
    JSON.stringify({
      translated: window.__SK.STATE.translated,
      para1: document.getElementById('para-1').innerText,
    })
  `));
  expect(afterRestore.translated, 'toggle 應已還原').toBe(false);
  expect(afterRestore.para1).not.toContain('[ZH');

  // 等 rescan 慢批次 settle(2.5s delay)再驗
  await evaluate(`window.__rescan`);
  await page.waitForTimeout(300);

  // 核心斷言:還原後晚到的 rescan 批次不得注入
  const finalState = JSON.parse(await evaluate(`
    JSON.stringify({
      late: document.getElementById('late').innerText,
      lateMarked: document.getElementById('late').hasAttribute('data-shinkansen-translated'),
      para1: document.getElementById('para-1').innerText,
      translated: window.__SK.STATE.translated,
    })
  `));
  expect(finalState.late, '還原後晚到的 rescan 批次不得注入譯文').not.toContain('[ZH');
  expect(finalState.lateMarked, '不得殘留 data-shinkansen-translated 殭屍標記').toBe(false);
  expect(finalState.para1, '已還原段落不得再變回譯文').not.toContain('[ZH');
  expect(finalState.translated).toBe(false);
});

test('還原後重新翻譯:新一輪 rescan 拿到新 signal,正常注入(abort 不黏住下一輪)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para-1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    chrome.storage.sync.get = async function(keys) {
      return {
        apiKey: 'test-key-not-used',
        glossary: { enabled: false },
        partialMode: { enabled: false, maxUnits: 25 },
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 20,
        maxCharsPerBatch: 100000,
      };
    };
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        return { ok: false, error: 'streaming disabled in test' };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 翻譯 → 還原(abort rescan controller)→ 再翻譯 → late content rescan
  await evaluate(`window.__SK.translatePage()`);
  await evaluate(`window.__SK.translatePage()`); // toggle 還原(abort 舊 rescan signal)
  await evaluate(`window.__SK.translatePage()`); // 重新翻譯
  await evaluate(`
    const zone = document.getElementById('late-zone');
    zone.innerHTML = '<p id="late">Another late paragraph for the second translation round to pick up.</p>';
    window.__rescan2 = window.__SK.translateUnitsByProvider(window.__SK.collectParagraphs()).catch(e => null);
    null
  `);
  await evaluate(`window.__rescan2`);
  await page.waitForTimeout(200);

  const late = await evaluate(`document.getElementById('late').innerText`);
  expect(late, '上一輪的 abort 不得黏住新一輪 rescan(getRescanSignal 應重建 controller)').toContain('[ZH]');
});
