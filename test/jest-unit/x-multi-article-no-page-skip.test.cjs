'use strict';

/**
 * v1.9.26 regression: X 多 article 整頁 skip 已移除
 *
 * Bug:X SPA 頁面常有多個 <article>(主推文 + 上輪 Shinkansen 譯文殘留 / X 自家翻譯版)。
 *   原本 content.js translatePage 入口的「整頁 skip」path 用
 *   `document.querySelector('article')` 抽 pageSample,抓**第一個** article(可能是繁中)
 *   → `isAlreadyInTarget` 命中 → 整頁 skip + 跳「此頁面已是繁體中文,不需翻譯」toast,
 *   簡中原文也跟著不翻。
 *
 *   實際使用者報告:https://x.com/philipinspain/status/2056152770298675234
 *   article[0]=繁中(來源不明,可能 X 翻譯 / 殘留)、article[2]=原始簡中。
 *
 * 修法(v1.9.26):translatePage 入口的整頁 skip 機制全拿掉(Gemini + Google MT 兩條 path),
 *   改靠 paragraph-level `isCandidateText` 逐段判定(zh-Hant 段被跳、zh-Hans 段照常翻)。
 *   連帶移除 storage.skipTraditionalChinesePage / options UI / i18n toast 字串等
 *   全套相關 code 路徑。
 *
 * 測試策略:整頁 skip 是「行為消失」型修法,沒有可正向驗的行為,且 jsdom 環境 layout
 *   API 不完整(collectParagraphs / getBoundingClientRect 等)。改用 structural 驗 —
 *   grep content.js + storage.js + options.js + i18n.js 內舊 code path 都不存在(避免
 *   未來誤回滾 / 部分 revert)。SANITY:任一檢查項加回對應 code 就 fail。
 *
 *   雙向偵測本身(`SK.detectTextLang`)沒改,既有 detect-lang-* spec 涵蓋。
 *
 * SANITY 紀錄(已驗證):暫時把整頁 skip block 從 git show v1.9.25 拿回貼進 content.js,
 *   本 spec 4 條全 fail(`/skipTraditionalChinesePage/` 命中、`/isAlreadyInTarget\(pageSample/`
 *   命中等);還原 → 全 pass。
 */

const fs = require('fs');
const path = require('path');

const SHINKANSEN_DIR = path.resolve(__dirname, '../../shinkansen');

function readSrc(rel) {
  return fs.readFileSync(path.join(SHINKANSEN_DIR, rel), 'utf-8');
}

describe('v1.9.26: X 多 article 整頁 skip 已移除', () => {
  test('content.js:translatePage 入口無 `skipTraditionalChinesePage` 設定讀取', () => {
    const code = readSrc('content.js');
    // 排除註解(註解內可能 reference 名稱當紀錄),只看 active code
    // 簡化:source 全文 grep,允許註解內存在
    const activeRefs = code.split('\n').filter(line => {
      const trimmed = line.trim();
      // 移除單行註解開頭的行
      if (trimmed.startsWith('//')) return false;
      return /skipTraditionalChinesePage/.test(line);
    });
    expect(activeRefs).toEqual([]);
  });

  test('content.js:translatePage 入口無 `SK.isAlreadyInTarget(pageSample` 整頁 skip 呼叫', () => {
    const code = readSrc('content.js');
    expect(code).not.toMatch(/SK\.isAlreadyInTarget\s*\(\s*pageSample/);
  });

  test('content.js:translatePage 入口無 `toast.alreadyInTarget` toast 呼叫', () => {
    const code = readSrc('content.js');
    // 註解內可能保留 marker,只 check active code(非 // 開頭)
    const activeRefs = code.split('\n').filter(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) return false;
      return /toast\.alreadyInTarget/.test(line);
    });
    expect(activeRefs).toEqual([]);
  });

  test('lib/storage.js DEFAULT_SETTINGS 已無 `skipTraditionalChinesePage` 預設值', () => {
    const code = readSrc('lib/storage.js');
    const activeRefs = code.split('\n').filter(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) return false;
      return /skipTraditionalChinesePage/.test(line);
    });
    expect(activeRefs).toEqual([]);
  });

  test('options.js sanitizeImport + readSettings 已無 `skipTraditionalChinesePage`', () => {
    const code = readSrc('options/options.js');
    expect(code).not.toMatch(/skipTraditionalChinesePage/);
  });

  test('options.html 已無 `#skipTraditionalChinesePage` checkbox', () => {
    const code = readSrc('options/options.html');
    expect(code).not.toMatch(/skipTraditionalChinesePage/);
  });

  test('lib/i18n.js 8 語 dict 全已移除 `toast.alreadyInTarget` + `options.langDetect.*` 三條 key', () => {
    const code = readSrc('lib/i18n.js');
    expect(code).not.toMatch(/toast\.alreadyInTarget/);
    expect(code).not.toMatch(/options\.langDetect\.heading/);
    expect(code).not.toMatch(/options\.langDetect\.skipInTarget/);
    expect(code).not.toMatch(/options\.langDetect\.skipInTargetHint/);
  });
});
