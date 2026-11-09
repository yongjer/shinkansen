'use strict';

/**
 * v1.10.46 批次 5-7d（code review 2026-06-11）：JS 端 i18n key 引用存在性 forcing function。
 *
 * 背景：content.js / content-spa.js / content-toast.js 約 12 處 toast 硬編繁中字串
 * （en 使用者看到中文 toast）改走 SK.t(key) + 8 語 dict。i18n-sync-check skill 驗
 * 「dict 8 語 key 集合 / placeholder / data-i18n 引用」,但明示**不驗 JS 端 SK.t('key')
 * 字面引用的 key 是否存在於 dict**（刪 key 漏改 JS、或 JS 加 key 漏加 dict 的方向）。
 * 本 spec 補這層:靜態掃所有 extension JS 的 SK.t('...') / _t('...') 字面 key,
 * 斷言全部存在於 zh-TW dict（source of truth;8 語對齊由 i18n-sync-check 驗）。
 *
 * 訊號層界定:只驗「字面字串 key」;動態組出來的 key（變數 / 三元式選 key）掃不到,
 * 那個方向靠相關行為 spec。也不驗 dict 內容品質。
 *
 * SANITY 紀錄（已驗證,2026-06-11）：暫時把 content.js 一處 SK.t('toast.done') 改成
 * SK.t('toast.doneXXX') → fail（列出缺 key 與檔案）；還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../shinkansen');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'lib/i18n.js'), 'utf-8');

// zh-TW dict block(source of truth)的所有 key
function zhTWKeys() {
  const start = I18N_SRC.indexOf('=== ZH_TW_DICT_START ===');
  const end = I18N_SRC.indexOf('=== ZH_TW_DICT_END ===');
  const block = I18N_SRC.slice(start, end === -1 ? I18N_SRC.indexOf('messages_zhCN') : end);
  const keys = new Set();
  for (const m of block.matchAll(/^\s*'([^']+)':/gm)) keys.add(m[1]);
  return keys;
}

// 掃 JS 檔內 SK.t('key') / _t('key') / t('key', / i18n.t('key') 的字面 key
function collectReferencedKeys() {
  const refs = []; // { file, key }
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (['vendor', 'node_modules'].includes(name)) continue;
        walk(full);
      } else if (name.endsWith('.js') && name !== 'i18n.js') {
        files.push(full);
      }
    }
  };
  walk(ROOT);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/(?:SK\.t|_t|i18n\.t)\(\s*'([^']+)'/g)) {
      refs.push({ file: path.relative(ROOT, f), key: m[1] });
    }
  }
  return refs;
}

describe('5-7d: JS 端 SK.t / _t 字面 key 必須存在於 zh-TW dict', () => {
  test('所有字面引用的 key 都在 dict（無 dangling reference）', () => {
    const dict = zhTWKeys();
    expect(dict.size).toBeGreaterThan(100); // dict 解析失敗防呆
    const refs = collectReferencedKeys();
    expect(refs.length).toBeGreaterThan(50); // 掃描失敗防呆
    const missing = refs.filter((r) => !dict.has(r.key));
    expect(missing).toEqual([]);
  });

  test('本批新增的 toast key 真的被 JS 引用（防 dict 加了沒接線）', () => {
    const refs = new Set(collectReferencedKeys().map((r) => r.key));
    for (const k of ['toast.done', 'toast.doneTruncated', 'toast.donePartial',
      'toast.allCacheHit', 'toast.translateRemaining',
      'toast.googleDone', 'toast.googleDoneTruncated', 'toast.googleFreeDetail',
      'toast.rescanPartialFailed', 'toast.rescanDone', 'toast.updateNoticeLink',
      'toast.welcomeNotice.html', 'toast.elapsedSec', 'toast.elapsedMinSec',
      'toast.autoTranslateLabel']) {
      expect(refs.has(k)).toBe(true);
    }
  });
});
