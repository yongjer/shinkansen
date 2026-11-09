// Regression: translateWindowFrom 失敗時不加 translatedWindows,下次 seek 可重試。
//
// Bug(v1.9.21 前 / 修在 v1.9.22):translateWindowFrom 內所有 batches 失敗(SW
// context invalidated / Gemini reject / rate limit / 15s timeout × maxRetries 全用光)
// 後,line 2336 仍無條件 YT.translatedWindows.add(windowStartMs)。結果:
//   - !YT.translatedWindows.has(N) → false → onVideoSeeked 不顯示「翻譯中」status
//   - translateWindowFrom 入口 guard 同 has(N) → 不重試
//   - captionMap 沒有此視窗 entry → overlay / native segment 都看不到中文
//   → 使用者拖到此視窗看到「一片空白 + 無 status」的靜默失敗(Chrome for Claude 實測
//      Jimmy 的 YouTube 影片 1500-1860 ms 範圍重現)。
//
// 修法:translateWindowFrom 內記 _cmSizeBefore / _cuesCountBefore,翻完比對
// captionMap.size / displayCues.length 都沒長 = 全失敗 → 不加 translatedWindows。
// 例外:windowSegs.length === 0(視窗本來就無字幕)仍加,避免無限重試空視窗。
//
// SANITY 紀錄(已驗證):暫時把修法的 `if (windowSegs.length === 0 || _windowProducedTranslation)`
// 改成無條件 `if (true)`(回到原本無條件 add 行為)→ case 1 fail(translatedWindows
// 含失敗視窗)→ 還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-window-retry';

async function commonSetup(page) {
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  // 預設 ytSubtitle config(非 ASR,直接走 _runBatch _injectBatchResult 路徑)
  await evaluate(`
    window.__SK.YT.config = {
      windowSizeS: 30, lookaheadS: 10, onTheFly: false,
      autoTranslate: false, asrMode: 'heuristic', bilingualMode: false,
    };
    window.__SK.YT.isAsr = false;  // 走 non-ASR 路徑(_runBatch)
    window.__SK.YT.active = true;
    window.__SK.YT.rawSegments = [
      { startMs: 1000, endMs: 3000, text: 'hello', normText: 'hello', groupId: null },
      { startMs: 5000, endMs: 7000, text: 'world', normText: 'world', groupId: null },
    ];
  `);
  return evaluate;
}

test('window-retry case 1: 所有 batches 失敗 → 不加 translatedWindows,可重試', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);

  // Mock TRANSLATE_SUBTITLE_BATCH 永遠失敗(模擬 SW context invalidated)
  await evaluate(`
    window.__batchCallCount = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__batchCallCount++;
        return { ok: false, error: 'mock failure' };
      }
      return { ok: true };
    };
  `);

  // 第一次嘗試 — 預期失敗,translatedWindows 不應加 0
  await evaluate(`window.__SK.translateWindowFrom(0)`);
  await page.waitForTimeout(500);

  const after1 = await evaluate(`({
    callCount: window.__batchCallCount,
    translatedWindowsHas0: window.__SK.YT.translatedWindows.has(0),
    translatingWindowsHas0: window.__SK.YT.translatingWindows.has(0),
    captionMapSize: window.__SK.YT.captionMap.size,
  })`);

  expect(after1.callCount, '第一次應送過 batch').toBeGreaterThanOrEqual(1);
  expect(after1.captionMapSize, '失敗,captionMap 應為空').toBe(0);
  expect(
    after1.translatedWindowsHas0,
    '★ 核心斷言:失敗的視窗不該加進 translatedWindows(否則下次 seek 不重試)',
  ).toBe(false);
  expect(after1.translatingWindowsHas0, 'finally 應清掉 translatingWindows').toBe(false);

  // 第二次嘗試(模擬使用者再 seek 進來)— 應該真的重試送 batch,不是被 guard 擋
  const beforeCallCount = after1.callCount;
  await evaluate(`window.__SK.translateWindowFrom(0)`);
  await page.waitForTimeout(500);

  const after2 = await evaluate(`window.__batchCallCount`);
  expect(
    after2,
    `第二次 translateWindowFrom 應再次送 batch(前 ${beforeCallCount},後 ${after2})`,
  ).toBeGreaterThan(beforeCallCount);

  await page.close();
});

test('window-retry case 2: batches 成功 → 仍加 translatedWindows(原本行為不破)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);

  // Mock TRANSLATE_SUBTITLE_BATCH 成功
  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  await evaluate(`window.__SK.translateWindowFrom(0)`);
  await page.waitForTimeout(500);

  const after = await evaluate(`({
    translatedWindowsHas0: window.__SK.YT.translatedWindows.has(0),
    captionMapSize: window.__SK.YT.captionMap.size,
  })`);

  expect(after.captionMapSize, '成功應寫 captionMap').toBeGreaterThan(0);
  expect(after.translatedWindowsHas0, '成功的視窗仍應加進 translatedWindows').toBe(true);

  await page.close();
});

test('window-retry case 3: 視窗本來就無字幕(windowSegs=[]) → 仍加 translatedWindows(避免無限重試空視窗)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);

  // window 30000-60000 沒任何 rawSegments(都在 1000-7000)
  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) { return { ok: true }; };
  `);

  await evaluate(`window.__SK.translateWindowFrom(30000)`);
  await page.waitForTimeout(300);

  const after = await evaluate(`({
    translatedWindowsHas30000: window.__SK.YT.translatedWindows.has(30000),
    captionMapSize: window.__SK.YT.captionMap.size,
  })`);

  expect(after.captionMapSize, '空視窗不送 batch,captionMap 不該長').toBe(0);
  expect(
    after.translatedWindowsHas30000,
    '空視窗仍應加 translatedWindows(沒譯文不代表失敗,是本來就沒字幕)',
  ).toBe(true);

  await page.close();
});
