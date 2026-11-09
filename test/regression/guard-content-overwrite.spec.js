// Regression: guard-content-overwrite (對應 v1.0.13+v1.0.14+v1.0.20 Content Guard)
//
// Fixture: test/regression/fixtures/guard-overwrite.html
// 結構: 簡單 <p> 段落，模擬「翻譯注入 → 框架覆寫 → guard 修復」完整路徑
//
// 結構通則 (不綁站名): SPA 框架在捲動時覆寫已翻譯元素的 innerHTML 回原文，
// Content Guard 從 STATE.translatedHTML 快取偵測到不符後重新套用譯文。
// 此測試鎖死 guard 的核心邏輯：快取比對 + innerHTML 修復。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'guard-overwrite';
const TARGET_SELECTOR = 'p#target';

test('guard-content-overwrite: 框架覆寫 innerHTML 後 guard 修復回中文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // 記住注入前的原始英文
  const originalText = await page.evaluate(
    (sel) => document.querySelector(sel).textContent,
    TARGET_SELECTOR,
  );
  expect(originalText).toContain('quick brown fox');

  // 步驟 1: 注入譯文（testInject 會同時填充 STATE.translatedHTML 快取）
  await runTestInject(evaluate, TARGET_SELECTOR, translation);

  // 驗證注入後是中文
  const afterInject = await page.evaluate(
    (sel) => document.querySelector(sel).textContent,
    TARGET_SELECTOR,
  );
  expect(afterInject, '注入後應包含中文譯文').toContain('棕色狐狸');

  // 步驟 2: 設定 STATE.translated = true（模擬翻譯完成，guard 需要此旗標）
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  // 驗證 guard 快取已填充
  const stateAfterInject = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.getState())`));
  expect(stateAfterInject.guardCacheSize, 'guard 快取應有 1 條').toBeGreaterThanOrEqual(1);

  // 步驟 3: 模擬框架覆寫 — 用 innerHTML 把元素改回英文
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.innerHTML = 'The quick brown fox jumps over the lazy dog near the riverbank on a sunny afternoon';
  }, TARGET_SELECTOR);

  // 驗證覆寫成功
  const afterOverwrite = await page.evaluate(
    (sel) => document.querySelector(sel).textContent,
    TARGET_SELECTOR,
  );
  expect(afterOverwrite, '覆寫後應恢復為英文').toContain('quick brown fox');

  // 步驟 4: 手動觸發 Content Guard
  const restoredRaw = await evaluate(`window.__shinkansen.testRunContentGuard()`);
  const restored = Number(restoredRaw);

  // 斷言: guard 應修復 1 個元素
  expect(restored, 'guard 應修復 1 個被覆寫的元素').toBe(1);

  // 斷言: 元素內容恢復為中文譯文
  const afterGuard = await page.evaluate(
    (sel) => document.querySelector(sel).textContent,
    TARGET_SELECTOR,
  );
  expect(afterGuard, 'guard 修復後應恢復中文譯文').toContain('棕色狐狸');

  // 步驟 5: 再跑一次 guard — 已經修復的不應重複修復
  const restoredAgainRaw = await evaluate(`window.__shinkansen.testRunContentGuard()`);
  expect(Number(restoredAgainRaw), '已修復的元素不應重複修復').toBe(0);

  await page.close();
});
