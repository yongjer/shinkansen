'use strict';

/**
 * v1.2.0 regression: fragment rescan 無限迴圈
 *
 * Bug：Wikipedia 等頁面翻譯完成後 SPA observer rescan 不斷觸發，
 *      toast「已翻譯 N 段新內容」無限重複出現。
 *
 * 根因：fragment 類型的翻譯單位注入後，父元素不帶 data-shinkansen-translated，
 *       collectParagraphs 的 extractInlineFragments 在 rescan 時重新收集
 *       已翻成繁中的 fragment（CJK 字元通過 regex 檢查），形成無限迴圈。
 *
 * 修法：extractInlineFragments 的 flushRun() 新增 isTraditionalChinese 過濾，
 *       已翻成繁中的 inline run 不再被收集為翻譯單位。
 *
 * 結構通則：任何含 block 後代的 block 元素，其 inline run 翻譯成繁中後，
 *           不應在後續 collectParagraphs 呼叫中被重新收集。
 */

const { createEnv } = require('./helpers/create-env.cjs');

describe('v1.2.0: fragment rescan 無限迴圈', () => {
  let env;

  afterEach(() => {
    if (env) { env.cleanup(); env = null; }
  });

  /**
   * jsdom 不做 layout，所有元素的 getBoundingClientRect 回傳 0，
   * 導致 SK.isVisible 永遠回傳 false。覆寫為 always-true 讓 collectParagraphs 正常運作。
   */
  function mockVisibility() {
    env.window.__SK.isVisible = () => true;
  }

  test('英文 inline run 被收集為 fragment（修復前後皆應通過）', () => {
    env = createEnv({
      html: `<!DOCTYPE html><html lang="en"><head></head><body>
        <ul>
          <li id="parent">
            This is an English text that should be collected as a fragment for translation purposes.
            <p>Another English paragraph inside the list item.</p>
          </li>
        </ul>
      </body></html>`,
    });
    mockVisibility();

    const SK = env.window.__SK;
    const units = SK.collectParagraphs();
    const fragmentUnits = units.filter(u =>
      u.kind === 'fragment' && u.el.id === 'parent'
    );
    expect(fragmentUnits.length).toBeGreaterThan(0);
  });

  test('繁中 inline run 不被收集為 fragment（v1.2.0 修復）', () => {
    env = createEnv({
      html: `<!DOCTYPE html><html lang="en"><head></head><body>
        <ul>
          <li id="parent">
            這是已經翻譯成繁體中文的文字，裡面有足夠多的中文字元可以被偵測到，不應該再被收集。
            <p>This is an English paragraph inside the parent.</p>
          </li>
        </ul>
      </body></html>`,
    });
    mockVisibility();

    const SK = env.window.__SK;
    const units = SK.collectParagraphs();
    const fragmentUnits = units.filter(u =>
      u.kind === 'fragment' && u.el.id === 'parent'
    );
    expect(fragmentUnits.length).toBe(0);
  });

  test('模擬翻譯→rescan：注入繁中後 fragment 不再被重新收集', () => {
    env = createEnv({
      html: `<!DOCTYPE html><html lang="en"><head></head><body>
        <ul>
          <li id="wiki-section">
            The Shinkansen is a network of high-speed railway lines in Japan operated by JR companies.
            <p>It was inaugurated in 1964 with the Tokaido Shinkansen between Tokyo and Osaka.</p>
          </li>
        </ul>
      </body></html>`,
    });
    mockVisibility();

    const SK = env.window.__SK;

    // 第一次收集：英文 inline run → 應被收集為 fragment
    const units1 = SK.collectParagraphs();
    const frags1 = units1.filter(u => u.kind === 'fragment' && u.el.id === 'wiki-section');
    expect(frags1.length).toBeGreaterThan(0);

    // 模擬翻譯注入：把 inline run 的文字節點替換成繁中
    const frag = frags1[0];
    const parent = frag.el;
    let textNode = null;
    for (const child of parent.childNodes) {
      if (child.nodeType === 3 && child.textContent.trim().length > 10) {
        textNode = child;
        break;
      }
    }
    expect(textNode).not.toBeNull();
    textNode.textContent = '新幹線是日本的高速鐵路網絡，由各地的日本鐵路公司營運，以快速和準時聞名於世。';

    // 第二次收集（模擬 SPA observer rescan）：繁中 fragment 不應被重新收集
    const units2 = SK.collectParagraphs();
    const frags2 = units2.filter(u => u.kind === 'fragment' && u.el.id === 'wiki-section');
    expect(frags2.length).toBe(0);
  });
});
