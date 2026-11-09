import { jest } from '@jest/globals';
import { createEngineRegistry, rateLimitsFor, isMtEngineId, ENGINE_IDS } from '../../shinkansen/fork/engines/registry.js';
import { createMtBatchHandler, mtCacheSuffix } from '../../shinkansen/fork/bg/mt-batch.js';
import { createProviderBatchHandler, buildProviderOverrides, isForkProviderPayload } from '../../shinkansen/fork/bg/providers.js';
import { mergeForkSettings } from '../../shinkansen/fork/settings/schema.js';
import { createMockFetch, jsonResponse } from '../helpers/mock-fetch.mjs';

describe('引擎註冊表', () => {
  test('google 包裝上游 translateGoogleBatch，不另寫一份', async () => {
    const googleBatch = jest.fn(async (texts, tl) => ({ translations: texts.map((t) => `${tl}:${t}`), chars: 9 }));
    const reg = createEngineRegistry({ googleBatch, fetchImpl: async () => { throw new Error('no fetch'); } });
    const r = await reg.translateWith('google', ['a', 'b'], { target: 'ja' });
    expect(googleBatch).toHaveBeenCalledWith(['a', 'b'], 'ja');
    expect(r).toMatchObject({ translations: ['ja:a', 'ja:b'], servedBy: 'google' });
  });

  test('Chrome 內建翻譯只能在頁面執行 → forkEngineContentOnly；未知 id → forkEngineUnknown', async () => {
    const reg = createEngineRegistry({ googleBatch: async () => ({}) });
    await expect(reg.translateWith('chrome-translator', ['a'], {})).rejects.toMatchObject({ skCode: 'forkEngineContentOnly' });
    await expect(reg.translateWith('nope', ['a'], {})).rejects.toMatchObject({ skCode: 'forkEngineUnknown' });
  });

  test('free-chain 依設定的順序與停用清單分派', async () => {
    const { fetchImpl } = createMockFetch([
      { match: 'https://deeplx.example.test/', respond: (_u, init) => jsonResponse({ code: 200, data: `x:${JSON.parse(init.body).text}` }) },
    ]);
    const googleBatch = jest.fn();
    const reg = createEngineRegistry({ googleBatch, fetchImpl });
    const cfg = mergeForkSettings({ mt: { chain: ['deeplx', 'google', 'microsoft-edge'], chainDisabled: ['microsoft-edge'], deeplx: { url: 'https://deeplx.example.test/' } } }).mt;
    const r = await reg.translateWith('free-chain', ['hi'], { target: 'zh-TW', cfg, secrets: {} });
    expect(r.servedBy).toBe('deeplx');
    expect(r.translations).toEqual(['x:hi']);
    expect(googleBatch).not.toHaveBeenCalled();
  });

  test('來源語言從 cfg.sourceLang 帶入，不合法值回 auto', async () => {
    const seen = [];
    const { fetchImpl } = createMockFetch([
      { match: 'https://d.test/', respond: (_u, init) => { seen.push(JSON.parse(init.body).source_lang); return jsonResponse({ code: 200, data: 'x' }); } },
    ]);
    const reg = createEngineRegistry({ fetchImpl });
    await reg.translateWith('deeplx', ['a'], { target: 'zh-TW', cfg: { sourceLang: 'ko', deeplx: { url: 'https://d.test/' } } });
    await reg.translateWith('deeplx', ['a'], { target: 'zh-TW', cfg: { sourceLang: 'xx', deeplx: { url: 'https://d.test/' } } });
    expect(seen).toEqual(['KO', 'auto']);
  });

  test('速率限制：使用者設定優先，DeepLX 預設每秒 3 次', () => {
    expect(rateLimitsFor({}, 'deeplx')).toEqual({ rps: 3, rpm: 0 });
    expect(rateLimitsFor({ rateLimits: { deeplx: { rps: 0, rpm: 30 } } }, 'deeplx')).toEqual({ rps: 0, rpm: 30 });
    expect(rateLimitsFor({}, 'deepl')).toEqual({ rps: 0, rpm: 0 });
  });

  test('isMtEngineId', () => {
    expect(ENGINE_IDS).toEqual(expect.arrayContaining(['google', 'microsoft-edge', 'azure', 'deepl', 'deeplx', 'chrome-translator', 'free-chain']));
    expect(isMtEngineId('deepl')).toBe(true);
    expect(isMtEngineId('__proto__')).toBe(false);
    expect(isMtEngineId(undefined)).toBe(false);
  });
});

describe('機器翻譯批次（背景端）', () => {
  function makeCache(prefill = {}) {
    const store = new Map(Object.entries(prefill));
    return {
      store,
      getBatch: async (texts, suffix) => texts.map((t) => store.get(`${suffix}|${t}`) ?? null),
      setBatch: async (texts, results, suffix) => texts.forEach((t, i) => store.set(`${suffix}|${t}`, results[i])),
    };
  }

  function makeDeps({ cache = makeCache(), translateWith, target = 'zh-TW', fork = {} } = {}) {
    const logUsage = jest.fn(async () => {});
    let t = 1000;
    return {
      deps: {
        registry: { translateWith: jest.fn(translateWith) },
        cache,
        logUsage,
        getTarget: async () => target,
        readFork: async () => mergeForkSettings(fork),
        readSecrets: async () => ({ providerKeys: {} }),
        now: () => (t += 50),
      },
      logUsage,
      cache,
    };
  }

  test('快取分區：引擎、目標語言、來源語言', () => {
    expect(mtCacheSuffix('microsoft-edge', 'zh-TW', 'auto')).toBe('_mt_microsoftedge');
    expect(mtCacheSuffix('deepl', 'ja', 'en')).toBe('_mt_deepl_langja_srcen');
  });

  test('只翻快取沒有的段落，結果依原順序合併，並以字元數記用量', async () => {
    const suffix = mtCacheSuffix('deepl', 'zh-TW', 'auto');
    const { deps, logUsage, cache } = makeDeps({
      cache: makeCache({ [`${suffix}|cached`]: '已快取' }),
      translateWith: async (_id, texts) => ({ translations: texts.map((t) => `譯${t}`), chars: 7, servedBy: 'deepl' }),
    });
    const handle = createMtBatchHandler(deps);
    const r = await handle({ mtEngine: 'deepl', texts: ['a', 'cached', 'b'] }, { tab: { url: 'https://example.com/x' } });
    expect(r.result).toEqual(['譯a', '已快取', '譯b']);
    expect(r.usage).toEqual({ engine: 'deepl', servedBy: 'deepl', chars: 7, cacheHits: 1 });
    expect(deps.registry.translateWith).toHaveBeenCalledWith('deepl', ['a', 'b'], expect.objectContaining({ target: 'zh-TW' }));
    expect(cache.store.get(`${suffix}|a`)).toBe('譯a');
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com/x', engine: 'deepl', model: 'deepl', billingUnit: 'chars',
      chars: 7, segments: 2, cacheHits: 1, billedCostUSD: 0, inputTokens: 0, outputTokens: 0,
    }));
  });

  test('free-chain 記錄實際服務的引擎', async () => {
    const { deps, logUsage } = makeDeps({
      translateWith: async (_id, texts) => ({ translations: texts, chars: 1, servedBy: 'google', attempts: [{ engine: 'microsoft-edge', error: 'x' }] }),
    });
    const r = await createMtBatchHandler(deps)({ mtEngine: 'free-chain', texts: ['a'] }, {});
    expect(r.usage.servedBy).toBe('google');
    expect(logUsage.mock.calls[0][0]).toMatchObject({ engine: 'google', model: 'free-chain:google' });
  });

  test('全部命中快取時不呼叫服務、不記用量', async () => {
    const suffix = mtCacheSuffix('azure', 'zh-TW', 'auto');
    const { deps, logUsage } = makeDeps({ cache: makeCache({ [`${suffix}|a`]: 'A' }), translateWith: async () => { throw new Error('no'); } });
    const r = await createMtBatchHandler(deps)({ mtEngine: 'azure', texts: ['a'] }, {});
    expect(r.result).toEqual(['A']);
    expect(deps.registry.translateWith).not.toHaveBeenCalled();
    expect(logUsage).not.toHaveBeenCalled();
  });

  test('結果筆數不符 → forkEngineBadResponse；未知引擎 → forkEngineUnknown', async () => {
    const { deps } = makeDeps({ translateWith: async () => ({ translations: ['only one'], chars: 1 }) });
    await expect(createMtBatchHandler(deps)({ mtEngine: 'deepl', texts: ['a', 'b'] }, {})).rejects.toMatchObject({ skCode: 'forkEngineBadResponse' });
    await expect(createMtBatchHandler(deps)({ mtEngine: 'bogus', texts: ['a'] }, {})).rejects.toMatchObject({ skCode: 'forkEngineUnknown' });
  });

  test('用量寫入失敗不影響翻譯結果', async () => {
    const { deps } = makeDeps({ translateWith: async (_id, texts) => ({ translations: texts, chars: 1 }) });
    deps.logUsage = async () => { throw new Error('idb down'); };
    const r = await createMtBatchHandler(deps)({ mtEngine: 'deepl', texts: ['a'] }, {});
    expect(r.result).toEqual(['a']);
  });
});

describe('額外 OpenAI 相容服務', () => {
  const provider = {
    id: 'p1', label: 'OR', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/x',
    temperature: 0.3, inputPerMTok: 3, outputPerMTok: 15, thinkingLevel: 'low',
  };
  const effective = (lang, custom) => custom || `default-prompt-${lang}`;

  test('isForkProviderPayload 只認 fork-cp: 前綴', () => {
    expect(isForkProviderPayload({ modelOverride: 'fork-cp:p1' })).toBe(true);
    expect(isForkProviderPayload({ modelOverride: 'gemini-3.8-flash' })).toBe(false);
    expect(isForkProviderPayload({})).toBe(false);
  });

  test('buildProviderOverrides：換掉 baseUrl / model / 金鑰 / prompt / 計價', () => {
    const { overrides, keyExtras } = buildProviderOverrides(provider, 'sk-1', '', 'ja', effective);
    expect(overrides).toMatchObject({
      baseUrl: provider.baseUrl, model: provider.model, apiKey: 'sk-1', systemPrompt: 'default-prompt-ja',
      temperature: 0.3, inputPerMTok: 3, outputPerMTok: 15, thinkingLevel: 'low', extraBodyJson: '',
    });
    expect(keyExtras).toEqual({ customPrompt: '' });
    expect(buildProviderOverrides(provider, '', 'MY PROMPT', 'ja', effective).keyExtras).toEqual({ customPrompt: 'MY PROMPT' });
  });

  test('交給上游 handleTranslateCustom，modelOverride 清空、套用術語表與禁用詞', async () => {
    const handleTranslateCustom = jest.fn(async () => ({ result: ['ok'] }));
    const handle = createProviderBatchHandler({
      handleTranslateCustom,
      getEffectiveSystemPrompt: effective,
      getTarget: async () => 'zh-TW',
      readFork: async () => mergeForkSettings({ providers: [provider] }),
      readSecrets: async () => ({ providerKeys: { p1: 'sk-secret' } }),
      readPrompts: async () => ({}),
    });
    const sender = { tab: { url: 'https://e.test' } };
    const r = await handle({ texts: ['a'], modelOverride: 'fork-cp:p1', glossary: null }, sender);
    expect(r).toEqual({ result: ['ok'] });
    const [payload, s, tag, overrides, fixedGlossary, forbidden] = handleTranslateCustom.mock.calls[0];
    expect(payload.modelOverride).toBeNull();
    expect(s).toBe(sender);
    expect(tag).toBe('_oc');
    expect(overrides.apiKey).toBe('sk-secret');
    expect(fixedGlossary).toBe(true);
    expect(forbidden).toBe(true);
  });

  test('找不到服務 → forkProviderMissing；沒有 Base URL → baseUrlMissing', async () => {
    const deps = {
      handleTranslateCustom: jest.fn(),
      getEffectiveSystemPrompt: effective,
      getTarget: async () => 'zh-TW',
      readFork: async () => mergeForkSettings({ providers: [{ ...provider, id: 'p2', baseUrl: '' }] }),
      readSecrets: async () => ({ providerKeys: {} }),
      readPrompts: async () => ({}),
    };
    const handle = createProviderBatchHandler(deps);
    await expect(handle({ modelOverride: 'fork-cp:p1' }, {})).rejects.toMatchObject({ skCode: 'forkProviderMissing', skParams: { id: 'p1' } });
    await expect(handle({ modelOverride: 'fork-cp:p2' }, {})).rejects.toMatchObject({ skCode: 'baseUrlMissing' });
    expect(deps.handleTranslateCustom).not.toHaveBeenCalled();
  });
});
