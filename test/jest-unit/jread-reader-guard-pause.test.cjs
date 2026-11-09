'use strict';

/**
 * v1.10.65 regression: JRead 閱讀模式握手暫停 content guard
 *
 * Bug（Jimmy 2026-06-21 iPhone 回報，JRead repo）：Shinkansen 翻譯後再進 JRead 閱讀
 * 模式，畫面每秒閃一下、像在重排版；未翻譯則無。
 *
 * 根因：JRead 把被翻譯的 articleEl 重排成閱讀卡片，Shinkansen content guard 每秒 sweep
 * 把它誤判成「譯文被 SPA 覆蓋」而重建子節點 → 每秒 reflow 閃動。閱讀卡片即 articleEl
 * 本身、在 guard 管轄區內，JRead 端無法閃避，故由 guard 端在閱讀模式期間讓位。
 *
 * 修法（握手）：JRead 進 / 出閱讀模式時 dispatch 'jread-reader-mode' CustomEvent（跨
 * extension content script、同 shinkansen-debug-request 機制）。content.js listener 收到
 * 呼叫 SK.setContentGuardPaused(active)，runContentGuard / onSpaObserverMutations 入口
 * 查 contentGuardExternallyPaused 旗標讓位（早退）。退出閱讀模式恢復。
 *
 * 本組驗：① listener 把事件轉成 setContentGuardPaused、② 旗標雙向切換正確、
 *         ③ 暫停期間 runContentGuard 不丟（早退，不動已翻譯內容）。
 */

const fs = require('fs');
const path = require('path');
const { createEnv } = require('./helpers/create-env.cjs');

describe('v1.10.65: JRead 閱讀模式握手暫停 content guard', () => {
  let env;
  afterEach(() => { if (env) { env.cleanup(); env = null; } });

  test('jread-reader-mode active:true → guard paused；active:false → resumed（雙向）', () => {
    env = createEnv({ url: 'https://example.com/article' });
    const SK = env.window.__SK;
    expect(typeof SK.setContentGuardPaused).toBe('function');
    // 初始未暫停
    expect(SK._spaDebug().contentGuardExternallyPaused).toBe(false);

    // JRead 進閱讀模式
    env.window.dispatchEvent(new env.window.CustomEvent('jread-reader-mode', { detail: { active: true } }));
    expect(SK._spaDebug().contentGuardExternallyPaused).toBe(true);

    // JRead 退出閱讀模式
    env.window.dispatchEvent(new env.window.CustomEvent('jread-reader-mode', { detail: { active: false } }));
    expect(SK._spaDebug().contentGuardExternallyPaused).toBe(false);
  });

  test('detail 缺漏 / 非 active 一律當 false（安全降級）', () => {
    env = createEnv({ url: 'https://example.com/article' });
    const SK = env.window.__SK;
    env.window.dispatchEvent(new env.window.CustomEvent('jread-reader-mode', { detail: { active: true } }));
    expect(SK._spaDebug().contentGuardExternallyPaused).toBe(true);
    // 無 detail → resume
    env.window.dispatchEvent(new env.window.CustomEvent('jread-reader-mode', {}));
    expect(SK._spaDebug().contentGuardExternallyPaused).toBe(false);
  });

  test('暫停期間 runContentGuard 早退、不丟（即使已翻譯）', () => {
    env = createEnv({ url: 'https://example.com/article' });
    const SK = env.window.__SK;
    // 標成已翻譯——否則 runContentGuard 本來就 early-return（!STATE.translated）
    env.shinkansen.setTestState({ translated: true });
    SK.setContentGuardPaused(true);
    expect(SK._spaDebug().contentGuardExternallyPaused).toBe(true);
    // production runContentGuard 跑一次：暫停旗標應在最前面 early-return，不丟
    expect(() => SK._testRunContentGuardProd()).not.toThrow();
  });

  test('原始碼：runContentGuard 與 onSpaObserverMutations 入口都查 contentGuardExternallyPaused', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'shinkansen', 'content-spa.js'), 'utf8');
    // v2.0.57(洞 1):runContentGuard 讓位分支從「整段早退」改成「只停 innerHTML / dual
    // 軌,nv 軌保留 sweep(reapplyOnly)後 return」——innerHTML / dual 軌讓位(防 JRead
    // 閃動)不可退步,nv 軌保留(防盲窗)也不可退步,兩者都鎖進同一條結構斷言
    expect(/if \(contentGuardExternallyPaused\)\s*\{[\s\S]{0,120}runContentGuardNvMutate\(false, true\);\s*return;\s*\}/.test(src)).toBe(true);
    // onSpaObserverMutations 維持整段讓位（mutation reconcile 會重建子樹,是閃動來源）
    expect(/function onSpaObserverMutations\([\s\S]{0,300}contentGuardExternallyPaused\)\s*return;/.test(src)).toBe(true);
    // setContentGuardPaused 是唯一寫入點
    expect(/SK\.setContentGuardPaused\s*=\s*function/.test(src)).toBe(true);
    // v2.0.57(洞 2):resume 補課——unpause 轉換時立即全量 nv reconcile
    expect(/wasPaused && !contentGuardExternallyPaused[\s\S]{0,120}runContentGuardNvMutate\(true\)/.test(src)).toBe(true);
  });
});
