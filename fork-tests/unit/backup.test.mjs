import { encryptJson, decryptJson, utf8ToBase64, KDF_ITERATIONS } from '../../shinkansen/fork/backup/crypto.js';
import {
  buildBackup, parseBackup, restoreBackup, summarizeBackup, BACKUP_FORMAT,
} from '../../shinkansen/fork/backup/backup-core.js';
import { createWebdavClient } from '../../shinkansen/fork/backup/webdav.js';
import { buildAuthUrl, parseAuthRedirect, createDriveClient, DRIVE_SCOPE } from '../../shinkansen/fork/backup/gdrive.js';
import { sanitizeImport } from '../../shinkansen/options/import-sanitize.js';
import { splitSettingsPatch, LOCAL_SETTINGS_KEYS } from '../../shinkansen/lib/storage.js';
import { createFakeStorage } from '../helpers/fake-storage.mjs';
import { createMockFetch, jsonResponse, textResponse, headerOf } from '../helpers/mock-fetch.mjs';

// 測試用較少的迭代次數（正式為 31 萬次），只驗證格式與流程
const FAST = { iterations: 100_000 };

describe('金鑰加密（AES-GCM + PBKDF2）', () => {
  test('加密後可用同一密語解開；信封不含明文', async () => {
    const env = await encryptJson({ apiKey: 'AIza-SECRET' }, 'correct horse', FAST);
    expect(env).toMatchObject({ alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: 100_000 });
    expect(JSON.stringify(env)).not.toContain('AIza-SECRET');
    expect(await decryptJson(env, 'correct horse')).toEqual({ apiKey: 'AIza-SECRET' });
  });

  test('密語錯誤 → badPassphrase；密語太短拒絕加密', async () => {
    const env = await encryptJson({ a: 1 }, 'correct horse', FAST);
    await expect(decryptJson(env, 'wrong horse')).rejects.toMatchObject({ code: 'badPassphrase' });
    await expect(encryptJson({ a: 1 }, 'short')).rejects.toThrow();
  });

  test('拒絕迭代次數異常的信封（避免被惡意檔案拖垮或降級）', async () => {
    const env = await encryptJson({ a: 1 }, 'correct horse', FAST);
    await expect(decryptJson({ ...env, iter: 10 }, 'correct horse')).rejects.toThrow('bad iteration count');
    await expect(decryptJson({ ...env, alg: 'none' }, 'correct horse')).rejects.toThrow('unsupported envelope');
  });

  test('正式迭代次數 ≥ 310,000', () => {
    expect(KDF_ITERATIONS).toBeGreaterThanOrEqual(310_000);
  });
});

function sanitize(raw) {
  return sanitizeImport(raw, (k, p) => `${k}${p ? JSON.stringify(p) : ''}`, null);
}

function baseStorage() {
  return createFakeStorage({
    sync: {
      apiKey: 'should-never-be-in-sync-but-strip-anyway',
      targetLanguage: 'ja',
      instapaperUsername: 'me@example.com',
      customProvider: { baseUrl: 'https://old.test/v1', model: 'm' },
      fork: { providers: [{ id: 'p1', label: 'A', baseUrl: 'https://p1.test/v1', model: 'x' }], mt: { deeplx: { url: 'https://dx.test/' } } },
    },
    local: {
      apiKey: 'GEMINI-KEY',
      customProviderApiKey: 'CP-KEY',
      fixedGlossary: { global: [{ source: 'a', target: 'b' }], byDomain: {} },
      forkSecrets: { deeplKey: 'DL', deeplxToken: 'DX', webdavPassword: 'DAVPW', providerKeys: { p1: 'P1KEY' } },
      forkProviderPrompts: { p1: 'my prompt' },
      instapaperToken: 'tok',
    },
  });
}

describe('備份檔產生', () => {
  test('預設不含任何金鑰、Instapaper 帳號與 WebDAV 密碼', async () => {
    const storage = baseStorage();
    const data = await buildBackup({ storage, localSettingsKeys: LOCAL_SETTINGS_KEYS }, { extVersion: '2.6.401', now: 0 });
    const text = JSON.stringify(data);
    for (const secret of ['GEMINI-KEY', 'CP-KEY', 'DL', 'DX', 'DAVPW', 'P1KEY', 'me@example.com', 'should-never']) {
      expect(text).not.toContain(secret);
    }
    expect(data).toMatchObject({ format: BACKUP_FORMAT, version: 1, extVersion: '2.6.401', secrets: null });
    expect(data.settings.targetLanguage).toBe('ja');
    expect(data.settings.fixedGlossary.global).toHaveLength(1); // local 的固定術語表也在備份裡
    expect(data.forkLocal.providerPrompts).toEqual({ p1: 'my prompt' });
  });

  test('勾選包含金鑰：沒有密語拒絕；有密語時金鑰加密放入，WebDAV 密碼仍排除', async () => {
    const storage = baseStorage();
    const deps = { storage, localSettingsKeys: LOCAL_SETTINGS_KEYS };
    await expect(buildBackup(deps, { includeKeys: true, passphrase: '' })).rejects.toMatchObject({ code: 'passphraseRequired' });
    const data = await buildBackup(deps, { includeKeys: true, passphrase: 'long passphrase' });
    expect(JSON.stringify(data)).not.toContain('GEMINI-KEY');
    const secrets = await decryptJson(data.secrets, 'long passphrase');
    expect(secrets).toEqual({
      apiKey: 'GEMINI-KEY',
      customProviderApiKey: 'CP-KEY',
      forkSecrets: { deeplKey: 'DL', deeplxToken: 'DX', providerKeys: { p1: 'P1KEY' } },
    });
  }, 30_000);

  test('parseBackup 檢查格式與版本；summarizeBackup', async () => {
    expect(() => parseBackup('{')).toThrow(expect.objectContaining({ code: 'notJson' }));
    expect(() => parseBackup('{"targetLanguage":"ja"}')).toThrow(expect.objectContaining({ code: 'notBackup' }));
    expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99, settings: {} }))).toThrow(expect.objectContaining({ code: 'newerVersion' }));
    const data = await buildBackup({ storage: baseStorage(), localSettingsKeys: LOCAL_SETTINGS_KEYS }, { now: 0 });
    expect(summarizeBackup(parseBackup(JSON.stringify(data)))).toMatchObject({ providers: 1, hasSecrets: false });
  });
});

describe('備份還原', () => {
  const deps = (storage) => ({ storage, sanitizeImport: sanitize, splitSettingsPatch });

  test('還原設定經過上游消毒；不認識的欄位丟掉；固定術語表寫回 local', async () => {
    const storage = createFakeStorage();
    const backup = {
      format: BACKUP_FORMAT, version: 1,
      settings: { targetLanguage: 'ko', notARealSetting: 1, apiKey: 'SNEAKY', fixedGlossary: { global: [{ source: 'x', target: 'y' }], byDomain: {} } },
      forkLocal: { providerPrompts: { p1: 'hi' } },
      secrets: null,
    };
    const r = await restoreBackup(backup, deps(storage));
    expect(r.restoredKeys).toBe(false);
    const sync = storage.sync.dump();
    const local = storage.local.dump();
    expect(sync.targetLanguage).toBe('ko');
    expect(sync).not.toHaveProperty('notARealSetting');
    expect(sync).not.toHaveProperty('apiKey');
    expect(local).not.toHaveProperty('apiKey');
    expect(local.fixedGlossary.global[0]).toMatchObject({ source: 'x', target: 'y' });
    expect(local.forkProviderPrompts).toEqual({ p1: 'hi' });
  });

  test('沒有還原金鑰而服務網址換了網域 → 清掉該服務的舊金鑰（避免把金鑰送到別台主機）', async () => {
    const storage = baseStorage();
    const backup = {
      format: BACKUP_FORMAT, version: 1,
      settings: {
        customProvider: { baseUrl: 'https://attacker.test/v1', model: 'm' },
        fork: { providers: [{ id: 'p1', baseUrl: 'https://evil.test/v1', model: 'x' }], mt: { deeplx: { url: 'https://dx.test/other' } } },
      },
      secrets: null,
    };
    const r = await restoreBackup(backup, deps(storage));
    expect(r.clearedKeys).toEqual(expect.arrayContaining(['customProvider', 'provider:p1']));
    expect(r.clearedKeys).not.toContain('deeplx'); // 同網域不清
    const local = storage.local.dump();
    expect(local).not.toHaveProperty('customProviderApiKey');
    expect(local.forkSecrets.providerKeys).toEqual({});
    expect(local.forkSecrets.deeplxToken).toBe('DX');
    expect(local.apiKey).toBe('GEMINI-KEY');
  });

  test('一併還原金鑰：密語正確才寫入；保留本機 WebDAV 密碼', async () => {
    const source = baseStorage();
    const data = await buildBackup({ storage: source, localSettingsKeys: LOCAL_SETTINGS_KEYS }, { includeKeys: true, passphrase: 'long passphrase' });
    const target = createFakeStorage({ local: { forkSecrets: { webdavPassword: 'LOCAL-DAV' } } });
    await expect(restoreBackup(data, deps(target), { restoreKeys: true, passphrase: 'nope nope' })).rejects.toMatchObject({ code: 'badPassphrase' });
    expect(target.sync.dump()).toEqual({}); // 密語錯誤時什麼都不寫
    const r = await restoreBackup(data, deps(target), { restoreKeys: true, passphrase: 'long passphrase' });
    expect(r.restoredKeys).toBe(true);
    const local = target.local.dump();
    expect(local.apiKey).toBe('GEMINI-KEY');
    expect(local.customProviderApiKey).toBe('CP-KEY');
    expect(local.forkSecrets).toEqual({ deeplKey: 'DL', deeplxToken: 'DX', providerKeys: { p1: 'P1KEY' }, webdavPassword: 'LOCAL-DAV' });
  }, 30_000);
});

describe('WebDAV', () => {
  const BASE = 'https://dav.test/remote.php/dav/files/me';

  test('Basic 驗證、逐層 MKCOL、PUT 備份檔', async () => {
    const { fetchImpl, calls } = createMockFetch([
      { match: (u, i) => i.method === 'MKCOL', respond: () => textResponse('', { status: 405 }) },
      { match: (u, i) => i.method === 'PUT', respond: () => textResponse('', { status: 201, headers: { ETag: '"v1"' } }) },
    ]);
    const c = createWebdavClient({ url: BASE, username: 'me', password: 'pä55', dir: 'apps/ekiden', fetchImpl });
    expect(c.folder).toBe(`${BASE}/apps/ekiden/`);
    const r = await c.put('ekiden-backup.json', '{}');
    expect(r.etag).toBe('"v1"');
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      `MKCOL ${BASE}/apps/`,
      `MKCOL ${BASE}/apps/ekiden/`,
      `PUT ${BASE}/apps/ekiden/ekiden-backup.json`,
    ]);
    expect(headerOf(calls[2].init, 'Authorization')).toBe(`Basic ${utf8ToBase64('me:pä55')}`);
    expect(calls[2].init.credentials).toBe('omit');
  });

  test('401 → auth；412 → conflict；GET 404 → null；網址不合法 → badUrl', async () => {
    const auth = createWebdavClient({ url: BASE, fetchImpl: createMockFetch([{ match: /./, respond: () => textResponse('', { status: 401 }) }]).fetchImpl });
    await expect(auth.test()).rejects.toMatchObject({ code: 'auth', status: 401 });

    const conflict = createWebdavClient({
      url: BASE,
      fetchImpl: createMockFetch([
        { match: (u, i) => i.method === 'MKCOL', respond: () => textResponse('', { status: 201 }) },
        { match: (u, i) => i.method === 'PUT', respond: () => textResponse('', { status: 412 }) },
      ]).fetchImpl,
    });
    await expect(conflict.put('f.json', '{}', { ifMatch: '"old"' })).rejects.toMatchObject({ code: 'conflict' });

    const missing = createWebdavClient({ url: BASE, fetchImpl: createMockFetch([{ match: /./, respond: () => textResponse('', { status: 404 }) }]).fetchImpl });
    expect(await missing.get('f.json')).toBeNull();

    expect(() => createWebdavClient({ url: 'javascript:alert(1)' })).toThrow(expect.objectContaining({ code: 'badUrl' }));
    expect(() => createWebdavClient({ url: BASE, dir: '../../other-user' })).toThrow(expect.objectContaining({ code: 'badUrl' }));
  });

  test('連線測試：PROPFIND Depth 0 + 建立資料夾', async () => {
    const { fetchImpl, calls } = createMockFetch([
      { match: (u, i) => i.method === 'PROPFIND', respond: () => textResponse('<multistatus/>', { status: 207 }) },
      { match: (u, i) => i.method === 'MKCOL', respond: () => textResponse('', { status: 201 }) },
    ]);
    await createWebdavClient({ url: BASE, fetchImpl }).test();
    expect(headerOf(calls[0].init, 'Depth')).toBe('0');
  });
});

describe('Google Drive（選用）', () => {
  test('授權網址只要求 drive.appdata，不含任何內建用戶端 ID', () => {
    const u = new URL(buildAuthUrl('USER-CLIENT', 'https://abc.chromiumapp.org/'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.appdata');
    expect(u.searchParams.get('client_id')).toBe('USER-CLIENT');
    expect(u.searchParams.get('response_type')).toBe('token');
  });

  test('解析回呼：取 token；使用者拒絕或缺 scope 時丟錯', () => {
    const ok = parseAuthRedirect(`https://abc.chromiumapp.org/#access_token=T&expires_in=3599&scope=${encodeURIComponent(DRIVE_SCOPE)}`);
    expect(ok.token).toBe('T');
    expect(() => parseAuthRedirect('https://abc.chromiumapp.org/#error=access_denied')).toThrow(expect.objectContaining({ code: 'authDenied' }));
    expect(() => parseAuthRedirect('https://abc.chromiumapp.org/#access_token=T&scope=email')).toThrow(expect.objectContaining({ code: 'scopeMissing' }));
  });

  test('token 放 Authorization header；新檔用 multipart 上傳到 appDataFolder', async () => {
    const { fetchImpl, calls } = createMockFetch([
      { match: 'https://www.googleapis.com/drive/v3/files?', respond: () => jsonResponse({ files: [] }) },
      { match: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', respond: () => jsonResponse({ id: 'F1', modifiedTime: 't' }) },
    ]);
    const c = createDriveClient({ getToken: async () => 'TOKEN', fetchImpl });
    expect(await c.find('ekiden-backup.json')).toBeNull();
    const r = await c.upload('ekiden-backup.json', '{"a":1}');
    expect(r.id).toBe('F1');
    for (const call of calls) {
      expect(headerOf(call.init, 'Authorization')).toBe('Bearer TOKEN');
      expect(call.url).not.toContain('TOKEN');
    }
    expect(new URL(calls[0].url).searchParams.get('spaces')).toBe('appDataFolder');
    expect(calls[1].init.body).toContain('"parents":["appDataFolder"]');
  });

  test('已有檔案時用 PATCH 覆寫；401 → auth', async () => {
    const { fetchImpl, calls } = createMockFetch([
      { match: 'https://www.googleapis.com/upload/drive/v3/files/F1', respond: () => jsonResponse({ id: 'F1' }) },
    ]);
    await createDriveClient({ getToken: async () => 'T', fetchImpl }).upload('n', '{}', 'F1');
    expect(calls[0].init.method).toBe('PATCH');

    const c401 = createDriveClient({ getToken: async () => 'T', fetchImpl: createMockFetch([{ match: /./, respond: () => textResponse('', { status: 401 }) }]).fetchImpl });
    await expect(c401.find('n')).rejects.toMatchObject({ code: 'auth' });
  });
});
