// fork/learn/store.js — 學習中心的資料（第 2 階段只負責「加入」；瀏覽、複習介面在第 3 階段）
//
// 存在擴充功能自己的 IndexedDB（'ekiden-learn'），只留在本機，不同步、不上傳。
// 一筆 = 使用者從劃詞卡片加入的一段文字：
//   { id, text, translation, lang, context, url, title, card?, createdAt, updatedAt }
// 同一段文字（不分大小寫、空白正規化）再次加入時更新既有那筆，不重複新增。

const DB_NAME = 'ekiden-learn';
const STORE = 'items';
export const LEARN_LIMITS = Object.freeze({ text: 2000, translation: 4000, context: 4000, title: 300, url: 2000 });

export function normalizeKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 500);
}

function clip(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 只收已知欄位；網址只留 http(s)。 */
export function sanitizeLearnItem(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const text = clip(r.text, LEARN_LIMITS.text).trim();
  if (!text) return null;
  let url = clip(r.url, LEARN_LIMITS.url);
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') url = '';
  } catch {
    url = '';
  }
  const item = {
    key: normalizeKey(text),
    text,
    translation: clip(r.translation, LEARN_LIMITS.translation).trim(),
    lang: clip(r.lang, 20),
    context: clip(r.context, LEARN_LIMITS.context),
    url,
    title: clip(r.title, LEARN_LIMITS.title),
    createdAt: now,
    updatedAt: now,
  };
  if (r.card && typeof r.card === 'object') {
    try {
      const json = JSON.stringify(r.card);
      if (json.length <= 20_000) item.card = JSON.parse(json);
    } catch { /* 卡片內容有問題就不存 */ }
  }
  return item;
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function createLearnStore({ indexedDB = globalThis.indexedDB, name = DB_NAME, now = () => Date.now() } = {}) {
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
            os.createIndex('key', 'key', { unique: true });
            os.createIndex('updatedAt', 'updatedAt');
          }
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => { dbp = null; reject(r.error); };
      });
    }
    return dbp;
  };

  return {
    /** @returns {Promise<{ id: number, created: boolean }>} */
    async add(raw) {
      const item = sanitizeLearnItem(raw, now());
      if (!item) throw new Error('learn: empty text');
      const db = await open();
      const os = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const existing = await req(os.index('key').get(item.key));
      if (existing) {
        const merged = {
          ...existing,
          ...item,
          id: existing.id,
          createdAt: existing.createdAt,
          // 新的這次沒有譯文 / 卡片時保留舊的
          translation: item.translation || existing.translation,
          card: item.card || existing.card,
        };
        await req(os.put(merged));
        return { id: existing.id, created: false };
      }
      const id = await req(os.add(item));
      return { id, created: true };
    },
    async count() {
      const db = await open();
      return req(db.transaction(STORE, 'readonly').objectStore(STORE).count());
    },
    async has(text) {
      const db = await open();
      const r = await req(db.transaction(STORE, 'readonly').objectStore(STORE).index('key').get(normalizeKey(text)));
      return !!r;
    },
  };
}
