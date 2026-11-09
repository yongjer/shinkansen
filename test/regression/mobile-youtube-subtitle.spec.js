// Regression: m.youtube.com(行動版 mweb)字幕翻譯管線啟動(v1.10.25)
//
// 歷史:v1.10.22 起 m.youtube 曾是「toast 提示切電腦版 + 不啟動」(當時 timedtext
// 攔截 manifest match 只有 www.youtube.com,啟動會變 zombie session)。v1.10.25 起
// 行動版完整支援:manifest match 加 m.youtube.com、isYouTubePage 接受 m.youtube、
// auto-CC 改走 #movie_player captions module API bridge(mweb 沒有 .ytp-subtitles-button)。
//
// 本 spec 鎖的訊號層次(CLAUDE.md 工作流原則 3):
//   驗:
//   1. SW tabs.sendMessage(SET_SUBTITLE) → m.youtube 啟動 YT pipeline(不再擋)
//   2. mweb auto-CC fallback 整條 integration:translateYouTubeSubtitles → 1s tick →
//      forceSubtitleReload(無 CC button)→ shinkansen-yt-cc-control bridge(MAIN world,
//      manifest match 真實載入)→ #movie_player stub 的 loadModule + setOption 被呼叫
//   不驗:
//   - 真實 mweb 播放器的 timedtext XHR 與字幕渲染(Playwright 全新 profile 被
//     YouTube POT/botguard 擋,timedtext body 一律空;此層只能 iOS simulator /
//     真機驗,fixture 用 #movie_player stub)
//   - track chooser 後續切軌邏輯(youtube-caption-lang spec 範疇)
//
// SANITY CHECK 紀錄(已驗證,2026-06-07):
//   1. 暫時把 content-youtube.js isYouTubePage 的 m.youtube.com 分支拿掉 →
//      「autoTranslate 載入自動啟動」case fail(YT.active=false),還原後 5 條綠。
//      註:第一輪 SANITY 發現 SET_SUBTITLE 路徑不經過 isYouTubePage(破壞後原 4 條
//      照樣綠),故補「autoTranslate 載入自動啟動」case 鎖 hostname 分支——這是行動版
//      使用者的主要啟動路徑。
//   2. 暫時把 content-youtube-main.js cc-control 的 enable 分支 throw →
//      「mweb auto-CC fallback」case fail(loadModule 未被呼叫),還原後綠。
//   3. 暫時把 content-youtube.js _scheduleMwebCcRetry 開頭 return(no-op 重試)→
//      「mweb 廣告時序」case fail(廣告期間只有 1 次 loadModule,等不到第 2 次),
//      還原後 6 條全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

// #movie_player stub:模擬 mweb 播放器 API(main world,inline script)。
// getPlayerResponse 的 videoId 必須對 URL ?v= 比對(content-youtube.js queryAndDecide
// 的 stale 防護),captionTracks 非空讓流程走「有字幕 → 等待 → 1s tick auto-CC」。
const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>watch fixture</title></head>
<body>
<main><p id="para">video page placeholder</p></main>
<div id="movie_player"></div>
<script>
  window.__playerCalls = [];
  // __adMode=true 模擬廣告播放中:getPlayerResponse 回廣告的 videoId(跟 URL ?v= 不符),
  // cc-control enable 的 videoId guard 應擋下(stale-player-response)
  window.__adMode = false;
  const player = document.getElementById('movie_player');
  player.getPlayerResponse = () => ({
    videoDetails: { videoId: window.__adMode ? 'adVideo00001' : 'test1234567' },
    captions: window.__adMode ? undefined : { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'en', kind: 'asr', isTranslatable: true, vssId: 'a.en', name: { simpleText: 'English (auto)' } },
    ] } },
  });
  player.getOption = (mod, key) => {
    window.__playerCalls.push(['getOption', mod, key]);
    if (mod === 'captions' && key === 'track') return null;      // CC 關著
    if (mod === 'captions' && key === 'tracklist') return [];    // mweb 實測 loadModule 後仍空
    return null;
  };
  player.loadModule = (mod) => { window.__playerCalls.push(['loadModule', mod]); };
  player.unloadModule = (mod) => { window.__playerCalls.push(['unloadModule', mod]); };
  player.setOption = (mod, key, val) => { window.__playerCalls.push(['setOption', mod, key, val]); };
</script>
</body></html>`;

// 用 route 模擬 youtube hostname:content script 注入(含 MAIN world 的
// content-youtube-main.js,manifest match 真實生效)與 hostname 分支都吃真實 URL。
// 先關 ytSubtitle.autoTranslate:isYouTubePage 對 m.youtube 為 true 後,載入 800ms
// 會自動啟動管線,會污染「SET_SUBTITLE 是唯一驅動」的斷言;關掉讓測試確定性。
async function openRoutedPage(context, url, { autoTranslate = false } = {}) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  await worker.evaluate(
    (autoTranslate) => chrome.storage.sync.set({ ytSubtitle: { autoTranslate } }),
    autoTranslate,
  );
  const page = await context.newPage();
  await page.route('https://m.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
  await page.route('https://www.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  // Stub showToast(closed shadow DOM 查不到內容,攔 SK.showToast 呼叫紀錄)
  await evaluate(`
    window.__toasts = [];
    window.__SK.showToast = (kind, msg, opts) => { window.__toasts.push({ kind, msg }); };
  `);
  return { page, evaluate };
}

// 從 background service worker 送 SET_SUBTITLE — 跟 popup yt-subtitle-toggle
// 的 browser.tabs.sendMessage 同一條真實路徑
async function sendSetSubtitle(context, urlPattern, enabled) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  await worker.evaluate(async ({ urlPattern, enabled }) => {
    const tabs = await chrome.tabs.query({ url: urlPattern });
    if (!tabs.length) throw new Error(`no tab matches ${urlPattern}`);
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'SET_SUBTITLE', payload: { enabled } });
  }, { urlPattern, enabled });
}

test('m.youtube + enabled=true → YT pipeline 啟動(不再擋行動版)', async ({ context, localServer }) => {
  const { page, evaluate } = await openRoutedPage(context, 'https://m.youtube.com/watch?v=test1234567');

  await sendSetSubtitle(context, 'https://m.youtube.com/*', true);

  // translateYouTubeSubtitles 入口同步把 YT.active 翻 true
  const start = Date.now();
  let active = false;
  while (Date.now() - start < 3000) {
    active = await evaluate(`!!(window.__SK.YT && window.__SK.YT.active)`);
    if (active) break;
    await page.waitForTimeout(50);
  }
  expect(active, 'm.youtube 應照常啟動字幕翻譯').toBe(true);

  // 不該出現任何 error 級提示(舊行為的「切電腦版」hint 已移除)
  const errorToasts = await evaluate(`window.__toasts.filter((t) => t.kind === 'error')`);
  expect(errorToasts, 'm.youtube 不該再跳切電腦版提示').toEqual([]);
});

test('m.youtube autoTranslate 載入自動啟動(isYouTubePage 接受 m.youtube)', async ({ context, localServer }) => {
  // 行動版使用者的主要啟動路徑:content.js 初始化的 isYouTubePage() gate +
  // autoTranslate 預設 true → 載入 800ms 後自動 translateYouTubeSubtitles。
  // SET_SUBTITLE 路徑不經過 isYouTubePage,只有這條 test 鎖得住 hostname 分支。
  const { page, evaluate } = await openRoutedPage(
    context, 'https://m.youtube.com/watch?v=test1234567', { autoTranslate: true });

  const start = Date.now();
  let active = false;
  while (Date.now() - start < 4000) {
    active = await evaluate(`!!(window.__SK.YT && window.__SK.YT.active)`);
    if (active) break;
    await page.waitForTimeout(100);
  }
  expect(active, 'm.youtube watch 頁應走 YT auto-subtitle 自動啟動').toBe(true);
});

test('mweb auto-CC fallback:無 CC button → cc-control bridge 呼叫 player API', async ({ context, localServer }) => {
  const { page, evaluate } = await openRoutedPage(context, 'https://m.youtube.com/watch?v=test1234567');

  await sendSetSubtitle(context, 'https://m.youtube.com/*', true);

  // 1s tick 後 forceSubtitleReload 走 bridge:status(getOption track=null → CC 關)
  // → enable(loadModule('captions') + setOption('captions','track', en/asr))。
  // 注意:track chooser(既有路徑)也會對 stub 呼叫 setOption,且比 1s tick 早;
  // loadModule('captions') 只有 cc-control enable 會呼叫,以它當完成訊號。
  const start = Date.now();
  let calls = [];
  while (Date.now() - start < 6000) {
    calls = await page.evaluate(`window.__playerCalls`);  // stub 在 main world,page.evaluate 正確
    if (calls.some((c) => c[0] === 'loadModule')) break;
    await page.waitForTimeout(100);
  }
  const loadIdx = calls.findIndex((c) => c[0] === 'loadModule' && c[1] === 'captions');
  expect(loadIdx, 'bridge 應呼叫 loadModule("captions")').toBeGreaterThan(-1);
  // enable 在 loadModule 之後必接 setOption 指定軌
  const setOpt = calls.slice(loadIdx + 1).find((c) => c[0] === 'setOption');
  expect(setOpt, 'enable 應在 loadModule 後呼叫 setOption 指定字幕軌').toBeTruthy();
  expect(setOpt[1]).toBe('captions');
  expect(setOpt[2]).toBe('track');
  expect(setOpt[3]).toEqual({ languageCode: 'en', kind: 'asr' });

  // 每 session 只 auto-enable 一次的旗標應已立起
  expect(await evaluate(`window.__SK.YT._autoCcToggled`)).toBe(true);
});

test('mweb 廣告時序:enable 被 videoId guard 擋下 → 有界重試,廣告結束後成功', async ({ context, localServer }) => {
  // 痛點(sim 實測):SPA 切片 / 初載先跑廣告時,1s tick 的 auto-CC 對廣告 player
  // 操作(getPlayerResponse 回廣告 videoId),舊版 _autoCcToggled 每 session 只試
  // 一次 → 廣告結束後沒人補開 CC,管線靜默卡死。修法:MAIN world enable 加
  // videoId guard(stale-player-response)+ isolated 端每 3s 有界重試。
  const { page, evaluate } = await openRoutedPage(context, 'https://m.youtube.com/watch?v=test1234567');
  await page.evaluate(`window.__adMode = true`); // 廣告開始
  await sendSetSubtitle(context, 'https://m.youtube.com/*', true);

  // 廣告期間:enable 反覆被擋(loadModule 有跑,setOption 不會跑到 en/asr 那步),
  // 重試應持續發生 → 等到 ≥2 次 loadModule(1s tick 一次 + 3s retry 至少一次)
  let calls = [];
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    calls = await page.evaluate(`window.__playerCalls`);
    if (calls.filter((c) => c[0] === 'loadModule').length >= 2) break;
    await page.waitForTimeout(200);
  }
  const adLoadCount = calls.filter((c) => c[0] === 'loadModule').length;
  expect(adLoadCount, '廣告期間重試應產生 ≥2 次 enable 嘗試(loadModule)').toBeGreaterThanOrEqual(2);

  // 廣告結束 → 下一輪重試的 enable 應成功(loadModule 後接 setOption en/asr)
  const lenAtAdEnd = calls.length;
  await page.evaluate(`window.__adMode = false`);
  let okSetOpt = null;
  const start2 = Date.now();
  while (Date.now() - start2 < 8_000) {
    calls = await page.evaluate(`window.__playerCalls`);
    const after = calls.slice(lenAtAdEnd);
    const li = after.findIndex((c) => c[0] === 'loadModule');
    if (li >= 0) {
      okSetOpt = after.slice(li + 1).find((c) => c[0] === 'setOption');
      if (okSetOpt) break;
    }
    await page.waitForTimeout(200);
  }
  expect(okSetOpt, '廣告結束後重試的 enable 應成功 setOption').toBeTruthy();
  expect(okSetOpt[3]).toEqual({ languageCode: 'en', kind: 'asr' });
});

test('m.youtube + enabled=false → 不啟動(no-op)', async ({ context, localServer }) => {
  const { page, evaluate } = await openRoutedPage(context, 'https://m.youtube.com/watch?v=test1234567');

  await sendSetSubtitle(context, 'https://m.youtube.com/*', false);
  await page.waitForTimeout(800);

  expect(await evaluate(`!!(window.__SK.YT && window.__SK.YT.active)`)).toBe(false);
});

test('www.youtube.com 對照組:enabled=true 照常啟動,桌面路徑不受 mweb 改動影響', async ({ context, localServer }) => {
  const { page, evaluate } = await openRoutedPage(context, 'https://www.youtube.com/watch?v=test1234567');

  await sendSetSubtitle(context, 'https://www.youtube.com/*', true);

  const start = Date.now();
  let active = false;
  while (Date.now() - start < 3000) {
    active = await evaluate(`!!(window.__SK.YT && window.__SK.YT.active)`);
    if (active) break;
    await page.waitForTimeout(50);
  }
  expect(active, '桌面版 YouTube 應照常啟動字幕翻譯').toBe(true);
});
