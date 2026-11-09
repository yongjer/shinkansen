// Regression: 快速反復按快速鍵(翻譯⇄取消)不得卡死在「每按都跳已取消、再也不能翻譯」
//
// 真實 bug(Jimmy 回報,2026-06-05,v1.10.19.1 dev):用快速反復按快速鍵測試
// 翻譯/取消,卡在「按任何鍵都顯示『已取消翻譯』、不能重新翻譯」的狀態。
//
// 根因(probe 實測確認,tools→test/probe-rapid-toggle 已刪,紀錄見本註解):
//   1. STATE.translating = true 原本在 storage.sync.get 等多個 await 之後才設定,
//      兩次快速按鍵會雙雙通過 `if (STATE.translating)` 檢查 → spawn 兩條並行翻譯。
//      取消只 abort 最後寫入 STATE.abortController 的那條,另一條變成殺不掉的
//      zombie run(真實 API 下可跑數分鐘,期間 translating 恆 true → 每按都只跳
//      「已取消」)。
//   2. 多條 run 的 finally 無條件清 STATE.translating / abortController,互踩共用
//      state(舊 run 收尾把新 run 的 translating=true 蓋成 false → 再按又 spawn 雙重)。
//   3. 取消後 controller 已 aborted 但 unwind 未完成期間,再按仍走「取消」分支
//      (no-op abort + 已取消 toast),使用者無法立刻重新翻譯。
//
// 修法(content.js):
//   1. translatePage / translatePageGoogle 把 run state(translating +
//      abortController)移到第一個 await 之前同步設定 → 雙重進入不可能
//   2. releaseRunState(myAC) identity guard:finally / noContent 早退只在
//      「STATE.abortController 還是自己這輪的」才清 state
//   3. 三個取消入口改判 aborted:translating=true 但 controller 已 aborted =
//      上一輪取消收尾中 → 放行開新一輪(toggle 語意)
//   4. _abortRestoredEarly boolean → _earlyRestoredAborts WeakSet(per-controller,
//      新舊 run 交錯時 boolean 會被錯的 run 消費)
//
// SANITY CHECK 紀錄(已驗證,2026-06-05):
//   Break 1(sync-set 前插 `await new Promise(r=>setTimeout(r,0))`)→ Case A
//     同 tick 雙呼叫雙雙通過檢查,streamStarts=1(第二條 run 也 spawn,搶先
//     abort 把第一條的 stream 訊息變 0/1 條皆可能)斷言 fail。還原後 pass。
//   Break 2(releaseRunState 改無條件清)→ Case B 舊 run unwind 後
//     translating 被蓋 false 斷言 fail。還原後 pass。
//   Break 3(取消分支拿掉 aborted 判斷,翻譯中一律取消)→ Case B 取消後
//     立刻重按變成再取消一次,streamStarts 不增加斷言 fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

const MOCK_SETUP = `
  window.__streamStarts = 0;
  window.__listeners = [];
  const origAdd = browser.runtime.onMessage.addListener.bind(browser.runtime.onMessage);
  const origRemove = browser.runtime.onMessage.removeListener.bind(browser.runtime.onMessage);
  browser.runtime.onMessage.addListener = (fn) => { window.__listeners.push(fn); return origAdd(fn); };
  browser.runtime.onMessage.removeListener = (fn) => {
    const i = window.__listeners.indexOf(fn);
    if (i >= 0) window.__listeners.splice(i, 1);
    return origRemove(fn);
  };
  chrome.storage.sync.get = async function(keys) {
    // 模擬真實 storage 延遲,撐開 entry race window(修法前這裡是雙重進入的破口)
    await new Promise(r => setTimeout(r, 5));
    return { maxConcurrentBatches: 1, maxUnitsPerBatch: 10, maxCharsPerBatch: 100000 };
  };
  chrome.runtime.sendMessage = async function(msg) {
    if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
      window.__streamStarts += 1;
      const streamId = msg.payload.streamId;
      const texts = msg.payload.texts;
      setTimeout(() => {
        for (const fn of window.__listeners) fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId } });
        texts.forEach((t, idx) => {
          setTimeout(() => {
            for (const fn of window.__listeners) fn({ type: 'STREAMING_SEGMENT', payload: { streamId, segmentIdx: idx, translation: '[ZH] ' + t } });
          }, 30 + idx * 10);
        });
        setTimeout(() => {
          for (const fn of window.__listeners) fn({ type: 'STREAMING_DONE', payload: { streamId, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0 }, totalSegments: texts.length, hadMismatch: false } });
        }, 30 + texts.length * 10 + 60);
      }, 30);
      return { ok: true, started: true };
    }
    if (msg && msg.type === 'STREAMING_ABORT') {
      const streamId = msg.payload.streamId;
      setTimeout(() => {
        for (const fn of window.__listeners) fn({ type: 'STREAMING_ABORTED', payload: { streamId } });
      }, 5);
      return { ok: true };
    }
    if (msg && msg.type === 'TRANSLATE_BATCH') {
      // 800ms 假延遲:取消當下保證有 in-flight 批次,unwind 要等它
      await new Promise(r => setTimeout(r, 800));
      const texts = (msg.payload && msg.payload.texts) || [];
      return { ok: true, result: texts.map(t => '[ZH] ' + t), usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUSD: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
    }
    return { ok: true };
  };
  (() => {
    const root = document.createElement('div');
    root.id = '__fake-root';
    for (let i = 0; i < 40; i++) {
      const p = document.createElement('p');
      p.textContent = 'fake unit ' + i + ' here we have some text to translate';
      root.appendChild(p);
    }
    document.body.appendChild(root);
    return null;
  })();
`;

async function setup(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(MOCK_SETUP);
  return { page, evaluate };
}

test('rapid-toggle Case A: 同 tick 連按兩下不得 spawn 雙重翻譯 run', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setup(context, localServer);

  // 同一個同步 tick 內連呼叫兩次(模擬最極端的快速連按):
  // 第一下同步佔住 run state,第二下必須命中「翻譯中 → 取消」分支取消第一下,
  // 不得雙雙通過 translating 檢查 spawn 兩條 run
  await evaluate(`
    window.__SK.translatePage();
    window.__SK.translatePage();
    null
  `);
  await page.waitForTimeout(1500);

  const st = await evaluate(`({
    streamStarts: window.__streamStarts,
    translating: window.__SK.STATE.translating,
    translated: window.__SK.STATE.translated,
    zhCount: (document.body.innerText.match(/\\[ZH\\]/g) || []).length,
  })`);
  // 第一下被第二下立即取消 → 不該有任何 stream 真的 dispatch(0 條),
  // 修法前兩條 run 都活著 → 1-2 條 stream + zombie
  expect(st.streamStarts, '同 tick 雙按 = 啟動+立即取消,不得 spawn 出活的 stream').toBe(0);
  expect(st.translating, '取消收尾後 translating 應回 false').toBe(false);
  expect(st.zhCount, '不應有任何譯文注入').toBe(0);

  // 之後單按一下必須能正常翻譯(沒有殘留 state 卡住)
  await evaluate(`window.__SK.translatePage(); null`);
  {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const done = await evaluate(`window.__SK.STATE.translated === true`);
      if (done) break;
      await page.waitForTimeout(100);
    }
  }
  const st2 = await evaluate(`({
    streamStarts: window.__streamStarts,
    translated: window.__SK.STATE.translated,
    zhCount: (document.body.innerText.match(/\\[ZH\\]/g) || []).length,
  })`);
  expect(st2.streamStarts, '後續單按應正常啟動新 stream').toBe(1);
  expect(st2.translated, '後續單按應完整翻完').toBe(true);
  expect(st2.zhCount, '譯文應注入').toBeGreaterThan(0);

  await page.close();
});

test('rapid-toggle Case B: 取消後立刻重按 → 馬上開新一輪,舊 run 收尾不踩新 run', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setup(context, localServer);

  // 1) 啟動翻譯,等 batch 0 注入 + batch 1 in-flight(800ms 延遲中)
  await evaluate(`window.__SK.translatePage(); null`);
  {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const ready = await evaluate(
        `document.body.innerText.includes('[ZH]') && window.__SK.STATE.translating === true`,
      );
      if (ready) break;
      await page.waitForTimeout(50);
    }
  }
  expect(await evaluate(`window.__streamStarts`)).toBe(1);

  // 2) 取消(舊 run 的 batch 1 仍 in-flight,~800ms 後才回)
  await evaluate(`window.__SK.translatePage(); null`);
  const afterCancel = await evaluate(`({
    zhCount: (document.body.innerText.match(/\\[ZH\\]/g) || []).length,
    acAborted: window.__SK.STATE.abortController ? window.__SK.STATE.abortController.signal.aborted : null,
  })`);
  expect(afterCancel.zhCount, '取消當下應已還原').toBe(0);
  expect(afterCancel.acAborted, '取消後 controller 應為 aborted').toBe(true);

  // 3) 立刻重按(舊 run unwind 還沒完成)→ 必須直接開新一輪,不是再跳一次「已取消」
  await evaluate(`window.__SK.translatePage(); null`);
  await page.waitForTimeout(300);
  const afterRepress = await evaluate(`({
    streamStarts: window.__streamStarts,
    translating: window.__SK.STATE.translating,
    acAborted: window.__SK.STATE.abortController ? window.__SK.STATE.abortController.signal.aborted : null,
  })`);
  expect(afterRepress.streamStarts, '重按應立刻開新 stream(不是又一次取消)').toBe(2);
  expect(afterRepress.translating, '新一輪應在翻譯中').toBe(true);
  expect(afterRepress.acAborted, '新一輪 controller 不應是 aborted').toBe(false);

  // 4) 舊 run 的 in-flight batch ~800ms 後回應 + unwind——identity guard 必須擋住
  //    舊 finally 把新一輪的 translating 蓋成 false(蓋掉會讓下一按 spawn 雙重 run)
  await page.waitForTimeout(1200); // 舊 batch 800ms + 餘裕;新 run 3 批 × 800ms 仍在跑
  const midNewRun = await evaluate(`({
    translating: window.__SK.STATE.translating,
    acAborted: window.__SK.STATE.abortController ? window.__SK.STATE.abortController.signal.aborted : null,
  })`);
  expect(midNewRun.translating, '舊 run unwind 後新一輪的 translating 不得被蓋掉').toBe(true);
  expect(midNewRun.acAborted, 'STATE.abortController 應仍是新一輪的(未 aborted)').toBe(false);

  // 5) 新一輪應跑完:translated=true + 譯文注入
  {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const done = await evaluate(`window.__SK.STATE.translated === true && window.__SK.STATE.translating === false`);
      if (done) break;
      await page.waitForTimeout(100);
    }
  }
  const finalState = await evaluate(`({
    translated: window.__SK.STATE.translated,
    translating: window.__SK.STATE.translating,
    zhCount: (document.body.innerText.match(/\\[ZH\\]/g) || []).length,
  })`);
  expect(finalState.translated, '新一輪應完整翻完').toBe(true);
  expect(finalState.translating, '收尾後 translating 應為 false').toBe(false);
  expect(finalState.zhCount, '新一輪譯文應注入').toBeGreaterThan(0);

  await page.close();
});
