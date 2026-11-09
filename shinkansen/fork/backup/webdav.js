// fork/backup/webdav.js — WebDAV 備份（Nextcloud、堅果雲、Synology 等）
//
// 只連使用者填的伺服器，帳號密碼以 HTTP Basic 驗證送出。建議只用 https://。
// 檔案放在 <伺服器網址>/<資料夾>/ekiden-backup.json。
// 覆寫保護：記住上次上傳 / 下載時的 ETag；上傳前若雲端檔的 ETag 不同，代表其他裝置改過，
// 由呼叫端詢問使用者是否覆蓋。

import { utf8ToBase64 } from './crypto.js';

export class WebdavError extends Error {
  constructor(code, status, message) {
    super(message || `${code}${status ? ` (HTTP ${status})` : ''}`);
    this.code = code;
    this.status = status || 0;
  }
}

function joinUrl(base, ...parts) {
  let u = String(base || '').trim();
  if (!u.endsWith('/')) u += '/';
  for (const p of parts) {
    const seg = String(p || '').replace(/^\/+|\/+$/g, '');
    if (!seg) continue;
    const pieces = seg.split('/').filter(Boolean);
    // '.' / '..' 會被瀏覽器正規化成上層目錄，拒絕
    if (pieces.some((x) => x === '.' || x === '..')) throw new WebdavError('badUrl', 0, 'invalid folder name');
    u += pieces.map(encodeURIComponent).join('/') + '/';
  }
  return u;
}

export function createWebdavClient({ url, username = '', password = '', dir = 'ekiden', fetchImpl = (...a) => fetch(...a) }) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
  } catch {
    throw new WebdavError('badUrl', 0, 'invalid WebDAV URL');
  }
  const root = joinUrl(url);
  const folder = joinUrl(url, dir);
  const auth = username || password ? `Basic ${utf8ToBase64(`${username}:${password}`)}` : '';

  async function call(method, target, { headers = {}, body } = {}) {
    let resp;
    try {
      resp = await fetchImpl(target, {
        method,
        headers: { ...(auth ? { Authorization: auth } : {}), ...headers },
        body,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      throw new WebdavError('network', 0, err?.message || String(err));
    }
    if (resp.status === 401 || resp.status === 403) throw new WebdavError('auth', resp.status);
    return resp;
  }

  async function ensureFolder() {
    // 逐層建立；已存在時伺服器回 405（或部分伺服器 301 / 409），都視為成功
    const segs = String(dir || '').split('/').filter(Boolean);
    let cur = root;
    for (const s of segs) {
      cur = joinUrl(cur, s);
      const r = await call('MKCOL', cur);
      if (!(r.ok || r.status === 405 || r.status === 301 || r.status === 409)) {
        throw new WebdavError('mkcol', r.status);
      }
    }
  }

  const fileUrl = (name) => folder + encodeURIComponent(name);

  return {
    folder,
    /** 測試連線：讀取根目錄（PROPFIND Depth 0），並確保資料夾存在。 */
    async test() {
      const r = await call('PROPFIND', root, { headers: { Depth: '0', 'Content-Type': 'application/xml' } });
      if (!(r.ok || r.status === 207)) throw new WebdavError('propfind', r.status);
      await ensureFolder();
      return true;
    },
    async head(name) {
      const r = await call('HEAD', fileUrl(name));
      if (r.status === 404) return null;
      if (!r.ok) throw new WebdavError('head', r.status);
      return { etag: r.headers.get('ETag') || '', lastModified: r.headers.get('Last-Modified') || '' };
    },
    async get(name) {
      const r = await call('GET', fileUrl(name));
      if (r.status === 404) return null;
      if (!r.ok) throw new WebdavError('get', r.status);
      return { text: await r.text(), etag: r.headers.get('ETag') || '' };
    },
    async put(name, text, { ifMatch } = {}) {
      await ensureFolder();
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (ifMatch) headers['If-Match'] = ifMatch;
      const r = await call('PUT', fileUrl(name), { headers, body: text });
      if (r.status === 412) throw new WebdavError('conflict', 412);
      if (!r.ok) throw new WebdavError('put', r.status);
      let etag = r.headers.get('ETag') || '';
      if (!etag) {
        const h = await this.head(name).catch(() => null);
        etag = h?.etag || '';
      }
      return { etag };
    },
    async remove(name) {
      const r = await call('DELETE', fileUrl(name));
      if (r.status === 404) return false;
      if (!r.ok) throw new WebdavError('delete', r.status);
      return true;
    },
  };
}
