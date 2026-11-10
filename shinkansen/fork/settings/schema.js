// fork/settings/schema.js — 驛傳（Ekiden）自有設定的結構、預設值與匯入消毒
//
// 儲存位置（見 docs/FORK-NOTES.md §3.1）：
//   storage.sync  'fork'                 一般設定（本檔 FORK_DEFAULTS 的形狀）
//   storage.local 'forkSecrets'          金鑰與密碼：azureKey / deeplKey / deeplxToken /
//                                         providerKeys{id:key} / webdavPassword
//   storage.local 'forkProviderPrompts'  額外 OpenAI 相容服務的自訂 system prompt {id: prompt}
//   storage.local 'forkBackupState'      備份同步狀態（ETag、檔案 id、時間）
//   storage.local 'forkPronunciations'   朗讀的自訂讀音表 [{term, mode, value}]（fork/tts/pronounce.js）
//   storage.local 'forkExplainPrompt'    AI 閱讀卡的自訂指示（字串；放 local 是因為 sync 單一項目上限 8 KB）
//
// 預設值一律不改變上游行為：presetEngines 全空 = 三組預設照上游原本的引擎翻譯。

import { SOURCE_LANGS } from '../engines/lang.js';
import { CHAIN_CANDIDATES, DEFAULT_CHAIN, normalizeChain } from '../engines/chain.js';
import { ENGINE_IDS } from '../engines/registry.js';
import { MODALITY_MODEL_PRICING } from '../../lib/model-pricing.js';
import { PREBUILT_VOICES, DEFAULT_VOICE } from '../tts/gemini-tts.js';

export const FORK_SYNC_KEY = 'fork';
export const FORK_SECRETS_KEY = 'forkSecrets';
export const FORK_PROVIDER_PROMPTS_KEY = 'forkProviderPrompts';
export const FORK_BACKUP_STATE_KEY = 'forkBackupState';
export const FORK_EXPLAIN_PROMPT_KEY = 'forkExplainPrompt';
export const MAX_EXPLAIN_PROMPT = 2000;

export const MAX_PROVIDERS = 8;

// 朗讀模型清單來自 lib/model-pricing.js 的多模態計價表（kind 'tts'），不在別處寫死
export const TTS_MODELS = Object.keys(MODALITY_MODEL_PRICING).filter((m) => MODALITY_MODEL_PRICING[m].kind === 'tts');
export const DEFAULT_TTS_MODEL = TTS_MODELS.find((m) => /flash-lite/.test(m)) || TTS_MODELS[0] || '';
export const STUDY_TRIGGERS = ['select', 'dblclick', 'longpress', 'middle', 'modifier', 'off'];
export const STUDY_ENGINES_FIXED = ['preset', 'gemini', 'custom'];
export const MODIFIER_KEYS = ['alt', 'shift', 'ctrl'];
export const TTS_ENGINES = ['auto', 'gemini', 'browser'];
export const CONTEXT_SCOPES = ['none', 'paragraph', 'nearby'];
export const PROVIDER_PREFIX = 'fork-cp:';

export const FORK_DEFAULTS = Object.freeze({
  schema: 1,
  // 三組翻譯預設各自改用的引擎。'' = 沿用上游設定。
  //   上游引擎是 Google 的那組 → 填機器翻譯引擎 id（microsoft-edge / deepl / free-chain …）
  //   上游引擎是自訂模型的那組 → 填額外 OpenAI 相容服務的 id
  presetEngines: { 1: '', 2: '', 3: '' },
  mt: {
    sourceLang: 'auto',
    chain: [...DEFAULT_CHAIN],
    chainDisabled: [],
    rateLimits: {},
    azure: { region: '', endpoint: '' },
    deeplx: { url: '' },
  },
  // 額外 OpenAI 相容服務；上游「自訂模型」分頁的那一組維持原樣、不在此列
  providers: [],
  backup: {
    includeKeys: false,
    webdav: { url: '', username: '', dir: 'ekiden' },
    gdrive: { clientId: '' },
  },
  // 劃詞卡片（第 2 階段）
  study: {
    trigger: 'select',      // select | dblclick | longpress | middle | modifier | off
    selectMode: 'icon',     // trigger 'select' 時：icon = 先出現小按鈕，點了才開卡片；card = 直接開卡片
    modifierKey: 'alt',     // trigger 'modifier'：按住這個鍵拖曳選取
    longPressMs: 500,
    engine: 'preset',       // preset = 跟主要翻譯預設（Alt+S）同一個引擎；gemini / custom / 機器翻譯 id / fork-cp:<id>
    bidirectional: false,   // 選取的文字已是目標語言時，改翻成 secondLang（只限機器翻譯引擎）
    secondLang: 'en',
    contextMenu: true,      // 右鍵選單：翻譯選取文字 / 翻譯整頁 / 還原這一段
  },
  tts: {
    engine: 'auto',         // auto = 有 Gemini 金鑰用 Gemini，沒有就用瀏覽器內建語音；gemini；browser
    model: DEFAULT_TTS_MODEL,
    voice: DEFAULT_VOICE,
  },
  explain: {
    model: '',              // '' = 沿用 Gemini 主設定的模型
    contextScope: 'paragraph', // none | paragraph | nearby（前後各一段）
  },
  paragraph: {
    hoverRestMs: 150,       // 懸停翻譯的停留時間（上游固定 150 ms，預設值不變）
    copyShortcut: { code: 'KeyC', alt: true, shift: false, ctrl: false, meta: false }, // null = 關閉
  },
});

export const SECRET_FIELDS = ['azureKey', 'deeplKey', 'deeplxToken', 'webdavPassword'];

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function str(v, max = 500) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v, { min = 0, max = Infinity, allowNull = false } = {}) {
  if (allowNull && (v === null || v === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return allowNull ? null : undefined;
  return Math.min(max, Math.max(min, n));
}

function isHttpUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function newProviderId() {
  const rand = (globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, '');
  return 'p' + rand.slice(0, 10);
}

function sanitizeProvider(p) {
  if (!p || typeof p !== 'object') return null;
  const id = str(p.id, 40);
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return null;
  const baseUrl = str(p.baseUrl, 500).trim();
  if (baseUrl && !isHttpUrl(baseUrl)) return null;
  const thinking = ['auto', 'off', 'low', 'medium', 'high'].includes(p.thinkingLevel) ? p.thinkingLevel : 'off';
  return {
    id,
    label: str(p.label, 60).trim(),
    baseUrl,
    model: str(p.model, 200).trim(),
    temperature: num(p.temperature, { min: 0, max: 2, allowNull: true }),
    inputPerMTok: num(p.inputPerMTok, { min: 0, max: 1000 }) ?? 0,
    outputPerMTok: num(p.outputPerMTok, { min: 0, max: 1000 }) ?? 0,
    thinkingLevel: thinking,
  };
}

function sanitizeRateLimits(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of ENGINE_IDS) {
    const r = raw[id];
    if (!r || typeof r !== 'object') continue;
    const rps = num(r.rps, { min: 0, max: 100 });
    const rpm = num(r.rpm, { min: 0, max: 6000 });
    if (rps === undefined && rpm === undefined) continue;
    out[id] = { rps: rps ?? 0, rpm: rpm ?? 0 };
  }
  return out;
}

/**
 * 把使用者存的值（可能缺欄位、可能是舊版）合併成完整設定。不做型別修正以外的改寫。
 */
export function mergeForkSettings(saved) {
  return sanitizeForkSettings(saved || {}, { fillDefaults: true }).clean;
}

/**
 * 消毒（匯入 / 雲端還原 / 讀取時共用）。不認識的欄位丟掉，不合法的值回預設。
 * @returns {{ clean: object, warnings: string[] }}
 */
export function sanitizeForkSettings(raw, { fillDefaults = true } = {}) {
  const warnings = [];
  const d = clone(FORK_DEFAULTS);
  const src = raw && typeof raw === 'object' ? raw : {};
  const clean = fillDefaults ? d : {};

  // presetEngines
  const pe = src.presetEngines && typeof src.presetEngines === 'object' ? src.presetEngines : {};
  clean.presetEngines = { ...d.presetEngines };
  for (const slot of ['1', '2', '3']) {
    const v = pe[slot] ?? pe[Number(slot)];
    if (v === undefined || v === '' || v === null) continue;
    if (typeof v === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(v)) clean.presetEngines[slot] = v;
    else warnings.push(`presetEngines.${slot}`);
  }

  // mt
  const mt = src.mt && typeof src.mt === 'object' ? src.mt : {};
  clean.mt = clone(d.mt);
  if (mt.sourceLang !== undefined) {
    if (SOURCE_LANGS.includes(mt.sourceLang)) clean.mt.sourceLang = mt.sourceLang;
    else warnings.push('mt.sourceLang');
  }
  if (Array.isArray(mt.chain)) clean.mt.chain = normalizeChain(mt.chain);
  if (Array.isArray(mt.chainDisabled)) {
    clean.mt.chainDisabled = mt.chainDisabled.filter((id) => CHAIN_CANDIDATES.includes(id));
  }
  clean.mt.rateLimits = sanitizeRateLimits(mt.rateLimits);
  if (mt.azure && typeof mt.azure === 'object') {
    clean.mt.azure.region = str(mt.azure.region, 60).trim();
    const ep = str(mt.azure.endpoint, 300).trim();
    if (ep && !isHttpUrl(ep)) warnings.push('mt.azure.endpoint');
    else clean.mt.azure.endpoint = ep;
  }
  if (mt.deeplx && typeof mt.deeplx === 'object') {
    const u = str(mt.deeplx.url, 500).trim();
    if (u && !isHttpUrl(u)) warnings.push('mt.deeplx.url');
    else clean.mt.deeplx.url = u;
  }

  // providers
  clean.providers = [];
  if (Array.isArray(src.providers)) {
    const ids = new Set();
    for (const p of src.providers.slice(0, MAX_PROVIDERS)) {
      const c = sanitizeProvider(p);
      if (!c || ids.has(c.id)) {
        warnings.push('providers');
        continue;
      }
      ids.add(c.id);
      clean.providers.push(c);
    }
  }

  // backup
  const b = src.backup && typeof src.backup === 'object' ? src.backup : {};
  clean.backup = clone(d.backup);
  if (typeof b.includeKeys === 'boolean') clean.backup.includeKeys = b.includeKeys;
  if (b.webdav && typeof b.webdav === 'object') {
    const u = str(b.webdav.url, 500).trim();
    if (u && !isHttpUrl(u)) warnings.push('backup.webdav.url');
    else clean.backup.webdav.url = u;
    clean.backup.webdav.username = str(b.webdav.username, 200);
    const dir = str(b.webdav.dir, 100).trim().replace(/^\/+|\/+$/g, '');
    // 資料夾只允許一般名稱；'.' / '..' 片段會讓網址跳到上層目錄，一律退回預設
    const segs = dir.split('/');
    const okDir = /^[\w.-]+(\/[\w.-]+)*$/.test(dir) && segs.every((x) => x !== '.' && x !== '..');
    if (dir && !okDir) warnings.push('backup.webdav.dir');
    clean.backup.webdav.dir = okDir ? dir : d.backup.webdav.dir;
  }
  if (b.gdrive && typeof b.gdrive === 'object') {
    clean.backup.gdrive.clientId = str(b.gdrive.clientId, 200).trim();
  }

  sanitizeStudy(src, d, clean, warnings);

  clean.schema = 1;
  return { clean, warnings };
}

function pickEnum(v, list, fallback, warnings, name) {
  if (v === undefined) return fallback;
  if (list.includes(v)) return v;
  warnings.push(name);
  return fallback;
}

function sanitizeShortcut(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || typeof v.code !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(v.code)) return undefined;
  const sc = { code: v.code, alt: !!v.alt, shift: !!v.shift, ctrl: !!v.ctrl, meta: !!v.meta };
  // 沒有任何修飾鍵的單鍵會干擾一般打字，不接受
  return (sc.alt || sc.ctrl || sc.meta) ? sc : undefined;
}

function sanitizeStudy(src, d, clean, warnings) {
  const st = src.study && typeof src.study === 'object' ? src.study : {};
  clean.study = clone(d.study);
  clean.study.trigger = pickEnum(st.trigger, STUDY_TRIGGERS, d.study.trigger, warnings, 'study.trigger');
  clean.study.selectMode = pickEnum(st.selectMode, ['icon', 'card'], d.study.selectMode, warnings, 'study.selectMode');
  clean.study.modifierKey = pickEnum(st.modifierKey, MODIFIER_KEYS, d.study.modifierKey, warnings, 'study.modifierKey');
  if (st.longPressMs !== undefined) clean.study.longPressMs = Math.round(num(st.longPressMs, { min: 250, max: 2000 }) ?? d.study.longPressMs);
  if (st.engine !== undefined) {
    const e = st.engine;
    const ok = typeof e === 'string'
      && (STUDY_ENGINES_FIXED.includes(e) || ENGINE_IDS.includes(e) || /^fork-cp:[a-zA-Z0-9_-]{1,40}$/.test(e));
    if (ok) clean.study.engine = e;
    else warnings.push('study.engine');
  }
  if (typeof st.bidirectional === 'boolean') clean.study.bidirectional = st.bidirectional;
  clean.study.secondLang = pickEnum(st.secondLang, SOURCE_LANGS.filter((x) => x !== 'auto'), d.study.secondLang, warnings, 'study.secondLang');
  if (typeof st.contextMenu === 'boolean') clean.study.contextMenu = st.contextMenu;

  const tts = src.tts && typeof src.tts === 'object' ? src.tts : {};
  clean.tts = clone(d.tts);
  clean.tts.engine = pickEnum(tts.engine, TTS_ENGINES, d.tts.engine, warnings, 'tts.engine');
  clean.tts.model = pickEnum(tts.model, TTS_MODELS, d.tts.model, warnings, 'tts.model');
  clean.tts.voice = pickEnum(tts.voice, PREBUILT_VOICES, d.tts.voice, warnings, 'tts.voice');

  const ex = src.explain && typeof src.explain === 'object' ? src.explain : {};
  clean.explain = clone(d.explain);
  if (ex.model !== undefined) {
    const m = typeof ex.model === 'string' ? ex.model.trim() : '';
    if (m === '' || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(m)) clean.explain.model = m;
    else warnings.push('explain.model');
  }
  clean.explain.contextScope = pickEnum(ex.contextScope, CONTEXT_SCOPES, d.explain.contextScope, warnings, 'explain.contextScope');

  const pg = src.paragraph && typeof src.paragraph === 'object' ? src.paragraph : {};
  clean.paragraph = clone(d.paragraph);
  if (pg.hoverRestMs !== undefined) clean.paragraph.hoverRestMs = Math.round(num(pg.hoverRestMs, { min: 0, max: 2000 }) ?? d.paragraph.hoverRestMs);
  if (pg.copyShortcut !== undefined) {
    const sc = sanitizeShortcut(pg.copyShortcut);
    if (sc === undefined) warnings.push('paragraph.copyShortcut');
    else clean.paragraph.copyShortcut = sc;
  }
}

export function sanitizeExplainPrompt(raw) {
  return typeof raw === 'string' ? raw.slice(0, MAX_EXPLAIN_PROMPT) : '';
}

/** 消毒 storage.local 的 forkSecrets（雲端還原用；只收已知欄位）。 */
export function sanitizeSecrets(raw) {
  const out = { providerKeys: {} };
  if (!raw || typeof raw !== 'object') return out;
  for (const f of SECRET_FIELDS) {
    if (typeof raw[f] === 'string' && raw[f]) out[f] = raw[f].slice(0, 500);
  }
  if (raw.providerKeys && typeof raw.providerKeys === 'object') {
    for (const [id, k] of Object.entries(raw.providerKeys)) {
      if (/^[a-zA-Z0-9_-]{1,40}$/.test(id) && typeof k === 'string' && k) out.providerKeys[id] = k.slice(0, 500);
    }
  }
  return out;
}

export function sanitizeProviderPrompts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, p] of Object.entries(raw)) {
    if (/^[a-zA-Z0-9_-]{1,40}$/.test(id) && typeof p === 'string') out[id] = p.slice(0, 20_000);
  }
  return out;
}

/** 解析某組預設的 fork 選擇（content 端與背景端共用規則）。 */
export function resolvePresetSelection(forkSettings, slot, upstreamEngine) {
  const v = forkSettings?.presetEngines?.[String(slot)] || '';
  if (!v) return {};
  if (upstreamEngine === 'google') {
    return ENGINE_IDS.includes(v) && v !== 'google' ? { mtEngine: v } : {};
  }
  if (upstreamEngine === 'openai-compat') {
    const p = (forkSettings.providers || []).find((x) => x.id === v);
    return p ? { modelOverride: PROVIDER_PREFIX + p.id, providerLabel: p.label } : {};
  }
  return {};
}
