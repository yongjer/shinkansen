// Regression: SPA rescan cap overflow 不可被標進 seenTexts (v1.10.15)
//
// Bug:SPA observer rescan 收到一批新內容時,原本先把「全部找到的 unit」標進
// spaObserverSeenTexts(防注入自身觸發 mutation 重入迴圈),再 slice 到
// SPA_OBSERVER_MAX_UNITS(50)。當一次 collectParagraphs 抓到 > 50 個 unit
// (真實場景:YouTube 留言批次 lazy-load,一次進來 64 則),被 slice 丟掉的
// overflow(14 則)已經在 seenTexts 內 → 後續 rescan 被 isSeenTextRecent 擋住
// 30s TTL → 使用者停止捲動後那批永遠不翻,造成留言區交錯漏翻。
//
// 修法:capUnitsAndMarkSeen 先 cap 再標 seen,只把「本輪實際要翻的 ≤MAX_UNITS 個」
// 標進 seenTexts;overflow 不標,留給下一輪 rescan 重新收進來。capped 時 rescan
// 主動 armSpaObserverRescan() 把剩下的接住(不依賴注入 mutation 是否觸發)。
//
// 這條驗:cap 後 seenTexts 只含 kept slice、overflow 仍 eligible(isSeenTextRecent=false)。
// 不驗:armSpaObserverRescan 的 timer 行為(那條由 spa-observer-max-wait 等覆蓋)、
//       真實 collectParagraphs 抓 unit 的邏輯。
//
// SANITY 紀錄(已驗證):暫時把 capUnitsAndMarkSeen 改回「先 units.forEach 標 seen
// 再 slice」舊順序 → test「overflow 不可被標 seen」fail → 還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('rescan 超過 MAX_UNITS 時,只有 kept slice 被標 seen,overflow 仍 eligible', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const max = SK.SPA_OBSERVER_MAX_UNITS;
      const total = max + 14; // 模擬 YouTube 一次 lazy-load 64 則 > cap 50
      SK._spaObserverSeenTexts.clear();
      // 建真實 DOM element(innerText 需要附在 document 上才有值)
      const units = [];
      const root = document.createElement('div');
      document.body.appendChild(root);
      for (let i = 0; i < total; i++) {
        const el = document.createElement('div');
        el.textContent = 'cap-overflow-unit-' + i;
        root.appendChild(el);
        units.push({ el });
      }
      const now = Date.now();
      const { kept, capped } = SK._capUnitsAndMarkSeen(units, now);
      // 第一個 kept(在 cap 內)與第一個 overflow(被丟掉)各取一個驗 seen 狀態
      const keptText = 'cap-overflow-unit-0';
      const overflowText = 'cap-overflow-unit-' + max; // 第 max 個(0-indexed)= 第一個被丟的
      const r = {
        capped,
        keptLen: kept.length,
        seenSize: SK._spaObserverSeenTexts.size,
        keptIsSeen: SK._isSeenTextRecent(keptText),
        overflowIsSeen: SK._isSeenTextRecent(overflowText),
        max,
        total,
      };
      root.remove();
      SK._spaObserverSeenTexts.clear();
      return r;
    })()
  `);

  expect(result.capped, '14 個 overflow → capped=true').toBe(true);
  expect(result.keptLen, 'kept 應正好等於 MAX_UNITS').toBe(result.max);
  expect(result.seenSize, 'seenTexts 只含 kept slice(MAX_UNITS 個),不含 overflow').toBe(result.max);
  expect(result.keptIsSeen, 'kept 內的 unit 應被標 seen(防重入)').toBe(true);
  expect(result.overflowIsSeen, 'overflow unit 不可被標 seen,否則下一輪 rescan 被擋死永遠不翻').toBe(false);

  await page.close();
});

test('rescan 未超過 MAX_UNITS 時,全部標 seen 且 capped=false', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK._spaObserverSeenTexts.clear();
      const root = document.createElement('div');
      document.body.appendChild(root);
      const units = [];
      for (let i = 0; i < 5; i++) {
        const el = document.createElement('div');
        el.textContent = 'undercap-unit-' + i;
        root.appendChild(el);
        units.push({ el });
      }
      const { kept, capped } = SK._capUnitsAndMarkSeen(units, Date.now());
      const r = { capped, keptLen: kept.length, seenSize: SK._spaObserverSeenTexts.size };
      root.remove();
      SK._spaObserverSeenTexts.clear();
      return r;
    })()
  `);

  expect(result.capped, '5 < 50 → capped=false').toBe(false);
  expect(result.keptLen, '未超 cap → kept = 全部').toBe(5);
  expect(result.seenSize, '未超 cap → 全部標 seen').toBe(5);

  await page.close();
});
