import { test, expect, isolatedEvaluator } from './fixtures.mjs';

test('擴充功能以新名稱載入，isolated world 名稱為 Ekiden', async ({ serviceWorker, context, localServer }) => {
  const manifest = await serviceWorker.evaluate(() => ({ name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version }));
  // 名稱依瀏覽器語系（_locales）：Ekiden / 驛傳 Ekiden / 驿传 Ekiden / 駅伝 Ekiden
  expect(manifest.name).toMatch(/Ekiden$/);
  expect(manifest.name).not.toMatch(/Shinkansen/i);
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/); // 三段：四段會開啟上游的 dev-only Debug Bridge
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/article.html`);
  const evaluate = await isolatedEvaluator(page);
  expect(await evaluate('typeof window.__SK.forkResolvePreset')).toBe('function');
  expect(['Free engines', '免費引擎', '免费引擎', '無料エンジン', '무료 엔진', 'Motores gratuitos', 'Moteurs gratuits', 'Kostenlose Engines'])
    .toContain(await evaluate('window.__SK.forkMtName("free-chain")'));
});

test('驛傳設定頁：正常顯示、無錯誤、變更自動儲存', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extensionId}/fork/pages/settings.html`);

  await expect(page.locator('h1')).toContainText('Ekiden settings');
  await expect(page.locator('#preset-rows .preset-row')).toHaveCount(3);
  await expect(page.locator('#chain-list li')).toHaveCount(3);
  await expect(page.locator('.engine-card')).toHaveCount(6);
  await expect(page.locator('.badge.unofficial').first()).toContainText('Unofficial');
  // 預設 3（上游預設為 Google MT）可以改用其他機器翻譯
  const slot3 = page.locator('select[data-preset-slot="3"]');
  await expect(slot3).toHaveValue('');
  await slot3.selectOption('microsoft-edge');
  await page.locator('#source-lang').selectOption('ja');
  await expect.poll(async () => serviceWorker.evaluate(async () => (await chrome.storage.sync.get('fork')).fork), { timeout: 5000 })
    .toMatchObject({ presetEngines: { 3: 'microsoft-edge' }, mt: { sourceLang: 'ja' } });

  // 金鑰存 local，不進 sync
  await page.locator('[data-secret="deeplKey"]').fill('TEST-KEY:fx');
  await page.locator('[data-secret="deeplKey"]').blur();
  await expect.poll(async () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('forkSecrets')).forkSecrets?.deeplKey), { timeout: 5000 })
    .toBe('TEST-KEY:fx');
  const sync = await serviceWorker.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)));
  expect(sync).not.toContain('TEST-KEY');

  // 新增一組 OpenAI 相容服務
  await page.locator('#provider-add').click();
  await expect(page.locator('.provider-card')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('主要設定頁：驛傳入口、衍生作品聲明；授權區塊維持原文', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#ekiden-settings-link')).toBeVisible();
  await expect(page.locator('#ekiden-attribution')).toContainText('Shinkansen');
  await expect(page.locator('#ios-promo')).toBeHidden();
  await expect(page.locator('h1')).toContainText('Ekiden');
});

test('預設 3 改用 DeepLX：整頁翻譯經由驛傳引擎送到使用者設定的端點', async ({ context, serviceWorker, localServer }) => {
  await serviceWorker.evaluate(async (url) => {
    await chrome.storage.sync.set({
      fork: { presetEngines: { 1: '', 2: '', 3: 'deeplx' }, mt: { deeplx: { url }, chain: ['microsoft-edge', 'deeplx', 'google'] } },
    });
    await chrome.storage.local.set({ forkSecrets: { deeplxToken: 'DX-TOKEN' } });
  }, `${localServer.baseUrl}/deeplx`);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/article.html`);
  const evaluate = await isolatedEvaluator(page);
  await evaluate(`(() => {
    window.__toastLog = [];
    const orig = window.__SK.showToast;
    window.__SK.showToast = (type, msg, opts) => { window.__toastLog.push([type, String(msg)]); return orig(type, msg, opts); };
  })()`);
  await evaluate('window.__SK.handleTranslatePreset(3)');
  await expect.poll(() => page.locator('article').innerText(), { timeout: 20_000 }).toContain('譯：');
  expect(localServer.requests.length).toBeGreaterThan(0);
  const first = localServer.requests[0];
  expect(first.headers.authorization).toBe('Bearer DX-TOKEN');
  expect(first.body.target_lang).toMatch(/^ZH-HAN[TS]$/);
  // 原文段落都翻到了
  const text = await page.locator('article').innerText();
  expect(text).toContain('譯：Ekiden is a long-distance relay race');
  // toast 顯示實際引擎名稱（上游字串寫死 Google）
  const toasts = await evaluate('JSON.stringify(window.__toastLog)');
  const log = JSON.parse(toasts);
  expect(log.some(([type, msg]) => type === 'success' && /DeepLX/.test(msg))).toBe(true);
  // 「[Google MT]」是使用者在主要設定頁取的預設標籤，不是引擎名稱，去掉後不應再出現 Google
  expect(log.some(([, msg]) => /Google/.test(msg.replace(/^\[[^\]]*\]\s*/, '')))).toBe(false);
});

test('預設 3 未設定時維持上游 Google 行為（不呼叫驛傳引擎）', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/article.html`);
  const evaluate = await isolatedEvaluator(page);
  const sel = await evaluate('window.__SK.forkResolvePreset(3, "google")');
  expect(sel).toEqual({});
  expect(localServer.requests.length).toBe(0);
});
