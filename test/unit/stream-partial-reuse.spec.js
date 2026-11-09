// Unit test: lib/stream-reuse.js planStreamingPartialReuse
// (對應 v1.10.61 修的「streaming 批次只要一段 miss 就整批重打 Gemini」效率 bug)
//
// 背景:background.js handleTranslateStream 原本只在「整批全命中(allHit)」時走 fast
// path 零 API,只要有一段 miss 就把整批 texts 重送 Gemini(含已快取段落)。改成跟
// handleTranslate / openai-compat 一致的 missing-only:已快取段落即刻回推、只把 miss 的
// 段落送 stream。唯一的新風險是「index 對映」——本 spec 鎖死它。
//
// 驗的訊號層次:planStreamingPartialReuse 純資料分流的正確性(split / 原始 index /
// remap / cache 寫回配對)。不驗 background.js 的訊息傳遞、cache I/O、content 注入
// (那些走既有 proven 路徑,且 SW orchestration 無 export 不易單測)。
//
// SANITY 紀錄(已驗證,2026-06-20):
//   破壞 1:lib/stream-reuse.js 把 `missingIdxs.push(i)` 改成 `missingIdxs.push(i + 1)`
//     → 「remap 後重建完整譯文」斷言 fail(段落注入錯位 / 漏段)。還原後 pass。
//   破壞 2:把 cachedSegments 的 `idx: i` 改成 `idx: 0`
//     → 「已快取段落帶原始 index」斷言 fail。還原後 pass。
//   破壞 3:把 missingTexts.push(texts[i]) 改成 push(texts[0])
//     → 「cache 寫回用 missingTexts 對齊原文」斷言 fail。還原後 pass。
import { test, expect } from '@playwright/test';

const { planStreamingPartialReuse } = await import('../../shinkansen/lib/stream-reuse.js');

// 模擬完整一輪 streaming partial-reuse 的「交付」結果:
//   1. cachedSegments 以原始 index 回推
//   2. translateBatchStream 以 missingTexts 內的 index(0..M-1)回 onSegment,經
//      missingIdxs remap 回原始 index 後注入
// 重建出來的陣列應該跟「期望的完整譯文」逐格相同。
function simulateDelivery(plan, total, freshTranslations) {
  const delivered = new Array(total).fill(undefined);
  for (const seg of plan.cachedSegments) {
    delivered[seg.idx] = seg.translation;
  }
  // stream 給 mIdx(missingTexts 內 index),background 端 remap 成 missingIdxs[mIdx]
  freshTranslations.forEach((tr, mIdx) => {
    const origIdx = plan.missingIdxs[mIdx];
    delivered[origIdx] = tr;
  });
  return delivered;
}

test('planStreamingPartialReuse: split / 原始 index / remap / cache 配對全對', () => {
  const texts = ['a', 'b', 'c', 'd', 'e'];
  // 命中 a / c / e,miss b / d(模擬 feed 中間插了兩段新內容)
  const cached = ['A', null, 'C', null, 'E'];

  const plan = planStreamingPartialReuse(cached, texts);

  // 1. miss 段落:原始 index 與原文都對
  expect(plan.missingIdxs).toEqual([1, 3]);
  expect(plan.missingTexts).toEqual(['b', 'd']);

  // 2. 已快取段落帶「原始 index」(content 端 segmentIdx 對應 job.texts)
  expect(plan.cachedSegments).toEqual([
    { idx: 0, translation: 'A' },
    { idx: 2, translation: 'C' },
    { idx: 4, translation: 'E' },
  ]);

  // 3. cache 寫回用 missingTexts 對齊原文:missingTexts[k] 必須等於 texts[missingIdxs[k]]
  plan.missingIdxs.forEach((origIdx, k) => {
    expect(plan.missingTexts[k]).toBe(texts[origIdx]);
  });

  // 4. remap 後重建完整譯文:stream 對 missing 回 ['B','D'],最終每格都對、無漏
  const delivered = simulateDelivery(plan, texts.length, ['B', 'D']);
  expect(delivered).toEqual(['A', 'B', 'C', 'D', 'E']);
});

test('planStreamingPartialReuse: 全 miss(冷快取)時 cachedSegments 空、missingIdxs 連續', () => {
  const texts = ['x', 'y', 'z'];
  const cached = [null, null, null];

  const plan = planStreamingPartialReuse(cached, texts);

  expect(plan.cachedSegments).toEqual([]);
  expect(plan.missingIdxs).toEqual([0, 1, 2]);
  expect(plan.missingTexts).toEqual(['x', 'y', 'z']);

  const delivered = simulateDelivery(plan, texts.length, ['X', 'Y', 'Z']);
  expect(delivered).toEqual(['X', 'Y', 'Z']);
});

test('planStreamingPartialReuse: 只有最後一段 miss(feed 底端新文章)時 remap 正確', () => {
  // 重現 cage 實測 Round 2 的形狀:batch 內絕大多數命中,尾端少數新內容 miss
  const texts = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
  const cached = ['T0', 'T1', 'T2', 'T3', 'T4', null, null];

  const plan = planStreamingPartialReuse(cached, texts);

  expect(plan.missingIdxs).toEqual([5, 6]);
  expect(plan.missingTexts).toEqual(['t5', 't6']);
  expect(plan.cachedSegments.length).toBe(5);

  // stream 對 missing 回 ['T5','T6'] → 經 remap 落在原始 index 5 / 6
  const delivered = simulateDelivery(plan, texts.length, ['T5', 'T6']);
  expect(delivered).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
});
