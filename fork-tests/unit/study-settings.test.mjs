// 第 2 階段：劃詞卡片設定、content script 副本一致、學習中心資料、雙向翻譯
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  FORK_DEFAULTS, mergeForkSettings, sanitizeForkSettings, sanitizeExplainPrompt, MAX_EXPLAIN_PROMPT,
} from '../../shinkansen/fork/settings/schema.js';
import { sanitizeLearnItem, normalizeKey } from '../../shinkansen/fork/learn/store.js';
import { createMtBatchHandler, mtCacheSuffix } from '../../shinkansen/fork/bg/mt-batch.js';
import { forkRoutes } from '../../shinkansen/fork/bg/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('劃詞卡片設定', () => {
  test('預設值：選取文字後出現小按鈕、朗讀自動選引擎、Flash-Lite TTS、懸停停留時間與上游相同', () => {
    expect(FORK_DEFAULTS.study).toEqual({
      trigger: 'select', selectMode: 'icon', modifierKey: 'alt', longPressMs: 500,
      engine: 'preset', bidirectional: false, secondLang: 'en', contextMenu: true,
    });
    expect(FORK_DEFAULTS.tts).toEqual({ engine: 'auto', model: 'gemini-3.8-flash-lite-tts', voice: 'Kore' });
    expect(FORK_DEFAULTS.explain).toEqual({ model: '', contextScope: 'paragraph' });
    // content-hover.js 原本固定 150 ms；預設不變
    expect(FORK_DEFAULTS.paragraph.hoverRestMs).toBe(150);
    expect(FORK_DEFAULTS.paragraph.copyShortcut).toEqual({ code: 'KeyC', alt: true, shift: false, ctrl: false, meta: false });
  });

  test('消毒：不合法的列舉值、模型、引擎、快速鍵回報警告並用預設', () => {
    const { clean, warnings } = sanitizeForkSettings({
      study: { trigger: 'hover', selectMode: 'x', modifierKey: 'meta', longPressMs: 50, engine: '<x>', bidirectional: 'yes', secondLang: 'auto' },
      tts: { engine: 'cloud', model: 'gemini-9-tts', voice: 'Bob' },
      explain: { model: 'bad model!', contextScope: 'page' },
      paragraph: { hoverRestMs: 99999, copyShortcut: { code: 'KeyC' } },
    });
    // 數值超出範圍時夾到邊界（與上游數值欄位相同做法）
    expect(clean.study.longPressMs).toBe(250);
    expect(clean.paragraph.hoverRestMs).toBe(2000);
    expect({ ...clean.study, longPressMs: 500 }).toEqual(FORK_DEFAULTS.study);
    expect(clean.tts).toEqual(FORK_DEFAULTS.tts);
    expect(clean.explain).toEqual(FORK_DEFAULTS.explain);
    expect(clean.paragraph.copyShortcut).toEqual(FORK_DEFAULTS.paragraph.copyShortcut);
    expect(warnings).toEqual(expect.arrayContaining([
      'study.trigger', 'study.selectMode', 'study.modifierKey', 'study.engine', 'study.secondLang',
      'tts.engine', 'tts.model', 'tts.voice', 'explain.model', 'explain.contextScope', 'paragraph.copyShortcut',
    ]));
  });

  test('消毒：接受合法值（MT 引擎、額外服務、Flash TTS、關閉快速鍵）', () => {
    const { clean, warnings } = sanitizeForkSettings({
      study: { trigger: 'middle', selectMode: 'card', modifierKey: 'shift', longPressMs: 800, engine: 'fork-cp:p1', bidirectional: true, secondLang: 'ja', contextMenu: false },
      tts: { engine: 'browser', model: 'gemini-3.8-flash-tts', voice: 'Puck' },
      explain: { model: 'gemini-3.8-flash-lite', contextScope: 'nearby' },
      paragraph: { hoverRestMs: 300, copyShortcut: null },
    });
    expect(warnings).toEqual([]);
    expect(clean.study).toEqual({ trigger: 'middle', selectMode: 'card', modifierKey: 'shift', longPressMs: 800, engine: 'fork-cp:p1', bidirectional: true, secondLang: 'ja', contextMenu: false });
    expect(clean.tts).toEqual({ engine: 'browser', model: 'gemini-3.8-flash-tts', voice: 'Puck' });
    expect(clean.explain).toEqual({ model: 'gemini-3.8-flash-lite', contextScope: 'nearby' });
    expect(clean.paragraph).toEqual({ hoverRestMs: 300, copyShortcut: null });
    for (const e of ['preset', 'gemini', 'custom', 'deepl', 'microsoft-edge', 'chrome-translator']) {
      expect(sanitizeForkSettings({ study: { engine: e } }).clean.study.engine).toBe(e);
    }
    // 單鍵（沒有 Alt / Ctrl / ⌘）會干擾打字，不接受；只有 Shift 也不行
    expect(sanitizeForkSettings({ paragraph: { copyShortcut: { code: 'KeyC', shift: true } } }).warnings).toEqual(['paragraph.copyShortcut']);
    expect(sanitizeExplainPrompt('x'.repeat(MAX_EXPLAIN_PROMPT + 9))).toHaveLength(MAX_EXPLAIN_PROMPT);
    expect(sanitizeExplainPrompt(5)).toBe('');
  });

  test('舊版設定（沒有第 2 階段欄位）合併後得到預設值', () => {
    const merged = mergeForkSettings({ presetEngines: { 1: 'deepl' } });
    expect(merged.study).toEqual(FORK_DEFAULTS.study);
    expect(merged.tts).toEqual(FORK_DEFAULTS.tts);
    expect(merged.paragraph).toEqual(FORK_DEFAULTS.paragraph);
  });
});

describe('content script 副本與 schema 一致（mirror）', () => {
  function loadContent(files, { storageFork } = {}) {
    const dom = new JSDOM('<!doctype html><html><body><p id="p">Hello world.</p></body></html>', { runScripts: 'outside-only', url: 'https://example.test/' });
    const win = dom.window;
    win.__SK = { STATE: {}, t: (k) => k };
    win.browser = {
      storage: { sync: { get: async () => ({ fork: storageFork }) }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} }, getURL: (p) => `chrome-extension://x/${p}` },
      i18n: { detectLanguage: async () => ({ languages: [] }) },
    };
    for (const f of files) win.eval(fs.readFileSync(path.join(ROOT, 'shinkansen', f), 'utf8'));
    return win;
  }

  test('study-card.js 的預設值與 FORK_DEFAULTS 相同', () => {
    const win = loadContent(['fork/content/study-card.js']);
    const d = JSON.parse(JSON.stringify(win.__SK._forkStudyDefaults));
    const { contextMenu, ...studyNoMenu } = FORK_DEFAULTS.study; // 右鍵選單由背景端處理
    expect(contextMenu).toBe(true);
    expect(d.study).toEqual(studyNoMenu);
    expect(d.explain.contextScope).toBe(FORK_DEFAULTS.explain.contextScope);
  });

  test('paragraph-tools.js 的懸停停留時間預設與 FORK_DEFAULTS 相同，並套用設定', async () => {
    const win = loadContent(['fork/content/paragraph-tools.js']);
    expect(win.__SK.forkHoverRestMs()).toBe(FORK_DEFAULTS.paragraph.hoverRestMs);
    const win2 = loadContent(['fork/content/paragraph-tools.js'], { storageFork: { paragraph: { hoverRestMs: 400 } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(win2.__SK.forkHoverRestMs()).toBe(400);
  });

  test('content-hover.js 透過掛鉤讀停留時間，掛鉤不存在時仍是 150 ms', () => {
    const src = fs.readFileSync(path.join(ROOT, 'shinkansen/content-hover.js'), 'utf8');
    expect(src).toMatch(/typeof SK\.forkHoverRestMs === 'function' \? SK\.forkHoverRestMs\(\) : REST_MS/);
    expect(src).toMatch(/const REST_MS = 150;/);
  });
});

describe('學習中心資料', () => {
  test('只收已知欄位，網址只留 http(s)，同一段文字的 key 相同', () => {
    const item = sanitizeLearnItem({
      text: '  table the motion ', translation: '擱置動議', lang: 'en', context: 'ctx', url: 'javascript:alert(1)', title: 'T',
      card: { translation: 'x' }, evil: 1,
    }, 1000);
    expect(item).toEqual({
      key: 'table the motion', text: 'table the motion', translation: '擱置動議', lang: 'en', context: 'ctx', url: '', title: 'T',
      createdAt: 1000, updatedAt: 1000, card: { translation: 'x' },
    });
    expect(sanitizeLearnItem({ text: 'x', url: 'https://a.test/p' }).url).toBe('https://a.test/p');
    expect(sanitizeLearnItem({ text: '   ' })).toBeNull();
    expect(normalizeKey('Table   THE\nmotion')).toBe(normalizeKey('table the motion'));
    // 太大的卡片不存
    expect(sanitizeLearnItem({ text: 'x', card: { big: 'y'.repeat(30_000) } })).not.toHaveProperty('card');
  });
});

describe('雙向翻譯（payload.forkTarget）', () => {
  function makeHandler() {
    const seen = [];
    const store = new Map();
    const handler = createMtBatchHandler({
      registry: { translateWith: async (id, texts, { target, cfg }) => { seen.push({ id, target, source: cfg.sourceLang }); return { translations: texts.map((t) => `${target}:${t}`), chars: 1 }; } },
      cache: {
        getBatch: async (texts, suffix) => texts.map((t) => store.get(t + suffix) ?? null),
        setBatch: async (texts, results, suffix) => texts.forEach((t, i) => store.set(t + suffix, results[i])),
      },
      logUsage: async () => {},
      getTarget: async () => 'zh-TW',
      readFork: async () => mergeForkSettings({ mt: { sourceLang: 'ja' } }),
      readSecrets: async () => ({}),
    });
    return { handler, seen, store };
  }

  test('forkTarget 覆蓋目標語言、來源改自動偵測，快取分區', async () => {
    const { handler, seen } = makeHandler();
    expect((await handler({ mtEngine: 'deepl', texts: ['你好'], forkTarget: 'en' })).result).toEqual(['en:你好']);
    expect((await handler({ mtEngine: 'deepl', texts: ['你好'] })).result).toEqual(['zh-TW:你好']);
    expect(seen).toEqual([{ id: 'deepl', target: 'en', source: 'auto' }, { id: 'deepl', target: 'zh-TW', source: 'ja' }]);
    expect(mtCacheSuffix('deepl', 'en', 'auto')).not.toBe(mtCacheSuffix('deepl', 'zh-TW', 'ja'));
    // 不合法的 forkTarget 忽略
    expect((await handler({ mtEngine: 'deepl', texts: ['b'], forkTarget: 'xx' })).result).toEqual(['zh-TW:b']);
  });

  test('只有帶合法 forkTarget 的 Google 請求才改走驛傳路徑（其他 Google 請求維持上游行為）', () => {
    expect(forkRoutes.isMtPayload({ mtEngine: 'google' })).toBe(false);
    expect(forkRoutes.isMtPayload({ mtEngine: 'google', forkTarget: 'en' })).toBe(true);
    expect(forkRoutes.isMtPayload({ mtEngine: 'google', forkTarget: 'xx' })).toBe(false);
    expect(forkRoutes.isMtPayload({ mtEngine: 'deepl' })).toBe(true);
    expect(forkRoutes.isMtPayload({})).toBe(false);
  });
});
