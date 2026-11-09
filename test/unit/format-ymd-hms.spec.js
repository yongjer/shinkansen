// Unit test: lib/format.js formatYmdHms（issue #54）
//
// 原 bug：options.js 的「匯出設定」（shinkansen-settings-）與「匯出 JSON」
// （shinkansen-log-）兩個按鈕都用
//   `new Date().toISOString().slice(0, 19).replace(...)` 產生檔名時間戳。
// toISOString() 永遠回傳 UTC，台灣（UTC+8）使用者看到的檔名時間會比實際
// 早 8 小時（本地早上 6 點匯出 → 檔名卻是前一天晚上 10 點）。
//
// 修法：抽 formatYmdHms(ts) 到 lib/format.js，改用本地時區
// （getFullYear/getHours... 系列），兩個按鈕共用同一支 helper。
// 接受 ms timestamp 參數 → 純函式可在 Node 直接 import 驗，且能跨時區斷言。
//
// SANITY 已驗（2026-06-01）：把 formatYmdHms body 改回
//   `new Date(ts).toISOString().slice(0,19).replace(/[-:]/g,'').replace('T','-')`
// → 「本地時區（非 UTC）」與「UTC+8 跨日」兩個 test fail。還原後全 pass。

import { test, expect } from '@playwright/test';
import { formatYmdHms } from '../../shinkansen/lib/format.js';

test.describe('formatYmdHms', () => {
  test('格式為 YYYYMMDD-HHMMSS', () => {
    const ts = new Date(2026, 3, 28, 9, 5, 3).getTime(); // 2026-04-28 09:05:03 本地
    expect(formatYmdHms(ts)).toBe('20260428-090503');
  });

  test('月 / 日 / 時 / 分 / 秒全部補零', () => {
    const ts = new Date(2026, 0, 5, 1, 2, 7).getTime(); // 2026-01-05 01:02:07 本地
    expect(formatYmdHms(ts)).toBe('20260105-010207');
  });

  test('跨年邊界（午夜前一秒）', () => {
    const ts = new Date(2025, 11, 31, 23, 59, 59).getTime(); // 2025-12-31 23:59:59 本地
    expect(formatYmdHms(ts)).toBe('20251231-235959');
  });

  test('用本地時區，不是 UTC（核心 issue #54 斷言）', () => {
    // 用本地建構子 new Date(y, m, d, h, ...) 取的就是本地時間欄位；
    // formatYmdHms 必須原封不動印出這些本地欄位，不可被轉成 UTC。
    const ts = new Date(2026, 5, 1, 6, 0, 0).getTime(); // 2026-06-01 06:00:00 本地
    const result = formatYmdHms(ts);
    expect(result).toBe('20260601-060000');

    // 反證：若 helper 誤用 toISOString()，非 UTC 機器上日期 / 時分秒會偏移，
    // 結果不會等於本地欄位組出來的字串。
    const localExpected =
      `${ts && new Date(ts).getFullYear()}` +
      String(new Date(ts).getMonth() + 1).padStart(2, '0') +
      String(new Date(ts).getDate()).padStart(2, '0') + '-' +
      String(new Date(ts).getHours()).padStart(2, '0') +
      String(new Date(ts).getMinutes()).padStart(2, '0') +
      String(new Date(ts).getSeconds()).padStart(2, '0');
    expect(result).toBe(localExpected);
  });

  test('UTC+8 凌晨時段不會掉回 UTC 前一天（台灣使用者場景）', () => {
    // 2026-06-01 02:30:00 在 UTC+8 → UTC 是 2025-05-31 18:30，
    // 若誤用 toISOString() 檔名會變成 5 月 31 日。本地 helper 必須維持 6 月 1 日。
    const ts = new Date(2026, 5, 1, 2, 30, 0).getTime();
    const result = formatYmdHms(ts);
    // 斷言「日期部分等於本地的年月日」，與機器時區無關（CI 任何時區都成立）。
    const d = new Date(ts);
    const localDate =
      `${d.getFullYear()}` +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
    expect(result.slice(0, 8)).toBe(localDate);
  });

  test('不依賴任何 DOM（純函式）— 可在 Node 環境直接執行', () => {
    const filename = `shinkansen-settings-${formatYmdHms(Date.now())}.json`;
    expect(filename).toMatch(/^shinkansen-settings-\d{8}-\d{6}\.json$/);
  });
});
