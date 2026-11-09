// Regression: youtube-cjk-source-inject（對應 code review 2026-07-08 R2(c),dev tail 2.0.7.1 修）
//
// Fixture: 重用 test/regression/fixtures/youtube-streaming-inject.html（YT 頁形狀）
// Bug:replaceSegmentEl 用 RE_CJK 字元集一刀擋「含 CJK 的 original」防自己注入的
//     譯文觸發 characterData 回呼，但：
//     - ja / ko 源語的人工字幕原文本身就含 CJK → 單語模式譯文永遠注入不進去
//       （API 照燒 token，字幕卻停在原文）
//     - target=en 時注入的英文不含 CJK → 該防禦其實也擋不到自我迴圈
// 修法（content-youtube.js）：移除 RE_CJK，改 _injectedSegmentText WeakMap
//     （el → 最後注入的可見文字快照）——cache miss 且 el.textContent 等於快照
//     = 自己注入觸發的回呼，return；語言無關。
//
// 本 spec 鎖的訊號層：驗「ja 源語 cache hit 注入」與「注入後同 el 再回呼不進
//   onTheFly」兩層（直接驅動 SK._replaceSegmentEl，不走 translateYouTubeSubtitles
//   全流程）。不驗 YouTube 真實 caption DOM 的 MutationObserver 觸發時序，也不驗
//   overlay 視覺。
//
// SANITY 紀錄（已驗證，2026-07-08，兩輪破壞）:
//   1. 在 replaceSegmentEl 的 key 計算後重新加回 RE_CJK 式防禦
//      `if (/[぀-ヿ㐀-鿿豈-﫿]/.test(original)) return;`
//      → Case 1「ja 原文應被替換為譯文」fail（停在原文）。
//   2. 把 `_injectedSegmentText.get(el) === el.textContent` 自我迴圈 guard 拿掉
//      → Case 2「注入後再回呼不應進 onTheFly」fail（譯文被當 miss 進 pendingQueue）。
//   還原後皆 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

test('youtube-cjk-source-inject: ja 源語字幕譯文可注入；注入後回呼不進 onTheFly', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const YT = window.__SK.YT;
      Object.assign(YT, {
        active: true, isAsr: false,
        captionMap: new Map(), pendingQueue: new Map(),
        onTheFlyTotal: 0,
        config: { bilingualMode: false, onTheFly: true },
        sessionStartTime: Date.now(),
      });
      // 防 onTheFly batchTimer 真送 background
      window.__SK.safeSendMessage = async () => ({ ok: false, error: 'test stub' });

      // ── Case 1:ja 源語（原文含 CJK）cache hit → 應注入譯文 ──
      const orig = '今日のニュースをお伝えします';
      const key = orig.replace(/\\s+/g, ' ').trim().toLowerCase();  // 同 normText
      YT.captionMap.set(key, '為您帶來今日新聞');

      const seg = document.createElement('span');
      seg.className = 'ytp-caption-segment';
      seg.textContent = orig;
      document.body.appendChild(seg);

      window.__SK._replaceSegmentEl(seg);
      const case1Text = seg.textContent;

      // ── Case 2：注入後同 el 再觸發回呼（模擬自己注入引起的 characterData mutation）
      //    譯文 key 不在 captionMap(cache miss)→ 必須被自我迴圈 guard 擋下，
      //    不得進 onTheFly（pendingQueue / onTheFlyTotal 不增）──
      window.__SK._replaceSegmentEl(seg);

      return {
        case1Text,
        case1Injected: case1Text === '為您帶來今日新聞',
        pendingSize: YT.pendingQueue.size,
        onTheFlyTotal: YT.onTheFlyTotal,
        case2TextStable: seg.textContent === '為您帶來今日新聞',
      };
    })()
  `);

  // 斷言（核心 1）:ja 源語原文應被替換為譯文（RE_CJK 一刀擋會讓它永遠停在原文）
  expect(
    result.case1Injected,
    `ja 原文應被替換為譯文，實際： ${result.case1Text}`,
  ).toBe(true);

  // 斷言（核心 2）：注入後的回呼不得進 onTheFly（否則譯文被當 miss 重送 API，燒 token 迴圈）
  expect(
    result.pendingSize,
    `注入後再回呼不應 enqueue onTheFly(pendingQueue.size=${result.pendingSize})`,
  ).toBe(0);
  expect(result.onTheFlyTotal, '注入後再回呼不應累計 onTheFlyTotal').toBe(0);
  expect(result.case2TextStable, '第二次回呼後譯文應保持不變').toBe(true);

  await page.close();
});
