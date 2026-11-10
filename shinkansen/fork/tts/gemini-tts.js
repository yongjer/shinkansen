// fork/tts/gemini-tts.js — Gemini 3.8 TTS（Interactions API）的請求與回應
//
// 格式依官方文件（2026-11-09 查閱 https://ai.google.dev/gemini-api/docs/speech-generation）：
//   POST https://generativelanguage.googleapis.com/v1beta/interactions
//   header x-goog-api-key（金鑰不放 URL）
//   {
//     model, store: false,
//     input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
//     response_format: { type: 'audio' },
//     generation_config: { speech_config: [{ voice }] }
//   }
//   回應：steps[] 裡 type 'model_output' 的 content[] 中 type 'audio' 的 data（base64）。
//   非串流請求預設回傳含 RIFF header 的 WAV（24 kHz、單聲道、16-bit），直接播放，不另外包 header。
//
// 3.8 TTS 會把 text 當逐字稿照唸：語速、語氣只能放在 speech_metadata.style，不能寫進 text。
// store: false —— Interactions API 預設會在伺服器保存互動紀錄（付費 55 天 / 免費 1 天），朗讀不需要。

export const TTS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// 播放模式 → speech_metadata.style（只描述說話方式，不會被唸出來）
export const TTS_STYLES = Object.freeze({
  normal: 'Natural, clear delivery at a normal conversational pace, like a language teacher modelling the sentence.',
  slow: 'Speaking slowly and very clearly, articulating every syllable, with a short pause between words, like a language teacher helping a learner hear each sound.',
});

// 官方列出的 30 個預設聲音（https://ai.google.dev/gemini-api/docs/speech-generation#prebuilt-voices）
export const PREBUILT_VOICES = Object.freeze([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]);
export const DEFAULT_VOICE = 'Kore';

// 一次最多朗讀的字元數（控制費用；Flash-Lite TTS 輸入上限 8192 tokens，遠高於此）
export const MAX_TTS_CHARS = 1500;

// 頁面文字裡像 <short pause> 的片段會被 TTS 當成行內標籤，朗讀前拿掉
const INLINE_TAG_LIKE = /<\s*[a-z][a-z \-]{0,40}>/gi;

export function cleanTtsText(text) {
  return String(text || '')
    .replace(INLINE_TAG_LIKE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TTS_CHARS);
}

export function buildTtsRequest({ model, text, voice = DEFAULT_VOICE, style = TTS_STYLES.normal }) {
  if (!model) throw new Error('tts: model required');
  const v = PREBUILT_VOICES.includes(voice) ? voice : DEFAULT_VOICE;
  const content = { type: 'text', text };
  if (style) content.annotations = [{ type: 'speech_metadata', style }];
  return {
    model,
    store: false,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: v }] },
  };
}

function modalityCounts(list) {
  const out = { text: 0, audio: 0, image: 0 };
  let any = false;
  if (Array.isArray(list)) {
    for (const d of list) {
      const m = String(d?.modality || '').toLowerCase();
      const n = Number(d?.tokens ?? d?.token_count ?? d?.tokenCount) || 0;
      if (m in out) {
        out[m] += n;
        any = true;
      }
    }
  }
  return { counts: out, any };
}

/**
 * Interactions API 的 usage → { input: {text,audio,image}, output: {text,audio,image} }
 * （與 lib/model-pricing.js usageFromMetadata 同形狀，交給 computeModalityCostUSD 計價）
 */
export function usageFromInteraction(usage, { inputFallback = 'text', outputFallback = 'audio' } = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const inp = modalityCounts(u.input_tokens_by_modality);
  const out = modalityCounts(u.output_tokens_by_modality);
  if (!inp.any) inp.counts[inputFallback] += Number(u.total_input_tokens) || 0;
  if (!out.any) out.counts[outputFallback] += Number(u.total_output_tokens) || 0;
  out.counts.text += Number(u.total_thought_tokens) || 0;
  return { input: inp.counts, output: out.counts };
}

/** 從回應取出最後一段音訊。找不到回傳 null。 */
export function parseTtsResponse(json) {
  if (!json || typeof json !== 'object') return null;
  let audio = null;
  const steps = Array.isArray(json.steps) ? json.steps : [];
  for (const step of steps) {
    if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const c of step.content) {
      if (c?.type === 'audio' && typeof c.data === 'string' && c.data) audio = c;
    }
  }
  // SDK 的 output_audio 便利欄位（REST 回應不一定有）
  if (!audio && json.output_audio && typeof json.output_audio.data === 'string') audio = json.output_audio;
  if (!audio) return null;
  return {
    data: audio.data,
    mimeType: audio.mime_type || audio.mimeType || 'audio/wav',
    usage: usageFromInteraction(json.usage),
  };
}

function ttsError(code, params, message) {
  const err = new Error(message);
  err.skCode = code;
  err.skParams = params || null;
  return err;
}

/**
 * 呼叫 TTS。fetcher 由呼叫端提供（背景端用上游 lib/llm-common.js fetchWithRetry），
 * 形狀 (url, body, { headers }) => Promise<Response>。
 */
export async function synthesize({ apiKey, model, text, voice, style, fetcher }) {
  if (!apiKey) throw ttsError('apiKeyMissing', null, 'Gemini API key is missing');
  const body = buildTtsRequest({ model, text, voice, style });
  const resp = await fetcher(TTS_ENDPOINT, body, { headers: { 'x-goog-api-key': apiKey } });
  let json = null;
  let raw = '';
  try {
    raw = await resp.text();
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!resp.ok) {
    // API 自帶的 error.message 是英文原文，照上游慣例原樣傳遞
    const detail = json?.error?.message || raw.slice(0, 200) || `HTTP ${resp.status}`;
    throw ttsError('forkTtsHttp', { status: resp.status, detail }, detail);
  }
  const parsed = parseTtsResponse(json);
  if (!parsed) throw ttsError('forkTtsNoAudio', null, 'TTS response contained no audio');
  return parsed;
}
