// Regression: 背景錯誤 error code 協定（SPEC-PRIVATE §27 錯誤字串族群）。
//
// 結構特徵：background / lib 端使用者面對錯誤不再只回繁中字串——response /
// STREAMING_ERROR payload 帶 errorCode（+ errorParams，lib/bg-error.js codedError），
// content 端 SK.i18n.bgErrorMessage() 依當前 uiLanguage 查 'error.bg.' + code 組訊息；
// 沒 code / dict 缺 key fallback 原字串原樣顯示。
//
// 本 spec 驗「完整真實路徑」（CLAUDE.md §9 真實路徑驗證）：fixture 頁 →
// SK.translatePage() → 真 background（fresh profile 無 API key → handleTranslate /
// handleTranslateStream 丟 codedError('apiKeyMissing')）→ 協定欄位過 runtime 訊息層 →
// content 端 bgErrorMessage → 批次全失敗 → SK.showToast('error',
// toast.partialFailed) 且 opts.detail = failures[0].error（本地化後的錯誤字串，
// content.js translatePage 失敗彙整路徑）。訊息層零 mock，只 spy SK.showToast 取
// msg / detail 字串（toast 在 closed Shadow root，外部讀不到渲染文字——同
// toast-master-switch.spec.js 的理由）。
//
// 訊號層界定（CLAUDE.md 工作流原則 §3）：驗「toast 訊息字串已本地化 + 協定欄位
// 真的過了 runtime 訊息層」；不驗 toast 視覺渲染（closed shadow），也不驗其他
// error code 的真實觸發（網路逾時 / 429 / 安全過濾需真 API 故障，harness 到不了；
// 那些 code 的 mapping 由 test/jest-unit/bg-error-i18n.test.cjs 覆蓋）。
//
// SANITY 紀錄（已驗證 2026-06-11）：暫時把 lib/i18n.js bgErrorMessage 的
// `if (!code) return raw;` 改成 `return raw;`（協定退化成永遠 fallback 原字串）→
// 「uiLanguage=en」case fail（Received 拿到繁中原字串；zh-TW case 斷言子字串是
// 繁中原字串的前綴，破壞下仍 pass——en case 才是本協定的 SANITY 觀測點）；
// 還原 → 全綠。同一破壞讓 test/jest-unit/bg-error-i18n.test.cjs 第 1 層 mapping 2 條 fail。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'lang-detect'; // 含英文 / 日文候選段，translatePage 會真的送批次

// 觸發整頁翻譯並等第一個 error toast 的 msg（spy SK.showToast）
async function triggerAndGetErrorToast(page, localServer, uiLang) {
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`(() => {
    window.__SK.STATE.uiLanguage = ${JSON.stringify(uiLang)};
    window.__SK._toastCalls = [];
    const orig = window.__SK.showToast;
    window.__SK.showToast = function (type, msg, opts) {
      window.__SK._toastCalls.push({ type, msg: String(msg), detail: String((opts && opts.detail) || '') });
      try { return orig.call(this, type, msg, opts); } catch (_) {}
    };
    window.__SK.translatePage();
  })()`);

  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const hit = await evaluate(
      `JSON.stringify((window.__SK._toastCalls || []).find(c => c.type === 'error') || null)`);
    if (hit && hit !== 'null') return JSON.parse(hit);
    await page.waitForTimeout(100);
  }
  return null;
}

test('無 API key 真實路徑：uiLanguage=en 時 error toast detail 顯示英文 apiKeyMissing（非繁中原字串）', async ({ context, localServer }) => {
  const page = await context.newPage();
  const toast = await triggerAndGetErrorToast(page, localServer, 'en');
  expect(toast).not.toBeNull();
  // 批次全失敗 → toast.partialFailed + detail = failures[0].error（bgErrorMessage 本地化結果）
  expect(toast.detail).toContain('Gemini API Key not set. Please enter it on the options page');
  // 協定真的生效：不是繁中原字串 fallback
  expect(toast.detail).not.toContain('尚未設定');
});

test('無 API key 真實路徑：uiLanguage=zh-TW 時 error toast detail 顯示繁中 apiKeyMissing', async ({ context, localServer }) => {
  const page = await context.newPage();
  const toast = await triggerAndGetErrorToast(page, localServer, 'zh-TW');
  expect(toast).not.toBeNull();
  expect(toast.detail).toContain('尚未設定 Gemini API Key，請至設定頁填入');
});
