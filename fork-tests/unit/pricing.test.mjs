import {
  getPricingForModel, resolveScheduledPricing, getModalityPricing, estimateAudioTokens,
  usageFromMetadata, computeModalityCostUSD, MODALITY_MODEL_PRICING, AUDIO_TOKENS_PER_SECOND,
} from '../../shinkansen/lib/model-pricing.js';

// 美西時間 2027-01-01 00:00 = UTC 08:00
const BEFORE = Date.parse('2027-01-01T07:59:59Z');
const AFTER = Date.parse('2027-01-01T08:00:00Z');

describe('計價表生效日期', () => {
  test('gemini-3.8-flash：2026-12-31 前促銷價，2027-01-01 起 1.50 / 7.50', () => {
    expect(getPricingForModel('gemini-3.8-flash', null, BEFORE)).toMatchObject({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
    expect(getPricingForModel('gemini-3.8-flash', null, AFTER)).toMatchObject({ inputPerMTok: 1.50, outputPerMTok: 7.50 });
  });

  test('使用者覆蓋價格優先於排程', () => {
    const settings = { modelPricingOverrides: { 'gemini-3.8-flash': { inputPerMTok: 9, outputPerMTok: 9 } } };
    expect(getPricingForModel('gemini-3.8-flash', settings, AFTER)).toMatchObject({ inputPerMTok: 9, outputPerMTok: 9 });
  });

  test('沒有 schedule 的模型原樣回傳；結果不含 schedule 欄位', () => {
    const p = getPricingForModel('gemini-3.1-flash-lite', null, AFTER);
    expect(p).toMatchObject({ inputPerMTok: 0.25, outputPerMTok: 1.50 });
    expect(resolveScheduledPricing({ a: 1, schedule: [{ from: '2000-01-01', a: 2 }] }, AFTER)).toEqual({ a: 2 });
    expect(resolveScheduledPricing(null)).toBeNull();
  });

  test('多段排程依日期依序套用，日期格式錯誤的段落不生效', () => {
    const entry = { x: 1, schedule: [{ from: '2030-01-01', x: 3 }, { from: '2028-01-01', x: 2 }, { from: 'garbage', x: 99 }] };
    expect(resolveScheduledPricing(entry, Date.parse('2029-06-01T00:00:00Z'))).toEqual({ x: 2 });
    expect(resolveScheduledPricing(entry, Date.parse('2031-01-01T00:00:00Z'))).toEqual({ x: 3 });
  });
});

describe('多模態計價（語音模型）', () => {
  test('TTS 價格：2026 年底前 0.50 / 9，之後 1.00 / 18', () => {
    expect(getModalityPricing('gemini-3.8-flash-tts', BEFORE)).toMatchObject({ input: { text: 0.5 }, output: { audio: 9 } });
    expect(getModalityPricing('gemini-3.8-flash-tts', AFTER)).toMatchObject({ input: { text: 1 }, output: { audio: 18 } });
    expect(getModalityPricing('gemini-3.8-flash-lite-tts', BEFORE)).toMatchObject({ output: { audio: 6 } });
    expect(getModalityPricing('gemini-3.8-flash-lite-tts', AFTER)).toMatchObject({ output: { audio: 12 } });
  });

  test('即時轉錄與即時口譯', () => {
    expect(getModalityPricing('gemini-3.5-transcribe-live')).toMatchObject({ input: { audio: 3.5 }, output: { text: 21 } });
    expect(getModalityPricing('gemini-3.5-live-translate-preview')).toMatchObject({ input: { audio: 3.5 }, output: { audio: 21 } });
    expect(Object.keys(MODALITY_MODEL_PRICING)).toHaveLength(4);
  });

  test('音訊秒數換算 token（每秒 25）', () => {
    expect(AUDIO_TOKENS_PER_SECOND).toBe(25);
    expect(estimateAudioTokens(10)).toBe(250);
    expect(estimateAudioTokens(0.01)).toBe(1);
    expect(estimateAudioTokens(-1)).toBe(0);
    expect(estimateAudioTokens('x')).toBe(0);
  });

  test('usageMetadata 依模態明細分類，沒有明細時歸到 fallback', () => {
    const u = usageFromMetadata({
      promptTokenCount: 100,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 40 }, { modality: 'AUDIO', tokenCount: 60 }],
      candidatesTokenCount: 500,
    }, { outputFallback: 'audio' });
    expect(u.input).toEqual({ text: 40, audio: 60, image: 0 });
    expect(u.output).toEqual({ text: 0, audio: 500, image: 0 });
    expect(usageFromMetadata(null).input).toEqual({ text: 0, audio: 0, image: 0 });
  });

  test('費用計算：1M 文字輸入 + 1M 音訊輸出 = 0.5 + 9 美元', () => {
    const usage = { input: { text: 1e6 }, output: { audio: 1e6 } };
    expect(computeModalityCostUSD('gemini-3.8-flash-tts', usage, BEFORE)).toBeCloseTo(9.5, 6);
    expect(computeModalityCostUSD('gemini-3.8-flash-tts', usage, AFTER)).toBeCloseTo(19, 6);
    // TTS 沒列音訊輸入價時，以同方向第一個價格計，不少算
    expect(computeModalityCostUSD('gemini-3.8-flash-tts', { input: { audio: 1e6 } }, BEFORE)).toBeCloseTo(0.5, 6);
    expect(computeModalityCostUSD('unknown-model', usage)).toBeNull();
  });
});
