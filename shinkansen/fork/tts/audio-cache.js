// fork/tts/audio-cache.js — 朗讀音訊的本機快取（最近 20 段，LRU）
//
// 存在擴充功能自己的 IndexedDB（'ekiden-tts'），不跟網頁共用。key 由模型、聲音、播放模式與
// 實際送出的文字（套用讀音表之後）算 SHA-256，任一項改變都會重新合成。
// 同一句再按一次朗讀、或按「重播」時，直接用快取，不發出 API 請求。

export const TTS_CACHE_MAX = 20;
const DB_NAME = 'ekiden-tts';
const STORE = 'clips';

export async function ttsCacheKey({ model, voice, style, text }) {
  const raw = JSON.stringify([model || '', voice || '', style || '', text || '']);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createMemoryBackend() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? { ...m.get(key) } : null; },
    async put(rec) { m.set(rec.key, { ...rec }); },
    async delete(key) { m.delete(key); },
    async list() { return [...m.values()].map((r) => ({ key: r.key, t: r.t })); },
    async clear() { m.clear(); },
  };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function createIdbBackend({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          // index 't'（最後使用時間）讓淘汰時只讀 key，不必把每段音訊都載入記憶體
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('t', 't');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => { dbp = null; reject(r.error); };
      });
    }
    return dbp;
  };
  const tx = async (mode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    async get(key) { return (await req((await tx('readonly')).get(key))) || null; },
    async put(rec) { await req((await tx('readwrite')).put(rec)); },
    async delete(key) { await req((await tx('readwrite')).delete(key)); },
    async list() {
      const store = await tx('readonly');
      return new Promise((resolve, reject) => {
        const out = [];
        const r = store.index('t').openKeyCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (!c) { resolve(out); return; }
          out.push({ key: c.primaryKey, t: c.key });
          c.continue();
        };
        r.onerror = () => reject(r.error);
      });
    },
    async clear() { await req((await tx('readwrite')).clear()); },
  };
}

/**
 * @param {object} opts
 * @param {object} opts.backend  createIdbBackend() / createMemoryBackend()
 * @param {number} [opts.max]
 * @param {Function} [opts.now]
 */
export function createAudioCache({ backend, max = TTS_CACHE_MAX, now = () => Date.now() }) {
  let tick = 0;
  // 同一毫秒內連續操作也要分得出先後
  const stamp = () => now() * 1000 + (tick++ % 1000);
  return {
    async get(key) {
      const rec = await backend.get(key);
      if (!rec) return null;
      rec.t = stamp();
      try { await backend.put(rec); } catch { /* 更新使用時間失敗不影響播放 */ }
      return { data: rec.data, mimeType: rec.mimeType };
    },
    async put(key, { data, mimeType }) {
      await backend.put({ key, data, mimeType, t: stamp() });
      const list = await backend.list();
      if (list.length <= max) return;
      list.sort((a, b) => a.t - b.t);
      for (const old of list.slice(0, list.length - max)) await backend.delete(old.key);
    },
    async size() { return (await backend.list()).length; },
    async clear() { await backend.clear(); },
  };
}
