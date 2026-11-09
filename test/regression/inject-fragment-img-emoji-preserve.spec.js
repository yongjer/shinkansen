// Regression: fragment 注入保留 inline emoji IMG (v1.10.15)
//
// Bug(真實頁面驗證):含 emoji 的 YouTube 留言(<span>長文字<span><img></span>更多文字</span>)
// 被 Case D 抽成 fragment 後,fragment 一律走 clean-rebuild 注入(injectFragmentTranslation)。
// LLM serializer(serializeNodeIterable)原本對 IMG 透明展開(walk childNodes,IMG 沒
// children → 從 source text 流消失),clean-rebuild 後譯文不含 emoji → emoji 整顆掉。
//
// 為何不能全域把 IMG 改 atomic:element 路徑可能走 Layer A3 nodeValue-mutate 注入
// (content-inject.js gated by kind !== 'fragment'),該路徑保留原 DOM、IMG 自然存活,
// 且 v1.9.31 對齊靠「LLM src/tgt 兩端 IMG 都不算 token」,多出 IMG slot 會破壞對齊
// → fallback dual(見 inject-a3-llm-img-emoji.spec.js)。
//
// 修法:serializeNodeIterable 加 opts.imgAsSlot,只在 fragment 路徑
// (serializeFragmentWithPlaceholders)開 → IMG 走 atomic ⟦*N⟧ slot,deserialize 還原
// IMG 在原位置。element 路徑維持 IMG 透明。
//
// 這條驗:fragment 序列化把 IMG 收成 atomic slot(⟦*N⟧)+ round-trip 注入後 img 仍在 DOM
//        + 譯文中文出現。
// 不驗:Case D 是否抓到該 fragment(由 detect-inline-single-emoji-wrapper.spec.js 蓋);
//      element 路徑 IMG 透明(由 inject-a3-llm-img-emoji.spec.js 蓋)。
//
// SANITY 紀錄(已驗證):把 serializeFragmentWithPlaceholders 的 imgAsSlot 改回 false
// (或拿掉 serializeNodeIterable 的 imgAsSlot IMG 分支)→ atomicImgSlot=false / imgAfter=0
// → fail;還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inline-mixed-span';

test('fragment 含 inline emoji IMG:序列化成 atomic slot + 注入後 img 保留 + 譯文出現', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-emoji-mid', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const root = document.querySelector('#target-emoji-mid');
      const imgBefore = root.querySelectorAll('img').length;

      // 取 Case D 抽出的 fragment unit
      const units = SK.collectParagraphs(root);
      const frag = units.find(u => u.kind === 'fragment');
      if (!frag) return { error: 'no fragment unit', units: units.map(u=>u.kind) };

      // 序列化(fragment 路徑 → imgAsSlot:true)
      const { text, slots } = SK.serializeFragmentWithPlaceholders(frag);
      const atomicImgSlot = slots.some(s => s && s.atomic && s.node && s.node.tagName === 'IMG');
      const hasAtomicMarker = /⟦\\*\\d+⟧/.test(text);

      // 假翻譯:把英文 prose 換中文,保留 atomic marker ⟦*N⟧
      const fake = text
        .replace(/My last deployment[^⟦]*/, '上次部署我用了自己的 EOTech 搭配同袍的倍率鏡,全程穩穩固定')
        .replace(/gave me good use[^]*$/, '整趟任務都好用得不得了,一次失誤都沒有');

      SK.injectTranslation(frag, fake, slots);

      const imgAfter = root.querySelectorAll('img').length;
      const txt = root.textContent;
      // emoji 前後是否有空白(v1.10.15:避免 emoji 跟 CJK 貼死)
      const img = root.querySelector('img');
      let spaceBefore = false, spaceAfter = false;
      if (img) {
        const prev = img.previousSibling;
        const next = img.nextSibling;
        const prevTail = prev && prev.nodeType === 3 ? (prev.nodeValue || '') : (prev ? prev.textContent || '' : '');
        const nextHead = next && next.nodeType === 3 ? (next.nodeValue || '') : (next ? next.textContent || '' : '');
        spaceBefore = /\\s$/.test(prevTail);
        spaceAfter = /^\\s/.test(nextHead);
      }
      return {
        imgBefore, imgAfter, atomicImgSlot, hasAtomicMarker,
        hasCJK: /[一-鿿]/.test(txt),
        spaceBefore, spaceAfter,
        slotKinds: slots.map(s => s.atomic ? (s.node && s.node.tagName) : 'paired'),
      };
    })()
  `);

  expect(result.error, `unexpected: ${JSON.stringify(result)}`).toBeUndefined();
  expect(result.atomicImgSlot, `fragment 序列化應把 IMG 收成 atomic slot,slotKinds=${JSON.stringify(result.slotKinds)}`).toBe(true);
  expect(result.hasAtomicMarker, 'source text 應含 atomic ⟦*N⟧ marker').toBe(true);
  expect(result.imgBefore, '注入前有 1 個 emoji img').toBe(1);
  expect(result.imgAfter, '注入後 emoji img 必須保留(不可被 clean-rebuild 丟掉)').toBe(1);
  expect(result.hasCJK, '注入後譯文中文出現').toBe(true);
  expect(result.spaceBefore, 'emoji 前面應有空白(不跟 CJK 貼死)').toBe(true);
  expect(result.spaceAfter, 'emoji 後面應有空白(不跟 CJK 貼死)').toBe(true);

  await page.close();
});
