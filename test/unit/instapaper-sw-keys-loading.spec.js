// Regression（源碼結構 forcing function）：background.js 載 Instapaper consumer 金鑰
// 不可用 dynamic import()。
//
// Bug：「popup 送得出去、Alt+I 快捷鍵一定失敗」。根因——background.js 原本用
// `await import('./lib/instapaper-keys.js')` 載金鑰，但 MV3 service worker 禁止
// dynamic import（實測 throw "import() is disallowed on ServiceWorkerGlobalScope"），
// 且該 throw 被 try/catch 靜默吞掉 → 金鑰永遠載不進 SW → saveToInstapaper 回 CONFIG
// → 快捷鍵恆失敗。popup 走 classic <script> 載金鑰故正常。
//
// 修法：SW 改用 fetch 自家檔案 + regex 抽金鑰（SW 可 fetch 自己打包的資源）。
//
// 本 spec 鎖死「不可回退成 dynamic import」——因為失敗是靜默的（被 catch），沒有
// forcing function 容易又被「簡化」回 import() 而悄悄壞掉。
//
// SANITY 紀錄（已驗證）：把 background.js 改回 `await import('./lib/instapaper-keys.js')`
// → 第一條斷言（不得含 dynamic import）fail → 還原後 pass。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bg = readFileSync(join(__dirname, '../../shinkansen/background.js'), 'utf8');

test('background.js 不得用 dynamic import() 載 instapaper-keys（SW 禁用）', () => {
  expect(bg).not.toMatch(/import\s*\(\s*['"][^'"]*instapaper-keys/);
});

test('background.js 改用 fetch(runtime.getURL) 載 instapaper-keys', () => {
  expect(bg).toMatch(/getURL\(\s*['"]lib\/instapaper-keys\.js['"]\s*\)/);
  // fetch + 設定 globalThis.__SK.INSTAPAPER_KEYS（讓 getInstapaperConsumerKeys 讀到）
  expect(bg).toContain('INSTAPAPER_KEYS');
  expect(bg).toMatch(/fetch\(/);
});
