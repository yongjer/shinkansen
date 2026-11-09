// Regression: ASR 緊急場景(seek 進視窗 / 影片追上視窗起點)的加速行為(v1.9.22)。
//
// Bug 背景:使用者拖進度條時 ASR 視覺上像 freeze 幾秒。原因:
//   1. progressive 模式同時跑 heuristic + LLM,LLM 佔 API 配額讓後續視窗排隊
//   2. heuristic batch 1+ 固定 BATCH=12,seek 後 batch 0 只回 1-4 條,接下來要再
//      等 batch 1 把 12 條都翻完才有第 5-N 條中文(~3-5s 空窗)
//
// v1.9.22 加速規則(translateWindowFrom 內):
//   wallLead = (windowStartMs - video.currentTime*1000) / playbackRate
//   wallLead < 10s → isUrgent = true:
//     A. _runAsrHeuristicWindow batch 1+ BATCH=4(原 12),讓「第 5-N 條」中文快點冒
//     B. progressive 模式跳掉 _runAsrWindow(LLM)— heuristic 已給 baseline,LLM 需 5-15s
//        使用者早滑過此視窗,refinement 浪費 API call
//   pure 'llm' 模式 isUrgent 仍跑(沒 heuristic baseline,跳了完全沒中文)
//
// SANITY 已驗:把 isUrgent 判斷強制設成 false → case 1 fail(BATCH=12 而非 4)+
//              case 3 fail(LLM 仍被呼叫)。還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-window-retry'; // 重用 minimal fixture

async function commonSetup(page, opts = {}) {
  const asrMode = opts.asrMode || 'progressive';
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  // 16 條 ASR rawSegments,間隔 500ms,落在 window 30000-60000(30 秒視窗)
  // heuristic 預設會把多個短句合成 sentence — 設定間隔讓 heuristic 大概合成 5+ 句
  // (確保有 batch 1+ 可驗證 BATCH 大小;heuristic 合句 gap 預設 ~1000ms,我們間隔
  //  3000ms 確保每條都獨立成句)
  await evaluate(`
    window.__SK.YT.config = {
      windowSizeS: 30, lookaheadS: 10, onTheFly: false,
      autoTranslate: false, asrMode: ${JSON.stringify(asrMode)}, bilingualMode: false,
    };
    window.__SK.YT.isAsr = true;
    window.__SK.YT.active = true;
    window.__SK.YT._ensureOverlay = window.__SK.YT._ensureOverlay || (() => null);
    window.__SK.YT.videoEl = document.querySelector('video');
    window.__SK.YT.rawSegments = (() => {
      const arr = [];
      for (let i = 0; i < 16; i++) {
        arr.push({ startMs: 30000 + i * 1800, endMs: 30000 + i * 1800 + 1500,
          text: 'seg ' + i + ' the quick brown fox.',
          normText: 'seg ' + i + ' the quick brown fox.',
          groupId: null });
      }
      return arr;
    })();
    // 確保 video.currentTime 可設定
    Object.defineProperty(document.querySelector('video'), 'currentTime', {
      value: 0, writable: true, configurable: true,
    });
    Object.defineProperty(document.querySelector('video'), 'playbackRate', {
      value: 1, writable: true, configurable: true,
    });
  `);
  return evaluate;
}

async function setMockMessages(evaluate) {
  await evaluate(`
    window.__heuristicCalls = [];   // 收集 texts.length per call
    window.__llmCalls = [];         // 收集 ASR JSON batch
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        window.__heuristicCalls.push(texts.length);
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      if (msg && msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        window.__llmCalls.push(1);
        return {
          ok: true,
          result: { entries: [] },
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);
}

test('asr-urgent case 1: isUrgent=true(video 在視窗內) → BATCH 1+ 用 4 而非 12', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);
  await setMockMessages(evaluate);

  // video at 35s(在 window 30000-60000 內,wallLead = 30 - 35 = -5s,isUrgent=true)
  await evaluate(`document.querySelector('video').currentTime = 35`);
  await evaluate(`window.__SK.translateWindowFrom(30000)`);
  await page.waitForTimeout(1500);

  const calls = await evaluate(`window.__heuristicCalls`);
  expect(calls.length, '至少應送過 1 個 heuristic batch').toBeGreaterThanOrEqual(1);
  // batch 0 = adaptive size(1 for urgent leadMs ≤ 0)
  // batch 1+ = isUrgent ? 4 : 12 — 任何 batch size > 4 = bug
  const maxSize = Math.max(...calls);
  expect(
    maxSize,
    `isUrgent batch 1+ 應 ≤ 4,實際 sizes=[${calls.join(',')}]`,
  ).toBeLessThanOrEqual(4);

  await page.close();
});

test('asr-urgent case 2: NOT urgent(video 遠在視窗前) → BATCH 1+ 仍用 12', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);
  await setMockMessages(evaluate);

  // video at 0s, window starts at 30s → wallLead = 30s > 10s → NOT urgent
  await evaluate(`document.querySelector('video').currentTime = 0`);
  await evaluate(`window.__SK.translateWindowFrom(30000)`);
  await page.waitForTimeout(1500);

  const calls = await evaluate(`window.__heuristicCalls`);
  expect(calls.length, '至少應送過 1 個 heuristic batch').toBeGreaterThanOrEqual(1);
  // batch 0 = 16(lead 充裕),batch 1+ = 12;有 16 條 sentences 時應該 1 個 batch=16
  // 或 batch 0=16 涵蓋全部 → calls=[16]。任一個 size >4 即表示 NOT urgent(沒回到 BATCH=4)
  const hasBigBatch = calls.some(s => s > 4);
  expect(
    hasBigBatch,
    `NOT urgent 應有 batch size > 4(原本 12 / 16);實際 sizes=[${calls.join(',')}]`,
  ).toBe(true);

  await page.close();
});

test('asr-urgent case 3: progressive + isUrgent → LLM 仍 fire-and-forget 跑(保留精緻分句)', async ({
  context, localServer,
}) => {
  // v1.9.22 草案曾跳 LLM(理由:LLM 5-15s 才回,使用者早滑過),但 dogfooding 發現
  // 「分句變糙」(使用者抱怨)。LLM 提供更聰明的句子切分,即使使用者已滑過,停下時
  // 也能看到精緻版。改回保留 LLM,只保留 BATCH=4 加速(由 case 1 覆蓋)。
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page, { asrMode: 'progressive' });
  await setMockMessages(evaluate);

  await evaluate(`document.querySelector('video').currentTime = 35`);
  await evaluate(`window.__SK.translateWindowFrom(30000)`);
  await page.waitForTimeout(1500);

  const llmCount = await evaluate(`window.__llmCalls.length`);
  expect(
    llmCount,
    `progressive + isUrgent 應仍跑 LLM(分句品質考量);實際 ${llmCount} 次 TRANSLATE_ASR_SUBTITLE_BATCH`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});

test('asr-urgent case 4: progressive + NOT urgent → 仍跑 _runAsrWindow (LLM)', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page, { asrMode: 'progressive' });
  await setMockMessages(evaluate);

  await evaluate(`document.querySelector('video').currentTime = 0`);
  await evaluate(`window.__SK.translateWindowFrom(30000)`);
  await page.waitForTimeout(1500);

  const llmCount = await evaluate(`window.__llmCalls.length`);
  expect(
    llmCount,
    'NOT urgent 仍應跑 LLM,實際 ' + llmCount + ' 次',
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});

test('asr-urgent case 5: pure llm 模式 + isUrgent 仍跑 LLM(沒 heuristic baseline)', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page, { asrMode: 'llm' });
  await setMockMessages(evaluate);

  await evaluate(`document.querySelector('video').currentTime = 35`);
  await evaluate(`window.__SK.translateWindowFrom(30000)`);
  await page.waitForTimeout(1500);

  const llmCount = await evaluate(`window.__llmCalls.length`);
  expect(
    llmCount,
    'pure llm + isUrgent 仍須跑 LLM(否則完全沒中文),實際 ' + llmCount + ' 次',
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});
