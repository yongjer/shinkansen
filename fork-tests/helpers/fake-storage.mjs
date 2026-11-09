// 測試用的 chrome.storage 替身（sync / local 兩區，Promise 介面）
export function createFakeArea(initial = {}) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return JSON.parse(JSON.stringify(data));
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async set(obj) {
      data = { ...data, ...JSON.parse(JSON.stringify(obj)) };
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    dump: () => JSON.parse(JSON.stringify(data)),
  };
}

export function createFakeStorage({ sync = {}, local = {} } = {}) {
  return { sync: createFakeArea(sync), local: createFakeArea(local) };
}
