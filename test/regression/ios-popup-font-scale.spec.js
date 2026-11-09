// Regression: iPad popup 字體放大,箱子尺寸不變(SPEC-PRIVATE §26.10)
//
// 背景(真機 probe 2026-06-08):大 iPad(12.9")跟 iPad mini 共用同一個 popover
// 尺寸(都 ~420pt,innerWidth=420 → zoom 1.5),但大螢幕檢視距離較遠 → 字看起來
// 偏小。`zoom` 是整體縮放、改不了「字相對箱子」的比例(放大 zoom 連箱子 + 留白
// 一起變大,字相對箱子沒變)。修法:另用 CSS 變數 --sk-fz 只放大可讀文字
// (popup.css 的字級用 calc(BASEpx * var(--sk-fz, 1))),箱子 zoom 不動。
// popup.js 依「螢幕短邊」設 --sk-fz:iPad mini(短邊 744)→ 1.0 維持原樣、
// 12.9"(短邊 1024)→ ~1.35;iPhone(短邊 ≤ 440)算出 < 1 被 clamp 回 1.0。
//
// 本 spec 鎖的訊號層次(CLAUDE.md 工作流原則 3):
//   驗(a)real render:--sk-fz 翻倍 → 可讀文字字級翻倍(calc var 接線正確),
//   且箱子 zoom 不隨 --sk-fz 變(維持 popup 原尺寸)。(b)source forcing function:
//   popup.js 依 screen.* 設 --sk-fz、popup.css 用 var(--sk-fz) 套字級。
//   不驗:真實 iPad 各機型 popover innerWidth / 檢視距離下的「主觀夠不夠大」
//   (Chromium / sim 都驗不到,真機驗收紀錄見 SPEC-PRIVATE §26.10:iPad Pro 12.9"
//   fz=1.35 字放大無換行、iPad mini fz=1 維持原樣)。
//
// SANITY 紀錄(已驗證 2026-06-08):
//   1. 把 popup.css 的 .row 字級從 calc(13px * var(--sk-fz)) 改回死的 13px →
//      (a) 字級翻倍斷言 fail(比值 1);還原 → pass。
//   2. 把 popup.js 的 setProperty('--sk-fz', ...) 那行刪掉 → (b) source 斷言
//      fail;還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';

test('--sk-fz 翻倍 → 可讀文字字級翻倍,箱子 zoom 不變', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  // 字級 calc 規則 scope 在 body.runtime-ios-touch(真觸控 iPad / iPhone)
  await page.evaluate(() => document.body.classList.add('runtime-ios-touch'));

  const measure = (fz) => page.evaluate((v) => {
    document.body.style.setProperty('--sk-fz', String(v));
    return {
      rowFont: parseFloat(getComputedStyle(document.querySelector('.row')).fontSize),
      btnFont: parseFloat(getComputedStyle(document.querySelector('button.primary')).fontSize),
      // footer 的「四指輕點快速切換」提示(.hint)也要跟著放大,否則 iPad Pro 上會跟
      // 同列被放大的「設定」(button.link)字級不一致(v1.10.34 漏套 → v1.10.35 補)
      hintFont: parseFloat(getComputedStyle(document.querySelector('.hint')).fontSize),
      linkFont: parseFloat(getComputedStyle(document.querySelector('button.link')).fontSize),
      bodyZoom: getComputedStyle(document.body).zoom,
    };
  }, fz);

  const m1 = await measure(1);
  const m2 = await measure(2);

  // calc(BASEpx * var(--sk-fz)) → fz 翻倍字級翻倍(zoom 為共同因子,比值約掉)
  expect(m2.rowFont / m1.rowFont).toBeCloseTo(2, 1);
  expect(m2.btnFont / m1.btnFont).toBeCloseTo(2, 1);
  // footer 同列的 .hint 與 button.link 都要隨 --sk-fz 翻倍(避免 iPad 上字級不一致)
  expect(m2.hintFont / m1.hintFont).toBeCloseTo(2, 1);
  expect(m2.linkFont / m1.linkFont).toBeCloseTo(2, 1);
  // 箱子 zoom 不隨 --sk-fz 變 → popup 尺寸維持原樣,只有字變大
  expect(m2.bodyZoom).toBe(m1.bodyZoom);
});

test('source 結構:popup.js 依 screen 短邊設 --sk-fz、popup.css 用 var(--sk-fz) 套字級', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const fetchText = (p) => page.evaluate(async (path) => (await fetch(path)).text(), p);

  const js = await fetchText('popup.js');
  expect(js).toContain("setProperty('--sk-fz'");
  expect(js).toMatch(/Math\.min\(screen\.width/);

  const css = await fetchText('popup.css');
  // 可讀文字字級用 calc + var(--sk-fz)(.row 為代表)
  expect(css).toMatch(/body\.runtime-ios-touch \.row \{\s*font-size:\s*calc\(13px \* var\(--sk-fz/);
});
