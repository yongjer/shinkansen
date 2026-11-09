// Unit test: 文章術語表輸入取樣 collectGlossaryInputParts(§27 批次 4-7)
//
// Bug:原 index.js inline 版的截斷分支是 `t.slice(0, MAX - acc)`——acc 累計含
// join('\n') 分隔符預算(+1),可以走到 MAX + 1;此時 MAX - acc 是負值,
// slice(0, -1) 變成「整塊只去尾字元」全收 → 取樣預算吹破。
// 修法:抽到 translate.js collectGlossaryInputParts,改 `room = MAX - acc;
// room <= 0 break; t.slice(0, room)`。
//
// SANITY 紀錄(已驗證):暫時把 helper 內 room 邏輯改回舊版
// `if (acc + t.length > maxChars) { parts.push(t.slice(0, maxChars - acc)); ... }`
// (拿掉 room <= 0 guard)→ 「acc 達 MAX+1 後不得再收」斷言 fail(第三塊以
// slice(0,-1) 形式被收進來);還原 → pass。

import { test, expect } from '@playwright/test';
import { collectGlossaryInputParts } from '../../shinkansen/translate-doc/translate.js';

function docOf(texts, type = 'paragraph') {
  return { pages: [{ blocks: texts.map((t, i) => ({ blockId: `b${i}`, type, plainText: t })) }] };
}

test.describe('collectGlossaryInputParts 取樣預算', () => {
  test('acc 因分隔符預算達 MAX+1 後不得再收(舊版負值 slice 會把整塊收進來)', () => {
    // 'aaaa'(4)→ acc 5;'bbbbb'(5)→ acc + 5 = 10 = MAX 收滿,acc → 11;
    // 'cccc':room = 10 - 11 = -1 → 停。舊版:slice(0, -1) = 'ccc' 被收,預算吹破
    const parts = collectGlossaryInputParts(docOf(['aaaa', 'bbbbb', 'cccc']), 10);
    expect(parts).toEqual(['aaaa', 'bbbbb']);
    expect(parts.join('\n').length).toBeLessThanOrEqual(10);
  });

  test('正常截斷:超出的 block 收 room 長度', () => {
    const parts = collectGlossaryInputParts(docOf(['aaaa', 'bbbbbbbbbb']), 10);
    // 'aaaa' → acc 5;room = 5 → 'bbbbb'
    expect(parts).toEqual(['aaaa', 'bbbbb']);
    expect(parts.join('\n').length).toBeLessThanOrEqual(10);
  });

  test('非 translatable type 與空白 block 跳過', () => {
    const doc = {
      pages: [{
        blocks: [
          { blockId: 'b0', type: 'table', plainText: 'SKIP ME' },
          { blockId: 'b1', type: 'paragraph', plainText: '   ' },
          { blockId: 'b2', type: 'heading', plainText: 'Keep me' },
        ],
      }],
    };
    expect(collectGlossaryInputParts(doc, 100)).toEqual(['Keep me']);
  });

  test('預算用完後跨頁也不再收', () => {
    const doc = {
      pages: [
        { blocks: [{ blockId: 'a', type: 'paragraph', plainText: 'x'.repeat(10) }] },
        { blocks: [{ blockId: 'b', type: 'paragraph', plainText: 'y'.repeat(10) }] },
      ],
    };
    const parts = collectGlossaryInputParts(doc, 10);
    expect(parts).toEqual(['x'.repeat(10)]);
  });
});
