// fork/engines/microsoft.js — 微軟翻譯：免金鑰（Edge 內建翻譯端點）與 Azure Translator（官方）
//
// 免金鑰模式：
//   GET  https://edge.microsoft.com/translate/auth  → 取得短效 JWT
//   POST https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=…
//   這是 Edge 瀏覽器內建翻譯使用的端點，**不是公開 API，可能失效、沒有 SLA**。
//
// Azure Translator（官方，需要金鑰）：
//   POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=…
//   headers: Ocp-Apim-Subscription-Key（+ 區域資源需要 Ocp-Apim-Subscription-Region）
//   文件：https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate
//
// 兩者回應格式相同。單次請求上限 1000 筆 / 50,000 字元，這裡保守切成 100 筆 / 40,000 字元。
// 用 textType=html 讓服務保留 【N】 換成的標籤（見 markers.js）。

import { request, chunkTexts, countChars, badResponse, notConfigured } from './http.js';
import { markersToXml, xmlToMarkers } from './markers.js';
import { microsoftTarget, microsoftSource } from './lang.js';

const EDGE_AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const EDGE_TRANSLATE_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate';
export const AZURE_DEFAULT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';

const CHUNK = { maxItems: 100, maxChars: 40_000 };

function buildUrl(base, { target, source }) {
  const u = new URL(base);
  u.searchParams.set('api-version', '3.0');
  u.searchParams.set('to', microsoftTarget(target));
  const from = microsoftSource(source);
  if (from) u.searchParams.set('from', from);
  u.searchParams.set('textType', 'html');
  return u.toString();
}

function parseTranslations(engine, json, expected) {
  if (!Array.isArray(json) || json.length !== expected) {
    throw badResponse(engine, JSON.stringify(json).slice(0, 200));
  }
  return json.map((item) => {
    const text = item?.translations?.[0]?.text;
    if (typeof text !== 'string') throw badResponse(engine, JSON.stringify(item).slice(0, 200));
    return xmlToMarkers(text);
  });
}

/** JWT 的 exp（秒）；解析失敗回 null。 */
export function jwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return Number.isFinite(json.exp) ? json.exp : null;
  } catch {
    return null;
  }
}

export function createMicrosoftEdgeEngine({ fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let token = null;
  let tokenExpiresAt = 0;

  async function getToken(signal) {
    if (token && now() < tokenExpiresAt - 60_000) return token;
    const text = await request(fetchImpl, 'microsoft-edge', EDGE_AUTH_URL, { method: 'GET' }, { signal, responseType: 'text' });
    const t = String(text || '').trim();
    if (!t || t.split('.').length !== 3) throw badResponse('microsoft-edge', 'auth token');
    const exp = jwtExpiry(t);
    token = t;
    // 解析不到 exp 時保守當作 8 分鐘有效（實測 token 約 10 分鐘）
    tokenExpiresAt = exp ? exp * 1000 : now() + 8 * 60_000;
    return token;
  }

  return {
    id: 'microsoft-edge',
    official: false,
    needsKey: false,
    isConfigured: () => true,
    async translate(texts, { target, source, signal, acquire = async () => {} }) {
      const out = [];
      for (const group of chunkTexts(texts, CHUNK)) {
        const auth = await getToken(signal);
        await acquire();
        const json = await request(fetchImpl, 'microsoft-edge', buildUrl(EDGE_TRANSLATE_URL, { target, source }), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
          body: JSON.stringify(group.map((t) => ({ Text: markersToXml(t) }))),
        }, { signal });
        out.push(...parseTranslations('microsoft-edge', json, group.length));
      }
      return { translations: out, chars: countChars(texts) };
    },
    // 測試用：清掉快取的 token
    _resetToken() { token = null; tokenExpiresAt = 0; },
  };
}

export function createAzureEngine({ fetchImpl = (...a) => fetch(...a) } = {}) {
  return {
    id: 'azure',
    official: true,
    needsKey: true,
    isConfigured: (_cfg, secrets) => !!secrets?.azureKey,
    async translate(texts, { target, source, cfg, secrets, signal, acquire = async () => {} }) {
      const key = secrets?.azureKey;
      if (!key) throw notConfigured('azure', 'apiKey');
      const endpoint = String(cfg?.azure?.endpoint || AZURE_DEFAULT_ENDPOINT).replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key };
      if (cfg?.azure?.region) headers['Ocp-Apim-Subscription-Region'] = cfg.azure.region;
      const out = [];
      for (const group of chunkTexts(texts, CHUNK)) {
        await acquire();
        const json = await request(fetchImpl, 'azure', buildUrl(`${endpoint}/translate`, { target, source }), {
          method: 'POST',
          headers,
          body: JSON.stringify(group.map((t) => ({ Text: markersToXml(t) }))),
        }, { signal });
        out.push(...parseTranslations('azure', json, group.length));
      }
      return { translations: out, chars: countChars(texts) };
    },
  };
}
