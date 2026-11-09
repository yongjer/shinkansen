// fork/bg/index.js — 驛傳（Ekiden）背景端入口
//
// background.js 只做三件事（掛鉤點記錄在 docs/FORK-NOTES.md §4）：
//   1. import 本檔
//   2. 呼叫 initFork({ handleTranslateCustom, errorFields }) 交出需要重用的內部函式
//   3. TRANSLATE_BATCH_GOOGLE / TRANSLATE_BATCH_CUSTOM 兩個 handler 先問 forkRoutes 要不要接手
//
// 驛傳自己的訊息一律用 'FORK_' 前綴，由本檔註冊的 runtime.onMessage listener 處理；
// 上游 router 遇到不認識的類型不回應，兩邊不會搶同一則訊息。

import { browser } from '../../lib/compat.js';
import * as cache from '../../lib/cache.js';
import * as usageDB from '../../lib/usage-db.js';
import { translateGoogleBatch } from '../../lib/google-translate.js';
import { getSettingsCached, getEffectiveSystemPrompt } from '../../lib/storage.js';
import { debugLog } from '../../lib/logger.js';
import { codedError } from '../../lib/bg-error.js';
import { createEngineRegistry, ENGINE_META, isMtEngineId } from '../engines/registry.js';
import { createMtBatchHandler } from './mt-batch.js';
import { createProviderBatchHandler, isForkProviderPayload } from './providers.js';
import {
  FORK_SYNC_KEY, FORK_SECRETS_KEY, FORK_PROVIDER_PROMPTS_KEY,
  mergeForkSettings, sanitizeSecrets, sanitizeProviderPrompts,
} from '../settings/schema.js';

let internals = null;

const log = (level, msg, data) => debugLog(level, 'translate', `[ekiden] ${msg}`, data);

// ── 設定讀取（storage 變動時清快取）────────────────────────
let forkCache = null;
let secretsCache = null;
let promptsCache = null;
try {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && FORK_SYNC_KEY in changes) forkCache = null;
    if (area === 'local' && FORK_SECRETS_KEY in changes) secretsCache = null;
    if (area === 'local' && FORK_PROVIDER_PROMPTS_KEY in changes) promptsCache = null;
  });
} catch { /* 測試環境沒有 storage */ }

export async function readFork() {
  if (!forkCache) {
    forkCache = browser.storage.sync.get(FORK_SYNC_KEY)
      .then((r) => mergeForkSettings(r?.[FORK_SYNC_KEY]))
      .catch((err) => { forkCache = null; throw err; });
  }
  return forkCache;
}

export async function readSecrets() {
  if (!secretsCache) {
    secretsCache = browser.storage.local.get(FORK_SECRETS_KEY)
      .then((r) => sanitizeSecrets(r?.[FORK_SECRETS_KEY]))
      .catch((err) => { secretsCache = null; throw err; });
  }
  return secretsCache;
}

async function readPrompts() {
  if (!promptsCache) {
    promptsCache = browser.storage.local.get(FORK_PROVIDER_PROMPTS_KEY)
      .then((r) => sanitizeProviderPrompts(r?.[FORK_PROVIDER_PROMPTS_KEY]))
      .catch((err) => { promptsCache = null; throw err; });
  }
  return promptsCache;
}

async function getTarget() {
  const s = await getSettingsCached();
  return s.targetLanguage || 'zh-TW';
}

const registry = createEngineRegistry({ googleBatch: translateGoogleBatch });

const handleMtBatch = createMtBatchHandler({
  registry,
  cache,
  logUsage: (record) => usageDB.upsertCharUsage(record),
  getTarget,
  readFork,
  readSecrets,
  log,
});

let handleProviderBatch = null;

export function initFork(deps) {
  internals = deps;
  handleProviderBatch = createProviderBatchHandler({
    handleTranslateCustom: deps.handleTranslateCustom,
    getEffectiveSystemPrompt,
    getTarget,
    readFork,
    readSecrets,
    readPrompts,
  });
}

// 上游 handler 的分流判斷（background.js 掛鉤用）
export const forkRoutes = {
  isMtPayload: (payload) => isMtEngineId(payload?.mtEngine) && payload.mtEngine !== 'google',
  mt: (payload, sender) => handleMtBatch(payload, sender),
  isProviderPayload: (payload) => isForkProviderPayload(payload),
  provider: (payload, sender) => {
    if (!handleProviderBatch) throw new Error('ekiden: initFork() was not called');
    return handleProviderBatch(payload, sender);
  },
};

// ── 驛傳自有訊息 ──────────────────────────────────────────
const SAMPLE_TEXT = 'Hello, world. This is a test of the translation service.';

const forkHandlers = {
  // 設定頁「測試」按鈕：用指定引擎翻譯一句範例文字（不寫快取、不記用量）
  async FORK_TEST_ENGINE(payload) {
    const engine = payload?.engine;
    if (!isMtEngineId(engine)) throw codedError('forkEngineUnknown', { engine: String(engine) }, `unknown engine: ${engine}`);
    const [target, fork, secrets] = await Promise.all([getTarget(), readFork(), readSecrets()]);
    const t0 = Date.now();
    const r = await registry.translateWith(engine, [payload?.text || SAMPLE_TEXT], { target, cfg: fork.mt, secrets });
    return { translation: r.translations[0], servedBy: r.servedBy, ms: Date.now() - t0, attempts: r.attempts || [] };
  },
  // 設定頁顯示各引擎狀態：是否已設定、健康紀錄
  async FORK_ENGINE_STATUS() {
    const [fork, secrets] = await Promise.all([readFork(), readSecrets()]);
    const configured = {};
    for (const id of Object.keys(ENGINE_META)) {
      configured[id] = ENGINE_META[id].runsIn === 'background' && id !== 'free-chain'
        ? registry.isConfigured(id, fork.mt, secrets)
        : null;
    }
    return { configured, health: registry.health.snapshot() };
  },
  // content 端在頁面內完成的翻譯（Chrome 內建 Translator）回報用量（只記字元數）
  async FORK_LOG_CHAR_USAGE(payload, sender) {
    const engine = payload?.engine;
    if (!isMtEngineId(engine) || ENGINE_META[engine].runsIn !== 'content') return {};
    const chars = Math.max(0, Math.floor(Number(payload?.chars) || 0));
    const segments = Math.max(0, Math.floor(Number(payload?.segments) || 0));
    if (!chars) return {};
    await usageDB.upsertCharUsage({
      url: sender?.tab?.url || '',
      title: '',
      engine,
      model: engine,
      billingUnit: 'chars',
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0,
      chars,
      segments,
      cacheHits: 0,
      durationMs: Math.max(0, Math.floor(Number(payload?.durationMs) || 0)),
      timestamp: Date.now(),
    });
    return {};
  },
};

function errorFieldsOf(err) {
  if (internals?.errorFields) return internals.errorFields(err);
  const fields = { error: err?.message || String(err) };
  if (err?.skCode) {
    fields.errorCode = err.skCode;
    if (err.skParams) fields.errorParams = err.skParams;
  }
  return fields;
}

try {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    if (typeof type !== 'string' || !type.startsWith('FORK_')) return undefined;
    const handler = forkHandlers[type];
    if (!handler) return undefined;
    Promise.resolve()
      .then(() => handler(message.payload, sender))
      .then((result) => sendResponse({ ok: true, ...(result && typeof result === 'object' ? result : {}) }))
      .catch((err) => {
        log('error', `${type} failed`, { error: err?.message || String(err) });
        sendResponse({ ok: false, ...errorFieldsOf(err) });
      });
    return true;
  });
} catch { /* 測試環境沒有 runtime */ }
