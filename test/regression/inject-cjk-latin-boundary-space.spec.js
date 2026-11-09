// Regression: inject-cjk-latin-boundary-space (台灣排版 CJK-Latin 空格)
//
// Fixture: test/regression/fixtures/inject-cjk-latin-boundary-space.html
// 結構特徵:tweetText > SPAN("...rights ") + A.url。SPAN 內文以 Latin "rights " 結尾
// 有 trailing space,LLM 重組句子後 trailing 變 CJK 結尾(...瓶頸)且 LLM 把 space 吃掉。
//
// 修法前:deserialize 後 SPAN.text 為 "...瓶頸"(無 trailing space)→ A.url 直接接,
// 視覺「轉播權https://...」黏一起(@9to5mac image #6 真實案例)。
// 修法後:parseSegment 在 append slot element 進 frag 之前,查 frag tail CJK + slot
// head Latin → 補 space 到 tail trailing text node。
//
// SANITY 紀錄(已驗證):暫拿掉 _maybePadCjkLatinSpace 呼叫 → 本 spec fail(SPAN.text
// 結尾不含 space) → 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-cjk-latin-boundary-space';
const TARGET_SELECTOR = '#target';

test('CJK-Latin 邊界:LLM 丟掉 placeholder 前 trailing space → deserialize 自動補', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await page.evaluate((sel) => {
    const tt = document.querySelector(sel);
    const prefix = tt.querySelector('.prefix');
    const a = tt.querySelector('a.url');
    return {
      prefix_text: prefix?.firstChild?.nodeValue,
      a_text: a?.textContent,
      url_prev_char: (() => {
        const s = tt.textContent;
        const i = s.indexOf('https://');
        return i > 0 ? s.charAt(i - 1) : null;
      })(),
    };
  }, TARGET_SELECTOR);

  // 關鍵斷言:prefix SPAN 結尾應該有 trailing space(視覺與 URL 分開)
  expect(result.prefix_text, 'prefix 含 CJK 譯文').toContain('轉播權');
  expect(result.prefix_text, 'prefix 結尾應補 trailing space(原 trailing space 被 LLM 吃掉,deserialize 自動補)').toMatch(/ $/);
  // URL 前一字元應為 space(不是直接接 CJK)
  expect(result.url_prev_char, 'URL 前一字元應為 space').toBe(' ');

  await page.close();
});
