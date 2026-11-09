// Regression: bbwrapper-inline-link (v1.4.19 Case C — bbWrapper 純行內段落偵測)
//
// Fixture: test/regression/fixtures/bbwrapper-inline-link.html
//
// Bug：XenForo bbWrapper 一種常見結構——DIV 含直接文字 + 行內 <a>，
// 沒有任何 block 子孫，也沒有 <br>。例如：
//   <div class="bbWrapper">There is actually <a>some evidence</a> to support...</div>
// Case A（v1.4.7，containsBlockDescendant）fail、Case B（v1.4.9，hasBrChild）fail，
// walker 直接 FILTER_SKIP，整段 TEXT + inline 子孫完全不會進結果 → 頁面顯示英文。
//
// 修法（v1.4.19）：在 acceptNode 的非 BLOCK_TAGS 分支再加一條 else if（Case C），
// 與 Case B 對稱但把「必須有 BR」換成「有直接文字 + inline 元素」——條件 4 重：
//   (1) tag in CONTAINER_TAGS（DIV/SECTION/ARTICLE/MAIN/ASIDE，排除 inline）
//   (2) hasDirectText（有直接 TEXT 子節點 >= 2 字）
//   (3) directTextLength(el) >= 20（排除 nav 短連結：nav 的文字藏在 <a> 內，
//       直接文字長度趨近 0）
//   (4) isCandidateText 通過
// 匹配時呼叫 extractInlineFragments → 一個 fragment unit 涵蓋整段 inline run。
//
// stats.inlineMixedFragment 計數 forcing function：此 counter 名字綁定 Case C
// 的語意（「mixed text + inline」），實作若退回整段變 element 會讓 counter 歸零。
//
// SANITY 紀錄（已驗證）：移除 content-detect.js 新增的 Case C else if 整段後，
// 第 1 條（hasInlineRunFrag）與第 2 條（inlineMixedFragment >= 1）同時 fail；
// 還原後 pass。負向對照 nav 短連結 test 在修法前後都 pass（Case B、C 的
// directTextLength >= 20 門檻都把它擋掉）。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'bbwrapper-inline-link';

test('Case C: bbWrapper 含直接文字 + inline <a>（無 block/BR）應被偵測為 fragment', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-c', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-c');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');

      // 收集每個 fragment 的文字（依 startNode → endNode 串起 textContent）
      const fragTexts = fragments.map(f => {
        let t = '';
        let n = f.startNode;
        while (n) {
          t += n.textContent || '';
          if (n === f.endNode) break;
          n = n.nextSibling;
        }
        return t.trim();
      });

      // 期望的 fragment 文字應同時涵蓋直接 TEXT（"There is actually"、
      // " to support..."）與 inline <a> 內文（"some evidence"）——被連成一個 run
      const hasInlineRunFrag = fragTexts.some(t =>
        t.includes('There is actually') &&
        t.includes('some evidence') &&
        t.includes('to support')
      );

      return {
        fragmentCount: fragments.length,
        fragTexts,
        hasInlineRunFrag,
        inlineMixedFragment: stats.inlineMixedFragment || 0,
        stats,
      };
    })()
  `);

  // 斷言 1：整段「直接文字 + inline <a>」應串成一個 fragment
  expect(
    result.hasInlineRunFrag,
    `Case C: bbWrapper 應被偵測為 fragment（涵蓋文字 + <a>），實際 fragmentCount=${result.fragmentCount}\nfragTexts=${JSON.stringify(result.fragTexts)}\nstats=${JSON.stringify(result.stats)}`,
  ).toBe(true);

  // 斷言 2：stats.inlineMixedFragment 計數 >= 1（forcing function：Case C 邏輯被觸發過）
  expect(
    result.inlineMixedFragment,
    `Case C: stats.inlineMixedFragment 應 >= 1，實際 ${result.inlineMixedFragment}\nstats=${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});

test('Case C 負向對照：nav 短連結（directTextLength < 20）不應被誤抓', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-short-nav', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-short-nav');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      // 若 Case C 門檻被放寬，nav 內的「Foo」會被抓進結果
      const hasShortNavFrag = fragments.some(f => {
        let t = '';
        let n = f.startNode;
        while (n) {
          t += n.textContent || '';
          if (n === f.endNode) break;
          n = n.nextSibling;
        }
        return t.trim() === 'Foo';
      });
      return {
        fragmentCount: fragments.length,
        hasShortNavFrag,
        inlineMixedFragment: stats.inlineMixedFragment || 0,
      };
    })()
  `);

  // Case C 的 directTextLength >= 20 門檻必須擋住這類短連結容器
  expect(
    result.hasShortNavFrag,
    `nav 短連結不應被 Case C 誤抓，fragmentCount=${result.fragmentCount} inlineMixedFragment=${result.inlineMixedFragment}`,
  ).toBe(false);

  await page.close();
});
