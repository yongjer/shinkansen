// Regression: grid-cell-leaf-detection (對應 v1.0.21+v1.0.22 Gmail inbox grid cell 修正)
//
// Fixture: test/regression/fixtures/grid-cell-leaf.html
// 結構: <table role="grid"> 內的 <td> 不整體偵測,但 leaf <span> >= 15 字被補抓
//
// 結構通則 (不綁站名): ARIA role="grid" 標記的是互動式資料格 (email 列表、
// 檔案管理器等),cell 內容是獨立資料欄位,翻譯整個 <td> 會摧毀欄位結構。
// grid 加入 EXCLUDE_ROLES 後整個 <td> 不進 walker,再用補抓 pass 掃
// cell 內部的純文字 leaf 元素,個別偵測 >= 15 字的文字。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'grid-cell-leaf';

test('grid-cell-leaf: role="grid" 的 <td> 不整體偵測,但 leaf span >= 15 字被補抓', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table[role="grid"]', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphs())
  `);
  const units = JSON.parse(result);
  const paths = units.map((u) => u.selectorPath || '');

  // 斷言 1: 正常 article 段落仍被偵測
  const controlUnit = units.find((u) => /#control-article/.test(u.selectorPath || ''));
  expect(controlUnit, '正常 #control-article 段落應該被收').toBeDefined();

  // 斷言 2: 整個 <td> 不出現在 units 裡（grid 排除生效）
  const cellIds = ['cell-sender', 'cell-subject', 'cell-preview', 'cell-date'];
  for (const id of cellIds) {
    const tdCollected = units.find(
      (u) => (u.selectorPath || '').includes(`#${id}`) && !(u.selectorPath || '').includes('#' + id + ' '),
    );
    // 如果有 match 且 selectorPath 就是 #cell-xxx 本身（非子元素），那就是 <td> 被整體偵測了
    // 但更精確的判斷：selectorPath 不應以 td#cell-xxx 結尾
    const tdDirectlyCollected = paths.some((p) => new RegExp(`td#${id}$`).test(p));
    expect(
      tdDirectlyCollected,
      `<td id="${id}"> 不應被整體偵測為翻譯單位`,
    ).toBe(false);
  }

  // 斷言 3: leaf span >= 15 字的被偵測（主旨欄位）
  const subjectUnit = units.find((u) => /#subject-text/.test(u.selectorPath || ''));
  expect(
    subjectUnit,
    'leaf #subject-text (>= 15 字元) 應該被補抓 pass 偵測到',
  ).toBeDefined();

  // 斷言 4: leaf span >= 15 字的含短文字子元素也被偵測（預覽欄位）
  const previewUnit = units.find((u) => /#preview-text/.test(u.selectorPath || ''));
  expect(
    previewUnit,
    'leaf #preview-text (含短文字子元素,總文字 >= 15 字元) 應該被偵測到',
  ).toBeDefined();

  // 斷言 5: 短文字 leaf 不被偵測（寄件者、日期）
  const senderUnit = units.find((u) => /#sender-name/.test(u.selectorPath || ''));
  expect(
    senderUnit,
    '短文字 #sender-name (< 15 字元) 不應被偵測',
  ).toBeUndefined();

  const dateUnit = units.find((u) => /#date-text/.test(u.selectorPath || ''));
  expect(
    dateUnit,
    '短文字 #date-text (< 15 字元) 不應被偵測',
  ).toBeUndefined();

  // 斷言 6: 非 role="grid" 的正常表格 <td> 內容仍被偵測
  const normalTableUnit = units.find((u) => /#normal-table-text/.test(u.selectorPath || ''));
  expect(
    normalTableUnit,
    '正常表格內的 #normal-table-text 應該被偵測（不受 grid 排除影響）',
  ).toBeDefined();

  await page.close();
});
