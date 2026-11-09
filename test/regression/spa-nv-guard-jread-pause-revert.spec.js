// Regression: spa-nv-guard-jread-pause-revert（2026-07-16 修的「NYT 圖說翻譯後變回
// 英文且永不修復」三洞 bug — 真實案例:NYT React 文章翻完後進 JRead 閱讀模式,
// React 對 figure 間歇 re-render 把圖說 text node 打回英文,guard 讓位期間全盲、
// 退出後也接不回,卡「標 translated、畫面英文」終態）
//
// Fixture: test/regression/fixtures/nv-guard-jread-pause-revert.html
// 結構:多 text node 的 framework-managed 圖說（說明 span + 來源 span）×2 + 一個
//   innerHTML 軌對照段落。
//
// 三洞各自獨立、各有一條 test,判定基礎互不共用:
//   洞 1（test ①,走 production runContentGuard + paused 旗標）:
//     讓位盲窗——v1.10.65 的 contentGuardExternallyPaused 讓 runContentGuard 整段
//     早退,連純 nodeValue 重套的 nv 軌一起停。修法:暫停期間只停 innerHTML / dual
//     軌（閃動來源）,nv 軌保留 sweep（reapplyOnly,不 unmark+rescan）。
//   洞 2（test ②,只靠 resume 事件本身,期間不跑任何 sweep）:
//     resume 無補課——setContentGuardPaused(false) 對盲窗期間的回退沒有一次性
//     reconcile。修法:unpause 當下跑全量 runContentGuardNvMutate(ignoreViewport)。
//   洞 3（test ③④,guard 正常、無暫停介入）:
//     sweep 閘門依賴 backup refs/值——backup originalValue 在多輪重建後 stale,
//     framework 用 reuse-node 把全段打回原文時 allDetached / reverted 都不成立 →
//     永久跳過。修法:加 nvRevertedToOrigText（el.textContent 直接對 STATE.originalText,
//     不經 backup）。附帶:lifetime 停損 8 次改滾動停損（60s 無介入歸零,test ④）。
//
// SANITY 紀錄（已驗證 2026-07-16,逐洞破壞、其餘兩洞完好時執行）:
//   洞 1:runContentGuard 的 paused 分支暫時改回 `if (contentGuardExternallyPaused)
//        return;`（v1.10.65 原形）→ test ① 「讓位期間 nv 軌應修復圖說」斷言 fail
//        （hasEnglishCaption=true）;還原後 pass。test ②③④ 不受影響（獨立判定）。
//   洞 2:setContentGuardPaused 內移除 resume reconcile 區塊 → test ② fail
//        （resume 後圖說仍英文）;還原後 pass。
//   洞 3:runContentGuardNvMutate 閘門暫時改回 `if (!allDetached && !reverted)
//        continue;`＋路徑 1 條件改回 `(reverted || curText === origText)` →
//        test ③ fail（guardResult=0、圖說卡英文）;還原後 pass。
//   洞 3 停損:nvGuardTryIntervene 暫時改回 lifetime 計數（無 decay）→ test ④
//        「+61s 後 sweep 應重新放行」斷言 fail;還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'nv-guard-jread-pause-revert';
const ORIG_CAP = 'A caption sentence that plainly describes the scene shown in the photo.';
const ORIG_CREDIT = 'Photographer Name/Agency';
// A3 對齊譯文:兩個 slot（兩段 span）各自對應
const TRANSLATION = '⟦0⟧清楚描述照片場景的一句圖說。⟦/0⟧⟦1⟧攝影師姓名/通訊社⟦/1⟧';
const TRANSLATION2 = '⟦0⟧描述另一張照片的圖說一句。⟦/0⟧⟦1⟧第二位攝影師/通訊社⟦/1⟧';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#cap', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);
  return { page, evaluate };
}

/** framework「換新 node」型 re-render:兩個 span 的 text node 都換成新物件、值為英文原文
 *  （element 與 data-shinkansen-* attr 原樣保留 — NYT React figcaption 實測形） */
async function revertWithNewNodes(page, selector, capText, creditText) {
  await page.evaluate(({ sel, cap, credit }) => {
    const spans = document.querySelectorAll(`${sel} span`);
    spans[0].replaceChildren(document.createTextNode(cap));
    spans[1].replaceChildren(document.createTextNode(credit));
  }, { sel: selector, cap: capText, credit: creditText });
}

test('洞 1:JRead 讓位期間 nv 軌 sweep 保留（回退 1s 內原地修復）,innerHTML 軌維持暫停', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#cap', TRANSLATION);
  const afterInject = await page.evaluate(() => document.querySelector('#cap').textContent);
  expect(/[一-鿿]/.test(afterInject), '注入後應含中文(前置條件)').toBe(true);

  // production runContentGuard 有 STATE.translated gate
  await evaluate(`window.__SK.STATE.translated = true`);

  // innerHTML 軌對照組:#para 掛進 STATE.translatedHTML,savedHTML 跟現況不同 →
  // 若 innerHTML 軌在讓位期間沒停,sweep 會把 sentinel 寫進畫面（= v1.10.65 閃動退步）
  await evaluate(`
    (() => {
      const p = document.querySelector('#para');
      window.__SK.STATE.translatedHTML.set(p, '<b>SENTINEL-SHOULD-NOT-APPEAR</b>');
      return true;
    })()
  `);

  // JRead 進閱讀模式（真實握手路徑:CustomEvent → content.js listener → setContentGuardPaused）
  await evaluate(`window.dispatchEvent(new CustomEvent('jread-reader-mode', { detail: { active: true } }))`);
  expect(await evaluate(`window.__SK._spaDebug().contentGuardExternallyPaused`)).toBe(true);

  // 盲窗內 framework 換新 node 把圖說打回英文
  await revertWithNewNodes(page, '#cap', ORIG_CAP, ORIG_CREDIT);

  // 跑 production guard sweep（respect paused 旗標的那條）
  await evaluate(`window.__SK._testRunContentGuardProd()`);

  const r = await page.evaluate(() => ({
    capText: document.querySelector('#cap').textContent,
    hasEnglishCaption: /caption sentence that plainly/i.test(document.querySelector('#cap').textContent),
    hasCJK: /[一-鿿]/.test(document.querySelector('#cap').textContent),
    paraHTML: document.querySelector('#para').innerHTML,
  }));
  expect(r.hasEnglishCaption,
    `讓位期間 nv 軌應修復圖說,實際: ${JSON.stringify(r.capText)}`).toBe(false);
  expect(r.hasCJK, '圖說應回到中文').toBe(true);
  expect(r.paraHTML.includes('SENTINEL-SHOULD-NOT-APPEAR'),
    '讓位期間 innerHTML 軌必須維持暫停(v1.10.65 防閃動不可退步)').toBe(false);

  await page.close();
});

test('洞 2:resume 補課——盲窗期間的回退在 unpause 當下修復;內容已變的 entry unmark 重翻', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#cap', TRANSLATION);
  await runTestInject(evaluate, '#cap2', TRANSLATION2);
  await evaluate(`window.__SK.STATE.translated = true`);

  await evaluate(`window.dispatchEvent(new CustomEvent('jread-reader-mode', { detail: { active: true } }))`);

  // 盲窗內:#cap 回退為原文;#cap2 被換成「全新且更長的不同內容」（非回退,不可重套舊譯文）
  await revertWithNewNodes(page, '#cap', ORIG_CAP, ORIG_CREDIT);
  await revertWithNewNodes(page, '#cap2',
    'Entirely new caption content that replaced the old one after a framework update, much longer than before to make the change obvious.',
    'A Completely Different Photographer Credit/Wire Agency');

  // 注意:期間刻意不跑任何 guard sweep——本 test 的判定基礎只有 resume 事件本身
  await evaluate(`window.dispatchEvent(new CustomEvent('jread-reader-mode', { detail: { active: false } }))`);

  const r = await page.evaluate(() => {
    const cap = document.querySelector('#cap');
    const cap2 = document.querySelector('#cap2');
    return {
      capText: cap.textContent,
      capEnglish: /caption sentence that plainly/i.test(cap.textContent),
      capCJK: /[一-鿿]/.test(cap.textContent),
      cap2Marked: cap2.hasAttribute('data-shinkansen-translated')
        || cap2.hasAttribute('data-shinkansen-nodevalue-mutated'),
      cap2Text: cap2.textContent,
    };
  });
  expect(r.capEnglish,
    `resume 當下應立即補課修復圖說,實際: ${JSON.stringify(r.capText)}`).toBe(false);
  expect(r.capCJK, '圖說應回到中文').toBe(true);
  // 內容已變:不可重套舊譯文蓋掉新內容,應 unmark 交還 rescan 重翻
  expect(r.cap2Marked, '內容已變的元素應被 unmark（等 rescan 重翻）,不可殘留翻譯標記').toBe(false);
  expect(/Entirely new caption content/.test(r.cap2Text),
    '內容已變的元素不可被舊譯文覆蓋(X 顯示更多 selective restore 同款不可退步)').toBe(true);

  await page.close();
});

test('洞 3:stale backup + reuse-node 全段回退 → 閘門不依賴 backup 值,sweep 仍重套', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#cap', TRANSLATION);

  // 製造終態前置:backup originalValue 變 stale（多輪 guard 重建後 originalValue 存的是
  // 重建當下的畫面值,可能已是譯文/混合態 — 這裡直接寫成 translatedValue 重現該態),
  // node refs 全部保持 connected（framework reuse-node 型）
  const staled = await evaluate(`
    (() => {
      const el = document.querySelector('#cap');
      const backup = window.__SK.STATE.nodeValueMutateBackup.get(el);
      if (!backup) return 0;
      for (const entry of backup) entry.originalValue = entry.translatedValue;
      return backup.length;
    })()
  `);
  expect(staled, '前置:backup 應存在且已 stale 化').toBeGreaterThanOrEqual(1);

  // framework reuse-node reset:同一批 text node 物件、nodeValue 直接改回英文原文
  // → allDetached=false（node 都還連著）、reverted=false（stale ov 比對不到英文）,
  //   curText === STATE.originalText → 只有不依賴 backup 的判準能接住
  await page.evaluate(({ cap, credit }) => {
    const spans = document.querySelectorAll('#cap span');
    spans[0].firstChild.nodeValue = cap;
    spans[1].firstChild.nodeValue = credit;
  }, { cap: ORIG_CAP, credit: ORIG_CREDIT });

  const guardResult = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  const r = await page.evaluate(() => ({
    text: document.querySelector('#cap').textContent,
    hasEnglishCaption: /caption sentence that plainly/i.test(document.querySelector('#cap').textContent),
    hasCJK: /[一-鿿]/.test(document.querySelector('#cap').textContent),
  }));
  expect(guardResult, 'guard 應介入修復 1 個元素').toBeGreaterThanOrEqual(1);
  expect(r.hasEnglishCaption,
    `stale backup 下圖說不得卡英文終態,實際: ${JSON.stringify(r.text)}`).toBe(false);
  expect(r.hasCJK, '圖說應為中文').toBe(true);

  await page.close();
});

test('洞 3 停損:上限 8 次為滾動視窗——高頻 ping-pong 停損不變,60s 無介入後重新放行（終態可自癒）', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#cap', TRANSLATION);

  // 高頻 ping-pong:framework 連續回退 8 次,每次 sweep 都介入修復（吃掉停損額度）
  for (let i = 0; i < 8; i++) {
    await revertWithNewNodes(page, '#cap', ORIG_CAP, ORIG_CREDIT);
    const fixed = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
    expect(fixed, `第 ${i + 1} 次介入應成功`).toBeGreaterThanOrEqual(1);
  }

  // 第 9 次:60s 視窗內 → 停損擋下（防站方持續對抗的 ping-pong,行為與舊版一致）
  await revertWithNewNodes(page, '#cap', ORIG_CAP, ORIG_CREDIT);
  const ninth = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  expect(ninth, '60s 視窗內第 9 次應被停損擋下').toBe(0);

  // 模擬 61s 後（isolated world 覆蓋 Date.now,guard 模組同 world 會吃到）:
  // 滾動停損歸零 → sweep 重新放行,終態自癒
  await evaluate(`
    (() => {
      const orig = Date.now;
      window.__origDateNow = orig;
      Date.now = () => orig() + 61000;
      return true;
    })()
  `);
  const afterDecay = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  await evaluate(`(() => { Date.now = window.__origDateNow; return true; })()`);

  const r = await page.evaluate(() => ({
    text: document.querySelector('#cap').textContent,
    hasEnglishCaption: /caption sentence that plainly/i.test(document.querySelector('#cap').textContent),
  }));
  expect(afterDecay, '60s 無介入後應重新放行').toBeGreaterThanOrEqual(1);
  expect(r.hasEnglishCaption,
    `停損解除後圖說應被修復,實際: ${JSON.stringify(r.text)}`).toBe(false);

  await page.close();
});
