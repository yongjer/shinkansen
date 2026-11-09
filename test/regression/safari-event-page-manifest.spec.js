// Regression: Safari build manifest background → event page(2026-06-07)
//
// 根因:iOS Safari 的 MV3 background service worker 被系統回收後**不再喚醒**
// (Apple Developer Forums thread 758346;iOS 17.4 起迄今未修)——SW 死後
// content / popup 的 runtime 訊息石沉大海,「用一段時間後四指 / popup 失效,
// 強制關閉 Safari 才復原」。Safari 對 event page(scripts + persistent: false)
// 的生命週期管理正常;WebKit 原始碼(WebExtension.cpp generatedBackgroundContent)
// 證實 scripts 形式照樣吃 type: "module",16 個 static import 不需 bundle。
//
// 修法:safari-app/patch-manifest-background.sh(macOS / iOS build 共用)把
// Safari build 的 manifest background 從 service_worker 改宣告 event page;
// Chrome 版 manifest(shinkansen/)維持 service_worker 不動。
//
// 本 spec 鎖的訊號層次(CLAUDE.md 工作流原則 3):
//   驗「patch script 實際執行後的 manifest 形式(event page + type module 保留
//   + 其餘欄位不動 + 冪等)」與「兩個 build script 有接 patch + drift check
//   排除受控差異」這兩層。
//   不驗:真實 iOS Safari 對 event page 的 lifecycle 行為(只能 TestFlight
//   實機放置驗收)、xcodebuild archive 鏈(spec 不該動到)。
//
// SANITY CHECK 紀錄(已驗證,2026-06-07):
//   暫時把 patch-manifest-background.sh 的 jq 改成不刪 service_worker →
//   「執行後必須是 event page 形式」case fail;還原後全綠。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PATCH_SH = path.join(ROOT, 'safari-app', 'patch-manifest-background.sh');
const IOS_SH = path.join(ROOT, 'safari-app', 'safari-build-ios.sh');
const MAC_SH = path.join(ROOT, 'safari-app', 'safari-build.sh');
const SRC_MANIFEST = path.join(ROOT, 'shinkansen', 'manifest.json');

test.describe('patch-manifest-background.sh', () => {
  test('存在且 executable', () => {
    expect(fs.existsSync(PATCH_SH)).toBe(true);
    expect(fs.statSync(PATCH_SH).mode & 0o111).toBeTruthy();
  });

  test('執行後必須是 event page 形式:scripts + persistent:false、保留 type:module、其餘欄位不動、冪等', () => {
    const tmp = path.join(os.tmpdir(), `sk-manifest-spec-${process.pid}.json`);
    fs.copyFileSync(SRC_MANIFEST, tmp);
    try {
      execFileSync('bash', [PATCH_SH, tmp]);
      const src = JSON.parse(fs.readFileSync(SRC_MANIFEST, 'utf8'));
      const patched = JSON.parse(fs.readFileSync(tmp, 'utf8'));

      // event page 形式
      expect(patched.background.scripts).toEqual([src.background.service_worker]);
      expect(patched.background.persistent).toBe(false);
      expect(patched.background.service_worker).toBeUndefined();
      // type: module 必須保留——background.js 有 16 個 static import,
      // 丟掉 type 會 'Cannot use import statement outside a module' 整個炸掉
      expect(patched.background.type).toBe('module');
      // background 以外欄位不可動
      const stripBg = (m) => { const c = { ...m }; delete c.background; return c; };
      expect(stripBg(patched)).toEqual(stripBg(src));

      // 冪等:再跑一次不可壞掉(scripts: [null] 之類)
      execFileSync('bash', [PATCH_SH, tmp]);
      const again = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      expect(again).toEqual(patched);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('Chrome 版 manifest(shinkansen/)必須維持 service_worker 不動', () => {
    const src = JSON.parse(fs.readFileSync(SRC_MANIFEST, 'utf8'));
    expect(src.background.service_worker).toBe('background.js');
    expect(src.background.scripts).toBeUndefined();
  });
});

test.describe('build script 接線', () => {
  test('safari-build-ios.sh:staging 後、rsync 進 Resources 前必須 patch', () => {
    const sh = fs.readFileSync(IOS_SH, 'utf8');
    const stagingIdx = sh.indexOf("rsync -a --exclude 'translate-doc/'");
    const patchIdx = sh.indexOf('patch-manifest-background.sh');
    const resourcesIdx = sh.indexOf('rsync -a --delete "$STAGING/"');
    expect(stagingIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(stagingIdx);
    expect(resourcesIdx).toBeGreaterThan(patchIdx);
  });

  test('safari-build.sh(macOS):rsync 後 patch + drift check 排除 manifest + 事後 verify', () => {
    const sh = fs.readFileSync(MAC_SH, 'utf8');
    const calls = sh.match(/patch-manifest-background\.sh/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2); // patch + drift 後 verify
    // drift check 必須排除 manifest.json(受控差異),否則 patch 後必炸 drift
    expect(sh).toMatch(/grep -vE "[^"]*manifest\\\.json[^"]*"/);
  });
});
