// fork/backup/gdrive.js — Google Drive 備份（選用）
//
// - 權限：'identity' 列在 optional_permissions，使用者第一次按「連結 Google Drive」才請求
// - 授權：chrome.identity.launchWebAuthFlow + 使用者自己在 Google Cloud 建立的 OAuth 用戶端 ID
//   （類型「網頁應用程式」，已授權的重新導向 URI 填設定頁顯示的網址）。驛傳不內建任何用戶端 ID。
// - 範圍：只要求 https://www.googleapis.com/auth/drive.appdata，只能存取 Drive 裡隱藏的
//   應用程式資料夾，看不到使用者的其他檔案
// - access token 只放記憶體（頁面關閉即失效），不寫入任何儲存區
//
// Drive API v3 文件：https://developers.google.com/drive/api/guides/appdata

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

export class DriveError extends Error {
  constructor(code, status, message) {
    super(message || `${code}${status ? ` (HTTP ${status})` : ''}`);
    this.code = code;
    this.status = status || 0;
  }
}

export function buildAuthUrl(clientId, redirectUri) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'token');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', DRIVE_SCOPE);
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

export function parseAuthRedirect(redirectedTo) {
  const hash = String(redirectedTo || '').split('#')[1] || '';
  const p = new URLSearchParams(hash);
  if (p.get('error')) throw new DriveError('authDenied', 0, p.get('error'));
  const token = p.get('access_token');
  if (!token) throw new DriveError('authFailed', 0, 'no access_token');
  const scopes = (p.get('scope') || '').split(' ');
  if (p.get('scope') && !scopes.includes(DRIVE_SCOPE)) throw new DriveError('scopeMissing', 0, 'drive.appdata scope not granted');
  return { token, expiresAt: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000 };
}

export function createDriveClient({ getToken, fetchImpl = (...a) => fetch(...a) }) {
  async function call(url, init = {}) {
    const token = await getToken();
    let resp;
    try {
      resp = await fetchImpl(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    } catch (err) {
      throw new DriveError('network', 0, err?.message || String(err));
    }
    if (resp.status === 401) throw new DriveError('auth', 401);
    if (!resp.ok && resp.status !== 404) throw new DriveError('http', resp.status, await resp.text().catch(() => ''));
    return resp;
  }

  async function find(name) {
    const u = new URL(FILES_URL);
    u.searchParams.set('spaces', 'appDataFolder');
    u.searchParams.set('q', `name = '${name.replace(/'/g, "\\'")}' and trashed = false`);
    u.searchParams.set('fields', 'files(id,name,modifiedTime,size)');
    const r = await call(u.toString());
    const j = await r.json();
    return (j.files || [])[0] || null;
  }

  return {
    find,
    async download(fileId) {
      const r = await call(`${FILES_URL}/${encodeURIComponent(fileId)}?alt=media`);
      if (r.status === 404) return null;
      return r.text();
    },
    async upload(name, text, existingId) {
      if (existingId) {
        const r = await call(`${UPLOAD_URL}/${encodeURIComponent(existingId)}?uploadType=media&fields=id,modifiedTime`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: text,
        });
        return r.json();
      }
      const boundary = 'ekiden' + Math.random().toString(36).slice(2);
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' }),
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        text,
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const r = await call(`${UPLOAD_URL}?uploadType=multipart&fields=id,modifiedTime`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
      return r.json();
    },
    async remove(fileId) {
      const r = await call(`${FILES_URL}/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
      return r.ok;
    },
  };
}
