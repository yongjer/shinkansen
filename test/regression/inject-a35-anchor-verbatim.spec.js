// Regression: inject-a35-anchor-verbatim(v1.10.49,對應「劃線段落譯文掉到
// 英文下方」bug — mark 內嵌 <a> 的段落 LLM 丟佔位符時 A3.5 被 <a> gate 擋下)
//
// Fixture: test/regression/fixtures/inject-a35-anchor-verbatim.html
// 結構:highlight inline(mark)內嵌 <a> 的段落 / 以 <a> 開頭的段落。
// Bug:LLM 丟佔位符 → deserialize ok=false → A3 無法對齊;A3.5 原 gate 對含
// <a> slot 一律讓路 → framework 分支掉 dual visible。但連結文字(專有名詞)
// 幾乎都逐字保留在譯文內,flatten 唯一損失是可點擊性。
// 修法(content-inject.js A3.5 anchor gate):第一個可見 text node 不在 <a> 內
// → 放行 flatten;否則(段落以 <a> 開頭,整段譯文會塞進連結)維持 dual。
//   v1.10.49 原本「額外」要求連結文字逐字在譯文中才放行,v1.10.52 移除此要求
//   (prose 內文連結文字會被翻成中文 → 強制逐字不合理,真實案例 theatlantic.com,
//   見 inject-dropcap-wordsplit.spec.js 第 3 條)。第 1 條 #target-verbatim 連結文字
//   逐字保留只是其中一種會放行的情形,改動後仍 single(本 spec 不受 v1.10.52 影響)。
//
// 守門對照組:第 2 條 #target-linkstart(以 <a> 開頭)→ 維持 dual。
//
// SANITY 紀錄(已驗證):暫時把 a35AnchorsOk 強制 = false(恢復「一律擋」行為)
// → 第 1 條 spec fail(nvMutated=false + wrapper 出現)→ 還原 → 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-a35-anchor-verbatim';
// 丟佔位符的純文字譯文,連結文字 "Crystal Echo" 逐字保留
const TRANSLATION_VERBATIM = '《Crystal Echo》的新專輯將在今年秋天問世。';
// 丟佔位符的純文字譯文,連結文字 "Delta Note" 逐字保留,但段落以 <a> 開頭
const TRANSLATION_LINKSTART = '《Delta Note》稍早發行了全新單曲。';

test('A3.5 放行: mark 內嵌 <a> + 連結文字逐字在譯文內 → flatten 原地替換(不掉 dual)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-verbatim', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await page.evaluate(() => {
    window.__probeMark = document.querySelector('#target-verbatim mark');
    window.__probeAnchor = document.querySelector('#target-verbatim a');
  });

  await runTestInject(evaluate, '#target-verbatim', TRANSLATION_VERBATIM);

  const r = await page.evaluate(() => {
    const el = document.querySelector('#target-verbatim');
    return {
      text: el.textContent,
      isChinese: /[一-鿿]/.test(el.textContent || ''),
      hasEnglishProse: /\b(album|arrives|season)\b/.test(el.textContent || ''),
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      dualSource: el.hasAttribute('data-shinkansen-dual-source'),
      wrapperPresent: !!document.querySelector('shinkansen-translation'),
      markSameRef: document.querySelector('#target-verbatim mark') === window.__probeMark,
      anchorSameRef: document.querySelector('#target-verbatim a') === window.__probeAnchor,
    };
  });

  expect(r.nvMutated, '應走 A3.5 flatten(nodeValue mutate)').toBe(true);
  expect(r.dualSource, '不應標 dual-source').toBe(false);
  expect(r.wrapperPresent, '不應出現 dual wrapper').toBe(false);
  expect(r.isChinese, '段落應為中文譯文').toBe(true);
  expect(r.hasEnglishProse, '英文原文 prose 不應殘留').toBe(false);
  expect(r.text, '連結文字以譯文內逐字形式保留(資訊零遺失)').toContain('Crystal Echo');
  expect(r.markSameRef, 'mark 元素 ref 保留(fiber-safe)').toBe(true);
  expect(r.anchorSameRef, 'a 元素 ref 保留(fiber-safe)').toBe(true);

  await page.close();
});

test('A3.5 守門: 第一個可見 text node 在 <a> 內 → 不 flatten(避免整段譯文變連結),維持 dual', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-linkstart', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await runTestInject(evaluate, '#target-linkstart', TRANSLATION_LINKSTART);

  const r = await page.evaluate(() => {
    const el = document.querySelector('#target-linkstart');
    const a = el.querySelector('a');
    return {
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      dualSource: el.hasAttribute('data-shinkansen-dual-source'),
      wrapperPresent: !!document.querySelector('shinkansen-translation'),
      anchorText: a ? a.textContent : '',
    };
  });

  expect(r.nvMutated, '不應 flatten(整段譯文會塞進 <a>)').toBe(false);
  expect(r.dualSource, '應維持 dual fallback').toBe(true);
  expect(r.wrapperPresent, '應出現 dual wrapper').toBe(true);
  expect(r.anchorText, '<a> 連結文字不可被動').toBe('Delta Note');

  await page.close();
});
