// Unit test: layout-analyzer 分行 / label-value merge 的遞移排序重構(§27 批次 4-9)
//
// Bug:groupIntoLines / mergeLabelValueRows 原用「tolerance 式 y 相等 + left
// tiebreak」單一 comparator——非遞移(a≈b、b≈c 推不出 a≈c),Array.sort 對
// 非遞移 comparator 的輸出依實作而異,row 邊界附近的 run / line 順序不穩定。
// 修法:兩階段——純按 top 升序(遞移)分 visual row,row 內再按 left 升序處理。
// (markSiblingsInRow 的 comparator 本來就是純 top 排序,無此問題,未改)
//
// SANITY 紀錄(已驗證,2026-06-11):暫時拿掉 groupIntoLines row 內的
// `.sort((a, b) => a.bbox[0] - b.bbox[0])` → 「雙欄同 row(右欄 top 略小)切
// 兩條 line」斷言 fail(右欄先處理 → 左欄 xGap 負值被誤併);「同 row 拼字」
// case 不 fail(finalizeLine 行內重排兜底,該 case 鎖的是這個兜底行為)。
// mergeLabelValueRows 同手法(拿掉 row 內 left sort)→ 「label/value 逆序輸入
// 仍 merge」fail。還原後全部 pass。

import { test, expect } from '@playwright/test';
import { groupIntoLines, mergeLabelValueRows } from '../../shinkansen/translate-doc/layout-analyzer.js';

// 最小 run 物件(finalizeLine 讀 bbox / fontSize / fontName / text)
function run(text, x0, top, w = 50, h = 12) {
  return { text, bbox: [x0, top, x0 + w, top + h], fontSize: 12, fontName: 'f1' };
}

// 最小 line 物件(mergeLabelValueRows 讀 bbox / plainText / runs)
function line(plainText, x0, top, w = 50, h = 12) {
  return { plainText, bbox: [x0, top, x0 + w, top + h], runs: [], fontSize: 12 };
}

const MEDIAN_LH = 12; // sameLineMaxXGap = 12 × 4 = 48

test.describe('groupIntoLines 兩階段分行', () => {
  test('同 row 內 top 順序與 left 順序相反,run 仍按 left 拼字', () => {
    // 右邊的 run top 反而較小:純 top 排序會讓它先進 row。拼字順序由
    // finalizeLine 的行內 left 重排兜底(本 case 鎖該行為);row 內 left sort
    // 的真正判別點是下一個 case(x gap 切行判斷依賴處理順序)
    const a = run('Hello', 50, 101);
    const b = run('World', 105, 100); // top 差 1 ≤ tolerance 2,xGap 5 ≤ 48
    for (const input of [[a, b], [b, a]]) {
      const lines = groupIntoLines(input.slice(), MEDIAN_LH);
      expect(lines).toHaveLength(1);
      expect(lines[0].plainText).toBe('HelloWorld');
    }
  });

  test('雙欄同 row(右欄 top 略小 + x gap 大)切兩條 line,與輸入順序無關', () => {
    // 右欄 top 較小:沒有 row 內 left sort 時會先處理右欄,左欄 xGap 變負值
    // 被誤併進同一條 line
    const left = run('LeftCol', 50, 101);
    const right = run('RightCol', 400, 100); // xGap = 400 - 100 = 300 > 48
    for (const input of [[left, right], [right, left]]) {
      const lines = groupIntoLines(input.slice(), MEDIAN_LH);
      expect(lines).toHaveLength(2);
      expect(lines[0].plainText).toBe('LeftCol');
      expect(lines[1].plainText).toBe('RightCol');
    }
  });

  test('top 漸移鏈(tolerance 內 / 外)分 row 確定,且全排列輸出一致', () => {
    // tops 100 / 101.5 / 103:row 以第一條(top 最小)為 refTop,
    // 101.5 在 tolerance 2 內、103 超出 → row1 = [100, 101.5],row2 = [103]
    const r1 = run('A', 50, 100);
    const r2 = run('B', 105, 101.5);
    const r3 = run('C', 50, 103);
    const perms = [
      [r1, r2, r3], [r1, r3, r2], [r2, r1, r3], [r2, r3, r1], [r3, r1, r2], [r3, r2, r1],
    ];
    const outputs = perms.map((p) => groupIntoLines(p.slice(), MEDIAN_LH).map((l) => l.plainText));
    for (const out of outputs) {
      expect(out).toEqual(['AB', 'C']);
    }
  });
});

test.describe('mergeLabelValueRows 兩階段 row 掃描', () => {
  test('label / value 逆序輸入(value top 略小)仍 merge', () => {
    // merge 會就地改 line 物件,每個輸入順序都用新建物件
    for (const order of ['label-first', 'value-first']) {
      const label = line('Name:', 50, 100.5, 40);
      const value = line('Jimmy', 100, 100, 40); // xGap = 100 - 90 = 10 ≤ 144
      const input = order === 'label-first' ? [label, value] : [value, label];
      const out = mergeLabelValueRows(input, MEDIAN_LH);
      expect(out).toHaveLength(1);
      expect(out[0].plainText).toBe('Name: Jimmy');
    }
  });

  test('不同 row(top 差超過 tolerance)不 merge', () => {
    const label = line('Name:', 50, 100, 40);
    const value = line('Jimmy', 100, 110, 40);
    const out = mergeLabelValueRows([label, value], MEDIAN_LH);
    expect(out).toHaveLength(2);
  });
});
