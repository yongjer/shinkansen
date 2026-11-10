// fork/bg/mt-batch.js — 驛傳機器翻譯引擎的批次處理
//
// 結構對齊上游 background.js 的 handleTranslateGoogle（快取 → 缺的才打 API → 寫快取 →
// 記用量 → 合併），差別只在：
//   - 引擎由註冊表決定（fork/engines/registry.js）
//   - 快取 key 後綴 '_mt_<引擎>'，加上目標語言與來源語言分區，不與上游 '_gt' 混用
//   - 用量以字元計（billingUnit: 'chars'），記錄實際服務的引擎與耗時
//
// 回傳形狀與 handleTranslateGoogle 相同，content 端的 translateUnitsGoogle 不需區分。
// payload.forkTarget（選填，劃詞卡片用）：覆蓋目標語言，快取 key 也跟著分區。

import { codedError } from '../../lib/bg-error.js';
import { isMtEngineId } from '../engines/registry.js';
import { TARGET_LANGS } from '../engines/lang.js';

export function mtCacheSuffix(engineId, target, source) {
  let s = '_mt_' + engineId.replace(/[^a-z0-9]/gi, '');
  if (target && target !== 'zh-TW') s += '_lang' + target.replace(/[^a-z0-9]/gi, '');
  if (source && source !== 'auto') s += '_src' + source.replace(/[^a-z0-9]/gi, '');
  return s;
}

/**
 * @param {object} deps
 * @param {object} deps.registry       createEngineRegistry() 的結果
 * @param {object} deps.cache          { getBatch(texts, suffix), setBatch(texts, results, suffix) }
 * @param {Function} deps.logUsage     (record) => Promise
 * @param {Function} deps.getTarget    () => Promise<string>  上游 settings.targetLanguage
 * @param {Function} deps.readFork     () => Promise<object>  合併後的 fork 設定
 * @param {Function} deps.readSecrets  () => Promise<object>
 * @param {Function} [deps.log]        (level, msg, data) => void
 * @param {Function} [deps.now]
 */
export function createMtBatchHandler(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});

  return async function handleMtBatch(payload, sender) {
    const engineId = payload?.mtEngine;
    if (!isMtEngineId(engineId)) {
      throw codedError('forkEngineUnknown', { engine: String(engineId) }, `unknown engine: ${engineId}`);
    }
    const texts = payload?.texts;
    if (!Array.isArray(texts) || texts.length === 0) {
      return { result: [], usage: { engine: engineId, chars: 0, cacheHits: 0 } };
    }

    const [settingsTarget, fork, secrets] = await Promise.all([deps.getTarget(), deps.readFork(), deps.readSecrets()]);
    // 劃詞卡片的雙向翻譯：選取的文字已是目標語言時，指定翻成另一種語言。
    // 這時原文就是平常的目標語言，固定的來源語言設定不適用，改成自動偵測。
    const override = TARGET_LANGS.includes(payload?.forkTarget) ? payload.forkTarget : '';
    const target = override || settingsTarget;
    const cfg = override ? { ...(fork.mt || {}), sourceLang: 'auto' } : (fork.mt || {});
    const suffix = mtCacheSuffix(engineId, target, cfg.sourceLang);

    const cached = await deps.cache.getBatch(texts, suffix);
    const missingIdxs = [];
    const missingTexts = [];
    cached.forEach((tr, i) => {
      if (tr == null) {
        missingIdxs.push(i);
        missingTexts.push(texts[i]);
      }
    });
    const cacheHits = texts.length - missingTexts.length;

    let fresh = [];
    let chars = 0;
    let servedBy = engineId;
    if (missingTexts.length > 0) {
      const t0 = now();
      let r;
      try {
        r = await deps.registry.translateWith(engineId, missingTexts, { target, cfg, secrets });
      } catch (err) {
        log('error', 'fork mt batch failed', { engine: engineId, count: missingTexts.length, error: err?.message || String(err) });
        throw err;
      }
      const durationMs = now() - t0;
      if (!Array.isArray(r.translations) || r.translations.length !== missingTexts.length) {
        throw codedError('forkEngineBadResponse', { engine: engineId, detail: 'count mismatch' }, `${engineId}: result count mismatch`);
      }
      fresh = r.translations;
      chars = r.chars || 0;
      servedBy = r.servedBy || engineId;
      log('info', 'fork mt batch done', {
        engine: engineId, servedBy, count: missingTexts.length, chars, durationMs, attempts: r.attempts?.length || 0,
      });

      await deps.cache.setBatch(missingTexts, fresh, suffix);

      // 免費 / 自備金鑰的服務，費用依各自方案而定，這裡不估算金額（billedCostUSD 0），只記字元數
      try {
        await deps.logUsage({
          url: sender?.tab?.url || '',
          title: '',
          engine: servedBy,
          model: engineId === 'free-chain' ? `free-chain:${servedBy}` : engineId,
          billingUnit: 'chars',
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          billedInputTokens: 0,
          billedCostUSD: 0,
          chars,
          segments: missingTexts.length,
          cacheHits,
          durationMs,
          timestamp: now(),
        });
      } catch (err) {
        log('warn', 'fork mt usage log failed', { error: err?.message || String(err) });
      }
    }

    const result = cached.slice();
    missingIdxs.forEach((idx, k) => { result[idx] = fresh[k]; });
    return { result, usage: { engine: engineId, servedBy, chars, cacheHits } };
  };
}
