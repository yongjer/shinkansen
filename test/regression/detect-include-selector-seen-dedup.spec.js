// Regression: include-selector-seen-dedup (v1.10.46 批次 1-5「同 el 雙 unit → echo-revert」)
//
// Fixture: test/regression/fixtures/include-selector-seen-dedup.html
//
// Bug 類型:收集層產生「同 el 雙 unit」→ content.js 段落 hash dedup 把兩個 unit 歸
// 同一 text entry → broadcast 注入時對同 el 注入兩次——第二次注入時 _preText 已是
// 譯文,被 content-inject.js 的 echo 判定誤判 → _revertEcho 把段落沖回原文
// (使用者看到「翻完又變回原文」)。
//
// 本 fixture 實際重現的雙收配對(probe 驗證,2026-06-11):
//   walker inlineMixedFragment(kind=fragment,el=容器)+ leaf-content-div 補抓
//   (kind=element,同 el)。fragment 抽取只標 fragmentExtracted、不把容器加進 seen
//   (容器可能還有其他 run),而 leaf-content-div 原本只查 seen → 雙收。
//
// 修法三層:
//   (a1) content-detect.js INCLUDE_BY_SELECTOR push 後補 seen.add(el)
//        (全檔唯一漏 seen.add 的入口,latent hole,本 fixture 碰不到但一併堵)
//   (a2) content-detect.js leaf-content-div 補抓加 fragmentExtracted.has(d) 檢查
//        (本 fixture 重現的那條)
//   (b)  content.js 兩條 broadcast loop(non-streaming + streaming)同輪同 el 去重:
//        element unit 同 el 已注入(element 或 fragment)→ skip;fragment unit 同 el
//        已整顆 element 注入 → skip;fragment 同 el 多 run 合法不擋
//
// SANITY 紀錄(已驗證,2026-06-11):
//   先寫 spec 重現紅燈 → 修 → 綠燈:修法 (a2) 套用前第 1 條 fail(#card-detail-text /
//   #note-leaf / #hatnote-leaf 各出現 fragment+element 雙 unit);(b) 套用前第 2 條
//   fail(同 el 雙 element unit 翻完被 echo-revert 沖回原文,finalText 退回英文原文)。
//   兩修法套用後全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'include-selector-seen-dedup';

test('收集層不得同 el 雙收(element 重複 / element 與 fragment 同 el)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#card-detail-text', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // isolated world 內直接比對 unit el reference(ground truth)。
  // 違規定義:element unit 的 el 已出現過(任何 kind),或 fragment unit 的 el 已被
  // element unit 收過。fragment 同 el 多 run(不同 startNode/endNode)是合法的,不算違規。
  const raw = await evaluate(`
    (() => {
      const units = window.__SK.collectParagraphs();
      const elementEls = new Set();
      const fragmentEls = new Set();
      const violations = [];
      for (const u of units) {
        if (!u.el) continue;
        const id = u.el.id || u.el.tagName;
        if (u.kind === 'element') {
          if (elementEls.has(u.el) || fragmentEls.has(u.el)) violations.push(id + '(element 重複收)');
          elementEls.add(u.el);
        } else if (u.kind === 'fragment') {
          if (elementEls.has(u.el)) violations.push(id + '(fragment 收在 element 之後)');
          fragmentEls.add(u.el);
        }
      }
      return JSON.stringify({
        violations,
        ids: units.map(u => (u.el && (u.el.id || u.el.tagName)) || '?'),
      });
    })()
  `);
  const { violations, ids } = JSON.parse(raw);

  // 斷言 1(核心):無同 el 雙收
  expect(violations, `同 el 雙收:${violations.join(', ')}(全部收集:${ids.join(', ')})`).toEqual([]);

  // 斷言 2:目標元素仍有被收(防修成「整個 pass 不收」的假綠)
  expect(ids).toContain('card-detail-text');
  expect(ids).toContain('note-leaf');
  expect(ids).toContain('hatnote-leaf');
  expect(ids).toContain('control-paragraph');
});

test('broadcast 注入防護:units 內同 el 雙 unit 時同輪只注入一次(不觸發 echo-revert)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#card-detail-text', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock 訊息層(同 translate-dedup-broadcast.spec.js pattern):
  //   streaming 失敗 → fallback non-streaming TRANSLATE_BATCH,回 '[ZH] ' + 原文
  await evaluate(`
    chrome.storage.sync.get = async function(keys) {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 20,
        maxCharsPerBatch: 100000,
        partialMode: { enabled: false, maxUnits: 25 },
      };
    };
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        return { ok: false, error: 'streaming disabled in test' };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: texts.length, outputTokens: texts.length, cachedTokens: 0,
                   billedInputTokens: texts.length, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 手動塞「同 el 雙 unit」進 translateUnits——模擬收集層雙收(獨立於修法 (a1)/(a2),
  // 即使未來又有新收集入口漏 seen.add,broadcast 防護層 (b) 也要堵住整類)。
  // 同 el → 序列化出同 text → text-hash dedup 歸同 entry → broadcast 對
  // orig indices [0,1] 各注入一次 → 沒防護時第二次 echo 判定誤判沖回原文。
  await evaluate(`
    (() => {
      const el = document.getElementById('card-detail-text');
      window.__originalText = el.innerText;
      const units = [{ kind: 'element', el }, { kind: 'element', el }];
      window.__translatePromise = window.__SK.translateUnits(units).catch(e => null);
      return null;
    })()
  `);
  await page.waitForTimeout(1500);

  const raw = await evaluate(`
    JSON.stringify({
      original: window.__originalText,
      finalText: document.getElementById('card-detail-text').innerText,
    })
  `);
  const { original, finalText } = JSON.parse(raw);

  // 譯文必須留在頁面上;任何「沖回原文」都代表同 el 雙注入觸發 echo-revert
  expect(finalText, '同 el 雙 unit 翻完不得沖回原文').toContain('[ZH]');
  expect(finalText).not.toBe(original);
});
