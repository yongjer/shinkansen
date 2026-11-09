// Regression: v1.10.46 批次 3-9 — _ASR_BREAK_WORDS 的 '- ' 是 dead entry
//
// 痛點：kle 初切比對前已 `c.utf8.trim().toLowerCase()`，含尾空格的 '- ' entry
// 永遠不可能命中 → speaker-change dash 斷句失效，不同說話者的句子被黏在同一合句。
//
// 修法位置：shinkansen/content-youtube.js _ASR_BREAK_WORDS:'- ' → '-'
//
// 結構通則：鎖「standalone dash segment（gap > _ASR_BREAK_MINI_TIME）觸發合句邊界」
// 行為，經 SK.ASR.mergeAsr 完整 heuristic pipeline（kle/Ile/Lle）驗證。
//
// SANITY 紀錄（已驗證，2026-06-11）:
//   暫時把 '-' 改回 '- ' → dash 不再觸發 break，兩句被黏成同一合句 → case fail。
//   還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';

test('youtube-asr-break-dash: standalone "-" segment（speaker change）應觸發合句邊界', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const sentences = window.__SK.ASR.mergeAsr([
        { text: 'we were just', startMs: 0 },
        { text: 'talking about it', startMs: 500 },
        { text: '-', startMs: 1500 },
        { text: 'really interesting', startMs: 1900 },
        { text: 'point you made', startMs: 2400 },
      ]);
      return sentences.map(s => s.text);
    })()
  `);

  // dash（gap 1000ms > _ASR_BREAK_MINI_TIME 300）應切出新合句：
  // 前句不得含 dash 之後的內容
  const firstWithDashTail = r.find(t => t.includes('talking about it') && t.includes('really interesting'));
  expect(
    firstWithDashTail,
    `dash 前後應為不同合句，實際合句： ${JSON.stringify(r)}`,
  ).toBeUndefined();
  expect(r.length, `應至少切成 2 個合句，實際： ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(2);

  await page.close();
});
