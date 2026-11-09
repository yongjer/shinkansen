// Pure regression: selectBestSlotOccurrences (對應 v0.57 graceful slot dedup)
//
// 純函式測試 (Category C):純文字字串 → 純文字字串,不需要 DOM、不需要 LLM。
// 透過 window.__shinkansen.selectBestSlotOccurrences 呼叫(v0.59 為了測試暴露)。
//
// 規則:
//   - 同一個 slot index 出現多次 → 保留「首個非空」occurrence,把其他 occurrence
//     拆殼 (只留 inner text,丟外殼 ⟦N⟧/⟦/N⟧)。
//   - 若所有 occurrence 都是空殼,保留第一個 (反正都一樣)。
//   - 巢狀 ⟦3⟧⟦4⟧x⟦/4⟧⟦/3⟧ → top-level regex 用 backreference \1,不會抓到
//     內層 ⟦4⟧ 當作獨立 occurrence,因此不動。
//   - 沒有重複 → 不動,原樣回傳。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

// 任意一個 fixture HTML 都可以,只是為了讓 content script load 進來、
// 拿到 isolated world。pure 測試本身不依賴 DOM。
const ANY_FIXTURE = 'br-paragraph';

test('selectBestSlotOccurrences pure: 4 cases', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${ANY_FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  async function dedup(text) {
    const expr = `JSON.stringify(window.__shinkansen.selectBestSlotOccurrences(${JSON.stringify(text)}))`;
    return JSON.parse(await evaluate(expr));
  }

  // Case A: 兩個 occurrence 都非空 → winner = 第一個 (A),loser = 第二個 (B 拆殼)
  const a = await dedup('⟦0⟧A⟦/0⟧⟦0⟧B⟦/0⟧');
  expect(a).toBe('⟦0⟧A⟦/0⟧B');

  // Case B: 第一個是空殼、第二個非空 → winner = 第二個 (B),loser = 第一個空殼
  // 第一個 occurrence inner = '',拆殼後變成 '' → 結果 '⟦0⟧B⟦/0⟧'
  const b = await dedup('⟦0⟧⟦/0⟧⟦0⟧B⟦/0⟧');
  expect(b).toBe('⟦0⟧B⟦/0⟧');

  // Case C: 巢狀 ⟦3⟧⟦4⟧x⟦/4⟧⟦/3⟧ → top-level regex 抓到的是整段外層 idx=3,
  // 內層 ⟦4⟧ 不被當作獨立 occurrence,沒有重複 → 不動
  const c = await dedup('⟦3⟧⟦4⟧x⟦/4⟧⟦/3⟧');
  expect(c).toBe('⟦3⟧⟦4⟧x⟦/4⟧⟦/3⟧');

  // Case D: 兩個不同 idx,沒有重複 → 不動
  const d = await dedup('⟦0⟧A⟦/0⟧⟦1⟧B⟦/1⟧');
  expect(d).toBe('⟦0⟧A⟦/0⟧⟦1⟧B⟦/1⟧');

  // 額外 Case E (回歸 v0.57 真實案例的縮小版):3 個 occurrence,前兩個非空,
  // 第三個空殼 → winner 是第一個非空 (X),其他兩個都是 loser
  const e = await dedup('⟦0⟧X⟦/0⟧⟦0⟧Y⟦/0⟧⟦0⟧⟦/0⟧');
  expect(e).toBe('⟦0⟧X⟦/0⟧Y');

  // 額外 Case F: 全部 occurrence 都是空殼 → winner = 第一個,其他拆殼成空
  const f = await dedup('⟦0⟧⟦/0⟧⟦0⟧⟦/0⟧');
  expect(f).toBe('⟦0⟧⟦/0⟧');

  await page.close();
});
