import { runChain, createHealth, normalizeChain, DEFAULT_CHAIN } from '../../shinkansen/fork/engines/chain.js';
import { createRateLimiter } from '../../shinkansen/fork/engines/rate-limit.js';

describe('免費引擎備援鏈', () => {
  test('預設順序：微軟 → DeepLX → Google', () => {
    expect(DEFAULT_CHAIN).toEqual(['microsoft-edge', 'deeplx', 'google']);
  });

  test('normalizeChain 去重、丟掉未知 id、補上漏掉的候選', () => {
    expect(normalizeChain(['google', 'google', 'deepl', 'microsoft-edge'])).toEqual(['google', 'microsoft-edge', 'deeplx']);
    expect(normalizeChain(null)).toEqual(DEFAULT_CHAIN);
  });

  test('依使用者順序嘗試，失敗才換下一家，回報實際服務的引擎', async () => {
    const tried = [];
    const r = await runChain({
      order: ['google', 'microsoft-edge', 'deeplx'],
      isConfigured: () => true,
      health: createHealth(),
      tryEngine: async (id) => {
        tried.push(id);
        if (id === 'google') throw new Error('google down');
        return { translations: [`by ${id}`], chars: 3 };
      },
    });
    expect(tried).toEqual(['google', 'microsoft-edge']);
    expect(r.servedBy).toBe('microsoft-edge');
    expect(r.attempts).toEqual([{ engine: 'google', error: 'google down' }]);
  });

  test('略過停用與未設定的引擎', async () => {
    const tried = [];
    await runChain({
      order: ['microsoft-edge', 'deeplx', 'google'],
      disabled: ['microsoft-edge'],
      isConfigured: (id) => id !== 'deeplx',
      health: createHealth(),
      tryEngine: async (id) => { tried.push(id); return { translations: ['x'], chars: 1 }; },
    });
    expect(tried).toEqual(['google']);
  });

  test('全部停用 → forkChainEmpty；全部失敗 → forkChainAllFailed 並列出原因', async () => {
    await expect(runChain({
      order: DEFAULT_CHAIN, disabled: [...DEFAULT_CHAIN], isConfigured: () => true, health: createHealth(), tryEngine: async () => ({}),
    })).rejects.toMatchObject({ skCode: 'forkChainEmpty' });

    const err = await runChain({
      order: DEFAULT_CHAIN, isConfigured: () => true, health: createHealth(),
      tryEngine: async (id) => { throw new Error(`${id} failed`); },
    }).catch((e) => e);
    expect(err.skCode).toBe('forkChainAllFailed');
    expect(err.skParams.detail).toContain('microsoft-edge: microsoft-edge failed');
    expect(err.skParams.detail).toContain('google: google failed');
  });

  test('連續失敗兩次的引擎冷卻 5 分鐘：先試其他家，其他家都失敗時仍會再試它', async () => {
    let t = 0;
    const health = createHealth({ now: () => t });
    health.recordFailure('microsoft-edge', new Error('x'));
    health.recordFailure('microsoft-edge', new Error('x'));
    expect(health.isCoolingDown('microsoft-edge')).toBe(true);

    const tried = [];
    const r = await runChain({
      order: ['microsoft-edge', 'google'], disabled: ['deeplx'], isConfigured: () => true, health,
      tryEngine: async (id) => { tried.push(id); return { translations: ['ok'], chars: 2 }; },
    });
    expect(tried).toEqual(['google']);
    expect(r.servedBy).toBe('google');

    const tried2 = [];
    const r2 = await runChain({
      order: ['microsoft-edge', 'google'], disabled: ['deeplx'], isConfigured: () => true, health,
      tryEngine: async (id) => { tried2.push(id); if (id === 'google') throw new Error('g'); return { translations: ['ok'], chars: 2 }; },
    });
    expect(tried2).toEqual(['google', 'microsoft-edge']);
    expect(r2.servedBy).toBe('microsoft-edge');
    expect(health.isCoolingDown('microsoft-edge')).toBe(false); // 成功後重設

    t += 0;
    health.recordFailure('google', new Error('g'));
    health.recordFailure('google', new Error('g'));
    t += 5 * 60_000;
    expect(health.isCoolingDown('google')).toBe(false);
  });

  test('使用者中止時不再嘗試下一家', async () => {
    const ac = new AbortController();
    const tried = [];
    const p = runChain({
      order: DEFAULT_CHAIN, isConfigured: () => true, health: createHealth(), signal: ac.signal,
      tryEngine: async (id) => { tried.push(id); ac.abort(); throw new Error('aborted'); },
    });
    await expect(p).rejects.toThrow('aborted');
    expect(tried).toEqual(['microsoft-edge']);
  });
});

describe('速率限制', () => {
  function fakeClock() {
    let t = 1_000_000;
    const sleeps = [];
    return {
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      advance: (ms) => { t += ms; },
      sleeps,
    };
  }

  test('不限制時立即通過', async () => {
    const c = fakeClock();
    const lim = createRateLimiter(c);
    for (let i = 0; i < 20; i++) await lim.acquire('x', {});
    expect(c.sleeps).toEqual([]);
  });

  test('每秒 3 次：第 4 次要等到第 1 次滑出 1 秒視窗', async () => {
    const c = fakeClock();
    const lim = createRateLimiter(c);
    await lim.acquire('deeplx', { rps: 3 });
    c.advance(100);
    await lim.acquire('deeplx', { rps: 3 });
    await lim.acquire('deeplx', { rps: 3 });
    await lim.acquire('deeplx', { rps: 3 });
    expect(c.sleeps).toEqual([900]);
  });

  test('每分鐘上限', async () => {
    const c = fakeClock();
    const lim = createRateLimiter(c);
    await lim.acquire('e', { rpm: 2 });
    await lim.acquire('e', { rpm: 2 });
    await lim.acquire('e', { rpm: 2 });
    expect(c.sleeps).toEqual([60_000]);
  });

  test('不同引擎各自計算', async () => {
    const c = fakeClock();
    const lim = createRateLimiter(c);
    await lim.acquire('a', { rps: 1 });
    await lim.acquire('b', { rps: 1 });
    expect(c.sleeps).toEqual([]);
  });

  test('同一引擎的併發請求依序排隊', async () => {
    const c = fakeClock();
    const lim = createRateLimiter(c);
    await Promise.all([1, 2, 3, 4].map(() => lim.acquire('q', { rps: 2 })));
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
  });
});
