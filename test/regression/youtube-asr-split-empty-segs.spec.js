// Regression: _splitAsrSubBatches 不應回傳含空 subarray 的結果(v1.9.22)
//
// 真正 root cause(v1.9.22):
//   Chrome for Claude 實機 20-iter rapid seek 出現 6 次「asr llm overlay failed:
//   Cannot read properties of undefined (reading 'startMs')」。
//   逆推:_runAsrWindow line 1736 `subBatches.map(b => \`${b[0].startMs/1000}...\`)`
//   如果 `b` 是空 array,`b[0]` 是 undefined → throw。
//
//   `_splitAsrSubBatches` 有兩條 return path 會回 `[[]]`(陣列含一個空 subarray):
//     A. windowSegs 空 → `return [windowSegs]` = `[[]]`(但 translateWindowFrom
//        外層 `if (windowSegs.length > 0)` 已 guard,理論上不該觸發)
//     B. **leadMs ≤ 0 AND 所有 windowSegs.startMs < videoNowMs**(=seek 到視窗最尾,
//        該視窗的 ASR segments 都已過去)→ `segs = windowSegs.filter(s => s.startMs >= sub0Start)`
//        = `[]` → 走 `if (segs.length <= 5) return [segs]` → 回 `[[]]`
//
//   B 完美吻合 30% 觸發率:rapid seek 容易剛好落在視窗尾段。
//
// 修法:所有 return path 加 `length === 0 → return []`(空 subBatches,_runAsrWindow
// 外層的 `if (subBatches.length === 0) return;` guard 就會生效)。
//
// SANITY 已驗:在 _splitAsrSubBatches 拔掉 length===0 guard → case 2 fail(throw 或
// 回傳含空 subarray)。

import { test, expect } from '@playwright/test';
import { test as extTest } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-window-retry';

extTest('asr-split case 1: leadMs ≤ 0 + 所有 segs 在 videoNowMs 之前 → 不該回含空 subarray', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // windowSegs 8 條都在 30-37s 區間(>5 條,跳過第一個 early return),
  // 模擬 video 已播到 50s(過了視窗尾,leadMs = -20s)→ segs.filter 後變空 → 觸發 bug
  const result = await evaluate(`
    (() => {
      const windowSegs = [];
      for (let i = 0; i < 8; i++) {
        windowSegs.push({ startMs: 30000 + i * 1000, endMs: 30000 + i * 1000 + 800,
                           text: 'seg' + i, normText: 'seg' + i });
      }
      const subBatches = window.__SK._splitAsrSubBatches(
        windowSegs,
        50000,   // videoNowMs 已過所有 segs(全 30-37s 之間)
        30000,   // windowStartMs
        1        // playbackRate
      );
      return {
        len: subBatches.length,
        emptySubBatches: subBatches.filter(b => b.length === 0).length,
        subBatchLens: subBatches.map(b => b.length),
      };
    })()
  `);

  // 修法後預期:回 [](length 0),沒任何 empty subarray
  expect(
    result.emptySubBatches,
    `★ 核心斷言:_splitAsrSubBatches 不該回含空 subarray,實際有 ${result.emptySubBatches} 個空`,
  ).toBe(0);
});

extTest('asr-split case 2: 一般情境(leadMs > 0,segs 充足)→ subBatches 正常,皆非空', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const windowSegs = [];
      for (let i = 0; i < 12; i++) {
        windowSegs.push({ startMs: 30000 + i * 1500, endMs: 30000 + i * 1500 + 1000, text: 'seg' + i, normText: 'seg' + i });
      }
      const subBatches = window.__SK._splitAsrSubBatches(
        windowSegs,
        10000,   // videoNowMs(早於 windowStartMs,leadMs > 0)
        30000,
        1
      );
      return {
        len: subBatches.length,
        emptySubBatches: subBatches.filter(b => b.length === 0).length,
        subBatchLens: subBatches.map(b => b.length),
      };
    })()
  `);

  expect(result.len, '一般情境應有 ≥ 1 個 subBatch').toBeGreaterThanOrEqual(1);
  expect(result.emptySubBatches, '一般情境不該有空 subBatch').toBe(0);
});

extTest('asr-split case 3: windowSegs 完全空 → 回空 subBatches([])', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const subBatches = window.__SK._splitAsrSubBatches([], 0, 30000, 1);
      return { len: subBatches.length, emptySubBatches: subBatches.filter(b => b.length === 0).length };
    })()
  `);

  expect(result.len, '空 input 應回空 subBatches(不是 [[]])').toBe(0);
  expect(result.emptySubBatches, '不該有任何 empty subarray').toBe(0);
});
