// W7 unit:translate-doc/pdf-renderer.js wrapSegmentsToWidth
//
// 驗證 segment-aware wrap:同行內合併連續同 style chunks 成 piece、
// 跨行 wrap 時 piece 邊界正確、bold/regular 用對應字型算寬。
//
// SANITY 已驗:把 mergeChunksToPieces 內 style 比對拿掉(永遠合一),test
// 「混合 style 同行有多個 piece」fail(會被合成單一 piece)。還原後 pass。

import { test, expect } from '@playwright/test';
import { wrapSegmentsToWidth } from '../../shinkansen/translate-doc/pdf-renderer.js';

// mock font:每字寬 = fontSize × multiplier。bold 字型寬一點(× 1.1)以驗
// wrap 時是否正確套對應字型
function makeFont(multiplier) {
  return {
    widthOfTextAtSize(text, size) {
      return text.length * size * multiplier;
    },
  };
}

test.describe('W7 wrapSegmentsToWidth', () => {
  test('純 plain segment 在足夠寬度下單行', () => {
    const fontReg = makeFont(0.5);
    const fontBold = makeFont(0.55);
    const segments = [{ text: 'Hello', isBold: false, isItalic: false, linkUrl: null }];
    const lines = wrapSegmentsToWidth(segments, fontReg, fontBold, 12, 1000);
    expect(lines).toHaveLength(1);
    expect(lines[0].pieces).toEqual([
      { text: 'Hello', isBold: false, isItalic: false, linkUrl: null },
    ]);
  });

  test('混合 style 同行有多個 piece', () => {
    const fontReg = makeFont(0.5);
    const fontBold = makeFont(0.5);
    const segments = [
      { text: 'A:', isBold: true, isItalic: false, linkUrl: null },
      { text: ' B', isBold: false, isItalic: true, linkUrl: null },
    ];
    const lines = wrapSegmentsToWidth(segments, fontReg, fontBold, 12, 1000);
    expect(lines).toHaveLength(1);
    // ASCII 詞「A:」一個 chunk + 空白「 」一個 chunk + 「B」一個 chunk
    // mergeChunksToPieces 會把連續同 style 合;style 不同處切新 piece
    // expectations:[{ A: bold }, { ' B': italic }] 或更細,只驗 piece 數 >= 2
    expect(lines[0].pieces.length).toBeGreaterThanOrEqual(2);
    // 第一個 piece 帶 bold
    expect(lines[0].pieces[0].isBold).toBe(true);
    expect(lines[0].pieces[0].isItalic).toBe(false);
  });

  test('CJK 逐字斷行', () => {
    const fontReg = makeFont(1); // 每字寬 = fontSize
    const fontBold = makeFont(1);
    const segments = [{ text: '一二三四五', isBold: false, isItalic: false, linkUrl: null }];
    // fontSize=10, maxWidth=25 → 一行只能 2 字(2*10=20,加第3字 30 > 25 斷)
    const lines = wrapSegmentsToWidth(segments, fontReg, fontBold, 10, 25);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // 全部字符總和 5 個
    const totalText = lines.map((l) => l.pieces.map((p) => p.text).join('')).join('');
    expect(totalText).toBe('一二三四五');
  });

  test('link piece 帶 linkUrl', () => {
    const fontReg = makeFont(0.5);
    const fontBold = makeFont(0.5);
    const segments = [
      { text: 'Visit ', isBold: false, isItalic: false, linkUrl: null },
      { text: 'site', isBold: false, isItalic: false, linkUrl: 'https://example.com' },
    ];
    const lines = wrapSegmentsToWidth(segments, fontReg, fontBold, 12, 1000);
    expect(lines).toHaveLength(1);
    const linkPiece = lines[0].pieces.find((p) => p.linkUrl);
    expect(linkPiece).toBeDefined();
    expect(linkPiece.linkUrl).toBe('https://example.com');
    expect(linkPiece.text).toBe('site');
  });

  test('CJK 行首禁標點挪到上一行末', () => {
    const fontReg = makeFont(1);
    const fontBold = makeFont(1);
    // 「中文,中文」想斷在「中,」與「文中文」邊界,但「,」是禁行首,要挪回
    const segments = [{ text: '中文,中文', isBold: false, isItalic: false, linkUrl: null }];
    // fontSize=10, maxWidth=25 → 一行 2 字。原始:line0=「中文」、line1=「,中」、line2=「文」
    // 標點規則後:「,」挪到 line0 → line0=「中文,」、line1=「中」、line2=「文」
    const lines = wrapSegmentsToWidth(segments, fontReg, fontBold, 10, 25);
    const firstLineText = lines[0].pieces.map((p) => p.text).join('');
    expect(firstLineText.endsWith(',')).toBe(true);
  });

  // §27 批次 4-5:單一 chunk 自己就寬過 maxWidth(長 URL / 料號等 ASCII 連續串)
  // 必須退化逐字元斷行;舊行為整條塞同一行,畫超出 box.x1 水平溢出。
  // SANITY(已驗證):暫時拿掉 wrapSegmentsToWidth 的 sizedChunks 逐字元退化
  // (直接用 chunks)→ 「每行寬不得超過 maxWidth」斷言 fail(單行寬 500);還原 → pass
  test('超寬單一 ASCII chunk 退化逐字元斷行,不水平溢出', () => {
    const fontReg = makeFont(0.5);
    const fontBold = makeFont(0.5);
    // 100 字元無空白 ASCII 串,fontSize 10 → 整條寬 500,maxWidth 100
    const segments = [{ text: 'A'.repeat(100), isBold: false, isItalic: false, linkUrl: null }];
    const lines = wrapSegmentsToWidth(segments, fontReg, fontBold, 10, 100);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const l of lines) {
      const w = l.pieces.reduce((s, p) => s + p.text.length * 10 * 0.5, 0);
      expect(w).toBeLessThanOrEqual(100);
    }
    const total = lines.map((l) => l.pieces.map((p) => p.text).join('')).join('');
    expect(total).toBe('A'.repeat(100));
  });

  test('空 segments 回空陣列', () => {
    const fontReg = makeFont(0.5);
    const fontBold = makeFont(0.5);
    expect(wrapSegmentsToWidth([], fontReg, fontBold, 12, 100)).toEqual([]);
    expect(wrapSegmentsToWidth(null, fontReg, fontBold, 12, 100)).toEqual([]);
  });
});
