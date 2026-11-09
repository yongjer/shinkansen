// Regression: detect-nested-double-collect(對應 SPEC-PRIVATE §29.1-1「偵測層巢狀雙收」，
// dev tail 2.0.9.1 修)
//
// Fixture: test/regression/fixtures/detect-nested-double-collect.html
// 結構(三變體 + 兩對照組):
//   v1: P(walker FILTER_ACCEPT 整顆收)> SPAN(直接文字 >= 20 + 非 BR element 子，Case D 形狀)
//   v2: P(walker 整顆收)> SPAN(直接文字 + BR,Case E 形狀)
//   v3: DIV(Case B 非 split 整顆收)> B(直接文字 >= 20,INLINE_PROSE 形狀)
//   c1: 獨立 SPAN(Case D 形狀，祖先沒被收)— 守門不可誤傷
//   c2: 獨立 B(INLINE_PROSE 形狀，祖先沒被收)— 守門不可誤傷
// Bug:walker FILTER_ACCEPT push 與 Case B 非 split push 只標 seen、不標 fragmentExtracted。
//   TreeWalker 的 ACCEPT/SKIP 都不阻擋子節點走訪 → 子代 SPAN 被 Case D/E、子代 <b> 被
//   INLINE_PROSE 補抓時，hasAncestorExtracted 查不到「祖先已整顆收成 unit」→ 同段文字
//   收兩次(兩次序列化字串不同繞過下游 text-hash dedup)→ 同段送 API 兩次、dual mode
//   譯文出現兩份。
// 修法(結構性通則):element unit push 時(walker push / Case B 非 split push / br-split
//   的 brTarget)一併 fragmentExtracted.add —— Case D/E/INLINE_PROSE 既有的
//   hasAncestorExtracted 守門即擋住後代重複收。
//
// 本 spec 鎖的訊號層：驗「偵測端同一子樹只收一個 unit + 對照組照常收」。不驗下游
//   序列化 / dedup / 注入層(偵測端收一次後根本不會產生第二條 path)。
//
// SANITY 紀錄(已驗證，2026-07-09，三輪):
//   ⓪ 修法前先跑(probe):v1/v2/v3 全部雙收 fail(v1=P+span fragment、v2=P+span element、
//      v3=DIV+b element,stats 顯示 inlineMixedSpan=2 / spanWithBr=1 / inlineProseWrapper=2)。
//   ① 只註解掉 walker push 的 fragmentExtracted.add(node)→ v1 斷言 fail。
//   ② 只註解掉 Case B 非 split push 的 fragmentExtracted.add(el)→ v3 斷言 fail。
//   各自還原後全 pass,git diff 確認無殘影。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-nested-double-collect';

test('detect-nested-double-collect: 已收 element unit 的後代不被 Case D/E/INLINE_PROSE 再收，對照組不誤傷', async ({
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
      // 「unit 落在 el 子樹內」：element unit 看 u.el,fragment unit 看 startNode
      const unitsIn = (el) => units.filter(u =>
        u.kind === 'element' ? el.contains(u.el) : !!(u.startNode && el.contains(u.startNode))
      );
      const describe = (list) => list.map(u =>
        u.kind === 'element'
          ? 'element:' + (u.el.id || u.el.tagName)
          : 'fragment@' + (u.startNode.parentElement?.id || u.startNode.parentElement?.tagName)
      );
      const v1 = unitsIn(document.getElementById('v1-p'));
      const v2 = unitsIn(document.getElementById('v2-p'));
      const v3 = unitsIn(document.getElementById('v3-div'));
      const c1 = unitsIn(document.getElementById('c1-span'));
      return {
        v1: describe(v1), v2: describe(v2), v3: describe(v3),
        v1IsWholeP: v1.length === 1 && v1[0].kind === 'element' && v1[0].el.id === 'v1-p',
        v2IsWholeP: v2.length === 1 && v2[0].kind === 'element' && v2[0].el.id === 'v2-p',
        v3IsWholeDiv: v3.length === 1 && v3[0].kind === 'element' && v3[0].el.id === 'v3-div',
        c1Collected: c1.length >= 1,
        c2Collected: units.some(u => u.kind === 'element' && u.el.id === 'c2-b'),
        stats,
      };
    })()
  `);

  const ctx = `v1=${JSON.stringify(result.v1)} v2=${JSON.stringify(result.v2)} v3=${JSON.stringify(result.v3)}\nstats: ${JSON.stringify(result.stats)}`;

  // 斷言 1-3(核心)：三個變體的子樹各恰好一個 unit，且是整顆容器本身
  expect(result.v1IsWholeP, `v1: walker 收的 P 子樹只能有 P 這一個 unit(SPAN 不得被 Case D 再抽)\n${ctx}`).toBe(true);
  expect(result.v2IsWholeP, `v2: walker 收的 P 子樹只能有 P 這一個 unit(SPAN 不得被 Case E 再收)\n${ctx}`).toBe(true);
  expect(result.v3IsWholeDiv, `v3: Case B 收的 DIV 子樹只能有 DIV 這一個 unit(<b> 不得被 INLINE_PROSE 再收)\n${ctx}`).toBe(true);

  // 斷言 4-5(對照組)：祖先沒被收成 unit 的同形狀元素，補抓照常運作
  expect(result.c1Collected, `c1: 獨立 Case D 形狀 SPAN 必須照常被抽\n${ctx}`).toBe(true);
  expect(result.c2Collected, `c2: 獨立 INLINE_PROSE 形狀 <b> 必須照常被收\n${ctx}`).toBe(true);

  await page.close();
});
