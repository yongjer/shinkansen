// Regression: v1.4.1 Google Translate 路徑的格式保留（⟦⟧ ↔ 【】 雙向替換）
//
// 根本問題：Google Translate 的 MT 引擎會亂動 ⟦⟧（數學符號），但會原樣保留
// 【】（CJK 標點）。content.js 的 translateUnitsGoogle 因此在送出前把
// ⟦N⟧/⟦/N⟧ 換成 【N】/【/N】，收回譯文後再換回 ⟦N⟧/⟦/N⟧ 走現有
// deserializeWithPlaceholders。
//
// 驗證流程（不打真實 Google API）：
//   1. fixture <p> 含 <a href>，本來會被序列化為 ⟦0⟧Tokyo travel guide⟦/0⟧
//   2. mock chrome.runtime.sendMessage 攔截 TRANSLATE_BATCH_GOOGLE，
//      回傳一段「假裝 Google MT 已翻成中文且【】標記原樣保留」的譯文：
//      "請參考【0】東京旅遊指南【/0】以了解更多。"
//   3. 觸發 SK.translateUnitsGoogle(units)
//   4. 預期：注入後 <p> 內仍有 <a href="https://example.com/tokyo">，
//      且 <a> 文字為「東京旅遊指南」（譯文已套進連結）
//
// 若 v1.4.1 的「【】 → ⟦⟧」反向 swap regex 被移除，譯文裡的 【0】 不會被
// 換回 ⟦0⟧，deserializeWithPlaceholders 找不到 ⟦⟧ → fallback 會把整段塞回，
// <a> 不會出現在 DOM 裡（或文字含可見的 【0】）。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'google-translate-format-preserve';
const TARGET_SELECTOR = 'p#target';

test('google-translate-format-preserve: 【N】 標記在 inject 前被換回 ⟦N⟧，<a> 連結保留', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 注入前 sanity：DOM 結構正確
  const before = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    return {
      linkCount: p.querySelectorAll('a').length,
      linkText: p.querySelector('a')?.textContent?.trim() ?? null,
      linkHref: p.querySelector('a')?.href ?? null,
    };
  })()`);
  expect(before.linkCount).toBe(1);
  expect(before.linkText).toBe('Tokyo travel guide');
  expect(before.linkHref).toBe('https://example.com/tokyo');

  // mock chrome.runtime.sendMessage 攔截 TRANSLATE_BATCH_GOOGLE，
  // 回傳含 【0】 標記的中文譯文（模擬 Google MT 把 【】 原樣保留的行為）
  await evaluate(`
    window.__sentMessages = [];
    chrome.runtime.sendMessage = async function(msg) {
      window.__sentMessages.push(msg);
      if (msg && msg.type === 'TRANSLATE_BATCH_GOOGLE') {
        const texts = msg.payload?.texts || [];
        // 假裝 Google MT 把每段譯成中文，且 【N】/【/N】 標記原樣保留
        const result = texts.map(t => {
          // 把 t 裡的 【0】…【/0】 段替換為「東京旅遊指南」（同樣包在 【0】…【/0】 內）
          return t.replace(/【0】.*?【\\/0】/g, '【0】東京旅遊指南【/0】')
                  .replace(/Visit the/g, '請參考')
                  .replace(/for more\\./g, '以了解更多。');
        });
        return { ok: true, result, usage: { chars: 10 } };
      }
      if (msg && msg.type === 'LOG') return;
      return { ok: true };
    };
  `);

  // 抓取段落並呼叫 translateUnitsGoogle
  await evaluate(`(async () => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    const units = [{ kind: 'element', el: p }];
    await window.__SK.translateUnitsGoogle(units);
  })()`);

  // 注入後驗證
  const after = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    if (!p) return null;
    const allLinks = Array.from(p.querySelectorAll('a'));
    return {
      hasLink: !!p.querySelector('a'),
      linkCount: allLinks.length,
      linkText: allLinks[0]?.textContent?.trim() ?? null,
      linkHref: allLinks[0]?.href ?? null,
      totalText: p.textContent.trim(),
      // 若 swap-back 失效，譯文裡會有可見的 【0】 / ⟦0⟧ 殘留
      hasVisibleBracket: /[【】⟦⟧]/.test(p.textContent),
      pInnerHTMLPreview: p.innerHTML.replace(/\\s+/g, ' ').slice(0, 300),
    };
  })()`);

  expect(after, '注入後 p 應仍存在').not.toBeNull();

  // 核心斷言：<a> 仍在，文字為譯文（連結結構完整保留）
  expect(
    after.linkCount,
    `p 內應有 1 個 <a>（連結被保留）\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(1);
  expect(
    after.linkText,
    `<a> 文字應為「東京旅遊指南」（譯文已套進連結）\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe('東京旅遊指南');
  expect(
    after.linkHref,
    `<a> href 必須維持原值\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe('https://example.com/tokyo');

  // 反向斷言：DOM 不應殘留可見的 【】 或 ⟦⟧（swap-back 失效時的症狀）
  expect(
    after.hasVisibleBracket,
    `DOM 不應留下可見的 【】 / ⟦⟧（swap-back 失效徵兆）\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(false);

  await page.close();
});

// ─── v1.4.2 / v1.4.3 複雜段落測試 ───────────────────────────────────────
// 兩個 test case 共用 fixture：google-translate-complex-paragraph.html
// （Wikipedia lede 樣式：<b>, <i>, <a>, <a>, <span class>, <small> 同段）

const COMPLEX_FIXTURE = 'google-translate-complex-paragraph';

test('google-translate-complex-paragraph: serializeForGoogleTranslate 只標 GT_INLINE_TAGS，span 不加標記（v1.4.2 / v1.4.3）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${COMPLEX_FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 直接呼叫 serializeForGoogleTranslate，驗證標記與 slots 結構
  const result = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    const { text, slots } = window.__SK.serializeForGoogleTranslate(p);
    // 計算 text 內配對標記數（【N】 與 【/N】，N 為純數字；不含 atomic 的 【*N】）
    const openMarkers   = (text.match(/【\\d+】/g) || []).length;
    const closeMarkers  = (text.match(/【\\/\\d+】/g) || []).length;
    return {
      text,
      slotCount: slots.length,
      slotTags: slots.map(s => s.tagName || (s.atomic ? 'ATOMIC' : 'UNKNOWN')),
      openMarkers,
      closeMarkers,
      // span 的內文應出現在 text 裡（被 walk 進去），但不該被【N】包住
      spanTextInText: text.includes('This text lives inside a span'),
      // 標記數應該等於 slot 數（每個 slot 一對 open+close）
      markersMatchSlots: openMarkers === slots.length && closeMarkers === slots.length,
    };
  })()`);

  // 5 個 GT_INLINE_TAGS 元素：B, I, A, A, SMALL（按 DOM 順序）
  expect(result.slotCount, `slot 數應為 5（B+I+A+A+SMALL）；實際 tags: ${result.slotTags.join(',')}`).toBe(5);
  expect(result.slotTags).toEqual(['B', 'I', 'A', 'A', 'SMALL']);

  // 標記數對齊 slot 數，且配對完整（無 stray 標記）
  expect(result.openMarkers, '【N】 開標記數應等於 slot 數').toBe(5);
  expect(result.closeMarkers, '【/N】 閉標記數應等於 slot 數').toBe(5);
  expect(result.markersMatchSlots).toBe(true);

  // span 文字進 text，但 span 自己沒被加上標記（v1.4.3 設計）
  expect(result.spanTextInText, 'span 內文應出現在 serialized text').toBe(true);
  // 反證：text 裡不該出現 span class 名「noise」（屬性都不該洩漏）
  expect(result.text.includes('noise'), 'text 不應含 span 的 class 屬性').toBe(false);

  await page.close();
});

test('google-translate-complex-paragraph: end-to-end 翻譯後 b/i/a/small 都保留，span 不重建（v1.4.3）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${COMPLEX_FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 注入前 sanity
  const before = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    return {
      bCount:     p.querySelectorAll('b').length,
      iCount:     p.querySelectorAll('i').length,
      aCount:     p.querySelectorAll('a').length,
      smallCount: p.querySelectorAll('small').length,
      spanCount:  p.querySelectorAll('span').length,
    };
  })()`);
  expect(before).toEqual({ bCount: 1, iCount: 1, aCount: 2, smallCount: 1, spanCount: 1 });

  // mock chrome.runtime.sendMessage：回傳一段保留所有 5 個【N】標記的中文譯文
  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_GOOGLE') {
        const texts = msg.payload?.texts || [];
        // 對每段假裝 Google MT 完成翻譯，所有【N】標記原樣保留
        const result = texts.map(_t => {
          // 直接回一段含 5 個標記、內文為中文的固定譯文
          return '【0】文章名稱【/0】是本段的【1】主要主題【/1】。請參考【2】主條目【/2】和【3】相關條目【/3】。這段文字在 span 裡。【4】（小字註）【/4】';
        });
        return { ok: true, result, usage: { chars: 50 } };
      }
      if (msg && msg.type === 'LOG') return;
      return { ok: true };
    };
  `);

  // 觸發 translateUnitsGoogle
  await evaluate(`(async () => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    const units = [{ kind: 'element', el: p }];
    await window.__SK.translateUnitsGoogle(units);
  })()`);

  const after = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    if (!p) return null;
    const allLinks = Array.from(p.querySelectorAll('a'));
    return {
      bCount:     p.querySelectorAll('b').length,
      bText:      p.querySelector('b')?.textContent?.trim() ?? null,
      iCount:     p.querySelectorAll('i').length,
      iText:      p.querySelector('i')?.textContent?.trim() ?? null,
      aCount:     allLinks.length,
      aTexts:     allLinks.map(a => a.textContent.trim()),
      aHrefs:     allLinks.map(a => a.href),
      smallCount: p.querySelectorAll('small').length,
      smallText:  p.querySelector('small')?.textContent?.trim() ?? null,
      spanCount:  p.querySelectorAll('span').length,
      totalText:  p.textContent.trim(),
      hasVisibleBracket: /[【】⟦⟧]/.test(p.textContent),
      pInnerHTMLPreview: p.innerHTML.replace(/\\s+/g, ' ').slice(0, 400),
    };
  })()`);

  expect(after, 'p#target 應仍存在').not.toBeNull();

  // v1.4.3：b / i / small 結構保留
  expect(after.bCount, '<b> 應保留').toBe(1);
  expect(after.bText, '<b> 文字應為翻譯後內容').toBe('文章名稱');
  expect(after.iCount, '<i> 應保留').toBe(1);
  expect(after.iText, '<i> 文字應為翻譯後內容').toBe('主要主題');
  expect(after.smallCount, '<small> 應保留').toBe(1);
  expect(after.smallText, '<small> 文字應為翻譯後內容').toBe('（小字註）');

  // <a> 結構與 href 都保留
  expect(after.aCount, '<a> 應有 2 個').toBe(2);
  expect(after.aTexts).toEqual(['主條目', '相關條目']);
  expect(after.aHrefs).toEqual(['https://example.com/main', 'https://example.com/related']);

  // <span> 不重建（沒在 GT_INLINE_TAGS 內，序列化時就沒被當 slot 包起來）
  expect(after.spanCount, '<span> 不應被重建（v1.4.3：span 不加標記）').toBe(0);
  // 但 span 內文仍出現在譯文裡
  expect(after.totalText.includes('這段文字在 span 裡'), 'span 文字應仍出現').toBe(true);

  // 反向：DOM 不應殘留可見 【】 / ⟦⟧（restoreGoogleTranslateMarkers 應全部換掉）
  expect(
    after.hasVisibleBracket,
    `DOM 不應留下可見 【】/⟦⟧ 殘留\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(false);

  await page.close();
});

// SANITY check 紀錄（已在 Claude Code 端實際跑過）：
//   - test #1（東京連結）：
//       把 content.js translateUnitsGoogle 的 SK.restoreGoogleTranslateMarkers(tr) 改成 tr，
//       linkCount=0、可見 【0】 殘留，測試 fail。已驗證。
//   - test #2（serializer 白名單）：
//       把 content-ns.js GT_INLINE_TAGS 加入 'SPAN'，slotCount 從 5 變 6（多出 span 的 slot），
//       slotTags 多出 'SPAN'，斷言 fail。已驗證。
//   - test #3（end-to-end 複雜段落）：
//       把 SK.restoreGoogleTranslateMarkers(tr) 改成 tr，bCount/iCount/aCount/smallCount 全變 0
//       （deserialize 找不到 ⟦⟧ → fallback 純文字注入），可見 【】 殘留，多條斷言 fail。已驗證。
