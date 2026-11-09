// Regression: isolated→main bridge detail 改 JSON 字串協定（批次 3.5，Firefox Xray 修復）
//
// 背景：Firefox 的 isolated world dispatch object detail，main world 讀屬性直接
// throw `Permission denied to access property`（Xray 安全模型，headless web-ext
// probe 實測）→ Firefox 版 chooser 切軌 / cc-control 靜默失敗。修法：dispatch 端
// （content-youtube.js bridgeRequest）detail 一律 JSON.stringify；main 端
// （content-youtube-main.js parseBridgeDetail）雙格式相容讀（字串 parse / 物件直收）。
//
// 本 spec 鎖的訊號層次（CLAUDE.md 工作流原則 3）：
//   驗（Chromium 真實雙 world）：
//   1. dispatch 端協定形狀：cc-control / set-caption-track 送出的 detail 是 JSON
//      字串且 parse 出正確欄位（在 main world 掛 raw listener 直接驗 wire format）
//   2. main 端雙格式相容：字串與舊 object detail 都能驅動 handler 回 result /
//      呼叫 player API（Chrome 新舊協定皆通，不需兩側同步升級）
//   3. 整條 round-trip 行為不變：cc-control enable 仍呼叫 loadModule+setOption、
//      chooser switch 仍 setOption 正確軌（與 mobile-youtube-subtitle 等既有 spec
//      共同構成回歸保證）
//   不驗：
//   - Firefox 真實 compartment 行為（Chromium 的 isolated→main object detail 本來
//     就可讀，字串協定在 Firefox 才「修了東西」；該層由 headless web-ext probe
//     驗 JSON 往返 + 真實 Firefox 體感驗收，為已知 harness 盲區）
//
// SANITY CHECK 紀錄（已驗證，2026-06-11）：
//   1. 暫時把 content-youtube.js bridgeRequest 的 JSON.stringify(detail) 改回
//      detail（物件直送）→「cc-control dispatch 端」「set-caption-track dispatch 端」
//      2 條 fail(typeof e.detail === 'object')，還原後綠。
//   2. 暫時把 content-youtube-main.js parseBridgeDetail 字串分支拿掉（只回 d）→
//      初版 case 3 用 op:'status' 驗字串格式沒 fail（parse 失敗 fallback 預設
//      'status' 剛好同值，斷言被遮住）→ 改用非預設 op:'reload'（CC 關著確定回
//      cc-not-on，無副作用）後 4 條全 fail，還原後 4 條全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

// #movie_player stub：同 mobile-youtube-subtitle.spec.js（getOption track=null →
// CC 關 → chooser 'switch' + auto-CC enable 兩條路徑都會走到）
const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>watch fixture</title></head>
<body>
<main><p id="para">video page placeholder</p></main>
<div id="movie_player"></div>
<script>
  window.__playerCalls = [];
  window.__rawBridgeEvents = []; // main world 收到的 raw bridge event（驗 wire format）
  for (const name of ['shinkansen-yt-cc-control', 'shinkansen-yt-set-caption-track']) {
    window.addEventListener(name, (e) => {
      window.__rawBridgeEvents.push({ name, detailType: typeof e.detail, raw: e.detail });
    });
  }
  window.__results = []; // main world 收到的 result event（驗雙格式 handler 回應）
  for (const name of ['shinkansen-yt-cc-control-result', 'shinkansen-yt-set-caption-track-result']) {
    window.addEventListener(name, (e) => { window.__results.push({ name, detail: e.detail }); });
  }
  const player = document.getElementById('movie_player');
  player.getPlayerResponse = () => ({
    videoDetails: { videoId: 'test1234567' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'en', kind: 'asr', isTranslatable: true, vssId: 'a.en', name: { simpleText: 'English (auto)' } },
    ] } },
  });
  player.getOption = (mod, key) => {
    window.__playerCalls.push(['getOption', mod, key]);
    return null; // track=null（CC 關）/ tracklist=null → fallback playerResponse
  };
  player.loadModule = (mod) => { window.__playerCalls.push(['loadModule', mod]); };
  player.unloadModule = (mod) => { window.__playerCalls.push(['unloadModule', mod]); };
  player.setOption = (mod, key, val) => { window.__playerCalls.push(['setOption', mod, key, val]); };
</script>
</body></html>`;

async function openRoutedPage(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  await worker.evaluate(() => chrome.storage.sync.set({ ytSubtitle: { autoTranslate: false } }));
  const page = await context.newPage();
  await page.route('https://m.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
  await page.goto('https://m.youtube.com/watch?v=test1234567', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`
    window.__toasts = [];
    window.__SK.showToast = (kind, msg, opts) => { window.__toasts.push({ kind, msg }); };
  `);
  return { page, evaluate };
}

async function sendSetSubtitle(context, enabled) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  await worker.evaluate(async (enabled) => {
    const tabs = await chrome.tabs.query({ url: 'https://m.youtube.com/*' });
    if (!tabs.length) throw new Error('no m.youtube tab');
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'SET_SUBTITLE', payload: { enabled } });
  }, enabled);
}

test('cc-control dispatch 端：detail 是 JSON 字串且 round-trip 仍呼叫 player API', async ({ context, localServer }) => {
  const { page } = await openRoutedPage(context);
  await sendSetSubtitle(context, true);

  // 等 1s tick → forceSubtitleReload → status + enable 完整 round-trip（loadModule 為完成訊號）
  let calls = [];
  const start = Date.now();
  while (Date.now() - start < 6000) {
    calls = await page.evaluate(`window.__playerCalls`);
    if (calls.some((c) => c[0] === 'loadModule')) break;
    await page.waitForTimeout(100);
  }
  expect(calls.some((c) => c[0] === 'loadModule' && c[1] === 'captions'), 'round-trip 應呼叫 loadModule').toBe(true);

  // wire format：main world 收到的 cc-control detail 必須是 JSON 字串
  const raw = await page.evaluate(`window.__rawBridgeEvents.filter((r) => r.name === 'shinkansen-yt-cc-control')`);
  expect(raw.length, '應至少攔到 status + enable 兩個 cc-control event').toBeGreaterThanOrEqual(2);
  for (const r of raw) {
    expect(r.detailType, 'cc-control detail 應為 JSON 字串（Firefox Xray 修復協定）').toBe('string');
  }
  const ops = raw.map((r) => JSON.parse(r.raw).op);
  expect(ops).toContain('status');
  expect(ops).toContain('enable');
});

test('set-caption-track dispatch 端：detail 是 JSON 字串且 main 端 setOption 收到正確軌', async ({ context, localServer }) => {
  const { page } = await openRoutedPage(context);
  await sendSetSubtitle(context, true);

  // chooser：activeTrack=null + en/asr 軌 → 'switch' → set-caption-track bridge
  let raw = [];
  const start = Date.now();
  while (Date.now() - start < 6000) {
    raw = await page.evaluate(`window.__rawBridgeEvents.filter((r) => r.name === 'shinkansen-yt-set-caption-track')`);
    if (raw.length > 0) break;
    await page.waitForTimeout(100);
  }
  expect(raw.length, 'chooser switch 應 dispatch set-caption-track').toBeGreaterThanOrEqual(1);
  expect(raw[0].detailType, 'set-caption-track detail 應為 JSON 字串').toBe('string');
  expect(JSON.parse(raw[0].raw)).toEqual({ languageCode: 'en', kind: 'asr' });

  // main 端 parse 後行為不變：setOption 收到正確物件
  const calls = await page.evaluate(`window.__playerCalls`);
  const setOpt = calls.find((c) => c[0] === 'setOption' && c[3] && c[3].languageCode === 'en');
  expect(setOpt, 'main 端應 setOption 切到 en/asr 軌').toBeTruthy();
  expect(setOpt[3]).toEqual({ languageCode: 'en', kind: 'asr' });
});

test('main 端雙格式相容：字串與舊 object detail 都能驅動 cc-control handler', async ({ context, localServer }) => {
  const { page } = await openRoutedPage(context);

  // 新協定：JSON 字串。op 刻意用非預設值 'reload'（handler 讀不出 op 會 fallback
  // 'status'，用 'status' 驗會被預設值遮住 parse 失敗）。CC 關著時 reload 確定回
  // { op:'reload', ok:false, error:'cc-not-on' }，無副作用且可區分 fallback。
  await page.evaluate(`window.dispatchEvent(new CustomEvent('shinkansen-yt-cc-control', { detail: JSON.stringify({ op: 'reload' }) }))`);
  // 舊協定：object（Chrome 既有 wire format，不得破）
  await page.evaluate(`window.dispatchEvent(new CustomEvent('shinkansen-yt-cc-control', { detail: { op: 'status' } }))`);

  let results = [];
  const start = Date.now();
  while (Date.now() - start < 3000) {
    results = await page.evaluate(`window.__results.filter((r) => r.name === 'shinkansen-yt-cc-control-result')`);
    if (results.length >= 2) break;
    await page.waitForTimeout(50);
  }
  expect(results.length, '兩種格式都應回 result').toBe(2);
  const strRes = results.find((r) => r.detail.op === 'reload');
  expect(strRes, '字串格式 handler 應正確 parse 出 op=reload（非 fallback status）').toBeTruthy();
  expect(strRes.detail.ok).toBe(false);
  expect(strRes.detail.error).toBe('cc-not-on');
  const objRes = results.find((r) => r.detail.op === 'status');
  expect(objRes, '舊 object 格式應照常運作').toBeTruthy();
  expect(objRes.detail.ok).toBe(true);
});

test('main 端雙格式相容：字串與舊 object detail 都能驅動 set-caption-track handler', async ({ context, localServer }) => {
  const { page } = await openRoutedPage(context);

  await page.evaluate(`window.dispatchEvent(new CustomEvent('shinkansen-yt-set-caption-track', { detail: JSON.stringify({ languageCode: 'ja', kind: '' }) }))`);
  await page.evaluate(`window.dispatchEvent(new CustomEvent('shinkansen-yt-set-caption-track', { detail: { languageCode: 'ko', kind: 'asr' } }))`);

  let results = [];
  const start = Date.now();
  while (Date.now() - start < 3000) {
    results = await page.evaluate(`window.__results.filter((r) => r.name === 'shinkansen-yt-set-caption-track-result')`);
    if (results.length >= 2) break;
    await page.waitForTimeout(50);
  }
  expect(results.length, '兩種格式都應回 result').toBe(2);
  for (const r of results) expect(r.detail.ok, 'handler 應正確讀出 languageCode 並 setOption').toBe(true);

  const calls = await page.evaluate(`window.__playerCalls.filter((c) => c[0] === 'setOption')`);
  expect(calls.map((c) => c[3])).toEqual([
    { languageCode: 'ja', kind: '' },
    { languageCode: 'ko', kind: 'asr' },
  ]);
});
