// Regression: dual 模式譯文繼承站點反爬蟲翻轉 transform 造成上下顛倒
//（對應 v2.0.7 修的「Google 搜尋雙語模式譯文上下顛倒」bug）
//
// Fixture: test/regression/fixtures/dual-flip-antiscrape.html
// 結構：站點用「祖先 scaleY(-1) + 該元素自身 scaleY(-1)」雙重翻轉互相抵消反爬蟲。
//   原文字經兩層翻轉後正立；dual wrapper 以 sibling 身分插進「只有祖先那層翻轉」的
//   位置，少吃一次翻轉 → 譯文上下顛倒。
// Bug：injectDual 建的 wrapper 沒中和祖先鏈殘留的軸對齊翻轉。
// 修法：neutralizeInheritedFlip 累乘 wrapper 祖先 2D transform 對角線，淨值任一軸為負
//   （奇數次軸對齊翻轉）→ 補對應軸 scale(-1)；遇 rotate/skew/matrix3d 保守不動。
//
// SANITY 紀錄（已驗證）：把 injectDual 內 `neutralizeInheritedFlip(wrapper);` 那行註解掉，
//   → #flip-target 的 wrapper.style.transform 變空字串，第一條斷言（應為 scaleY(-1)）fail；
//   還原後全綠。even / noflip / rotate 三條對照斷言在破壞前後都是空字串（不受影響），
//   確保修法沒有對「本就正立 / 不該動」的情境亂補 transform。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-flip-antiscrape: 單層翻轉祖先 → wrapper 補 scaleY(-1)；偶數層／無翻轉／含旋轉 → 不動', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual-flip-antiscrape.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#flip-target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const cases = [
      ['#flip-target', '中文標題一'],
      ['#even-target', '中文標題二'],
      ['#noflip-target', '純標題'],
      ['#rotate-target', '旋轉容器標題'],
    ];
    for (const [sel, tr] of cases) {
      window.__shinkansen.testInjectDual(document.querySelector(sel), tr);
    }
    return true;
  })()`);

  const after = await page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      const wrapper = el.nextElementSibling;
      return {
        wrapperTag: wrapper ? wrapper.tagName : null,
        inlineTransform: wrapper ? wrapper.style.transform : null,
        computedTransform: wrapper ? window.getComputedStyle(wrapper).transform : null,
      };
    };
    return {
      flip: read('#flip-target'),
      even: read('#even-target'),
      noflip: read('#noflip-target'),
      rotate: read('#rotate-target'),
    };
  });

  // 每個 target 都應注入了 wrapper
  expect(after.flip.wrapperTag, 'flip-target 應注入 wrapper').toBe('SHINKANSEN-TRANSLATION');
  expect(after.even.wrapperTag, 'even-target 應注入 wrapper').toBe('SHINKANSEN-TRANSLATION');
  expect(after.noflip.wrapperTag, 'noflip-target 應注入 wrapper').toBe('SHINKANSEN-TRANSLATION');
  expect(after.rotate.wrapperTag, 'rotate-target 應注入 wrapper').toBe('SHINKANSEN-TRANSLATION');

  // 單層翻轉祖先：wrapper 補 scaleY(-1)，computed matrix 垂直分量為 -1（視覺正立）
  expect(after.flip.inlineTransform, 'flip-target wrapper 應補 scaleY(-1)').toBe('scaleY(-1)');
  expect(after.flip.computedTransform, 'flip-target wrapper computed 垂直翻轉').toBe('matrix(1, 0, 0, -1, 0, 0)');

  // 偶數層翻轉：淨值正立，不補償
  expect(after.even.inlineTransform, 'even-target wrapper 不應補 transform').toBe('');

  // 無翻轉祖先：不補償
  expect(after.noflip.inlineTransform, 'noflip-target wrapper 不應補 transform').toBe('');

  // 含旋轉（非軸對齊）：保守不動
  expect(after.rotate.inlineTransform, 'rotate-target wrapper 保守不補 transform').toBe('');

  await page.close();
});
