// fork/engines/markers.js — 上游 Google MT 序列化標記 ↔ XML 標籤
//
// 上游的機器翻譯路徑（content.js serializeForGoogleTranslate）把連結與不可拆元素
// 標成 【N】…【/N】 與 【*N】，翻譯後再由 restoreGoogleTranslateMarkers 換回。
// Google 端點會原樣保留這些 CJK 括號；DeepL / 微軟有正式的標籤處理模式
// （DeepL tag_handling=xml、微軟 textType=html），把標記換成標籤交給服務處理，
// 譯文裡連結的位置比較不會跑掉。
//
// 標籤命名：成對標記 → <xN>…</xN>，單一標記 → <yN/>。每個編號用不同的標籤名，
// 換回時不需要堆疊配對。標記不成對（理論上不會發生）時整段維持原本的 【】 寫法，
// 只做 XML 跳脫，交給服務當一般文字翻譯。

const PAIRED_OPEN = /【(\d+)】/g;
const PAIRED_CLOSE = /【\/(\d+)】/g;
const ATOMIC = /【\*(\d+)】/g;
const ANY_MARKER = /【(\/|\*)?(\d+)】/g;

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 成對標記是否正確巢狀（開、關一一對應且順序正確）。 */
export function markersBalanced(text) {
  const stack = [];
  for (const m of String(text).matchAll(ANY_MARKER)) {
    const [, kind, n] = m;
    if (kind === '*') continue;
    if (kind === '/') {
      if (stack.pop() !== n) return false;
    } else {
      stack.push(n);
    }
  }
  return stack.length === 0;
}

export function hasMarkers(text) {
  ANY_MARKER.lastIndex = 0;
  return ANY_MARKER.test(String(text));
}

/**
 * 【N】 標記 → XML 標籤。文字內容一律跳脫，避免原文中的 < & 被當成標籤。
 * @returns {string}
 */
export function markersToXml(text) {
  const escaped = escapeXml(text);
  if (!markersBalanced(text)) return escaped;
  return escaped
    .replace(PAIRED_CLOSE, '</x$1>')
    .replace(ATOMIC, '<y$1/>')
    .replace(PAIRED_OPEN, '<x$1>');
}

/**
 * XML 標籤 → 【N】 標記，並還原跳脫字元。
 * 服務可能把 <yN/> 改寫成 <yN></yN> 或 <yN />，三種都接受。
 */
export function xmlToMarkers(text) {
  return unescapeXml(
    String(text)
      .replace(/<y(\d+)\s*\/>/g, '【*$1】')
      .replace(/<y(\d+)\s*><\/y\1\s*>/g, '【*$1】')
      .replace(/<\/x(\d+)\s*>/g, '【/$1】')
      .replace(/<x(\d+)\s*>/g, '【$1】'),
  );
}
