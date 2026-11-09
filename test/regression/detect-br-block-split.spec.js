// Regression: br-block-split(對應 v1.10.53 修的「整篇文章塞在一個 <div> 用 <br><br>
// 分段時,整塊變成單一超長 segment,Gemini flash/flash-lite 串流『最後一段無法結束』」bug)
//
// Fixture: test/regression/fixtures/br-block-split.html
// 結構(不綁站點,§8):#big 是 CONTAINER(div)直接含長文,段落間用 <br><br> 分隔,
//   無任何 block 子孫;整篇 > BR_BLOCK_SPLIT_CHARS(3500)。P1 內含單一 <br>(引言 + 出處)。
//   #small 是同型但 < 門檻的小區塊(對照組)。
// Bug:Case B(v1.4.9)把整塊當單一 {kind:'element'} 單元 → 4 千字(真實站點 2 萬字)
//   單一 streaming segment,串流極慢甚至 stall。
// 修法:Case B 命中且 textContent > BR_BLOCK_SPLIT_CHARS 時,splitBrBlock 按 <br><br>
//   段落邊界切成多個 {kind:'fragment'} 單元(單一 <br> 留段內);切不出 ≥2 段才退回整塊。
//
// SANITY 紀錄(已驗證):把 Case B 分支裡「if ((el.textContent||'').trim().length >
//   SK.BR_BLOCK_SPLIT_CHARS) { ... splitFrags ... }」整段拿掉(永遠走 else 推單一 element)
//   → 斷言 1(bigFragments >= 8)fail(實得 0)、斷言 2(bigElements === 0)fail(實得 1)
//   → 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'br-block-split';

test('br-block-split: 超長 <br><br> 區塊切成多個 fragment,小區塊維持單一 element', async ({
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
      const fragText = (u) => {
        let t = '', n = u.startNode;
        while (n) { t += n.textContent || ''; if (n === u.endNode) break; n = n.nextSibling; }
        return t.trim();
      };
      const bigFragments = units.filter(u => u.kind === 'fragment' && u.el && u.el.id === 'big');
      const bigElements  = units.filter(u => u.kind === 'element'  && u.el && u.el.id === 'big');
      const smallElements = units.filter(u => u.kind === 'element' && u.el && u.el.id === 'small');
      const smallFragments = units.filter(u => u.kind === 'fragment' && u.el && u.el.id === 'small');
      const bigTexts = bigFragments.map(fragText);
      // P1:引言 + 出處用單一 <br> → 必須在同一個 fragment(不被切開)
      const quoteFrag = bigTexts.find(t => t.includes('A painting is a record of looking'));
      const quoteSeparate = bigTexts.find(
        t => t.includes('teacher whose name') && !t.includes('A painting is a record of looking')
      );
      return {
        bigFragmentCount: bigFragments.length,
        bigElementCount: bigElements.length,
        smallElementCount: smallElements.length,
        smallFragmentCount: smallFragments.length,
        containerWithBrSplit: stats.containerWithBrSplit || 0,
        containerWithBr: stats.containerWithBr || 0,
        quoteFragHasAttribution: !!(quoteFrag && quoteFrag.includes('teacher whose name')),
        quoteSplitIntoTwo: !!quoteSeparate,
      };
    })()
  `);

  // 斷言 1:#big 切成多個 fragment(8 段:7 個 <br><br> 分隔 → 8 段)
  expect(
    result.bigFragmentCount,
    `#big 應切成 >= 8 個 fragment,實得 ${result.bigFragmentCount}（stats.containerWithBrSplit=${result.containerWithBrSplit}）`,
  ).toBeGreaterThanOrEqual(8);

  // 斷言 2:#big 不再有「整塊單一 element」單元
  expect(result.bigElementCount, '#big 不應再有 element 單元(整塊未切)').toBe(0);

  // 斷言 3:stats 計數對齊——走的是 split 路徑,不是整塊路徑
  expect(result.containerWithBrSplit, 'stats.containerWithBrSplit 應 = bigFragmentCount').toBe(
    result.bigFragmentCount,
  );

  // 斷言 4:單一 <br> 的引言 + 出處留在同一 fragment,沒被切成兩段
  expect(result.quoteFragHasAttribution, '引言 fragment 應含出處(單一 <br> 不切開)').toBe(true);
  expect(result.quoteSplitIntoTwo, '出處不應自成一個 fragment').toBe(false);

  // 斷言 5:對照組——小於門檻的 #small 維持「整塊單一 element」,沒被切分
  expect(result.smallElementCount, '#small 應維持單一 element 單元').toBe(1);
  expect(result.smallFragmentCount, '#small 不應被切成 fragment').toBe(0);
  expect(result.containerWithBr, '#small 應計入 stats.containerWithBr').toBeGreaterThanOrEqual(1);

  await page.close();
});
