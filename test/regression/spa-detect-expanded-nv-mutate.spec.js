// Regression: spa-detect-expanded-nv-mutate (v1.9.27 Layer A4)
//
// SPA observer 對 STATE.nodeValueMutateBackup 內 element 做 detect-expand。
// 對應使用者點 X 顯示更多後 X 把 nodeValue 改成完整英文 → Shinkansen detect →
// unmark + clear backup + remove attribute → 觸發 SPA rescan 重翻。
//
// 對應 SPEC-PRIVATE §25.19。Layer 8 (dual map detect) 同套邏輯，只是對
// STATE.nodeValueMutateBackup map。
//
// 所有 STATE / SK.STATE access 必走 evaluate(isolated world）。page.evaluate
// 跑 main world 拿不到 SK。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('Layer A4: detect 對 nodeValueMutateBackup element + textContent 顯著變長 + startsWith origText → unmark', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // setup STATE 走 isolated evaluate（走 main world page.evaluate 拿不到 SK)
  // mutate text node 走 page.evaluate（只動 DOM，不碰 SK)
  await page.evaluate(() => {
    const textNode = document.querySelector('#target span').firstChild;
    window.__probeOrigValue = textNode.nodeValue;
  });

  await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      const origValue = window.__probeOrigValue || textNode.nodeValue;
      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, origValue.trim(), [{ node: textNode, originalValue: origValue }]);
      textNode.nodeValue = '中文短譯';
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      el.setAttribute('data-shinkansen-translated', '1');
    })()
  `);

  // 模擬 X click show more → nodeValue 變成展開後完整原文（startsWith origText + 顯著變長）
  await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      const origValue = window.__SK.STATE.nodeValueMutateBackup.get(el)[0].originalValue;
      textNode.nodeValue = origValue + ' Additional expanded content '.repeat(20);
    })()
  `);

  const detectResult = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      const mockMutations = [{ target: textNode, type: 'characterData' }];
      const fired = window.__SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations);
      return {
        fired,
        attr_nodeValueMutated_after: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
        attr_translated_after: el.hasAttribute('data-shinkansen-translated'),
        backup_size_after: window.__SK.STATE.nodeValueMutateBackup.size,
      };
    })()
  `);
  const r = typeof detectResult === 'string' ? JSON.parse(detectResult) : detectResult;
  expect(String(r.fired), 'detect 應 fire').toBe('true');
  expect(r.attr_nodeValueMutated_after, 'attribute 應移除').toBe(false);
  expect(r.attr_translated_after, 'translated attribute 應移除').toBe(false);
  expect(r.backup_size_after, 'backup 應 clear').toBe(0);

  await page.close();
});

test('Layer A4 守門：textContent 沒顯著變長 → 不 unmark', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, textNode.nodeValue.trim(), [{ node: textNode, originalValue: textNode.nodeValue }]);
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      // textContent 沒變
      const mockMutations = [{ target: textNode, type: 'characterData' }];
      const fired = window.__SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations);
      return { fired, still_attr: el.hasAttribute('data-shinkansen-nodevalue-mutated') };
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(String(r.fired), '沒變應守門擋住').toBe('false');
  expect(r.still_attr, 'attribute 應維持').toBe(true);
});

test('Layer A4 守門：textContent 變長但 NOT startsWith origText → 不 unmark', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, 'GPT Image 2 Prompt original english', [{ node: textNode, originalValue: textNode.nodeValue }]);
      textNode.nodeValue = '完全不同的中文內容'.repeat(20);
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      const mockMutations = [{ target: textNode, type: 'characterData' }];
      return window.__SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations);
    })()
  `);
  expect(String(result), 'NOT startsWith origText 應守門擋住').toBe('false');
});

// v1.9.30 Layer A4 Path B(partial reset)
test('Layer A4 partial-reset:framework 把任一 backup text node nodeValue 改寫 → unmark 重翻', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 模擬:tt 內有 2 個 backed-up text node,各 mutate 成中文 translatedValue。
  // 然後其中 1 個 text node 被 framework 改寫成新英文(對應 X show more 部分 reset)。
  // detect 應透過 partial-reset path 觸發 unmark。
  const result = await evaluate(`
    (() => {
      const el = document.createElement('div');
      el.setAttribute('data-testid', 'tweetText');
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      el.setAttribute('data-shinkansen-translated', '1');
      const span1 = document.createElement('span');
      const span2 = document.createElement('span');
      const text1 = document.createTextNode('正如我們今天在');
      const text2 = document.createTextNode('所展示的');
      span1.appendChild(text1);
      span2.appendChild(text2);
      el.appendChild(span1);
      el.appendChild(span2);
      document.body.appendChild(el);

      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, 'As we showed at today', [
        { node: text1, originalValue: 'As we showed at', translatedValue: '正如我們今天在' },
        { node: text2, originalValue: 'today', translatedValue: '所展示的' },
      ]);

      // 模擬 X show more 部分 reset:text2 被 framework 改寫成新英文
      text2.nodeValue = 'today, Ask YouTube is a great way to explore more complex search queries';

      const mockMutations = [{ target: text2, type: 'characterData' }];
      const fired = window.__SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations);
      return {
        fired,
        attr_nodeValueMutated_after: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
        attr_translated_after: el.hasAttribute('data-shinkansen-translated'),
        backup_has_el: window.__SK.STATE.nodeValueMutateBackup.has(el),
      };
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(String(r.fired), 'partial-reset path 應 fire').toBe('true');
  expect(r.attr_nodeValueMutated_after, 'attribute 應移除').toBe(false);
  expect(r.attr_translated_after, 'translated attribute 應移除').toBe(false);
  expect(r.backup_has_el, 'backup 該 el 應 clear').toBe(false);

  await page.close();
});

// v1.10.2 Path C(expanded-content):X 點「顯示更多」展開截斷推文。
// 真實場景:X 替換 article 級 wrapper → mutation target 在 backup 元素祖先,
// 方法 1(mutation walk-up)找不到。方法 2 全量掃描 backup 元素 textContent
// 顯著變長 → 觸發。舊 text node 保持翻譯後值(Path A/B 都不符),Path C
// 用長度比對觸發 + 還原舊 nodeValue 為原文。
test('Layer A4 Path C expanded-content:mutation 不在 backup 子樹、textContent 顯著變長 → unmark + 還原', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const article = document.createElement('article');
      const wrapper = document.createElement('div');
      const el = document.createElement('div');
      el.setAttribute('data-testid', 'tweetText');
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      el.setAttribute('data-shinkansen-translated', '1');
      const span1 = document.createElement('span');
      const text1 = document.createTextNode('Also in this weekly release:');
      span1.appendChild(text1);
      const img1 = document.createElement('img');
      const span2 = document.createElement('span');
      const text2 = document.createTextNode('New features and improvements');
      span2.appendChild(text2);
      el.appendChild(span1);
      el.appendChild(img1);
      el.appendChild(span2);
      wrapper.appendChild(el);
      article.appendChild(wrapper);
      document.body.appendChild(article);

      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, 'Also in this weekly release: New features and improvements', [
        { node: text1, originalValue: 'Also in this weekly release:', translatedValue: '另外在本週的發布中：' },
        { node: text2, originalValue: 'New features and improvements', translatedValue: '新功能和改進' },
      ]);
      text1.nodeValue = '另外在本週的發布中：';
      text2.nodeValue = '新功能和改進';

      // 模擬 X 展開:append 新 SPAN(英文內容),不動舊 node
      const span3 = document.createElement('span');
      span3.textContent = 'AI Chat: Added line wrapping for code and more details about the release notes';
      el.appendChild(span3);

      // 關鍵:mutation target 在 backup 元素外部(模擬 X 替換上層 wrapper)
      const outerDiv = document.createElement('div');
      document.body.appendChild(outerDiv);
      const mockMutations = [{ target: outerDiv, type: 'childList', addedNodes: [article], removedNodes: [] }];
      const fired = SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations);
      return {
        fired,
        attr_nvm: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
        attr_tr: el.hasAttribute('data-shinkansen-translated'),
        backup_has: SK.STATE.nodeValueMutateBackup.has(el),
        text1_restored: text1.nodeValue,
        text2_restored: text2.nodeValue,
      };
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(String(r.fired), 'Path C 應 fire').toBe('true');
  expect(r.attr_nvm, 'nodevalue-mutated 應移除').toBe(false);
  expect(r.attr_tr, 'translated 應移除').toBe(false);
  expect(r.backup_has, 'backup 該 el 應 clear').toBe(false);
  expect(r.text1_restored, 'text1 應還原為英文原文').toBe('Also in this weekly release:');
  expect(r.text2_restored, 'text2 應還原為英文原文').toBe('New features and improvements');

  await page.close();
});

test('Layer A4 Path C 守門:textContent 沒顯著變長(< 1.5x)不觸發', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.createElement('div');
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      el.setAttribute('data-shinkansen-translated', '1');
      const span1 = document.createElement('span');
      const text1 = document.createTextNode('中文譯文內容比較長的段落需要超過原文');
      span1.appendChild(text1);
      el.appendChild(span1);
      document.body.appendChild(el);

      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, 'A moderately long original English text that should be at least sixty characters total', [
        { node: text1, originalValue: 'Original', translatedValue: '中文譯文內容比較長的段落需要超過原文' },
      ]);

      const outerDiv = document.createElement('div');
      document.body.appendChild(outerDiv);
      const mockMutations = [{ target: outerDiv, type: 'childList', addedNodes: [], removedNodes: [] }];
      return {
        fired: SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations),
        attr_still: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      };
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(String(r.fired), 'textContent 沒顯著變長不該觸發').toBe('false');
  expect(r.attr_still, 'attribute 應維持').toBe(true);
});

test('Layer A4 partial-reset 守門:所有 backup node nodeValue 仍 === translatedValue → 不 unmark', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.createElement('div');
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      const span1 = document.createElement('span');
      const text1 = document.createTextNode('中文譯文');
      span1.appendChild(text1);
      el.appendChild(span1);
      document.body.appendChild(el);

      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, 'original english text', [
        { node: text1, originalValue: 'original english', translatedValue: '中文譯文' },
      ]);
      // 不動 text1.nodeValue,保持 === translatedValue

      const mockMutations = [{ target: text1, type: 'characterData' }];
      return {
        fired: window.__SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations),
        attr_still: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      };
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(String(r.fired), '所有 node 仍 === translatedValue,不該 unmark').toBe('false');
  expect(r.attr_still, 'attribute 應維持').toBe(true);
});

// v1.10.2 Path D(attr-stripped):X 推文點「顯示更多」,React re-render 保留
// 同一個 element ref 但 strip custom attributes + 改 text node 為完整原文 +
// append 新 child nodes。Path D 偵測 attribute 消失即觸發 unmark。
// 關鍵:React 已把 text node 改成完整英文(不再 === translatedValue),
// Path D 不可 restore(否則截斷版覆蓋完整版,中間段落消失)。
test('Layer A4 Path D attr-stripped:framework 改 text + strip attr → unmark,不覆蓋 React 設的完整原文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.createElement('div');
      el.setAttribute('data-testid', 'tweetText');
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      el.setAttribute('data-shinkansen-translated', '1');
      const span1 = document.createElement('span');
      const truncatedOrig = '"Can 1Password see what\\'s in my vault?" No. That\\'s how we built 1Password. Your data is encrypted on your device.';
      const fullExpanded = truncatedOrig + ' Zero-knowledge architecture has been part of 1Password since day one. The stakes are higher now.';
      const text1 = document.createTextNode(truncatedOrig);
      span1.appendChild(text1);
      el.appendChild(span1);
      document.body.appendChild(el);

      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, truncatedOrig, [
        { node: text1, originalValue: truncatedOrig, translatedValue: '「1Password 看得到我保險箱裡的內容嗎？」沒辦法。您的資料在裝置上就已經加密。' },
      ]);
      text1.nodeValue = '「1Password 看得到我保險箱裡的內容嗎？」沒辦法。您的資料在裝置上就已經加密。';

      // 模擬 React re-render:
      // 1. 改 text node 為完整英文(展開後的全文)
      text1.nodeValue = fullExpanded;
      // 2. strip attributes
      el.removeAttribute('data-shinkansen-nodevalue-mutated');
      el.removeAttribute('data-shinkansen-translated');
      // 3. append 新 children(link + hashtags)
      const hashSpan = document.createElement('span');
      hashSpan.textContent = '#Security #ZeroKnowledge #Privacy';
      el.appendChild(hashSpan);

      const mockMutations = [{ target: el, type: 'childList', addedNodes: [hashSpan], removedNodes: [] }];
      const fired = SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations);
      return {
        fired,
        attr_nvm: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
        attr_tr: el.hasAttribute('data-shinkansen-translated'),
        backup_has: SK.STATE.nodeValueMutateBackup.has(el),
        text1_value: text1.nodeValue,
        text1_preserved_full: text1.nodeValue === fullExpanded,
      };
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(String(r.fired), 'Path D 應 fire').toBe('true');
  expect(r.attr_nvm, 'nodevalue-mutated 應移除').toBe(false);
  expect(r.attr_tr, 'translated 應移除').toBe(false);
  expect(r.backup_has, 'backup 該 el 應 clear').toBe(false);
  expect(r.text1_preserved_full, 'text1 應保留 React 設的完整原文,不被截斷版覆蓋').toBe(true);

  await page.close();
});

// Path D text node 仍持 translatedValue(React 沒改 text):應 restore 為 originalValue
test('Layer A4 Path D attr-stripped + text 仍持翻譯值 → selective restore 為 originalValue', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.createElement('div');
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      el.setAttribute('data-shinkansen-translated', '1');
      const span1 = document.createElement('span');
      const origText = 'Original English text';
      const text1 = document.createTextNode(origText);
      span1.appendChild(text1);
      el.appendChild(span1);
      document.body.appendChild(el);

      const SK = window.__SK;
      SK.STATE.translated = true;
      const translatedVal = '中文翻譯';
      SK._testNvMutateStubSetup(el, origText, [
        { node: text1, originalValue: origText, translatedValue: translatedVal },
      ]);
      // text node 仍持 translatedValue(React 只 strip attr,沒改 text)
      text1.nodeValue = translatedVal;
      el.removeAttribute('data-shinkansen-nodevalue-mutated');
      el.removeAttribute('data-shinkansen-translated');

      const mockMutations = [{ target: text1, type: 'characterData' }];
      const fired = SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations);
      return {
        fired,
        backup_has: SK.STATE.nodeValueMutateBackup.has(el),
        text1_value: text1.nodeValue,
      };
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(String(r.fired), 'Path D 應 fire').toBe('true');
  expect(r.backup_has, 'backup 應 clear').toBe(false);
  expect(r.text1_value, 'text 仍持翻譯值時應 restore 為原文').toBe('Original English text');
});

test('Layer A4 Path D 守門:attribute 仍在 → 不觸發 attr-stripped', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-nodevalue-mutate-a3.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.createElement('div');
      el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      el.setAttribute('data-shinkansen-translated', '1');
      const span1 = document.createElement('span');
      const text1 = document.createTextNode('中文譯文保持不變');
      span1.appendChild(text1);
      el.appendChild(span1);
      document.body.appendChild(el);

      const SK = window.__SK;
      SK.STATE.translated = true;
      SK._testNvMutateStubSetup(el, 'English original text stays', [
        { node: text1, originalValue: 'English original text stays', translatedValue: '中文譯文保持不變' },
      ]);

      // attribute 仍在,不動
      const mockMutations = [{ target: text1, type: 'characterData' }];
      return {
        fired: SK._detectAndUnmarkExpandedNodeValueMutate(mockMutations),
        attr_still: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      };
    })()
  `);
  const r = typeof result === 'string' ? JSON.parse(result) : result;
  expect(String(r.fired), 'attribute 仍在不該觸發').toBe('false');
  expect(r.attr_still, 'attribute 應維持').toBe(true);
});
