// translate-doc/layout-analyzer.js maybeSplitNarrowMultilineBlock
//
// 驗證:多行 block 但所有 line 的 max right edge 距 column right edge 太遠
// (ratio < 0.25) → 切成每行一個 block。真 wrap 段落(ratio ≥ 0.25)維持原樣。
//
// 觸發場景:聯絡資訊區「姓名 / 職稱 / 電話 / email」在 PDF 是同 leading 的 6 行,
// gap 規則切不開,被當成單一 paragraph 送翻譯結果連起來變一句。
//
// SANITY 紀錄(已驗證):暫時把 ratio 判斷反向(ratio < THRESHOLD 改成回傳原 block),
// 「ratio 0.17 應切 6 個」spec fail。還原後 pass。
//
// SANITY 紀錄(已驗證 2):暫時把 NARROW_BLOCK_MAX_RIGHT_RATIO 改成 0.05(嚴到不會切),
// 「ratio 0.17 應切 6 個」spec fail。還原 0.25 後 pass。

import { test, expect } from '@playwright/test';
import { maybeSplitNarrowMultilineBlock } from '../../shinkansen/translate-doc/layout-analyzer.js';

// helper:用同 fontSize / fontName 構造 line(模擬 buildBlockFromLines 拿到的 _lines 結構)
function makeLine(text, leftX, topY, width, height = 11) {
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

// helper:模擬 buildBlockFromLines 產出的 block 結構(只填 maybeSplitNarrowMultilineBlock 需要的欄位)
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

test.describe('maybeSplitNarrowMultilineBlock', () => {
  // 模擬 column 寬度 502pt(對照真實 letter PDF body width)
  const COL_LEFTS = [54];
  const COL_RIGHTS = [556];

  test('ratio 0.17(聯絡資訊區)→ 切成 6 個獨立 block', () => {
    // 模擬 Plano-style 聯絡資訊:6 行短行,max right ≈ 142(ratio 17%)
    const lines = [
      makeLine('Person Name',     54, 665, 60),
      makeLine('Director',        54, 678, 35),
      makeLine('Media Relations', 54, 691, 71),
      makeLine('Ph. (555) 123-4567', 54, 704, 86),
      makeLine('Mo. (555) 987-6543', 54, 717, 88),
      makeLine('press@example.org', 54, 730, 87),
    ];
    const block = makeBlock(lines);
    const out = maybeSplitNarrowMultilineBlock(block, COL_LEFTS, COL_RIGHTS);
    expect(out).toHaveLength(6);
    expect(out[0].plainText).toBe('Person Name');
    expect(out[1].plainText).toBe('Director');
    expect(out[5].plainText).toBe('press@example.org');
    // 每個 sub-block 各自一個 line
    for (const b of out) expect(b.lineCount).toBe(1);
  });

  test('ratio 0.97(真 wrap 段落)→ 維持單一 block', () => {
    // 模擬 5 行 wrap 段落,每行接近 col right(485-543pt → ratio 86-97%)
    const lines = [
      makeLine('First line of a wrapped paragraph that fills nearly the full column width.', 54, 220, 486),
      makeLine('Second line of the same paragraph that also reaches near the column right edge.', 54, 233, 489),
      makeLine('Third line continues the paragraph with similar near-full line width again.', 54, 246, 462),
      makeLine('Fourth line still reaches near the right edge of the column body.', 54, 259, 458),
      makeLine('Last line is shorter.', 54, 272, 347),
    ];
    const block = makeBlock(lines);
    const out = maybeSplitNarrowMultilineBlock(block, COL_LEFTS, COL_RIGHTS);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(block); // 原 block reference
  });

  test('ratio 0.30(邊界 case)→ 維持單一 block(threshold 0.25 之上)', () => {
    // ratio 30% 是真實 PDF 觀察到的「short heading 跨 2 行」場景,不該切
    const lines = [
      makeLine('FOR APPROVAL', 54, 100, 150),  // (150)/(556-54) = 30%
      makeLine('Section Title', 54, 113, 130),
    ];
    const block = makeBlock(lines);
    const out = maybeSplitNarrowMultilineBlock(block, COL_LEFTS, COL_RIGHTS);
    expect(out).toHaveLength(1);
  });

  test('lineCount=1 → 不動', () => {
    const lines = [makeLine('Single', 54, 100, 30)];
    const block = makeBlock(lines);
    const out = maybeSplitNarrowMultilineBlock(block, COL_LEFTS, COL_RIGHTS);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(block);
  });

  test('退化 case:column width <= 0 → 不動(避免除零)', () => {
    const lines = [
      makeLine('A', 54, 100, 30),
      makeLine('B', 54, 113, 30),
    ];
    const block = makeBlock(lines);
    // 故意傳壞的 col 邊界
    const out = maybeSplitNarrowMultilineBlock(block, [100], [50]);
    expect(out).toHaveLength(1);
  });

  test('多欄 PDF:用 block.column 取對應欄的 left/right', () => {
    // 模擬雙欄,block 在第 2 欄(column index 1)
    const COL_LEFTS_2 = [54, 320];
    const COL_RIGHTS_2 = [300, 556];
    const lines = [
      makeLine('Name', 320, 100, 35),  // ratio (320+35-320)/(556-320)= 35/236 = 15%
      makeLine('Title', 320, 113, 30),
      makeLine('Email', 320, 126, 35),
    ];
    const block = makeBlock(lines, 1);
    const out = maybeSplitNarrowMultilineBlock(block, COL_LEFTS_2, COL_RIGHTS_2);
    expect(out).toHaveLength(3);
    expect(out.every((b) => b.column === 1)).toBe(true);
  });

  test('切出來的 block 各自帶正確 bbox', () => {
    const lines = [
      makeLine('Name',  54, 100, 60),
      makeLine('Title', 54, 113, 35),
    ];
    const block = makeBlock(lines);
    const out = maybeSplitNarrowMultilineBlock(block, COL_LEFTS, COL_RIGHTS);
    expect(out).toHaveLength(2);
    expect(out[0].bbox[1]).toBe(100);
    expect(out[0].bbox[3]).toBe(111);
    expect(out[1].bbox[1]).toBe(113);
    expect(out[1].bbox[3]).toBe(124);
  });
});
