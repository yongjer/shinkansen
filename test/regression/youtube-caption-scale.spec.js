// Regression: YouTube 字幕字級 scale（ytSubtitle.captionScale,全平台統一旋鈕）
//
// Fixture: test/regression/fixtures/caption-scale.html（任意頁即可,只測純函式 + style 注入）
//
// 背景（2026-06-08）:iPhone / iPad 進原生全螢幕後字幕由系統播放器渲染我們掛的 TextTrack,
// 字級偏小。真機 probe 確認 iOS 原生全螢幕「吃」網頁 `::cue`（Safari 18.2 起系統預設字幕樣式
// 可被網頁覆寫）。設計成「全平台統一字級 scale」:一個值（popup「字幕大小」,只在 YT 影片頁顯示）
// 套兩條路徑——桌面 / macOS / iOS 視窗內乘 overlay `--sk-cue-size`（原生 px × scale/100）、
// iOS 原生全螢幕注入 `video::cue { font-size: scale% }`。content-youtube.js `_scaledCueSizePx` /
// `_buildIosFsCueCss` / `_applyYtCaptionScale`。預設 100 = 桌面零改變。
//
// 訊號層次（CLAUDE.md 工作流原則 §3）:
//   - 本 spec 測得到:scale → overlay px 對映、scale → iOS `::cue` CSS 對映、clamp（50–400）、
//     已注入 iOS style 的 live 更新
//   - 本 spec 測不到（永久 path B）:iOS 原生全螢幕播放器「實際渲染 `::cue` font-size」那層是
//     iPhone 系統層,Playwright Chromium / harness 完全碰不到,只能真機肉眼驗（2026-06-08
//     已真機 probe 確認 `::cue` 生效）。桌面 overlay 視覺也只能 cage / 截圖驗。
//
// SANITY 紀錄（已驗證）:
//   - 把 `_scaledCueSizePx` 的 `* _ytCaptionScale / 100` 改成寫死 → overlay 對映 case fail
//   - 把 `_buildIosFsCueCss` 的 `${scale}%` 改寫死 → iOS ::cue case fail
//   - 把 `_applyYtCaptionScale` 的範圍 guard（>= 50 && <= 400）拿掉 → clamp case fail
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'caption-scale';

test('_scaledCueSizePx:_applyYtCaptionScale 設 scale 後,overlay px = round(原生 × scale/100)', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK._applyYtCaptionScale(150);
      const px150 = SK._scaledCueSizePx(20);   // round(20 × 1.5) = 30
      SK._applyYtCaptionScale(100);
      const px100 = SK._scaledCueSizePx(20);   // 20（預設 100 = 跟隨原生）
      return { px150, px100 };
    })()
  `);

  expect(r.px150).toBe(30);
  expect(r.px100).toBe(20);

  await page.close();
});

test('_buildIosFsCueCss:scale → iOS 原生全螢幕 ::cue font-size CSS + 兩個選擇器都在', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const css150 = window.__SK._buildIosFsCueCss(150);
      const css200 = window.__SK._buildIosFsCueCss(200);
      return { css150, css200 };
    })()
  `);

  expect(r.css150).toContain('font-size: 150%');
  expect(r.css200).toContain('font-size: 200%');
  expect(r.css150).toContain('video::cue');
  expect(r.css150).toContain('video::-webkit-media-text-track-display');

  await page.close();
});

test('_applyScaleToSegment:內建字幕原生 segment inline 字級 × scale + scale=100 還原 + 未套過不碰', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const SK = window.__SK;
      // 模擬 YouTube 原生 segment（inline 16px = YouTube 基準）
      const seg = document.createElement('span');
      seg.className = 'ytp-caption-segment';
      seg.style.fontSize = '16px';
      document.body.appendChild(seg);

      SK._applyYtCaptionScale(150);            // 設 scale + iterate 套到 seg
      const at150 = seg.style.fontSize;        // round(16 × 1.5) = 24px
      const baseCaptured = seg.dataset.skBaseFs;

      SK._applyYtCaptionScale(100);            // 還原回 base
      const at100 = seg.style.fontSize;        // 16px

      // 未套過的 segment 在預設 100 下完全不碰
      const seg2 = document.createElement('span');
      seg2.className = 'ytp-caption-segment';
      seg2.style.fontSize = '20px';
      SK._applyScaleToSegment(seg2);           // scale=100 + 無 dataset → 不動
      const seg2fs = seg2.style.fontSize;

      return { at150, baseCaptured, at100, seg2fs, seg2HasDataset: seg2.dataset.skBaseFs != null };
    })()
  `);

  expect(r.at150).toBe('24px');
  expect(r.baseCaptured).toBe('16px');
  expect(r.at100).toBe('16px');         // 還原 YouTube 原始基準
  expect(r.seg2fs).toBe('20px');        // 預設 100 + 未套過 → 零改變
  expect(r.seg2HasDataset).toBe(false); // 沒被碰過,連 dataset 都不寫

  await page.close();
});

test('caption-scale observer:scale≠100 時新出現的 segment 自動套 scale;=100 停掉並還原', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 啟動 observer（scale 200）後,動態加一個新 .ytp-caption-segment 進 #movie_player,
  // 應被 observer 自動 scale（模擬 YouTube 自家字幕 / 自動翻譯持續產生新字幕行的情境,
  // 此時 Shinkansen 沒接手寫字幕,光靠 _setSegmentText hook 接不到 → 靠 observer）。
  const r = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const mp = document.getElementById('movie_player');
      SK._applyYtCaptionScale(200);                 // 啟動 observer

      // 動態新增 segment（observer 應接到）
      const seg = document.createElement('span');
      seg.className = 'ytp-caption-segment';
      seg.style.fontSize = '16px';
      seg.textContent = 'new caption line';
      mp.appendChild(seg);

      // 等 observer 的 rAF 觸發
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 50));
      const afterAdd = seg.style.fontSize;          // 期望 32px

      SK._applyYtCaptionScale(100);                 // 停 observer + 還原
      const afterStop = seg.style.fontSize;         // 期望還原 16px

      // observer 已停:再加一個新 segment 不應被動到
      const seg2 = document.createElement('span');
      seg2.className = 'ytp-caption-segment';
      seg2.style.fontSize = '16px';
      mp.appendChild(seg2);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 50));
      const seg2fs = seg2.style.fontSize;           // 期望維持 16px（observer 已停 + scale=100）

      return { afterAdd, afterStop, seg2fs };
    })()
  `);

  expect(r.afterAdd).toBe('32px');    // observer 自動把新 segment 放大
  expect(r.afterStop).toBe('16px');   // scale=100 還原 base
  expect(r.seg2fs).toBe('16px');      // observer 已停,新 segment 不被動

  await page.close();
});

test('_applyYtCaptionScale:有效值更新已注入 iOS style;超界值被 clamp guard 拒絕', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const SK = window.__SK;
      // 預先注入 iOS ::cue style 元素,讓 _applyYtCaptionScale 會 live 更新
      const st = document.createElement('style');
      st.id = 'sk-ios-fs-cue-style';
      document.head.appendChild(st);

      SK._applyYtCaptionScale(180);
      const after180 = st.textContent;
      const px180 = SK._scaledCueSizePx(20);   // round(20 × 1.8) = 36

      SK._applyYtCaptionScale(9999);           // 超界,應被拒絕,維持 180
      const afterBad = st.textContent;
      const pxBad = SK._scaledCueSizePx(20);

      return { after180, px180, afterBad, pxBad };
    })()
  `);

  expect(r.after180).toContain('font-size: 180%');
  expect(r.px180).toBe(36);
  expect(r.afterBad).toContain('font-size: 180%');   // 9999 被 guard 拒絕,維持 180
  expect(r.afterBad).not.toContain('9999');
  expect(r.pxBad).toBe(36);

  await page.close();
});

// Regression（v1.10.35,iPhone 全螢幕字幕消失）:
// v1.10.29 起 _refreshIosFsTrack 無條件注入 `video::-webkit-media-text-track-display
// { font-size: 100% !important }`,連預設 scale=100 也注入。這個 !important 覆寫了 iOS 系統
// 原本「依影片大小算字級」的原生全螢幕字幕渲染,把字級壓到看不見 → 使用者回報「全螢幕沒字幕」。
// v1.10.27(實機驗收正常)那版完全不注入任何 cue style。修法:scale=100 時 _ensureIosFsCueStyle
// 移除既有 style 並 return(零覆寫,交回 iOS 系統),scale≠100 才注入 override。
// SANITY 紀錄（已驗證）:把 `if (_ytCaptionScale === 100) { if (existing) existing.remove(); return; }`
//   整段拿掉 → 本 case「scale=100 不留 override style」斷言 fail;還原後 pass。
test('scale=100:_ensureIosFsCueStyle 不留任何 ::cue override style(還原 iOS 系統原生字級)', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const SK = window.__SK;
      // 先在 scale≠100 注入 override style（模擬 iPhone 上 _refreshIosFsTrack 已建過 style）
      const st = document.createElement('style');
      st.id = 'sk-ios-fs-cue-style';
      document.head.appendChild(st);
      SK._applyYtCaptionScale(150);
      const at150 = document.getElementById('sk-ios-fs-cue-style')?.textContent || '';

      // 切回預設 100 → 應移除 override，全螢幕字級交回 iOS 系統
      SK._applyYtCaptionScale(100);
      const styleAt100 = document.getElementById('sk-ios-fs-cue-style');

      return {
        at150HasOverride: at150.includes('font-size: 150%'),
        styleRemovedAt100: styleAt100 === null,
      };
    })()
  `);

  expect(r.at150HasOverride).toBe(true);    // scale≠100 仍注入 override
  expect(r.styleRemovedAt100).toBe(true);   // scale=100 移除 override（不再壓 iOS 原生字級）

  await page.close();
});
