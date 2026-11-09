// Regression: showToast(success) outside-click listener race
//
// 結構特徵:content-toast.js 內 success toast 路徑會 setTimeout(0) 排定綁
// document mousedown listener。若同一個 macrotask 內連續呼叫兩次 SK.showToast('success'),
// 兩個 setTimeout(0) 各自把新 handler 寫進 module 變數 toastOutsideHandler 並 addEventListener,
// 但中間沒做 remove,導致先寫的 handler 留在 document 上直到下次 hideToast——
// 然而 hideToast 只 remove 當前 toastOutsideHandler(後寫的那個),先寫的永久 leak。
//
// 影響:極小但真實的 listener leak。SPA rescan 連續完成多 trigger 時可能發生。
//
// 修法:setTimeout 內 addEventListener 之前先 removeOutsideClickHandler(),
//       確保 toastOutsideHandler 始終跟 document 上的 listener 1:1 對應。
//
// 驗證手法:在 isolated world 內 monkey-patch document.addEventListener /
//          removeEventListener,計 mousedown(capture) 的 net 增量。
//          連續 showToast(success) 兩次 → 等 setTimeout(0) 觸發完 → net 應為 1(而非 2)。
//          hideToast 後 net 應為 0。
//
// SANITY 紀錄(已驗證):把 content-toast.js setTimeout 內新加的 removeOutsideClickHandler() 拿掉
// → 本 spec 第二條 expect (net===1) 會 fail 為 net===2。還原修法 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('toast-outside-listener-no-leak: 連續 showToast(success) 不應 leak document mousedown listener', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 等 content-toast.js 載入後初次讀 storage 完成(toast-master-switch 也用 100ms)
  await page.waitForTimeout(100);

  // 確認 master switch 預設 true,否則 SK.showToast 會 short-circuit 整支不跑
  const sw = await evaluate(`window.__SK.shouldShowToast()`);
  expect(sw, 'master switch 預設應為 true').toBe(true);

  // 在 isolated world 安裝 spy:計 document 上 mousedown(capture) listener 的 net 數量
  // (content-toast.js 也跑 isolated world,所以攔得到)
  await evaluate(`(() => {
    const origAdd = document.addEventListener;
    const origRem = document.removeEventListener;
    window.__skMousedownNet = 0;
    document.addEventListener = function(t, h, opts) {
      if (t === 'mousedown' && (opts === true || (opts && opts.capture === true))) {
        window.__skMousedownNet++;
      }
      return origAdd.call(this, t, h, opts);
    };
    document.removeEventListener = function(t, h, opts) {
      if (t === 'mousedown' && (opts === true || (opts && opts.capture === true))) {
        window.__skMousedownNet--;
      }
      return origRem.call(this, t, h, opts);
    };
  })()`);

  // 連續 showToast(success) 兩次,同 macrotask
  await evaluate(`
    window.__SK.showToast('success', '已翻譯第一段');
    window.__SK.showToast('success', '已翻譯第二段');
  `);

  // 等 setTimeout(0) 兩個都觸發完(50ms 充裕)
  await page.waitForTimeout(50);

  const net = await evaluate(`window.__skMousedownNet`);
  expect(net, '連續 showToast(success) 後 mousedown listener net 應為 1(不是 2,後寫的應先 remove 前一個)').toBe(1);

  // hideToast 後應降到 0
  await evaluate(`window.__SK.hideToast()`);
  const netAfterHide = await evaluate(`window.__skMousedownNet`);
  expect(netAfterHide, 'hideToast 後 listener net 應為 0').toBe(0);

  await page.close();
});
