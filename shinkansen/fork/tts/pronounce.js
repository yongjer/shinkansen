// fork/tts/pronounce.js — 自訂讀音表：朗讀前把指定詞換成讀音
//
// 每一筆 { term, mode, value }：
//   mode 'ipa'      value 是 IPA（不含斜線），送 Gemini 時寫成 /IPA/ 放回原位
//   mode 'respell'  value 是拼讀式改寫（例如 "toe-MAH-toe"），直接取代原詞
//
// 注意：Gemini 3.8 TTS 官方文件（2026-11 查閱）沒有寫明 /IPA/ 語法，實際效果請用設定頁的
// 「試聽」確認；不理想時改用拼讀式改寫（見 docs/FORK-NOTES.md R-12）。
// 瀏覽器內建語音（speechSynthesis）不認 IPA，只套用拼讀式改寫。

export const PRONUNCIATIONS_KEY = 'forkPronunciations'; // storage.local
export const MAX_PRONUNCIATIONS = 200;
const MAX_TERM = 80;
const MAX_VALUE = 160;

const WORD_CHAR = /[\p{L}\p{N}_]/u;
// 拉丁 / 西里爾 / 希臘字母組成的詞才做「整詞」比對；中日韓文字沒有詞界，直接比對子字串
const WORDLIKE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}'’\- ._]+$/u;

function cleanIpa(v) {
  // 使用者可能連斜線或方括號一起貼上；內部的斜線會讓 /…/ 提早結束，一律拿掉
  return String(v || '').trim().replace(/^[/[]+|[/\]]+$/g, '').replace(/\//g, '').trim();
}

export function sanitizePronunciations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const term = typeof e.term === 'string' ? e.term.trim().slice(0, MAX_TERM) : '';
    const mode = e.mode === 'respell' ? 'respell' : 'ipa';
    let value = typeof e.value === 'string' ? e.value.trim().slice(0, MAX_VALUE) : '';
    if (mode === 'ipa') value = cleanIpa(value);
    // 角括號會被 TTS 當成行內標籤（例如 <short pause>），讀音欄位不允許
    value = value.replace(/[<>]/g, '');
    if (!term || !value) continue;
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ term, mode, value });
    if (out.length >= MAX_PRONUNCIATIONS) break;
  }
  return out;
}

function findAll(haystack, needle, { wordlike }) {
  const hits = [];
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return hits;
  let from = 0;
  while (from <= h.length - n.length) {
    const i = h.indexOf(n, from);
    if (i < 0) break;
    const end = i + n.length;
    const okLeft = !wordlike || i === 0 || !WORD_CHAR.test(haystack[i - 1]);
    const okRight = !wordlike || end === haystack.length || !WORD_CHAR.test(haystack[end]);
    if (okLeft && okRight) hits.push([i, end]);
    from = i + 1;
  }
  return hits;
}

/**
 * 套用讀音表。長的詞優先；已被較長詞佔用的位置不再比對。不分大小寫。
 * @param {string} text
 * @param {Array} entries  sanitizePronunciations 的結果
 * @param {object} [opts]
 * @param {'gemini'|'browser'} [opts.engine]  browser = 只套用拼讀式改寫
 * @returns {{ text: string, applied: string[] }}
 */
export function applyPronunciations(text, entries, { engine = 'gemini' } = {}) {
  const src = String(text || '');
  const list = sanitizePronunciations(entries)
    .filter((e) => engine === 'gemini' || e.mode === 'respell')
    .sort((a, b) => b.term.length - a.term.length);
  if (!src || !list.length) return { text: src, applied: [] };

  const claimed = []; // [start, end, replacement, term]
  const overlaps = (s, e) => claimed.some(([cs, ce]) => s < ce && e > cs);
  for (const entry of list) {
    const wordlike = WORDLIKE.test(entry.term);
    for (const [s, e] of findAll(src, entry.term, { wordlike })) {
      if (overlaps(s, e)) continue;
      const replacement = entry.mode === 'ipa' ? `/${entry.value}/` : entry.value;
      claimed.push([s, e, replacement, entry.term]);
    }
  }
  if (!claimed.length) return { text: src, applied: [] };
  claimed.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  const applied = new Set();
  for (const [s, e, rep, term] of claimed) {
    out += src.slice(pos, s) + rep;
    pos = e;
    applied.add(term);
  }
  out += src.slice(pos);
  return { text: out, applied: [...applied] };
}
