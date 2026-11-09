// Regression: v1.10.46 批次 3-3 — parseJson3 / parseTtml 全軌 dedup 把重複字幕行丟掉 → 時間軸出洞
//
// 痛點：`seen` Set 以整軌為範圍 dedup——副歌歌詞 / [Music] / 重複口頭禪第二次以後
// 不進 rawSegments → 該時段不在任何 segment 上：
//   - non-ASR:seek 到重複行視窗，windowSegs 撈不到 → 不送翻，字幕停留原文
//   - ASR:displayCues 對應時段空窗
//
// 修法位置：shinkansen/content-youtube.js
//   1. parseJson3 / parseTtml 移除 `seen` dedup，保留所有 segment（各帶自己的 startMs）
//   2. 連鎖防護：dedup 移除後「群組 keys[0] 寫譯文、其餘 key 寫空字串」的三個寫入點
//      (_runAsrSubBatch covered 迴圈 / _runAsrHeuristicWindow / _injectBatchResult)
//      遇到同 normText 重複 key 不得用 '' 把剛寫入的譯文抹掉
//
// 結構通則：key 去重交給 captionMap 同 key 覆寫（同文字 → 同譯文，冪等）,
// 不在 parse 層丟資料。
//
// SANITY 紀錄（已驗證，2026-06-11）:
//   (a) 暫時把 parseJson3 的 `seen` dedup 加回 → case 1 fail（重複行被丟）→ 還原 pass。
//   (b) 暫時把 _injectBatchResult 的 `unit.keys[k] !== unit.keys[0]` guard 拿掉
//       → case 3 fail(captionMap.get('la la') 被 '' 抹掉）→ 還原 pass。
//   (c) 暫時把 _runAsrSubBatch covered 迴圈 guard 拿掉 → case 4 fail → 還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';
const VIDEO_ID = 'testABC1234';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=${VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  return { page, evaluate };
}

function dispatchCaptions(responseText) {
  return `
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en',
        responseText: ${JSON.stringify(responseText)},
      }
    }));
  `;
}

test.describe('youtube-caption-dedup-repeat-lines', () => {
  test('case 1: json3 重複行（副歌）各時間點都保留進 rawSegments', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const json3 = JSON.stringify({
      events: [
        { tStartMs: 0,     segs: [{ utf8: 'unique opening line' }] },
        { tStartMs: 5000,  segs: [{ utf8: 'repeat chorus line' }] },
        { tStartMs: 10000, segs: [{ utf8: 'repeat chorus line' }] },
        { tStartMs: 15000, segs: [{ utf8: 'repeat chorus line' }] },
      ],
    });
    await evaluate(dispatchCaptions(json3));
    await page.waitForTimeout(100);

    const r = await evaluate(`
      (() => {
        const segs = window.__SK.YT.rawSegments;
        return {
          len: segs.length,
          chorusStarts: segs.filter(s => s.text === 'repeat chorus line').map(s => s.startMs),
        };
      })()
    `);
    expect(r.len, '4 條 event（含 3 條重複行）應全部保留').toBe(4);
    expect(r.chorusStarts, '重複行各自的 startMs 都要在').toEqual([5000, 10000, 15000]);

    await page.close();
  });

  test('case 2: TTML 重複行也保留', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const ttml = '<?xml version="1.0" encoding="utf-8"?><transcript>'
      + '<text begin="00:00:01.000">Repeated phrase</text>'
      + '<text begin="00:00:05.000">Repeated phrase</text>'
      + '</transcript>';
    await evaluate(dispatchCaptions(ttml));
    await page.waitForTimeout(100);

    const r = await evaluate(`
      (() => {
        const segs = window.__SK.YT.rawSegments;
        return { len: segs.length, starts: segs.map(s => s.startMs) };
      })()
    `);
    expect(r.len, 'TTML 2 條重複行應全部保留').toBe(2);
    expect(r.starts).toEqual([1000, 5000]);

    await page.close();
  });

  test('case 3: 同 event 重複行群組 → 譯文不得被空字串抹掉（完整非 ASR 注入路徑）', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(`
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
          const texts = (msg.payload && msg.payload.texts) || [];
          return { ok: true, result: texts.map(t => '[ZH] ' + t),
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
        }
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
          return { ok: false, error: 'streaming disabled in test' };
        }
        return { ok: true };
      };
      window.__SK.YT.active = true;
    `);

    // 同一 event 內兩行相同歌詞（\\n 分隔）→ 群組 keys = ['la la sing','la la sing']
    const json3 = JSON.stringify({
      events: [{ tStartMs: 0, segs: [{ utf8: 'la la sing\nla la sing' }] }],
    });
    await evaluate(dispatchCaptions(json3));

    const start = Date.now();
    let hit = '';
    while (Date.now() - start < 5000) {
      hit = await evaluate(`window.__SK.YT.captionMap.get('la la sing') ?? ''`);
      if (hit) break;
      await page.waitForTimeout(50);
    }
    expect(
      hit,
      '群組第二個重複 key 不得用空字串抹掉合併譯文',
    ).toBe('[ZH] la la sing la la sing');

    await page.close();
  });

  test('case 4: ASR covered 區間含重複 normText → 譯文不得被空字串抹掉（_runAsrSubBatch）', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(`
      chrome.runtime.sendMessage = async function(msg) {
        return { ok: true,
          result: ['[{"s":0,"e":1600,"t":"耶"}]'],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
      };
      window.__SK.YT.active = true;
    `);

    await evaluate(`
      window.__asrDone = false;
      window.__SK._runAsrSubBatch(
        [
          { startMs: 0,   text: 'yeah', normText: 'yeah' },
          { startMs: 800, text: 'yeah', normText: 'yeah' },
        ],
        0, Date.now(), [0]
      ).then(() => { window.__asrDone = true; });
    `);
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (await evaluate(`window.__asrDone`)) break;
      await page.waitForTimeout(50);
    }

    const hit = await evaluate(`window.__SK.YT.captionMap.get('yeah') ?? ''`);
    expect(hit, 'covered[1] 同 normText 不得抹掉 covered[0] 剛寫入的譯文').toBe('耶');

    await page.close();
  });
});
