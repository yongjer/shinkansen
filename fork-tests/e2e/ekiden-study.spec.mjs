// 第 2 階段 e2e：劃詞卡片（翻譯、朗讀、重播不發請求、AI 解釋、追問、學習中心）、段落還原、右鍵選單、設定頁
//
// 不連外：Gemini 請求在 service worker 裡攔截（覆寫 self.fetch），回固定的 WAV / JSON；
// 卡片的翻譯用 DeepLX 引擎，送到 fixtures 的本機模擬端點。
import { test, expect, isolatedEvaluator } from './fixtures.mjs';

// 0.1 秒的靜音 WAV（24 kHz、單聲道、16-bit，含 RIFF header）——與 Gemini TTS 預設輸出同格式
function silentWavBase64() {
  const rate = 24000;
  const samples = 2400;
  const dataLen = samples * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  return b.toString('base64');
}

async function installGeminiMock(serviceWorker) {
  await serviceWorker.evaluate((wav) => {
    self.__geminiCalls = [];
    if (!self.__origFetch) self.__origFetch = self.fetch.bind(self);
    const between = (s, a, b) => {
      const i = s.indexOf(a);
      if (i < 0) return '';
      const j = s.indexOf(b, i + a.length);
      return j < 0 ? '' : s.slice(i + a.length, j);
    };
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
    self.fetch = async (url, init = {}) => {
      const u = String(url);
      if (!u.startsWith('https://generativelanguage.googleapis.com/')) return self.__origFetch(url, init);
      const body = JSON.parse(init.body || '{}');
      self.__geminiCalls.push({ url: u, key: (init.headers || {})['x-goog-api-key'], body });
      if (u.endsWith('/interactions')) {
        return json({
          steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav, mime_type: 'audio/wav' }] }],
          usage: { total_input_tokens: 8, total_output_tokens: 3, input_tokens_by_modality: [{ modality: 'text', tokens: 8 }], output_tokens_by_modality: [{ modality: 'audio', tokens: 3 }] },
        });
      }
      const first = body.contents?.[0]?.parts?.[0]?.text || '';
      const sel = between(first, '<selection>\n', '\n</selection>');
      const ctx = between(first, '<context>\n', '\n</context>');
      let out;
      if (body.contents.length > 1) {
        out = { answer: `追問回答：${sel}`, citations: ctx ? [ctx.slice(0, 12)] : [] };
      } else {
        const half = Math.max(1, Math.floor(sel.length / 2));
        out = {
          translation: `模擬譯文：${sel}`,
          meaning: '模擬詞義',
          pronunciation: { ipa: 'ˈmɒk', stress: '重音在第一音節' },
          structure: [{ text: sel.slice(0, half), role: '主語', note: '前半' }, { text: sel.slice(half), role: '述語', note: '後半' }],
          usage: '模擬用法',
          examples: [{ source: 'Example one.', translation: '例句一。' }, { source: 'Example two.', translation: '例句二。' }],
          citations: ctx ? [ctx.slice(0, 15), 'not in the page'] : [],
        };
      }
      return json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
      });
    };
  }, silentWavBase64());
}

const geminiCalls = (sw) => sw.evaluate(() => self.__geminiCalls.map((c) => ({ url: c.url, key: c.key, body: c.body })));

async function setup(serviceWorker, localServer, fork = {}) {
  await installGeminiMock(serviceWorker);
  await serviceWorker.evaluate(async ({ url, fork }) => {
    await chrome.storage.sync.set({
      targetLanguage: 'zh-TW',
      fork: { ...fork, study: { engine: 'deeplx', ...(fork.study || {}) }, mt: { deeplx: { url } } },
    });
    await chrome.storage.local.set({ apiKey: 'TEST-GEMINI-KEY' });
  }, { url: `${localServer.baseUrl}/deeplx`, fork });
}

/** 用滑鼠拖曳選取 selector 第一個元素裡的 phrase。 */
async function dragSelect(page, selector, phrase) {
  const box = await page.evaluate(({ selector, phrase }) => {
    const el = document.querySelector(selector);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.nodeValue.indexOf(phrase);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + phrase.length);
      const rects = r.getClientRects();
      const a = rects[0];
      const z = rects[rects.length - 1];
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: z.right - 1, y2: z.top + z.height / 2 };
    }
    return null;
  }, { selector, phrase });
  if (!box) throw new Error(`phrase not found: ${phrase}`);
  // 先從空白處移過來（滑鼠從 (0,0) 直接跳到字上按下時，整頁翻譯後的第一次短距離拖曳偶爾選不到字）
  await page.mouse.move(box.x1, box.y1 + 200);
  await page.waitForTimeout(50);
  await page.mouse.move(box.x1, box.y1, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move((box.x1 + box.x2) / 2, box.y2, { steps: 4 });
  await page.mouse.move(box.x2, box.y2, { steps: 4 });
  await page.mouse.up();
}

async function clickAct(page, evaluate, act) {
  const pt = await evaluate(`window.__SK._forkStudy.rectOf(${JSON.stringify(act)})`);
  if (!pt) throw new Error(`button not found: ${act}`);
  await page.mouse.click(pt.x, pt.y);
}

const statusText = (evaluate) => evaluate(`(window.__SK._forkStudy.card && window.__SK._forkStudy.card.node.querySelector('.status').textContent) || ''`);

async function openCardBySelecting(page, evaluate, selector, phrase) {
  await dragSelect(page, selector, phrase);
  await expect.poll(() => evaluate('!!window.__SK._forkStudy.iconRect()')).toBe(true);
  const pt = await evaluate('window.__SK._forkStudy.iconRect()');
  await page.mouse.click(pt.x, pt.y);
  await expect.poll(() => evaluate('window.__SK._forkStudy.card && window.__SK._forkStudy.card.snap.text')).toBe(phrase);
}

async function runCardFlow({ page, serviceWorker, selector, phrase, lang, question }) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const evaluate = await isolatedEvaluator(page);
  const t = (key) => evaluate(`window.__SK.t(${JSON.stringify(key)})`);

  await openCardBySelecting(page, evaluate, selector, phrase);
  // 翻譯
  await expect.poll(() => evaluate('window.__SK._forkStudy.card.translation'), { timeout: 15_000 }).toBe(`譯：${phrase}`);
  expect(await evaluate('window.__SK._forkStudy.card.lang')).toBe(lang);

  // 朗讀（正常速度）→ 一次 Interactions 請求
  await clickAct(page, evaluate, 'speak');
  await expect.poll(() => statusText(evaluate), { timeout: 15_000 }).toBe(await t('fork.card.playing'));
  let calls = (await geminiCalls(serviceWorker)).filter((c) => c.url.endsWith('/interactions'));
  expect(calls).toHaveLength(1);
  expect(calls[0].key).toBe('TEST-GEMINI-KEY');
  expect(calls[0].url).not.toContain('TEST-GEMINI-KEY');
  expect(calls[0].body.input[0].content[0].text).toBe(phrase);
  expect(calls[0].body.model).toBe('gemini-3.8-flash-lite-tts');

  // 重播：不發請求
  await clickAct(page, evaluate, 'replay');
  await expect.poll(() => statusText(evaluate)).toBe(await t('fork.card.replaying'));
  // 再按一次朗讀：背景端本機快取命中，也不發請求
  await clickAct(page, evaluate, 'speak');
  await expect.poll(() => statusText(evaluate), { timeout: 10_000 }).toBe(await t('fork.card.playingCached'));
  calls = (await geminiCalls(serviceWorker)).filter((c) => c.url.endsWith('/interactions'));
  expect(calls).toHaveLength(1);

  // 慢速：另一段音訊，語速指示在 style、不在 text
  await clickAct(page, evaluate, 'slow');
  await expect.poll(() => statusText(evaluate), { timeout: 10_000 }).toBe(await t('fork.card.playing'));
  calls = (await geminiCalls(serviceWorker)).filter((c) => c.url.endsWith('/interactions'));
  expect(calls).toHaveLength(2);
  expect(calls[1].body.input[0].content[0].text).toBe(phrase);
  expect(calls[1].body.input[0].content[0].annotations[0].style).toMatch(/slowly/i);

  // AI 解釋
  await clickAct(page, evaluate, 'explain');
  await expect.poll(() => evaluate('!!window.__SK._forkStudy.card.explainCard'), { timeout: 15_000 }).toBe(true);
  const explained = await evaluate(`(() => {
    const c = window.__SK._forkStudy.card;
    const ex = c.node.querySelector('.ex');
    return { text: ex.textContent, chips: ex.querySelectorAll('.chip').length, cites: ex.querySelectorAll('.cite').length, card: c.explainCard };
  })()`);
  expect(explained.text).toContain(`模擬譯文：${phrase}`);
  expect(explained.text).toContain('ˈmɒk');
  expect(explained.chips).toBe(2);
  expect(explained.cites).toBe(1); // 不在頁面上的引用被丟掉
  let gen = (await geminiCalls(serviceWorker)).filter((c) => c.url.includes(':generateContent'));
  expect(gen).toHaveLength(1);
  expect(gen[0].key).toBe('TEST-GEMINI-KEY');
  const userText = gen[0].body.contents[0].parts[0].text;
  expect(userText).toContain('<context>');
  expect(userText).not.toContain('127.0.0.1'); // 只送標題，不送網址

  // 句子結構：方向鍵在片段間移動
  const chip = await evaluate(`(() => { const b = window.__SK._forkStudy.card.node.querySelector('.chip'); b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5 }; })()`);
  await page.mouse.click(chip.x, chip.y);
  await page.keyboard.press('ArrowRight');
  expect(await evaluate(`[...window.__SK._forkStudy.card.node.querySelectorAll('.chip')].map((c) => c.getAttribute('aria-pressed')).join(',')`)).toBe('false,true');

  // 追問
  const ask = await evaluate(`(() => { const i = window.__SK._forkStudy.card.node.querySelector('.ask input'); i.scrollIntoView({ block: 'nearest' }); const r = i.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`);
  await page.mouse.click(ask.x, ask.y);
  await page.keyboard.type(question);
  await page.keyboard.press('Enter');
  await expect.poll(() => evaluate('window.__SK._forkStudy.card.history.length'), { timeout: 15_000 }).toBe(1);
  expect(await evaluate('window.__SK._forkStudy.card.node.querySelector(".qa").textContent')).toContain(`追問回答：${phrase}`);
  gen = (await geminiCalls(serviceWorker)).filter((c) => c.url.includes(':generateContent'));
  expect(gen).toHaveLength(2);
  expect(gen[1].body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
  expect(gen[1].body.contents[2].parts[0].text).toContain(question);
  // 卡片還開著（追問輸入框的按鍵沒有被頁面的快速鍵吃掉）
  expect(await evaluate('!!window.__SK._forkStudy.card')).toBe(true);

  // 加入學習中心
  await clickAct(page, evaluate, 'save');
  await expect.poll(() => statusText(evaluate)).toBe(await t('fork.card.saved'));

  expect(errors).toEqual([]);
  return evaluate;
}

test('劃詞卡片（英文）：翻譯、朗讀、重播不發請求、AI 解釋、追問、加入學習中心', async ({ context, serviceWorker, localServer }) => {
  await setup(serviceWorker, localServer);
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/article.html`);
  const evaluate = await runCardFlow({
    page, serviceWorker, selector: 'article p', phrase: 'long-distance relay race', lang: 'en', question: 'Why "relay"?',
  });
  expect(await evaluate(`browser.runtime.sendMessage({ type: 'FORK_LEARN_COUNT' })`)).toEqual({ ok: true, count: 1 });
});

test('劃詞卡片（日文）：翻譯、朗讀、重播不發請求、AI 解釋、追問', async ({ context, serviceWorker, localServer }) => {
  await setup(serviceWorker, localServer);
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/ja.html`);
  await runCardFlow({
    page, serviceWorker, selector: 'article p', phrase: '長距離リレー競走', lang: 'ja', question: '「競走」と「競争」の違いは？',
  });
});

test('沒有 Gemini 金鑰：朗讀改用瀏覽器內建語音，不發 Gemini 請求', async ({ context, serviceWorker, localServer }) => {
  await setup(serviceWorker, localServer);
  await serviceWorker.evaluate(() => chrome.storage.local.remove('apiKey'));
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/article.html`);
  const evaluate = await isolatedEvaluator(page);
  await evaluate(`(() => {
    window.__spoken = [];
    window.speechSynthesis.speak = (u) => window.__spoken.push({ text: u.text, rate: u.rate, lang: u.lang });
  })()`);
  await openCardBySelecting(page, evaluate, 'article p', 'relay race');
  await clickAct(page, evaluate, 'slow');
  await expect.poll(() => statusText(evaluate)).toBe(await evaluate('window.__SK.t("fork.card.browserVoiceNoKey")'));
  const spoken = await evaluate('window.__spoken');
  // 短字串不交給 CLD 猜（"relay race" 曾被判成塞爾維亞文），以頁面的 lang="en" 為準
  expect(spoken).toEqual([{ text: 'relay race', rate: expect.closeTo(0.65, 5), lang: 'en-US' }]);
  expect(await geminiCalls(serviceWorker)).toEqual([]);
});

test('雙擊與長按觸發；雙向翻譯：已是目標語言時改翻成第二語言', async ({ context, serviceWorker, localServer }) => {
  await setup(serviceWorker, localServer, { study: { trigger: 'dblclick', bidirectional: true, secondLang: 'ja' } });
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/article.html`);
  const evaluate = await isolatedEvaluator(page);
  const word = await page.evaluate(() => {
    const p = document.querySelector('article p');
    const node = p.firstChild;
    const i = node.nodeValue.indexOf('century');
    const r = document.createRange();
    r.setStart(node, i + 2);
    r.setEnd(node, i + 3);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.dblclick(word.x, word.y);
  await expect.poll(() => evaluate('window.__SK._forkStudy.card && window.__SK._forkStudy.card.snap.text')).toBe('century');
  await expect.poll(() => evaluate('window.__SK._forkStudy.card.translation'), { timeout: 15_000 }).toBe('譯：century');

  // 中文段落（已是目標語言 zh-TW）→ 雙向翻譯送 forkTarget ja
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'zh';
    p.textContent = '這是一段已經是繁體中文的句子。';
    document.querySelector('article').appendChild(p);
  });
  await page.keyboard.press('Escape');
  const zh = await page.evaluate(() => {
    const r = document.createRange();
    const node = document.getElementById('zh').firstChild;
    r.setStart(node, 4);
    r.setEnd(node, 5);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  localServer.requests.length = 0;
  await page.mouse.dblclick(zh.x, zh.y);
  await expect.poll(() => evaluate('window.__SK._forkStudy.card && window.__SK._forkStudy.card.translation'), { timeout: 15_000 }).toMatch(/^譯：/);
  expect(localServer.requests.at(-1).body.target_lang).toBe('JA');
  expect(await evaluate('window.__SK._forkStudy.card.node.querySelector(".note").hidden')).toBe(false);

  // 改成長按
  await serviceWorker.evaluate(async () => {
    const { fork } = await chrome.storage.sync.get('fork');
    await chrome.storage.sync.set({ fork: { ...fork, study: { ...fork.study, trigger: 'longpress', longPressMs: 300 } } });
  });
  await expect.poll(() => evaluate('window.__SK._forkStudy.config.study.trigger')).toBe('longpress');
  await page.keyboard.press('Escape');
  await page.mouse.move(word.x, word.y);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect.poll(() => evaluate('window.__SK._forkStudy.card && window.__SK._forkStudy.card.snap.text')).toBe('century');
});

test('段落還原：整頁翻譯後只把一段還原成原文，其他段落維持譯文；整頁還原後標記清掉', async ({ context, serviceWorker, localServer }) => {
  await setup(serviceWorker, localServer, { presetEngines: { 1: '', 2: '', 3: 'deeplx' } });
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/article.html`);
  const evaluate = await isolatedEvaluator(page);
  await evaluate('window.__SK.handleTranslatePreset(3)');
  // 等三段都翻完（翻譯寫回 DOM 時會清掉進行中的選取）
  await expect.poll(async () => (await page.locator('article p').allInnerTexts()).every((t) => t.startsWith('譯：')), { timeout: 20_000 }).toBe(true);

  await openCardBySelecting(page, evaluate, 'article p:nth-of-type(2)', 'sash');
  await expect.poll(() => evaluate('!!window.__SK._forkStudy.rectOf("restore")')).toBe(true);
  await clickAct(page, evaluate, 'restore');
  await expect.poll(() => page.locator('article p').nth(1).innerText()).toBe('Each runner carries a sash and hands it to the next runner at the relay station.');
  expect(await page.locator('article p').nth(1).getAttribute('translate')).toBe('no');
  expect(await page.locator('article p').first().innerText()).toContain('譯：');
  expect(await page.locator('article p').nth(2).innerText()).toContain('譯：');

  // 整頁還原（再按一次同一組預設）
  await evaluate('window.__SK.handleTranslatePreset(3)');
  await expect.poll(() => page.locator('article p').first().innerText()).not.toContain('譯：');
  expect(await page.locator('article p').nth(1).getAttribute('translate')).toBeNull();
});

test('右鍵選單：預設建立三個項目，設定頁關閉後移除', async ({ serviceWorker }) => {
  const exists = (id) => serviceWorker.evaluate((id) => new Promise((resolve) => {
    chrome.contextMenus.update(id, {}, () => resolve(!chrome.runtime.lastError));
  }), id);
  await expect.poll(() => exists('ekiden-translate-selection')).toBe(true);
  expect(await exists('ekiden-translate-page')).toBe(true);
  expect(await exists('ekiden-restore-paragraph')).toBe(true);
  await serviceWorker.evaluate(() => chrome.storage.sync.set({ fork: { study: { contextMenu: false } } }));
  await expect.poll(() => exists('ekiden-translate-selection')).toBe(false);
});

test('驛傳設定頁：劃詞卡片區塊、讀音表存到 local、試聽、學習中心筆數', async ({ context, extensionId, serviceWorker, localServer }) => {
  await setup(serviceWorker, localServer);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extensionId}/fork/pages/settings.html`);

  await expect(page.locator('#sec-study h2')).toHaveText('Selection card');
  await expect(page.locator('#study-trigger option')).toHaveCount(6);
  await expect(page.locator('#tts-model option')).toHaveCount(2);
  await expect(page.locator('#tts-model')).toHaveValue('gemini-3.8-flash-lite-tts');
  await expect(page.locator('#tts-voice option')).toHaveCount(30);
  await expect(page.locator('#study-engine')).toHaveValue('deeplx');
  // 觸發方式切換時只顯示相關欄位
  await expect(page.locator('[data-show-trigger="select"]')).toBeVisible();
  await expect(page.locator('[data-show-trigger="longpress"]')).toBeHidden();
  await page.locator('#study-trigger').selectOption('longpress');
  await expect(page.locator('[data-show-trigger="longpress"]')).toBeVisible();
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.sync.get('fork')).fork.study.trigger)).toBe('longpress');

  // 讀音表
  await page.locator('#pron-add').click();
  await page.locator('.pron-row input[data-pron-field="term"]').fill('GIF');
  await page.locator('.pron-row input[data-pron-field="value"]').fill('/dʒɪf/');
  await page.locator('.pron-row input[data-pron-field="value"]').blur();
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.local.get('forkPronunciations')).forkPronunciations), { timeout: 5000 })
    .toEqual([{ term: 'GIF', mode: 'ipa', value: 'dʒɪf' }]);

  // 試聽（讀音表套用後送出）
  await page.locator('#tts-sample').fill('A GIF file');
  await page.locator('#tts-try').click();
  await expect(page.locator('#tts-result')).toContainText('Played');
  const calls = (await geminiCalls(serviceWorker)).filter((c) => c.url.endsWith('/interactions'));
  expect(calls.at(-1).body.input[0].content[0].text).toBe('A /dʒɪf/ file');

  // 複製段落譯文的快速鍵：錄製組合鍵
  await page.locator('#para-copy-shortcut').click();
  await page.keyboard.press('Alt+KeyY');
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.sync.get('fork')).fork.paragraph.copyShortcut))
    .toEqual({ code: 'KeyY', alt: true, shift: false, ctrl: false, meta: false });

  await expect(page.locator('#learn-count')).toContainText('0');
  expect(errors).toEqual([]);
});

test('Alt+C 複製游標所在段落的譯文', async ({ context, serviceWorker, localServer }) => {
  await setup(serviceWorker, localServer, { presetEngines: { 1: '', 2: '', 3: 'deeplx' } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: localServer.baseUrl });
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/article.html`);
  const evaluate = await isolatedEvaluator(page);
  await evaluate('window.__SK.handleTranslatePreset(3)');
  await expect.poll(() => page.locator('article p').nth(2).innerText(), { timeout: 20_000 }).toContain('譯：');
  const box = await page.locator('article p').nth(2).boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.keyboard.press('Alt+KeyC');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('譯：Spectators line the roads');
});
