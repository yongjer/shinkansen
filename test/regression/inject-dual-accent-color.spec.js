// Regression: v1.8.52 dualAccentColor — issue #35「譯文強調色自訂」
//
// 結構特徵:wrapper 上 data-sk-accent="custom" + inline `--sk-accent-rgb` 三段
// 數字字串。CSS 用 rgb(var(--sk-accent-rgb) / <alpha>) 把同一色套到三種 mark
// (tint 走 alpha、bar/dashed 走實心)。'auto' 不寫屬性,走原 CSS 預設。
//
// SANITY 紀錄(已驗證):
//   1. 把 SK.injectDual 內 accent 處理整段刪掉(rgb 不寫 inline style),
//      auto 以外的 case 三項斷言全 fail;還原後 pass。
//   2. 把 SK.sanitizeDualAccent 改成 always return 'auto',hex / token 兩條
//      正向 case 都退化成 auto,attribute 缺失,fail;還原後 pass。
//
// 為什麼這條 spec 必要:options 預覽是用 options.css 同步的副本驗,真實頁面
// 是 ensureDualWrapperStyle 在 head 注入。兩條路徑必須等價。本 spec 走真實
// extension content-script,確認 inject 路徑正確。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-accent-color: auto / token / 自訂 hex / 無效值 各別行為', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mark-tint', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 五個獨立 target,每個用不同 accent 注入。沒有 dualAccentColor key 的 spec
  // 會 fall through 到 currentDualAccent 殘留值,所以順序內每筆都明確指定。
  await evaluate(`(() => {
    const cases = [
      ['#mark-tint',   'tint',   'auto'],      // 不該寫 attribute / inline var
      ['#mark-bar',    'tint',   'blue'],      // token → 套 #3B82F6 = rgb(59 130 246)
      ['#mark-dashed', 'tint',   '#ff00aa'],   // 自訂 hex(小寫,sanitize 後變大寫）
      ['#mark-none',   'tint',   'garbage!!'], // 無效值 → fallback 'auto'
    ];
    cases.forEach(([sel, mark, accent]) => {
      const el = document.querySelector(sel);
      window.__shinkansen.testInjectDual(el, '譯文', {
        markStyle: mark,
        dualAccentColor: accent,
      });
    });
  })()`);

  const after = await page.evaluate(() => {
    const out = {};
    for (const sel of ['#mark-tint', '#mark-bar', '#mark-dashed', '#mark-none']) {
      const wrapper = document.querySelector(sel)?.nextElementSibling;
      if (!wrapper) { out[sel] = null; continue; }
      const cs = window.getComputedStyle(wrapper);
      out[sel] = {
        accent: wrapper.getAttribute('data-sk-accent'),
        // inline custom property 從 wrapper.style 讀(getComputedStyle 對 -- 開頭
        // 在某些 chromium 版本回空字串,改 wrapper.style.getPropertyValue 讀更穩)
        cssVar: wrapper.style.getPropertyValue('--sk-accent-rgb').trim(),
        bgColor: cs.backgroundColor,
      };
    }
    return out;
  });

  // auto:不寫 attribute、不寫 inline var、bg 走預設米色 #FFF8E1 = rgb(255, 248, 225)
  expect(after['#mark-tint']?.accent).toBeNull();
  expect(after['#mark-tint']?.cssVar).toBe('');
  expect(after['#mark-tint']?.bgColor).toBe('rgb(255, 248, 225)');

  // token blue:attribute = 'custom',var = '59 130 246',bg = rgba(59, 130, 246, 0.15)
  expect(after['#mark-bar']?.accent).toBe('custom');
  expect(after['#mark-bar']?.cssVar).toBe('59 130 246');
  // 0.15 alpha 在 chromium 通常 round 成 0.149... 或 0.15,正則涵蓋兩種
  expect(after['#mark-bar']?.bgColor).toMatch(/rgba\(59,\s*130,\s*246,\s*0\.1[45]\d*\)/);

  // 自訂 hex:小寫 #ff00aa,sanitize 後 hex map 解析得到 (255, 0, 170)
  expect(after['#mark-dashed']?.accent).toBe('custom');
  expect(after['#mark-dashed']?.cssVar).toBe('255 0 170');

  // 無效值:fallback 'auto' → 不寫 attribute / inline var
  expect(after['#mark-none']?.accent).toBeNull();
  expect(after['#mark-none']?.cssVar).toBe('');
});

test('dual-accent-color: bar 套 token red → border-left-color 變實心紅', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mark-bar', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const el = document.querySelector('#mark-bar');
    window.__shinkansen.testInjectDual(el, '譯文 bar+red', {
      markStyle: 'bar',
      dualAccentColor: 'red',
    });
  })()`);

  const after = await page.evaluate(() => {
    const wrapper = document.querySelector('#mark-bar').nextElementSibling;
    if (!wrapper) return null;
    const cs = window.getComputedStyle(wrapper);
    return {
      borderLeftColor: cs.borderLeftColor,
      borderLeftWidth: cs.borderLeftWidth,
      borderLeftStyle: cs.borderLeftStyle,
    };
  });

  // red token = #EF4444 = rgb(239, 68, 68);bar 寬度維持 v1.8.52 的 3px solid
  expect(after?.borderLeftColor).toBe('rgb(239, 68, 68)');
  expect(after?.borderLeftWidth).toBe('3px');
  expect(after?.borderLeftStyle).toBe('solid');
});
