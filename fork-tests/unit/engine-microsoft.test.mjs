import { createMicrosoftEdgeEngine, createAzureEngine, jwtExpiry, AZURE_DEFAULT_ENDPOINT } from '../../shinkansen/fork/engines/microsoft.js';
import { createMockFetch, jsonResponse, textResponse, headerOf, fakeJwt } from '../helpers/mock-fetch.mjs';

const msReply = (items) => jsonResponse(items.map((t) => ({ translations: [{ text: t, to: 'zh-Hant' }] })));

describe('Microsoft Translator（Edge 免費端點）', () => {
  test('先取 token，再以 Bearer 送翻譯；標記轉成標籤再轉回', async () => {
    const nowSec = 1_800_000_000;
    const jwt = fakeJwt(nowSec + 600);
    const { fetchImpl, calls } = createMockFetch([
      { match: 'https://edge.microsoft.com/translate/auth', respond: () => textResponse(jwt) },
      {
        match: 'https://api-edge.cognitive.microsofttranslator.com/translate',
        respond: (_u, init) => {
          const body = JSON.parse(init.body);
          expect(body).toEqual([{ Text: 'Hello <x1>world</x1>' }, { Text: 'Bye' }]);
          return msReply(['你好 <x1>世界</x1>', '再見']);
        },
      },
    ]);
    const engine = createMicrosoftEdgeEngine({ fetchImpl, now: () => nowSec * 1000 });
    const r = await engine.translate(['Hello 【1】world【/1】', 'Bye'], { target: 'zh-TW', source: 'auto' });
    expect(r.translations).toEqual(['你好 【1】世界【/1】', '再見']);
    expect(r.chars).toBe('Hello 【1】world【/1】'.length + 3);

    const tr = calls[1];
    const u = new URL(tr.url);
    expect(u.searchParams.get('to')).toBe('zh-Hant');
    expect(u.searchParams.get('from')).toBeNull();
    expect(u.searchParams.get('textType')).toBe('html');
    expect(headerOf(tr.init, 'Authorization')).toBe(`Bearer ${jwt}`);
  });

  test('token 在有效期內重複使用，快到期才重新取得', async () => {
    let t = 1_800_000_000_000;
    const jwt = fakeJwt(t / 1000 + 600);
    let authCalls = 0;
    const { fetchImpl } = createMockFetch([
      { match: 'https://edge.microsoft.com/translate/auth', respond: () => { authCalls++; return textResponse(jwt); } },
      { match: /translate\?/, respond: () => msReply(['x']) },
    ]);
    const engine = createMicrosoftEdgeEngine({ fetchImpl, now: () => t });
    await engine.translate(['a'], { target: 'zh-TW' });
    t += 5 * 60_000;
    await engine.translate(['a'], { target: 'zh-TW' });
    expect(authCalls).toBe(1);
    t += 5 * 60_000; // 超過 exp - 60s
    await engine.translate(['a'], { target: 'zh-TW' });
    expect(authCalls).toBe(2);
  });

  test('指定來源語言時帶 from；超過 100 筆分批送', async () => {
    const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 600);
    const { fetchImpl, calls } = createMockFetch([
      { match: 'https://edge.microsoft.com/translate/auth', respond: () => textResponse(jwt) },
      { match: /translate\?/, respond: (_u, init) => msReply(JSON.parse(init.body).map((x) => x.Text.toUpperCase())) },
    ]);
    const engine = createMicrosoftEdgeEngine({ fetchImpl });
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const r = await engine.translate(texts, { target: 'ja', source: 'en' });
    expect(r.translations).toHaveLength(150);
    expect(r.translations[149]).toBe('T149');
    const trCalls = calls.filter((c) => c.url.includes('/translate?'));
    expect(trCalls).toHaveLength(2);
    expect(new URL(trCalls[0].url).searchParams.get('from')).toBe('en');
    expect(new URL(trCalls[0].url).searchParams.get('to')).toBe('ja');
  });

  test('HTTP 429 → forkEngineRateLimited；回應筆數不符 → forkEngineBadResponse', async () => {
    const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 600);
    const { fetchImpl } = createMockFetch([
      { match: 'https://edge.microsoft.com/translate/auth', respond: () => textResponse(jwt) },
      { match: /translate\?/, respond: () => textResponse('slow down', { status: 429 }) },
    ]);
    const engine = createMicrosoftEdgeEngine({ fetchImpl });
    await expect(engine.translate(['a'], { target: 'zh-TW' })).rejects.toMatchObject({ skCode: 'forkEngineRateLimited' });

    const bad = createMockFetch([
      { match: 'https://edge.microsoft.com/translate/auth', respond: () => textResponse(jwt) },
      { match: /translate\?/, respond: () => msReply(['only one']) },
    ]);
    const engine2 = createMicrosoftEdgeEngine({ fetchImpl: bad.fetchImpl });
    await expect(engine2.translate(['a', 'b'], { target: 'zh-TW' })).rejects.toMatchObject({ skCode: 'forkEngineBadResponse' });
  });

  test('auth 端點回非 JWT → forkEngineBadResponse', async () => {
    const { fetchImpl } = createMockFetch([
      { match: 'https://edge.microsoft.com/translate/auth', respond: () => textResponse('<html>blocked</html>') },
    ]);
    const engine = createMicrosoftEdgeEngine({ fetchImpl });
    await expect(engine.translate(['a'], { target: 'zh-TW' })).rejects.toMatchObject({ skCode: 'forkEngineBadResponse' });
  });

  test('網路錯誤 → forkEngineNetwork', async () => {
    const { fetchImpl } = createMockFetch([
      { match: 'https://edge.microsoft.com/translate/auth', throws: new TypeError('Failed to fetch') },
    ]);
    const engine = createMicrosoftEdgeEngine({ fetchImpl });
    await expect(engine.translate(['a'], { target: 'zh-TW' })).rejects.toMatchObject({
      skCode: 'forkEngineNetwork',
      skParams: { engine: 'Microsoft Translator', reason: 'Failed to fetch' },
    });
  });

  test('jwtExpiry 解析失敗回 null', () => {
    expect(jwtExpiry('not-a-jwt')).toBeNull();
    expect(jwtExpiry(fakeJwt(123))).toBe(123);
  });
});

describe('Azure Translator（官方）', () => {
  test('金鑰與區域放在 header，不放網址', async () => {
    const { fetchImpl, calls } = createMockFetch([
      { match: `${AZURE_DEFAULT_ENDPOINT}/translate`, respond: () => msReply(['你好']) },
    ]);
    const engine = createAzureEngine({ fetchImpl });
    const r = await engine.translate(['Hello'], {
      target: 'zh-TW', source: 'auto', cfg: { azure: { region: 'eastasia', endpoint: '' } }, secrets: { azureKey: 'AZ-SECRET' },
    });
    expect(r.translations).toEqual(['你好']);
    const c = calls[0];
    expect(c.url).not.toContain('AZ-SECRET');
    expect(headerOf(c.init, 'Ocp-Apim-Subscription-Key')).toBe('AZ-SECRET');
    expect(headerOf(c.init, 'Ocp-Apim-Subscription-Region')).toBe('eastasia');
  });

  test('自訂端點去掉結尾斜線；沒有區域就不送區域 header', async () => {
    const { fetchImpl, calls } = createMockFetch([
      { match: 'https://my.cognitiveservices.azure.com/translate', respond: () => msReply(['x']) },
    ]);
    const engine = createAzureEngine({ fetchImpl });
    await engine.translate(['a'], { target: 'de', cfg: { azure: { endpoint: 'https://my.cognitiveservices.azure.com/' } }, secrets: { azureKey: 'k' } });
    expect(new URL(calls[0].url).searchParams.get('to')).toBe('de');
    expect(headerOf(calls[0].init, 'Ocp-Apim-Subscription-Region')).toBeUndefined();
  });

  test('沒有金鑰 → forkEngineNotConfigured；401 → forkEngineAuth；403 + quota → forkEngineQuota', async () => {
    const engine = createAzureEngine({ fetchImpl: async () => { throw new Error('should not fetch'); } });
    expect(engine.isConfigured({}, {})).toBe(false);
    await expect(engine.translate(['a'], { target: 'zh-TW', secrets: {} })).rejects.toMatchObject({ skCode: 'forkEngineNotConfigured' });

    const e401 = createAzureEngine({ fetchImpl: createMockFetch([{ match: /./, respond: () => textResponse('bad key', { status: 401 }) }]).fetchImpl });
    await expect(e401.translate(['a'], { target: 'zh-TW', secrets: { azureKey: 'k' } })).rejects.toMatchObject({ skCode: 'forkEngineAuth', skParams: { status: 401 } });

    const e403 = createAzureEngine({ fetchImpl: createMockFetch([{ match: /./, respond: () => textResponse('{"error":"Quota exceeded"}', { status: 403 }) }]).fetchImpl });
    await expect(e403.translate(['a'], { target: 'zh-TW', secrets: { azureKey: 'k' } })).rejects.toMatchObject({ skCode: 'forkEngineQuota' });
  });
});
