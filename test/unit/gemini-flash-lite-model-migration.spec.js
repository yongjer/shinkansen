// Unit test: v1.9.14 migrateGeminiFlashLiteModelIfNeeded
//
// Gemini 3.1 Flash Lite 從 preview alias 轉正式版,model ID:
//   'gemini-3.1-flash-lite-preview' → 'gemini-3.1-flash-lite'
//
// 既有 v1.9.13 使用者 storage.sync 裡會有舊 ID。getSettings() 載入時跑 migration
// 自動改寫;沒舊 ID 就 no-op。本 spec 鎖:
//   (1) geminiConfig.model / glossary.model / ytSubtitle.model 各自改寫
//   (2) translatePresets 內 gemini engine slot 改寫,非 gemini slot 不動
//   (3) modelPricingOverrides key 從 OLD rename 成 NEW(value 保留)
//       v1.10.46 批次 5-4 修正:原 migration 誤檢查 syncSaved.pricing——pricing 的
//       shape 是 {inputPerMTok, outputPerMTok, cachedDiscount},key 永遠不是 model ID
//       (dead code);model ID 為 key 的計價覆蓋實際存 modelPricingOverrides
//       (model-pricing.js getPricingForModel 讀的那份)。本 spec 原本也照抄了錯誤
//       假設,一併改正。
//   (4) 空 saved / 無舊 ID → 不寫 storage(empty patch 短路)
//   (5) syncSaved 物件本身也被原地改寫,讓 caller 後續 merge 看得到新值
//
// SANITY 紀錄(已驗證):暫時把 migration 內所有 patch[*] = ... 註解掉後,
// 測試 1/2/3 全 fail,還原後 pass。
// SANITY 紀錄(批次 5-4,已驗證,2026-06-11):暫時把 modelPricingOverrides 區塊改回
// 檢查 syncSaved.pricing → 「modelPricingOverrides key rename」case fail → 還原 → pass。
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
const { migrateGeminiFlashLiteModelIfNeeded, GEMINI_FLASH_LITE_OLD_ID, GEMINI_FLASH_LITE_NEW_ID } =
  await import('../../shinkansen/lib/storage.js');

const OLD = GEMINI_FLASH_LITE_OLD_ID;
const NEW = GEMINI_FLASH_LITE_NEW_ID;

test.beforeEach(() => {
  syncStore = {};
  setCalls = [];
});

test('migration: geminiConfig.model OLD → NEW + 寫 sync', async () => {
  const saved = { geminiConfig: { model: OLD, otherKey: 'keep' } };
  await migrateGeminiFlashLiteModelIfNeeded(saved);
  expect(setCalls.length).toBe(1);
  expect(setCalls[0]).toEqual({ geminiConfig: { model: NEW, otherKey: 'keep' } });
  // saved 物件也被原地改寫
  expect(saved.geminiConfig.model).toBe(NEW);
});

test('migration: glossary.model / ytSubtitle.model 都改寫', async () => {
  const saved = {
    glossary: { model: OLD, enabled: true },
    ytSubtitle: { model: OLD },
  };
  await migrateGeminiFlashLiteModelIfNeeded(saved);
  expect(setCalls.length).toBe(1);
  const patch = setCalls[0];
  expect(patch.glossary.model).toBe(NEW);
  expect(patch.glossary.enabled).toBe(true);
  expect(patch.ytSubtitle.model).toBe(NEW);
});

test('migration: translatePresets 內 gemini slot 改寫,非 gemini slot 不動', async () => {
  const saved = {
    translatePresets: [
      { slot: 0, engine: 'gemini', model: 'gemini-3-pro', label: 'Pro' },
      { slot: 1, engine: 'gemini', model: OLD, label: 'Flash Lite' },
      { slot: 2, engine: 'google-mt', model: OLD, label: 'MT' }, // 非 gemini engine 不動
    ],
  };
  await migrateGeminiFlashLiteModelIfNeeded(saved);
  expect(setCalls.length).toBe(1);
  const presets = setCalls[0].translatePresets;
  expect(presets[0].model).toBe('gemini-3-pro');           // 不動
  expect(presets[1].model).toBe(NEW);                       // 改寫
  expect(presets[2].model).toBe(OLD);                       // 非 gemini engine 不動
});

test('migration: modelPricingOverrides key rename OLD → NEW(value 保留,其他 model 不動)', async () => {
  const saved = {
    modelPricingOverrides: {
      [OLD]: { inputPerMTok: 0.10, outputPerMTok: 0.30 },
      'gemini-3-pro': { inputPerMTok: 1.25, outputPerMTok: 5.00 },
    },
  };
  await migrateGeminiFlashLiteModelIfNeeded(saved);
  expect(setCalls.length).toBe(1);
  const overrides = setCalls[0].modelPricingOverrides;
  expect(overrides[NEW]).toEqual({ inputPerMTok: 0.10, outputPerMTok: 0.30 });
  expect(overrides[OLD]).toBeUndefined();
  expect(overrides['gemini-3-pro']).toEqual({ inputPerMTok: 1.25, outputPerMTok: 5.00 });
});

test('migration: modelPricingOverrides 已含 NEW key 時不覆蓋,只刪 OLD', async () => {
  const saved = {
    modelPricingOverrides: {
      [OLD]: { inputPerMTok: 0.99, outputPerMTok: 0.99 },
      [NEW]: { inputPerMTok: 0.10, outputPerMTok: 0.30 },
    },
  };
  await migrateGeminiFlashLiteModelIfNeeded(saved);
  const overrides = setCalls[0].modelPricingOverrides;
  expect(overrides[NEW]).toEqual({ inputPerMTok: 0.10, outputPerMTok: 0.30 }); // 保留原 NEW
  expect(overrides[OLD]).toBeUndefined();
});

test('migration: pricing(非 model-keyed shape)有 OLD 字樣以外的正常欄位 → 不動 pricing', async () => {
  // pricing 真實 shape:{inputPerMTok, outputPerMTok, cachedDiscount}。migration 不該碰它
  const saved = { pricing: { inputPerMTok: 0.10, outputPerMTok: 0.40, cachedDiscount: 0.9 } };
  await migrateGeminiFlashLiteModelIfNeeded(saved);
  expect(setCalls.length).toBe(0);
  expect(saved.pricing).toEqual({ inputPerMTok: 0.10, outputPerMTok: 0.40, cachedDiscount: 0.9 });
});

test('migration: 空 saved / 無舊 ID → 不寫 storage', async () => {
  await migrateGeminiFlashLiteModelIfNeeded(null);
  await migrateGeminiFlashLiteModelIfNeeded({});
  await migrateGeminiFlashLiteModelIfNeeded({ geminiConfig: { model: NEW } });
  await migrateGeminiFlashLiteModelIfNeeded({ translatePresets: [{ engine: 'gemini', model: NEW }] });
  await migrateGeminiFlashLiteModelIfNeeded({ modelPricingOverrides: { [NEW]: { inputPerMTok: 0.1 } } });
  expect(setCalls.length).toBe(0);
});
