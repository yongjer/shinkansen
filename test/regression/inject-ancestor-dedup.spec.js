// Regression: inject-ancestor-dedup (§5 單一資料源)
//
// Fixture: test/regression/fixtures/inject-ancestor-dedup.html
// 結構特徵:framework-managed parent(tweetText)走 nvMutate 成功設 attrs 後,
// 內部 child SPAN[5] 因為 React fiber 失效(restorePage 後 innerHTML 重 parse 的
// orphan node)走 standard slots path,replaceNodeInPlace 把 nvMutate 結果蓋掉。
//
// 修法前:standard slots / fragment / no-slots 路徑不檢查祖先 dedup,後 inject
// 蓋掉先 inject(image #5:Yoink 推文 restore + retranslate 後段落 \n\n 丟失)。
// 修法後:injectTranslation 入口加全局祖先 dedup,任何 path 共用 — 祖先 element
// 已被任一 inject path 標記 translated/dual-source/nv-mutated → bail。
//
// 本 spec 用順序 inject 模擬 X restore + retranslate cycle:
//   1. testInject parent → framework branch nvMutate 成功(parent 設 attrs)
//   2. testInject child(parent attrs 仍在)→ 入口 dedup 應該 bail,child 內結構
//      保持 nvMutate 後的狀態,不被 replaceNodeInPlace 蓋成 fragment 結構
//
// SANITY 紀錄(已驗證):暫拿掉 injectTranslation 入口祖先 dedup → 本 spec fail
//   (child 內結構變 [text, BR, BR, text] 4 個 children + parent attrs 雖在但被
//    second inject 又設 translated)→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

function loadResp(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8').replace(/\n+$/, '');
}

test('§5 ancestor dedup:parent inject 後 child inject 應 bail 不覆蓋', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-ancestor-dedup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#parent', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const parentTranslation = loadResp('inject-ancestor-dedup.parent.response.txt');
  const childTranslation = loadResp('inject-ancestor-dedup.child.response.txt');

  // parent 走 framework-managed nvMutate path
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  // 抓 child SPAN ref + 內部 text node ref
  await page.evaluate(() => {
    const child = document.querySelector('#child');
    window.__before = {
      child,
      childText: child.firstChild,
      childChildCount: child.children.length, // 0 個子 element
    };
  });

  // 第一輪:testInject parent → 走 framework branch → nvMutate 成功,parent 設 attrs
  await runTestInject(evaluate, '#parent', parentTranslation);

  const afterParent = await page.evaluate(() => {
    const parent = document.querySelector('#parent');
    const child = document.querySelector('#child');
    const b = window.__before;
    return {
      parent_translated: parent.hasAttribute('data-shinkansen-translated'),
      parent_nvMutated: parent.hasAttribute('data-shinkansen-nodevalue-mutated'),
      child_sameRef: child === b.child,
      child_textSameRef: child.firstChild === b.childText,
      child_childCount: child.children.length, // 應仍 0(text 已 mutate,不重建)
      child_text_value: child.firstChild?.nodeValue?.slice(0, 80),
    };
  });
  expect(afterParent.parent_translated, 'parent 設 translated attr').toBe(true);
  expect(afterParent.parent_nvMutated, 'parent 走 nvMutate').toBe(true);
  expect(afterParent.child_sameRef, '第一輪後 child ref 不變').toBe(true);
  expect(afterParent.child_textSameRef, 'child text node ref 不變(nvMutate)').toBe(true);
  expect(afterParent.child_childCount, 'child 內仍 0 子 element').toBe(0);
  expect(afterParent.child_text_value, 'child text 已被 mutate 為中文').toContain('v2.5.5 正式版');

  // 第二輪:testInject child(模擬 SPAN[5] 自己當 unit 又跑一次 inject)
  // child 此時是 orphan node(沒 framework fiber),會跳過 framework branch 走 standard
  // slots path 的 replaceNodeInPlace → 沒入口 dedup 會把 child 結構蓋成 [text, BR, BR, text]
  // 帶入口 dedup → 祖先 parent 有 data-shinkansen-translated → bail,不蓋
  await evaluate(`window.__SK.isFrameworkManaged = () => false`);
  await runTestInject(evaluate, '#child', childTranslation);

  const afterChild = await page.evaluate(() => {
    const child = document.querySelector('#child');
    const b = window.__before;
    return {
      child_sameRef: child === b.child,
      child_textSameRef: child.firstChild === b.childText,
      child_childCount: child.children.length, // 必須仍 0,沒被 replaceNodeInPlace 蓋成 BR 結構
      child_text_value: child.firstChild?.nodeValue?.slice(0, 80),
      child_has_translated: child.hasAttribute('data-shinkansen-translated'),
    };
  });
  // 關鍵斷言:child 內結構沒被 standard path 蓋掉
  expect(afterChild.child_childCount, '第二輪 inject 應因祖先 dedup bail,child 內仍 0 子 element(沒變 [text, BR, BR, text])').toBe(0);
  expect(afterChild.child_textSameRef, 'child text node ref 仍是第一輪 mutate 過的同一個').toBe(true);
  expect(afterChild.child_text_value, 'child text 維持第一輪 mutate 的中文').toContain('v2.5.5 正式版');
  expect(afterChild.child_has_translated, 'child 自己不應被 inject 設 translated attr(祖先已標)').toBe(false);

  await page.close();
});
