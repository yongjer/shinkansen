// fork/engines/rate-limit.js — 每個引擎各自的請求速率限制（每秒 / 每分鐘請求數）
//
// 滑動視窗：記錄最近一分鐘內每次請求的時間點，取得許可前檢查兩個視窗都沒超過，
// 超過就等到最早那筆滑出視窗。0 或未設定 = 不限制。
// 只在背景 service worker 的記憶體內生效；service worker 重啟後視窗歸零，
// 對「避免短時間打爆端點」這個目的已足夠。

export function createRateLimiter({ now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const history = new Map(); // engineId → number[]（時間戳，舊到新）
  const queues = new Map();  // engineId → Promise（序列化同一引擎的取得許可）

  function prune(list, t) {
    while (list.length && t - list[0] >= 60_000) list.shift();
  }

  function waitMs(list, t, { rps, rpm }) {
    let wait = 0;
    if (rps > 0) {
      const inLastSec = list.filter((x) => t - x < 1000);
      if (inLastSec.length >= rps) wait = Math.max(wait, 1000 - (t - inLastSec[inLastSec.length - rps]));
    }
    if (rpm > 0 && list.length >= rpm) {
      wait = Math.max(wait, 60_000 - (t - list[list.length - rpm]));
    }
    return wait;
  }

  async function acquireNow(engineId, limits) {
    const list = history.get(engineId) || [];
    history.set(engineId, list);
    for (;;) {
      const t = now();
      prune(list, t);
      const w = waitMs(list, t, limits);
      if (w <= 0) {
        list.push(t);
        return;
      }
      await sleep(w);
    }
  }

  /**
   * 取得一次請求許可。limits = { rps, rpm }（皆可省略或 0 = 不限）。
   */
  function acquire(engineId, limits = {}) {
    const rps = Number(limits.rps) > 0 ? Math.floor(Number(limits.rps)) : 0;
    const rpm = Number(limits.rpm) > 0 ? Math.floor(Number(limits.rpm)) : 0;
    if (!rps && !rpm) return Promise.resolve();
    const prev = queues.get(engineId) || Promise.resolve();
    const next = prev.then(() => acquireNow(engineId, { rps, rpm }));
    queues.set(engineId, next.catch(() => {}));
    return next;
  }

  return { acquire };
}
