// Regression: v1.10.46 批次 3-6 / 3-7 / 3-8 — content-drive.js 字幕 pipeline 三條防護
//
//   3-6 DRIVE_ASR_CAPTIONS 無重入 guard：同一支字幕重複送進來（iframe reload /
//       PerformanceObserver 重複捕捉）→ entries 疊加 + 整支重翻（token ×2）。
//       修法：rawSegments 指紋（條數 + 首尾 startMs）判重，DRIVE._lastCaptionsFp。
//   3-7 LLM 路徑不驗 entry.s 對齊原始 startMs:LLM 幻覺時間戳直接上 overlay。
//       修法：對齊驗證收斂到 SK.ASR.normalizeAsrEntry（跟 YT _runAsrSubBatch 共用，
//       避免同協定雙實作 drift);Drive 端零長度 cue（區間顯示永不可見）一併丟棄。
//       v2.0.54 演進:normalizeAsrEntry → SK.ASR.resolveEntryTimeline(時間軸分割,
//       LLM 的 e 不採信)——幻覺 s 仍丟棄;e 零長度但 s 有效的 entry 改由分割補齊
//       顯示區間(不再整條丟),對應斷言已更新。詳見 youtube-asr-cue-timeline.spec.js。
//   3-8 engine latch 註解與實作不符：_engine 每批重讀，mid-run 切設定跨批混用
//       google / gemini / openai-compat 結果。修法：_handleCaptionsMessage 開頭
//       latch 成 const 傳進 worker。
//
// 驅動方式：翻譯 pipeline（v1.10.46 起）定義在 runtime gate 之前並暴露
// SK._driveHandleCaptionsMessage / SK._driveSetEngine seam,localServer fixture 頁
// 可直接呼叫（同檔既有 SK._drive* helpers 慣例）;production 行為不變
// (gate 之前只定義函式，不掛 listener)。
//
// SANITY 紀錄（已驗證，2026-06-11）:
//   (a) 暫時註解 _handleCaptionsMessage 的 `DRIVE._lastCaptionsFp === _fp` 判重
//       → case 2 fail（重複 payload 重翻，entries 疊加）→ 還原 pass。
//   (b) 暫時把 _runOneBatchLlm 的 normalizeAsrEntry 改回只驗 isFinite（不查 startMsSet）
//       → case 1 fail（幻覺時間戳 entry 被 push）→ 還原 pass。
//   (c) 暫時把 worker 內 `engine` 改回讀 `_engine` → case 4 fail（第 4 批變 google）
//       → 還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'drive-bilingual-overlay';

const JSON3_TWO_SEGS = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: 'hello' }] },
    { tStartMs: 3000, segs: [{ utf8: 'world' }] },
  ],
});

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

test.describe('drive-captions-pipeline-guards', () => {
  test('case 1(3-7): LLM 幻覺時間戳 / 零長度 entry 被丟棄，只 push 對齊 entry', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(`
      window.__msgTypes = [];
      chrome.runtime.sendMessage = async function(msg) {
        if (!msg || !String(msg.type).startsWith('TRANSLATE_DRIVE_')) return { ok: true }; // LOG 等雜訊放行
        window.__msgTypes.push(msg.type);
        return { ok: true, result: [JSON.stringify([
          { s: 0,     e: 3000, t: '譯文一' },   // 對齊（s=原始 startMs）→ push
          { s: 99999, e: 100000, t: '幻覺' },  // s 不在原始 startMs 集合 → 丟
          { s: 3000,  e: 3000, t: '零長度' },  // 零長度 cue 區間顯示永不可見 → 丟
        ])], usage: {} };
      };
    `);

    await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);

    const r = await evaluate(`
      ({ entries: window.__SK.DRIVE.entries.map(e => e.text), msgTypes: window.__msgTypes })
    `);
    expect(r.msgTypes, '應送出 1 批 Gemini LLM 請求').toEqual(['TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH']);
    // v2.0.54:resolveEntryTimeline 取代 normalizeAsrEntry——幻覺 s 仍丟棄;
    // 「e 零長度」的 entry 因 s 對齊有效,改由時間軸分割修復顯示區間(舊邏輯整條丟 =
    // 該片段的譯文永遠不顯示),所以 '零長度' 現在應該上 overlay
    expect(r.entries, '對齊 entry 上 overlay(含 e 零長度但 s 有效者),幻覺 s 被丟').toEqual(['譯文一', '零長度']);
    const zeroLenEntry = await evaluate(`window.__SK.DRIVE.entries.find(e => e.text === '零長度')`);
    expect(zeroLenEntry.endMs, 'e 零長度 entry 的區間由時間軸分割補齊(3000 + fallback 1500)').toBe(4500);

    await page.close();
  });

  test('case 2+3(3-6): 同 payload 重複送 → 跳過不重翻；不同 payload 照翻', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(`
      window.__llmCalls = 0;
      chrome.runtime.sendMessage = async function(msg) {
        if (!msg || !String(msg.type).startsWith('TRANSLATE_DRIVE_')) return { ok: true }; // LOG 等雜訊放行
        window.__llmCalls++;
        return { ok: true, result: ['[{"s":0,"e":3000,"t":"譯文"}]'], usage: {} };
      };
    `);

    await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);
    const after1 = await evaluate(`({ calls: window.__llmCalls, entries: window.__SK.DRIVE.entries.length })`);

    // 同一支字幕重複進來 → 指紋判重，不重翻不疊加
    await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);
    const after2 = await evaluate(`({ calls: window.__llmCalls, entries: window.__SK.DRIVE.entries.length })`);
    expect(after2.calls, '重複 payload 不得再送 API').toBe(after1.calls);
    expect(after2.entries, '重複 payload 不得疊加 entries').toBe(after1.entries);

    // 不同字幕（條數 / 首尾 startMs 不同）→ 照翻
    const json3Other = JSON.stringify({
      events: [
        { tStartMs: 0,    segs: [{ utf8: 'aa' }] },
        { tStartMs: 2000, segs: [{ utf8: 'bb' }] },
        { tStartMs: 9000, segs: [{ utf8: 'cc' }] },
      ],
    });
    await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(json3Other)} } })`);
    const after3 = await evaluate(`window.__llmCalls`);
    expect(after3, '不同 payload 應照翻（指紋不得誤殺）').toBeGreaterThan(after2.calls);

    await page.close();
  });

  test('case 4(3-8): mid-run 切 engine → 已啟動的整支翻譯維持 latch 的 engine，不跨批混用', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // 91 段 → BATCH_SIZE 30 切 4 批；MAX_CONCURRENT 3 → 前 3 批先 in-flight。
    // mock:LLM 批掛起（可手動放行），記錄每批 msg type。
    await evaluate(`
      window.__msgTypes = [];
      window.__resolvers = [];
      chrome.runtime.sendMessage = function(msg) {
        if (!msg || !String(msg.type).startsWith('TRANSLATE_DRIVE_')) return Promise.resolve({ ok: true }); // LOG 等雜訊放行
        window.__msgTypes.push(msg.type);
        return new Promise(res => {
          window.__resolvers.push(() => res({ ok: true, result: ['[]'], usage: {} }));
        });
      };
      window.__driveEvents = { events: [] };
      for (let i = 0; i < 91; i++) {
        window.__driveEvents.events.push({ tStartMs: i * 1000, segs: [{ utf8: 'seg ' + i }] });
      }
    `);

    // 不 await handler（整支要等全部批次），先放著跑
    await evaluate(`
      (window.__handlerP = window.__SK._driveHandleCaptionsMessage({
        payload: { json3: JSON.stringify(window.__driveEvents) },
      }), true)
    `);

    // 等前 3 批 in-flight
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if ((await evaluate(`window.__resolvers.length`)) >= 3) break;
      await page.waitForTimeout(50);
    }
    expect(await evaluate(`window.__resolvers.length`), '前 3 批應 in-flight').toBe(3);

    // mid-run 切 engine → 第 4 批不得變 google
    await evaluate(`window.__SK._driveSetEngine('google')`);
    await evaluate(`window.__resolvers.splice(0).forEach(fn => fn())`);

    // 等第 4 批送出 + 放行收尾
    const start2 = Date.now();
    while (Date.now() - start2 < 5000) {
      if ((await evaluate(`window.__msgTypes.length`)) >= 4) break;
      await page.waitForTimeout(50);
    }
    await evaluate(`window.__resolvers.splice(0).forEach(fn => fn())`);

    const types = await evaluate(`window.__msgTypes`);
    expect(types.length, '4 批都應送出').toBe(4);
    expect(
      types.every(t => t === 'TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH'),
      `mid-run 切 engine 後第 4 批仍應走 latch 的 gemini，實際： ${JSON.stringify(types)}`,
    ).toBe(true);

    // 還原 engine 設定殘影（模組 let，跨 case 不共享頁面所以其實安全，防呆）
    await evaluate(`window.__SK._driveSetEngine('gemini')`);
    await page.close();
  });
});
