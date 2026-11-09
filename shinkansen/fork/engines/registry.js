// fork/engines/registry.js — 驛傳的機器翻譯引擎註冊表
//
// 上游的引擎是「訊息類型 × 用途」路由，沒有註冊表（見 docs/ARCHITECTURE-SUMMARY.md §3）。
// 驛傳新增的機器翻譯引擎集中在這裡登記，共用同一個介面：
//   translate(texts, { target, source, cfg, secrets, signal, acquire }) → { translations, chars }
// 文字裡的 【N】 標記由上游的 Google MT 序列化產生，各引擎負責原樣保留或轉成標籤處理。
//
// 'google' 包裝上游 lib/google-translate.js，不另寫一份；'chrome-translator' 只能在
// content script 執行（Translator API 不能在 service worker 使用），這裡只登記描述資料。

import { createMicrosoftEdgeEngine, createAzureEngine } from './microsoft.js';
import { createDeeplEngine, createDeeplxEngine } from './deepl.js';
import { createRateLimiter } from './rate-limit.js';
import { createHealth, runChain } from './chain.js';
import { normalizeTarget, normalizeSource } from './lang.js';
import { codedError } from '../../lib/bg-error.js';
import { engineName } from './http.js';

// official：官方 API；unofficial：可能失效、無 SLA；runsIn：執行位置
export const ENGINE_META = {
  google:              { official: false, needsKey: false, runsIn: 'background' },
  'microsoft-edge':    { official: false, needsKey: false, runsIn: 'background' },
  azure:               { official: true,  needsKey: true,  runsIn: 'background' },
  deepl:               { official: true,  needsKey: true,  runsIn: 'background' },
  deeplx:              { official: false, needsKey: false, runsIn: 'background' },
  'chrome-translator': { official: true,  needsKey: false, runsIn: 'content' },
  'free-chain':        { official: false, needsKey: false, runsIn: 'background' },
};

export const ENGINE_IDS = Object.keys(ENGINE_META);

// 預設速率限制：DeepLX 多半是個人或小型實例，預設每秒 3 次；其他不限（使用者可自訂）
export const DEFAULT_RATE_LIMITS = {
  deeplx: { rps: 3, rpm: 0 },
};

export function isMtEngineId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ENGINE_META, id);
}

export function rateLimitsFor(cfg, id) {
  const user = cfg?.rateLimits?.[id];
  const def = DEFAULT_RATE_LIMITS[id] || { rps: 0, rpm: 0 };
  return {
    rps: Number.isFinite(Number(user?.rps)) && user?.rps !== '' && user?.rps != null ? Number(user.rps) : def.rps,
    rpm: Number.isFinite(Number(user?.rpm)) && user?.rpm !== '' && user?.rpm != null ? Number(user.rpm) : def.rpm,
  };
}

function createGoogleEngine({ googleBatch }) {
  return {
    id: 'google',
    official: false,
    needsKey: false,
    isConfigured: () => typeof googleBatch === 'function',
    async translate(texts, { target, acquire = async () => {} }) {
      // 上游端點不支援指定來源語言（一律自動偵測），批次切分與重試由上游 lib 處理
      await acquire();
      const r = await googleBatch(texts, target);
      return { translations: r.translations, chars: r.chars };
    },
  };
}

/**
 * @param {object} deps
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.googleBatch] 上游 translateGoogleBatch(texts, tl)
 * @param {object} [deps.limiter] createRateLimiter() 的結果
 * @param {object} [deps.health] createHealth() 的結果
 */
export function createEngineRegistry({ fetchImpl, googleBatch, limiter, health, now } = {}) {
  const engines = {
    google: createGoogleEngine({ googleBatch }),
    'microsoft-edge': createMicrosoftEdgeEngine({ fetchImpl, now }),
    azure: createAzureEngine({ fetchImpl }),
    deepl: createDeeplEngine({ fetchImpl }),
    deeplx: createDeeplxEngine({ fetchImpl }),
  };
  const lim = limiter || createRateLimiter({ now });
  const hp = health || createHealth({ now });

  function isConfigured(id, cfg, secrets) {
    const e = engines[id];
    return !!e && e.isConfigured(cfg, secrets);
  }

  async function translateSingle(id, texts, ctx) {
    const e = engines[id];
    if (!e) {
      if (ENGINE_META[id]?.runsIn === 'content') {
        throw codedError('forkEngineContentOnly', { engine: engineName(id) }, `${id} runs in the page, not in the background`);
      }
      throw codedError('forkEngineUnknown', { engine: id }, `unknown engine: ${id}`);
    }
    const limits = rateLimitsFor(ctx.cfg, id);
    return e.translate(texts, { ...ctx, acquire: () => lim.acquire(id, limits) });
  }

  /**
   * @param {string} id 引擎 id（含 'free-chain'）
   * @param {string[]} texts
   * @param {{ target: string, source?: string, cfg?: object, secrets?: object, signal?: AbortSignal }} opts
   * @returns {Promise<{ translations: string[], chars: number, servedBy: string, attempts?: object[] }>}
   */
  async function translateWith(id, texts, opts = {}) {
    const ctx = {
      target: normalizeTarget(opts.target),
      source: normalizeSource(opts.source ?? opts.cfg?.sourceLang),
      cfg: opts.cfg || {},
      secrets: opts.secrets || {},
      signal: opts.signal,
    };
    if (id === 'free-chain') {
      return runChain({
        order: ctx.cfg.chain,
        disabled: ctx.cfg.chainDisabled || [],
        isConfigured: (eid) => isConfigured(eid, ctx.cfg, ctx.secrets),
        health: hp,
        signal: ctx.signal,
        tryEngine: (eid) => translateSingle(eid, texts, ctx),
      });
    }
    const r = await translateSingle(id, texts, ctx);
    return { ...r, servedBy: id };
  }

  return { engines, translateWith, isConfigured, health: hp };
}
