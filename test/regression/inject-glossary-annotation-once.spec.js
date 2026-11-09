// Regression: inject-glossary-annotation-once（術語表對照「只出現一次」注入端裁剪）
//
// Fixture: test/regression/fixtures/glossary-annotation-once.html
// 結構：多個 <p> 各含同一術語（alpha-gal / watchfluencer）多次出現，跨多個
//       注入單元（模擬整頁跨批翻譯，每段獨立經 injectTranslation 入口）。
// Bug：自動術語表 tech 類 target 自帶「譯名（原文）」對照，system prompt 又要求
//      模型每次出現都完整輸出（EPUB 抗剝除措辭）→ 網頁譯文每次出現都是全對照，
//      蓋掉主 prompt「僅首次加註」；整頁跨批模型層做不到「全頁只加註一次」。
// 修法：注入端確定性裁剪（content-inject.js trimAnnotationDedupe）——
//      setAnnotationDedupeRules 由當前 run glossary 建規則，injectTranslation 統一
//      入口對整頁第一個出現保留完整對照、後續只留譯名；seen 跨段延續、
//      同一 keeper 元素 re-inject 不誤裁、clear 後歸零。
//
// SANITY 紀錄（已驗證）：把 content-inject.js injectTranslation 入口的
//   `translation = SK.trimAnnotationDedupe(...)` 那行註解掉 → 本 spec「後續段落
//   只留譯名」斷言 fail（p2/p3 仍出現「（alpha-gal）」全對照）→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'glossary-annotation-once';

// 對照 target：慣例「譯名（原文）」。source 供 setAnnotationDedupeRules 判斷方向。
const GLOSSARY = [
  { source: 'alpha-gal', target: 'α-半乳糖（alpha-gal）', type: 'tech' },
  { source: 'watchfluencer', target: '錶壇網紅（watchfluencer）', type: 'tech' },
];

// 各段的「模型完整輸出」譯文（每次出現都帶全對照，模擬 LLM 遵照注入指令）
const T = {
  p1: '過敏原是 α-半乳糖（alpha-gal），而 α-半乳糖（alpha-gal）是哺乳動物體內的醣分子。',
  p2: '研究人員測量了蜱唾液樣本中 α-半乳糖（alpha-gal）的濃度。',
  p3: '另一段提到 α-半乳糖（alpha-gal）用於跨批延續檢查。',
  p4: '重設情境下再次出現 α-半乳糖（alpha-gal）的新段落。',
  p5: '這位錶壇網紅（watchfluencer）發布了一支關於古董計時錶的爆紅影片。',
  p6: '上週又有一位錶壇網紅（watchfluencer）加入這股潮流。',
};

async function injectOrder(evaluate, order) {
  for (const id of order) {
    await evaluate(`
      (() => {
        const el = document.querySelector('#${id}');
        return window.__shinkansen.testInject(el, ${JSON.stringify(T[id])});
      })()
    `);
  }
}

async function textOf(evaluate, id) {
  return evaluate(`document.querySelector('#${id}').textContent`);
}

test('對照只出現一次：整頁首現保留全對照，後續同段/跨段只留譯名', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#p1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.setAnnotationDedupeRules(${JSON.stringify(GLOSSARY)})`);

  await injectOrder(evaluate, ['p1', 'p2', 'p3', 'p5', 'p6']);

  const p1 = await textOf(evaluate, 'p1');
  const p2 = await textOf(evaluate, 'p2');
  const p3 = await textOf(evaluate, 'p3');
  const p5 = await textOf(evaluate, 'p5');
  const p6 = await textOf(evaluate, 'p6');

  // p1：整頁第一段。第一次出現保留全對照，同段第二次出現只留譯名
  expect(p1).toContain('α-半乳糖（alpha-gal）');
  expect((p1.match(/（alpha-gal）/g) || []).length).toBe(1);
  // 同段第二次出現只留譯名（替換左右都是 CJK → 不補空格，對齊 epub-writer 邊界規則）
  expect(p1).toContain('而 α-半乳糖是哺乳動物');

  // p2 / p3：跨段後續出現只留譯名，不帶對照
  expect(p2).not.toContain('（alpha-gal）');
  expect(p2).toContain('α-半乳糖');
  expect(p3).not.toContain('（alpha-gal）');
  expect(p3).toContain('α-半乳糖');

  // 不同術語各自獨立計數：watchfluencer 首現（p5）保留、後續（p6）裁剪
  expect(p5).toContain('錶壇網紅（watchfluencer）');
  expect(p6).not.toContain('（watchfluencer）');
  expect(p6).toContain('錶壇網紅');

  await page.close();
});

test('keeper 元素 re-inject 不誤裁：framework 打回原文後重注入仍保留完整對照', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#p1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.setAnnotationDedupeRules(${JSON.stringify(GLOSSARY)})`);

  // p1 先注入（成為整頁 keeper），p2 後注入（被裁 → rule.seen=true）
  await injectOrder(evaluate, ['p1', 'p2']);
  const originalHtml = await evaluate(`window.__SK.STATE.originalHTML.get(document.querySelector('#p1'))`);

  // framework re-render 把 p1 打回原文（content guard 會偵測到並 re-inject 譯文）。
  // 元素 ref 不變 → keeper 身分應延續：重注入仍保留當初那份完整對照，
  // 不因 rule.seen=true 被誤裁成只剩譯名
  await evaluate(`document.querySelector('#p1').innerHTML = ${JSON.stringify(originalHtml)}`);
  await injectOrder(evaluate, ['p1']);

  const p1 = await textOf(evaluate, 'p1');
  expect(p1).toContain('α-半乳糖（alpha-gal）');
  expect((p1.match(/（alpha-gal）/g) || []).length).toBe(1);

  await page.close();
});

test('clearAnnotationDedupeRules 後歸零：新 run 首段重新保留全對照', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#p1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.setAnnotationDedupeRules(${JSON.stringify(GLOSSARY)})`);
  await injectOrder(evaluate, ['p1']);

  // 還原（restorePage 會呼叫）→ 清規則 → 重新設定 → p4 現在是「新 run 首段」
  await evaluate(`window.__SK.clearAnnotationDedupeRules()`);
  await evaluate(`window.__SK.setAnnotationDedupeRules(${JSON.stringify(GLOSSARY)})`);
  await injectOrder(evaluate, ['p4']);

  const p4 = await textOf(evaluate, 'p4');
  expect(p4).toContain('α-半乳糖（alpha-gal）');
  expect((p4.match(/（alpha-gal）/g) || []).length).toBe(1);

  await page.close();
});

test('無規則時 no-op：未啟用術語表的譯文原樣注入', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#p1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.clearAnnotationDedupeRules()`);
  await injectOrder(evaluate, ['p1', 'p2']);

  // 沒規則 → 每段都原樣（模型完整輸出保留），裁剪不介入
  const p1 = await textOf(evaluate, 'p1');
  const p2 = await textOf(evaluate, 'p2');
  expect((p1.match(/（alpha-gal）/g) || []).length).toBe(2);
  expect(p2).toContain('（alpha-gal）');

  await page.close();
});
