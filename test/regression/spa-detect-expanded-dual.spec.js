// Regression: dual mode「顯示更多」展開後譯文不更新 (v1.10.10.1)
//
// Root cause:injectDual 未呼叫 snapshotOnce → STATE.originalText 沒設 →
// detectAndUnmarkExpandedDual 讀 STATE.originalText.get(el) 得 undefined →
// continue 跳過 → 展開永不被偵測 → wrapper 不更新。
//
// 修法:injectDual 建 wrapper 前加 SK.snapshotOnce(original)。
//
// SANITY 紀錄（已驗證）:暫時移除 injectDual 內的 SK.snapshotOnce(original) →
// 'STATE.originalText 應被設定' case fail（得到 false）；還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual inject 後 STATE.originalText 應被設定（snapshotOnce 修法驗證）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__shinkansen.testInjectDual(el, '你好世界。');
  })()`);

  const hasOriginalText = await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__SK.STATE.originalText.has(el);
  })()`);
  expect(hasOriginalText, 'STATE.originalText 應被設定').toBe(true);

  await page.close();
});

test('dual mode: 展開後 detectAndUnmarkExpandedDual 應 fire 並清除 wrapper', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 注入 dual 翻譯
  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__shinkansen.testInjectDual(el, '你好世界。');
  })()`);

  // 確認 wrapper 存在
  const beforeExpand = await page.evaluate(() => {
    const el = document.querySelector('#basic');
    const wrapper = el.nextElementSibling;
    return {
      hasWrapper: wrapper?.tagName?.toLowerCase() === 'shinkansen-translation',
      hasDualSourceAttr: el.hasAttribute('data-shinkansen-dual-source'),
    };
  });
  expect(beforeExpand.hasWrapper, '展開前應有 wrapper').toBe(true);
  expect(beforeExpand.hasDualSourceAttr, '展開前應有 dual-source attr').toBe(true);

  // 模擬 X「顯示更多」:framework 把 el.textContent 展開為更長版本
  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    const origText = window.__SK.STATE.originalText.get(el);
    el.textContent = origText + ' This is the expanded content that appears after clicking show more. '.repeat(3);
  })()`);

  // 呼叫 detectAndUnmarkExpandedDual
  const detectResult = await evaluate(`(() => {
    const el = document.querySelector('#basic');
    const mockMutations = [{ target: el, type: 'childList', addedNodes: [], removedNodes: [] }];
    const fired = window.__SK._detectAndUnmarkExpandedDual(mockMutations);
    return {
      fired,
      hasDualSourceAttr: el.hasAttribute('data-shinkansen-dual-source'),
      cacheSize: window.__SK.STATE.translationCache.size,
      hasOriginalText: window.__SK.STATE.originalText.has(el),
    };
  })()`);
  const r = typeof detectResult === 'string' ? JSON.parse(detectResult) : detectResult;
  expect(String(r.fired), 'detect 應 fire').toBe('true');
  expect(r.hasDualSourceAttr, 'dual-source attr 應移除').toBe(false);
  expect(r.cacheSize, 'translationCache 應清除該項').toBe(0);
  expect(r.hasOriginalText, 'originalText 應清除該項').toBe(false);

  // wrapper 應被 remove
  const afterExpand = await page.evaluate(() => {
    const el = document.querySelector('#basic');
    const next = el.nextElementSibling;
    return {
      hasWrapper: next?.tagName?.toLowerCase() === 'shinkansen-translation',
    };
  });
  expect(afterExpand.hasWrapper, 'wrapper 應被移除').toBe(false);

  await page.close();
});

test('dual mode 守門:textContent 沒顯著變長 → 不 unmark', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__shinkansen.testInjectDual(el, '你好世界。');
  })()`);

  // 文字變動但沒有顯著變長（< 1.5x = 18 chars,原文 12 chars）
  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    el.textContent = 'Hello world. OK';
  })()`);

  const detectResult = await evaluate(`(() => {
    const el = document.querySelector('#basic');
    const mockMutations = [{ target: el, type: 'childList', addedNodes: [], removedNodes: [] }];
    const fired = window.__SK._detectAndUnmarkExpandedDual(mockMutations);
    return {
      fired,
      hasDualSourceAttr: el.hasAttribute('data-shinkansen-dual-source'),
    };
  })()`);
  const r = typeof detectResult === 'string' ? JSON.parse(detectResult) : detectResult;
  expect(String(r.fired), '不應 fire').toBe('false');
  expect(r.hasDualSourceAttr, 'dual-source attr 應保留').toBe(true);

  await page.close();
});
