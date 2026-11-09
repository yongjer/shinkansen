// Regression: block-br-wrapper-split(對應 v1.10.56 修的「paulgraham.com/boss.html 最後一段
// 始終無法翻完」bug)
//
// Fixture: test/regression/fixtures/block-br-wrapper-split.html
// 結構(不綁站點,§8):#big 是 block <p>,唯一子是 <font> inline wrapper,整篇長文塞在
//   <font> 內、段落間用 <br><br> 分隔(<p> 自己沒有直接 BR);整篇 > BR_BLOCK_SPLIT_CHARS(3500)。
//   其中一段引言用單一 <br> 接出處(不可被切開)。#small 是同型但 < 門檻的對照組。
// Bug:<p> 是 BLOCK_TAGS_SET 成員 → 走主 walker 被當單一 {kind:'element'} 單元(實測真實站點
//   1.4 萬字)。Case B(splitBrBlock)只跑非-block CONTAINER_TAGS(DIV…),block <p> 永遠不切。
//   單一超長 segment 送 thinking 模型(gemini-3-flash-preview)→ streaming idle watchdog 誤判
//   stall + 非串流 retry fetch timeout(15s)整段 FAIL,使用者看到「最後一段翻不完」。
// 修法:主 walker accept 點,對超長 block 段落用 findBrSplitTarget 沿「唯一 inline wrapper」
//   鏈下探到帶 <br> 的容器(此例 <font>),再 splitBrBlock 切多 fragment;切不出 ≥2 段才退回整塊。
//
// SANITY 紀錄(已驗證):把主 walker 迴圈裡新增的「if (textContent > BR_BLOCK_SPLIT_CHARS) {
//   findBrSplitTarget → splitBrBlock → push fragments }」整段拿掉(永遠走 push element)
//   → 斷言 1(bigFragmentCount >= 12)fail(實得 0)、斷言 2(bigElementCount === 0)fail(實得 1)
//   → 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'block-br-wrapper-split';

test('block-br-wrapper-split: 超長 block <p>(內含 <font> br 分段)切成多 fragment,小區塊維持單一 element', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#big', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const stats = {};
      const units = window.__SK.collectParagraphs(document.body, stats);
      const big = document.querySelector('#big');
      const small = document.querySelector('#small');
      const fragText = (u) => {
        let t = '', n = u.startNode;
        while (n) { t += n.textContent || ''; if (n === u.endNode) break; n = n.nextSibling; }
        return t.trim();
      };
      const bigFragments = units.filter(u => u.kind === 'fragment' && u.el && big.contains(u.el));
      const bigElements  = units.filter(u => u.kind === 'element'  && u.el === big);
      const smallElements = units.filter(u => u.kind === 'element' && u.el === small);
      const smallFragments = units.filter(u => u.kind === 'fragment' && u.el && small.contains(u.el));
      const bigTexts = bigFragments.map(fragText);
      // 引言 + 出處用單一 <br> → 必須在同一個 fragment(不被切開)
      const quoteFrag = bigTexts.find(t => t.includes('A painting is a record of looking'));
      const quoteSeparate = bigTexts.find(
        t => t.includes('the same teacher reminded') && !t.includes('A painting is a record of looking')
      );
      return {
        unitCount: units.length,
        bigFragmentCount: bigFragments.length,
        bigElementCount: bigElements.length,
        smallElementCount: smallElements.length,
        smallFragmentCount: smallFragments.length,
        blockBrSplit: stats.blockBrSplit || 0,
        // 下探證據:big fragment 應錨在內層 <font>,不是 <p>
        fragAnchorTags: [...new Set(bigFragments.map(u => u.el.tagName))],
        maxBigFragChars: bigTexts.reduce((m, t) => Math.max(m, t.length), 0),
        // 最後一段(先前翻不完的那段)有被收進來
        hasFinalThanks: bigTexts.some(t => t.includes('Thanks to the readers')),
        quoteFragHasAttribution: !!(quoteFrag && quoteFrag.includes('the same teacher reminded')),
        quoteSplitIntoTwo: !!quoteSeparate,
      };
    })()
  `);

  // 斷言 1:#big 切成多個 fragment(15 個 <br><br> 分隔 → ~16 段;保守抓 >= 12)
  expect(
    result.bigFragmentCount,
    `#big 應切成 >= 12 個 fragment,實得 ${result.bigFragmentCount}(stats.blockBrSplit=${result.blockBrSplit}）`,
  ).toBeGreaterThanOrEqual(12);

  // 斷言 2:#big 不再有「整塊單一 element」單元
  expect(result.bigElementCount, '#big 不應再有 element 單元(整塊未切)').toBe(0);

  // 斷言 3:stats 計數對齊——走的是 blockBrSplit 路徑
  expect(result.blockBrSplit, 'stats.blockBrSplit 應 = bigFragmentCount').toBe(result.bigFragmentCount);

  // 斷言 4:fragment 錨在內層 <font>(證明 findBrSplitTarget 有下探穿越 inline wrapper)
  expect(result.fragAnchorTags, 'big fragment 應錨在 <font>，不是 <p>').toEqual(['FONT']);

  // 斷言 5:最大單一 fragment 遠小於整篇(整篇 ~3.7K 字,切後每段應 < 1200)
  expect(result.maxBigFragChars, '切後最大 fragment 應 < 1200 字').toBeLessThan(1200);

  // 斷言 6:先前翻不完的最後一段有被收進候選
  expect(result.hasFinalThanks, '最後一段(Thanks…)應被收進候選').toBe(true);

  // 斷言 7:單一 <br> 的引言 + 出處留在同一 fragment,沒被切成兩段
  expect(result.quoteFragHasAttribution, '引言 fragment 應含出處(單一 <br> 不切開)').toBe(true);
  expect(result.quoteSplitIntoTwo, '出處不應自成一個 fragment').toBe(false);

  // 斷言 8:對照組——小於門檻的 #small 維持「整塊單一 element」,沒被切分
  expect(result.smallElementCount, '#small 應維持單一 element 單元').toBe(1);
  expect(result.smallFragmentCount, '#small 不應被切成 fragment').toBe(0);

  await page.close();
});
