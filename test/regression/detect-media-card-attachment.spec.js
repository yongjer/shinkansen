// Regression: media-card-attachment (v1.4.20 媒體卡片附件圖片保留)
//
// Fixture: test/regression/fixtures/media-card-attachment.html
//
// Bug：XenForo 等論壇的附件 LI 是典型「媒體 + container 子容器」結構：
//   <li>
//     <a class="file-preview"><img></a>
//     <div class="file-content"><span class="file-name">...</span><div class="file-meta">...</div></div>
//   </li>
// LI 在 BLOCK_TAGS_SET，內部又無 H/P/LI 等 block 後代
// → containsBlockDescendant = false → walker 把整個 LI 當 element unit
// → injection 時 containsMedia(LI)=true 但 hasContainerChild=true
// → injectIntoTarget `containsMedia && !hasContainerChild` 不成立 → clean-slate
// → 清空所有子元素（含預覽 img）→ 圖片消失。
//
// 修法（content-detect.js acceptNode BLOCK_TAGS 分支）：
// 加條件 `containsMedia(el) && 直屬 CONTAINER_TAGS 子元素` → FILTER_SKIP，
// 讓 walker 往 LI 內部找真正可翻的葉節點（file-meta DIV 等），
// LI 本身不成單元，clean-slate 不會觸發，預覽圖完整保留。
// stats.mediaCardSkip 作 forcing function。
//
// 與 v1.4.17（vBulletin skipBlockWithContainer）的關係：v1.4.17 涵蓋「block 含 CONTAINER
// 子 + 直屬 A」的 forumdisplay 結構；v1.4.20 補全「同類 block 結構但 CONTAINER 裡沒有
// 直屬 A（例如檔名是 span/h4）且本身含媒體」的情境。兩條 skip 互不重疊：v1.4.20 要求
// containsMedia，v1.4.17 要求 CONTAINER 內有直屬 A。正向 fixture 特意用 <span class="file-name">
// 而非 <a>，避免被 v1.4.17 先接走，才能隔離驗證 v1.4.20。
//
// SANITY 紀錄（已驗證）：移除 content-detect.js 新增的 mediaCardSkip 整個 if block 後，
// 正向 test 的第一條（LI 不應被偵測為 element unit）fail（stats 顯示 skipBlockWithContainer/
// blockContainerLink 都未命中，因為 file-name 是 span 沒有 A）；
// 負向對照兩條（無 CONTAINER / 無媒體）在修法前後皆 pass。還原後全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'media-card-attachment';

test('媒體卡片 LI（img + CONTAINER 子容器）應被 FILTER_SKIP，不當 element unit', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-attachment', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-attachment');
      const li = root.querySelector('li.attachment');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const hasLiAsUnit = units.some(u => u.kind === 'element' && u.el === li);
      const unitTexts = units.map(u => {
        if (u.kind === 'fragment') {
          let t = '';
          let n = u.startNode;
          while (n) {
            t += n.textContent || '';
            if (n === u.endNode) break;
            n = n.nextSibling;
          }
          return t.trim();
        }
        return (u.el.innerText || '').trim();
      });
      const hasInnerLeaf = unitTexts.some(t => t.includes('2.3 MB') && t.includes('admin'));
      return {
        unitCount: units.length,
        hasLiAsUnit,
        hasInnerLeaf,
        unitTexts,
        mediaCardSkip: stats.mediaCardSkip || 0,
        stats,
      };
    })()
  `);

  // 斷言 1：LI 本身不該被收為 element unit（否則 clean-slate 會清掉預覽圖）
  expect(
    result.hasLiAsUnit,
    `LI 不應被收為 element unit，unitCount=${result.unitCount}\nunitTexts=${JSON.stringify(result.unitTexts)}\nstats=${JSON.stringify(result.stats)}`,
  ).toBe(false);

  // 斷言 2：forcing counter：mediaCardSkip 至少命中一次
  expect(
    result.mediaCardSkip,
    `stats.mediaCardSkip 應 >= 1，實際 ${result.mediaCardSkip}\nstats=${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 3：內部葉節點（file-meta DIV）仍應被偵測，不讓整個卡片被忽略
  expect(
    result.hasInnerLeaf,
    `LI 內部葉節點（file-meta）應被偵測，unitTexts=${JSON.stringify(result.unitTexts)}`,
  ).toBe(true);

  // 斷言 4：img 仍在 DOM 中（偵測階段不會動 DOM，但順便 sanity）
  const imgStillPresent = await page.evaluate(
    `!!document.querySelector('#target-attachment img[src="/preview.jpg"]')`
  );
  expect(imgStillPresent, 'preview img 應仍在 DOM').toBe(true);

  await page.close();
});

test('負向對照：LI 含 img 但無 CONTAINER 子容器，照原路徑走（不誤攔）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-plain-li-with-img', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-plain-li-with-img');
      const li = root.querySelector('li');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const hasLiAsUnit = units.some(u => u.kind === 'element' && u.el === li);
      return {
        unitCount: units.length,
        hasLiAsUnit,
        mediaCardSkip: stats.mediaCardSkip || 0,
      };
    })()
  `);

  // 這種 LI 沒有 CONTAINER 子容器（直接 text + inline img），不該走 mediaCardSkip，
  // 該照原 BLOCK_TAGS 路徑當成 element unit 翻譯。
  expect(
    result.hasLiAsUnit,
    `含 img 但無 CONTAINER 子容器的 LI 應正常當 element unit。unitCount=${result.unitCount} mediaCardSkip=${result.mediaCardSkip}`,
  ).toBe(true);
  expect(
    result.mediaCardSkip,
    `不該觸發 mediaCardSkip，實際 ${result.mediaCardSkip}`,
  ).toBe(0);

  await page.close();
});

test('負向對照：LI 含 CONTAINER 子容器但無媒體，照原路徑走（不誤攔）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-li-container-no-media', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-li-container-no-media');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      return {
        unitCount: units.length,
        mediaCardSkip: stats.mediaCardSkip || 0,
      };
    })()
  `);

  expect(
    result.mediaCardSkip,
    `無媒體元素的 LI 不該觸發 mediaCardSkip，實際 ${result.mediaCardSkip}`,
  ).toBe(0);

  await page.close();
});
