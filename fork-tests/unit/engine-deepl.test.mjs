import {
  createDeeplEngine, createDeeplxEngine, deeplEndpointForKey, isValidDeeplxUrl, DEEPL_FREE_URL, DEEPL_PRO_URL,
} from '../../shinkansen/fork/engines/deepl.js';
import { createMockFetch, jsonResponse, textResponse, headerOf } from '../helpers/mock-fetch.mjs';

describe('DeepL API（官方）', () => {
  test(':fx 金鑰走 Free 端點，其他走 Pro 端點', () => {
    expect(deeplEndpointForKey('abc:fx')).toBe(DEEPL_FREE_URL);
    expect(deeplEndpointForKey(' abc:fx ')).toBe(DEEPL_FREE_URL);
    expect(deeplEndpointForKey('abc')).toBe(DEEPL_PRO_URL);
  });

  test('金鑰放 Authorization header；tag_handling=xml；自動偵測時不送 source_lang', async () => {
    const { fetchImpl, calls } = createMockFetch([
      {
        match: DEEPL_FREE_URL,
        respond: (_u, init) => {
          const body = JSON.parse(init.body);
          expect(body.text).toEqual(['Read <x1>this</x1> &amp; that']);
          expect(body.target_lang).toBe('ZH-HANT');
          expect(body.tag_handling).toBe('xml');
          expect(body).not.toHaveProperty('source_lang');
          return jsonResponse({ translations: [{ detected_source_language: 'EN', text: '閱讀 <x1>這個</x1> &amp; 那個' }] });
        },
      },
    ]);
    const engine = createDeeplEngine({ fetchImpl });
    const r = await engine.translate(['Read 【1】this【/1】 & that'], { target: 'zh-TW', source: 'auto', secrets: { deeplKey: 'KEY:fx' } });
    expect(r.translations).toEqual(['閱讀 【1】這個【/1】 & 那個']);
    expect(headerOf(calls[0].init, 'Authorization')).toBe('DeepL-Auth-Key KEY:fx');
    expect(calls[0].url).not.toContain('KEY');
  });

  test('指定來源語言時送 source_lang；超過 50 段分批', async () => {
    const { fetchImpl, calls } = createMockFetch([
      {
        match: DEEPL_PRO_URL,
        respond: (_u, init) => {
          const body = JSON.parse(init.body);
          expect(body.source_lang).toBe('JA');
          expect(body.target_lang).toBe('EN-US');
          return jsonResponse({ translations: body.text.map((t) => ({ text: `en:${t}` })) });
        },
      },
    ]);
    const engine = createDeeplEngine({ fetchImpl });
    const texts = Array.from({ length: 120 }, (_, i) => `文${i}`);
    const r = await engine.translate(texts, { target: 'en', source: 'ja', secrets: { deeplKey: 'pro-key' } });
    expect(calls).toHaveLength(3);
    expect(r.translations[119]).toBe('en:文119');
  });

  test('456 → forkEngineQuota；403 → forkEngineAuth；缺金鑰 → forkEngineNotConfigured', async () => {
    const q = createDeeplEngine({ fetchImpl: createMockFetch([{ match: /./, respond: () => textResponse('Quota exceeded', { status: 456 }) }]).fetchImpl });
    await expect(q.translate(['a'], { target: 'zh-TW', secrets: { deeplKey: 'k' } })).rejects.toMatchObject({ skCode: 'forkEngineQuota', skParams: { engine: 'DeepL', status: 456 } });

    const a = createDeeplEngine({ fetchImpl: createMockFetch([{ match: /./, respond: () => textResponse('Forbidden', { status: 403 }) }]).fetchImpl });
    await expect(a.translate(['a'], { target: 'zh-TW', secrets: { deeplKey: 'k' } })).rejects.toMatchObject({ skCode: 'forkEngineAuth' });

    const n = createDeeplEngine({ fetchImpl: async () => { throw new Error('no'); } });
    await expect(n.translate(['a'], { target: 'zh-TW', secrets: {} })).rejects.toMatchObject({ skCode: 'forkEngineNotConfigured' });
  });

  test('回應形狀不對 → forkEngineBadResponse', async () => {
    const e = createDeeplEngine({ fetchImpl: createMockFetch([{ match: /./, respond: () => jsonResponse({ message: 'weird' }) }]).fetchImpl });
    await expect(e.translate(['a'], { target: 'zh-TW', secrets: { deeplKey: 'k' } })).rejects.toMatchObject({ skCode: 'forkEngineBadResponse' });
  });
});

describe('DeepLX（使用者自填端點）', () => {
  const URL_ = 'https://deeplx.example.test/translate';

  test('沒有網址就視為未設定，不送任何請求', async () => {
    const engine = createDeeplxEngine({ fetchImpl: async () => { throw new Error('should not fetch'); } });
    expect(engine.isConfigured({ deeplx: { url: '' } })).toBe(false);
    expect(engine.isConfigured({ deeplx: { url: 'ftp://x' } })).toBe(false);
    expect(isValidDeeplxUrl('https://a.b/translate')).toBe(true);
    await expect(engine.translate(['a'], { target: 'zh-TW', cfg: { deeplx: { url: '' } } })).rejects.toMatchObject({ skCode: 'forkEngineNotConfigured' });
  });

  test('逐段送出、保持順序；權杖放 Bearer header', async () => {
    const { fetchImpl, calls } = createMockFetch([
      {
        match: URL_,
        respond: async (_u, init) => {
          const body = JSON.parse(init.body);
          expect(body.source_lang).toBe('auto');
          expect(body.target_lang).toBe('ZH-HANS');
          // 讓後送出的先回來，確認輸出仍依原順序
          await new Promise((r) => setTimeout(r, body.text === 'one' ? 20 : 0));
          return jsonResponse({ code: 200, data: `譯:${body.text}` });
        },
      },
    ]);
    const engine = createDeeplxEngine({ fetchImpl, concurrency: 3 });
    const r = await engine.translate(['one', 'two', 'three'], {
      target: 'zh-CN', source: 'auto', cfg: { deeplx: { url: URL_ } }, secrets: { deeplxToken: 'TOK' },
    });
    expect(r.translations).toEqual(['譯:one', '譯:two', '譯:three']);
    expect(calls).toHaveLength(3);
    expect(headerOf(calls[0].init, 'Authorization')).toBe('Bearer TOK');
    expect(calls[0].url).toBe(URL_);
  });

  test('沒有權杖就不送 Authorization；code != 200 → forkEngineBadResponse', async () => {
    const { fetchImpl, calls } = createMockFetch([{ match: URL_, respond: () => jsonResponse({ code: 503, message: 'blocked' }) }]);
    const engine = createDeeplxEngine({ fetchImpl });
    await expect(engine.translate(['a'], { target: 'zh-TW', cfg: { deeplx: { url: URL_ } }, secrets: {} })).rejects.toMatchObject({ skCode: 'forkEngineBadResponse' });
    expect(headerOf(calls[0].init, 'Authorization')).toBeUndefined();
  });

  test('每段送出前都經過 acquire（速率限制）', async () => {
    const { fetchImpl } = createMockFetch([{ match: URL_, respond: (_u, init) => jsonResponse({ code: 200, data: JSON.parse(init.body).text }) }]);
    const engine = createDeeplxEngine({ fetchImpl });
    let n = 0;
    await engine.translate(['a', 'b', 'c', 'd'], { target: 'zh-TW', cfg: { deeplx: { url: URL_ } }, acquire: async () => { n++; } });
    expect(n).toBe(4);
  });
});
