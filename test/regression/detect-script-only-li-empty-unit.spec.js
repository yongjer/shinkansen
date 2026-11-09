// Regression: script-only-li-empty-unit（對應 v1.10.50 修的「sidebar script li
// 被翻成整段無關幻覺長文」bug)
//
// Fixture: test/regression/fixtures/script-only-li-empty-unit.html
// 結構：<li><script>cookie 判斷 JS</script></li> 夾在正常 li 之間
// Bug（兩層）:
//   1. 偵測端：LI 是 block tag,isCandidateText 看 textContent(660 字 JS code)
//      誤判通過；script li 只有 1 個 element 子孫逃過 shortBlockComplexSkip →
//      整顆 li 被收為 element unit
//   2. 協定端：序列化時 walker 正確排除 SCRIPT 子樹 → 該 unit 序列化成空字串，
//      但空 unit 照樣進 batch 送 API → LLM 對空段自由發揮編出無關長文 →
//      注入回 li（囈語）；且 cache key = sha1('') 固定值，幻覺譯文跨頁汙染所有空段
// 修法（結構性通則，各自獨立的兩層，工作流原則 §3）:
//   A. content-detect.js acceptNode:NOSCRIPT 窄修通則化——含 script/style/noscript/
//      textarea 子樹且 innerText < 2 字 → REJECT(stats.hardExcludeInflated)
//   B. content.js translateUnits：序列化後 text 為空/全空白的 unit 在送 API 前丟棄
//      （不送、不注入、不標 translated）
//
// SANITY 紀錄（已驗證，2026-06-12）:
//   破壞 A(content-detect.js 把 hardExcludeInflated REJECT 條件改回只查 noscript)→
//   case 1「collectParagraphs 不收 script-only li」fail(containsScriptLi=true)→ 還原 pass。
//   破壞 B(content.js translateUnits 拿掉空 unit 過濾 block)→
//   case 2「空字串 unit 不送 API」fail(emptyTextsSent=1)→ 還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'script-only-li-empty-unit';

test('script-only-li-empty-unit: collectParagraphs 不收 script-only li（偵測端 REJECT）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#script-li', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const stats = {};
      const units = window.__SK.collectParagraphs(document.body, stats);
      const scriptLi = document.querySelector('#script-li');
      return {
        count: units.length,
        containsScriptLi: units.some(u =>
          u.el === scriptLi ||
          (u.startNode && scriptLi.contains(u.startNode))),
        hardExcludeInflated: stats.hardExcludeInflated || 0,
        realPCollected: units.filter(u =>
          u.el && u.el.classList && u.el.classList.contains('real-p')).length,
      };
    })()
  `);

  // script-only li 絕不可成為 unit
  expect(result.containsScriptLi,
    'script-only li 不應被 collectParagraphs 收為 unit').toBe(false);
  // REJECT 走的是 hardExcludeInflated 這條通則（不是碰巧被其他條件擋掉）
  expect(result.hardExcludeInflated,
    `stats.hardExcludeInflated 應 >= 1，實際 ${result.hardExcludeInflated}`).toBeGreaterThanOrEqual(1);
  // 對照組：兩個正常段落仍正常收（REJECT 沒誤傷）
  expect(result.realPCollected, '兩個 .real-p 應正常被收').toBe(2);

  await page.close();
});

test('script-only-li-empty-unit: 序列化後為空的 unit 不送 API、不注入（協定端 guard）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#script-li', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock TRANSLATE_BATCH：記錄送出的 texts;streaming mock 失敗 → fallback non-streaming
  await evaluate(`
    window.__batchTextsSeen = [];
    chrome.storage.sync.get = async function(keys) {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 20,
        maxCharsPerBatch: 100000,
        partialMode: { enabled: false, maxUnits: 25 },
      };
    };
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        return { ok: false, error: 'streaming disabled in test' };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        return { ok: true, aborted: false };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        for (const t of texts) window.__batchTextsSeen.push(t);
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: texts.length, outputTokens: texts.length, cachedTokens: 0,
                   billedInputTokens: texts.length, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 手工餵 units（繞過偵測端修法 A，獨立驗證協定端 guard B）:
  // 1 個正常段 + 1 個 script-only li（序列化後為空字串）
  await evaluate(`
    (() => {
      const units = [
        { kind: 'element', el: document.querySelector('.real-p') },
        { kind: 'element', el: document.querySelector('#script-li') },
      ];
      window.__translatePromise = window.__SK.translateUnits(units).catch(e => null);
      return null;
    })()
  `);
  await page.waitForTimeout(1500);

  const result = await evaluate(`({
    sentCount: window.__batchTextsSeen.length,
    emptyTextsSent: window.__batchTextsSeen.filter(t => !(t || '').trim()).length,
    scriptLiMarked: document.querySelector('#script-li').hasAttribute('data-shinkansen-translated'),
    scriptLiStillHasScript: !!document.querySelector('#script-li script'),
    realPTranslated: document.querySelector('.real-p').textContent.startsWith('[ZH] '),
  })`);

  // 空字串 unit 絕不可送 API
  expect(result.emptyTextsSent,
    `送 API 的 texts 不可含空字串，實際有 ${result.emptyTextsSent} 段空`).toBe(0);
  expect(result.sentCount, '只送 1 段（正常段）').toBe(1);
  // script li 維持原樣：不標 translated、script 元素完整保留
  expect(result.scriptLiMarked, 'script li 不應被標 data-shinkansen-translated').toBe(false);
  expect(result.scriptLiStillHasScript, 'script li 的 <script> 元素應完整保留').toBe(true);
  // 正常段照常翻完（guard 沒誤傷）
  expect(result.realPTranslated, '.real-p 應正常翻完').toBe(true);

  await page.close();
});
