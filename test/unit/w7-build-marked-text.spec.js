// W7 unit:translate-doc/translate.js buildMarkedText
//
// 驗證從 block.styleSegments 構出 inline marker 字串送 LLM 的邏輯。
// 巢狀順序由外到內:bold → italic → link;link 編號 1-based。
//
// SANITY 已驗:把 buildMarkedText 內 marker 順序改成 link → bold → italic
// (錯誤巢狀)後,test「巢狀順序 b > i > l」fail。還原後 pass。

import { test, expect } from '@playwright/test';
import { buildMarkedText } from '../../shinkansen/translate-doc/translate.js';

test.describe('W7 buildMarkedText', () => {
  test('純 plain segment 不加 marker', () => {
    const block = {
      plainText: 'Hello world',
      styleSegments: [{ text: 'Hello world', isBold: false, isItalic: false, linkUrl: null }],
      linkUrls: [],
    };
    expect(buildMarkedText(block)).toBe('Hello world');
  });

  test('bold 加 ⟦b⟧', () => {
    const block = {
      plainText: 'Important',
      styleSegments: [{ text: 'Important', isBold: true, isItalic: false, linkUrl: null }],
      linkUrls: [],
    };
    expect(buildMarkedText(block)).toBe('⟦b⟧Important⟦/b⟧');
  });

  test('italic 加 ⟦i⟧', () => {
    const block = {
      plainText: 'note',
      styleSegments: [{ text: 'note', isBold: false, isItalic: true, linkUrl: null }],
      linkUrls: [],
    };
    expect(buildMarkedText(block)).toBe('⟦i⟧note⟦/i⟧');
  });

  test('link 用 1-based index', () => {
    const block = {
      plainText: 'example.com',
      styleSegments: [{ text: 'example.com', isBold: false, isItalic: false, linkUrl: 'https://example.com' }],
      linkUrls: ['https://example.com'],
    };
    expect(buildMarkedText(block)).toBe('⟦l:1⟧example.com⟦/l⟧');
  });

  test('巢狀順序 b > i > l(由外到內)', () => {
    const block = {
      plainText: 'X',
      styleSegments: [{ text: 'X', isBold: true, isItalic: true, linkUrl: 'https://a.com' }],
      linkUrls: ['https://a.com'],
    };
    expect(buildMarkedText(block)).toBe('⟦b⟧⟦i⟧⟦l:1⟧X⟦/l⟧⟦/i⟧⟦/b⟧');
  });

  test('段內 b + i + l 混合(粗體標題 + 斜體文字 + 內含連結)', () => {
    const block = {
      plainText: 'Note: Visit example.com for details about Acme.',
      styleSegments: [
        { text: 'Note:', isBold: true, isItalic: false, linkUrl: null },
        { text: ' Visit ', isBold: false, isItalic: true, linkUrl: null },
        { text: 'example.com', isBold: false, isItalic: true, linkUrl: 'https://example.com' },
        { text: ' for details about Acme.', isBold: false, isItalic: true, linkUrl: null },
      ],
      linkUrls: ['https://example.com'],
    };
    expect(buildMarkedText(block)).toBe(
      '⟦b⟧Note:⟦/b⟧⟦i⟧ Visit ⟦/i⟧⟦i⟧⟦l:1⟧example.com⟦/l⟧⟦/i⟧⟦i⟧ for details about Acme.⟦/i⟧'
    );
  });

  test('多個 link 編號分開', () => {
    const block = {
      plainText: 'A B',
      styleSegments: [
        { text: 'A', isBold: false, isItalic: false, linkUrl: 'https://a.com' },
        { text: ' ', isBold: false, isItalic: false, linkUrl: null },
        { text: 'B', isBold: false, isItalic: false, linkUrl: 'https://b.com' },
      ],
      linkUrls: ['https://a.com', 'https://b.com'],
    };
    expect(buildMarkedText(block)).toBe('⟦l:1⟧A⟦/l⟧ ⟦l:2⟧B⟦/l⟧');
  });

  test('沒 styleSegments → fallback plainText', () => {
    const block = { plainText: 'fallback text' };
    expect(buildMarkedText(block)).toBe('fallback text');
  });

  test('空 styleSegments → fallback plainText', () => {
    const block = { plainText: 'fallback', styleSegments: [], linkUrls: [] };
    expect(buildMarkedText(block)).toBe('fallback');
  });

  test('null block 回空字串', () => {
    expect(buildMarkedText(null)).toBe('');
  });
});
