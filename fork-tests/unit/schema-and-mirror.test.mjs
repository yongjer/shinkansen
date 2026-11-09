import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  FORK_DEFAULTS, MAX_PROVIDERS, mergeForkSettings, sanitizeForkSettings, sanitizeSecrets, sanitizeProviderPrompts,
  resolvePresetSelection, newProviderId,
} from '../../shinkansen/fork/settings/schema.js';
import { sanitizeImport } from '../../shinkansen/options/import-sanitize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('fork 設定結構', () => {
  test('預設值不改變上游行為：三組預設都沿用原引擎、金鑰不進備份', () => {
    expect(FORK_DEFAULTS.presetEngines).toEqual({ 1: '', 2: '', 3: '' });
    expect(FORK_DEFAULTS.backup.includeKeys).toBe(false);
    expect(FORK_DEFAULTS.providers).toEqual([]);
    expect(mergeForkSettings(undefined)).toEqual(JSON.parse(JSON.stringify(FORK_DEFAULTS)));
  });

  test('消毒：不認識的欄位丟掉、不合法網址回報警告', () => {
    const { clean, warnings } = sanitizeForkSettings({
      evil: 1,
      presetEngines: { 1: 'deepl', 2: '<script>', 3: '' },
      mt: { sourceLang: 'xx', deeplx: { url: 'javascript:alert(1)' }, azure: { endpoint: 'not a url', region: 'eastasia' }, rateLimits: { deeplx: { rps: 999 }, bogus: { rps: 1 } } },
      backup: { webdav: { url: 'https://dav.test/', dir: '../../etc' } },
    });
    expect(clean).not.toHaveProperty('evil');
    expect(clean.presetEngines).toEqual({ 1: 'deepl', 2: '', 3: '' });
    expect(clean.mt.sourceLang).toBe('auto');
    expect(clean.mt.deeplx.url).toBe('');
    expect(clean.mt.azure).toEqual({ region: 'eastasia', endpoint: '' });
    expect(clean.mt.rateLimits).toEqual({ deeplx: { rps: 100, rpm: 0 } });
    expect(clean.backup.webdav.dir).toBe('ekiden');
    expect(warnings).toEqual(expect.arrayContaining(['presetEngines.2', 'mt.sourceLang', 'mt.deeplx.url', 'mt.azure.endpoint', 'backup.webdav.dir']));
    expect(sanitizeForkSettings({ backup: { webdav: { dir: 'a/./b' } } }).clean.backup.webdav.dir).toBe('ekiden');
    expect(sanitizeForkSettings({ backup: { webdav: { dir: '/apps/ekiden.v2/' } } }).clean.backup.webdav.dir).toBe('apps/ekiden.v2');
  });

  test('服務清單：最多 8 組、id 不重複、網址必須是 http(s)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, baseUrl: 'https://x.test/v1', model: 'm' }));
    expect(sanitizeForkSettings({ providers: many }).clean.providers).toHaveLength(MAX_PROVIDERS);
    const { clean, warnings } = sanitizeForkSettings({
      providers: [
        { id: 'a', baseUrl: 'https://ok.test', temperature: '', thinkingLevel: 'weird' },
        { id: 'a', baseUrl: 'https://dup.test' },
        { id: 'b', baseUrl: 'file:///etc/passwd' },
        { id: 'bad id!', baseUrl: 'https://x.test' },
      ],
    });
    expect(clean.providers).toEqual([expect.objectContaining({ id: 'a', temperature: null, thinkingLevel: 'off' })]);
    expect(warnings.filter((w) => w === 'providers')).toHaveLength(3);
    expect(newProviderId()).toMatch(/^p[a-z0-9]{10}$/i);
  });

  test('sanitizeSecrets / sanitizeProviderPrompts 只收已知欄位', () => {
    expect(sanitizeSecrets({ deeplKey: 'k', foo: 'bar', providerKeys: { ok: 'x', 'bad id': 'y', empty: '' } }))
      .toEqual({ deeplKey: 'k', providerKeys: { ok: 'x' } });
    expect(sanitizeProviderPrompts({ ok: 'p', n: 3 })).toEqual({ ok: 'p' });
  });

  test('上游設定匯入（import-sanitize）會經過 fork 規則', () => {
    const _t = (k, p) => `${k}:${JSON.stringify(p || {})}`;
    const { clean, warnings } = sanitizeImport({ fork: { presetEngines: { 3: 'microsoft-edge' }, mt: { deeplx: { url: 'nope' } } } }, _t, null);
    expect(clean.fork.presetEngines['3']).toBe('microsoft-edge');
    expect(clean.fork.mt.deeplx.url).toBe('');
    expect(warnings.some((w) => w.includes('fork.mt.deeplx.url'))).toBe(true);
  });
});

describe('翻譯預設對應', () => {
  const fork = mergeForkSettings({
    presetEngines: { 1: 'deepl', 2: 'p1', 3: 'google' },
    providers: [{ id: 'p1', label: 'My OR', baseUrl: 'https://or.test/v1', model: 'm' }],
  });

  test('背景端規則', () => {
    expect(resolvePresetSelection(fork, 1, 'google')).toEqual({ mtEngine: 'deepl' });
    expect(resolvePresetSelection(fork, 1, 'gemini')).toEqual({});
    expect(resolvePresetSelection(fork, 2, 'openai-compat')).toEqual({ modelOverride: 'fork-cp:p1', providerLabel: 'My OR' });
    expect(resolvePresetSelection(fork, 2, 'google')).toEqual({});
    expect(resolvePresetSelection(fork, 3, 'google')).toEqual({}); // 'google' = 原本的引擎
    expect(resolvePresetSelection(mergeForkSettings({}), 1, 'google')).toEqual({});
  });

  test('content script 的副本與 schema.js 規則逐案相同（mirror）', () => {
    const SK = {};
    const context = vm.createContext({
      window: { __SK: SK },
      browser: { storage: { sync: { get: async () => ({}) } }, runtime: { sendMessage: async () => ({}) } },
      console,
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'shinkansen/fork/content/ekiden-content.js'), 'utf8'), context);
    const contentRule = SK._forkResolvePresetSelection;
    expect(typeof contentRule).toBe('function');

    const forks = [
      fork,
      mergeForkSettings({}),
      mergeForkSettings({ presetEngines: { 1: 'free-chain', 2: 'chrome-translator', 3: 'azure' } }),
      mergeForkSettings({ presetEngines: { 1: 'unknown-engine', 2: 'p9', 3: 'deeplx' }, providers: [{ id: 'p9', baseUrl: 'https://a.test' }] }),
    ];
    for (const f of forks) {
      for (const slot of [1, 2, 3]) {
        for (const engine of ['google', 'gemini', 'openai-compat', undefined]) {
          // vm 內建立的物件原型不同，比對 JSON 形狀
          expect(JSON.parse(JSON.stringify(contentRule(f, slot, engine)))).toEqual(resolvePresetSelection(f, slot, engine));
        }
      }
    }
  });
});
