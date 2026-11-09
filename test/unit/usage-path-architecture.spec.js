// Unit test: 用量紀錄 path 合一 architecture invariants(v1.9.1)
//
// 對應 PENDING_REGRESSION.md 條目「popup 累計費用 = IndexedDB usage stats」。
// 過去 popup 累計費用走 storage.local['usageStats'] grand total,options 用量明細
// 走 IndexedDB,兩條 path drift 導致清紀錄後 popup 仍顯示舊值 + glossary 用量
// 漏算。v1.9.1 拔掉 usageStats path,popup 改 QUERY_USAGE_STATS 讀 IndexedDB。
//
// 本檔做 static check 鎖死 architecture invariant —— 確保未來不會有人不小心
// 把舊 path 加回去,讓 drift bug 重現。
//
// 驗證內容:
//   - background.js 不再有 USAGE_STATS / RESET_USAGE message handler
//   - background.js 不再定義 addUsage / getUsageStats / resetUsageStats 函式
//   - background.js 不再用 USAGE_KEY 常數 / 不再 .set('usageStats') 寫累計值
//   - QUERY_USAGE_STATS handler 仍存在(popup ↔ options 同源來源)
//   - popup.js 送 QUERY_USAGE_STATS 而非 USAGE_STATS
//   - popup.js 讀 stats.totalBilledCostUSD 而非舊 resp.totalCostUSD
//
// SANITY 紀錄(已驗證):暫時把 USAGE_STATS handler 加回 background.js,對應
// spec fail;還原後全綠。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

test.describe('background.js: usageStats path 已拔除', () => {
  const bg = readFile('shinkansen/background.js');

  test('不含 USAGE_STATS message handler(被 QUERY_USAGE_STATS 取代)', () => {
    // 抓 message router 內 `USAGE_STATS:` 的 handler 物件起頭(不會誤抓 'QUERY_USAGE_STATS:'
    // 因為 \b 字界要求 USAGE_STATS 前面是非單字字元,QUERY_ 結尾的 R 是單字字元 → 不命中)
    expect(bg).not.toMatch(/\bUSAGE_STATS:\s*\{/);
  });

  test('不含 RESET_USAGE message handler', () => {
    expect(bg).not.toMatch(/\bRESET_USAGE:\s*\{/);
  });

  test('不再定義 addUsage 函式(累計寫入入口)', () => {
    expect(bg).not.toMatch(/(?:async\s+)?function\s+addUsage\b/);
  });

  test('不再定義 getUsageStats 函式(累計讀取入口)', () => {
    expect(bg).not.toMatch(/(?:async\s+)?function\s+getUsageStats\b/);
  });

  test('不再定義 resetUsageStats 函式(累計重置入口)', () => {
    expect(bg).not.toMatch(/(?:async\s+)?function\s+resetUsageStats\b/);
  });

  test('不再有 USAGE_KEY 常數(過去指向 \'usageStats\')', () => {
    expect(bg).not.toMatch(/const\s+USAGE_KEY\s*=/);
  });

  test('不再有 storage.local.set 寫入 usageStats 累計值', () => {
    // 一次性 cleanup 用 storage.local.remove('usageStats') 是可接受的(殘餘清理)
    // 但 .set 寫入累計欄位是 forbidden(會重新引入 drift)
    const setUsageStatsRegex = /storage\.local\.set\s*\(\s*\{\s*\[?\s*['"]?usageStats['"]?\s*\]?\s*:/;
    expect(bg).not.toMatch(setUsageStatsRegex);
  });
});

test.describe('background.js: QUERY_USAGE_STATS 仍是 popup ↔ options 同源來源', () => {
  const bg = readFile('shinkansen/background.js');

  test('QUERY_USAGE_STATS handler 存在', () => {
    expect(bg).toMatch(/\bQUERY_USAGE_STATS:\s*\{/);
  });

  test('handler 走 usageDB.getStats(IndexedDB getStats)', () => {
    // 確認 handler body 內呼叫 usageDB.getStats,不是讀 storage.local
    const handlerSection = bg.match(/QUERY_USAGE_STATS:\s*\{[\s\S]*?\},/);
    expect(handlerSection).not.toBeNull();
    expect(handlerSection[0]).toMatch(/usageDB\.getStats/);
  });
});

test.describe('popup.js: 改用 QUERY_USAGE_STATS 讀 IndexedDB', () => {
  const popup = readFile('shinkansen/popup/popup.js');

  test('送 QUERY_USAGE_STATS message', () => {
    expect(popup).toMatch(/type:\s*['"]QUERY_USAGE_STATS['"]/);
  });

  test('不送舊的 USAGE_STATS message', () => {
    expect(popup).not.toMatch(/type:\s*['"]USAGE_STATS['"]/);
  });

  test('讀 stats.totalBilledCostUSD(IndexedDB getStats schema)', () => {
    // QUERY_USAGE_STATS handler 回 { ok, stats: { totalBilledCostUSD, ... } }
    expect(popup).toMatch(/totalBilledCostUSD/);
  });

  test('不再讀舊版 resp.totalCostUSD top-level 欄位', () => {
    expect(popup).not.toMatch(/resp\.totalCostUSD\b/);
  });
});
