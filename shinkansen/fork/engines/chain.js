// fork/engines/chain.js — 免費引擎依序備援（預設：微軟 → DeepLX → Google）
//
// 依使用者設定的順序逐一嘗試；某家失敗就改送下一家。**同一段文字因此可能送往多家服務**，
// 這是使用者在設定頁明確啟用並排好順序的行為，設定頁會說明。
//
// 健康紀錄：同一引擎連續失敗達門檻（預設 2 次）就冷卻一段時間（預設 5 分鐘），
// 冷卻中先跳過；若其他引擎全都失敗，最後仍會再試一次冷卻中的引擎，避免整條鏈直接放棄。
// 紀錄只存在背景 service worker 的記憶體，重啟後歸零。

// 可以放進備援鏈的引擎：免費、不需金鑰、在背景執行
export const CHAIN_CANDIDATES = ['microsoft-edge', 'deeplx', 'google'];
export const DEFAULT_CHAIN = ['microsoft-edge', 'deeplx', 'google'];

export function normalizeChain(order) {
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (CHAIN_CANDIDATES.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  // 沒列到的候選補在最後，維持「每個候選都有位置」，啟用與否由 disabled 決定
  for (const id of CHAIN_CANDIDATES) if (!seen.has(id)) out.push(id);
  return out;
}

export function createHealth({ now = () => Date.now(), threshold = 2, cooldownMs = 5 * 60_000 } = {}) {
  const state = new Map(); // id → { failures, cooldownUntil, lastError }
  const get = (id) => state.get(id) || { failures: 0, cooldownUntil: 0, lastError: '' };
  return {
    recordSuccess(id) {
      state.set(id, { failures: 0, cooldownUntil: 0, lastError: '' });
    },
    recordFailure(id, error) {
      const s = get(id);
      const failures = s.failures + 1;
      state.set(id, {
        failures,
        cooldownUntil: failures >= threshold ? now() + cooldownMs : s.cooldownUntil,
        lastError: String(error?.message || error || '').slice(0, 200),
      });
    },
    isCoolingDown(id) {
      return get(id).cooldownUntil > now();
    },
    snapshot() {
      return Object.fromEntries([...state.entries()].map(([id, s]) => [id, { ...s, coolingDown: s.cooldownUntil > now() }]));
    },
  };
}

/**
 * 依序嘗試。tryEngine(id) 回傳 { translations, chars } 或丟錯。
 * @returns {Promise<{ translations: string[], chars: number, servedBy: string, attempts: Array<{engine: string, error: string}> }>}
 */
export async function runChain({ order, disabled = [], isConfigured, health, tryEngine, signal }) {
  const candidates = normalizeChain(order).filter((id) => !disabled.includes(id) && isConfigured(id));
  if (candidates.length === 0) {
    const err = new Error('free-chain: no engine available');
    err.skCode = 'forkChainEmpty';
    err.skParams = null;
    throw err;
  }
  const attempts = [];
  const skipped = [];
  let lastError = null;

  const attempt = async (id) => {
    try {
      const r = await tryEngine(id);
      health.recordSuccess(id);
      return { ...r, servedBy: id, attempts };
    } catch (err) {
      if (signal?.aborted) throw err;
      health.recordFailure(id, err);
      attempts.push({ engine: id, error: String(err?.message || err).slice(0, 200) });
      lastError = err;
      return null;
    }
  };

  for (const id of candidates) {
    if (health.isCoolingDown(id)) {
      skipped.push(id);
      continue;
    }
    const r = await attempt(id);
    if (r) return r;
  }
  for (const id of skipped) {
    const r = await attempt(id);
    if (r) return r;
  }
  const err = new Error(`free-chain: all engines failed (${attempts.map((a) => a.engine).join(', ')})`);
  err.skCode = 'forkChainAllFailed';
  err.skParams = { detail: attempts.map((a) => `${a.engine}: ${a.error}`).join(' / ').slice(0, 300) };
  err.cause = lastError;
  throw err;
}
