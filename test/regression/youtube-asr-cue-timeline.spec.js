// Regression: youtube-asr-cue-timeline(v2.0.54 修的「AI 分句字幕不是太早結束就是
// 太晚出現」bug)
//
// Fixture: 沿用 youtube-streaming-inject.html(只需 video element + content script 載入,
//          spec 直接驅動 SK._runAsrSubBatch / SK._runAsrHeuristicWindow)
//
// Bug(real-data 校準,2026-07-12,gemini-3.1-flash-lite × 真實 ASR 軌):
//   1. 舊邏輯把 LLM 回傳的 e 直接當顯示終點 + captionMap 覆蓋上界。實測 ~4% entry
//      的 e 挑到「句中片段」而非句尾片段的 e → 句尾片段 uncovered、cue 提早 2-4s 消失,
//      下一句要等自己的 s 才出現 → 中間空窗(使用者感知:太早結束/太晚出現)。
//   2. 子批末條輸入 e 固定 lastStart+1500ms,但真實 ASR 相鄰片段間隔中位數 ~1.7s
//      (p90 2.6s)→ 每個子批最後一句系統性提早收(32% 短收 >1s)。
//   3. LLM 偶發 s 幻覺(~1.4%)整條被丟 → 該句時段空窗。
//
// 修法(結構性通則,單一資料源):顯示時間軸由 _resolveAsrEntryTimeline 以「片段時刻表 +
// LLM 給的句起點」分割——entry i 涵蓋 [s_i, s_{i+1}),LLM 的 e 完全不採信;批次末條
// 終點查 rawSegments 真實後繼片段起點(cap +5s 防長靜默 linger,無後繼才 +1500ms);
// 幻覺 s 落在批次範圍內時當保守邊界(cap 前一句 endMs),不讓前句譯文 linger 蓋到下一句。
//
// SANITY 紀錄（已驗證,2026-07-12）:
//   暫時把 _runAsrSubBatch 的 timeline 寫回改回舊邏輯(covered 用 entry 原始 e 當上界、
//   _upsertDisplayCue 傳 entry.e)→ case 1 fail(甲句 cue endMs=2000 非 6000,
//   'alpha three' captionMap 無 key)、case 2 fail(丙句 endMs=3000 非 1234)→ 還原 pass。
//   暫時把 _runAsrSubBatch 的 batchEndMs 改回 lastSeg.startMs + SK.ASR_LAST_CUE_FALLBACK_MS
//   → case 3 fail(payload 末條 e=4500 非 2900)→ 還原 pass。
//   暫時移除 _runAsrHeuristicWindow 的尾組 endMs 修正 → case 4 fail(尾 cue endMs=7500
//   非 8800)→ 還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

// 最小 YT state(isAsr=false 讓 _updateOverlay early return,不需 overlay DOM)
function ytStateExpr(rawSegments) {
  return `
    Object.assign(window.__SK.YT, {
      active: true,
      isAsr: false,
      videoEl: null,
      captionMap: new Map(),
      displayCues: [],
      rawSegments: ${JSON.stringify(rawSegments)},
      sessionStartTime: Date.now(),
      videoId: 'test',
      config: {},
    });
  `;
}

async function runSubBatch(evaluate, subSegs) {
  return await evaluate(`
    (async () => {
      await window.__SK._runAsrSubBatch(${JSON.stringify(subSegs)}, 0, Date.now(), [0]);
      return {
        cues: window.__SK.YT.displayCues.map(c => ({
          startMs: c.startMs, endMs: c.endMs, targetText: c.targetText,
        })),
        captionMap: Object.fromEntries(window.__SK.YT.captionMap),
      };
    })()
  `);
}

test.describe('youtube-asr-cue-timeline', () => {
  test('case 1: LLM 的 e 挑錯句中片段 → 顯示區間用時間軸分割,不採信 e', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const subSegs = [
      { startMs: 0,    text: 'alpha one',   normText: 'alpha one' },
      { startMs: 2000, text: 'alpha two',   normText: 'alpha two' },
      { startMs: 4000, text: 'alpha three', normText: 'alpha three' },
      { startMs: 6000, text: 'beta one',    normText: 'beta one' },
      { startMs: 8000, text: 'beta two',    normText: 'beta two' },
    ];
    // rawSegments 比 subSegs 多一條後繼(下一子批首條)@10500
    const rawSegments = [...subSegs, { startMs: 10500, text: 'next batch', normText: 'next batch' }];
    await evaluate(ytStateExpr(rawSegments));

    // LLM 回應:甲句 e=2000 挑錯(真實句尾在 6000 前);乙句 e=9500 也非分割真值
    await evaluate(`
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
          return { ok: true,
            result: ['[{"s":0,"e":2000,"t":"甲句"},{"s":6000,"e":9500,"t":"乙句"}]'],
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
        }
        return { ok: true };
      };
    `);

    const r = await runSubBatch(evaluate, subSegs);

    // 甲句涵蓋 [0, 6000)(下一 entry 的 s),不是 LLM 的 e=2000
    const cueA = r.cues.find(c => c.targetText === '甲句');
    expect(cueA, '甲句 cue 應存在').toBeTruthy();
    expect(cueA.endMs, '甲句 endMs 應為下一 entry 的 s(時間軸分割),不採信 LLM e').toBe(6000);
    // 句尾片段 alpha three(4000)不再 uncovered:歸甲句,存空字串
    expect(r.captionMap['alpha one'], '甲句譯文寫入第一片段').toBe('甲句');
    expect(r.captionMap['alpha two']).toBe('');
    expect(
      Object.prototype.hasOwnProperty.call(r.captionMap, 'alpha three'),
      'e 挑錯時句尾片段不得 uncovered(舊邏輯漏洞)',
    ).toBe(true);
    // 乙句(末 entry)涵蓋到 rawSegments 真實後繼起點 10500,不是 LLM 的 e=9500
    const cueB = r.cues.find(c => c.targetText === '乙句');
    expect(cueB.endMs, '末 entry endMs 應為 rawSegments 後繼片段起點').toBe(10500);

    await page.close();
  });

  test('case 2: 幻覺 s 整條丟棄,但落點合理時當前一句的保守邊界(不 linger)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const subSegs = [
      { startMs: 0,    text: 'gamma', normText: 'gamma' },
      { startMs: 3000, text: 'delta', normText: 'delta' },
    ];
    await evaluate(ytStateExpr(subSegs)); // 無後繼 → batchEnd = 3000 + 1500

    await evaluate(`
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
          return { ok: true,
            result: ['[' +
              '{"s":0,"e":99,"t":"丙句"},' +
              '{"s":1234,"e":2000,"t":"幻覺句"},' +   // s 不在片段集合,但落點在批次範圍內
              '{"s":3000,"e":3000,"t":"丁句"}' +      // e 零長度,舊 Drive 邏輯會整條丟
            ']'],
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
        }
        return { ok: true };
      };
    `);

    const r = await runSubBatch(evaluate, subSegs);

    expect(r.cues.find(c => c.targetText === '幻覺句'), '幻覺 s 不得產生 cue').toBeUndefined();
    const cueC = r.cues.find(c => c.targetText === '丙句');
    expect(cueC.endMs, '幻覺 s 當保守邊界:丙句止於 1234,不 linger 到 3000').toBe(1234);
    const cueD = r.cues.find(c => c.targetText === '丁句');
    expect(cueD, 'e 零長度不得整條丟(時間軸分割修復區間)').toBeTruthy();
    expect(cueD.endMs, '末 entry 無後繼 → fallback +1500').toBe(4500);

    await page.close();
  });

  test('case 3: 送 LLM 的 payload 末條 e 用 rawSegments 真實後繼起點(cap +5s)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const subSegs = [
      { startMs: 0,    text: 'one', normText: 'one' },
      { startMs: 2000, text: 'two', normText: 'two' },
    ];
    // 後繼 @2900(< 2000+5000)→ 末條 e 應為 2900(舊邏輯固定 2000+1500=3500)
    const rawSegments = [...subSegs, { startMs: 2900, text: 'next', normText: 'next' }];
    await evaluate(ytStateExpr(rawSegments));
    await evaluate(`
      window.__asrPayloads = [];
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
          window.__asrPayloads.push(msg.payload.texts[0]);
          return { ok: true, result: ['[]'],
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
        }
        return { ok: true };
      };
    `);
    await runSubBatch(evaluate, subSegs);
    let input = JSON.parse(await evaluate(`window.__asrPayloads[0]`));
    expect(input[1].e, '末條 e 應為 rawSegments 真實後繼起點 2900').toBe(2900);

    // 後繼 @9000(> 2000+5000)→ cap 在 2000+5000=7000(長靜默不 linger)
    const rawFar = [...subSegs, { startMs: 9000, text: 'far', normText: 'far' }];
    await evaluate(ytStateExpr(rawFar));
    await evaluate(`window.__asrPayloads = [];`);
    await runSubBatch(evaluate, subSegs);
    input = JSON.parse(await evaluate(`window.__asrPayloads[0]`));
    expect(input[1].e, '後繼過遠 → cap 於 lastStart + ASR_LAST_CUE_MAX_EXTEND_MS').toBe(7000);

    await page.close();
  });

  test('case 4: heuristic 路徑視窗尾組 endMs 用 rawSegments 後繼(不固定 +1500)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // 兩句(gap 3000 > _ASR_MIN_INTERVAL 保證 heuristic 切成兩組):
    //   句1 @0-1000,句2 @6000;視窗後繼片段 @8800
    const windowSegs = [
      { startMs: 0,    text: 'first sentence words', normText: 'first sentence words' },
      { startMs: 6000, text: 'second sentence words', normText: 'second sentence words' },
    ];
    const rawSegments = [...windowSegs, { startMs: 8800, text: 'after window', normText: 'after window' }];
    await evaluate(ytStateExpr(rawSegments));
    await evaluate(`
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
          const texts = (msg.payload && msg.payload.texts) || [];
          // 譯文刻意短:閱讀補償(200ms/字,min 800)不得超過分割區間,否則斷言驗不到 endMs
          return { ok: true, result: texts.map(() => '短譯'),
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
        }
        return { ok: true };
      };
    `);
    await evaluate(`
      (async () => { await window.__SK._runAsrHeuristicWindow(${JSON.stringify(windowSegs)}, 0, {}); })()
    `);
    // 輪詢等 heuristic 批次寫入 displayCues
    const start = Date.now();
    let cues = [];
    while (Date.now() - start < 5000) {
      cues = JSON.parse(await evaluate(
        `JSON.stringify(window.__SK.YT.displayCues.map(c => ({ startMs: c.startMs, endMs: c.endMs })))`,
      ));
      if (cues.length >= 2) break;
      await page.waitForTimeout(50);
    }
    expect(cues.length, 'heuristic 應產生 2 個 cue').toBeGreaterThanOrEqual(2);
    const lastCue = cues[cues.length - 1];
    expect(lastCue.endMs, '尾組 endMs 應為 rawSegments 後繼起點 8800(舊邏輯 6000+1500=7500)').toBe(8800);

    await page.close();
  });
});
