// Regression: iOS background keep-alive port(content-touch.js + background.js,
// SPEC-PRIVATE §26.13)
//
// 背景：iOS Safari 的擴充功能 background event page 閒置後會被系統永久回收且叫不醒
// （Apple Developer Forums thread 758346）→「用一陣子後四指 / popup 翻譯失效」。
// 修法：content script 在「iOS build + top frame + 分頁可見」時開一條長連線 port +
// 每 20s ping，讓系統把 background 維持在非閒置、不被回收。
//
// 本 spec 鎖的訊號層次（CLAUDE.md 工作流原則 3）：
//   驗「content-touch.js maybeStartKeepAlive → browser.runtime.connect →
//   background onConnect('shinkansen-keepalive')→ 收 ping 回 pong → content 端
//   收到 pong」整條跨 isolated world + service worker 的真實 port round-trip，
//   以及 IS_IOS_BUILD gate（桌面 build 不開 port）。
//   不驗：真實 iOS Safari 的「永久回收」行為與這條 port 是否真能阻止回收
//   （Chromium harness 與模擬器都不會發生回收，只能真機 TestFlight 驗收）；
//   visibilitychange 切背景斷線（harness 控制 document.hidden 不穩，留真機）。
//
// SANITY CHECK 紀錄（已驗證，2026-06-09）：
//   暫時把 background.js onConnect handler 內的 `port.postMessage({ pong: true })`
//   註解掉 → 「iOS build → 收到 pong」case fail（_keepAliveAlive 永遠 false），
//   還原後全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'ios-keepalive';

async function setupPage(context, localServer, { iosBuild }) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  // 載入期 IS_IOS_BUILD 為 false(Chromium 預設),maybeStartKeepAlive() 已 no-op 跑過。
  // 翻 flag 後手動再觸發，模擬 iOS build 行為。
  if (iosBuild) {
    await evaluate(`window.__SK.IS_IOS_BUILD = true`);
  }
  return { page, evaluate };
}

// 觸發後輪詢 _keepAliveAlive（port round-trip 過 background，非同步）
async function waitAlive(page, evaluate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const alive = await evaluate(`window.__SK._keepAliveAlive === true`);
    if (alive) return true;
    await page.waitForTimeout(50);
  }
  return await evaluate(`window.__SK._keepAliveAlive === true`);
}

test('iOS build → 開 keep-alive port → background 回 pong(content↔background round-trip)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true });

  await evaluate(`window.__SK.maybeStartKeepAlive()`);

  const alive = await waitAlive(page, evaluate);
  expect(alive, 'content 端應收到 background 的 pong → port 連線打通').toBe(true);
});

test('IS_IOS_BUILD=false(桌面 build 預設)→ 不開 port', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: false });

  await evaluate(`window.__SK.maybeStartKeepAlive()`);

  // 桌面 gate 應擋下，port 不開 → 永遠收不到 pong
  await page.waitForTimeout(800);
  const alive = await evaluate(`window.__SK._keepAliveAlive === true`);
  expect(alive, '桌面 build 不該開 keep-alive port').toBe(false);
});
