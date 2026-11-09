// translate-doc/layout-analyzer.js form 處理:
//   1. mergeLabelValueRows — 同 y 的「label : value」pair 合一 line
//   2. maybeSubsplitFormBlock — 多行 block 多數行 label-shape → 每行各自 block
//
// 觸發場景:報價單 / 申請表 / 送貨單的 metadata 區雙欄 form 結構,被 PDF.js 抽出
// 後 label 跟 value x 距離不夠近也不夠遠(SAME_LINE 跟 sibling row 死區),groupIntoLines
// 切成獨立 line + classifyBlockType 因 left 跳躍誤判 table → 不送翻譯。
//
// SANITY 紀錄(已驗證):
//   - 暫時把 mergeLabelValueRows 的 `:` 結尾條件拿掉(永遠不 merge)→ 「label-value 同 y
//     合一」spec fail。還原後 pass
//   - 暫時把 FORM_SUBSPLIT_LABEL_RATIO 設 0.99(永遠不 split)→ 「form block 切多行」
//     spec fail。還原後 pass

import { test, expect } from '@playwright/test';
import {
  mergeLabelValueRows,
  maybeSubsplitFormBlock,
  maybeSubsplitTableRowCells,
} from '../../shinkansen/translate-doc/layout-analyzer.js';

function makeLine(text, leftX, topY, width, height = 8) {
  const right = leftX + width;
  const bottom = topY + height;
  return {
    bbox: [leftX, topY, right, bottom],
    plainText: text,
    fontSize: height,
    dominantFontName: 'Helvetica',
    runs: [{
      text,
      bbox: [leftX, topY, right, bottom],
      fontName: 'Helvetica',
      fontSize: height,
      isBold: false,
      isItalic: false,
      linkUrl: null,
    }],
  };
}

function makeBlock(lines, column = 0) {
  let bbox = lines[0].bbox.slice();
  for (let i = 1; i < lines.length; i++) {
    bbox[0] = Math.min(bbox[0], lines[i].bbox[0]);
    bbox[1] = Math.min(bbox[1], lines[i].bbox[1]);
    bbox[2] = Math.max(bbox[2], lines[i].bbox[2]);
    bbox[3] = Math.max(bbox[3], lines[i].bbox[3]);
  }
  return {
    blockId: '',
    type: 'paragraph',
    bbox,
    column,
    readingOrder: 0,
    plainText: lines.map((l) => l.plainText).join(' '),
    fontSize: lines[0].fontSize,
    lineCount: lines.length,
    runCount: lines.length,
    _lines: lines,
  };
}

test.describe('mergeLabelValueRows', () => {
  test('同 y 的 label-value pair 合一 line', () => {
    const lines = [
      makeLine('ATTN:', 42, 200, 25),
      makeLine('Person Name', 126, 200, 60),
    ];
    const out = mergeLabelValueRows(lines, 8);
    expect(out).toHaveLength(1);
    expect(out[0].plainText).toBe('ATTN: Person Name');
    // bbox 應 union
    expect(out[0].bbox[0]).toBe(42);
    expect(out[0].bbox[2]).toBe(186);
    // runs 合
    expect(out[0].runs).toHaveLength(2);
  });

  test('左 line 結尾無 : 不 merge', () => {
    const lines = [
      makeLine('Hello', 42, 200, 30),
      makeLine('world', 126, 200, 30),
    ];
    const out = mergeLabelValueRows(lines, 8);
    expect(out).toHaveLength(2);
  });

  test('label 跟 value x gap 太大(跨欄)不 merge', () => {
    // gap = 200pt > FORM_ROW_MAX_X_GAP_FACTOR(12) × medianLH(8) = 96
    const lines = [
      makeLine('TO:', 42, 200, 15),
      makeLine('Quotation#:', 279, 200, 40),
    ];
    const out = mergeLabelValueRows(lines, 8);
    expect(out).toHaveLength(2);
  });

  test('不同 y 不 merge', () => {
    const lines = [
      makeLine('ATTN:', 42, 200, 25),
      makeLine('value', 126, 215, 30),
    ];
    const out = mergeLabelValueRows(lines, 8);
    expect(out).toHaveLength(2);
  });

  test('全形冒號(中文 label)也觸發 merge', () => {
    const lines = [
      makeLine('收件人:', 42, 200, 30),
      makeLine('John', 126, 200, 30),
    ];
    const out = mergeLabelValueRows(lines, 8);
    expect(out).toHaveLength(1);
    expect(out[0].plainText).toBe('收件人: John');
  });

  test('多 row form 各自 merge,row 之間獨立', () => {
    const lines = [
      makeLine('TO:', 42, 191, 14),
      makeLine('ATTN:', 42, 202, 25),
      makeLine('Katrina Ravadilla', 126, 202, 60),
      makeLine('email:', 42, 214, 21),
      makeLine('katrina@example.com', 126, 214, 100),
    ];
    const out = mergeLabelValueRows(lines, 8);
    expect(out).toHaveLength(3); // TO: 單獨 + ATTN: pair + email: pair
    expect(out[0].plainText).toBe('TO:');
    expect(out[1].plainText).toBe('ATTN: Katrina Ravadilla');
    expect(out[2].plainText).toBe('email: katrina@example.com');
  });
});

test.describe('maybeSubsplitFormBlock', () => {
  test('多行 block 多數行 label-shape → 每行 1 block', () => {
    const lines = [
      makeLine('TO:', 42, 191, 14),
      makeLine('ATTN: Person Name', 42, 202, 80),
      makeLine('email: a@b.com', 42, 214, 80),
      makeLine('Phone: 12345', 42, 226, 80),
    ];
    const block = makeBlock(lines);
    const out = maybeSubsplitFormBlock(block);
    expect(out).toHaveLength(4);
    expect(out[0].plainText).toBe('TO:');
    expect(out[1].plainText).toBe('ATTN: Person Name');
  });

  test('block 內無 label-shape line 不切', () => {
    const lines = [
      makeLine('First sentence', 42, 200, 100),
      makeLine('Second sentence', 42, 212, 100),
      makeLine('Third sentence', 42, 224, 100),
    ];
    const block = makeBlock(lines);
    const out = maybeSubsplitFormBlock(block);
    expect(out).toHaveLength(1);
  });

  test('label-shape 比例不到 40% 不切', () => {
    const lines = [
      makeLine('TO:', 42, 191, 14),
      makeLine('Long sentence one with words.', 42, 202, 120),
      makeLine('Long sentence two with words.', 42, 214, 120),
      makeLine('Long sentence three with words.', 42, 226, 120),
      makeLine('Long sentence four with words.', 42, 238, 120),
    ];
    const block = makeBlock(lines);
    const out = maybeSubsplitFormBlock(block);
    // 1/5 = 20% < 40% → 不切
    expect(out).toHaveLength(1);
  });

  test('1 行 block 不切', () => {
    const lines = [makeLine('Single line', 42, 200, 60)];
    const block = makeBlock(lines);
    const out = maybeSubsplitFormBlock(block);
    expect(out).toHaveLength(1);
  });
});

// 構造 1-line block 內含 N runs 的 helper(模擬同 row 多 cell merge)
function makeBlockWithRuns(runs) {
  const sorted = runs.slice().sort((a, b) => a.bbox[0] - b.bbox[0]);
  let bbox = sorted[0].bbox.slice();
  for (let i = 1; i < sorted.length; i++) {
    bbox[0] = Math.min(bbox[0], sorted[i].bbox[0]);
    bbox[1] = Math.min(bbox[1], sorted[i].bbox[1]);
    bbox[2] = Math.max(bbox[2], sorted[i].bbox[2]);
    bbox[3] = Math.max(bbox[3], sorted[i].bbox[3]);
  }
  const line = {
    bbox,
    plainText: sorted.map((r) => r.text).join(''),
    fontSize: sorted[0].fontSize,
    dominantFontName: 'Helvetica',
    runs: sorted,
  };
  return {
    blockId: '',
    type: 'paragraph',
    bbox,
    column: 0,
    readingOrder: 0,
    plainText: line.plainText,
    fontSize: line.fontSize,
    lineCount: 1,
    runCount: sorted.length,
    _lines: [line],
  };
}

function r(text, x0, x1, y0 = 307, y1 = 318) {
  return {
    text,
    bbox: [x0, y0, x1, y1],
    fontName: 'Helvetica',
    fontSize: 10,
    isBold: false,
    isItalic: false,
    linkUrl: null,
  };
}

test.describe('maybeSubsplitTableRowCells', () => {
  test('3 runs 大 gap → 切 3 個 cell block', () => {
    // QTY (325-347) | gap 11pt | Unit Cost (358-426) | gap 20pt | Total (446-496)
    // medianLH=8.4,gap threshold = 8.4*1.5 = 12.6
    // gap 11 < 12.6 → 不切;gap 20 > 12.6 → 切
    // 為了確切切 3 cell,我用更大 gap
    const runs = [
      r('QTY', 325, 347),
      r('Unit Cost', 380, 426), // gap = 380-347 = 33 > 12.6
      r('Total', 460, 496),     // gap = 460-426 = 34 > 12.6
    ];
    const block = makeBlockWithRuns(runs);
    const out = maybeSubsplitTableRowCells(block, 8.4);
    expect(out).toHaveLength(3);
    expect(out[0].plainText).toBe('QTY');
    expect(out[1].plainText).toBe('Unit Cost');
    expect(out[2].plainText).toBe('Total');
    // bbox 應 cell-sized 不是 row-sized
    expect(out[0].bbox[0]).toBe(325);
    expect(out[0].bbox[2]).toBe(347);
    expect(out[2].bbox[0]).toBe(460);
  });

  test('2 runs 大 gap 不切(避開 form merged label-value)', () => {
    // 「ATTN: Person Name」是 form merged 後的 2 runs,gap 大也不該切
    const runs = [
      r('ATTN:', 42, 67),
      r('Person Name', 126, 186), // gap = 59
    ];
    const block = makeBlockWithRuns(runs);
    const out = maybeSubsplitTableRowCells(block, 8.4);
    expect(out).toHaveLength(1);
    expect(out[0].plainText).toBe('ATTN:Person Name');
  });

  test('3 runs 但 gap 都小 → 不切', () => {
    // 普通 inline runs(bold / italic 切換)gap 通常 < 1pt
    const runs = [
      r('Hello ', 100, 130),
      r('World', 130, 165),  // gap = 0
      r('!', 165, 170),       // gap = 0
    ];
    const block = makeBlockWithRuns(runs);
    const out = maybeSubsplitTableRowCells(block, 8.4);
    expect(out).toHaveLength(1);
  });

  test('multi-line block 不適用此 split(只動 lineCount=1)', () => {
    const runs = [
      r('A', 100, 110),
      r('B', 200, 210),
      r('C', 300, 310),
    ];
    const block = makeBlockWithRuns(runs);
    block.lineCount = 2; // 假裝多行
    const out = maybeSubsplitTableRowCells(block, 8.4);
    expect(out).toHaveLength(1);
  });

  test('4 runs row 切 4 個 cell', () => {
    const runs = [
      r('A', 50, 70),
      r('B', 150, 170), // gap 80
      r('C', 250, 270), // gap 80
      r('D', 350, 370), // gap 80
    ];
    const block = makeBlockWithRuns(runs);
    const out = maybeSubsplitTableRowCells(block, 8.4);
    expect(out).toHaveLength(4);
  });
});

