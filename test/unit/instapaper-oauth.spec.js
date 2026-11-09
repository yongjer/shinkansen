// Unit test: Instapaper Full API（OAuth 1.0a + xAuth）核心邏輯
//
// 驗證 shinkansen/lib/instapaper.js:
//   - oauthPercentEncode：RFC 3986 補編 ! * ' ( ) + space
//   - normalizeOAuthParams / buildOAuthBaseString：RFC 5849 §3.4.1 官方測試向量
//   - signRequest：OAuth 1.0 Appendix A.5.2 已知 HMAC-SHA1 簽章向量（Node crypto 注入）
//   - parseTokenResponse：正常解析 + 缺欄位回 null
//   - buildInstapaperPayload：url 必填、title/content 防呆
//   - instapaperXAuth / saveToInstapaper：mock fetchImpl 驗 ok / AUTH / HTTP / NETWORK / CONFIG 分支
//
// 本層驗「簽章字串 / 分支」,不驗真實 Instapaper 端點接受度（受測試向量限制）——
// 真實送出需 consumer 金鑰到位後手動驗一次。
//
// SANITY 紀錄（已驗證）:
//   把 normalizeOAuthParams 的 `pairs.sort(...)` 註解掉（破壞參數字典序）→
//   normalizeOAuthParams（§3.4.1.3.2）、buildOAuthBaseString（§3.4.1.1）、
//   signRequest（A.5.2 簽章）三條向量斷言同時 fail（3 failed / 10 passed）→ 還原後 13 全 pass。
import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const {
  oauthPercentEncode, normalizeOAuthParams, buildOAuthBaseString,
  buildOAuthSigningKey, signRequest, parseTokenResponse, buildInstapaperPayload,
  encodeFormBody, instapaperXAuth, saveToInstapaper,
  INSTAPAPER_ACCESS_TOKEN_URL, INSTAPAPER_ADD_URL,
} = await import('../../shinkansen/lib/instapaper.js');

// Node crypto 當 signImpl（瀏覽器跑 crypto.subtle，這裡注入避開 async subtle 環境差異）
const nodeSign = (key, msg) => createHmac('sha1', key).update(msg).digest('base64');

// 測試用 consumer 金鑰（注入,不依賴 gitignored 的 instapaper-keys.js）
const TEST_KEYS = { consumerKey: 'test-ck', consumerSecret: 'test-cs' };

test('oauthPercentEncode 補編 ! * \' ( ) 與 space，保留 - _ . ~', () => {
  expect(oauthPercentEncode("a b")).toBe('a%20b');
  expect(oauthPercentEncode("!*'()")).toBe('%21%2A%27%28%29');
  expect(oauthPercentEncode('-_.~')).toBe('-_.~');
  expect(oauthPercentEncode('=&')).toBe('%3D%26');
});

test('normalizeOAuthParams 對 RFC 5849 §3.4.1.3.2 範例參數產出正確排序字串', () => {
  // RFC 5849 §3.4.1.3.1 解碼後參數表（含同 key 多值 a3）
  const params = {
    b5: '=%3D',
    a3: ['a', '2 q'],
    'c@': '',
    a2: 'r b',
    c2: '',
    oauth_consumer_key: '9djdj82h48djs9d2',
    oauth_token: 'kkk9d7dh3k39sjv7',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '137131201',
    oauth_nonce: '7d8f3e4a',
  };
  const expected =
    'a2=r%20b&a3=2%20q&a3=a&b5=%3D%253D&c%40=&c2=' +
    '&oauth_consumer_key=9djdj82h48djs9d2&oauth_nonce=7d8f3e4a' +
    '&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131201' +
    '&oauth_token=kkk9d7dh3k39sjv7';
  expect(normalizeOAuthParams(params)).toBe(expected);
});

test('buildOAuthBaseString 對 RFC 5849 §3.4.1.1 範例產出正確 base string', () => {
  const params = {
    b5: '=%3D',
    a3: ['a', '2 q'],
    'c@': '',
    a2: 'r b',
    c2: '',
    oauth_consumer_key: '9djdj82h48djs9d2',
    oauth_token: 'kkk9d7dh3k39sjv7',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '137131201',
    oauth_nonce: '7d8f3e4a',
  };
  const base = buildOAuthBaseString({ method: 'POST', url: 'http://example.com/request', params });
  // RFC 5849 §3.4.1.1 範例 base string（移除文件中的換行）
  const expected =
    'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q' +
    '%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_' +
    'key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_m' +
    'ethod%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk' +
    '9d7dh3k39sjv7';
  expect(base).toBe(expected);
});

test('signRequest 對 OAuth 1.0 Appendix A.5.2 已知向量產出正確 HMAC-SHA1 簽章', async () => {
  const { signature, baseString } = await signRequest({
    method: 'GET',
    url: 'http://photos.example.net/photos',
    consumerKey: 'dpf43f3p2l4k3l03',
    consumerSecret: 'kd94hf93k423kf44',
    token: 'nnch734d00sl2jdk',
    tokenSecret: 'pfkkdhi9sl3r4s00',
    bodyParams: { file: 'vacation.jpg', size: 'original' },
    nonce: 'kllo9940pd9333jh',
    timestamp: 1191242096,
    signImpl: nodeSign,
  });
  // Appendix A.5.2 base string + 簽章
  expect(baseString).toBe(
    'GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg' +
    '%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh' +
    '%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096' +
    '%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal');
  expect(signature).toBe('tR3+Ty81lMeYAr/Fid0kMTYa/WM=');
});

test('buildOAuthSigningKey pctEncode 兩段以 & 連接', () => {
  expect(buildOAuthSigningKey({ consumerSecret: 'a b', tokenSecret: 'c+d' }))
    .toBe('a%20b&c%2Bd');
  expect(buildOAuthSigningKey({ consumerSecret: 'x', tokenSecret: '' })).toBe('x&');
});

test('signRequest authHeader 只含 oauth_ 參數且含簽章', async () => {
  const { authHeader } = await signRequest({
    method: 'POST', url: INSTAPAPER_ADD_URL,
    consumerKey: 'ck', consumerSecret: 'cs', token: 'tk', tokenSecret: 'ts',
    bodyParams: { url: 'https://e.com', content: '<p>hi</p>' },
    nonce: 'n1', timestamp: 1700000000, signImpl: nodeSign,
  });
  expect(authHeader).toMatch(/^OAuth /);
  expect(authHeader).toContain('oauth_consumer_key="ck"');
  expect(authHeader).toContain('oauth_token="tk"');
  expect(authHeader).toContain('oauth_signature="');
  // body 參數不可外洩到 header
  expect(authHeader).not.toContain('content');
  expect(authHeader).not.toContain('url=');
});

test('parseTokenResponse 正常解析 + 缺欄位回 null', () => {
  expect(parseTokenResponse('oauth_token=abc&oauth_token_secret=def'))
    .toEqual({ token: 'abc', tokenSecret: 'def' });
  expect(parseTokenResponse('oauth_token=abc')).toBeNull();
  expect(parseTokenResponse('')).toBeNull();
  expect(parseTokenResponse(null)).toBeNull();
});

test('buildInstapaperPayload：url 必填、title/content 防呆', () => {
  expect(() => buildInstapaperPayload({})).toThrow();
  expect(buildInstapaperPayload({ url: 'https://e.com' })).toEqual({ url: 'https://e.com' });
  // 不設 is_private_from_source（影片綁架真因是 frame 廣播，已修 content.js;留住 source URL）
  expect(buildInstapaperPayload({ url: 'https://e.com', html: '<p>x</p>', title: 'T' }))
    .toEqual({ url: 'https://e.com', title: 'T', content: '<p>x</p>' });
  // 空 title / html 不帶
  expect(buildInstapaperPayload({ url: 'https://e.com', html: '', title: '' }))
    .toEqual({ url: 'https://e.com' });
});

test('encodeFormBody 用 pctEncode（space→%20）與簽章一致', () => {
  expect(encodeFormBody({ a: 'r b', c: '=' })).toBe('a=r%20b&c=%3D');
});

function mockRes({ status = 200, ok, text = '', json } = {}) {
  return {
    status,
    ok: ok !== undefined ? ok : (status >= 200 && status < 300),
    text: async () => text,
    json: async () => { if (json === undefined) throw new Error('no json'); return json; },
  };
}

test('instapaperXAuth：200 + token body → ok', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return mockRes({ status: 200, text: 'oauth_token=T1&oauth_token_secret=S1' });
  };
  const r = await instapaperXAuth({
    email: 'a@b.com', password: 'pw', fetchImpl, signImpl: nodeSign, ...TEST_KEYS,
  });
  expect(r).toEqual({ ok: true, token: 'T1', tokenSecret: 'S1' });
  expect(captured.url).toBe(INSTAPAPER_ACCESS_TOKEN_URL);
  expect(captured.opts.headers.Authorization).toMatch(/^OAuth /);
  expect(captured.opts.body).toContain('x_auth_mode=client_auth');
});

test('instapaperXAuth：403 → AUTH、500 → HTTP、throw → NETWORK、無金鑰 → CONFIG', async () => {
  const xa = (fetchImpl, keys = TEST_KEYS) =>
    instapaperXAuth({ email: 'a@b.com', password: 'pw', fetchImpl, signImpl: nodeSign, ...keys });
  expect(await xa(async () => mockRes({ status: 403 }))).toMatchObject({ ok: false, error: 'AUTH' });
  expect(await xa(async () => mockRes({ status: 500 }))).toMatchObject({ ok: false, error: 'HTTP', status: 500 });
  expect(await xa(async () => { throw new Error('net down'); })).toMatchObject({ ok: false, error: 'NETWORK' });
  // 金鑰未注入 + globalThis 無 keys → CONFIG
  expect(await xa(async () => mockRes({ status: 200 }), { consumerKey: '', consumerSecret: '' }))
    .toMatchObject({ ok: false, error: 'CONFIG' });
});

test('saveToInstapaper：200/201 → ok、403 → AUTH、500 → HTTP、throw → NETWORK', async () => {
  const payload = buildInstapaperPayload({ url: 'https://e.com', html: '<p>譯文</p>', title: 'T' });
  const save = (fetchImpl) => saveToInstapaper({
    token: 'tk', tokenSecret: 'ts', payload, fetchImpl, signImpl: nodeSign, ...TEST_KEYS,
  });
  let captured = null;
  const okFetch = async (url, opts) => { captured = { url, opts }; return mockRes({ status: 201, json: [{ bookmark_id: 1 }] }); };
  const r = await save(okFetch);
  expect(r.ok).toBe(true);
  expect(r.status).toBe(201);
  expect(captured.url).toBe(INSTAPAPER_ADD_URL);
  expect(captured.opts.body).toContain('content=');
  expect(captured.opts.body).not.toContain('is_private_from_source');

  expect(await save(async () => mockRes({ status: 200, json: [{}] }))).toMatchObject({ ok: true, status: 200 });
  expect(await save(async () => mockRes({ status: 403 }))).toMatchObject({ ok: false, error: 'AUTH' });
  expect(await save(async () => mockRes({ status: 500 }))).toMatchObject({ ok: false, error: 'HTTP', status: 500 });
  expect(await save(async () => { throw new Error('x'); })).toMatchObject({ ok: false, error: 'NETWORK' });
});

test('saveToInstapaper：缺 token → AUTH', async () => {
  const payload = buildInstapaperPayload({ url: 'https://e.com' });
  const r = await saveToInstapaper({ token: '', tokenSecret: '', payload, fetchImpl: async () => mockRes(), signImpl: nodeSign, ...TEST_KEYS });
  expect(r).toMatchObject({ ok: false, error: 'AUTH' });
});
