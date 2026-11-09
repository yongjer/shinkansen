// model-pricing.js — Gemini 模型計價表（Standard tier，USD per 1M tokens）
// 來源：https://ai.google.dev/gemini-api/docs/pricing
// 結構對齊 settings.pricing，可直接當 effectivePricing 使用。
//
// v1.4.12：preset 快速鍵按 modelOverride 觸發翻譯時，由 background.js handleTranslate
// 依當下 model 查此表覆蓋 settings.pricing，讓 toast 顯示的費用與 usage log 跟 model 走。
// 使用者若在 options 頁有自訂 settings.pricing，該值在「沒有 modelOverride」時仍會被使用。
//
// v1.6.14:加入 LAST_CALIBRATED_DATE + settings.modelPricingOverrides。
// Google 改價時內建表會過時,使用者可在「Gemini 分頁 → 模型計價」逐模型覆蓋。
// getPricingForModel 簽名加 settings 參數,先查 override 再 fallback 內建。
//
// v1.9.2:加入 cachedDiscount(0-1,cache 命中省下的比例)。Gemini 2.5+ 起 implicit
// cache 命中折扣為 90%(命中部分付 10%)→ 預設 0.90。早於 v1.9.2 的版本硬編 0.75
// (Gemini 2.0 時代),會讓 cache 命中部分被高估 1.5×。input/output 與 cachedDiscount
// 三者於 override 表獨立 fallback——使用者可只覆蓋折扣不覆蓋價格,反之亦然。
export const DEFAULT_GEMINI_CACHED_DISCOUNT = 0.90;

export const MODEL_PRICING = {
  'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.50, cachedDiscount: DEFAULT_GEMINI_CACHED_DISCOUNT },
  // v2.0.64:官方定價頁明示 3.5 Flash-Lite 不提供 context caching → cachedDiscount 0
  // (API 不會回報 cached tokens,設 0 讓萬一出現的 cached 部分照全價計,不虛報折扣)
  'gemini-3.5-flash-lite': { inputPerMTok: 0.30, outputPerMTok: 2.50, cachedDiscount: 0 },
  'gemini-3-flash-preview':        { inputPerMTok: 0.50, outputPerMTok: 3.00, cachedDiscount: DEFAULT_GEMINI_CACHED_DISCOUNT },
  // v2.0.64:gemini-3.5-flash 下架(遷移至 3.6-flash);2026-08-20:gemini-3.6-flash 下架
  // (遷移至 3.7-flash);2026-09-03:gemini-3.7-flash 下架
  // (migrateGemini37FlashModelIfNeeded 遷移至 3.8-flash;歷史用量費用寫入當下已存
  // billedCostUSD,不受查表影響)。
  // gemini-3.8-flash:官方促銷價 $0.75 / $3.75 至 2026-12-31,
  // 2027-01-01 起回 $1.50 / $7.50——屆時更新此列 + options 選單價格標示。
  // context cache $0.075 = input 10% → 折扣走 DEFAULT。
  'gemini-3.8-flash':              { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedDiscount: DEFAULT_GEMINI_CACHED_DISCOUNT,
    // [Ekiden fork] 生效日期排程：到期自動改用新價，不必等發版改這一列（見 resolveScheduledPricing）
    schedule: [{ from: '2027-01-01', inputPerMTok: 1.50, outputPerMTok: 7.50 }] },
};

// v1.6.14:內建表校準日期。UI 顯示「(YYYY-MM 校準)」提示使用者可能過時。
// release 時若 Google 公布新價,把這裡更新 + 同步 MODEL_PRICING 數字。
export const LAST_CALIBRATED_DATE = '2026-09';

/**
 * 查模型計價,各欄位獨立 fallback(v1.9.2 起):
 *   inputPerMTok / outputPerMTok / cachedDiscount 三欄各自先查 override 再 fallback 內建表。
 *   使用者可只覆蓋折扣不覆蓋價格,反之亦然。
 *   找不到內建 entry 且 override 沒填整組 → null(呼叫端再走 settings.pricing 全域 fallback)。
 *
 * @param {string} model 模型 ID
 * @param {object|null} settings 完整 settings(可只帶 modelPricingOverrides)
 */
export function getPricingForModel(model, settings = null, at = Date.now()) {
  if (!model) return null;
  const override = settings?.modelPricingOverrides?.[model] || {};
  const builtIn = resolveScheduledPricing(MODEL_PRICING[model] || null, at);
  const oIn = Number(override.inputPerMTok);
  const oOut = Number(override.outputPerMTok);
  const oDisc = Number(override.cachedDiscount);
  const overrideHasPrices = Number.isFinite(oIn) && Number.isFinite(oOut);
  if (!builtIn && !overrideHasPrices) return null;
  return {
    inputPerMTok:  overrideHasPrices ? oIn  : builtIn.inputPerMTok,
    outputPerMTok: overrideHasPrices ? oOut : builtIn.outputPerMTok,
    cachedDiscount: (Number.isFinite(oDisc) && oDisc >= 0 && oDisc <= 1)
      ? oDisc
      : (builtIn?.cachedDiscount ?? DEFAULT_GEMINI_CACHED_DISCOUNT),
  };
}


// ─── [Ekiden fork] 生效日期排程與多模態計價 ─────────────────────────────
// Google 的促銷價有明確到期日（例如 3.8 Flash / 3.8 TTS 到 2026-12-31），內建表只寫一組價格
// 會在到期後少算。entry 可帶 schedule: [{ from: 'YYYY-MM-DD', ...要覆蓋的欄位 }]，
// from 當天起（以美西時間 00:00 計）改用該組數字。
// 來源：https://ai.google.dev/gemini-api/docs/pricing（2026-11-09 校準）

const PRICING_TZ_OFFSET = '-08:00';

function scheduleStart(from) {
  const t = Date.parse(`${from}T00:00:00${PRICING_TZ_OFFSET}`);
  return Number.isFinite(t) ? t : Infinity;
}

/** 依時間點套用 schedule，回傳不含 schedule 欄位的計價物件（null 原樣回傳）。 */
export function resolveScheduledPricing(entry, at = Date.now()) {
  if (!entry) return null;
  const { schedule, ...base } = entry;
  if (!Array.isArray(schedule) || schedule.length === 0) return base;
  let out = base;
  const sorted = [...schedule].sort((a, b) => scheduleStart(a.from) - scheduleStart(b.from));
  for (const step of sorted) {
    if (scheduleStart(step.from) <= at) {
      const { from, ...fields } = step;
      out = { ...out, ...fields };
    }
  }
  return out;
}

// 音訊 token 換算：官方以每秒 25 個 token 計（輸入與輸出相同）
export const AUDIO_TOKENS_PER_SECOND = 25;

// 語音模型（TTS / 即時轉錄 / 即時口譯）各模態分開計價，USD per 1M tokens。
// input / output 底下的 key 是模態：text / audio / image。
// 模型 ID 只在這裡與 fork 設定預設值出現，其他程式一律從這裡讀。
export const MODALITY_MODEL_PRICING = {
  'gemini-3.8-flash-tts': {
    kind: 'tts',
    input: { text: 0.50 },
    output: { audio: 9.00 },
    schedule: [{ from: '2027-01-01', input: { text: 1.00 }, output: { audio: 18.00 } }],
  },
  'gemini-3.8-flash-lite-tts': {
    kind: 'tts',
    input: { text: 0.50 },
    output: { audio: 6.00 },
    schedule: [{ from: '2027-01-01', input: { text: 1.00 }, output: { audio: 12.00 } }],
  },
  'gemini-3.5-transcribe-live': {
    kind: 'asr',
    input: { audio: 3.50 },
    output: { text: 21.00 },
  },
  'gemini-3.5-live-translate-preview': {
    kind: 'live-translate',
    input: { audio: 3.50 },
    output: { audio: 21.00 },
  },
};

export function getModalityPricing(model, at = Date.now()) {
  return resolveScheduledPricing(MODALITY_MODEL_PRICING[model] || null, at);
}

export function estimateAudioTokens(seconds) {
  const s = Number(seconds);
  return Number.isFinite(s) && s > 0 ? Math.ceil(s * AUDIO_TOKENS_PER_SECOND) : 0;
}

const MODALITIES = ['text', 'audio', 'image'];

function emptyModalities() {
  return { text: 0, audio: 0, image: 0 };
}

function addDetails(target, details) {
  if (!Array.isArray(details)) return false;
  let any = false;
  for (const d of details) {
    const m = String(d?.modality || '').toLowerCase();
    const n = Number(d?.tokenCount) || 0;
    if (MODALITIES.includes(m)) {
      target[m] += n;
      any = true;
    }
  }
  return any;
}

/**
 * 把 Gemini 回應的 usageMetadata 轉成 { input: {text,audio,image}, output: {text,audio,image} }。
 * 依模態明細（promptTokensDetails / candidatesTokensDetails / responseTokensDetails）分類；
 * 沒有明細時，總數歸到 fallback 指定的模態。
 */
export function usageFromMetadata(meta, { inputFallback = 'text', outputFallback = 'text' } = {}) {
  const input = emptyModalities();
  const output = emptyModalities();
  if (!meta || typeof meta !== 'object') return { input, output };
  if (!addDetails(input, meta.promptTokensDetails)) {
    input[inputFallback] += Number(meta.promptTokenCount) || 0;
  }
  const outDetails = meta.candidatesTokensDetails || meta.responseTokensDetails;
  if (!addDetails(output, outDetails)) {
    output[outputFallback] += (Number(meta.candidatesTokenCount) || Number(meta.responseTokenCount) || 0);
  }
  // 思考 token 以輸出價計（與上游 Gemini 文字模型的計費慣例一致）
  output[outputFallback] += Number(meta.thoughtsTokenCount) || 0;
  return { input, output };
}

/**
 * 依模態計算費用（USD）。沒有該模態價格的 token 以同方向第一個有價格的模態計，
 * 避免少算（例如 TTS 輸入只列 text 價）。找不到模型回傳 null。
 */
export function computeModalityCostUSD(model, usage, at = Date.now()) {
  const p = getModalityPricing(model, at);
  if (!p) return null;
  const side = (prices, counts) => {
    const fallbackRate = Object.values(prices || {})[0] || 0;
    let usd = 0;
    for (const m of MODALITIES) {
      const n = Number(counts?.[m]) || 0;
      if (!n) continue;
      const rate = prices?.[m] ?? fallbackRate;
      usd += (n / 1e6) * rate;
    }
    return usd;
  };
  return side(p.input, usage?.input) + side(p.output, usage?.output);
}
