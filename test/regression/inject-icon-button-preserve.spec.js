// Regression: inject-icon-button-preserve(2026-07-09,dev tail 2.0.9.1 修)
//
// Fixture: 共用 test/regression/fixtures/detect-footnote-button-paragraph.html
//   (prose P 內嵌 icon-only 註腳鈕：div 容器 > 零文字 button > svg)。
// Bug(兩層):
//   1. 零文字 BUTTON(bigfoot 註腳鈕 / icon 按鈕)過不了 hasSubstantiveContent,
//      掉進序列化 HARD_EXCLUDE 被整顆丟掉 → slots 沒有它 → clean-slate 重建後按鈕
//      消失(leancrew P0 實測：A3 對齊失敗走 deserialize 重建就掉鈕)。
//   2. 就算有 slot,LLM 重組句子偶爾把整組佔位符吃掉(句中註腳最常見),
//      parseSegment 只放「譯文裡出現的」佔位符，沒出現的 slot 無回收 → 載體遺失。
// 修法：
//   1. serializer(LLM + GT 兩路徑)：零文字 BUTTON 改 atomic + reuseNode slot(⟦*N⟧),
//      deserialize 非 cloneReuse 用途放回活的原 node。
//   2. deserializeWithPlaceholders:ok=true 時回收未使用的載體型 slot(atomic /
//      reuseNode)，補到 frag 尾端；純格式 shell 不回收。
//
// 本 spec 鎖的訊號層：isolated world 直接驅動 serialize / deserialize，驗 slot 形狀、
//   活節點 identity、遺失回收與 cloneReuse 隔離。不驗 LLM 真的掉不掉 token(不可控),
//   真站端到端由 probe-leancrew-footnote.js 驗過(2026-07-09)。
//
// SANITY 紀錄(已驗證，2026-07-09):
//   ① 把 serializer LLM 路徑「零文字 BUTTON → atomic+reuseNode」分支註解掉(還原成
//      HARD_EXCLUDE 丟棄)→ case 1(slot 形狀)與 case 2/3/4 全 fail。還原 → pass。
//   ② 只把 deserializeWithPlaceholders 的遺失回收 loop 改 `if (false)` → case 3
//      (掉 token 回收)fail,case 2(token 在)仍 pass。還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-footnote-button-paragraph';

test('inject-icon-button-preserve: 零文字 BUTTON atomic slot + 遺失回收 + cloneReuse 隔離', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prose-p', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`
    (() => {
      const p = document.getElementById('prose-p');
      const liveBtn = p.querySelector('button.fn-btn');
      liveBtn.__probeMark = 'LIVE';
      const { text, slots } = window.__SK.serializeWithPlaceholders(p);

      // case 1:slot 形狀 — 零文字 BUTTON 必須是 atomic + reuseNode 活節點 slot
      const btnSlotIdx = slots.findIndex(s => s && s.atomic && s.reuseNode && s.node === liveBtn);
      const tokenInText = btnSlotIdx >= 0 && text.includes('⟦*' + btnSlotIdx + '⟧');

      // case 2：譯文保留 token → 按鈕以「活節點」放回 frag(identity 相同)
      const trKeep = '這是一段測試譯文，' + (btnSlotIdx >= 0 ? '⟦*' + btnSlotIdx + '⟧' : '') + ' 後半句繼續。';
      const r2 = window.__SK.deserializeWithPlaceholders(trKeep, slots);
      const d2 = document.createElement('div'); d2.appendChild(r2.frag);
      const keptBtn = d2.querySelector('button.fn-btn');
      const keptIsLive = !!keptBtn && keptBtn.__probeMark === 'LIVE';

      // 放回原位讓 case 3 重測(deserialize 已把活節點 detach 進 d2)
      p.querySelector('.fn-container')?.appendChild(keptBtn || liveBtn);

      // case 3：譯文完全沒有 placeholder → ok=false，不回收(caller 走 fallback 不用
      // frag,detach 活節點只會讓按鈕跟著被丟棄的 frag 消失)
      const trDrop = '這是掉了全部佔位符的譯文。';
      const r3 = window.__SK.deserializeWithPlaceholders(trDrop, slots);
      const okFalseNoDetach = r3.ok === false && !!p.querySelector('button.fn-btn');

      // case 3b:ok=true 且掉 button token → 回收。造一個含文字的 SPAN 進 slots?
      // 不造假 slot——改真實路徑：在 p 尾端加一個 <code> 讓 serialize 產生第二個 atomic
      // slot，譯文只帶 code 的 token、掉 button 的 token。
      const codeEl = document.createElement('code'); codeEl.textContent = 'x'; p.appendChild(codeEl);
      const s3 = window.__SK.serializeWithPlaceholders(p);
      const bIdx = s3.slots.findIndex(s => s && s.atomic && s.reuseNode && s.node && s.node.tagName === 'BUTTON');
      const cIdx = s3.slots.findIndex(s => s && s.atomic && !s.reuseNode);
      const r3b = window.__SK.deserializeWithPlaceholders('掉了註腳但保留了 ⟦*' + cIdx + '⟧ 的譯文。', s3.slots);
      const d3 = document.createElement('div'); d3.appendChild(r3b.frag);
      const recoveredBtn = d3.querySelector('button.fn-btn');
      const recoveredIsLive = !!recoveredBtn && recoveredBtn.__probeMark === 'LIVE';

      // 放回原位供 case 4
      p.querySelector('.fn-container')?.appendChild(recoveredBtn || p.querySelector('button.fn-btn'));

      // case 4:cloneReuse 用途(比對 / 探測)掉 token → 回收放的是 clone，活節點不被 detach
      const r4 = window.__SK.deserializeWithPlaceholders('掉了註腳但保留了 ⟦*' + cIdx + '⟧ 的譯文。', s3.slots, { cloneReuse: true });
      const d4 = document.createElement('div'); d4.appendChild(r4.frag);
      const cloneBtn = d4.querySelector('button.fn-btn');
      const cloneIsClone = !!cloneBtn && cloneBtn.__probeMark !== 'LIVE';
      const liveStillInP = !!p.querySelector('button.fn-btn') && p.querySelector('button.fn-btn').__probeMark === 'LIVE';

      return {
        btnSlotIdx, tokenInText,
        case2ok: r2.ok, keptIsLive,
        okFalseNoDetach,
        r3bOk: r3b.ok, recoveredIsLive,
        cloneIsClone, liveStillInP,
        serializedHead: text.slice(0, 160),
      };
    })()
  `);

  const ctx = `serialized: ${result.serializedHead}`;
  // case 1:slot 形狀
  expect(result.btnSlotIdx, `零文字 BUTTON 必須有 atomic+reuseNode slot\n${ctx}`).toBeGreaterThanOrEqual(0);
  expect(result.tokenInText, `序列化字串必須含 ⟦*N⟧ token\n${ctx}`).toBe(true);
  // case 2:token 在 → 活節點放回
  expect(result.case2ok, 'case2 deserialize 應 ok').toBe(true);
  expect(result.keptIsLive, 'token 保留時放回的必須是活的原 node(identity 相同)').toBe(true);
  // ok=false 不回收(活節點不被 detach 進被丟棄的 frag)
  expect(result.okFalseNoDetach, 'ok=false 時不得把活按鈕 detach 進 throwaway frag').toBe(true);
  // case 3b：掉 button token(ok=true)→ 回收補回活按鈕
  expect(result.r3bOk, 'case3b deserialize 應 ok(code token 有 match)').toBe(true);
  expect(result.recoveredIsLive, 'LLM 掉 token 時遺失回收必須補回活按鈕').toBe(true);
  // case 4:cloneReuse 隔離
  expect(result.cloneIsClone, 'cloneReuse 用途回收放的必須是 clone').toBe(true);
  expect(result.liveStillInP, 'cloneReuse 用途不得動到頁面上的活按鈕').toBe(true);

  await page.close();
});
