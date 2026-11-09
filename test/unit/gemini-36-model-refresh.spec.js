// Unit test: v2.0.64 模型清單更新——gemini-3.5-flash 下架,gemini-3.5-flash-lite /
// gemini-3.6-flash 上架
//
// 鎖四件事:
//   (1) migrateGemini35FlashModelIfNeeded:存了 'gemini-3.5-flash' 的使用者設定
//       改寫成 'gemini-3.6-flash'(欄位矩陣細節由 gemini-flash-lite-model-migration
//       .spec.js 鎖共用實作,這裡鎖新舊 ID 接線與精確比對)
//   (2) 精確字串比對:'gemini-3.5-flash-lite'(新增模型)不被 3.5-flash 遷移誤傷
//   (3) 取樣參數模型 gating(Gemini 3.6 / 3.5 Flash-Lite 起官方淘汰
//       temperature/topP/topK,目前忽略、日後 400):modelDropsSamplingParams 矩陣、
//       buildTemperatureField、buildSamplingFields 對未來 gemini-4 也不送 topP/topK
//   (4) MODEL_PRICING:新模型 entry 存在(3.5-flash-lite 官方無 context caching →
//       cachedDiscount 0)、3.5-flash entry 已移除(v2.0.64 配額管理功能移除後
//       TIER_LIMITS 斷言一併下架)
//
// SANITY 紀錄(已驗證,2026-07-23):
//   破壞 1:storage.js migrateGemini35FlashModelIfNeeded 的 NEW 參數改傳 OLD
//   (遷移空轉)→ case 1 fail(model 停在 gemini-3.5-flash)→ 還原 pass。
//   破壞 2:gemini.js modelDropsSamplingParams 首行插 `return false;` → case 3
//   矩陣 + case 4 temperature gating + case 5 gemini-4 topP/topK 全 fail → 還原 pass。
import { test, expect } from '@playwright/test';

let syncStore = {};
let setCalls = [];

function setupMockChrome() {
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (keys) => {
          if (keys == null) return { ...syncStore };
          if (typeof keys === 'string') return { [keys]: syncStore[keys] };
          return {};
        },
        set: async (obj) => {
          setCalls.push(JSON.parse(JSON.stringify(obj)));
          Object.assign(syncStore, obj);
        },
        remove: async () => {},
      },
      local: {
        get: async () => ({}),
        set: async () => {},
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { id: 'mock' },
  };
}

setupMockChrome();
const { migrateGemini35FlashModelIfNeeded, GEMINI_35_FLASH_OLD_ID, GEMINI_35_FLASH_NEW_ID } =
  await import('../../shinkansen/lib/storage.js');
const { modelDropsSamplingParams, buildTemperatureField, buildSamplingFields } =
  await import('../../shinkansen/lib/gemini.js');
const { MODEL_PRICING } = await import('../../shinkansen/lib/model-pricing.js');

const OLD = GEMINI_35_FLASH_OLD_ID;
const NEW = GEMINI_35_FLASH_NEW_ID;

test.beforeEach(() => {
  syncStore = {};
  setCalls = [];
});

test('case 1: 3.5-flash 遷移接線——geminiConfig / presets / overrides 改寫成 3.6-flash', async () => {
  expect(OLD).toBe('gemini-3.5-flash');
  expect(NEW).toBe('gemini-3.6-flash');
  const saved = {
    geminiConfig: { model: OLD, otherKey: 'keep' },
    translatePresets: [
      { slot: 2, engine: 'gemini', model: OLD, label: 'flash' },
      { slot: 3, engine: 'google-mt', model: OLD, label: 'MT' }, // 非 gemini 不動
    ],
    modelPricingOverrides: { [OLD]: { inputPerMTok: 2 } },
  };
  await migrateGemini35FlashModelIfNeeded(saved);
  expect(setCalls.length).toBe(1);
  expect(saved.geminiConfig.model).toBe(NEW);
  expect(saved.translatePresets[0].model).toBe(NEW);
  expect(saved.translatePresets[1].model).toBe(OLD);
  expect(saved.modelPricingOverrides[NEW]).toEqual({ inputPerMTok: 2 });
  expect(saved.modelPricingOverrides[OLD]).toBeUndefined();
});

test('case 2: gemini-3.5-flash-lite 是新增模型,不被 3.5-flash 遷移誤傷', async () => {
  const saved = {
    geminiConfig: { model: 'gemini-3.5-flash-lite' },
    glossary: { model: 'gemini-3.5-flash-lite' },
    modelPricingOverrides: { 'gemini-3.5-flash-lite': { inputPerMTok: 9 } },
  };
  await migrateGemini35FlashModelIfNeeded(saved);
  expect(setCalls.length, '無舊 ID → 不寫 storage').toBe(0);
  expect(saved.geminiConfig.model).toBe('gemini-3.5-flash-lite');
  expect(saved.modelPricingOverrides['gemini-3.5-flash-lite']).toEqual({ inputPerMTok: 9 });
});

test('case 3: modelDropsSamplingParams 模型矩陣', () => {
  // 淘汰取樣參數的世代(官方:3.6 Flash / 3.5 Flash-Lite 起含日後所有模型)
  expect(modelDropsSamplingParams('gemini-3.6-flash')).toBe(true);
  expect(modelDropsSamplingParams('gemini-3.5-flash-lite')).toBe(true);
  expect(modelDropsSamplingParams('gemini-4-flash')).toBe(true);       // 未來模型 future-proof
  expect(modelDropsSamplingParams('gemini-4.5-pro-preview')).toBe(true);
  // 前代模型照舊
  expect(modelDropsSamplingParams('gemini-3.5-flash')).toBe(false);    // 同版號但屬前代
  expect(modelDropsSamplingParams('gemini-3.1-flash-lite')).toBe(false);
  expect(modelDropsSamplingParams('gemini-3-flash-preview')).toBe(false);
  expect(modelDropsSamplingParams('')).toBe(false);
  expect(modelDropsSamplingParams(null)).toBe(false);
});

test('case 4: buildTemperatureField 對淘汰世代回空物件,其餘照送', () => {
  expect(buildTemperatureField('gemini-3.6-flash', 1.0)).toEqual({});
  expect(buildTemperatureField('gemini-3.5-flash-lite', 0.7)).toEqual({});
  expect(buildTemperatureField('gemini-3-flash-preview', 1.0)).toEqual({ temperature: 1.0 });
  expect(buildTemperatureField('gemini-3.1-flash-lite', 0.1)).toEqual({ temperature: 0.1 });
});

test('case 5: buildSamplingFields 對未來 gemini-4 也不送 topP/topK', () => {
  // 舊邏輯只擋 /gemini-3/,gemini-4 會漏送 topP/topK → 官方日後直接 400
  expect(buildSamplingFields('gemini-4-flash', { topP: 0.95, topK: 40 })).toEqual({});
  expect(buildSamplingFields('gemini-3.6-flash', { topP: 0.95, topK: 40 })).toEqual({});
  // 非 Gemini 3+(理論上不會出現)維持舊相容行為
  expect(buildSamplingFields('gemini-2-flash', { topP: 0.95, topK: 40 }))
    .toEqual({ topP: 0.95, topK: 40 });
});

test('case 6: MODEL_PRICING 清單同步', () => {
  expect(MODEL_PRICING['gemini-3.5-flash-lite']).toEqual(
    { inputPerMTok: 0.30, outputPerMTok: 2.50, cachedDiscount: 0 }); // 官方:不支援 caching
  expect(MODEL_PRICING['gemini-3.6-flash']).toEqual(
    { inputPerMTok: 1.50, outputPerMTok: 7.50, cachedDiscount: 0.90 });
  expect(MODEL_PRICING['gemini-3.5-flash'], '下架模型不留 pricing entry(歷史費用寫入時已存)').toBeUndefined();
});
