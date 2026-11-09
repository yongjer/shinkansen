// fork/bg/providers.js — 額外 OpenAI 相容服務
//
// 上游只有一組「自訂模型」（settings.customProvider）。驛傳讓使用者另外設定多組，
// 由翻譯預設指定使用哪一組。content 端沿用上游 openai-compat 路徑，只把
// modelOverride 設成 'fork-cp:<id>'（上游在 openai-compat 路徑不使用 modelOverride，
// 而且這個值會隨 translationContext 一路帶到 rescan / SPA 續翻）。
//
// 背景端收到後，用上游 handleTranslateCustom 的 cpOverrides 參數把 baseUrl / model /
// 金鑰 / prompt / 計價換成這一組，術語表、禁用詞、快取、計費全部沿用上游同一條管線。
// 快取 key 由上游依 baseUrl hash + model 分區，不同服務不會互相污染。

import { codedError } from '../../lib/bg-error.js';
import { PROVIDER_PREFIX } from '../settings/schema.js';

export function isForkProviderPayload(payload) {
  return typeof payload?.modelOverride === 'string' && payload.modelOverride.startsWith(PROVIDER_PREFIX);
}

/**
 * 組出 cpOverrides 與 keyExtras。
 * @param {object} provider  fork 設定裡的一組服務
 * @param {string} apiKey
 * @param {string} customPrompt  使用者自訂 prompt（空字串 = 用預設翻譯 prompt）
 * @param {string} targetLanguage
 * @param {Function} getEffectiveSystemPrompt 上游 lib/storage.js 的同名函式
 */
export function buildProviderOverrides(provider, apiKey, customPrompt, targetLanguage, getEffectiveSystemPrompt) {
  const effectivePrompt = getEffectiveSystemPrompt(targetLanguage, customPrompt || '');
  return {
    overrides: {
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: apiKey || '',
      systemPrompt: effectivePrompt,
      temperature: provider.temperature ?? null,
      inputPerMTok: provider.inputPerMTok || 0,
      outputPerMTok: provider.outputPerMTok || 0,
      cachedDiscount: null,
      thinkingLevel: provider.thinkingLevel || 'off',
      extraBodyJson: '',
    },
    keyExtras: { customPrompt: customPrompt ? effectivePrompt : '' },
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.handleTranslateCustom  上游 background.js 的同名函式
 * @param {Function} deps.getEffectiveSystemPrompt
 * @param {Function} deps.getTarget   () => Promise<string>
 * @param {Function} deps.readFork    () => Promise<object>
 * @param {Function} deps.readSecrets () => Promise<object>
 * @param {Function} deps.readPrompts () => Promise<object>
 */
export function createProviderBatchHandler(deps) {
  return async function handleProviderBatch(payload, sender) {
    const id = payload.modelOverride.slice(PROVIDER_PREFIX.length);
    const [fork, secrets, prompts, target] = await Promise.all([
      deps.readFork(), deps.readSecrets(), deps.readPrompts(), deps.getTarget(),
    ]);
    const provider = (fork.providers || []).find((p) => p.id === id);
    if (!provider) throw codedError('forkProviderMissing', { id }, `OpenAI-compatible service not found: ${id}`);
    if (!provider.baseUrl) throw codedError('baseUrlMissing', null, 'Base URL is not set.');
    const { overrides, keyExtras } = buildProviderOverrides(
      provider, secrets.providerKeys?.[id] || '', prompts[id] || '', target, deps.getEffectiveSystemPrompt,
    );
    return deps.handleTranslateCustom({ ...payload, modelOverride: null }, sender, '_oc', overrides, true, true, keyExtras);
  };
}
