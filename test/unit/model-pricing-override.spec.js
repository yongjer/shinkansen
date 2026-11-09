// Unit test: getPricingForModel 的優先順序(v1.6.14)
//
// 對應 v1.6.14 修法:Google 改價時內建表會過時,使用者可在「Gemini 分頁 → 模型計價」
// 用 settings.modelPricingOverrides 個別覆蓋。新簽名 getPricingForModel(model, settings)。
//
// v1.9.2 修改:
//   - 回傳物件多 cachedDiscount 欄位(0-1,cache 命中省下的比例,Gemini 2.5+ 預設 0.90)。
//   - input/output 與 cachedDiscount 各自獨立 fallback——可只覆蓋折扣不覆蓋價格,反之亦然。
//
// 優先順序(每欄獨立):
//   inputPerMTok / outputPerMTok 兩欄合法 → 用 override;否則 fallback 內建表
//   cachedDiscount 0-1 範圍 → 用 override;否則 fallback 內建表(Gemini 預設 0.90)
//   無 override 且無內建表 → null(呼叫端 fallback 全域 settings.pricing)
//
// SANITY 紀錄(已驗證):把 override 分支整段移除 → "override 優先" spec fail,
// 還原後全綠。
import { test, expect } from '@playwright/test';
import { getPricingForModel, MODEL_PRICING, LAST_CALIBRATED_DATE } from '../../shinkansen/lib/model-pricing.js';

test.describe('getPricingForModel: override 優先', () => {
  test('settings.modelPricingOverrides 有合法 entry → 用 override 蓋過內建表', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3-flash-preview': { inputPerMTok: 1.23, outputPerMTok: 4.56 },
      },
    };
    // v1.9.2: cachedDiscount 沒覆蓋 → 走內建表預設(0.90)
    expect(getPricingForModel('gemini-3-flash-preview', settings)).toEqual({
      inputPerMTok: 1.23,
      outputPerMTok: 4.56,
      cachedDiscount: 0.90,
    });
  });

  test('override 字串型數字也可接受(coerce)', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3.1-pro-preview': { inputPerMTok: '3.5', outputPerMTok: '14.0' },
      },
    };
    expect(getPricingForModel('gemini-3.1-pro-preview', settings)).toEqual({
      inputPerMTok: 3.5,
      outputPerMTok: 14.0,
      cachedDiscount: 0.90,
    });
  });

  test('v1.9.2: 只覆蓋 cachedDiscount 不覆蓋價格 → input/output 走內建,折扣走 override', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3-flash-preview': { cachedDiscount: 0.50 },
      },
    };
    expect(getPricingForModel('gemini-3-flash-preview', settings)).toEqual({
      inputPerMTok: MODEL_PRICING['gemini-3-flash-preview'].inputPerMTok,
      outputPerMTok: MODEL_PRICING['gemini-3-flash-preview'].outputPerMTok,
      cachedDiscount: 0.50,
    });
  });

  test('v1.9.2: cachedDiscount 不在 0-1 範圍 → 視為無 override 走內建', () => {
    const cases = [{ cachedDiscount: 1.5 }, { cachedDiscount: -0.1 }, { cachedDiscount: 'abc' }];
    for (const ov of cases) {
      const settings = { modelPricingOverrides: { 'gemini-3-flash-preview': ov } };
      expect(getPricingForModel('gemini-3-flash-preview', settings).cachedDiscount).toBe(0.90);
    }
  });

  test('v1.9.2: 三欄全 override(包含 cachedDiscount)', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3-flash-preview': { inputPerMTok: 1, outputPerMTok: 5, cachedDiscount: 0.6 },
      },
    };
    expect(getPricingForModel('gemini-3-flash-preview', settings)).toEqual({
      inputPerMTok: 1, outputPerMTok: 5, cachedDiscount: 0.6,
    });
  });

  test('override 非合法數字(NaN/null/undefined) → 視為無 override 走內建表', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3-flash-preview': { inputPerMTok: 'abc', outputPerMTok: 3.0 },
      },
    };
    expect(getPricingForModel('gemini-3-flash-preview', settings)).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
  });

  test('其他 model 即使有 override entry 也不影響 fallback 內建表', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3.1-flash-lite': { inputPerMTok: 99, outputPerMTok: 99 },
      },
    };
    // 查詢 flash 不該被 lite 的 override 影響
    expect(getPricingForModel('gemini-3-flash-preview', settings)).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
  });
});

test.describe('getPricingForModel: 內建表 fallback', () => {
  test('沒帶 settings 或 settings 沒 overrides 欄位 → 用內建表', () => {
    expect(getPricingForModel('gemini-3-flash-preview')).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
    expect(getPricingForModel('gemini-3-flash-preview', null)).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
    expect(getPricingForModel('gemini-3-flash-preview', {})).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
    expect(getPricingForModel('gemini-3-flash-preview', { modelPricingOverrides: {} })).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
  });

  test('未列入內建表的 model + 無 override → null', () => {
    expect(getPricingForModel('unknown-model')).toBeNull();
    expect(getPricingForModel('unknown-model', { modelPricingOverrides: {} })).toBeNull();
  });

  test('空值/undefined model → null', () => {
    expect(getPricingForModel('')).toBeNull();
    expect(getPricingForModel(null)).toBeNull();
    expect(getPricingForModel(undefined)).toBeNull();
  });
});

test.describe('LAST_CALIBRATED_DATE 常數', () => {
  test('export 一個非空字串(UI 用來顯示「YYYY-MM 校準」提示)', () => {
    expect(typeof LAST_CALIBRATED_DATE).toBe('string');
    expect(LAST_CALIBRATED_DATE.length).toBeGreaterThan(0);
    // 格式應為 YYYY-MM
    expect(LAST_CALIBRATED_DATE).toMatch(/^\d{4}-\d{2}$/);
  });
});
