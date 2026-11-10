// fork/bg/study.js — 劃詞卡片的背景端：朗讀（Gemini TTS）、AI 閱讀卡、加入學習中心、右鍵選單
//
// 訊息（content → 背景，由 fork/bg/index.js 的 FORK_ listener 分派）：
//   FORK_TTS          { text, mode: 'normal'|'slow' }
//                     → { engine: 'gemini', audio(base64 WAV), mimeType, cached } 或
//                       { engine: 'browser', text, lang }（沒有 Gemini 金鑰 / 設定用瀏覽器語音）
//   FORK_EXPLAIN      { text, context, title, sourceLang, question?, card?, history? }
//                     → { card } | { raw }（解析失敗時的原文字）| { answer, citations }（追問）
//   FORK_LEARN_SAVE   { text, translation, lang, context, card? } → { id, created }
//
// 卡片上的「翻譯」不經過這裡：content 端直接送上游既有的 TRANSLATE_BATCH / _GOOGLE / _CUSTOM，
// 沿用整頁翻譯的快取、術語表與用量紀錄。
//
// 所有 Gemini 請求的金鑰都放 x-goog-api-key header（lib/llm-common.js fetchWithRetry）。

import { browser } from '../../lib/compat.js';
import * as usageDB from '../../lib/usage-db.js';
import { getSettingsCached, LANG_LABELS } from '../../lib/storage.js';
import { fetchWithRetry } from '../../lib/llm-common.js';
import { pickThinkingConfig, parseGeminiUsage, buildTemperatureField, buildSamplingFields } from '../../lib/gemini.js';
import { buildEffectiveSystemInstruction } from '../../lib/system-instruction.js';
import { getPricingForModel, computeModalityCostUSD } from '../../lib/model-pricing.js';
import { computeBilling, geminiCachedRate } from '../../lib/billing.js';
import { codedError } from '../../lib/bg-error.js';
import { synthesize, cleanTtsText, TTS_STYLES } from '../tts/gemini-tts.js';
import { applyPronunciations, sanitizePronunciations, PRONUNCIATIONS_KEY } from '../tts/pronounce.js';
import { createAudioCache, createIdbBackend, ttsCacheKey } from '../tts/audio-cache.js';
import * as explain from '../explain/explain.js';
import { createLearnStore } from '../learn/store.js';
import { FORK_EXPLAIN_PROMPT_KEY, sanitizeExplainPrompt } from '../settings/schema.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const FALLBACK_EXPLAIN_MODEL = 'gemini-3.8-flash';

const sumModalities = (m) => Object.values(m || {}).reduce((a, b) => a + (Number(b) || 0), 0);

/**
 * @param {object} deps
 * @param {Function} deps.readFork
 * @param {Function} deps.getInternals  () => initFork 交進來的上游函式（buildFixedGlossaryEntries）
 * @param {Function} deps.log
 */
export function createStudyHandlers({ readFork, getInternals, log }) {
  let audioCache = null;
  let learn = null;
  const getAudioCache = () => (audioCache ||= createAudioCache({ backend: createIdbBackend() }));
  const getLearn = () => (learn ||= createLearnStore());

  async function logUsage(record) {
    try {
      await usageDB.logTranslation({ cachedTokens: 0, segments: 1, cacheHits: 0, timestamp: Date.now(), ...record });
    } catch (err) {
      log('warn', 'study usage log failed', { error: err?.message || String(err) });
    }
  }

  async function handleTts(payload, sender) {
    const text = cleanTtsText(payload?.text);
    if (!text) throw codedError('forkTtsEmpty', null, 'nothing to read');
    const mode = payload?.mode === 'slow' ? 'slow' : 'normal';
    const [settings, fork, local] = await Promise.all([
      getSettingsCached(),
      readFork(),
      browser.storage.local.get(PRONUNCIATIONS_KEY),
    ]);
    const pron = sanitizePronunciations(local?.[PRONUNCIATIONS_KEY]);
    const hasKey = !!settings.apiKey;
    const engine = fork.tts.engine;
    if (engine === 'browser' || (engine === 'auto' && !hasKey)) {
      // 瀏覽器內建語音只認拼讀式改寫；IPA 不套用
      return { engine: 'browser', text: applyPronunciations(text, pron, { engine: 'browser' }).text, mode, reason: hasKey ? 'setting' : 'noKey' };
    }
    if (!hasKey) throw codedError('apiKeyMissing', null, 'Gemini API key is missing');

    const spoken = applyPronunciations(text, pron, { engine: 'gemini' }).text;
    const { model, voice } = fork.tts;
    const style = TTS_STYLES[mode];
    const key = await ttsCacheKey({ model, voice, style, text: spoken });
    const cache = getAudioCache();
    let hit = null;
    try { hit = await cache.get(key); } catch (err) { log('warn', 'tts cache read failed', { error: err?.message }); }
    if (hit) return { engine: 'gemini', cached: true, audio: hit.data, mimeType: hit.mimeType, mode };

    const t0 = Date.now();
    const r = await synthesize({
      apiKey: settings.apiKey,
      model,
      text: spoken,
      voice,
      style,
      // 音訊生成較久；逾時不重送（重送 = 再付一次錢）
      fetcher: (url, body, { headers }) => fetchWithRetry(url, body, {
        headers, maxRetries: 1, timeoutMs: 45_000, timeoutRetries: 0, logPrefix: 'ekiden tts',
      }),
    });
    try { await cache.put(key, r); } catch (err) { log('warn', 'tts cache write failed', { error: err?.message }); }
    const inputTokens = sumModalities(r.usage.input);
    await logUsage({
      url: sender?.tab?.url || '',
      title: sender?.tab?.title || '',
      engine: 'gemini',
      model,
      inputTokens,
      outputTokens: sumModalities(r.usage.output),
      billedInputTokens: inputTokens,
      billedCostUSD: computeModalityCostUSD(model, r.usage) ?? 0,
      durationMs: Date.now() - t0,
      source: 'tts',
    });
    return { engine: 'gemini', cached: false, audio: r.data, mimeType: r.mimeType, mode };
  }

  async function handleExplain(payload, sender) {
    const text = String(payload?.text || '').trim();
    if (!text) throw codedError('forkExplainEmpty', { reason: 'empty selection' }, 'nothing to explain');
    const [settings, fork, local] = await Promise.all([
      getSettingsCached(),
      readFork(),
      browser.storage.local.get(FORK_EXPLAIN_PROMPT_KEY),
    ]);
    if (!settings.apiKey) throw codedError('apiKeyMissing', null, 'Gemini API key is missing');
    const model = fork.explain.model || settings.geminiConfig?.model || FALLBACK_EXPLAIN_MODEL;
    const context = String(payload?.context || '');
    const question = typeof payload?.question === 'string' ? payload.question.trim() : '';
    const isFollowup = !!question;

    const base = explain.buildExplainSystem({
      langLabel: LANG_LABELS[settings.targetLanguage] || settings.targetLanguage,
      customInstruction: sanitizeExplainPrompt(local?.[FORK_EXPLAIN_PROMPT_KEY]),
    });
    // 固定術語表與禁用詞：與整頁翻譯同一個產生器（texts 傳空，只取這兩段規則）
    const fixed = getInternals()?.buildFixedGlossaryEntries?.(settings.fixedGlossary, sender) || null;
    const forbidden = Array.isArray(settings.forbiddenTerms) ? settings.forbiddenTerms : [];
    const system = buildEffectiveSystemInstruction(base, [], '', null, fixed, forbidden);

    const userText = explain.buildExplainUserText({
      text, context, title: payload?.title || '', sourceLang: payload?.sourceLang || '',
    });
    const card = isFollowup && payload?.card && typeof payload.card === 'object' ? payload.card : null;
    if (isFollowup && !card) throw codedError('forkExplainEmpty', { reason: 'no card' }, 'follow-up needs a card');
    const history = Array.isArray(payload?.history)
      ? payload.history.filter((h) => h && typeof h.q === 'string' && typeof h.a === 'string')
      : [];
    const contents = explain.buildContents({ userText, card, history, question: isFollowup ? question : '' });
    const body = explain.buildGenerateBody({
      system,
      contents,
      maxOutputTokens: isFollowup ? 1536 : 3072,
      thinkingConfig: pickThinkingConfig(model),
      samplingFields: { ...buildTemperatureField(model, 0.7), ...buildSamplingFields(model) },
    });
    if (settings.geminiConfig?.serviceTier && settings.geminiConfig.serviceTier !== 'DEFAULT') {
      body.service_tier = settings.geminiConfig.serviceTier.toLowerCase();
    }

    const t0 = Date.now();
    const resp = await fetchWithRetry(`${GEMINI_BASE}${encodeURIComponent(model)}:generateContent`, body, {
      headers: { 'x-goog-api-key': settings.apiKey },
      maxRetries: 2,
      timeoutMs: 60_000,
      timeoutRetries: 0,
      logPrefix: 'ekiden explain',
    });
    let json = null;
    let raw = '';
    try {
      raw = await resp.text();
      json = raw ? JSON.parse(raw) : null;
    } catch { json = null; }
    if (!resp.ok) {
      const detail = json?.error?.message || raw.slice(0, 200) || `HTTP ${resp.status}`;
      throw codedError('forkExplainHttp', { status: resp.status, detail }, detail);
    }

    const usage = parseGeminiUsage(json?.usageMetadata);
    const pricing = getPricingForModel(model, settings) || settings.pricing;
    const billing = computeBilling(usage, pricing, geminiCachedRate(pricing));
    await logUsage({
      url: sender?.tab?.url || '',
      title: sender?.tab?.title || '',
      engine: 'gemini',
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      billedInputTokens: billing.billedInputTokens,
      billedCostUSD: billing.billedCostUSD,
      durationMs: Date.now() - t0,
      source: isFollowup ? 'explain-followup' : 'explain',
    });

    const outText = explain.responseText(json);
    if (!outText.trim()) {
      const reason = json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || 'empty';
      throw codedError('forkExplainEmpty', { reason }, `empty response (${reason})`);
    }
    if (isFollowup) {
      const a = explain.parseAnswer(outText, { context });
      return { answer: a.answer, citations: a.citations, model };
    }
    const r = explain.parseCard(outText, { selection: text, context });
    return r.ok ? { card: r.card, model } : { raw: r.raw, model };
  }

  async function handleLearnSave(payload, sender) {
    const r = await getLearn().add({
      text: payload?.text,
      translation: payload?.translation,
      lang: payload?.lang,
      context: payload?.context,
      card: payload?.card,
      url: sender?.tab?.url || '',
      title: sender?.tab?.title || '',
    });
    return r;
  }

  return {
    FORK_TTS: handleTts,
    FORK_EXPLAIN: handleExplain,
    FORK_LEARN_SAVE: handleLearnSave,
    async FORK_LEARN_COUNT() { return { count: await getLearn().count() }; },
    async FORK_TTS_CLEAR_CACHE() { await getAudioCache().clear(); return {}; },
  };
}

// ── 右鍵選單 ───────────────────────────────────────────────
// 選單文字來自 _locales（chrome.i18n，跟隨瀏覽器語言）。設定頁關掉時全部移除。
export const MENU_IDS = Object.freeze({
  selection: 'ekiden-translate-selection',
  page: 'ekiden-translate-page',
  paragraph: 'ekiden-restore-paragraph',
});

function menusApi() {
  return browser.contextMenus || browser.menus || null;
}

function msg(name, fallback) {
  try { return browser.i18n.getMessage(name) || fallback; } catch { return fallback; }
}

export async function setupContextMenus(enabled) {
  const api = menusApi();
  if (!api) return;
  // Chrome MV3 與 Firefox 的 removeAll 都回傳 Promise
  try { await api.removeAll(); } catch { /* 沒有項目可移除 */ }
  if (!enabled) return;
  const create = (props) => {
    try { api.create(props, () => { void browser.runtime.lastError; }); } catch { /* 重複建立等錯誤不影響其他項目 */ }
  };
  create({ id: MENU_IDS.selection, title: msg('ctxTranslateSelection', 'Translate “%s”'), contexts: ['selection'] });
  create({ id: MENU_IDS.page, title: msg('ctxTranslatePage', 'Translate page / show original'), contexts: ['page'] });
  create({ id: MENU_IDS.paragraph, title: msg('ctxRestoreParagraph', 'Show original of this paragraph'), contexts: ['page', 'selection', 'link'] });
}

export function onContextMenuClicked(info, tab) {
  if (!tab?.id) return;
  const frame = Number.isInteger(info?.frameId) ? { frameId: info.frameId } : undefined;
  const send = (message, opts) => browser.tabs.sendMessage(tab.id, message, opts).catch(() => {});
  if (info.menuItemId === MENU_IDS.selection) send({ type: 'FORK_CARD_OPEN', payload: { text: info.selectionText || '' } }, frame);
  // 與 Alt+S 快速鍵同一條路徑（background.js onCommand → TRANSLATE_PRESET slot 2）
  else if (info.menuItemId === MENU_IDS.page) send({ type: 'TRANSLATE_PRESET', payload: { slot: 2 } });
  else if (info.menuItemId === MENU_IDS.paragraph) send({ type: 'FORK_RESTORE_PARAGRAPH' }, frame);
}
