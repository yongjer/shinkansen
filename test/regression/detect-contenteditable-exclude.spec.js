// Regression: contenteditable-exclude (對應 v1.0.10 排除 contenteditable/textbox)
//
// Fixture: test/regression/fixtures/contenteditable-exclude.html
// 結構特徵:
//   contenteditable="true" 或 role="textbox" 的容器是表單控制項，等同 <textarea>，
//   內部的 placeholder 文字不該被翻譯，翻譯會破壞表單互動與排版。
//
// v1.0.9 以前的 bug:
//   HARD_EXCLUDE_TAGS 排除 TEXTAREA/INPUT，但不處理 contenteditable div。
//   Medium 留言輸入框用 <div role="textbox" contenteditable="true"> 包住
//   placeholder "What are your thoughts?"，被 walker 的 <p> 偵測到並翻譯，
//   導致排版跑掉。
//
// v1.0.10 修法:
//   isInsideExcludedContainer 新增 contenteditable="true" 與 role="textbox" 判斷。
//
// 斷言基於 DOM attribute（contenteditable / role），不綁站點，符合硬規則 8。
// <!-- SANITY-PENDING: 移除 isInsideExcludedContainer 的 contenteditable 判斷，確認 #ce-placeholder 出現 -->
import { test, expect } from '../fixtures/extension.js';
import {
  getShinkansenEvaluator,
} from './helpers/run-inject.js';

const FIXTURE = 'contenteditable-exclude';

test('contenteditable-exclude: contenteditable 內的文字不應被偵測', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#article-text', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units } = JSON.parse(result);

  // 斷言 1: #ce-placeholder（contenteditable 內）不應被偵測
  const cePlaceholder = units.find((u) =>
    (u.textPreview || '').includes('your thoughts')
  );
  expect(cePlaceholder, 'contenteditable 內的 placeholder 不應被偵測').toBeUndefined();

  // 斷言 2: #textbox-placeholder（role=textbox 內）不應被偵測
  const textboxPlaceholder = units.find((u) =>
    (u.textPreview || '').includes('Write a comment')
  );
  expect(textboxPlaceholder, 'role=textbox 內的文字不應被偵測').toBeUndefined();

  // 斷言 3: #article-text（正常段落）應被偵測
  const articleUnit = units.find((u) =>
    (u.textPreview || '').includes('art industry')
  );
  expect(articleUnit, '正常文章段落應被偵測').toBeDefined();

  await page.close();
});
