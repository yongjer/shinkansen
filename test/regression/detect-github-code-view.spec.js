// Regression: github-code-view (對應「GitHub 新版 React 檔案瀏覽器 code 被翻譯」bug)
//
// Fixture: test/regression/fixtures/github-code-view.html
// 結構特徵(通用,不綁站名):
//   - 容器 computed font-family 含 monospace 系列字眼
//   - 容器 computed white-space 是 pre / pre-wrap
//   - 每行用 <div> 而非 <pre>/<code>
//
// 修法前的 bug:
//   HARD_EXCLUDE 只擋 <code> / <pre>+<code>。GitHub 新版不用這兩個 tag,
//   每行 <div> 文字夠長就被當段落送翻(整份 package.json / 程式碼被翻成中文)。
//
// 修法:
//   content-detect.js isInsideExcludedContainer 新增「祖先 computed
//   font-family 含 monospace 且 white-space 為 pre 系」判斷,整子樹 reject。
//
// 斷言基於結構特徵(monospace + pre),不綁站點/class,符合硬規則 §6 / §8。
//
// SANITY 紀錄(已驗證 2026-05-05):
//   1. content-detect.js isInsideExcludedContainer 內 `if (isCodeContainer(cur)) ...`
//      註解掉 → leaf-content-span 補抓路徑把 <span class="pl-s">"Shinkansen Chrome
//      Extension Playwright automation..."</span> 偵測為段落,spec fail。
//   2. 還原 → leak 消失,pass。確認 spec 真有抓到 leak 點(主路徑是 leaf 補抓
//      span:not(:has(*)),不是主 walker)。
import { test, expect } from '../fixtures/extension.js';
import {
  getShinkansenEvaluator,
} from './helpers/run-inject.js';

const FIXTURE = 'github-code-view';

test('github-code-view: monospace + white-space:pre 容器內的行不應被偵測為翻譯單位', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.code-view', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units } = JSON.parse(result);

  // 斷言 1: 沒有任何 unit 的文字落在 .code-view 子樹內
  // 用 description 值字串(只在 code 容器內出現)當代表特徵——leaf-content-span
  // 補抓路徑會把單一長文字 <span class="pl-s">"...description value..."</span>
  // 抓出來,為主要 leak 點。
  const codeViewUnits = units.filter((u) => {
    const preview = (u.textPreview || '');
    return preview.includes('Shinkansen Chrome Extension Playwright automation')
      || preview.includes('shinkansen-tests')
      || preview.includes('"description"')
      || preview.includes('"version"')
      || preview.includes('"scripts"');
  });
  expect(
    codeViewUnits.length,
    `monospace + white-space:pre 容器內的行不應被偵測,實際偵測到 ${codeViewUnits.length} 個。units: ${JSON.stringify(units.map((u) => u.tag + ':' + (u.textPreview || '').substring(0, 60)))}`,
  ).toBe(0);

  // 斷言 2: 控制組——容器外的一般段落仍正常被偵測
  const articleUnits = units.filter((u) =>
    (u.textPreview || '').includes('regular article paragraph')
    || (u.textPreview || '').includes('After the code block')
  );
  expect(
    articleUnits.length,
    `容器外的一般 <p> 應正常偵測(monospace 規則不能誤殺),實際 ${articleUnits.length} 個`,
  ).toBeGreaterThanOrEqual(2);

  await page.close();
});
