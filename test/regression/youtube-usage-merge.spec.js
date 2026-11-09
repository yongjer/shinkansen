// Regression: v1.4.18 YouTube 字幕用量紀錄合併
//
// Bug：v1.4.17 之前每個字幕批次（~5–10 秒一次）都走 logTranslation 新建一筆，
// 一支影片會產生幾十筆獨立紀錄，用量頁變得很雜。
//
// 修法：`lib/usage-db.js` 新增 `upsertYouTubeUsage`，以 (videoId + model, 1 小時視窗)
// 合併紀錄；換模型或超過視窗才拆新筆。`background.js` LOG_USAGE handler 偵測到
// `source === 'youtube-subtitle' && videoId` 時走此路徑，網頁翻譯仍走 logTranslation。
//
// 這組 spec 直接送 LOG_USAGE 訊息到真實 extension（IndexedDB 走 browser 的）,
// 再用 QUERY_USAGE 驗結果。Timestamp 在 payload 內顯式帶，避免依賴時鐘。
//
// SANITY 紀錄（已驗證）：把 `background.js` LOG_USAGE handler 的 youtube 分支改成
// 永遠走 `usageDB.logTranslation(record)` 後，test (1) fail（records.length 從 1 變 2）、
// test (3) 的 3 筆數字不變但 test (2) 也會 fail。還原 fix 後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const VIDEO_ID_A = 'youtube-merge-video-a';
const VIDEO_ID_B = 'youtube-merge-video-b';
const MODEL_1 = 'gemini-3-flash-preview';
const MODEL_2 = 'gemini-3-flash-lite-preview';

// 基準時間，每條 spec 內用 T0 + 偏移量，避免各 test 互相干擾
const BASE_TS = 1_800_000_000_000; // 2027-01-15 附近

const _evalCache = new WeakMap();
async function sendMessageFrom(page, msg) {
  let evaluate = _evalCache.get(page);
  if (!evaluate) {
    evaluate = (await getShinkansenEvaluator(page)).evaluate;
    _evalCache.set(page, evaluate);
  }
  return JSON.parse(
    await evaluate(`(async () => JSON.stringify(await chrome.runtime.sendMessage(${JSON.stringify(msg)})))()`)
  );
}

function ytPayload({ videoId, model, timestamp, segments = 5, inputTokens = 1000, outputTokens = 500, cachedTokens = 0, billedInputTokens = 1000, billedCostUSD = 0.002 }) {
  return {
    type: 'LOG_USAGE',
    payload: {
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: `Test video ${videoId}`,
      source: 'youtube-subtitle',
      videoId,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      billedInputTokens,
      billedCostUSD,
      segments,
      cacheHits: 0,
      durationMs: 0,
      timestamp,
    },
  };
}

async function clearUsage(page) {
  const resp = await sendMessageFrom(page, { type: 'CLEAR_USAGE' });
  // CLEAR_USAGE 的成功訊號是 ok: true
  expect(resp?.ok, 'CLEAR_USAGE 應成功').toBe(true);
}

// 查與 VIDEO_ID_* 相關的 YouTube 字幕紀錄，過濾掉其他來源
async function queryYtRecords(page, from, to) {
  const resp = await sendMessageFrom(page, { type: 'QUERY_USAGE', payload: { from, to } });
  expect(resp?.ok).toBe(true);
  return (resp.records || []).filter(
    r => r.source === 'youtube-subtitle'
      && (r.videoId === VIDEO_ID_A || r.videoId === VIDEO_ID_B),
  );
}

test.describe('v1.4.18 YouTube usage merge', () => {
  test.beforeEach(async ({ context, localServer }) => {
    // 用任一有 content script 的 fixture 頁來取得 isolated world evaluator
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#target', { timeout: 10_000 });
    await clearUsage(page);
    await page.close();
  });

  test('1 小時內同 videoId + 同 model 兩次 LOG_USAGE → 一筆合併', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#target', { timeout: 10_000 });

    const r1 = await sendMessageFrom(page, ytPayload({
      videoId: VIDEO_ID_A, model: MODEL_1, timestamp: BASE_TS,
      segments: 5, inputTokens: 1000, outputTokens: 500, billedCostUSD: 0.002,
    }));
    expect(r1?.ok).toBe(true);

    // 30 分鐘後第二批（仍在 1 小時視窗內）
    const r2 = await sendMessageFrom(page, ytPayload({
      videoId: VIDEO_ID_A, model: MODEL_1, timestamp: BASE_TS + 30 * 60_000,
      segments: 3, inputTokens: 600, outputTokens: 300, billedCostUSD: 0.001,
    }));
    expect(r2?.ok).toBe(true);

    const records = await queryYtRecords(page, BASE_TS - 1000, BASE_TS + 60 * 60_000);
    expect(records.length, `應合併成一筆，實際 ${JSON.stringify(records.map(r => ({ id: r.id, videoId: r.videoId, model: r.model, segments: r.segments })))}`).toBe(1);
    const rec = records[0];
    expect(rec.videoId).toBe(VIDEO_ID_A);
    expect(rec.model).toBe(MODEL_1);
    expect(rec.segments).toBe(8);       // 5 + 3
    expect(rec.inputTokens).toBe(1600); // 1000 + 600
    expect(rec.outputTokens).toBe(800); // 500 + 300
    expect(rec.billedCostUSD).toBeCloseTo(0.003, 6);
    expect(rec.timestamp).toBe(BASE_TS + 30 * 60_000); // 以最新為準

    await page.close();
  });

  test('同 videoId 換 model → 拆兩筆', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#target', { timeout: 10_000 });

    await sendMessageFrom(page, ytPayload({
      videoId: VIDEO_ID_A, model: MODEL_1, timestamp: BASE_TS, segments: 5,
    }));
    // 同一分鐘內但換了 model（使用者中途去設定改成別的模型）
    await sendMessageFrom(page, ytPayload({
      videoId: VIDEO_ID_A, model: MODEL_2, timestamp: BASE_TS + 60_000, segments: 2,
    }));

    const records = await queryYtRecords(page, BASE_TS - 1000, BASE_TS + 60 * 60_000);
    expect(records.length, '換 model 應拆兩筆').toBe(2);
    const byModel = Object.fromEntries(records.map(r => [r.model, r]));
    expect(byModel[MODEL_1].segments).toBe(5);
    expect(byModel[MODEL_2].segments).toBe(2);

    await page.close();
  });

  test('同 videoId + 同 model 但超過 1 小時 → 拆兩筆', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#target', { timeout: 10_000 });

    await sendMessageFrom(page, ytPayload({
      videoId: VIDEO_ID_A, model: MODEL_1, timestamp: BASE_TS, segments: 5,
    }));
    // 70 分鐘後（超出 1 小時 mergeWindowMs）
    await sendMessageFrom(page, ytPayload({
      videoId: VIDEO_ID_A, model: MODEL_1, timestamp: BASE_TS + 70 * 60_000, segments: 4,
    }));

    const records = await queryYtRecords(page, BASE_TS - 1000, BASE_TS + 120 * 60_000);
    expect(records.length, '超過 1 小時視窗應拆兩筆').toBe(2);
    const sorted = records.slice().sort((a, b) => a.timestamp - b.timestamp);
    expect(sorted[0].segments).toBe(5);
    expect(sorted[1].segments).toBe(4);

    await page.close();
  });

  test('不同 videoId → 各自獨立', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#target', { timeout: 10_000 });

    await sendMessageFrom(page, ytPayload({
      videoId: VIDEO_ID_A, model: MODEL_1, timestamp: BASE_TS, segments: 5,
    }));
    await sendMessageFrom(page, ytPayload({
      videoId: VIDEO_ID_B, model: MODEL_1, timestamp: BASE_TS + 60_000, segments: 3,
    }));

    const records = await queryYtRecords(page, BASE_TS - 1000, BASE_TS + 60 * 60_000);
    expect(records.length, '不同 videoId 應各自一筆').toBe(2);

    await page.close();
  });
});
