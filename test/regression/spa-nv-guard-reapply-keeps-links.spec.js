// Regression: spa-nv-guard-reapply-keeps-links（2026-07-16 修的「framework 重繪後
// guard 補課重套,段落內 <a> 連結全部變空殼消失」bug — 真實案例:The Verge 文章
// 翻完連結正常,幾秒後站方重繪打回原文,guard 重套後連結底線消失、連結文字混進純文字）
//
// Fixture: test/regression/fixtures/nv-guard-reapply-keeps-links.html
// 結構:prose 段落內嵌 3 個 inline <a>（文字-連結-文字交錯）,framework-managed
//   → 首翻走 Layer A3 nodeValue mutate（slots 同構配對,<a> 結構保留）。
// Bug:recordNvMutateTranslation 只存純文字譯文 → guard 重套走
//   tryInjectNodeValueMutate(el, plain, []) 的 slots=[] Case 3b flatten:整段譯文
//   塞第一個 text node、其餘 text node（含 <a> 內）清空 → 連結空殼化。
// 修法:record 連帶存帶佔位符原始譯文 + slots;重套統一入口 nvReapplySaved 先重走
//   A3 同構配對（framework 打回原文後結構與首翻相同,配對成功 → inline 結構保留）,
//   配對不成才 fallback 純文字 flatten（原行為,內容不遺失）。
//
// SANITY 紀錄（已驗證 2026-07-16,兩輪）：
//   ① 把 content-spa.js nvReapplySaved 的 A3 分支暫時改為
//     `if (false && rec.raw && rec.slots …)`（強制走純文字 fallback）→ case 1 的
//     「重套後 <a> 不得空殼」斷言 fail（anchorTexts ["","",""]）;還原後 pass。
//   ② 把 runContentGuardNvMutate 的健康譯文守門(nvBackupIntact ||
//     nvTextEqualsPlain 合併閘門)暫時改為 `if (false && (…)) continue;`
//     → case 2 的「健康譯文 sweep 應為 no-op」斷言 fail（guardResult=8,誤判後
//     連續介入到停損上限）;還原後 pass。
//   fallback case（不同構重繪）不受兩輪破壞影響,各態皆 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'nv-guard-reapply-keeps-links';
// A3 對齊譯文:source seq = [text, A, text, A, text, A, text] 同構 7 項
const TRANSLATION =
  '本週我讀了關於⟦0⟧第一則連結報導⟦/0⟧的文章，寫作時聽著⟦1⟧一長串混音清單⟦/1⟧，同時完成了⟦2⟧我的大專案文章⟦/2⟧。';

function snapshotPara() {
  const el = document.querySelector('#para');
  const anchors = Array.from(el.querySelectorAll('a'));
  return {
    text: el.textContent,
    hasCJK: /[一-鿿]/.test(el.textContent),
    hasPlaceholder: el.textContent.includes('⟦'),
    anchorCount: anchors.length,
    emptyAnchors: anchors.filter((a) => !(a.textContent || '').trim()).length,
    anchorTexts: anchors.map((a) => (a.textContent || '').trim()),
    nvMarked: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
  };
}

test('framework 打回原文 → guard 重套後 inline <a> 結構與連結文字保留', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 記下原文 innerHTML,供模擬 framework 重繪打回原文
  const origHTML = await page.evaluate(() => document.querySelector('#para').innerHTML);

  // 首翻:走 framework branch → Layer A3 nodeValue mutate（slots 同構配對）
  await runTestInject(evaluate, '#para', TRANSLATION);
  const fresh = await page.evaluate(snapshotPara);
  expect(fresh.hasCJK, '注入後應含中文(前置條件)').toBe(true);
  expect(fresh.hasPlaceholder, '注入後不得殘留佔位符').toBe(false);
  expect(fresh.nvMarked, '應走 nodeValue mutate 注入(前置條件)').toBe(true);
  expect(fresh.anchorCount, '首翻後 3 個 <a> 應都在').toBe(3);
  expect(fresh.emptyAnchors,
    `首翻後 <a> 不得空殼,實際 anchorTexts: ${JSON.stringify(fresh.anchorTexts)}`).toBe(0);

  // framework 重繪:整段打回英文原文（全部 text node 換新 → backup 全 detach,
  // curText === origText → guard 路徑 1「重套譯文」）
  await page.evaluate((html) => {
    document.querySelector('#para').innerHTML = html;
  }, origHTML);

  const guardResult = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  expect(guardResult, 'guard 應介入重套 1 個元素').toBeGreaterThanOrEqual(1);

  const after = await page.evaluate(snapshotPara);
  expect(after.hasCJK, '重套後應為中文').toBe(true);
  expect(after.hasPlaceholder, '重套後不得殘留佔位符').toBe(false);
  expect(after.anchorCount, '重套後 3 個 <a> 應都在').toBe(3);
  expect(after.emptyAnchors,
    `重套後 <a> 不得空殼(連結消失),實際 anchorTexts: ${JSON.stringify(after.anchorTexts)}`).toBe(0);
  // 連結文字應為譯文（A3 配對把譯文寫進 <a> 內 text node）
  expect(after.anchorTexts.every((t) => /[一-鿿]/.test(t)),
    `<a> 內應為中文譯文,實際: ${JSON.stringify(after.anchorTexts)}`).toBe(true);

  await page.close();
});

test('健康譯文含逐字保留的原文專有名詞 → sweep 不得誤判 reverted 重套', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 譯文逐字保留 anchor 1 的英文原文（專有名詞場景:人名 / 品牌名照抄進譯文）——
  // nvMutateRevertedToOriginal 的「curText 含 backup originalValue 片段」判準會對
  // 這種健康譯文誤報 reverted;誤報後對譯文態 DOM 重跑 A3 配對可能失敗 → flatten
  //（The Verge 真實案例:譯文保留 David Attenborough / Maxinomics 等)
  const KEEP_NOUN_TRANSLATION =
    '本週我讀了關於⟦0⟧第一則連結報導⟦/0⟧的文章，寫作時聽著⟦1⟧a long mix playlist⟦/1⟧，同時完成了⟦2⟧我的大專案文章⟦/2⟧。';
  await runTestInject(evaluate, '#para', KEEP_NOUN_TRANSLATION);
  const fresh = await page.evaluate(snapshotPara);
  expect(fresh.nvMarked, '應走 nodeValue mutate 注入(前置條件)').toBe(true);
  expect(fresh.emptyAnchors, '首翻後 <a> 不得空殼(前置條件)').toBe(0);

  // 不做任何 revert——DOM 就是健康譯文。sweep 不得介入。
  const guardResult = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  expect(guardResult, '健康譯文 sweep 應為 no-op(0 介入)').toBe(0);

  const after = await page.evaluate(snapshotPara);
  expect(after.emptyAnchors,
    `健康譯文不得被重套成空殼,實際 anchorTexts: ${JSON.stringify(after.anchorTexts)}`).toBe(0);
  expect(after.text, '健康譯文內容不得被 sweep 改動').toBe(fresh.text);

  await page.close();
});

test('framework 重繪成不同構結構 → 重套 fallback 純文字,譯文內容不遺失', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  const origText = await page.evaluate(() => document.querySelector('#para').textContent);

  await runTestInject(evaluate, '#para', TRANSLATION);

  // framework 重繪成「同原文但不同構」:純文字、無 <a>（A3 配對必失敗 → 走 fallback）
  await page.evaluate((txt) => {
    document.querySelector('#para').textContent = txt;
  }, origText);

  const guardResult = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  expect(guardResult, 'guard 應介入重套 1 個元素').toBeGreaterThanOrEqual(1);

  const after = await page.evaluate(() => {
    const el = document.querySelector('#para');
    return {
      hasCJK: /[一-鿿]/.test(el.textContent),
      hasPlaceholder: el.textContent.includes('⟦'),
      hasLinkText: el.textContent.includes('第一則連結報導'),
    };
  });
  expect(after.hasCJK, 'fallback 重套後應為中文').toBe(true);
  expect(after.hasPlaceholder, 'fallback 重套不得殘留佔位符').toBe(false);
  expect(after.hasLinkText, '連結文字應以純文字保留(內容不遺失)').toBe(true);

  await page.close();
});
