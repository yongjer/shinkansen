// Regression(v1.10.45):fragment 容器是其他 block 單元的祖先時,RESTORE 還原原文
//
// 真實 bug(Jimmy 回報 2026-06-10,telefoncek.si 文章頁):
//   翻譯後按取消無法恢復原文,主文整批仍是中文。
//
// 根因(§8 結構性):
//   頁面 .wrapper 容器同時(a)尾段有直屬文字「Kategorije:」+ inline <i><a>
//   → collectParagraphs Case A 抽 inline fragment,fragment.el = 整個 .wrapper;
//   (b)包住 <article> 內 37 個 <p>(各自 element unit)。
//   injectFragmentTranslation 對 fragment 走 snapshotOnce(el) 存「整個 .wrapper.innerHTML」,
//   而此 snapshot 是注入時才 lazy 取——容器內的 P 在更早批次(priority sort 把頁尾
//   fragment 排最後)已翻譯注入 → 容器的「原文」snapshot 被污染成含譯文。
//   RESTORE 迴圈把各 P 還原英文後,迭代到 .wrapper → `el.innerHTML = 污染snapshot`
//   把已還原的英文段落整批沖回中文 → 殘留譯文。
//
// 修法(content-detect.js collectParagraphs Case A):
//   趁全頁尚未翻譯,在「收集當下」就 SK.snapshotOnce(容器),確保 originalHTML[容器]
//   是真原文;注入時的 snapshotOnce 因冪等變 no-op。RESTORE 用乾淨 snapshot 還原。
//
// 本 spec 鎖:
//   1. 結構前提:確實抽出 fragment 且 fragment.el 是 P element 單元的祖先
//   2. 刻意以「污染順序」注入(先注入內層 P,再注入 fragment 容器)
//   3. RESTORE 後主文完整回英文、無殘留譯文標記、originalHTML 清空
//
// SANITY CHECK 紀錄(已驗證,2026-06-10):
//   把 content-detect.js Case A 內新增的 `SK.snapshotOnce?.(el);` 那行註解掉 →
//   斷言「RESTORE 後 zhCount === 0」fail(主文 P 殘留 [ZH] 譯文,容器污染 snapshot
//   把已還原英文沖回)。還原該行後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'restore-fragment-ancestor';

test('inject-restore-fragment-ancestor: fragment 容器祖先污染下 RESTORE 仍完整還原原文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#wrap', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // ── 收集 + 刻意污染順序注入 ──
  // 全程在 isolated world 一次 evaluate 完成(unit 物件含 DOM ref 不能跨 evaluate 傳)。
  const setup = await evaluate(`(() => {
    const SK = window.__SK;
    const STATE = SK.STATE;
    const wrap = document.getElementById('wrap');

    // 收集前先記原文(restore 比對基準)
    const origP = ['p1','p2','p3'].map(id => document.getElementById(id).textContent.trim());

    const units = SK.collectParagraphs(document.body);
    const fragUnits = units.filter(u => u.kind === 'fragment');
    const elemUnits = units.filter(u => u.kind === 'element' && u.el && u.el.tagName === 'P');

    // 結構前提:抽出 fragment 且其 el 是 .wrapper(P 單元的祖先)
    const fragAncestorOfP = fragUnits.some(fu =>
      elemUnits.length > 0 && elemUnits.every(eu => fu.el.contains(eu.el)));

    // 污染順序:先注入內層 P element 單元(模擬 priority sort 先翻主文),
    // 再注入 fragment 容器(模擬頁尾 fragment 最後注入)。
    for (const eu of elemUnits) {
      SK.injectTranslation(eu, '[ZH] ' + (eu.el.textContent || '').trim(), null);
    }
    for (const fu of fragUnits) {
      let t = '';
      let n = fu.startNode;
      while (n) { t += (n.textContent || ''); if (n === fu.endNode) break; n = n.nextSibling; }
      SK.injectTranslation(fu, '[ZH] ' + t.trim(), null);
    }

    // 模擬 translatePage 完成後的狀態(RESTORE 入口要求 translated)
    STATE.translated = true;
    STATE.translatedMode = 'single';

    return {
      unitCount: units.length,
      fragCount: fragUnits.length,
      elemPCount: elemUnits.length,
      fragAncestorOfP,
      zhAfterInject: (document.body.innerText.match(/\\[ZH\\]/g) || []).length,
      origP,
    };
  })()`);

  expect(setup.fragCount, '應抽出至少一個 fragment 單元').toBeGreaterThanOrEqual(1);
  expect(setup.elemPCount, '應收集到 3 個 P element 單元').toBe(3);
  expect(setup.fragAncestorOfP, 'fragment 容器應為 P 單元的祖先(觸發污染條件)').toBe(true);
  expect(setup.zhAfterInject, '注入後主文 + 頁尾應都帶 [ZH] 譯文').toBeGreaterThanOrEqual(4);

  // ── RESTORE(走真實 restorePage 路徑)──
  const restoreResp = await evaluate(`new Promise((resolve) => {
    const onResp = (e) => { window.removeEventListener('shinkansen-debug-response', onResp); resolve(e.detail); };
    window.addEventListener('shinkansen-debug-response', onResp);
    window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: { action: 'RESTORE', afterSeq: 0 } }));
    setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), 3000);
  })`);
  expect(restoreResp.restored, 'RESTORE 應回報 restored').toBe(true);

  // ── 還原結果驗證 ──
  const after = await evaluate(`(() => {
    const STATE = window.__SK.STATE;
    const curP = ['p1','p2','p3'].map(id => { const el = document.getElementById(id); return el ? el.textContent.trim() : null; });
    return {
      zhCount: (document.body.innerText.match(/\\[ZH\\]/g) || []).length,
      markedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
      originalHTMLSize: STATE.originalHTML.size,
      translated: STATE.translated,
      wrapText: document.getElementById('wrap').innerText,
      curP,
    };
  })()`);

  expect(after.zhCount, 'RESTORE 後不得殘留任何 [ZH] 譯文(核心斷言)').toBe(0);
  expect(after.markedCount, 'RESTORE 後 data-shinkansen-translated 應全清').toBe(0);
  expect(after.originalHTMLSize, 'RESTORE 後 originalHTML 應清空').toBe(0);
  expect(after.translated, 'RESTORE 後不應標記 translated').toBe(false);
  // 主文 P 應完整回到原始英文
  expect(after.curP[0]).toBe(setup.origP[0]);
  expect(after.curP[1]).toBe(setup.origP[1]);
  expect(after.curP[2]).toBe(setup.origP[2]);
  // 頁尾 fragment 區也應回原文(無中文殘留標記)
  expect(after.wrapText.includes('[ZH]'), '頁尾 fragment 也應還原').toBe(false);

  await page.close();
});
