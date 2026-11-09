'use strict';

/**
 * M9(c)（code review 2026-06-09）：background.js 的 chrome.alarms onAlarm 從「3 個各自
 * name-filter 的 addListener」收斂成「單一 dispatcher（_alarmHandlers name→handler map +
 * 一個 onAlarm listener 依 alarm.name 分派）」。純維護性重構，淨行為不變；收斂的目的是
 * 「未來新增 alarm 只要 _registerAlarm 一行，不會再漏接」。
 *
 * 為什麼是 source 斷言而非行為測試（訊號層次，CLAUDE.md 工作流原則 §3）：
 *   background.js 是 ES module，module top-level 有大量 side effect（建 limiter、註冊
 *   message handlers、fire-and-forget 初始呼叫等）+ 依賴 browser/chrome global，jest cjs
 *   環境無法 representatively 載入整個 SW。本 spec 鎖的是「結構性事實」：
 *     1. 全檔只剩「一個」onAlarm.addListener（不是回到分散註冊）
 *     2. dispatcher 依 alarm.name 從 _alarmHandlers 取 handler 分派
 *     3. 三個 alarm（update-check / exchange-rate-fetch / keepalive）都有 _registerAlarm 接上
 *   它「不鎖」alarm 真的 fire 時 handler 跑對結果——那要真 SW 環境，本層測不到。
 *   未來新增 alarm 漏接（忘了 _registerAlarm）→ 第 3 類斷言會抓到「名字數 < alarm.create 數」。
 *
 * SANITY 紀錄（已驗證，2026-06-09）：
 *   - 暫時把 keepalive 的 _registerAlarm(_STREAM_KEEPALIVE_ALARM, ...) 刪掉 → 「三個 alarm
 *     都有 handler」斷言 fail；還原 → pass
 *   - 暫時加回第二個 `.onAlarm.addListener(` → 「單一 listener」斷言 fail；還原 → pass
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/background.js'),
  'utf-8'
);

describe('M9(c) onAlarm 單一 dispatcher', () => {
  test('全檔只有一個 onAlarm.addListener（沒回到分散註冊）', () => {
    const matches = SRC.match(/\.onAlarm\.addListener\(/g) || [];
    expect(matches.length).toBe(1);
  });

  test('dispatcher infra 存在：_alarmHandlers map + _registerAlarm + 依 alarm.name 分派', () => {
    expect(SRC).toMatch(/const\s+_alarmHandlers\s*=\s*Object\.create\(null\)/);
    expect(SRC).toMatch(/function\s+_registerAlarm\(name,\s*handler\)/);
    // dispatcher 依 alarm.name 取 handler
    expect(SRC).toMatch(/_alarmHandlers\[alarm\.name\]/);
  });

  test('三個 alarm 都有 _registerAlarm 接上（漏接守門員）', () => {
    expect(SRC).toMatch(/_registerAlarm\(\s*'update-check'/);
    expect(SRC).toMatch(/_registerAlarm\(\s*'exchange-rate-fetch'/);
    expect(SRC).toMatch(/_registerAlarm\(\s*_STREAM_KEEPALIVE_ALARM/);
  });

  test('每個 alarm.create 的 name 都有對應 _registerAlarm（create 數 = handler 數）', () => {
    // 收集 alarms.create 的字面 name（'update-check' / 'exchange-rate-fetch'）+ 常數名 keepalive
    const createNames = new Set();
    for (const m of SRC.matchAll(/alarms\??\.create\(\s*'([a-z-]+)'/g)) createNames.add(m[1]);
    // keepalive 用常數 _STREAM_KEEPALIVE_ALARM 建立
    const keepaliveCreate = /alarms\??\.create\(\s*_STREAM_KEEPALIVE_ALARM/.test(SRC);
    expect(createNames.has('update-check')).toBe(true);
    expect(createNames.has('exchange-rate-fetch')).toBe(true);
    expect(keepaliveCreate).toBe(true);

    // 每個被 create 的 name 都要有 handler
    for (const name of createNames) {
      expect(SRC).toMatch(new RegExp(`_registerAlarm\\(\\s*'${name}'`));
    }
    expect(SRC).toMatch(/_registerAlarm\(\s*_STREAM_KEEPALIVE_ALARM/);
  });
});
