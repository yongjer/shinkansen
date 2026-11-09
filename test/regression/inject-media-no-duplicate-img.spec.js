// Regression: Google MT atomic IMG slot 造成圖片重複。
//
// Fixture: test/regression/fixtures/inject-media-no-duplicate-img.html
//
// 結構特徵（不綁站名）：<a> 含 <img> + <span>文字</span>。
// Google MT serializer 把 IMG 做成 atomic slot（【*0】），deserialization 後
// fragment 已包含 IMG clone + 翻譯文字。injectIntoTarget media-preserving
// path (B) 保留原始 IMG + fragment 帶 IMG clone → 圖片重複。
//
// 修法：注入 fragment 含 IMG 時跳過 (B)，走 (A) clean-slate。
//
// 真實 case：Amazon.co.jp 商品比較表，每個 <a> 含商品圖 + 商品名。
//
// SANITY 紀錄（已驗證 2026-05-26）：暫拿掉 contentHasImg 條件
// → spec fail（imgCount=2）→ 還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-media-no-duplicate-img';
const TARGET_SELECTOR = '#target-link';

test('Google MT atomic IMG slot：翻譯後圖片不重複', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const injectResult = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);
      // 模擬 Google MT：IMG 走 atomic（【*0】），文字翻譯
      let fake = sourceText.replace('Oven Paper 30cm x 50m Bleached', '烤箱紙 30cm x 50m 漂白');
      const restored = window.__SK.restoreGoogleTranslateMarkers(fake);
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, restored, slots);
      return { sourceText, fake, slotCount: slots.length };
    })()
  `);

  // IMG 應該被序列化為 atomic slot
  expect(injectResult.slotCount).toBeGreaterThanOrEqual(1);

  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const imgs = el.querySelectorAll('img');
    return {
      imgCount: imgs.length,
      text: el.textContent?.trim() || '',
      translated: el.hasAttribute('data-shinkansen-translated'),
    };
  }, TARGET_SELECTOR);

  expect(result.imgCount, '翻譯後只有 1 張 IMG（不重複）').toBe(1);
  expect(result.text, '文字已翻譯成中文').toContain('烤箱紙');
  expect(result.translated, '元素標記為已翻譯').toBe(true);

  await page.close();
});
