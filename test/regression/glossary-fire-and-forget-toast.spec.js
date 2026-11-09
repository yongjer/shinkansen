// Regression(對應加「fire-and-forget 術語表也顯示『建立術語表』toast」的 UX 修法):
//
// 背景:術語表依批次數三級——短頁(<= skipThreshold)跳過、中頁(skipThreshold <
//   批次 <= blockingThreshold)走 fire-and-forget(背景抽、不 blocking 首字)、長頁
//   (> blockingThreshold)走 blocking。原本只有 blocking 路徑會 SK.showToast
//   'toast.glossaryBuilding',中頁完全無回饋 → 使用者在 popup 勾了「術語表一致化」、
//   翻一般文章卻看不到任何術語表步驟,誤以為開關沒作用。
//
// 修法:(1) 中頁 fire-and-forget else 分支也 SK.showToast('toast.glossaryBuilding')。
//   (2) 把「翻譯前短等術語表最多 2s」的 glossary-await 從翻譯進度 toast 之後移到之前,
//   讓 glossaryBuilding toast 在等待期間真的看得見(否則會被立即顯示的翻譯進度 toast 蓋掉)。
//
// 本 spec 鎖的訊號層(CLAUDE.md 工作流原則 §3):
//   驗 content.js 「原始碼結構」——(a) toast.glossaryBuilding 兩條路徑都出現(>= 2 次)、
//   (b) fire-and-forget 那條在設 STATE._glossaryPromise 之前先秀 toast、(c) glossary-await
//   (2000ms race)排在翻譯進度 toast 之前。**不驗** runtime 真的把 toast 畫出來、也不驗
//   實際 blocking/fire-and-forget 分流(那要真實 SW glossary 回應 + 完整翻譯流程,
//   jsdom / 純 source 測不到)。真機/瀏覽器視覺需另行手驗。
//
// SANITY 紀錄(已驗證):
//   - 拿掉 fire-and-forget else 分支新增的 glossaryBuilding toast → 出現次數掉回 1 → (a) fail。
//   - 把 glossary-await 移回翻譯進度 toast 之後(還原順序)→ (c) idxAwait < idxProgress fail。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONTENT_JS = path.resolve(__dirname, '../../shinkansen/content.js');

test('fire-and-forget 術語表:content.js 兩條路徑都秀 glossaryBuilding、await 排在翻譯進度 toast 前', () => {
  const src = fs.readFileSync(CONTENT_JS, 'utf8');

  // (a) toast.glossaryBuilding 至少出現兩次:blocking + fire-and-forget 各一。
  const buildingCount = (src.match(/toast\.glossaryBuilding/g) || []).length;
  expect(buildingCount, 'blocking 與 fire-and-forget 兩條路徑都應顯示 glossaryBuilding toast(>= 2 次)').toBeGreaterThanOrEqual(2);

  // (b) fire-and-forget 那條 glossaryBuilding 必須排在設 STATE._glossaryPromise 之前
  //     (確保新增的 toast 落在 fire-and-forget else 分支、不是誤複製到別處)。
  const idxPromiseAssign = src.indexOf('STATE._glossaryPromise = glossaryPromise');
  expect(idxPromiseAssign, '應保有 fire-and-forget 的 STATE._glossaryPromise 指派').toBeGreaterThan(-1);
  const idxFireForgetToast = src.lastIndexOf('toast.glossaryBuilding', idxPromiseAssign);
  expect(idxFireForgetToast, 'fire-and-forget 分支在設 _glossaryPromise 前應先秀 glossaryBuilding toast').toBeGreaterThan(-1);

  // 且這條(第二條)必須晚於 blocking 路徑那條(第一條),確認是新增的而非同一條。
  const idxFirstBuilding = src.indexOf('toast.glossaryBuilding');
  expect(idxFireForgetToast, 'fire-and-forget toast 應是第二條(晚於 blocking 那條)').toBeGreaterThan(idxFirstBuilding);

  // (c) glossary-await(2000ms race)必須排在翻譯進度 toast 之前,否則 building toast
  //     會被立即顯示的翻譯進度 toast 蓋掉、等於沒顯示。
  const idxAwait = src.indexOf('resolve(null), 2000');
  const idxProgressToast = src.indexOf('toast.translateProgress');
  expect(idxAwait, '應保有 fire-and-forget 的 2000ms glossary-await').toBeGreaterThan(-1);
  expect(idxProgressToast, '應保有翻譯進度 toast').toBeGreaterThan(-1);
  expect(idxAwait, 'glossary-await 必須排在翻譯進度 toast 之前(否則 building toast 看不見)').toBeLessThan(idxProgressToast);
});
