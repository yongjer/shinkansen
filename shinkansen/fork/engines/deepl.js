// fork/engines/deepl.js — DeepL API（官方）與 DeepLX（使用者自填的端點）
//
// DeepL API：
//   POST https://api-free.deepl.com/v2/translate（金鑰以 ':fx' 結尾 = Free 方案）
//   POST https://api.deepl.com/v2/translate（Pro 方案）
//   header: Authorization: DeepL-Auth-Key <key>
//   單次最多 50 段、請求總大小 128 KiB；tag_handling=xml 保留 【N】 換成的標籤。
//   文件：https://developers.deepl.com/api-reference/translate
//
// DeepLX：社群重新實作的 DeepL 網頁版介面，**非官方、可能失效、沒有 SLA**。
//   驛傳不內建任何公開實例，也不使用 DeepL 的匿名端點，只連使用者自己填的網址。
//   POST <url>  JSON { text, source_lang, target_lang }，回應 { code: 200, data: "譯文" }
//   每次只翻一段，所以逐段送出（受速率限制控管）。

import { request, chunkTexts, countChars, badResponse, notConfigured } from './http.js';
import { markersToXml, xmlToMarkers } from './markers.js';
import { deeplTarget, deeplSource } from './lang.js';

export const DEEPL_FREE_URL = 'https://api-free.deepl.com/v2/translate';
export const DEEPL_PRO_URL = 'https://api.deepl.com/v2/translate';

export function deeplEndpointForKey(key) {
  return String(key || '').trim().endsWith(':fx') ? DEEPL_FREE_URL : DEEPL_PRO_URL;
}

export function createDeeplEngine({ fetchImpl = (...a) => fetch(...a) } = {}) {
  return {
    id: 'deepl',
    official: true,
    needsKey: true,
    isConfigured: (_cfg, secrets) => !!secrets?.deeplKey,
    async translate(texts, { target, source, secrets, signal, acquire = async () => {} }) {
      const key = String(secrets?.deeplKey || '').trim();
      if (!key) throw notConfigured('deepl', 'apiKey');
      const url = deeplEndpointForKey(key);
      const out = [];
      for (const group of chunkTexts(texts, { maxItems: 50, maxChars: 30_000 })) {
        const body = {
          text: group.map(markersToXml),
          target_lang: deeplTarget(target),
          tag_handling: 'xml',
        };
        const src = deeplSource(source);
        if (src) body.source_lang = src;
        await acquire();
        const json = await request(fetchImpl, 'deepl', url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` },
          body: JSON.stringify(body),
        }, { signal });
        const list = json?.translations;
        if (!Array.isArray(list) || list.length !== group.length) {
          throw badResponse('deepl', JSON.stringify(json).slice(0, 200));
        }
        out.push(...list.map((x) => {
          if (typeof x?.text !== 'string') throw badResponse('deepl', JSON.stringify(x).slice(0, 200));
          return xmlToMarkers(x.text);
        }));
      }
      return { translations: out, chars: countChars(texts) };
    },
  };
}

export function isValidDeeplxUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function createDeeplxEngine({ fetchImpl = (...a) => fetch(...a), concurrency = 3 } = {}) {
  async function translateOne(text, { url, token, target, source, signal }) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const json = await request(fetchImpl, 'deeplx', url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text,
        source_lang: deeplSource(source) || 'auto',
        target_lang: deeplTarget(target),
      }),
    }, { signal });
    if (json?.code !== undefined && Number(json.code) !== 200) {
      throw badResponse('deeplx', JSON.stringify(json).slice(0, 200));
    }
    if (typeof json?.data !== 'string') throw badResponse('deeplx', JSON.stringify(json).slice(0, 200));
    return json.data;
  }

  return {
    id: 'deeplx',
    official: false,
    needsKey: false,
    isConfigured: (cfg) => isValidDeeplxUrl(cfg?.deeplx?.url),
    async translate(texts, { target, source, cfg, secrets, signal, acquire = async () => {} }) {
      const url = String(cfg?.deeplx?.url || '').trim();
      if (!isValidDeeplxUrl(url)) throw notConfigured('deeplx', 'url');
      const token = secrets?.deeplxToken || '';
      const out = new Array(texts.length);
      let next = 0;
      const worker = async () => {
        while (next < texts.length) {
          const i = next++;
          await acquire();
          out[i] = await translateOne(texts[i], { url, token, target, source, signal });
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
      return { translations: out, chars: countChars(texts) };
    },
  };
}
