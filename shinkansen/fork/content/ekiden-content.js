// fork/content/ekiden-content.js — 驛傳（Ekiden）content script 入口
//
// 排在 manifest content_scripts 清單最後，透過 window.__SK 與上游共用命名空間。
// 提供給上游掛鉤點呼叫的函式（掛鉤清單見 docs/FORK-NOTES.md §4）：
//   SK.forkResolvePreset(slot, upstreamEngine)  某組翻譯預設要改用的引擎
//   SK.forkInterceptMt(message)                  Chrome 內建翻譯在頁面內執行（背景端不能用）
//   SK.forkMtName(id)                            機器翻譯 toast 顯示的引擎名稱
//   SK.t 包一層：Google MT toast 帶 engine 參數時改用驛傳字串
//
// 只在 Chrome 內建翻譯被選用時才會碰到 Translator API；其他情況本檔不做任何事。

(function (SK) {
  'use strict';
  if (!SK || SK.__ekidenContentLoaded) return;
  SK.__ekidenContentLoaded = true;

  // 字串表在 fork/i18n/fork-strings.js（manifest 排在本檔之前）
  const ENGINE_NAMES = {
    google: 'Google',
    'microsoft-edge': 'Microsoft',
    azure: 'Azure Translator',
    deepl: 'DeepL',
    deeplx: 'DeepLX',
    'chrome-translator': 'Chrome',
    'free-chain': '', // 依介面語言顯示，見 forkMtName
  };
  const MT_IDS = Object.keys(ENGINE_NAMES);
  const PROVIDER_PREFIX = 'fork-cp:';

  // ── 翻譯預設對應（規則與 fork/settings/schema.js resolvePresetSelection 相同，
  //    content script 不能 import ES module，兩份由 fork-tests 的 mirror 測試鎖住）──
  function resolvePresetSelection(fork, slot, upstreamEngine) {
    const v = (fork && fork.presetEngines && fork.presetEngines[String(slot)]) || '';
    if (!v) return {};
    if (upstreamEngine === 'google') {
      return MT_IDS.includes(v) && v !== 'google' ? { mtEngine: v } : {};
    }
    if (upstreamEngine === 'openai-compat') {
      const p = ((fork && fork.providers) || []).find((x) => x && x.id === v);
      return p ? { modelOverride: PROVIDER_PREFIX + p.id, providerLabel: p.label } : {};
    }
    return {};
  }
  SK._forkResolvePresetSelection = resolvePresetSelection; // 測試用

  SK.forkResolvePreset = async function forkResolvePreset(slot, upstreamEngine) {
    try {
      const r = await browser.storage.sync.get('fork');
      return resolvePresetSelection(r && r.fork, slot, upstreamEngine);
    } catch (_) {
      return {};
    }
  };

  // ── 機器翻譯 toast：上游字串寫死「Google」，換成實際引擎名稱 ──────────
  // content.js 的 Google MT toast 呼叫多帶 engine 參數（掛鉤點見 FORK-NOTES §4）。
  // engine 非空時改查驛傳的字串；上游原本的呼叫不帶 engine，結果與上游完全相同。
  const TOAST_KEYS = {
    'toast.translateProgressGoogle': 'fork.toast.mtProgress',
    'toast.googleDone': 'fork.toast.mtDone',
    'toast.googleDoneTruncated': 'fork.toast.mtDoneTruncated',
    'toast.googleFreeDetail': 'fork.toast.mtDetail',
  };
  if (typeof SK.t === 'function' && !SK.t.__ekidenWrapped) {
    const upstreamT = SK.t;
    const wrapped = function (key, params, target) {
      const forkKey = params && params.engine ? TOAST_KEYS[key] : null;
      return upstreamT(forkKey || key, params, target);
    };
    wrapped.__ekidenWrapped = true;
    SK.t = wrapped;
  }
  SK.forkMtName = (id) => {
    if (id === 'free-chain') {
      try { return SK.t('fork.engine.freeChain'); } catch (_) { return 'Free MT'; }
    }
    return ENGINE_NAMES[id] || '';
  };

  // ── Chrome 內建翻譯（Translator API；只能在頁面環境執行）─────────────
  const CHROME_LANG = { 'zh-TW': 'zh-Hant', 'zh-CN': 'zh', en: 'en', ja: 'ja', ko: 'ko', es: 'es', fr: 'fr', de: 'de' };
  const translators = new Map(); // 'src>tgt' → Promise<Translator>
  let detectorPromise = null;

  function ctError(code, params, message) {
    const err = new Error(message);
    err.skCode = code;
    err.skParams = params || null;
    return err;
  }

  function baseLang(tag) {
    const t = String(tag || '').toLowerCase();
    if (t.startsWith('zh-hant') || t === 'zh-tw' || t === 'zh-hk') return 'zh-Hant';
    if (t.startsWith('zh')) return 'zh';
    return t.split('-')[0];
  }

  async function getDetector() {
    if (typeof self.LanguageDetector === 'undefined') return null;
    if (!detectorPromise) {
      detectorPromise = (async () => {
        const a = await self.LanguageDetector.availability();
        if (a === 'unavailable') return null;
        return self.LanguageDetector.create();
      })().catch(() => null);
    }
    return detectorPromise;
  }

  async function detectSource(text, fallback) {
    const det = await getDetector();
    if (det) {
      try {
        const results = await det.detect(text);
        const top = results && results[0];
        if (top && top.detectedLanguage && top.detectedLanguage !== 'und' && top.confidence >= 0.5) {
          return baseLang(top.detectedLanguage);
        }
      } catch (_) { /* 退回頁面語言 */ }
    }
    return fallback;
  }

  async function getTranslator(source, target) {
    const key = source + '>' + target;
    if (!translators.has(key)) {
      translators.set(key, (async () => {
        const avail = await self.Translator.availability({ sourceLanguage: source, targetLanguage: target });
        if (avail === 'unavailable') {
          throw ctError('forkCtUnsupportedPair', { source, target }, `unsupported pair ${source} → ${target}`);
        }
        try {
          return await self.Translator.create({ sourceLanguage: source, targetLanguage: target });
        } catch (err) {
          // 模型還沒下載時，Chrome 要求使用者在頁面上操作才會開始下載；由瀏覽器快速鍵、
          // 工具列或自動翻譯觸發時沒有這個操作 → 提示到驛傳設定頁按「測試」下載
          if (avail !== 'available' && err && err.name === 'NotAllowedError') {
            throw ctError('forkCtNeedsDownload', { source, target }, 'language model download needs a user gesture');
          }
          throw ctError('forkCtFailed', { detail: String((err && err.message) || err).slice(0, 200) }, 'Chrome translator failed');
        }
      })());
      translators.get(key).catch(() => translators.delete(key));
    }
    return translators.get(key);
  }

  async function readSourceSetting() {
    try {
      const r = await browser.storage.sync.get('fork');
      const s = r && r.fork && r.fork.mt && r.fork.mt.sourceLang;
      return s && s !== 'auto' ? (CHROME_LANG[s] || '') : '';
    } catch (_) {
      return '';
    }
  }

  async function chromeTranslateBatch(texts) {
    if (typeof self.Translator === 'undefined') {
      throw ctError('forkCtUnavailable', null, 'Translator API unavailable');
    }
    const target = CHROME_LANG[(SK.STATE && SK.STATE.targetLanguage) || 'zh-TW'] || 'zh-Hant';
    const fixedSource = await readSourceSetting();
    const pageLang = baseLang(document.documentElement.lang || 'en') || 'en';
    const out = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const source = fixedSource || await detectSource(text, pageLang);
      if (baseLang(source) === baseLang(target)) {
        out[i] = text; // 已是目標語言
        continue;
      }
      const tr = await getTranslator(source, target);
      try {
        out[i] = await tr.translate(text);
      } catch (err) {
        throw ctError('forkCtFailed', { detail: String((err && err.message) || err).slice(0, 200) }, 'Chrome translator failed');
      }
    }
    return out;
  }

  // translateUnitsGoogle 送出每一批前先問這裡；回傳 Promise 代表已接手，undefined 代表照常送背景
  SK.forkInterceptMt = function forkInterceptMt(message) {
    const payload = message && message.payload;
    if (!payload || payload.mtEngine !== 'chrome-translator') return undefined;
    const texts = Array.isArray(payload.texts) ? payload.texts : [];
    const t0 = Date.now();
    return chromeTranslateBatch(texts).then((result) => {
      const chars = texts.reduce((n, t) => n + String(t).length, 0);
      browser.runtime.sendMessage({
        type: 'FORK_LOG_CHAR_USAGE',
        payload: { engine: 'chrome-translator', chars, segments: texts.length, durationMs: Date.now() - t0 },
      }).catch(() => {});
      return { ok: true, result, usage: { engine: 'chrome-translator', chars, cacheHits: 0 } };
    }, (err) => ({
      ok: false,
      error: (err && err.message) || String(err),
      errorCode: err && err.skCode,
      errorParams: err && err.skParams,
    }));
  };
})(window.__SK);
