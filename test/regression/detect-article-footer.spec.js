// Regression: article-footer (對應 v1.0.9 修的 main/article 內 footer 放行)
//
// Fixture: test/regression/fixtures/article-footer.html
// 結構特徵:
//   <footer> 在 <main> 或 <article> 內 → 內容 footer（文章附屬資訊如刊登期數），應翻譯
//   <footer> 不在 <main> 也不在 <article> 內 → 站底 footer（版權聲明、導覽連結），應跳過
//
// v1.0.8 以前的 bug:
//   SEMANTIC_CONTAINER_EXCLUDE_TAGS 含 FOOTER，一律 REJECT。
//   isContentFooter 只認 WordPress block，不認 main/article 祖先。
//   New Yorker 等 CSS-in-JS 網站的「刊登資訊」被放在 <main> 內的 <footer>，
//   被錯誤排除。
//
// v1.0.9 修法:
//   isContentFooter 新增「footer 有 <article> 或 <main> 祖先」判斷。
//   footer 在 main/article 內 → 回傳 true → isInsideExcludedContainer 放行。
//   footer 不在 main/article 內 → 維持原本邏輯排除。
//
// 斷言基於 DOM 結構（main/article 祖先有無），不綁站點，符合硬規則 8。
// <!-- SANITY-PENDING: 移除 isContentFooter 的 main/article 祖先判斷，確認 #print-edition 消失 -->
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'article-footer';
const PRINT_EDITION_SELECTOR = 'p#print-edition';

test('article-footer: main 內的 footer 段落必須被偵測為翻譯單位', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(PRINT_EDITION_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  // 斷言 1: #print-edition（main 內 footer 的 <p>）必須被偵測到
  const printUnit = units.find((u) =>
    (u.textPreview || '').includes('print edition')
  );
  expect(printUnit, '應偵測到 main 內 footer 含 "print edition" 的翻譯單位').toBeDefined();

  // 斷言 2: #article-print（article 內 footer 的 <p>）也必須被偵測到
  const articlePrintUnit = units.find((u) =>
    (u.textPreview || '').includes('spring 2024')
  );
  expect(articlePrintUnit, '應偵測到 article 內 footer 含 "spring 2024" 的翻譯單位').toBeDefined();

  // 斷言 3: #site-copyright（站底 footer 的 <p>）不應被偵測到
  const copyrightUnit = units.find((u) =>
    (u.textPreview || '').includes('Condé Nast')
  );
  expect(copyrightUnit, '站底 footer 的文字不應被偵測').toBeUndefined();

  // 斷言 4: 正常段落仍正常偵測
  const bodyUnit = units.find((u) =>
    (u.textPreview || '').includes('bilingual education')
  );
  expect(bodyUnit, '正常段落應被偵測').toBeDefined();

  await page.close();
});

test('article-footer: 注入譯文後文字正確替換', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(PRINT_EDITION_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await runTestInject(evaluate, PRINT_EDITION_SELECTOR, translation);

  const injectedText = await evaluate(`
    document.querySelector(${JSON.stringify(PRINT_EDITION_SELECTOR)}).textContent.trim()
  `);
  expect(injectedText).toContain('印刷版');

  await page.close();
});
