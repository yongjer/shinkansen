// Regression: spa-nv-guard-reapply(v1.10.49,對應「劃線 hydration 把譯文還原成
// 英文後永遠卡住」bug — nv-mutate 元素先前完全沒有 Content Guard 保護)
//
// Fixture: test/regression/fixtures/spa-nv-guard-reapply.html
// 結構:單一 text node 段落,mutate 注入後 framework「同內容重 render」把
// text node 換成全新 node(英文原文),backup node 全 detach。
// Bug:A4 是 observer batch 反應式,revert 落在注入期間 / debounce 視窗外會
// 漏看;Path B 對 !isConnected entry 直接 skip → 元素卡「標 translated 但顯示
// 英文」。
// 修法:
//   1. runContentGuardNvMutate(1s sweep):backup 全 detach + 同內容 → 重套
//      記錄的譯文(免 API);內容已變 → unmark + rescan
//   2. A4 觸發時(nodes-replaced / attr-stripped 等)同樣先試重套
//
// SANITY 紀錄(已驗證 2026-06-12,分兩段破壞):
//   1. runContentGuardNvMutate 重套分支 `if (false && origText && ...)` →
//      第 1 條 fail(guardResult=0,text 仍英文),其餘 3 條 pass → 還原
//   2. A4 reapply 分支 `if (false && _allDetached && ...)` → 第 3 條 fail
//      (A4 走 unmark 而非重套,attrs 被移除),其餘 3 條 pass → 還原 → 4 條全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'spa-nv-guard-reapply';
const ORIG_TARGET = 'The committee approved the proposal after a long debate yesterday.';
const ORIG_CHANGED = 'Original short text about the meeting agenda for today.';
const ORIG_A4 = 'The garden festival attracted thousands of visitors over the weekend.';
const T_TARGET = '委員會在昨天漫長的辯論後批准了這項提案。';
const T_CHANGED = '關於今天會議議程的原始簡短文字。';
const T_A4 = '園藝節在週末吸引了數千名遊客。';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);
  return { page, evaluate };
}

// framework 同內容重 render:把元素唯一 text node 換成「全新 node + 指定內容」
function replaceTextNode(page, sel, newText) {
  return page.evaluate(({ s, t }) => {
    const el = document.querySelector(s);
    el.firstChild.replaceWith(document.createTextNode(t));
  }, { s: sel, t: newText });
}

test('guard 巡檢: backup node 全 detach + 同內容 → 重套譯文(免 API、attrs 保留)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#target', T_TARGET);
  const afterInject = await page.evaluate(() => document.querySelector('#target').textContent);
  expect(afterInject, '注入後應為中文(前置條件)').toBe(T_TARGET);

  // framework 同內容重 render:譯文被換回英文原文(全新 text node)
  await replaceTextNode(page, '#target', ORIG_TARGET);

  const guardResult = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  expect(guardResult, 'guard 應修復 1 個元素').toBe(1);

  const r = await page.evaluate(() => {
    const el = document.querySelector('#target');
    return {
      text: el.textContent,
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      translated: el.hasAttribute('data-shinkansen-translated'),
    };
  });
  expect(r.text, '譯文應被重套回來').toBe(T_TARGET);
  expect(r.nvMutated, 'nv-mutated attr 應在').toBe(true);
  expect(r.translated, 'translated attr 應在').toBe(true);

  // 重套後 backup 已綁新 node(connected)→ 再跑一次 guard 應為 no-op(冪等)
  const secondRun = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  expect(secondRun, '修復後再 sweep 應為 no-op').toBe(0);

  await page.close();
});

test('guard 巡檢: backup node 全 detach + 內容已變 → unmark 讓 rescan 重翻(不可重套舊譯文)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#target-changed', T_CHANGED);

  // framework 重 render 成「不同的新內容」(對應展開 / 換文場景)
  const NEW_CONTENT = 'Completely different expanded content that the framework rendered.';
  await replaceTextNode(page, '#target-changed', NEW_CONTENT);

  const guardResult = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  expect(guardResult, 'guard 應處理 1 個元素').toBe(1);

  const r = await page.evaluate(() => {
    const el = document.querySelector('#target-changed');
    return {
      text: el.textContent,
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      translated: el.hasAttribute('data-shinkansen-translated'),
    };
  });
  expect(r.text, '新內容必須保留(不可被舊譯文覆蓋)').toBe(NEW_CONTENT);
  expect(r.nvMutated, '應 unmark(nv-mutated 移除)讓 rescan 重翻').toBe(false);
  expect(r.translated, '應 unmark(translated 移除)').toBe(false);

  await page.close();
});

test('A4 nodes-replaced: backup 全 detach + 同內容 → A4 路徑也重套(不 unmark)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#target-a4', T_A4);
  await replaceTextNode(page, '#target-a4', ORIG_A4);

  const r = await evaluate(`
    (() => {
      const el = document.querySelector('#target-a4');
      const mockMutations = [{ target: el, type: 'childList' }];
      const fired = window.__SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations);
      return {
        fired,
        text: el.textContent,
        nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
        translated: el.hasAttribute('data-shinkansen-translated'),
      };
    })()
  `);

  expect(String(r.fired), '重套路徑不算 unmark(回 false)').toBe('false');
  expect(r.text, 'A4 應重套譯文').toBe(T_A4);
  expect(r.nvMutated, 'nv-mutated attr 應在').toBe(true);
  expect(r.translated, 'translated attr 應在').toBe(true);

  await page.close();
});

test('guard 巡檢守門: backup node 還連著(未被換新)→ 不介入', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#target', T_TARGET);
  // 不動 DOM — backup node 仍 connected 且持譯文
  const guardResult = await evaluate(`window.__SK._testRunContentGuardNvMutate()`);
  expect(guardResult, '無 revert 時 guard 應為 no-op').toBe(0);

  const text = await page.evaluate(() => document.querySelector('#target').textContent);
  expect(text, '譯文不動').toBe(T_TARGET);

  await page.close();
});
