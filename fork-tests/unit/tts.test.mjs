// 第 2 階段：朗讀（Gemini 3.8 TTS）、自訂讀音表、音訊快取
import { webcrypto } from 'node:crypto';
import {
  sanitizePronunciations, applyPronunciations, MAX_PRONUNCIATIONS,
} from '../../shinkansen/fork/tts/pronounce.js';
import {
  TTS_ENDPOINT, TTS_STYLES, PREBUILT_VOICES, DEFAULT_VOICE, MAX_TTS_CHARS,
  cleanTtsText, buildTtsRequest, usageFromInteraction, parseTtsResponse, synthesize,
} from '../../shinkansen/fork/tts/gemini-tts.js';
import {
  TTS_CACHE_MAX, ttsCacheKey, createMemoryBackend, createAudioCache,
} from '../../shinkansen/fork/tts/audio-cache.js';
import { computeModalityCostUSD } from '../../shinkansen/lib/model-pricing.js';
import { TTS_MODELS, DEFAULT_TTS_MODEL } from '../../shinkansen/fork/settings/schema.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

describe('自訂讀音表', () => {
  test('消毒：去掉 IPA 的斜線與方括號、角括號、重複與空值', () => {
    const out = sanitizePronunciations([
      { term: ' tomato ', mode: 'ipa', value: '/təˈmɑːtoʊ/' },
      { term: 'Tomato', mode: 'respell', value: 'dup' },           // 重複（不分大小寫）
      { term: 'GIF', mode: 'ipa', value: '[dʒɪf]' },
      { term: 'tag', mode: 'respell', value: '<short pause>tag' }, // 角括號會被當成 TTS 行內標籤
      { term: 'empty', mode: 'ipa', value: '  //  ' },
      { term: '', value: 'x' },
      null, 'str',
      { term: 'x', mode: 'weird', value: 'a/b' },                   // 不認識的 mode → ipa，內部斜線拿掉
    ]);
    expect(out).toEqual([
      { term: 'tomato', mode: 'ipa', value: 'təˈmɑːtoʊ' },
      { term: 'GIF', mode: 'ipa', value: 'dʒɪf' },
      { term: 'tag', mode: 'respell', value: 'short pausetag' },
      { term: 'x', mode: 'ipa', value: 'ab' },
    ]);
    expect(sanitizePronunciations('nope')).toEqual([]);
    const many = Array.from({ length: MAX_PRONUNCIATIONS + 5 }, (_, i) => ({ term: `w${i}`, value: 'v' }));
    expect(sanitizePronunciations(many)).toHaveLength(MAX_PRONUNCIATIONS);
  });

  test('IPA 以 /…/ 放回原位；拉丁字母整詞比對、不分大小寫', () => {
    const entries = [{ term: 'read', mode: 'ipa', value: 'rɛd' }];
    const r = applyPronunciations('I Read it. Reading is fun; read!', entries);
    expect(r.text).toBe('I /rɛd/ it. Reading is fun; /rɛd/!');
    expect(r.applied).toEqual(['read']);
  });

  test('長的詞優先，已被佔用的位置不重複套用', () => {
    const entries = [
      { term: 'New York', mode: 'respell', value: 'noo YORK' },
      { term: 'York', mode: 'ipa', value: 'jɔːk' },
    ];
    expect(applyPronunciations('New York and York', entries).text).toBe('noo YORK and /jɔːk/');
  });

  test('中日韓文字沒有詞界，直接比對子字串', () => {
    const entries = [{ term: '行く', mode: 'respell', value: 'いく' }, { term: '銀行', mode: 'ipa', value: 'ginkoː' }];
    expect(applyPronunciations('銀行へ行くつもり', entries).text).toBe('/ginkoː/へいくつもり');
  });

  test('瀏覽器內建語音只套用拼讀式改寫', () => {
    const entries = [{ term: 'GIF', mode: 'ipa', value: 'dʒɪf' }, { term: 'SQL', mode: 'respell', value: 'sequel' }];
    expect(applyPronunciations('GIF and SQL', entries, { engine: 'browser' }).text).toBe('GIF and sequel');
    expect(applyPronunciations('GIF and SQL', entries).text).toBe('/dʒɪf/ and sequel');
    expect(applyPronunciations('', entries)).toEqual({ text: '', applied: [] });
  });
});

describe('Gemini TTS 請求 / 回應', () => {
  test('預設模型是 Flash-Lite，可切換 Flash；模型 ID 只從計價表來', () => {
    expect(TTS_MODELS).toEqual(expect.arrayContaining(['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']));
    expect(DEFAULT_TTS_MODEL).toBe('gemini-3.8-flash-lite-tts');
    expect(PREBUILT_VOICES).toHaveLength(30);
    expect(PREBUILT_VOICES).toContain(DEFAULT_VOICE);
  });

  test('語速、語氣只放在 speech_metadata.style，text 是逐字稿', () => {
    const body = buildTtsRequest({ model: 'gemini-3.8-flash-lite-tts', text: 'Hello there.', voice: 'Puck', style: TTS_STYLES.slow });
    expect(body).toEqual({
      model: 'gemini-3.8-flash-lite-tts',
      store: false,
      input: [{
        type: 'user_input',
        content: [{ type: 'text', text: 'Hello there.', annotations: [{ type: 'speech_metadata', style: TTS_STYLES.slow }] }],
      }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Puck' }] },
    });
    // 指示不會混進 text
    expect(body.input[0].content[0].text).not.toMatch(/slow|clearly/i);
    // 不認識的聲音退回預設
    expect(buildTtsRequest({ model: 'm', text: 'x', voice: 'Nope' }).generation_config.speech_config[0].voice).toBe(DEFAULT_VOICE);
    expect(() => buildTtsRequest({ text: 'x' })).toThrow();
  });

  test('cleanTtsText 拿掉像行內標籤的片段、壓縮空白、限制長度', () => {
    expect(cleanTtsText('Hi <short pause>  there\n\n<b>you</b>')).toBe('Hi there you</b>');
    expect(cleanTtsText('a'.repeat(MAX_TTS_CHARS + 50))).toHaveLength(MAX_TTS_CHARS);
  });

  test('取出最後一段音訊；用量依 modality 分開', () => {
    const json = {
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
        { type: 'model_output', content: [{ type: 'audio', data: 'AAA', mime_type: 'audio/wav' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'note' }, { type: 'audio', data: 'BBB', mime_type: 'audio/wav' }] },
      ],
      usage: {
        total_input_tokens: 12,
        total_output_tokens: 250,
        total_thought_tokens: 3,
        input_tokens_by_modality: [{ modality: 'text', tokens: 12 }],
        output_tokens_by_modality: [{ modality: 'audio', tokens: 250 }],
      },
    };
    const r = parseTtsResponse(json);
    expect(r.data).toBe('BBB');
    expect(r.mimeType).toBe('audio/wav');
    expect(r.usage).toEqual({ input: { text: 12, audio: 0, image: 0 }, output: { text: 3, audio: 250, image: 0 } });
    expect(parseTtsResponse({ steps: [] })).toBeNull();
    expect(parseTtsResponse(null)).toBeNull();
    // 沒有分 modality 時：輸入算文字、輸出算音訊
    expect(usageFromInteraction({ total_input_tokens: 5, total_output_tokens: 100 }))
      .toEqual({ input: { text: 5, audio: 0, image: 0 }, output: { text: 0, audio: 100, image: 0 } });
  });

  test('費用以計價表的多模態價格計算', () => {
    const cost = computeModalityCostUSD('gemini-3.8-flash-lite-tts', { input: { text: 1_000_000 }, output: { audio: 1_000_000 } });
    expect(typeof cost).toBe('number');
    expect(cost).toBeGreaterThan(0);
  });

  test('synthesize：金鑰放 x-goog-api-key header，不放網址', async () => {
    const calls = [];
    const fetcher = async (url, body, opts) => {
      calls.push({ url, body, opts });
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'UklGRg==' }] }] }), { status: 200 });
    };
    const r = await synthesize({ apiKey: 'K123', model: 'gemini-3.8-flash-lite-tts', text: 'Hi', fetcher });
    expect(r.data).toBe('UklGRg==');
    expect(r.mimeType).toBe('audio/wav');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TTS_ENDPOINT);
    expect(calls[0].url).not.toContain('K123');
    expect(calls[0].opts.headers).toEqual({ 'x-goog-api-key': 'K123' });
    expect(calls[0].body.store).toBe(false);
  });

  test('synthesize：錯誤碼 apiKeyMissing / forkTtsHttp / forkTtsNoAudio', async () => {
    await expect(synthesize({ apiKey: '', model: 'm', text: 'x', fetcher: async () => { throw new Error('no'); } }))
      .rejects.toMatchObject({ skCode: 'apiKeyMissing' });
    const bad = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
    await expect(synthesize({ apiKey: 'k', model: 'm', text: 'x', fetcher: bad }))
      .rejects.toMatchObject({ skCode: 'forkTtsHttp', skParams: { status: 400, detail: 'API key not valid' } });
    const empty = async () => new Response(JSON.stringify({ steps: [] }), { status: 200 });
    await expect(synthesize({ apiKey: 'k', model: 'm', text: 'x', fetcher: empty }))
      .rejects.toMatchObject({ skCode: 'forkTtsNoAudio' });
  });
});

describe('朗讀音訊快取（LRU）', () => {
  test('key 隨模型、聲音、播放模式、文字改變', async () => {
    const base = { model: 'a', voice: 'Kore', style: TTS_STYLES.normal, text: 'hi' };
    const k = await ttsCacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(await ttsCacheKey({ ...base })).toBe(k);
    for (const change of [{ model: 'b' }, { voice: 'Puck' }, { style: TTS_STYLES.slow }, { text: 'hi!' }]) {
      expect(await ttsCacheKey({ ...base, ...change })).not.toBe(k);
    }
  });

  test(`最多保留 ${TTS_CACHE_MAX} 段，淘汰最久沒用的`, async () => {
    let clock = 1000;
    const cache = createAudioCache({ backend: createMemoryBackend(), now: () => clock });
    for (let i = 0; i < TTS_CACHE_MAX; i++) {
      clock += 1;
      await cache.put(`k${i}`, { data: `d${i}`, mimeType: 'audio/wav' });
    }
    expect(await cache.size()).toBe(TTS_CACHE_MAX);
    clock += 1;
    expect(await cache.get('k0')).toEqual({ data: 'd0', mimeType: 'audio/wav' }); // 用過 → 變成最新
    clock += 1;
    await cache.put('new', { data: 'n', mimeType: 'audio/wav' });
    expect(await cache.size()).toBe(TTS_CACHE_MAX);
    expect(await cache.get('k0')).not.toBeNull();
    expect(await cache.get('k1')).toBeNull(); // 最久沒用的被淘汰
    expect(await cache.get('new')).not.toBeNull();
    await cache.clear();
    expect(await cache.size()).toBe(0);
  });

  test('同一毫秒內的操作也分得出先後', async () => {
    const cache = createAudioCache({ backend: createMemoryBackend(), max: 2, now: () => 5 });
    await cache.put('a', { data: '1' });
    await cache.put('b', { data: '2' });
    await cache.get('a');
    await cache.put('c', { data: '3' });
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).not.toBeNull();
  });
});
