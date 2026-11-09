// Regression(integration): br-block-split 注入路徑(對應 v1.10.53)
//
// Fixture: test/regression/fixtures/br-block-split.html
// 驗「切分 → 序列化 → 注入」整條 path:超長 <br><br> 區塊切成多個 fragment 後,每段譯文
// 都注回『原 #big element』內(§15:single mode 必須注回原 element,不可 sibling overlay),
// 段落分隔 <br> 保留,原文英文被取代。
//
// 對應 CLAUDE.md §9「真實路徑驗證」——不是只驗中間 invariant(切出幾段),而是驗
// 切出來的 fragment 真的能注入回原容器、結構正確。
//
// SANITY 紀錄(已驗證):把 content-detect.js Case B 的 split 分支條件改成
// `if (false && ...)`(永不切分,退回整塊單一 element)→ bigFragmentCount=0、
// 斷言 1(>= 8)fail → 還原後 pass。(注入函式 injectFragmentTranslation 本身是 Case A
// 既有路徑,本 spec 驗的是「Case B 切分後沿用該路徑注回原 element」這條組合 path。)
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'br-block-split';

test('br-block-split 注入: 每段譯文注回原 #big element,無 sibling wrapper,分隔保留', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#big', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const units = window.__SK.collectParagraphs(document.body, {});
      const bigFrags = units.filter(u => u.kind === 'fragment' && u.el && u.el.id === 'big');
      // 逐段 fake 翻譯 + 注入(沿用 production 的 serialize → injectTranslation 路徑)
      bigFrags.forEach((u, i) => {
        const { slots } = window.__SK.serializeFragmentWithPlaceholders(u);
        window.__SK.injectTranslation(u, '「中文段' + i + '」', slots);
      });
      const big = document.querySelector('#big');
      const bigText = big.innerText;
      const allMarkers = bigFrags.every((_, i) => bigText.includes('「中文段' + i + '」'));
      return {
        bigFragmentCount: bigFrags.length,
        allMarkersInBig: allMarkers,
        hasSiblingWrapper: !!document.querySelector('shinkansen-translation'),
        bigStillInDoc: document.body.contains(big),
        bigTranslatedAttr: big.hasAttribute('data-shinkansen-translated'),
        brCount: big.querySelectorAll('br').length,
        englishLeftover: /A masterpiece of pictorial|weakness of much painting|quality of light/.test(bigText),
      };
    })()
  `);

  // 斷言 1:確實切成多段(前提)
  expect(result.bigFragmentCount, '#big 應切成 >= 8 段').toBeGreaterThanOrEqual(8);

  // 斷言 2:每段譯文都注回原 #big element 內
  expect(result.allMarkersInBig, '每段譯文都應出現在原 #big 內').toBe(true);

  // 斷言 3:§15 — 不得產生 sibling overlay wrapper(single mode 注回原 element)
  expect(result.hasSiblingWrapper, '不應出現 <shinkansen-translation> sibling wrapper').toBe(false);

  // 斷言 4:原 element 仍在 DOM 且標記已翻譯
  expect(result.bigStillInDoc, '#big 應仍在 DOM').toBe(true);
  expect(result.bigTranslatedAttr, '#big 應標記 data-shinkansen-translated').toBe(true);

  // 斷言 5:段落分隔 <br> 保留(7 個 <br><br> 分隔仍在)
  expect(result.brCount, '段落分隔 <br> 應保留').toBeGreaterThanOrEqual(7);

  // 斷言 6:原文英文被取代(沒有殘留未翻段落)
  expect(result.englishLeftover, '不應有未翻的英文段落殘留').toBe(false);

  await page.close();
});
