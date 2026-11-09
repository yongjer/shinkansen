// 測試用的 fetch 替身：依序比對 routes，記錄每次呼叫。
// route: { match: (url, init) => boolean | RegExp | string, respond: (url, init, call) => Response 形狀 }

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return makeResponse(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function textResponse(text, { status = 200, headers = {} } = {}) {
  return makeResponse(text, { status, headers });
}

function makeResponse(text, { status, headers }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

export function createMockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init, body: typeof init.body === 'string' ? init.body : init.body });
    for (const r of routes) {
      const m = r.match;
      const hit = typeof m === 'function' ? m(u, init) : m instanceof RegExp ? m.test(u) : u.startsWith(m);
      if (hit) {
        if (r.throws) throw r.throws;
        return r.respond(u, init, calls.length);
      }
    }
    throw new Error(`mock fetch: no route for ${init.method || 'GET'} ${u}`);
  };
  return { fetchImpl, calls };
}

export function headerOf(init, name) {
  const h = init?.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

// 偽 JWT（Edge 的 auth 端點回這種格式）
export function fakeJwt(expSec) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: expSec })}.sig`;
}
