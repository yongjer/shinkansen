// Pure regression: serialize → deserialize round-trip 健康檢查 (Category C)
//
// 對 5 個 representative snippet 跑 serialize 拿 {text, slots},
// 把 text 原樣當「譯文」餵 deserialize,把產生的 fragment 跟原 element
// 做結構比對。若任何序列化 / 反序列化路徑變動破壞對稱,這條會掛。
//
// 比對對象:tag 樹 (tagName 巡迴序列)、textContent、A 的 href。
// 不比對 inline style 或 class (那些屬於 element 殼,測試用 cloneNode 已自動帶)。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'roundtrip-snippets';

const SNIPPETS = [
  { id: 's1', desc: 'plain text' },
  { id: 's2', desc: 'flat inline B/A/EM' },
  { id: 's3', desc: 'nested B>SMALL>A' },
  { id: 's4', desc: 'atomic sup.reference' },
  { id: 's5', desc: 'BR via \\n sentinel' },
];

test('serialize-deserialize roundtrip: 5 snippets', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  for (const { id, desc } of SNIPPETS) {
    // 在 isolated world 裡跑 serialize → deserialize → 比對
    const out = await evaluate(`
      JSON.stringify((() => {
        const el = document.querySelector('#${id}');
        const original = {
          tagSeq: [],
          text: el.textContent,
          anchors: [],
        };
        const walkOriginal = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
        let n = walkOriginal.nextNode();
        while (n) {
          original.tagSeq.push(n.tagName);
          if (n.tagName === 'A') original.anchors.push(n.getAttribute('href'));
          n = walkOriginal.nextNode();
        }

        const { text, slots } = window.__shinkansen.serialize(el);
        const { frag, ok } = window.__shinkansen.deserialize(text, slots);

        const rebuilt = {
          tagSeq: [],
          text: '',
          anchors: [],
          ok,
        };
        // frag 是 DocumentFragment,textContent 沒問題
        rebuilt.text = frag.textContent;
        const walkRebuilt = document.createTreeWalker(frag, NodeFilter.SHOW_ELEMENT);
        let m = walkRebuilt.nextNode();
        while (m) {
          rebuilt.tagSeq.push(m.tagName);
          if (m.tagName === 'A') rebuilt.anchors.push(m.getAttribute('href'));
          m = walkRebuilt.nextNode();
        }
        return { original, rebuilt, sourceText: text, slotCount: slots.length };
      })())
    `);
    const { original, rebuilt, slotCount } = JSON.parse(out);

    // tagSeq 比對 (深度優先 element 序列必須完全一致)
    expect(
      rebuilt.tagSeq,
      `[${id} ${desc}] tag sequence 應一致\n  original: ${JSON.stringify(original.tagSeq)}\n  rebuilt:  ${JSON.stringify(rebuilt.tagSeq)}`,
    ).toEqual(original.tagSeq);

    // textContent 比對 (允許 BR snippet 的 \n 差異:原 DOM 的 BR 沒換行,
    // round-trip 後的 BR 之間是 textNode 不含換行,因此 textContent 相同)
    expect(
      rebuilt.text,
      `[${id} ${desc}] textContent 應一致`,
    ).toBe(original.text);

    // anchors 比對 (href 必須原樣保留)
    expect(
      rebuilt.anchors,
      `[${id} ${desc}] anchor href 序列應一致`,
    ).toEqual(original.anchors);

    // slotCount sanity:plain text snippet 應為 0,其他 > 0
    if (id === 's1') {
      expect(slotCount, `[${id}] plain text 應無 slot`).toBe(0);
    } else if (id === 's5') {
      expect(slotCount, `[${id}] BR snippet 不該產 slot (BR 走 sentinel)`).toBe(0);
    } else {
      expect(slotCount, `[${id}] 應有 slot`).toBeGreaterThan(0);
    }
  }

  await page.close();
});
