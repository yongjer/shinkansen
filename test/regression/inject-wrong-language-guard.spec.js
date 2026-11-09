// Regression: inject-wrong-language-guard（對應 v2.0.2 修的「目標設德文卻出現中文譯文」bug）
//
// Fixture: test/regression/fixtures/wrong-language-guard.html
// 結構：最小英文來源段落 <p id="target">。
// Bug：使用者把目標語言設德文翻譯英文網站，部分段落（實測混語頁面 + Gemini Flash Lite
//   temperature=1.0 隨機性）掉回繁體中文。快取 key 已按目標語言分（_langde），harness
//   6 輪確定性排除跨語言快取污染 / glossary 洩漏；根因是間歇性 LLM 掉語言。
// 修法（結構性通則，§8）：注入入口 SK.injectTranslation 加「輸出語言守門」——目標為拉丁
//   字母語言(en/es/fr/de)時，整段譯文是東亞文字(CJK/假名/韓文音節) = 必為掉語言，不注入、
//   保留原文。判斷邏輯單一資料源在 content-detect.js 的 SK.isWrongLanguageOutput，自數
//   East-Asian 字元比例（不走 detectTextLang，避免其 htmlLang 短路在 ja/ko 頁誤判德文）。
//
// SANITY 紀錄（已驗證）：把 content-inject.js injectTranslation 入口的
//   `if (SK.isWrongLanguageOutput(...)) return;` 暫拿掉 → 「德文 target 注入中文被擋、
//   原文保留」斷言 fail（#target 變成中文）→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'wrong-language-guard';
const CHINESE = '敏捷的棕色狐狸跳過懶狗。';
const GERMAN = 'Der schnelle braune Fuchs springt über den faulen Hund.';
const ORIGINAL = 'The quick brown fox jumps over the lazy dog.';

test('wrong-language-guard: 德文 target 收到中文譯文 → 不注入、保留原文；正常德文照注入', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 目標語言設德文（拉丁字母 target）
  await evaluate(`window.__SK.STATE.targetLanguage = 'de'`);

  // (1) 掉語言：注入中文譯文 → 守門攔下 → #target 維持英文原文
  const afterChinese = await evaluate(`(() => {
    const el = document.querySelector('#target');
    window.__shinkansen.testInject(el, ${JSON.stringify(CHINESE)});
    return el.textContent.trim();
  })()`);
  expect(afterChinese).toBe(ORIGINAL);   // 中文被擋，原文保留

  // (2) 正常德文譯文 → 照常注入
  const afterGerman = await evaluate(`(() => {
    const el = document.querySelector('#target');
    window.__shinkansen.testInject(el, ${JSON.stringify(GERMAN)});
    return el.textContent.trim();
  })()`);
  expect(afterGerman).toBe(GERMAN);      // 德文正常替換

  await page.close();
});

// 單一資料源判定函式的分支覆蓋（純函式層，補上 injection path 沒涵蓋的 target / 語系組合）。
//
// SANITY 紀錄（已驗證）：把 isWrongLanguageOutput 的 `ea / letters.length >= 0.5` 暫改成
//   `>= 1.1`（永遠 false）→ deZh / deJa / deKo 斷言 fail（收到 false）→ 還原 → pass。
test('wrong-language-guard: SK.isWrongLanguageOutput 判定分支', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`(() => {
    const f = window.__SK.isWrongLanguageOutput;
    return {
      // 拉丁 target 收到東亞文字 → true（掉語言）
      deZh: f('超過 300 噸的黏土被用於建立壘線。', 'de'),
      deJa: f('すばしっこい茶色の狐が怠け者の犬を飛び越える。', 'de'),
      deKo: f('빠른 갈색 여우가 게으른 개를 뛰어넘는다.', 'de'),
      enZh: f('敏捷的棕色狐狸。', 'en'),
      // 拉丁 target 收到正常拉丁譯文 → false
      deLatin: f('Der schnelle braune Fuchs.', 'de'),
      frLatin: f('Le renard brun rapide.', 'fr'),
      // 拉丁 target 但含少量 CJK 專有名詞（<50%）→ false（不誤傷）
      deMostlyLatin: f('Die Firma 中国 ist groß und weltweit tätig heute.', 'de'),
      // CJK / 東亞 target 一律不守（正確輸出本就是該語言）→ false
      zhTwGetsZh: f('敏捷的棕色狐狸跳過懶狗。', 'zh-TW'),
      zhCnGetsZh: f('敏捷的棕色狐狸。', 'zh-CN'),
      jaGetsJa: f('すばしっこい茶色の狐。', 'ja'),
      // 空 / 非字串 → false
      empty: f('', 'de'),
      nullish: f(null, 'de'),
    };
  })()`);

  expect(r.deZh).toBe(true);
  expect(r.deJa).toBe(true);
  expect(r.deKo).toBe(true);
  expect(r.enZh).toBe(true);
  expect(r.deLatin).toBe(false);
  expect(r.frLatin).toBe(false);
  expect(r.deMostlyLatin).toBe(false);
  expect(r.zhTwGetsZh).toBe(false);
  expect(r.zhCnGetsZh).toBe(false);
  expect(r.jaGetsJa).toBe(false);
  expect(r.empty).toBe(false);
  expect(r.nullish).toBe(false);

  await page.close();
});
