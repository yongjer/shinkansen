// Shinkansen 回歸測試共用 helper (v0.59 新增)
//
// 兩個職責:
//   1. loadFixtureResponse(name)
//      讀 test/regression/fixtures/<name>.response.txt 的內容 (canned LLM 回應)。
//      HTML fixture 本身是給 localServer 直接 serve 的,不需要 Node 端讀。
//
//   2. getShinkansenEvaluator(page)
//      跟 test/edo-detection.spec.js 同樣的 CDP isolated world evaluator,
//      讓 spec 能在 Shinkansen content script isolated world 內呼叫
//      window.__shinkansen.testInject(...) 等 debug API。
//
// 為什麼非 CDP 不可:Playwright 的 page.evaluate(fn) 一律跑在 page main world,
// 看不到 content script isolated world 的 window.__shinkansen,
// 必須走 Chrome DevTools Protocol 指定 contextId 才能呼叫到。
// 細節 (Runtime.executionContextCreated 必須在 enable 之前掛、auxData.type
// 為 'isolated' 的篩選邏輯等) 見 edo-detection.spec.js 開頭註解。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

export function loadFixtureResponse(name) {
  const respPath = path.join(FIXTURES_DIR, `${name}.response.txt`);
  // .response.txt 末尾的尾隨 \n 是 editor 自動加的,canned LLM 回應裡不應該
  // 帶它,否則會在 deserializer 後面留下多餘的空白文字節點。
  return fs.readFileSync(respPath, 'utf8').replace(/\n+$/, '');
}

export async function getShinkansenEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);

  const contexts = [];
  // 改用 event-driven 等 Shinkansen isolated world 出現,取代原本寫死 500ms wait。
  // 原因:MV3 service worker cold-start + content script 注入耗時隨系統負載變動,
  // 全套 npm test 跑到 600+ specs 時偶發超過 500ms 命中,後續 evaluate 卡到 60s timeout
  // (Playwright 預設 per-test timeout)。改成「context 一出現就解 Promise」+ 5s 安全上限,
  // 在閒置時與原本一樣快(< 500ms)、在高負載時也能等到位才繼續,不再 flaky。
  const findShinkansen = () => {
    const isolated = contexts.filter((c) => c?.auxData?.type === 'isolated');
    return isolated.find((c) => c.name === 'Shinkansen')
        || isolated.find((c) => /Shinkansen/i.test(c.name || ''));
  };

  let shinkansen = null;
  let resolveReady;
  const ready = new Promise((res) => { resolveReady = res; });
  const tryResolve = () => {
    if (shinkansen) return;
    const found = findShinkansen();
    if (found) { shinkansen = found; resolveReady(found); }
  };

  cdp.on('Runtime.executionContextCreated', (event) => {
    contexts.push(event.context);
    tryResolve();
  });
  cdp.on('Runtime.executionContextDestroyed', (event) => {
    const idx = contexts.findIndex((c) => c.id === event.executionContextId);
    if (idx >= 0) contexts.splice(idx, 1);
  });

  await cdp.send('Runtime.enable');
  // Runtime.enable 會觸發 executionContextCreated 補發既存 contexts,event listener
  // 收到後 tryResolve 會立即觸發。但 race 有可能:enable 完成前 listener 已註冊好,
  // 安全起見 enable 後再手動 try 一次(已存在的 contexts 已被推進陣列)。
  tryResolve();

  await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => {
      const dump = contexts
        .filter((c) => c?.auxData?.type === 'isolated')
        .map((c) => ({ id: c.id, name: c.name, origin: c.origin, auxData: c.auxData }));
      reject(new Error(
        `找不到 Shinkansen isolated world execution context(等 5s 仍無)。\n候選: ${JSON.stringify(dump, null, 2)}`,
      ));
    }, 5000)),
  ]);

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      contextId: shinkansen.id,
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `Runtime.evaluate 失敗: ${result.exceptionDetails.text}\nexpression: ${expression}`,
      );
    }
    return result.result.value;
  }

  return { cdp, contextId: shinkansen.id, contextName: shinkansen.name, evaluate };
}

/**
 * 在 isolated world 對指定 selector 命中的 element 跑 testInject。
 * 為什麼把這個包起來:讓 spec 不用每次手寫長串的 expression 字串拼接,
 * 也讓「element 必須存在」這個前置斷言只寫一次。
 */
export async function runTestInject(evaluate, targetSelector, translation) {
  const expr = `
    (() => {
      const el = document.querySelector(${JSON.stringify(targetSelector)});
      if (!el) throw new Error('runTestInject: target not found: ' + ${JSON.stringify(targetSelector)});
      return window.__shinkansen.testInject(el, ${JSON.stringify(translation)});
    })()
  `;
  return evaluate(expr);
}
