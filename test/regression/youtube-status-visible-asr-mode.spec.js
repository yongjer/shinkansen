// Regression: v1.8.53 ASR / CC-paused hide-mode 把「翻譯中…」status 一起藏掉
//
// 痛點:使用者拖進度條到沒翻過的區段,DOM 上 #__sk-yt-caption-status element 已存在
// + textContent='翻譯中…',畫面上完全看不到。
//
// 根因(分兩層,本輪兩條都修):
//   (1) v1.8.16 對 .ytp-caption-window-container 設 visibility:hidden!important —
//       status 是 container 子元素,visibility 繼承 hidden → 不可見。
//       (visibility 可被 child 反轉,但...)
//   (2) 同 rule 也設 opacity: 0 !important — opacity 不繼承,但 rendering 上
//       child 的視覺最終 opacity = child × parent。父 opacity:0 → 整個子樹視覺
//       fade 到 0,**status 設 opacity:1 + visibility:visible 仍看不到**。
//       getComputedStyle(child).opacity 回 child 自己的值(=1),反映不出父層 fade。
//
// 修法位置:shinkansen/content-youtube.js _ensureAsrStylesheet
//   不再對 .ytp-caption-window-container 自身設 visibility:hidden + opacity:0,
//   改成只對它的真子元素(.caption-window / .ytp-caption-window-rollup)個別設。
//   container 本身只保留 pointer-events: none。原本 reverse rule 不再需要。
//
// 結構通則:鎖「ASR hide-mode 啟動時,status 元素的祖先鏈沒有 opacity:0 / visibility:hidden,
// 但 .caption-window(native CC 真容器)仍必 hidden」。後者保證原本藏 native CC 的目的不退化。
//
// SANITY CHECK 紀錄(已驗證,2026-05-05):
//   把 hide rule 還原成 v1.8.52 對 container 設 visibility/opacity 的版本 → spec fail
//   (container visibility=hidden 且 opacity=0)。還原 fix → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';

test.describe('youtube-status-visible-asr-mode', () => {
  test('ASR hide-mode 啟動時「翻譯中…」status visibility=visible', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

    const { evaluate } = await getShinkansenEvaluator(page);

    // 模擬 ASR hide-mode 啟動:加 _ASR_PLAYER_CLASS 到 player root + 注入 stylesheet
    // (走真實 code path 的 css injection,不手動寫死 stylesheet)
    await evaluate(`
      (() => {
        const root = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
        if (!root) throw new Error('player root not found in fixture');
        // 用 main entry: dispatch captionsXHR 事件 → captureSubtitles → _applyBilingualMode → _setAsrHidingMode
        // 但 captionsXHR handler 需要 SK.YT.active + isYouTubePage,先設好
        window.__SK.isYouTubePage = () => true;
        // 直接觸發 hide-mode + ensure stylesheet(透過內部 helper—走最少代碼路徑)
        // 我們已 export 部分 helper,但 _setAsrHidingMode 沒 export → 直接 add class + 派 captionsXHR
        root.classList.add('shinkansen-asr-active');
        // 模擬 _ensureAsrStylesheet:派一個 dummy captionsXHR 走 captureSubtitles 也會注入 stylesheet
        // 但更可靠是直接在這裡呼叫(若沒 export,我們等 captureSubtitles 也行)
      })()
    `);

    // 派發 captionsXHR(ASR URL,kind=asr)→ captureSubtitles 內 _applyBilingualMode →
    // _setAsrHidingMode(true) → _ensureAsrStylesheet 注入 stylesheet
    await evaluate(`
      window.__SK.YT.active = true;
      window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
        detail: {
          url: 'https://www.youtube.com/api/timedtext?v=test&lang=en&kind=asr',
          responseText: JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'hello world' }] }] }),
        }
      }));
    `);

    // 等 stylesheet 注入完
    await page.waitForFunction(() => !!document.getElementById('shinkansen-asr-hide-css'), null, { timeout: 5000 });

    // 手動建 status element(模擬 showCaptionStatus 的 appendChild,不依賴翻譯流程觸發)
    // + 加一個 .caption-window(模擬 YouTube 原生 CC 容器)以驗它仍被藏。
    // 2026-07-23:建立與量測必須在**同一個 evaluate**(同一個 JS turn)內完成——
    // 上面派發的 captionsXHR 會真的啟動 ASR 翻譯 pipeline,無 API key 時 chunk 全
    // 失敗的非同步路徑會呼叫 hideCaptionStatus() 把同 id 元素收掉;拆成兩個 evaluate
    // 時失敗路徑落在中間空檔就 flake(v2.0.64 移除 rate limiter 等待後空檔變窄更常中)。
    // 本 spec 驗的是「stylesheet 不得藏 status」,不驗 status 的生滅時序,同 turn
    // 建立+量測不受 pipeline 時序影響。
    const result = await evaluate(`
      (() => {
        const container = document.querySelector('.ytp-caption-window-container');
        if (!container) throw new Error('caption-window-container not found');
        if (!document.querySelector('.caption-window')) {
          const cw = document.createElement('div');
          cw.className = 'caption-window';
          cw.textContent = 'native English CC';
          container.appendChild(cw);
        }
        let el = document.getElementById('__sk-yt-caption-status');
        if (!el) {
          el = document.createElement('div');
          el.id = '__sk-yt-caption-status';
          el.textContent = '翻譯中…';
          // 模擬 showCaptionStatus 內 inline style(不含 visibility,讓 stylesheet 主導)
          Object.assign(el.style, {
            position: 'absolute',
            zIndex: '99',
            background: 'rgba(8, 8, 8, 0.75)',
            color: '#fff',
          });
          container.appendChild(el);
        }
        if (!el) return { found: false };
        const ancestors = [];
        let cur = el;
        while (cur && cur !== document.documentElement) {
          const cs = getComputedStyle(cur);
          ancestors.push({
            tag: cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (cur.className ? '.' + String(cur.className).slice(0, 40) : ''),
            visibility: cs.visibility,
            opacity: cs.opacity,
          });
          cur = cur.parentElement;
        }
        const captionWindow = document.querySelector('.caption-window');
        return {
          found: true,
          ancestors,
          captionWindow: captionWindow ? {
            visibility: getComputedStyle(captionWindow).visibility,
            opacity: getComputedStyle(captionWindow).opacity,
          } : null,
        };
      })()
    `);

    expect(result.found, 'status element 應存在').toBe(true);
    // 祖先鏈(包含 status 自己)不該有 opacity:0(rendering 上會 compound 把整個子樹 fade 掉)
    const fadedAncestor = result.ancestors.find(a => parseFloat(a.opacity) === 0);
    expect(
      fadedAncestor,
      `status 祖先鏈不該有 opacity:0,實際 ${JSON.stringify(result.ancestors)}`,
    ).toBeUndefined();
    // 祖先鏈不該有 visibility:hidden(子可反轉,但易出錯,直接保證父都 visible 最 robust)
    const hiddenAncestor = result.ancestors.find(a => a.visibility === 'hidden');
    expect(
      hiddenAncestor,
      `status 祖先鏈不該有 visibility:hidden,實際 ${JSON.stringify(result.ancestors)}`,
    ).toBeUndefined();
    // .caption-window(原生 CC 真容器)仍必 hidden,確保藏 native CC 的目的不退化
    if (result.captionWindow) {
      expect(
        result.captionWindow.visibility,
        '.caption-window(native CC 真容器)應 visibility:hidden,藏 native CC 目的不能退化',
      ).toBe('hidden');
    }

    await page.close();
  });
});
