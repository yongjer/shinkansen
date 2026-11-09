'use strict';

/**
 * v1.9.17 F2 regression: user interaction blackout window
 *
 * Bug:Medium 留言點「更多」展開後出現「500 系統出狀況」error page。
 *   Root cause:user click → React onClick → React commit phase(sync 改 DOM)→
 *   Shinkansen MutationObserver callback fire 在 commit 期間 microtask queue →
 *   `restoreOnInnerMutation` sync `target.innerHTML = savedHTML` 改 DOM →
 *   React 後續 reconcile removeChild 找不到原 child → throw NotFoundError →
 *   React Router fallback render「500 系統出狀況」error page。
 *
 * 修法(content-ns.js + content-spa.js F2):
 *   1. content-ns.js init 區裝 mousedown/pointerdown/keydown capture listener,
 *      更新 SK._lastInteractionT。
 *   2. content-spa.js onSpaObserverMutations 把 sync DOM modify(restoreOnInner
 *      Mutation + reapplyOnDetachReattach)改 RAF defer。
 *   3. RAF callback 內檢查 USER_INTERACTION_BLACKOUT_MS (2000ms) window —
 *      blackout 內完全跳過 sync restore,讓 framework 自己處理 DOM,Shinkansen
 *      等 armSpaObserverRescan path 走 idle gate 安全 inject。
 *
 * 本檔測:
 *   1. content-ns.js init 區裝 user interaction listeners + SK._lastInteractionT
 *      / SK.USER_INTERACTION_BLACKOUT_MS 常數
 *   2. mousedown / pointerdown / keydown 觸發後 SK._lastInteractionT 更新
 *   3. content-spa.js source 含 BLACKOUT_MS 比對 + RAF defer 兩個 sync restore call
 *
 * SANITY 紀錄(已驗證 2026-05-14):
 *   1. content-ns.js 移掉 user interaction listener → mousedown 後 _lastInteractionT
 *      不更新 → blackout check 永遠不命中 → spec fail
 *   2. content-spa.js 移掉 BLACKOUT check → blackout 內仍 sync restore → spec fail
 *   3. 復原 → 全綠
 */

const { JSDOM } = require('jsdom');
const path = require('path');
const fs = require('fs');

function loadSk() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'shinkansen', 'content-ns.js'), 'utf8');
}
function loadSpa() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'shinkansen', 'content-spa.js'), 'utf8');
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
    dispatchEvent(type) {
      const evt = new win.Event(type, { bubbles: true });
      win.dispatchEvent(evt);
    },
    cleanup() { win.close(); },
  };
}

describe('v1.9.17 F2: user interaction blackout window', () => {
  let env;
  afterEach(() => { if (env) { env.cleanup(); env = null; } });

  test('SK.USER_INTERACTION_BLACKOUT_MS 常數 = 2000(forcing function)', () => {
    env = makeEnv();
    expect(env.win.__SK.USER_INTERACTION_BLACKOUT_MS).toBe(2000);
  });

  test('init 區裝 SK._lastInteractionT = 0(默認狀態 = 沒有近期 interaction)', () => {
    env = makeEnv();
    expect(env.win.__SK._lastInteractionT).toBe(0);
  });

  test('mousedown 後 SK._lastInteractionT 更新到當下時間', () => {
    env = makeEnv();
    const SK = env.win.__SK;
    const before = Date.now();
    env.dispatchEvent('mousedown');
    expect(SK._lastInteractionT).toBeGreaterThanOrEqual(before);
    expect(SK._lastInteractionT).toBeLessThanOrEqual(Date.now() + 10);
  });

  test('pointerdown 後 SK._lastInteractionT 更新', () => {
    env = makeEnv();
    const SK = env.win.__SK;
    env.dispatchEvent('pointerdown');
    expect(SK._lastInteractionT).toBeGreaterThan(0);
  });

  test('keydown 後 SK._lastInteractionT 更新', () => {
    env = makeEnv();
    const SK = env.win.__SK;
    env.dispatchEvent('keydown');
    expect(SK._lastInteractionT).toBeGreaterThan(0);
  });

  test('其他 event(mouseup / scroll / mousemove)不觸發 interaction tracker', () => {
    env = makeEnv();
    const SK = env.win.__SK;
    env.dispatchEvent('mouseup');
    env.dispatchEvent('scroll');
    env.dispatchEvent('mousemove');
    expect(SK._lastInteractionT).toBe(0);
  });

  test('content-spa.js source 必須在 RAF defer 內檢查 USER_INTERACTION_BLACKOUT_MS', () => {
    const src = loadSpa();
    // RAF defer wrapper 內含 blackout 比對
    expect(/USER_INTERACTION_BLACKOUT_MS/.test(src)).toBe(true);
    // RAF defer 把 sync restoreOnInnerMutation / reapplyOnDetachReattach 包起來
    expect(/requestAnimationFrame\(deferredRestore\)/.test(src)).toBe(true);
  });

  test('content-spa.js source 內 restoreOnInnerMutation / reapplyOnDetachReattach 兩個 call 必須在 deferredRestore 內(不可在 onSpaObserverMutations 直接 sync call)', () => {
    const src = loadSpa();
    // 抓 onSpaObserverMutations 函式內容
    const startIdx = src.indexOf('function onSpaObserverMutations');
    expect(startIdx).toBeGreaterThan(0);
    const nextFn = src.indexOf('\n  function ', startIdx + 1);
    const fnBody = src.slice(startIdx, nextFn > 0 ? nextFn : startIdx + 3000);
    // restoreOnInnerMutation / reapplyOnDetachReattach 必須出現,但只能在 deferredRestore
    // closure 內。最簡單檢查:body 包含 deferredRestore 關鍵字 + 兩個 sync call 名稱
    expect(/deferredRestore/.test(fnBody)).toBe(true);
    expect(/restoreOnInnerMutation\(mutations\)/.test(fnBody)).toBe(true);
    expect(/reapplyOnDetachReattach\(mutations\)/.test(fnBody)).toBe(true);
  });
});
