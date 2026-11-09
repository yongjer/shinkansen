// Chrome 內建翻譯（Translator API）只能在頁面環境執行，實作在 content script。
// 這裡用 vm 載入 ekiden-content.js，以假的 Translator / LanguageDetector 驗證行為。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'shinkansen/fork/content/ekiden-content.js'), 'utf8');

function load({ translator, detector, forkSync = {}, pageLang = 'en', target = 'zh-TW' } = {}) {
  const SK = { STATE: { targetLanguage: target } };
  const sent = [];
  const self = {};
  if (translator) self.Translator = translator;
  if (detector) self.LanguageDetector = detector;
  const context = vm.createContext({
    window: { __SK: SK },
    self,
    document: { documentElement: { lang: pageLang } },
    browser: {
      storage: { sync: { get: async () => ({ fork: forkSync }) } },
      runtime: { sendMessage: async (m) => { sent.push(m); return {}; } },
    },
    console,
  });
  vm.runInContext(SRC, context);
  return { SK, sent };
}

// 假的 Translator：記錄建立了哪些語言組合；譯文 = [來源>目標] 原文
function fakeTranslator({ unavailable = [], failOn = null } = {}) {
  const created = [];
  return {
    created,
    availability: async ({ sourceLanguage, targetLanguage }) => (
      unavailable.includes(`${sourceLanguage}>${targetLanguage}`) ? 'unavailable' : 'available'),
    create: async ({ sourceLanguage, targetLanguage }) => {
      created.push(`${sourceLanguage}>${targetLanguage}`);
      return {
        translate: async (text) => {
          if (failOn && text === failOn) throw new Error('model crashed');
          return `[${sourceLanguage}>${targetLanguage}] ${text}`;
        },
      };
    },
  };
}

function fakeDetector(map) {
  return {
    availability: async () => 'available',
    create: async () => ({
      detect: async (text) => [map[text] || { detectedLanguage: 'und', confidence: 0 }],
    }),
  };
}

const msg = (texts, mtEngine = 'chrome-translator') => ({ type: 'TRANSLATE_BATCH_GOOGLE', payload: { texts, mtEngine } });

describe('Chrome 內建翻譯（content script）', () => {
  test('不是 chrome-translator 的批次不接手，照常送背景', () => {
    const { SK } = load({ translator: fakeTranslator() });
    expect(SK.forkInterceptMt(msg(['a'], 'deepl'))).toBeUndefined();
    expect(SK.forkInterceptMt({ type: 'TRANSLATE_BATCH_GOOGLE', payload: { texts: ['a'] } })).toBeUndefined();
  });

  test('瀏覽器沒有 Translator API → forkCtUnavailable', async () => {
    const { SK, sent } = load({});
    const r = await SK.forkInterceptMt(msg(['Hello']));
    expect(r).toMatchObject({ ok: false, errorCode: 'forkCtUnavailable' });
    expect(sent).toEqual([]);
  });

  test('逐段偵測來源語言；已是目標語言的段落原樣保留；同一組語言只建立一次；以字元數記用量', async () => {
    const translator = fakeTranslator();
    const { SK, sent } = load({
      translator,
      detector: fakeDetector({
        Hello: { detectedLanguage: 'en', confidence: 0.9 },
        World: { detectedLanguage: 'en', confidence: 0.95 },
        こんにちは: { detectedLanguage: 'ja', confidence: 0.99 },
        已是中文: { detectedLanguage: 'zh-Hant', confidence: 0.9 },
      }),
    });
    const r = await SK.forkInterceptMt(msg(['Hello', 'World', 'こんにちは', '已是中文']));
    expect(r.ok).toBe(true);
    expect(r.result).toEqual(['[en>zh-Hant] Hello', '[en>zh-Hant] World', '[ja>zh-Hant] こんにちは', '已是中文']);
    expect(translator.created).toEqual(['en>zh-Hant', 'ja>zh-Hant']);
    expect(r.usage).toEqual({ engine: 'chrome-translator', chars: 5 + 5 + 5 + 4, cacheHits: 0 });
    expect(sent).toEqual([expect.objectContaining({
      type: 'FORK_LOG_CHAR_USAGE',
      payload: expect.objectContaining({ engine: 'chrome-translator', chars: 19, segments: 4 }),
    })]);
  });

  test('偵測信心不足時退回頁面語言；目標語言跟隨上游設定（zh-CN → zh）', async () => {
    const { SK } = load({
      translator: fakeTranslator(),
      detector: fakeDetector({ Bonjour: { detectedLanguage: 'fr', confidence: 0.2 } }),
      pageLang: 'de-DE',
      target: 'zh-CN',
    });
    const r = await SK.forkInterceptMt(msg(['Bonjour']));
    expect(r.result).toEqual(['[de>zh] Bonjour']);
  });

  test('設定了固定來源語言就不偵測', async () => {
    let detectCalls = 0;
    const detect = async () => { detectCalls += 1; return []; };
    const { SK } = load({
      translator: fakeTranslator(),
      detector: { availability: async () => 'available', create: async () => ({ detect }) },
      forkSync: { mt: { sourceLang: 'ja' } },
    });
    const r = await SK.forkInterceptMt(msg(['テスト']));
    expect(r.result).toEqual(['[ja>zh-Hant] テスト']);
    expect(detectCalls).toBe(0);
  });

  test('不支援的語言組合 → forkCtUnsupportedPair，且不留下失敗的快取（下次會重新檢查）', async () => {
    const translator = fakeTranslator({ unavailable: ['ko>zh-Hant'] });
    const { SK } = load({ translator, forkSync: { mt: { sourceLang: 'ko' } } });
    const r1 = await SK.forkInterceptMt(msg(['안녕']));
    expect(r1).toMatchObject({ ok: false, errorCode: 'forkCtUnsupportedPair', errorParams: { source: 'ko', target: 'zh-Hant' } });
    translator.availability = async () => 'downloadable';
    const r2 = await SK.forkInterceptMt(msg(['안녕']));
    expect(r2.ok).toBe(true);
  });

  test('需要下載模型但沒有使用者操作（create 被拒）→ forkCtNeedsDownload；其他建立錯誤 → forkCtFailed', async () => {
    const translator = fakeTranslator();
    translator.availability = async () => 'downloadable';
    translator.create = async () => {
      const e = new Error('Requires a user gesture when availability is "downloadable"');
      e.name = 'NotAllowedError';
      throw e;
    };
    const { SK } = load({ translator, forkSync: { mt: { sourceLang: 'en' } } });
    const r = await SK.forkInterceptMt(msg(['Hello']));
    expect(r).toMatchObject({ ok: false, errorCode: 'forkCtNeedsDownload', errorParams: { source: 'en', target: 'zh-Hant' } });

    translator.create = async () => { throw new Error('quota exceeded'); };
    const r2 = await SK.forkInterceptMt(msg(['Hello']));
    expect(r2).toMatchObject({ ok: false, errorCode: 'forkCtFailed', errorParams: { detail: 'quota exceeded' } });
  });

  test('翻譯過程出錯 → forkCtFailed 並帶原因；不記用量', async () => {
    const { SK, sent } = load({ translator: fakeTranslator({ failOn: 'boom' }), forkSync: { mt: { sourceLang: 'en' } } });
    const r = await SK.forkInterceptMt(msg(['ok', 'boom']));
    expect(r).toMatchObject({ ok: false, errorCode: 'forkCtFailed', errorParams: { detail: 'model crashed' } });
    expect(sent).toEqual([]);
  });
});
