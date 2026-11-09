// Regression: isCandidateText 用 element/ancestor lang attribute 作為 hint,優先於純文字 detect
//
// Bug:Twitter / Reddit / Threads / Mastodon 等社群網站對每則內容標 lang attribute(Twitter
// 對簡中標 "zh"、繁中標 "zh-TW"/"zh-Hant")。Shinkansen 的 detectTextLang 用 SIMPLIFIED_ONLY_CHARS
// 集合,要求 simp/cjk >= 0.2 才判 zh-Hans;對短簡中(< ~30 cjk)集合命中密度只有 8-12%,
// 跨不過閾值 → 預設回 zh-Hant → isAlreadyInTarget('zh-TW') = true → skip 不翻。
// 真實案例:Leesp 的「不如顺势请马嘉祺做咱们的品牌大使...」(33 cjk + 4 simp = 0.121)被誤判 skip。
//
// 修法:isCandidateText 內加 lang attribute hint(getElementLangHint + langHintDecision):
//   - 明確 zh-Hant 系列(zh-Hant / zh-TW / zh-HK / zh-MO)+ target=zh-TW → skip(信 lang)
//   - 明確 zh-Hans 系列(zh / zh-Hans / zh-CN / zh-SG)+ target=zh-TW → translate(覆蓋 SIMP 誤判)
//   - target=zh-CN 對稱
//   - target=en/ja/ko 對應同語言 lang → skip
//   - 沒 lang 或 lang 不對應 → fallback 到純文字 isAlreadyInTarget
//
// SANITY 紀錄(已驗證):暫時把 getElementLangHint 一律 return null → spec「lang=zh 短簡中應翻」
// fail(fallback 純文字 detect 仍誤判 zh-Hant 當 already-in-target)。還原 fix → 全綠。
//
// ── 追加 regression(form named-control .lang 遮蓋,對應 v1.10.66 修)──
// Bug:HTMLFormElement 帶 [LegacyOverrideBuiltIns],表單內有 name="lang" 控制項時
//   form.lang 回傳該控制項(element)而非字串,getElementLangHint 對 form ancestor 走到
//   `cur.lang.toLowerCase()` 直接 throw「cur.lang.toLowerCase is not a function」→
//   整頁翻譯在偵測階段就炸、卡 translating(WordPress email-subscriptions form 實例,
//   實站 militaryrealism.blog 重現)。
// 修法:採用 cur.lang 前先 typeof === 'string' 守衛,非字串 fall through 到 getAttribute('lang')。
// SANITY 紀錄(已驗證):把守衛改回 `if (cur.lang)` → 「form named-control 不 throw」test
//   throw「cur.lang.toLowerCase is not a function」而 fail。還原 fix → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'lang-attr-hint';

test('getElementLangHint 讀 element 自身 lang attribute(lowercase)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-zh-shortsimp', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      return {
        zhshort: SK._getElementLangHint(document.querySelector('#tweet-zh-shortsimp')),
        zhhans: SK._getElementLangHint(document.querySelector('#tweet-zh-hans')),
        zhtw: SK._getElementLangHint(document.querySelector('#tweet-zh-tw')),
        zhhant: SK._getElementLangHint(document.querySelector('#tweet-zh-hant')),
        en: SK._getElementLangHint(document.querySelector('#tweet-en')),
        nolang: SK._getElementLangHint(document.querySelector('#tweet-no-lang')),
      };
    })()
  `);
  expect(result.zhshort).toBe('zh');
  expect(result.zhhans).toBe('zh-hans');
  expect(result.zhtw).toBe('zh-tw');
  expect(result.zhhant).toBe('zh-hant');
  expect(result.en).toBe('en');
  // nolang 在 fixture 內 ancestor body 沒設,但 <html lang="en"> 有 — closest 走到 html 應該命中
  // 但實作 stop at document.body / document.documentElement 之前(看 production code)
  expect(result.nolang === null || result.nolang === 'en').toBe(true);

  await page.close();
});

test('getElementLangHint 從 ancestor 繼承(closest [lang])', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-inherited-zhtw', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      return {
        inherited_zhtw: SK._getElementLangHint(document.querySelector('#tweet-inherited-zhtw')),
        inherited_zh: SK._getElementLangHint(document.querySelector('#tweet-inherited-zh')),
      };
    })()
  `);
  expect(result.inherited_zhtw, '從父 div lang=zh-TW 繼承').toBe('zh-tw');
  expect(result.inherited_zh, '從父 div lang=zh 繼承').toBe('zh');

  await page.close();
});

test('langHintDecision:target=zh-TW 各 lang 結果', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-zh-shortsimp', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const t = 'zh-TW';
      return {
        zh: SK._langHintDecision('zh', t),
        zhhans: SK._langHintDecision('zh-hans', t),
        zhcn: SK._langHintDecision('zh-cn', t),
        zhsg: SK._langHintDecision('zh-sg', t),
        zhhant: SK._langHintDecision('zh-hant', t),
        zhtw: SK._langHintDecision('zh-tw', t),
        zhhk: SK._langHintDecision('zh-hk', t),
        zhmo: SK._langHintDecision('zh-mo', t),
        en: SK._langHintDecision('en', t),
        ja: SK._langHintDecision('ja', t),
        nullArg: SK._langHintDecision(null, t),
      };
    })()
  `);
  // target=zh-TW:zh-Hans 系列應 translate(覆蓋 SIMP 誤判)
  expect(result.zh).toBe('translate');
  expect(result.zhhans).toBe('translate');
  expect(result.zhcn).toBe('translate');
  expect(result.zhsg).toBe('translate');
  // target=zh-TW:zh-Hant 系列應 skip(已是 target)
  expect(result.zhhant).toBe('skip');
  expect(result.zhtw).toBe('skip');
  expect(result.zhhk).toBe('skip');
  expect(result.zhmo).toBe('skip');
  // 其他 lang 跟 target 不對應 → unknown(走 fallback)
  expect(result.en).toBe('unknown');
  expect(result.ja).toBe('unknown');
  expect(result.nullArg).toBe('unknown');

  await page.close();
});

test('isCandidateText:Leesp 短簡中 lang=zh 應 collected(雙向偵測 + lang hint 雙重保障)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-zh-shortsimp', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK.STATE.targetLanguage = 'zh-TW';
      // v1.9.15 雙向偵測修法後,Leesp 短簡中應已直接判 zh-Hans(不需 lang hint 救援)。
      // lang hint 仍保留為更極端 case 的備援(極短文字 / 命中率為 0 等)。
      const text = document.querySelector('#tweet-zh-shortsimp').textContent.trim();
      const detected = SK.detectTextLang(text);
      const isAlready = SK.isAlreadyInTarget(text, 'zh-TW');
      const r = window.__shinkansen.collectParagraphsWithStats();
      const leespUnit = r.units.find(u => /品牌大使/.test(u.textPreview || ''));
      return {
        detected,
        isAlready,
        textLen: text.length,
        leespCollected: !!leespUnit,
      };
    })()
  `);
  expect(result.detected, 'v1.9.15 雙向偵測後 detectTextLang 應正確判 zh-Hans').toBe('zh-Hans');
  expect(result.isAlready, 'target=zh-TW 對 zh-Hans 文字應回 false(需翻譯)').toBe(false);
  expect(result.leespCollected, 'Leesp 短簡中段應 collected(無論是 detect 直接命中還是 lang hint 救回)').toBe(true);

  await page.close();
});

test('isCandidateText:lang=zh-TW 繁中 tweet 應 skip(信 lang attribute,target=zh-TW)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-zh-tw', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK.STATE.targetLanguage = 'zh-TW';
      const r = window.__shinkansen.collectParagraphsWithStats();
      const zhtwUnit = r.units.find(u => /應 skip 不翻/.test(u.textPreview || ''));
      const zhhantUnit = r.units.find(u => /使用 zh-Hant 標籤/.test(u.textPreview || ''));
      const zhhkUnit = r.units.find(u => /港式繁中/.test(u.textPreview || ''));
      return {
        zhtw: !!zhtwUnit,
        zhhant: !!zhhantUnit,
        zhhk: !!zhhkUnit,
      };
    })()
  `);
  expect(result.zhtw, 'lang=zh-TW 繁中應 skip(不在 units)').toBe(false);
  expect(result.zhhant, 'lang=zh-Hant 應 skip').toBe(false);
  expect(result.zhhk, 'lang=zh-HK 應 skip').toBe(false);

  await page.close();
});

test('getElementLangHint:form 內 name="lang" 控制項遮蓋 .lang 時不 throw', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#text-in-form-named-lang', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // form.lang 被 name="lang" 的 input 遮蓋成 element(非字串)。修法前對 form ancestor
  // 呼叫 .toLowerCase() 會 throw;修法後應 fall through 到 getAttribute('lang')(null)→ 不命中。
  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const el = document.querySelector('#text-in-form-named-lang');
      const form = document.querySelector('#form-named-lang-control');
      let threw = false, hint = 'SENTINEL';
      try { hint = SK._getElementLangHint(el); } catch (e) { threw = true; hint = String(e && e.message); }
      return {
        formLangIsString: typeof form.lang === 'string',
        threw,
        hint,
      };
    })()
  `);
  // 前置確認:這個 fixture 真的觸發 form.lang 被遮蓋(非字串),否則 regression 失去意義
  expect(result.formLangIsString, 'fixture 應讓 form.lang 被 name="lang" 控制項遮蓋成非字串').toBe(false);
  expect(result.threw, 'getElementLangHint 不應 throw').toBe(false);
  expect(result.hint, 'form ancestor 無真實 lang attribute → 應回 null').toBeNull();

  await page.close();
});

test('isCandidateText:沒 lang attribute 維持純文字 detect 行為', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tweet-no-lang', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 沒 lang 的英文 element,純文字 detect 為 'en',target='zh-TW' isAlreadyInTarget=false → 該收
  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK.STATE.targetLanguage = 'zh-TW';
      const r = window.__shinkansen.collectParagraphsWithStats();
      const noLangUnit = r.units.find(u => /English without lang attribute/.test(u.textPreview || ''));
      return { collected: !!noLangUnit };
    })()
  `);
  expect(result.collected, '沒 lang 的英文 element 應走純文字 detect → translate').toBe(true);

  await page.close();
});
