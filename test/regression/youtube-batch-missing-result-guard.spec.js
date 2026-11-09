// Regression(code review 2026-06-09 M8,pending queue 補測 2026-06-10):
//   YouTube ASR heuristic(_runAsrHeuristicWindow 內 _runBatch)與 on-the-fly
//   (flushOnTheFly)兩條批次路徑,對 background 回應的 `res.result` 缺失防禦。
//
// 背景(§5 單一資料源 drift):
//   非 ASR 主路徑 _injectBatchResult 早就用 `res.result || []` 防「res.ok=true 但
//   res.result 缺失」。但 heuristic 與 on-the-fly 兩條平行路徑沿用 `res.result[j]`
//   直接索引,沒跟上 → 一旦 background 回 ok=true 卻不帶 result(契約違反),
//   `undefined[j]` 在 per-unit 迴圈第一步就丟 TypeError。
//
// 修法(content-youtube.js 兩處):改成 `const results = res.result || []` 再索引,
//   缺 result 時每段 fallback 回原文(`results[i] || texts[i]`),不丟例外。
//
// 觀測點(關鍵):兩條路徑的 result 迴圈都包在 try/catch 內,throw 會被吞掉 →
//   不能用「promise 不 reject」當斷言。改觀測 captionMap:
//     - 有 fix:results=[] → 每段 fallback 原文 → captionMap 被填(size > 0)
//     - 無 fix:`undefined[j]` 在迴圈第一步 throw → 被 catch 吞 → captionMap 維持空
//
// 本 spec 鎖的訊號層(CLAUDE.md 工作流原則 §3):
//   驗「background 回 ok 但缺 result 時,兩條路徑不靜默丟空字幕、而是 fallback 原文寫入
//   captionMap」。不驗 background 真的會不會違反契約(正常不會)、也不驗 overlay 視覺。
//
// SANITY CHECK 紀錄(已驗證,2026-06-10):
//   把 content-youtube.js 兩處 `const results = res.result || []` 改回
//   `res.result[j]` / `res.result[i]` 直接索引 → 兩個 case 的「captionMap.size > 0」
//   斷言皆 fail(throw 被 try/catch 吞,captionMap 維持空)。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

const USAGE = `{ inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, segments: 0, cacheHits: 0 }`;
const SESSION_USAGE = `{ inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0, segments: 0, cacheHits: 0 }`;

test('youtube heuristic / on-the-fly:res.result 缺失時 fallback 原文不丟空(M8)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 共用 mock:safeSendMessage 故意回 ok=true 但「不帶 result」(契約違反場景),帶 usage
  // 讓 _logWindowUsage 正常累計。
  await evaluate(`
    window.__SK.safeSendMessage = async function() {
      return { ok: true, usage: ${USAGE} };
    };
  `);

  // ── Case 1:heuristic 路徑(_runAsrHeuristicWindow 內 _runBatch)──
  const heuristic = await evaluate(`
    (async () => {
      Object.assign(window.__SK.YT, {
        active: true, isAsr: false, videoEl: null,
        captionMap: new Map(), displayCues: [],
        sessionStartTime: Date.now(), sessionUsage: ${SESSION_USAGE},
        videoId: 'test', config: {},
      });
      // 3 條 ASR raw seg(gap 500ms < MIN_INTERVAL 1000)→ 合成 1 句、3 個 sourceSeg
      const windowSegs = [
        { text: 'hello ',   normText: 'hello',   startMs: 0 },
        { text: 'world ',   normText: 'world',   startMs: 500 },
        { text: 'and now ', normText: 'and now', startMs: 1000 },
      ];
      let threw = null;
      try {
        await window.__SK._runAsrHeuristicWindow(windowSegs, 0, {});
      } catch (e) { threw = { name: e.name, message: e.message }; }
      const cm = window.__SK.YT.captionMap;
      return {
        threw,
        size: cm.size,
        firstVal: cm.get('hello'),    // 多段 sentence:keys[0] 拿整句原文 fallback
      };
    })()
  `);

  expect(heuristic.threw, `heuristic 路徑不應拋未捕獲例外;實際:${JSON.stringify(heuristic.threw)}`).toBeNull();
  expect(heuristic.size, 'heuristic:缺 result 時應 fallback 原文填入 captionMap(非空)').toBeGreaterThan(0);
  expect(heuristic.firstVal, 'heuristic:fallback 值應為原文整句').toContain('hello world');

  // ── Case 2:on-the-fly 路徑(flushOnTheFly)──
  const onTheFly = await evaluate(`
    (async () => {
      Object.assign(window.__SK.YT, {
        active: true, flushing: false,
        pendingQueue: new Map([['hello world', []], ['foo bar', []]]),
        captionMap: new Map(),
        sessionStartTime: Date.now(), sessionUsage: ${SESSION_USAGE},
        config: {},
      });
      let threw = null;
      try {
        await window.__SK._flushOnTheFly();
      } catch (e) { threw = { name: e.name, message: e.message }; }
      const cm = window.__SK.YT.captionMap;
      return {
        threw,
        size: cm.size,
        val0: cm.get('hello world'),
        val1: cm.get('foo bar'),
      };
    })()
  `);

  expect(onTheFly.threw, `on-the-fly 路徑不應拋未捕獲例外;實際:${JSON.stringify(onTheFly.threw)}`).toBeNull();
  expect(onTheFly.size, 'on-the-fly:缺 result 時應 fallback 原文填入 captionMap(2 段)').toBe(2);
  expect(onTheFly.val0, 'on-the-fly:第一段 fallback 原文').toBe('hello world');
  expect(onTheFly.val1, 'on-the-fly:第二段 fallback 原文').toBe('foo bar');

  await page.close();
});
