// 規則守門：原始碼掃描與 i18n 完整度
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORK_DIR = path.join(ROOT, 'shinkansen/fork');
const LANGS = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

const forkSources = walk(FORK_DIR).filter((p) => /\.(js|mjs|html)$/.test(p));

describe('原始碼規則', () => {
  test('fork 程式碼不把金鑰放進網址（Gemini 金鑰一律走 x-goog-api-key header）', () => {
    const offenders = [];
    for (const f of forkSources) {
      const src = fs.readFileSync(f, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return; // 註解
        if (/[?&](key|api_key|apikey|access_token|auth_key)=/i.test(line)
            || /searchParams\.(set|append)\(\s*['"](key|api_key|apikey|auth_key)['"]/i.test(line)) {
          offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('fork 程式碼不連到任何內建的第三方預設端點以外的主機（DeepLX 沒有預設網址）', () => {
    const allowedHosts = new Set([
      'edge.microsoft.com', 'api-edge.cognitive.microsofttranslator.com', 'api.cognitive.microsofttranslator.com',
      'api.deepl.com', 'api-free.deepl.com', 'www.googleapis.com', 'accounts.google.com',
      // 說明文字與連結（不是請求目標）
      'github.com', 'console.cloud.google.com', 'developers.google.com', 'developers.deepl.com', 'learn.microsoft.com',
      // 範例 placeholder
      'deeplx.example.com', 'cloud.example.com', 'dav.jianguoyun.com',
      // 渲染 / 文件來源
      'ai.google.dev', 'abc.chromiumapp.org',
      // Gemini（上游已有的主機；語音與 AI 閱讀卡沿用）
      'generativelanguage.googleapis.com',
    ]);
    const unexpected = new Set();
    for (const f of forkSources) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        const host = m[1].toLowerCase();
        if (!allowedHosts.has(host)) unexpected.add(`${host} (${path.relative(ROOT, f)})`);
      }
    }
    expect([...unexpected]).toEqual([]);
  });

  test('manifest 沒有移除上游權限；fork 只新增 optional identity、contextMenus 與 6 個翻譯 / 備份主機', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'shinkansen/manifest.json'), 'utf8'));
    expect(manifest.optional_permissions).toEqual(['identity']);
    expect(manifest.permissions).not.toContain('identity');
    for (const h of [
      'https://api.deepl.com/*', 'https://api-free.deepl.com/*', 'https://edge.microsoft.com/*',
      'https://api-edge.cognitive.microsofttranslator.com/*', 'https://api.cognitive.microsofttranslator.com/*', 'https://www.googleapis.com/*',
    ]) {
      expect(manifest.host_permissions).toContain(h);
    }
    const mainScripts = manifest.content_scripts.find((c) => c.js.includes('content.js')).js;
    expect(mainScripts.slice(-5)).toEqual([
      'fork/i18n/fork-strings.js', 'fork/i18n/study-strings.js', 'fork/content/ekiden-content.js',
      'fork/content/paragraph-tools.js', 'fork/content/study-card.js',
    ]);
    // 上游的三個權限都在；第 2 階段只加 contextMenus（安裝時不會跳出權限警告）
    expect(manifest.permissions).toEqual(['storage', 'alarms', 'webNavigation', 'contextMenus']);
  });

  test('版號必須是三段：四段會被上游當成開發版，對所有網頁開放 Debug Bridge（FORK-NOTES §5.1）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'shinkansen/manifest.json'), 'utf8'));
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version_name).toBeUndefined();
    // 第三段 = 上游 patch × 100 + fork 建置號（1–99）
    expect(Number(manifest.version.split('.')[2]) % 100).toBeGreaterThan(0);
    // CHANGELOG 的 fork 區段最上面一條就是目前版本
    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const forkSection = changelog.slice(changelog.indexOf('## 驛傳 Ekiden（fork）'));
    expect(forkSection.match(/^\*\*v(\d+\.\d+\.\d+)\*\*/m)?.[1]).toBe(manifest.version);
  });

  test('擴充功能名稱與描述不再使用 Shinkansen', () => {
    for (const dir of fs.readdirSync(path.join(ROOT, 'shinkansen/_locales'))) {
      const msgs = JSON.parse(fs.readFileSync(path.join(ROOT, 'shinkansen/_locales', dir, 'messages.json'), 'utf8'));
      for (const key of ['extName', 'extDescription', 'actionTitle']) {
        expect(msgs[key].message).not.toMatch(/shinkansen|新幹線/i);
      }
      expect(msgs.extDescription.message.length).toBeLessThanOrEqual(132);
    }
  });

  test('上游授權檔仍在且未修改（ELv2 原文）', () => {
    const license = fs.readFileSync(path.join(ROOT, 'LICENSE'));
    expect(license.toString('utf8')).toMatch(/Elastic License 2\.0/);
    // 上游 4ebf220 的 LICENSE 雜湊；這個檔案不得修改
    expect(crypto.createHash('sha256').update(license).digest('hex'))
      .toBe('dc0c985858617bb914ce43ed8d37747f42de2eec005f6e4217a7ea239ad63a96');
    // 上游的第三方授權聲明只能追加，不能刪
    expect(fs.existsSync(path.join(ROOT, 'shinkansen/THIRD-PARTY-NOTICES.md'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'shinkansen/lib/readability.LICENSE'))).toBe(true);
  });
});

describe('i18n 完整度', () => {
  function loadTables(files) {
    const win = { __SK: {} };
    const context = vm.createContext({ window: win, globalThis: undefined, navigator: { language: 'en' }, console });
    context.globalThis = context;
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'shinkansen', f), 'utf8'), context);
    return win.__SK.i18n._tables;
  }

  test('fork 字串 8 種語言的 key 完全一致', () => {
    const tables = loadTables(['lib/i18n.js', 'fork/i18n/fork-i18n.js', 'fork/i18n/fork-strings.js', 'fork/i18n/study-strings.js', 'fork/i18n/settings-strings.js', 'fork/i18n/settings-study-strings.js']);
    const keysOf = (l) => Object.keys(tables[l]).filter((k) => k.startsWith('fork.') || k.startsWith('error.bg.fork')).sort();
    const base = keysOf('zh-TW');
    expect(base.length).toBeGreaterThan(100);
    for (const l of LANGS) expect(keysOf(l)).toEqual(base);
  });

  test('content script 的 i18n 子集也能載入 fork 字串', () => {
    const tables = loadTables(['lib/i18n-content.js', 'fork/i18n/fork-strings.js', 'fork/i18n/study-strings.js']);
    for (const l of LANGS) {
      expect(tables[l]['fork.toast.mtDone']).toContain('{engine}');
      expect(tables[l]['error.bg.forkChainAllFailed']).toContain('{detail}');
      expect(typeof tables[l]['fork.engine.freeChain']).toBe('string');
      expect(typeof tables[l]['fork.card.speak']).toBe('string');
      expect(tables[l]['error.bg.forkTtsHttp']).toContain('{status}');
    }
  });

  test('設定頁用到的 key 都存在', () => {
    const tables = loadTables(['lib/i18n.js', 'fork/i18n/fork-i18n.js', 'fork/i18n/fork-strings.js', 'fork/i18n/study-strings.js', 'fork/i18n/settings-strings.js', 'fork/i18n/settings-study-strings.js']);
    const used = new Set();
    for (const f of ['fork/pages/settings.html', 'fork/pages/settings.js']) {
      const s = fs.readFileSync(path.join(ROOT, 'shinkansen', f), 'utf8');
      for (const m of s.matchAll(/['"`]((?:fork|options)\.[A-Za-z0-9_.-]+[A-Za-z0-9])['"`]/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !LANGS.every((l) => Object.prototype.hasOwnProperty.call(tables[l], k)));
    expect(missing).toEqual([]);
  });

  test('fork 程式碼裡 SK.t / _t / i18n.t 的字面 key 都存在（上游 i18n-key-references 測試的 fork 版）', () => {
    const tables = loadTables(['lib/i18n.js', 'fork/i18n/fork-i18n.js', 'fork/i18n/fork-strings.js', 'fork/i18n/study-strings.js', 'fork/i18n/settings-strings.js', 'fork/i18n/settings-study-strings.js']);
    const refs = [];
    for (const f of forkSources.filter((p) => p.endsWith('.js'))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:SK\.t|_t|i18n\.t)\(\s*'([^']+)'/g)) refs.push({ file: path.relative(ROOT, f), key: m[1] });
    }
    expect(refs.length).toBeGreaterThan(30);
    expect(refs.filter((r) => !Object.prototype.hasOwnProperty.call(tables['zh-TW'], r.key))).toEqual([]);
  });

  test('品牌改名不動到授權區塊字串', () => {
    const tables = loadTables(['lib/i18n.js', 'fork/i18n/fork-i18n.js']);
    const licenseKeys = Object.keys(tables['zh-TW']).filter((k) => k.startsWith('options.license.'));
    expect(licenseKeys.length).toBeGreaterThan(0);
    const raw = loadTables(['lib/i18n.js']);
    for (const k of licenseKeys) expect(tables['zh-TW'][k]).toBe(raw['zh-TW'][k]);
    const other = Object.entries(tables.en).filter(([k, v]) => !k.startsWith('options.license.') && typeof v === 'string' && v.includes('Shinkansen') && !k.startsWith('fork.') && k !== 'options.intro.html');
    expect(other).toEqual([]);
  });
});
