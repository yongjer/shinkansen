// fork/engines/http.js — 機器翻譯引擎共用的 HTTP 呼叫與錯誤分類
//
// 錯誤一律帶 error code（lib/bg-error.js 協定），由 content 端查 'error.bg.<code>'
// 組成使用者看得懂的訊息；服務回的原始錯誤內容放在 params.detail，不被翻譯吞掉。

import { codedError } from '../../lib/bg-error.js';

export const DEFAULT_TIMEOUT_MS = 20_000;

// 錯誤訊息裡的引擎名稱（品牌名各語言通用，背景端不知道使用者的介面語言）
export const ENGINE_NAMES = {
  google: 'Google Translate',
  'microsoft-edge': 'Microsoft Translator',
  azure: 'Azure Translator',
  deepl: 'DeepL',
  deeplx: 'DeepLX',
  'chrome-translator': 'Chrome Translator',
  'free-chain': 'Free engines',
};

export const engineName = (id) => ENGINE_NAMES[id] || String(id);

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return signal;
}

async function readDetail(resp) {
  try {
    const text = await resp.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * 依 HTTP 狀態碼分類錯誤。
 * 401 / 403 → 金鑰錯誤；429 → 請求太頻繁；456（DeepL）/ 403 + quota 字樣 → 額度用盡。
 */
export function httpError(id, status, detail) {
  const engine = engineName(id);
  if (status === 456 || /quota/i.test(detail || '')) {
    return codedError('forkEngineQuota', { engine, status, detail }, `${engine}: quota exceeded (HTTP ${status})`);
  }
  if (status === 401 || status === 403) {
    return codedError('forkEngineAuth', { engine, status, detail }, `${engine}: authentication failed (HTTP ${status})`);
  }
  if (status === 429) {
    return codedError('forkEngineRateLimited', { engine, status, detail }, `${engine}: rate limited (HTTP 429)`);
  }
  return codedError('forkEngineHttp', { engine, status, detail }, `${engine}: HTTP ${status} ${detail || ''}`.trim());
}

export function badResponse(id, detail) {
  const engine = engineName(id);
  return codedError('forkEngineBadResponse', { engine, detail: String(detail || '').slice(0, 300) }, `${engine}: unexpected response`);
}

export function notConfigured(id, field) {
  const engine = engineName(id);
  return codedError('forkEngineNotConfigured', { engine, field }, `${engine}: ${field} is not set`);
}

/**
 * 送出請求並解析回應。responseType: 'json'（預設）或 'text'。
 */
export async function request(fetchImpl, engine, url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, responseType = 'json' } = {}) {
  let resp;
  try {
    resp = await fetchImpl(url, { ...init, signal: combineSignals(signal, timeoutMs) });
  } catch (err) {
    if (signal?.aborted) throw err;
    const reason = err?.name === 'TimeoutError' ? 'timeout' : (err?.message || String(err));
    throw codedError('forkEngineNetwork', { engine: engineName(engine), reason }, `${engine}: network error (${reason})`);
  }
  if (!resp.ok) {
    throw httpError(engine, resp.status, await readDetail(resp));
  }
  if (responseType === 'text') return resp.text();
  try {
    return await resp.json();
  } catch {
    throw badResponse(engine, 'invalid JSON');
  }
}

/** 依筆數與字元上限把文字切成多組，保留原順序。 */
export function chunkTexts(texts, { maxItems, maxChars }) {
  const groups = [];
  let cur = [];
  let chars = 0;
  for (const t of texts) {
    const len = String(t).length;
    if (cur.length && (cur.length >= maxItems || chars + len > maxChars)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += len;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function countChars(texts) {
  return texts.reduce((n, t) => n + String(t).length, 0);
}
