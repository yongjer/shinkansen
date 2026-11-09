// Regression: rescan / SPA observer / SPA nav 三個增量路徑必須依首翻 provider 分流
//
// Bug:首次翻譯走 Google MT(translateUnitsGoogle)成功後,SPA observer rescan 與
// scheduleRescanForLateContent 的 rescanTick 都寫死 SK.translateUnits(...) Gemini path,
// 不檢查首翻使用的 provider → 使用者選 Google MT 翻 X(Twitter)等 SPA 站,捲動觸發
// rescan 時新單元全部 fail「尚未設定 Gemini API Key」(若沒設 Gemini key)或偷偷
// 用 Gemini 翻(模型與首翻不一致,使用者無感)。同樣 drift 也影響:
//   - openai-compat preset 首翻 → rescan 用預設 Gemini path
//   - Gemini + modelOverride preset → rescan 用全域 default model
//   - Gemini + glossary → rescan 失去 glossary
//
// 修法:新增 STATE.translationContext 記錄首翻 provider+engine+modelOverride+glossary;
// 新增 SK.translateUnitsByProvider(rescan / SPA observer 用)+ SK.replayTranslateByProvider
// (SPA nav stickySlot=null fallback 用)依 context 分流。
//
// 本檔驗:
//   1. STATE.translationContext 欄位存在
//   2. SK.translateUnitsByProvider 依 ctx.provider='google' → 走 SK.translateUnitsGoogle
//   3. SK.translateUnitsByProvider 依 ctx.provider='gemini' → 走 SK.translateUnits 帶對應 engine
//   4. SK.translateUnitsByProvider 依 ctx.provider='openai-compat' → 走 SK.translateUnits 帶 engine='openai-compat'+modelOverride
//   5. SK.replayTranslateByProvider 依 ctx.provider 重放對應整頁翻譯函式
//   6. ctx 為 null 時防禦性 fallback 至 SK.translateUnits / SK.translatePage(舊行為)
//
// SANITY 紀錄(已驗證):暫時把 translateUnitsByProvider 內 google 分支改成走
// SK.translateUnits → test 2「provider=google 應呼叫 translateUnitsGoogle」fail
// (lastCalled='translateUnits');還原後全綠。
//
// v1.9.8 SANITY(已驗證):google 分支的 return 暫時改回 pageUsage: null →
// test 2「純 cache hit 透傳 cacheHits」fail(pageUsage 變 null,toEqual 失敗);
// 還原為 { cacheHits: r.cacheHits || 0 } 後 pass。
//
// 本檔不驗:真實 API 呼叫(無 key)/ rescan 觸發時機(已有 spa-virtualization-by-text-reuse 等覆蓋)。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('STATE.translationContext 欄位存在,新 page 為 null', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      return {
        hasField: 'translationContext' in SK.STATE,
        initialValue: SK.STATE.translationContext,
        hasUnitsRouter: typeof SK.translateUnitsByProvider === 'function',
        hasReplayRouter: typeof SK.replayTranslateByProvider === 'function',
      };
    })()
  `);
  expect(result.hasField, 'STATE 應有 translationContext 欄位').toBe(true);
  expect(result.initialValue, '新 page translationContext 應為 null').toBeNull();
  expect(result.hasUnitsRouter, 'SK.translateUnitsByProvider 應存在').toBe(true);
  expect(result.hasReplayRouter, 'SK.replayTranslateByProvider 應存在').toBe(true);

  await page.close();
});

test('translateUnitsByProvider:ctx.provider=google → 走 translateUnitsGoogle,純 cache hit 透傳 cacheHits 給 pickRescanToast', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // v1.9.8: Google MT 路徑改回 pageUsage: { cacheHits },支援「rescan 純 cache hit
  // silent」(對應 spa-observer-pure-cache-hit-silent.spec.js)。
  // 模擬 translateUnitsGoogle 回 cacheHits=3、done=3 → router 應包成
  // pageUsage: { cacheHits: 3 },讓 pickRescanToast 命中 isPureCacheHit 走 silent。
  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const calls = [];
      const origUnits = SK.translateUnits;
      const origGoogle = SK.translateUnitsGoogle;
      SK.translateUnits = async (units, opts) => { calls.push({ fn: 'translateUnits', opts: opts || {} }); return { done: 0, total: 0, failures: [], pageUsage: {} }; };
      SK.translateUnitsGoogle = async (units, opts) => {
        calls.push({ fn: 'translateUnitsGoogle', opts: opts || {} });
        return { done: 3, total: 3, failures: [], chars: 0, cacheHits: 3 };
      };
      try {
        SK.STATE.translationContext = { provider: 'google' };
        const ret = await SK.translateUnitsByProvider([{ kind: 'element', el: document.body }]);
        return { calls, hasPageUsageField: 'pageUsage' in ret, pageUsage: ret.pageUsage, done: ret.done };
      } finally {
        SK.translateUnits = origUnits;
        SK.translateUnitsGoogle = origGoogle;
        SK.STATE.translationContext = null;
      }
    })()
  `);
  expect(result.calls.length, '應有恰好 1 次 dispatch').toBe(1);
  expect(result.calls[0].fn, '應呼叫 translateUnitsGoogle').toBe('translateUnitsGoogle');
  expect(result.hasPageUsageField, 'Google MT 路徑回傳應補 pageUsage 欄位給 caller(pickRescanToast 用)').toBe(true);
  expect(result.pageUsage, 'router 應把 cacheHits 包進 pageUsage,給 pickRescanToast 判 silent').toEqual({ cacheHits: 3 });
  expect(result.done, 'cacheHits === done → 純 cache hit 場景').toBe(3);

  await page.close();
});

test('translateUnitsByProvider:ctx.provider=gemini + modelOverride + glossary → 走 translateUnits 帶完整參數', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const calls = [];
      const origUnits = SK.translateUnits;
      const origGoogle = SK.translateUnitsGoogle;
      SK.translateUnits = async (units, opts) => { calls.push({ fn: 'translateUnits', opts: opts || {} }); return { done: 0, total: 0, failures: [], pageUsage: {} }; };
      SK.translateUnitsGoogle = async (units, opts) => { calls.push({ fn: 'translateUnitsGoogle', opts: opts || {} }); return { done: 0, total: 0, failures: [], chars: 0 }; };
      try {
        SK.STATE.translationContext = {
          provider: 'gemini',
          engine: null,
          modelOverride: 'gemini-3-pro',
          glossary: [{ src: 'Foo', tgt: '富' }],
        };
        await SK.translateUnitsByProvider([{ kind: 'element', el: document.body }]);
        return { calls };
      } finally {
        SK.translateUnits = origUnits;
        SK.translateUnitsGoogle = origGoogle;
        SK.STATE.translationContext = null;
      }
    })()
  `);
  expect(result.calls.length).toBe(1);
  expect(result.calls[0].fn, '應呼叫 translateUnits').toBe('translateUnits');
  expect(result.calls[0].opts.modelOverride, '應 forward modelOverride').toBe('gemini-3-pro');
  expect(result.calls[0].opts.glossary, '應 forward glossary').toEqual([{ src: 'Foo', tgt: '富' }]);

  await page.close();
});

test('translateUnitsByProvider:ctx.provider=openai-compat → 走 translateUnits 帶 engine=openai-compat', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const calls = [];
      const origUnits = SK.translateUnits;
      const origGoogle = SK.translateUnitsGoogle;
      SK.translateUnits = async (units, opts) => { calls.push({ fn: 'translateUnits', opts: opts || {} }); return { done: 0, total: 0, failures: [], pageUsage: {} }; };
      SK.translateUnitsGoogle = async (units, opts) => { calls.push({ fn: 'translateUnitsGoogle', opts: opts || {} }); return { done: 0, total: 0, failures: [], chars: 0 }; };
      try {
        SK.STATE.translationContext = {
          provider: 'openai-compat',
          engine: 'openai-compat',
          modelOverride: null,
          glossary: null,
        };
        await SK.translateUnitsByProvider([{ kind: 'element', el: document.body }]);
        return { calls };
      } finally {
        SK.translateUnits = origUnits;
        SK.translateUnitsGoogle = origGoogle;
        SK.STATE.translationContext = null;
      }
    })()
  `);
  expect(result.calls.length).toBe(1);
  expect(result.calls[0].fn).toBe('translateUnits');
  expect(result.calls[0].opts.engine, '應 forward engine=openai-compat').toBe('openai-compat');

  await page.close();
});

test('translateUnitsByProvider:ctx=null → 防禦性 fallback SK.translateUnits(舊行為)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const calls = [];
      const origUnits = SK.translateUnits;
      const origGoogle = SK.translateUnitsGoogle;
      SK.translateUnits = async (units, opts) => { calls.push({ fn: 'translateUnits', opts: opts || {} }); return { done: 0, total: 0, failures: [], pageUsage: {} }; };
      SK.translateUnitsGoogle = async (units, opts) => { calls.push({ fn: 'translateUnitsGoogle', opts: opts || {} }); return { done: 0, total: 0, failures: [], chars: 0 }; };
      try {
        SK.STATE.translationContext = null;
        await SK.translateUnitsByProvider([{ kind: 'element', el: document.body }]);
        return { calls };
      } finally {
        SK.translateUnits = origUnits;
        SK.translateUnitsGoogle = origGoogle;
      }
    })()
  `);
  expect(result.calls.length).toBe(1);
  expect(result.calls[0].fn, '無 ctx 時應 fallback 走 translateUnits').toBe('translateUnits');

  await page.close();
});

test('replayTranslateByProvider:依 ctx.provider 分流到 translatePage / translatePageGoogle', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const calls = [];
      const origPage = SK.translatePage;
      const origGooglePage = SK.translatePageGoogle;
      SK.translatePage = async (opts) => { calls.push({ fn: 'translatePage', opts: opts || {} }); };
      SK.translatePageGoogle = async (opts) => { calls.push({ fn: 'translatePageGoogle', opts: opts || {} }); };
      try {
        // case A: provider=google
        SK.STATE.translationContext = { provider: 'google' };
        await SK.replayTranslateByProvider();
        // case B: provider=gemini + modelOverride
        SK.STATE.translationContext = { provider: 'gemini', engine: null, modelOverride: 'gemini-3-pro', glossary: null };
        await SK.replayTranslateByProvider();
        // case C: provider=openai-compat
        SK.STATE.translationContext = { provider: 'openai-compat', engine: 'openai-compat', modelOverride: null, glossary: null };
        await SK.replayTranslateByProvider();
        // case D: ctx=null fallback
        SK.STATE.translationContext = null;
        await SK.replayTranslateByProvider();
        return { calls };
      } finally {
        SK.translatePage = origPage;
        SK.translatePageGoogle = origGooglePage;
        SK.STATE.translationContext = null;
      }
    })()
  `);
  expect(result.calls.length, '4 次 replay').toBe(4);
  expect(result.calls[0].fn, 'google → translatePageGoogle').toBe('translatePageGoogle');
  expect(result.calls[1].fn, 'gemini → translatePage').toBe('translatePage');
  expect(result.calls[1].opts.modelOverride, 'gemini 應 forward modelOverride').toBe('gemini-3-pro');
  expect(result.calls[2].fn, 'openai-compat → translatePage').toBe('translatePage');
  expect(result.calls[2].opts.engine, 'openai-compat 應 forward engine').toBe('openai-compat');
  expect(result.calls[3].fn, 'ctx=null fallback → translatePage').toBe('translatePage');

  await page.close();
});
