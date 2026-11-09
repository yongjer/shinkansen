// Regression: inject-echo-rescan-loop（對應 v1.10.50 修的「echo 段被 rescan 重複送 API」bug）
//
// Fixture: test/regression/fixtures/inject-echo-rescan-loop.html
// 結構：<li><a>專有名詞</a></li> 短導覽段(模型對品牌名/專有名詞常原樣 echo)
// Bug：模型 echo(譯文 === 原文)時 _revertEcho 還原 DOM 後不標
//   data-shinkansen-translated → rescanTick(1.2s/3s 兩輪,無 seenTexts 過濾)與
//   spaObserverRescan(30s TTL 過期後)每輪把同段重新收進 collectParagraphs 候選、
//   重送 API,模型再 echo、再不標——循環燒 token(DF probe 實測同兩段 20s 內 3 連打)。
// 修法：_revertEcho 改標 data-shinkansen-translated(echo 語意 = 已翻譯且譯文恰等於
//   原文)+ 記 by-text reuse。restorePage 照常清標記,使用者清快取重翻(必經 restore
//   toggle)仍會重送。
//
// 訊號層界定:本 spec 驗「echo 注入後段落退出 collectParagraphs 候選 + restore 後
//   重新成為候選」這層(rescanTick / spaObserverRescan 的候選都來自 collectParagraphs,
//   擋住候選即擋住重送);不驗「真實 model 是否 echo」(模型行為,canned 注入模擬)
//   與「rescan timer 真實 fire 節奏」。
//
// SANITY 紀錄（已驗證）：暫時註解掉 content-inject.js _revertEcho 內的
//   el.setAttribute('data-shinkansen-translated', '1') + _recordTranslatedByText →
//   3 條全 fail(case 1「echo 後應標 translated」marked=false、case 2 by-text 未記、
//   case 3 markedAfterEcho=false)→ 還原後 3 條全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const ECHO_TEXT = 'The Weekly Review Show';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/inject-echo-rescan-loop.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#echo-li', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

// 「候選是否涵蓋 echo 段文字」:rescanTick / spaObserverRescan 的重送對象都來自
// collectParagraphs,任何 kind 的 unit 只要文字涵蓋 echo 段就代表會被重送
const COVERS_FN = `
  function coversEchoText(units, needle) {
    return units.some((u) => {
      if (u.kind === 'fragment') {
        let t = '';
        let n = u.startNode;
        while (n) {
          t += n.textContent || '';
          if (n === u.endNode) break;
          n = n.nextSibling;
        }
        return t.includes(needle);
      }
      return ((u.el && u.el.textContent) || '').includes(needle);
    });
  }
`;

test('echo 注入後標 translated,collectParagraphs 不再重收(rescan 不重送 API)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  const r = await evaluate(`
    (() => {
      ${COVERS_FN}
      const el = document.querySelector('#echo-li');
      const before = window.__SK.collectParagraphs(document.body, {});
      const inCandidatesBefore = coversEchoText(before, ${JSON.stringify(ECHO_TEXT)});

      // 模擬模型 echo:譯文 = 序列化原文,逐字相同
      const { text, slots } = window.__SK.serializeWithPlaceholders(el);
      window.__SK.injectTranslation({ kind: 'element', el }, text, slots);

      const after = window.__SK.collectParagraphs(document.body, {});
      return {
        inCandidatesBefore,
        marked: el.hasAttribute('data-shinkansen-translated'),
        textAfter: (el.textContent || '').trim(),
        anchorIntact: !!el.querySelector('a[href]'),
        inCandidatesAfter: coversEchoText(after, ${JSON.stringify(ECHO_TEXT)}),
      };
    })()
  `);

  // 前置:echo 段注入前本來就是候選(fixture 有效性)
  expect(r.inCandidatesBefore, 'echo 段注入前應是 collectParagraphs 候選').toBe(true);
  // 修法核心:echo 後標 translated → 候選過濾生效,rescan 不再重收
  expect(r.marked, 'echo 後應標 data-shinkansen-translated').toBe(true);
  expect(r.inCandidatesAfter, 'echo 注入後不應再是 collectParagraphs 候選').toBe(false);
  // revert 語意保留:DOM 還原為原文、結構不動
  expect(r.textAfter, 'echo 段文字應維持原文').toBe(ECHO_TEXT);
  expect(r.anchorIntact, '<a> 結構應保留').toBe(true);

  await page.close();
});

test('echo 段記進 by-text reuse(SPA remount 同文字新元素不再進 API 候選)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  const r = await evaluate(`
    (() => {
      const el = document.querySelector('#echo-li');
      const { text, slots } = window.__SK.serializeWithPlaceholders(el);
      window.__SK.injectTranslation({ kind: 'element', el }, text, slots);
      const byText = window.__SK.STATE.translatedHTMLByText;
      return {
        recorded: !!(byText && byText.has(${JSON.stringify(ECHO_TEXT)})),
        value: byText ? byText.get(${JSON.stringify(ECHO_TEXT)}) || null : null,
      };
    })()
  `);

  expect(r.recorded, 'echo 段應記進 translatedHTMLByText').toBe(true);
  // reuse value = 還原後的原文 innerHTML(remount 注入後視覺無變化)
  expect(r.value, 'by-text value 應含原文').toContain(ECHO_TEXT);

  await page.close();
});

test('restorePage 清掉 echo 標記,清快取重翻場景仍可重收', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  const r = await evaluate(`
    (() => {
      ${COVERS_FN}
      const el = document.querySelector('#echo-li');
      const { text, slots } = window.__SK.serializeWithPlaceholders(el);
      window.__SK.injectTranslation({ kind: 'element', el }, text, slots);
      const markedAfterEcho = el.hasAttribute('data-shinkansen-translated');

      // 模擬「已翻譯」session 再 restore(使用者清快取重翻必經 restore toggle)
      window.__SK.STATE.translated = true;
      return new Promise((resolve) => {
        window.addEventListener('shinkansen-debug-response', () => {
          const rescanCandidates = window.__SK.collectParagraphs(document.body, {});
          resolve({
            markedAfterEcho,
            markedAfterRestore: el.hasAttribute('data-shinkansen-translated'),
            inCandidatesAfterRestore: coversEchoText(rescanCandidates, ${JSON.stringify(ECHO_TEXT)}),
          });
        }, { once: true });
        window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: { action: 'RESTORE' } }));
        setTimeout(() => resolve({ markedAfterEcho, timeout: true }), 5000);
      });
    })()
  `);

  expect(r.timeout, 'RESTORE bridge 不應 timeout').toBeFalsy();
  expect(r.markedAfterEcho, 'echo 後應標 translated').toBe(true);
  expect(r.markedAfterRestore, 'restore 後標記應清掉').toBe(false);
  expect(r.inCandidatesAfterRestore, 'restore 後應重新成為候選(重翻可重送)').toBe(true);

  await page.close();
});
