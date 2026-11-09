// Regression: inline-prose-wrapper(inline 格式化元素直接當 prose 容器補抓)
//
// Fixture: test/regression/fixtures/inline-prose-wrapper.html
//
// Bug(2026-06-08 forum.miata.net):vBulletin 主貼文結構為
//   <div class="post_message"><b>主文段1<br><br>主文段2…</b><div class="bbcodestyle">引用 table</div></div>
// <b> 直接包整段主文(以 <br> 分段),掛在非-block 的 post_message DIV 下;其唯一 block
// 祖先 TD 因 containsBlockDescendant(內含引用 TD)被結構性跳過。<b> 既非 CONTAINER_TAGS
//(Case B/C)也非 SPAN(Case D/E),walker 非-block 分支 Case A-F 全 miss;leaf 補抓只收
// div/span:not(:has(*)) 與 a → <b> 完全漏抓。實測單頁 25 篇貼文中 5 篇命中此結構,主文不翻、
// 引用區塊(block table)卻有翻 — 正是使用者回報的「部分內容沒翻譯」。
//
// 修法:collectParagraphs 末段加 inline-prose 補抓(querySelectorAll
// 'b, strong, i, em, u, font, mark, cite'),hasBlockAncestor 守門(structurallySkipped /
// widgetRejected 的 block 不算祖先,讓孤兒 <b> 撈得回、一般 <p> 內 <b> 不誤命中),
// push element unit 讓 <br> 走 sentinel 序列化、譯文注入回原 <b>(§15)。
//
// stats.inlineProseWrapper counter 是 forcing function:刪掉整段補抓 / 退回舊行為 counter 歸零。
//
// SANITY 紀錄(已驗證):暫時把 content-detect.js 新增的 inline-prose 補抓整段移除後,
// 第 1 條(target-b 命中 + inlineProseWrapper>=1)fail;還原後 pass。負向對照
// target-inside-p / target-short 在修法前後都 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inline-prose-wrapper';

test('孤兒 <b> 主文(post_message > b + 引用)應被收成 element 單元', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-b', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-b');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);

      const bUnit = units.find(u =>
        u.kind === 'element' && u.el?.tagName === 'B'
      );
      // 引用內文(block TD)也應被正常收集(畫面上引用有翻、主文沒翻 → 兩者都要在)
      const quoteCaught = units.some(u =>
        (u.el?.textContent || '').includes('I do not think the track mode')
      );

      return {
        unitCount: units.length,
        bUnitFound: !!bUnit,
        bUnitHead: bUnit ? (bUnit.el.textContent || '').trim().slice(0, 40) : null,
        quoteCaught,
        inlineProseWrapper: stats.inlineProseWrapper || 0,
        stats,
      };
    })()
  `);

  expect(
    result.bUnitFound,
    `孤兒 <b> 主文應被收成 element 單元,實際 unitCount=${result.unitCount}\nstats=${JSON.stringify(result.stats)}`,
  ).toBe(true);

  expect(
    result.inlineProseWrapper,
    `stats.inlineProseWrapper 應 >= 1,實際 ${result.inlineProseWrapper}\nstats=${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  expect(result.bUnitHead).toContain("I'm pretty amateur");

  expect(
    result.quoteCaught,
    `引用內文(block TD)應同時被收集,stats=${JSON.stringify(result.stats)}`,
  ).toBe(true);

  await page.close();
});

test('負向對照:已收集 <p> block prose 內的 <b> 強調不應重複收成獨立 unit', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-inside-p', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-inside-p');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const pCaught = units.some(u => u.kind === 'element' && u.el?.tagName === 'P');
      const bCaught = units.some(u => u.kind === 'element' && u.el?.tagName === 'B');
      return {
        unitCount: units.length,
        pCaught,
        bCaught,
        inlineProseWrapper: stats.inlineProseWrapper || 0,
      };
    })()
  `);

  // P 本身是 block prose → 被正常收集;P 內的 <b> 不應額外成 unit(hasBlockAncestor 守門)
  expect(result.pCaught, `<p> 應被收集,unitCount=${result.unitCount}`).toBe(true);
  expect(
    result.bCaught,
    `<p> 內的 <b> 強調不應重複收成獨立 unit,inlineProseWrapper=${result.inlineProseWrapper}`,
  ).toBe(false);
  expect(result.inlineProseWrapper).toBe(0);

  await page.close();
});

test('整條路徑:收集到的 <b> 序列化+注入後譯文就地替換、<br> 保留(§15 single mode)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-b', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 模擬 LLM 譯文:三段以 \n\n 分隔(對應原 <b> 內 <br><br> 兩處分段),
  // deserialize 應把 \n 還原回 <br>。
  const translation = '我承認我相當業餘\n\n我不想失控或犯錯\n\n預設模式下保姆系統不讓你動分毫';
  await runTestInject(evaluate, '#target-b b', translation);

  const after = await evaluate(`
    (() => {
      const b = document.querySelector('#target-b b');
      return {
        exists: !!b,
        tag: b?.tagName,
        html: b?.innerHTML || '',
        text: (b?.textContent || '').trim(),
      };
    })()
  `);

  // §15:譯文必須注入回原 <b>(不另起 sibling wrapper),原文消失
  expect(after.exists, '<b> 應仍存在(就地替換,非另建 wrapper)').toBe(true);
  expect(after.text).toContain('我承認我相當業餘');
  expect(after.text).not.toContain('amateur');
  // <br> 透過 sentinel 流程還原(\n → <br>)
  expect(after.html.toLowerCase()).toContain('<br');

  await page.close();
});

test('負向對照:孤兒 <b> 但無字母內容(純標點)不應命中', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-short', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-short');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const bCaught = units.some(u => u.kind === 'element' && u.el?.tagName === 'B');
      return { bCaught, inlineProseWrapper: stats.inlineProseWrapper || 0 };
    })()
  `);

  expect(
    result.bCaught,
    `無字母內容(純標點)的 <b> 不應被 inline-prose 補抓命中`,
  ).toBe(false);
  expect(result.inlineProseWrapper).toBe(0);

  await page.close();
});
