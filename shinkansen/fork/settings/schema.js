// fork/settings/schema.js — 驛傳（Ekiden）自有設定的結構、預設值與匯入消毒
//
// 儲存位置（見 docs/FORK-NOTES.md §3.1）：
//   storage.sync  'fork'                 一般設定（本檔 FORK_DEFAULTS 的形狀）
//   storage.local 'forkSecrets'          金鑰與密碼：azureKey / deeplKey / deeplxToken /
//                                         providerKeys{id:key} / webdavPassword
//   storage.local 'forkProviderPrompts'  額外 OpenAI 相容服務的自訂 system prompt {id: prompt}
//   storage.local 'forkBackupState'      備份同步狀態（ETag、檔案 id、時間）
//
// 預設值一律不改變上游行為：presetEngines 全空 = 三組預設照上游原本的引擎翻譯。

import { SOURCE_LANGS } from '../engines/lang.js';
import { CHAIN_CANDIDATES, DEFAULT_CHAIN, normalizeChain } from '../engines/chain.js';
import { ENGINE_IDS } from '../engines/registry.js';

export const FORK_SYNC_KEY = 'fork';
export const FORK_SECRETS_KEY = 'forkSecrets';
export const FORK_PROVIDER_PROMPTS_KEY = 'forkProviderPrompts';
export const FORK_BACKUP_STATE_KEY = 'forkBackupState';

export const MAX_PROVIDERS = 8;
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

  clean.schema = 1;
  return { clean, warnings };
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
