// Regression: detect-hidden-container-skip（對應 code review 2026-07-08 R5(b),dev tail 2.0.7.1 修）
//
// Fixture: test/regression/fixtures/detect-hidden-container-skip.html
// 結構：display:none 的非 block 容器（DIV，直接 text + <br><br>,Case B 形狀）
//       + 同結構可見對照組。
// Bug：非 block 容器的 Case A-F 補抓全程不查 SK.isVisible（葉節點補抓路徑都有查，
//     不對稱漏檢）。block 路徑的 isVisible REJECT 在 acceptNode 較後段，非 block
//     分支在它之前就 return，擋不住 → display:none 的 template / 未展開 modal /
//     prerender 內容照收照翻，純燒 token（probe 實測重現）。
// 修法（content-detect.js 非 block 容器分支）:Case A-F 入口補
//     `SK.isVisible(el) &&` gate。
//
// 本 spec 鎖的訊號層：驗「偵測端不收 display:none 容器」。不驗 token 用量 /
//   API 呼叫層（偵測端擋掉後根本進不了翻譯批次）。
//
// SANITY 紀錄（已驗證，2026-07-08）：把 Case A-F 入口的 `SK.isVisible(el) &&`
//   拿掉 → 「hidden container 不應進 units」斷言 fail（hiddenCollected=true）。
//   還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-hidden-container-skip';

test('detect-hidden-container-skip: display:none 非 block 容器不進候選、可見對照組照常收', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const stats = {};
      const units = window.__SK.collectParagraphs(document.body, stats);
      const hidden = document.querySelector('#hidden-container');
      const visible = document.querySelector('#visible-container');
      const touches = (u, el) => {
        if (u.kind === 'element') return u.el === el;
        // fragment unit:startNode 在該容器內也算（Case B 超長 split 或 Case A/C 形狀變異）
        return !!(u.startNode && el.contains(u.startNode));
      };
      return {
        unitCount: units.length,
        hiddenCollected: units.some(u => touches(u, hidden)),
        visibleCollected: units.some(u => touches(u, visible)),
        containerWithBr: stats.containerWithBr || 0,
        stats,
      };
    })()
  `);

  // 斷言 1（核心）:display:none 容器（含其內部節點）不應進 units
  expect(
    result.hiddenCollected,
    `display:none 容器不應被 Case A-F 收進 units\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(false);

  // 斷言 2（對照組，防假綠）：可見同結構容器應照常收 → 證明 Case B 路徑有跑到
  expect(
    result.visibleCollected,
    `可見對照組應被收為 unit(containerWithBr=${result.containerWithBr})`,
  ).toBe(true);

  // 斷言 3:containerWithBr 計數應恰為 1（只有可見那顆；隱藏那顆被 gate 擋下）
  expect(
    result.containerWithBr,
    `containerWithBr 應為 1（僅可見容器），實際 ${result.containerWithBr}`,
  ).toBe(1);

  await page.close();
});
