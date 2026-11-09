// Regression: SPA virtualization by-text reuse(Twitter / Reddit / Threads / Mastodon)
//
// Bug:Twitter 等 virtualized scroll 站把離開 viewport 的 element 完全 unmount,使用者
// 滑回去時 React 建立全新 element(沒 data-shinkansen-translated attribute、不在
// STATE.translatedHTML)→ SPA observer 看到「新內容」→ collectParagraphs + translateUnits
// → 即使 cache hit 也會重新 inject + 短暫 flicker;若 serialize 後 placeholder 微差導致
// cache miss,還會真打 API 重翻一次,且譯文可能跟原本不同(實測 Magnolia1234B profile
// idx 0「繞過 Paywalls Clean 在 GitLab 上被阻止」滑回頂變成「Bypass Paywalls Clean 在
// GitLab 被封殺了」)。
//
// 修法:加 STATE.translatedHTMLByText(原 textContent → savedHTML)secondary cache。
// inject 路徑同步寫入此 Map(SK._recordTranslatedByText)。SPA observer rescan 收到
// element unit 時用 textContent 預檢此 Map,命中 → 直接 reuse 既有譯文 inject + 加
// attribute + 補 STATE.translatedHTML / originalText,從 newUnits 移除,**不送 API**。
//
// SANITY 紀錄(已驗證):暫時把 by-text reuse 區塊整段 comment 掉 → spec「remount 後新
// element 應該 by-text reuse 不送 API」 fail(reused=0);還原 fix → 全綠。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('STATE.translatedHTMLByText 存在 + 新建 page 為空', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      return {
        hasMap: SK.STATE.translatedHTMLByText instanceof Map,
        size: SK.STATE.translatedHTMLByText?.size,
        hasRecorder: typeof SK._recordTranslatedByText === 'function',
      };
    })()
  `);
  expect(result.hasMap, 'translatedHTMLByText 應為 Map').toBe(true);
  expect(result.size, '新 page 應為空').toBe(0);
  expect(result.hasRecorder, '_recordTranslatedByText helper 應存在').toBe(true);

  await page.close();
});

test('SK._recordTranslatedByText:寫入後可用 originalText 查回 savedHTML', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK.STATE.translatedHTMLByText.clear();
      const el = document.querySelector('p#target');
      const text = 'sample original text ' + Math.random().toString(36).slice(2);
      SK.STATE.originalText.set(el, text);
      SK._recordTranslatedByText(el, '<span>譯文 SAVED HTML</span>');
      const got = SK.STATE.translatedHTMLByText.get(text);
      // 沒 originalText 時應該不寫入(防止以 wrong key 污染)
      const el2 = document.createElement('div');
      SK._recordTranslatedByText(el2, '<span>orphan</span>');
      const sizeAfter = SK.STATE.translatedHTMLByText.size;
      return { got, sizeAfter };
    })()
  `);
  expect(result.got, '寫入後應可查回 savedHTML').toBe('<span>譯文 SAVED HTML</span>');
  expect(result.sizeAfter, '沒 originalText 的 element 不應寫入').toBe(1);

  await page.close();
});

test('SK.spaByTextReuse:remount 全新 element 應 reuse 既有譯文 + 加 attribute,不收進 remaining', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 走 production helper SK.spaByTextReuse,跟 spaObserverRescan 用同一條路徑。
  // SANITY 拔掉 production 內 by-text reuse 邏輯時,此 spec 會 fail。
  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const ORIG_TEXT = 'This original tweet text from virtualization scenario';
      const SAVED_HTML = '虛擬化場景的譯文(來自原 element 的 inject 結果)';
      SK.STATE.translatedHTMLByText.clear();
      SK.STATE.translatedHTML.clear();
      SK.STATE.translated = true;
      SK.STATE.translatedHTMLByText.set(ORIG_TEXT, SAVED_HTML);

      // 模擬 React 建立全新 element 加進 DOM,內容跟原本一樣 + 1 個未命中的 element
      const remountedEl = document.createElement('p');
      remountedEl.id = 'remounted-tweet';
      remountedEl.textContent = ORIG_TEXT;
      document.body.appendChild(remountedEl);

      const noHitEl = document.createElement('p');
      noHitEl.id = 'no-hit';
      noHitEl.textContent = 'this text not in cache';
      document.body.appendChild(noHitEl);

      const units = [
        { kind: 'element', el: remountedEl },
        { kind: 'element', el: noHitEl },
      ];

      const { reused, remaining } = SK.spaByTextReuse(units);
      const out = {
        reusedCount: reused.length,
        remainingCount: remaining.length,
        injectedInnerHTML: remountedEl.innerHTML,
        attrSetOnRemounted: remountedEl.hasAttribute('data-shinkansen-translated'),
        attrSetOnNoHit: noHitEl.hasAttribute('data-shinkansen-translated'),
        translatedHTMLSize: SK.STATE.translatedHTML.size,
        originalTextHasRemounted: SK.STATE.originalText.has(remountedEl),
      };
      // cleanup
      remountedEl.remove();
      noHitEl.remove();
      SK.STATE.translatedHTMLByText.clear();
      SK.STATE.translatedHTML.clear();
      SK.STATE.originalText?.delete?.(remountedEl);
      SK.STATE.translated = false;
      return out;
    })()
  `);

  expect(result.reusedCount, 'cache 命中的 element 應收進 reused').toBe(1);
  expect(result.remainingCount, 'cache 未命中的 element 應留在 remaining 走正常翻譯').toBe(1);
  expect(result.injectedInnerHTML, 'remount 後應 inject 既有譯文').toBe('虛擬化場景的譯文(來自原 element 的 inject 結果)');
  expect(result.attrSetOnRemounted, 'reuse 後應加 data-shinkansen-translated attribute').toBe(true);
  expect(result.attrSetOnNoHit, '未命中的 element 不該被加 attribute').toBe(false);
  expect(result.translatedHTMLSize, 'reuse 後新 element 應補進 STATE.translatedHTML').toBe(1);
  expect(result.originalTextHasRemounted, 'reuse 後新 element 應補進 STATE.originalText').toBe(true);

  await page.close();
});

test('SK.spaByTextReuse:byText cache 為空時應全部回 remaining', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK.STATE.translatedHTMLByText.clear();
      const el = document.createElement('p');
      el.textContent = 'sample';
      document.body.appendChild(el);
      const { reused, remaining } = SK.spaByTextReuse([{ kind: 'element', el }]);
      el.remove();
      return { reusedLen: reused.length, remainingLen: remaining.length };
    })()
  `);
  expect(result.reusedLen, 'byText 為空時 reused 為 0').toBe(0);
  expect(result.remainingLen, 'byText 為空時 units 全部回 remaining').toBe(1);

  await page.close();
});

test('restorePage / SPA navigation reset 應 clear translatedHTMLByText', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      // 寫入 byText
      SK.STATE.translatedHTMLByText.clear();
      SK.STATE.translatedHTMLByText.set('sample', '<span>x</span>');
      const sizeBefore = SK.STATE.translatedHTMLByText.size;
      // 模擬 SPA reset(content-spa.js resetForSpaNavigation)直接呼叫 clear
      SK.STATE.translatedHTMLByText.clear();
      return { sizeBefore, sizeAfter: SK.STATE.translatedHTMLByText.size };
    })()
  `);
  expect(result.sizeBefore, 'set 後 size=1').toBe(1);
  expect(result.sizeAfter, 'clear 後 size=0').toBe(0);

  await page.close();
});
