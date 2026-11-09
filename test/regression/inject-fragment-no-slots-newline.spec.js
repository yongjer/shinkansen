// Regression: inject-fragment-no-slots-newline (對應 v1.4.8 的兩個 inject path 修正)
//
// Fixture: test/regression/fixtures/inject-fragment-no-slots-newline.html
//
// 驗證：fragment unit + slots=[] 路徑下，translation 含字面「\n」（反斜線+n，兩字元）時，
//       兩個 v1.4.8 修正會接力把它變成 DOM 內的 <br>：
//   (1) injectTranslation 入口：translation.replace(/\\n/g, '\n')
//       字面「\n」→ 真正換行符
//   (2) injectFragmentTranslation 無 slots 分支：
//       if (translation.includes('\n')) buildFragmentFromTextWithBr(translation)
//       真正換行符 → DocumentFragment（含 <br>）
//
// 為什麼用 fragment unit + 直接呼叫 injectTranslation：
//   既有 fixtures 多走 element + slots 路徑（透過 testInject helper），
//   fragment no-slots 在實際使用較少見但確實存在（例如 extractInlineFragments 的單純 text run）。
//   無對應 helper，spec 在 page 端直接構造 unit 物件。
//
// SANITY 驗證紀錄（已實測，見對應 SANITY 段落）：
//   (i)  移除入口 \\n→\n 規範化 → DOM 殘留字面「\n」字串、brCount=0
//   (ii) 移除無 slots 分支的 \n→<br> 還原 → DOM 出現含換行符的單一 text node、brCount=0
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-fragment-no-slots-newline';

test('inject-fragment-no-slots-newline: fragment unit + slots=[] + 含字面 \\n 的譯文應變成 <br>', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 在 isolated world 構造 fragment unit + 呼叫 injectTranslation
  // translation 內容 '段一\\\\n段二' 在 eval 後變成 '段一\\n段二'（4 chars: 段一 + \ + n + 段二）
  // 模擬 LLM 回了字面「\n」而非真正換行符
  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const startNode = el.firstChild; // text node
      const endNode = startNode;       // 單一 text node
      const unit = { kind: 'fragment', el, startNode, endNode };
      // 譯文含字面「\\n」（反斜線+n 兩字元）
      window.__SK.injectTranslation(unit, '段一\\\\n段二', []);
      const brs = el.querySelectorAll('br');
      const textPieces = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.nodeValue;
        if (t) textPieces.push(t);
      }
      return {
        brCount: brs.length,
        textPieces,
        hasLiteralBackslashN: textPieces.some(t => t.includes('\\\\n')),
        hasRealNewline: textPieces.some(t => t.includes('\\n')),
        innerHTMLPreview: el.innerHTML.replace(/\\s+/g, ' ').slice(0, 200),
      };
    })()
  `);

  // 斷言 1：DOM 不應殘留字面「\n」（兩字元）
  expect(
    result.hasLiteralBackslashN,
    `DOM 不應殘留字面 \\n，textPieces=${JSON.stringify(result.textPieces)}\nDOM=${result.innerHTMLPreview}`,
  ).toBe(false);

  // 斷言 2：DOM 不應殘留真正換行符（應該已被轉成 <br>）
  expect(
    result.hasRealNewline,
    `DOM 不應殘留真正換行符（應已變 <br>），textPieces=${JSON.stringify(result.textPieces)}\nDOM=${result.innerHTMLPreview}`,
  ).toBe(false);

  // 斷言 3：DOM 應含 1 個 <br>（段一 與 段二 之間）
  expect(
    result.brCount,
    `應出現 1 個 <br>，實際 ${result.brCount}，DOM=${result.innerHTMLPreview}`,
  ).toBe(1);

  // 斷言 4：兩段中文都應出現
  expect(
    result.textPieces.some(t => t.includes('段一')),
    `應含「段一」，textPieces=${JSON.stringify(result.textPieces)}`,
  ).toBe(true);
  expect(
    result.textPieces.some(t => t.includes('段二')),
    `應含「段二」，textPieces=${JSON.stringify(result.textPieces)}`,
  ).toBe(true);

  await page.close();
});
