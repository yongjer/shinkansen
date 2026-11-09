// Regression: code-wrapped-heading(對應「文章內部標題沒被翻譯」bug,v2.0.62 修)
//
// Fixture: test/regression/fixtures/code-wrapped-heading.html
// 結構:<h2><code>heading text</code></h2> — 區塊全部文字都在一顆 inline <code> 內
//(某些 CMS 把 code 格式當標題樣式,CSS 蓋掉後視覺上是一般標題)。
// Bug:inline <code> 一律 atomic slot → unit payload 只剩「⟦*0⟧」,模型無字可翻
// 原樣返還 → echo 偵測標記已翻,標題永遠停在原文。
// 修法:序列化後殘餘文字(去佔位符)不含字母/數字、且實質文字全在 CODE atomic slot
// 內 → 重跑讓 CODE 走 paired 標記,文字進 payload、wrapper 保留
//(content-serialize.js allTextLockedInCodeSlots + codeAsPaired 重跑,LLM/GT 兩路徑)。
//
// SANITY 紀錄(已驗證 2026-07-21):
//   1. serializeNodeIterable 重跑條件改 `if (false && …)` → 第 1 條(payload 不含
//      標題文字)與第 3 條(注入後 code 內文非譯文)fail
//   2. serializeNodeIterableForGoogle 重跑條件同樣關掉 → 第 4 條 fail
//   3. 兩處還原 → 4 條全 pass;控制組(prose inline code atomic)兩態皆 pass
//   4. `git diff shinkansen/` 確認破壞動作無殘影
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'code-wrapped-heading';
const HEADING = 'h2#code-heading';
const PROSE = 'p#prose-with-code';

test('code-wrapped-heading: 全文在 <code> 內的區塊,序列化必須讓文字進 payload(paired 而非 atomic)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(HEADING, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(HEADING)});
      const { text, slots } = window.__shinkansen.serialize(el);
      return JSON.stringify({
        text,
        slotCount: slots.length,
        slotShapes: slots.map((s) => ({
          atomic: !!(s && s.atomic),
          tag: s && s.atomic ? s.node.tagName : (s && s.tagName) || 'unknown',
        })),
      });
    })()
  `);
  const parsed = JSON.parse(result);

  // 斷言 1: 標題文字本身必須出現在 payload(bug 態是整串只剩 ⟦*0⟧)
  expect(
    parsed.text,
    `標題文字應進 payload,實際 text="${parsed.text}"`,
  ).toContain('Who will take over the role?');

  // 斷言 2: CODE 走 paired 標記(⟦0⟧…⟦/0⟧),slot 是非 atomic 的 CODE shell
  expect(/⟦0⟧.*⟦\/0⟧/.test(parsed.text)).toBe(true);
  expect(parsed.slotShapes[0]).toEqual({ atomic: false, tag: 'CODE' });

  await page.close();
});

test('code-wrapped-heading: 控制組 — prose 段落內 inline <code> 仍維持 atomic 保護', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(PROSE, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(PROSE)});
      const { text, slots } = window.__shinkansen.serialize(el);
      return JSON.stringify({
        text,
        atomicCount: slots.filter((s) => s && s.atomic).length,
      });
    })()
  `);
  const parsed = JSON.parse(result);

  // prose 內 identifier 不進 payload(維持確定性保護,不受重跑機制影響)
  expect(/⟦\*\d+⟧/.test(parsed.text)).toBe(true);
  expect(parsed.text).not.toContain('fetchData()');
  expect(parsed.atomicCount).toBe(2);

  await page.close();
});

test('code-wrapped-heading: 注入譯文後 <code> wrapper 保留且內文已翻成中文', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(HEADING, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await runTestInject(evaluate, HEADING, translation);

  const after = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(HEADING)});
      const code = el.querySelector('code');
      return JSON.stringify({
        outerHTML: el.outerHTML,
        codeText: code ? code.textContent : null,
      });
    })()
  `);
  const parsed = JSON.parse(after);

  // <code> wrapper 存活(站方樣式掛在 code 上,消失會跑版)
  expect(parsed.codeText, `注入後 <code> 應存活,outerHTML=${parsed.outerHTML}`).not.toBeNull();
  // 內文已是譯文
  expect(parsed.codeText).toContain('誰將接任這個職位');

  await page.close();
});

test('code-wrapped-heading: Google MT serializer 同 pattern(【N】paired,文字進 payload)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(HEADING, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(HEADING)});
      const { text, slots } = window.__SK.serializeForGoogleTranslate(el);
      return JSON.stringify({ text, slotCount: slots.length });
    })()
  `);
  const parsed = JSON.parse(result);

  expect(parsed.text).toContain('Who will take over the role?');
  expect(/【0】.*【\/0】/.test(parsed.text)).toBe(true);

  await page.close();
});
