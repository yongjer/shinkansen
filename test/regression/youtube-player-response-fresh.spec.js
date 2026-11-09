// Regression: 真實 bug 回報 — 日文影片偶發「日→英→中」二手翻譯。
//
// Root cause(cage 真機抓到,影片 mSUxnf6rmUE):
//   content-youtube-main.js 的 player response bridge 原本讀 window.ytInitialPlayerResponse。
//   這個全域只反映「整頁初次載入那支影片」的快照,SPA 站內切片(點下一支影片不重整頁)後
//   不更新 → videoId 一直停在前一支(實測停在 SGt2lYaPP00,但 URL/getPlayerResponse 都已是
//   mSUxnf6rmUE)→ isolated 端 _runCaptionTrackChooser videoId 比對失敗判 stale → noop 放棄切軌
//   → YT 帳號黏性自翻譯(日→英)沒被關 → Gemini 拿到英文再翻中 → 二手翻譯。
//
// 修法:bridge 改成優先讀 #movie_player.getPlayerResponse()(反映「當前正在播」的影片),
//       拿不到才 fallback 回 window.ytInitialPlayerResponse。
//
// 本 spec 載入「真實」content-youtube-main.js(addScriptTag from disk,跑在 MAIN world),
// 不是 mock bridge,所以驗的是修法本體的資料源選擇。
//
// 驗證:
//   case 1(fresh 優先):getPlayerResponse=fresh(ja) + ytInitialPlayerResponse=stale(en)
//     → bridge 回 fresh 的 videoId + ja tracks(不是 stale 的 en)
//   case 2(fallback):getPlayerResponse 不存在(player 未就緒)→ 回 ytInitialPlayerResponse
//
// SANITY CHECK(已驗證):
//   把 bridge 改回先讀 window.ytInitialPlayerResponse(拿掉 getPlayerResponse 優先)
//     → case 1 fail(videoId 回 stale 的 SGt2lYaPP00 / tracks 回 en)→ 還原 pass

import { test, expect } from '../fixtures/extension.js';
import { fileURLToPath } from 'node:url';

const SRC_PATH = fileURLToPath(new URL('../../shinkansen/content-youtube-main.js', import.meta.url));

const FRESH_ID = 'mSUxnf6rmUE';
const STALE_ID = 'SGt2lYaPP00';

async function setup(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/youtube-player-response-fresh.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player', { state: 'attached', timeout: 10_000 });
  // 注入真實 bridge(MAIN world)
  await page.addScriptTag({ path: SRC_PATH });
  return page;
}

// dispatch query + 同步捕捉 bridge 回應(listener 與 dispatcher 同在 MAIN world,page.evaluate 即可)
async function queryBridge(page) {
  return page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('shinkansen-yt-player-response', (e) => resolve(e.detail || null), { once: true });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-query-player-response'));
    setTimeout(() => resolve(null), 1000);
  }));
}

test('bridge 優先讀 getPlayerResponse(fresh)而非 stale 的 ytInitialPlayerResponse', async ({ context, localServer }) => {
  const page = await setup(context, localServer);

  await page.evaluate(({ freshId, staleId }) => {
    // stale 全域:停在前一支影片 + en asr 軌
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: staleId },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto)' } },
      ] } },
    };
    // fresh:當前播放中的影片 + ja asr 軌
    const player = document.querySelector('#movie_player');
    player.getPlayerResponse = () => ({
      videoDetails: { videoId: freshId },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { languageCode: 'ja', kind: 'asr', name: { simpleText: '日文 (自動產生)' } },
      ] } },
    });
  }, { freshId: FRESH_ID, staleId: STALE_ID });

  const detail = await queryBridge(page);
  expect(detail).not.toBeNull();
  expect(detail.playerResponseAvailable).toBe(true);
  // 關鍵斷言:回 fresh,不是 stale
  expect(detail.videoId).toBe(FRESH_ID);
  expect(detail.captionTracks).toHaveLength(1);
  expect(detail.captionTracks[0].languageCode).toBe('ja');

  await page.close();
});

test('getPlayerResponse 不存在(player 未就緒)→ fallback 回 ytInitialPlayerResponse', async ({ context, localServer }) => {
  const page = await setup(context, localServer);

  await page.evaluate(({ staleId }) => {
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: staleId },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { languageCode: 'ja', kind: 'asr' },
      ] } },
    };
    // player 沒有 getPlayerResponse(document_start ~ 初始化之間)
    const player = document.querySelector('#movie_player');
    delete player.getPlayerResponse;
  }, { staleId: STALE_ID });

  const detail = await queryBridge(page);
  expect(detail).not.toBeNull();
  expect(detail.playerResponseAvailable).toBe(true);
  expect(detail.videoId).toBe(STALE_ID);
  expect(detail.captionTracks[0].languageCode).toBe('ja');

  await page.close();
});
