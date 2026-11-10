// 第 2 階段：背景端劃詞卡片 handler（朗讀分流、AI 閱讀卡請求、右鍵選單）
// 這裡沒有 IndexedDB：音訊快取與用量紀錄寫入失敗只記 log，不影響回應（快取命中由 e2e 驗證）。
import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { createFakeStorage } from '../helpers/fake-storage.mjs';
import { jsonResponse, headerOf } from '../helpers/mock-fetch.mjs';
import { mergeForkSettings } from '../../shinkansen/fork/settings/schema.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const storage = createFakeStorage({
  sync: { targetLanguage: 'zh-TW', geminiConfig: { model: 'gemini-3.8-flash' } },
  local: {
    apiKey: 'TEST-KEY',
    fixedGlossary: { global: [{ source: 'motion', target: '動議' }], byDomain: {} },
    forbiddenTerms: [{ forbidden: '視頻', replacement: '影片' }],
    forkPronunciations: [{ term: 'GIF', mode: 'ipa', value: 'dʒɪf' }, { term: 'SQL', mode: 'respell', value: 'sequel' }],
    forkExplainPrompt: 'Prefer business examples.',
  },
});
const changeListeners = [];
const menus = { items: [], removeAll: jest.fn(async () => { menus.items = []; }), create: jest.fn((p, cb) => { menus.items.push(p); cb?.(); }) };
const sentToTabs = [];
globalThis.chrome = {
  storage: { ...storage, onChanged: { addListener: (fn) => changeListeners.push(fn) } },
  runtime: { lastError: undefined },
  i18n: { getMessage: (name) => ({ ctxTranslateSelection: '翻譯「%s」' }[name] || '') },
  contextMenus: menus,
  tabs: { sendMessage: async (id, msg, opts) => { sentToTabs.push({ id, msg, opts }); } },
};

const { createStudyHandlers, setupContextMenus, onContextMenuClicked, MENU_IDS } = await import('../../shinkansen/fork/bg/study.js');

async function setLocal(patch) {
  const before = await storage.local.get(Object.keys(patch));
  await storage.local.set(patch);
  const changes = Object.fromEntries(Object.keys(patch).map((k) => [k, { oldValue: before[k], newValue: patch[k] }]));
  for (const fn of changeListeners) fn(changes, 'local');
}

function makeHandlers(forkOverrides = {}, internals = {}) {
  const logs = [];
  const h = createStudyHandlers({
    readFork: async () => mergeForkSettings(forkOverrides),
    getInternals: () => internals,
    log: (level, msg, data) => logs.push({ level, msg, data }),
  });
  return { h, logs };
}

const realFetch = globalThis.fetch;
let calls = [];
function stubFetch(respond) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return respond(String(url), init);
  };
}
afterAll(() => { globalThis.fetch = realFetch; delete globalThis.chrome; });

const sender = { tab: { id: 7, url: 'https://news.example/a', title: 'A' } };

describe('FORK_TTS', () => {
  afterEach(async () => { await setLocal({ apiKey: 'TEST-KEY' }); });

  test('有金鑰：送 Interactions API，讀音表套用 IPA 與拼讀，style 不進 text', async () => {
    stubFetch(() => jsonResponse({
      steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'UklGRiQ=', mime_type: 'audio/wav' }] }],
      usage: { total_input_tokens: 10, total_output_tokens: 200 },
    }));
    const { h } = makeHandlers();
    const r = await h.FORK_TTS({ text: 'A GIF  in SQL', mode: 'slow' }, sender);
    expect(r).toEqual({ engine: 'gemini', cached: false, audio: 'UklGRiQ=', mimeType: 'audio/wav', mode: 'slow' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(headerOf(calls[0].init, 'x-goog-api-key')).toBe('TEST-KEY');
    expect(calls[0].url).not.toContain('TEST-KEY');
    const content = calls[0].body.input[0].content[0];
    expect(content.text).toBe('A /dʒɪf/ in sequel');
    expect(content.annotations[0].style).toMatch(/slowly/i);
    expect(calls[0].body.model).toBe('gemini-3.8-flash-lite-tts');
    expect(calls[0].body.store).toBe(false);
  });

  test('可以切換成 Flash TTS 與其他聲音', async () => {
    stubFetch(() => jsonResponse({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'QQ==' }] }] }));
    const { h } = makeHandlers({ tts: { model: 'gemini-3.8-flash-tts', voice: 'Puck' } });
    await h.FORK_TTS({ text: 'hello' }, sender);
    expect(calls[0].body.model).toBe('gemini-3.8-flash-tts');
    expect(calls[0].body.generation_config.speech_config[0].voice).toBe('Puck');
  });

  test('沒有金鑰：退回瀏覽器語音，只套用拼讀，不發請求', async () => {
    await setLocal({ apiKey: '' });
    stubFetch(() => { throw new Error('should not fetch'); });
    const { h } = makeHandlers();
    const r = await h.FORK_TTS({ text: 'A GIF in SQL' }, sender);
    expect(r).toEqual({ engine: 'browser', text: 'A GIF in sequel', mode: 'normal', reason: 'noKey' });
    expect(calls).toHaveLength(0);
  });

  test('設定指定瀏覽器語音時，即使有金鑰也不發請求', async () => {
    stubFetch(() => { throw new Error('should not fetch'); });
    const { h } = makeHandlers({ tts: { engine: 'browser' } });
    expect(await h.FORK_TTS({ text: 'x' }, sender)).toMatchObject({ engine: 'browser', reason: 'setting' });
    expect(calls).toHaveLength(0);
  });

  test('指定 Gemini 但沒有金鑰 → apiKeyMissing；空文字 → forkTtsEmpty', async () => {
    await setLocal({ apiKey: '' });
    const { h } = makeHandlers({ tts: { engine: 'gemini' } });
    await expect(h.FORK_TTS({ text: 'x' }, sender)).rejects.toMatchObject({ skCode: 'apiKeyMissing' });
    await expect(h.FORK_TTS({ text: '  <short pause> ' }, sender)).rejects.toMatchObject({ skCode: 'forkTtsEmpty' });
  });

  test('HTTP 錯誤帶狀態碼與 API 訊息', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'API key not valid' } }, { status: 400 }));
    const { h } = makeHandlers();
    await expect(h.FORK_TTS({ text: 'x' }, sender)).rejects.toMatchObject({ skCode: 'forkTtsHttp', skParams: { status: 400 } });
  });
});

describe('FORK_EXPLAIN', () => {
  const CARD = {
    translation: '擱置動議', meaning: '延後討論', pronunciation: { ipa: 'ˈteɪbəl', stress: 'TA-ble' },
    structure: [{ text: 'table', role: 'verb', note: '擱置' }, { text: 'the motion', role: 'object', note: '' }],
    usage: '', examples: [{ source: 'They tabled it.', translation: '他們擱置了。' }], citations: ['will table the motion'],
  };
  const CONTEXT = 'The committee will table the motion until next week.';
  const reply = (obj) => jsonResponse({
    candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: JSON.stringify(obj) }] } }],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 120, totalTokenCount: 420 },
  });

  test('第一輪：generateContent、金鑰走 header、附段落上下文、術語表與禁用詞、自訂指示', async () => {
    stubFetch(() => reply(CARD));
    const buildFixedGlossaryEntries = jest.fn((fg) => fg.global);
    const { h } = makeHandlers({}, { buildFixedGlossaryEntries });
    const r = await h.FORK_EXPLAIN({ text: 'table the motion', context: CONTEXT, title: 'Minutes', sourceLang: 'en' }, sender);
    expect(r.model).toBe('gemini-3.8-flash');
    expect(r.card).toMatchObject({ translation: '擱置動議', citations: ['will table the motion'] });
    expect(r.card.structure).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(headerOf(calls[0].init, 'x-goog-api-key')).toBe('TEST-KEY');
    const sys = calls[0].body.systemInstruction.parts[0].text;
    expect(sys).toContain('動議');
    expect(sys).toContain('視頻');
    expect(sys).toContain('Prefer business examples.');
    expect(sys).toMatch(/Traditional Chinese|繁體中文|台灣/);
    const user = calls[0].body.contents[0].parts[0].text;
    expect(user).toContain(`<context>\n${CONTEXT}\n</context>`);
    expect(user).toContain('<page_title>Minutes</page_title>');
    expect(user).not.toContain('news.example'); // 網址不送出
    expect(calls[0].body.generationConfig.responseMimeType).toBe('application/json');
    expect(buildFixedGlossaryEntries).toHaveBeenCalled();
  });

  test('追問：帶上第一輪卡片與歷史，回傳 answer', async () => {
    stubFetch(() => reply({ answer: '因為 table 在美式英文是「擱置」。', citations: ['until next week'] }));
    const { h } = makeHandlers({ explain: { model: 'gemini-3.8-flash-lite' } });
    const r = await h.FORK_EXPLAIN({
      text: 'table the motion', context: CONTEXT, card: CARD,
      history: [{ q: 'q1', a: 'a1' }, { bad: true }], question: '為什麼是 table？',
    }, sender);
    expect(r).toEqual({ answer: '因為 table 在美式英文是「擱置」。', citations: ['until next week'], model: 'gemini-3.8-flash-lite' });
    const contents = calls[0].body.contents;
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    expect(contents.at(-1).parts[0].text).toContain('為什麼是 table？');
    expect(calls[0].url).toContain('/models/gemini-3.8-flash-lite:generateContent');
  });

  test('回應不是 JSON 時回傳 raw；空回應與 HTTP 錯誤有錯誤碼', async () => {
    stubFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: 'just prose' }] } }] }));
    const { h } = makeHandlers();
    expect(await h.FORK_EXPLAIN({ text: 'x' }, sender)).toEqual({ raw: 'just prose', model: 'gemini-3.8-flash' });

    stubFetch(() => jsonResponse({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }));
    await expect(h.FORK_EXPLAIN({ text: 'x' }, sender)).rejects.toMatchObject({ skCode: 'forkExplainEmpty', skParams: { reason: 'SAFETY' } });

    stubFetch(() => jsonResponse({ error: { message: 'quota' } }, { status: 403 }));
    await expect(h.FORK_EXPLAIN({ text: 'x' }, sender)).rejects.toMatchObject({ skCode: 'forkExplainHttp', skParams: { status: 403, detail: 'quota' } });

    await expect(h.FORK_EXPLAIN({ text: 'x', question: 'q' }, sender)).rejects.toMatchObject({ skCode: 'forkExplainEmpty' });
  });

  test('沒有金鑰 → apiKeyMissing', async () => {
    await setLocal({ apiKey: '' });
    const { h } = makeHandlers();
    await expect(h.FORK_EXPLAIN({ text: 'x' }, sender)).rejects.toMatchObject({ skCode: 'apiKeyMissing' });
    await setLocal({ apiKey: 'TEST-KEY' });
  });
});

describe('右鍵選單', () => {
  test('開啟時建立三個項目，關閉時全部移除', async () => {
    await setupContextMenus(true);
    expect(menus.items.map((i) => i.id)).toEqual([MENU_IDS.selection, MENU_IDS.page, MENU_IDS.paragraph]);
    expect(menus.items[0]).toMatchObject({ title: '翻譯「%s」', contexts: ['selection'] });
    expect(menus.items[1].title).toBe('Translate page / show original'); // 沒有 _locales 字串時的備援
    await setupContextMenus(false);
    expect(menus.items).toEqual([]);
  });

  test('點擊分派到對應的 frame；翻譯整頁走 Alt+S 同一條路徑', async () => {
    sentToTabs.length = 0;
    onContextMenuClicked({ menuItemId: MENU_IDS.selection, selectionText: 'hello', frameId: 3 }, { id: 9 });
    onContextMenuClicked({ menuItemId: MENU_IDS.page, frameId: 3 }, { id: 9 });
    onContextMenuClicked({ menuItemId: MENU_IDS.paragraph, frameId: 0 }, { id: 9 });
    onContextMenuClicked({ menuItemId: MENU_IDS.paragraph }, {}); // 沒有分頁 → 不處理
    await Promise.resolve();
    expect(sentToTabs).toEqual([
      { id: 9, msg: { type: 'FORK_CARD_OPEN', payload: { text: 'hello' } }, opts: { frameId: 3 } },
      { id: 9, msg: { type: 'TRANSLATE_PRESET', payload: { slot: 2 } }, opts: undefined },
      { id: 9, msg: { type: 'FORK_RESTORE_PARAGRAPH' }, opts: { frameId: 0 } },
    ]);
  });
});
