'use strict';

/**
 * v1.9.17 regression: SK.ensureFirstInjectIdle 首次 inject hydration wait gate
 *
 * 【歷史 bug】Medium / Substack 等 React 18 SSR + streaming hydration SPA 站,page reload
 *   後 hydration 期間 Shinkansen auto-translate 早於 hydration 完成就 inject DOM
 *   → 移走 React reconciliation 認為仍掛在 parent 的 child → React 內部 removeChild
 *   找不到 → throw NotFoundError → React Router error boundary → render「500 系統
 *   出狀況」error page。
 *
 * 【v1.9.17 修法 + 2026-05-20 停用】content-ns.js 加 SK.ensureFirstInjectIdle 機制,
 *   用固定 setTimeout(FIRST_INJECT_HYDRATION_WAIT_MS)等 1500ms 後才 resolve。
 *   2026-05-20 Finding 4 對照實驗(SPEC-PRIVATE §25.20.12)發現此 gate 是 OP first-paint
 *   3.9s 中 64% 延遲源頭,且 Medium 當前 React 版本已內部解掉 race,gate 成 dead code。
 *   **常數改 0(等同跳過 wait),保留整套機制備未來新 site race scenario 一鍵 rollback**。
 *
 * 為什麼不用 requestIdleCallback:已驗證 RIC 對「React 完成 hydration」沒鑒別力。
 *   RIC 只看主執行緒 frame 間 microsecond idle,Medium hydration 跨多 task 跑,每
 *   task 間 RIC 立刻 fire,實質上 idle gate 20-50ms reach,使用者根本感覺不到 delay,
 *   完全沒擋到 inject vs React commit race。固定 setTimeout 是粗暴但確定的等法。
 *
 * 本檔測:
 *   1. FIRST_INJECT_HYDRATION_WAIT_MS = 0(2026-05-20 對照實驗後 disabled)forcing function
 *   2. 第一次 call 返回 pending promise,setTimeout fire 前不 resolve(用 local override 測機制完整性)
 *   3. 等到 setTimeout fire 後 _idleGateReached 變 true、promise resolve
 *   4. 後續 call 在 _idleGateReached=true 後直接返回 resolved promise
 *   5. 同一 gate window 內多 caller 共用同個 pending promise
 *   6. content-spa.js triggerSpaObserverRescan 入口 reset gate(機制仍保留,gate 重啟時有用)
 *
 * SANITY 紀錄(已驗證 2026-05-14 + 2026-05-20 update):
 *   1. content-ns.js ensureFirstInjectIdle 還原成「return Promise.resolve()」(完全不 gate)
 *      → test 2 fail(promise 立即 resolve,沒等 setTimeout)
 *   2. FIRST_INJECT_HYDRATION_WAIT_MS 改成 1500(rollback gate)→ test 1 fail(常數值斷言)
 *   3. content-spa.js triggerSpaObserverRescan 移掉 reset → test 6 fail
 *   4. 復原 → 全綠
 */

const { JSDOM } = require('jsdom');
const path = require('path');
const fs = require('fs');

function loadSk() {
  const root = path.join(__dirname, '..', '..', 'shinkansen');
  return fs.readFileSync(path.join(root, 'content-ns.js'), 'utf8');
}

function loadSpaSource() {
  const root = path.join(__dirname, '..', '..', 'shinkansen');
  return fs.readFileSync(path.join(root, 'content-spa.js'), 'utf8');
}

const NS_SCRIPT = loadSk();

function makeEnv() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  win.chrome = {
    runtime: { sendMessage: () => Promise.resolve({}), getManifest: () => ({ version: '1.9.17' }), onMessage: { addListener: () => {} } },
    storage: { sync: { get: () => Promise.resolve({}) }, onChanged: { addListener: () => {} } },
  };

  try { win.eval(NS_SCRIPT); } catch (_) { /* init side effects 可忽略 */ }

  return {
    win,
    cleanup() { win.close(); },
  };
}

describe('v1.9.17: SK.ensureFirstInjectIdle 首次 inject hydration wait gate', () => {
  let env;
  afterEach(() => { if (env) { env.cleanup(); env = null; } });

  test('FIRST_INJECT_HYDRATION_WAIT_MS = 0(2026-05-20 對照實驗後 disabled,forcing function,SPEC-PRIVATE §25.20.12)', () => {
    env = makeEnv();
    expect(env.win.__SK.FIRST_INJECT_HYDRATION_WAIT_MS).toBe(0);
  });

  test('第一次 call 返回 pending promise,setTimeout fire 前不 resolve', async () => {
    env = makeEnv();
    const SK = env.win.__SK;
    // 暫時把 wait 改短一點測,不必真等 1.5s
    SK.FIRST_INJECT_HYDRATION_WAIT_MS = 200;
    let resolved = false;
    const start = Date.now();
    const p = SK.ensureFirstInjectIdle();
    p.then(() => { resolved = true; });

    // 給 microtask 一輪
    await new Promise(r => setTimeout(r, 50));
    expect(resolved).toBe(false);
    expect(SK._idleGateReached).toBe(false);

    await p;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);  // 寬鬆 lower bound (200ms - 20ms)
    expect(SK._idleGateReached).toBe(true);
  });

  test('後續 call 在 _idleGateReached=true 後直接返回 resolved promise(no extra wait)', async () => {
    env = makeEnv();
    const SK = env.win.__SK;
    SK.FIRST_INJECT_HYDRATION_WAIT_MS = 50;
    const p1 = SK.ensureFirstInjectIdle();
    await p1;
    expect(SK._idleGateReached).toBe(true);

    // 後續 call:should 直接 resolve
    const start = Date.now();
    const p2 = SK.ensureFirstInjectIdle();
    let p2Resolved = false;
    p2.then(() => { p2Resolved = true; });
    await new Promise(r => setTimeout(r, 5));
    expect(p2Resolved).toBe(true);
    expect(Date.now() - start).toBeLessThan(30);  // 沒等
  });

  test('同一 gate window 內多 caller 共用同個 pending promise', async () => {
    env = makeEnv();
    const SK = env.win.__SK;
    SK.FIRST_INJECT_HYDRATION_WAIT_MS = 100;
    const p1 = SK.ensureFirstInjectIdle();
    const p2 = SK.ensureFirstInjectIdle();
    const p3 = SK.ensureFirstInjectIdle();
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    await Promise.all([p1, p2, p3]);
    expect(SK._idleGateReached).toBe(true);
  });

  // ─── v1.9.17 第二輪:SPA rescan 路徑要 reset gate ──────
  // 為什麼必須鎖死:單純「首次 inject hydration wait」只解 *initial hydration race*。
  // React SPA click button 觸發 re-render → Shinkansen MutationObserver → SPA rescan
  // → inject。此時 SK._idleGateReached 已是 true,inject 直接通過 gate → 跟 React
  // re-render commit phase 撞 removeChild race(Medium 留言「more」點下變 500 page)。
  //
  // 修法(content-spa.js triggerSpaObserverRescan):rescan trigger 入口 reset gate,
  // 讓 SPA rescan 觸發的 inject 重新走完整 1500ms wait。手動 Alt+S / first translate
  // 路徑不受影響(它們不經過 triggerSpaObserverRescan)。
  //
  // 本 spec 用 source-code grep 鎖死該 reset 邏輯存在(non-runtime test)。
  test('navigator.webdriver === true 時 gate 立刻 bypass(Playwright spec 環境不被 1500ms 拖)', async () => {
    // 自建 env 預先設 navigator.webdriver = true(模擬 Playwright / WebDriver session)
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://example.com/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    const win = dom.window;
    // 在 SK 載入前 patch navigator.webdriver
    Object.defineProperty(win.navigator, 'webdriver', { value: true, configurable: true });
    win.chrome = {
      runtime: { sendMessage: () => Promise.resolve({}), getManifest: () => ({ version: '1.9.17' }), onMessage: { addListener: () => {} } },
      storage: { sync: { get: () => Promise.resolve({}) }, onChanged: { addListener: () => {} } },
    };
    try { win.eval(NS_SCRIPT); } catch (_) {}

    const SK = win.__SK;
    const start = Date.now();
    await SK.ensureFirstInjectIdle();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);  // 立刻 resolve 不等 setTimeout
    expect(SK._idleGateReached).toBe(true);
    win.close();
  });

  test('content-spa.js triggerSpaObserverRescan 入口必須 reset _idleGateReached / _idleGatePromise', () => {
    const src = loadSpaSource();
    const startIdx = src.indexOf('function triggerSpaObserverRescan');
    expect(startIdx).toBeGreaterThan(0);
    const nextFn = src.indexOf('\n  function ', startIdx + 1);
    const body = src.slice(startIdx, nextFn > 0 ? nextFn : startIdx + 800);
    expect(/SK\._idleGateReached\s*=\s*false/.test(body)).toBe(true);
    expect(/SK\._idleGatePromise\s*=\s*null/.test(body)).toBe(true);
  });
});
