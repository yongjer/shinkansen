// Regression: inline-code-preserve(對應「段落內 inline <code> 翻譯後底色 / 文字消失」bug)
//
// Fixture: test/regression/fixtures/inline-code-preserve.html
// 結構特徵(通用,不綁站名):
//   <p>...inline <code>identifier</code>...</p>(GitHub PR description / 技術文章 /
//   Markdown backtick 渲染都是這形狀)
//
// 修法前的 bug:
//   content-serialize.js 兩個 serializer(LLM + Google MT)都先檢查
//   HARD_EXCLUDE_TAGS(內含 'CODE')就 continue,inline <code> 整顆被丟掉:
//     - serializer 輸出 text 缺少 <code> 對應 placeholder
//     - slots 不包含 <code>
//     - Gemini 拿不到 identifier 文字 → 譯文回來沒對應 atomic 標記能還原
//     - 注入後 DOM 內 <code> 完全消失,GitHub 那種 grey background 也跟著沒了
//
// 修法:
//   serializeNodeIterable + serializeNodeIterableForGoogle 在 HARD_EXCLUDE 檢查前
//   先處理 inline <code> → 用 atomic preserve 機制(⟦*N⟧ 標記),slot 存整顆
//   cloneNode(true)。Walker 入口處的 HARD_EXCLUDE 仍擋頂層 CODE / PRE+CODE 程式碼
//   區塊不變,inline 路徑單獨開洞。
//
// 斷言基於結構特徵(段落內 inline element 必須跨翻譯保留),不綁站點/class,符合 §6 / §8。
//
// SANITY 紀錄(已驗證 2026-05-05):
//   1. serializer 內 inline CODE → atomic 處理拿掉 → serialize 輸出無 ⟦*N⟧ 標記、
//      slots.length === 0 → spec fail
//   2. content-ns.js hasPreservableInline 內 inline CODE 短路移除 → 對只含 <code>
//      子元素的 <p> 回 false → translateUnits 走 el.innerText 純文字早返回路徑,
//      serializer 完全沒呼叫 → 第 2 條 spec fail。**這條是真正抓到 GitHub PR
//      description 失效的關鍵**——只測 serializer 不夠,因為生產路徑根本進不去 serializer。
//   3. 還原兩層 → ⟦*N⟧ 標記出現、slots.length === 3、注入後 <code> 仍在 DOM → pass
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'inline-code-preserve';
const TARGET_SELECTOR = 'p#with-code';

test('inline-code-preserve: 序列化必須把 inline <code> 保成 atomic slot', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const { text, slots } = window.__shinkansen.serialize(el);
      return JSON.stringify({
        text,
        slotCount: slots.length,
        slotTags: slots.map((s) => (s && s.atomic ? s.node.tagName : (s && s.tagName) || 'unknown')),
        slotTexts: slots.map((s) => {
          const node = s && s.atomic ? s.node : s;
          return node && node.textContent ? node.textContent : '';
        }),
      });
    })()
  `);
  const parsed = JSON.parse(result);

  // 斷言 1: text 含 atomic 標記(⟦*N⟧),代表 <code> 被當成 atomic slot 保留
  expect(
    /⟦\*\d+⟧/.test(parsed.text),
    `serialize 輸出應含 atomic 標記 ⟦*N⟧,實際 text="${parsed.text}"`,
  ).toBe(true);

  // 斷言 2: slot 數量 = fixture 內 <code> 數量(3 個)
  expect(parsed.slotCount, `應有 3 個 slot,實際 ${parsed.slotCount}`).toBe(3);

  // 斷言 3: slot 內容對應原 inline code 的 identifier 文字
  expect(parsed.slotTexts.join('|')).toContain('fetchData()');
  expect(parsed.slotTexts.join('|')).toContain('config.json');
  expect(parsed.slotTexts.join('|')).toContain('renderUI()');

  await page.close();
});

test('inline-code-preserve: hasPreservableInline 必須對只含 <code> 的 <p> 回 true(否則生產路徑早返回純文字,跳過 serializer)', async ({
  context,
  localServer,
}) => {
  // 為什麼這條斷言獨立存在:translateUnits 在呼叫 serialize 之前會先做
  // hasPreservableInline 短路檢查,只含 <code> 的 <p> 若回 false 整顆 element
  // 走 el.innerText.trim() + slots:[] 純文字路徑,前一條 spec(直接呼叫 serialize)
  // 偵測不到。必須兩層斷言才能鎖死真實生產路徑。
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const hasInline = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      return window.__SK.hasPreservableInline(el);
    })()
  `);

  expect(
    hasInline,
    'hasPreservableInline 對只含 <code> 子元素的 <p> 必須回 true(否則 translateUnits 早返回純文字 → serializer 完全沒被呼叫到)',
  ).toBe(true);

  await page.close();
});

test('inline-code-preserve: 注入譯文後 <code> 元素與識別字必須保留', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);

  const after = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const codes = Array.from(el.querySelectorAll('code')).map((c) => c.textContent);
      return JSON.stringify({
        outerHTML: el.outerHTML,
        codeTexts: codes,
        codeCount: codes.length,
      });
    })()
  `);
  const parsed = JSON.parse(after);

  // 斷言 1: 注入後 DOM 仍有 3 個 <code> 元素(底色 / class 等樣式靠 element 存活而保留)
  expect(parsed.codeCount, `注入後 <code> 元素應有 3 個,實際 ${parsed.codeCount}。outerHTML=${parsed.outerHTML}`).toBe(3);

  // 斷言 2: 每個 <code> 內文還是原英文識別字(不被翻譯)
  expect(parsed.codeTexts).toContain('fetchData()');
  expect(parsed.codeTexts).toContain('config.json');
  expect(parsed.codeTexts).toContain('renderUI()');

  // 斷言 3: 段落本體已翻成中文(控制組:inline preserve 不影響整段翻譯)
  expect(parsed.outerHTML).toContain('函式');
  expect(parsed.outerHTML).toContain('回傳');

  await page.close();
});
