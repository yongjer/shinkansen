// W7 unit:translate-doc/layout-analyzer.js buildStyleSegments
//
// 驗證從 lines 的 runs 合 styleSegments + linkUrls 去重保 order。
// 規則:連續同 (isBold, isItalic, linkUrl) tuple 合一段;跨 line 同 style 也合;
// line 之間以 ASCII space 銜接(不另開 segment)。
//
// SANITY 已驗:把同 style 比對拿掉(永遠新開 segment)後,test「連續同 style
// 合一段」fail。還原後 pass。

import { test, expect } from '@playwright/test';
import { buildStyleSegments } from '../../shinkansen/translate-doc/layout-analyzer.js';

function r(text, opts = {}) {
  return {
    text,
    isBold: !!opts.bold,
    isItalic: !!opts.italic,
    linkUrl: opts.link || null,
  };
}

test.describe('W7 buildStyleSegments', () => {
  test('單一 plain run', () => {
    const lines = [{ runs: [r('Hello')] }];
    const { styleSegments, linkUrls } = buildStyleSegments(lines);
    expect(styleSegments).toEqual([
      { text: 'Hello', isBold: false, isItalic: false, linkUrl: null },
    ]);
    expect(linkUrls).toEqual([]);
  });

  test('連續同 bold 合一段', () => {
    const lines = [{ runs: [r('A', { bold: true }), r('B', { bold: true })] }];
    const { styleSegments } = buildStyleSegments(lines);
    expect(styleSegments).toEqual([
      { text: 'AB', isBold: true, isItalic: false, linkUrl: null },
    ]);
  });

  test('不同 style 切兩段', () => {
    const lines = [{ runs: [r('A', { bold: true }), r('B', { italic: true })] }];
    const { styleSegments } = buildStyleSegments(lines);
    expect(styleSegments).toHaveLength(2);
    expect(styleSegments[0].text).toBe('A');
    expect(styleSegments[0].isBold).toBe(true);
    expect(styleSegments[1].text).toBe('B');
    expect(styleSegments[1].isItalic).toBe(true);
  });

  test('跨 line 同 style 合一段(line 之間補 space)', () => {
    const lines = [
      { runs: [r('Hello', { bold: true })] },
      { runs: [r('World', { bold: true })] },
    ];
    const { styleSegments } = buildStyleSegments(lines);
    expect(styleSegments).toEqual([
      { text: 'Hello World', isBold: true, isItalic: false, linkUrl: null },
    ]);
  });

  test('linkUrls 去重保 order', () => {
    const lines = [{
      runs: [
        r('A', { link: 'https://a.com' }),
        r('B', { link: 'https://b.com' }),
        r('C', { link: 'https://a.com' }), // 重複
      ],
    }];
    const { linkUrls } = buildStyleSegments(lines);
    expect(linkUrls).toEqual(['https://a.com', 'https://b.com']);
  });

  test('段內 b + i + l 混合(粗體標題 + 斜體文字 + 內含連結)', () => {
    const lines = [{
      runs: [
        r('Note:', { bold: true }),
        r(' Visit ', { italic: true }),
        r('example.com', { italic: true, link: 'https://example.com' }),
        r(' for details.', { italic: true }),
      ],
    }];
    const { styleSegments, linkUrls } = buildStyleSegments(lines);
    expect(styleSegments).toHaveLength(4);
    expect(styleSegments[0].text).toBe('Note:');
    expect(styleSegments[0].isBold).toBe(true);
    expect(styleSegments[1].text).toBe(' Visit ');
    expect(styleSegments[1].isItalic).toBe(true);
    expect(styleSegments[2].text).toBe('example.com');
    expect(styleSegments[2].linkUrl).toBe('https://example.com');
    expect(styleSegments[3].text).toBe(' for details.');
    expect(linkUrls).toEqual(['https://example.com']);
  });

  test('純空白 run 過濾(pdf-engine 階段已丟,但保險)', () => {
    const lines = [{
      runs: [
        r('Hello'),
        r(''),
        r('World'),
      ],
    }];
    const { styleSegments } = buildStyleSegments(lines);
    expect(styleSegments[0].text).toBe('HelloWorld');
  });

  test('空 lines 陣列回空', () => {
    const { styleSegments, linkUrls } = buildStyleSegments([]);
    expect(styleSegments).toEqual([]);
    expect(linkUrls).toEqual([]);
  });
});
