// Regression: aria-tree-files(對應「GitHub Files sidebar 檔名被翻譯 / icon 消失」bug)
//
// Fixture: test/regression/fixtures/aria-tree-files.html
// 結構特徵:
//   <ul role="tree" aria-label="Files">
//     <li role="treeitem">...檔名 + SVG icon...</li>
//   </ul>
//
// 修法前 bug:
//   EXCLUDE_ROLES 只擋 'banner' / 'contentinfo' / 'search' / 'grid'。role="tree"
//   進不到擋下名單,walker 把每個 treeitem 內的檔名當段落送翻 → injectIntoTarget
//   走 clean-slate 路徑替換 innerHTML → 檔名翻成「英文版說明文件.md」+ SVG icon
//   一併消失,整個 file panel 視覺崩壞。
//
// 修法:
//   content-ns.js EXCLUDE_ROLES 加入 'tree' 與 'treeitem'。isInsideExcludedContainer
//   走訪祖先鏈遇到 role="tree" / "treeitem" → 整子樹 reject。
//
// 斷言基於 ARIA 語意(W3C 定義 role="tree" 為階層 widget),不綁站點 / class,
// 符合 §6 / §8。
//
// SANITY 紀錄(已驗證 2026-05-05):
//   1. EXCLUDE_ROLES 加 'tree' 拿掉 → 5 個 treeitem 被偵測為段落 → spec fail
//   2. 還原 → 0 個 → pass。控制組 <p> 不受影響(2 個 article 段落仍偵測)
import { test, expect } from '../fixtures/extension.js';
import {
  getShinkansenEvaluator,
} from './helpers/run-inject.js';

const FIXTURE = 'aria-tree-files';

test('aria-tree-files: role="tree" 子樹內任何元素都不應被偵測為段落', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ul[role="tree"]', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units } = JSON.parse(result);

  // 斷言 1: 沒有任何 unit 的文字落在 role="tree" 子樹內(用檔名做特徵)
  const treeUnits = units.filter((u) => {
    const preview = (u.textPreview || '');
    return preview.includes('README.md')
      || preview.includes('SPEC.md')
      || preview.includes('PERFORMANCE.md')
      || preview.includes('firefox-build.sh')
      || preview.includes('.github');
  });
  expect(
    treeUnits.length,
    `role="tree" 子樹內檔名不應被偵測,實際 ${treeUnits.length} 個。units: ${JSON.stringify(units.map((u) => u.tag + ':' + (u.textPreview || '').substring(0, 60)))}`,
  ).toBe(0);

  // 斷言 2: 控制組——容器外的一般段落仍正常被偵測(不誤殺)
  const articleUnits = units.filter((u) =>
    (u.textPreview || '').includes('regular article paragraph')
    || (u.textPreview || '').includes('After the file tree')
  );
  expect(
    articleUnits.length,
    `<article> 內的一般 <p> 仍應正常偵測,實際 ${articleUnits.length}`,
  ).toBeGreaterThanOrEqual(2);

  await page.close();
});
