// fork/content/paragraph-tools.js — 段落工具：還原單一段落、複製段落譯文、懸停翻譯的停留時間
//
// 掛在 window.__SK 上提供：
//   SK.forkParagraph.find(node)      node 所在的已翻譯段落 → { el, kind, wrapper? } | null
//   SK.forkParagraph.restore(hit)    只把這一段還原成原文
//   SK.forkParagraph.blockOf(node)   node 所在的段落元素（不論是否翻譯過）
//   SK.forkHoverRestMs()             content-hover.js 掛鉤點讀取的停留時間（預設與上游相同 150 ms）
//   SK.forkAfterRestorePage()        content.js restorePage 掛鉤點：整頁還原後清掉本檔加的標記
//
// 還原單一段落：上游只有整頁還原（content.js restoreInjectedDom），三種注入方式
// （single 覆蓋 / dual 雙語 wrapper / framework 段落的 nodeValue 改寫）各有簿記。本檔照同樣的
// 規則只處理一個元素，並把它從 Content Guard 與 SPA 重用表（translatedHTMLByText）移除，
// 免得被自動補回。另外在元素上加 translate="no"（上游偵測層會跳過），SPA 重新掃描時
// 不會再翻這一段；整頁還原時移除。

(function (SK) {
  'use strict';
  if (!SK || SK.__ekidenParagraphLoaded) return;
  SK.__ekidenParagraphLoaded = true;
  const STATE = SK.STATE;

  const DEFAULTS = { hoverRestMs: 150, copyShortcut: { code: 'KeyC', alt: true, shift: false, ctrl: false, meta: false } };
  let cfg = { ...DEFAULTS };
  let upstreamShortcuts = {};

  function applyFork(fork) {
    const p = (fork && fork.paragraph) || {};
    const ms = Number(p.hoverRestMs);
    cfg = {
      hoverRestMs: Number.isFinite(ms) && ms >= 0 && ms <= 2000 ? ms : DEFAULTS.hoverRestMs,
      copyShortcut: p.copyShortcut === null ? null : (p.copyShortcut && p.copyShortcut.code ? p.copyShortcut : DEFAULTS.copyShortcut),
    };
  }

  try {
    browser.storage.sync.get(['fork', 'customShortcuts']).then((r) => {
      applyFork(r && r.fork);
      upstreamShortcuts = (r && r.customShortcuts) || {};
    }).catch(() => {});
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.fork) applyFork(changes.fork.newValue);
      if (changes.customShortcuts) upstreamShortcuts = changes.customShortcuts.newValue || {};
    });
  } catch (_) { /* 沒有 storage（測試頁）就用預設值 */ }

  SK.forkHoverRestMs = () => cfg.hoverRestMs;

  // ── 找段落 ──────────────────────────────────────────────
  const BLOCK_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'FIGCAPTION', 'CAPTION', 'PRE', 'ARTICLE', 'SECTION', 'MAIN', 'ASIDE', 'DIV', 'SUMMARY']);

  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function blockOf(node) {
    let el = elementOf(node);
    while (el && el !== document.body && el !== document.documentElement) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      let display = '';
      try { display = getComputedStyle(el).display; } catch (_) { /* detached */ }
      if (display === 'block' || display === 'list-item' || display === 'table-cell' || display === 'flex' || display === 'grid') return el;
      el = el.parentElement;
    }
    return elementOf(node);
  }

  function find(node) {
    const el = elementOf(node);
    if (!el || !el.closest) return null;
    const tag = SK.TRANSLATION_WRAPPER_TAG;
    const cache = STATE && STATE.translationCache;
    const wrapper = tag ? el.closest(tag) : null;
    if (wrapper && cache) {
      for (const [orig, info] of cache) {
        if (info && info.wrapper === wrapper) return { el: orig, kind: 'dual', wrapper };
      }
    }
    const dual = el.closest('[data-shinkansen-dual-source]');
    if (dual && cache && cache.get(dual)) return { el: dual, kind: 'dual', wrapper: cache.get(dual).wrapper };
    const single = el.closest('[data-shinkansen-translated]');
    if (single && STATE.originalHTML && STATE.originalHTML.has(single)) return { el: single, kind: 'single' };
    const nv = el.closest('[data-shinkansen-nodevalue-mutated]');
    if (nv && STATE.nodeValueMutateBackup && STATE.nodeValueMutateBackup.has(nv)) return { el: nv, kind: 'nv' };
    return null;
  }

  // ── 還原單一段落 ──────────────────────────────────────────
  const marked = new Set();

  function forgetEl(el) {
    const text = STATE.originalText && STATE.originalText.get(el);
    if (text && STATE.translatedHTMLByText) STATE.translatedHTMLByText.delete(text);
    if (STATE.originalHTML) STATE.originalHTML.delete(el);
    if (STATE.translatedHTML) STATE.translatedHTML.delete(el);
    if (STATE.originalText) STATE.originalText.delete(el);
    if (STATE.originalLang) STATE.originalLang.delete(el);
    if (STATE.originalFontFamily) STATE.originalFontFamily.delete(el);
  }

  function restore(hit) {
    if (!hit || !hit.el) return false;
    const el = hit.el;
    if (hit.kind === 'dual') {
      try { hit.wrapper && hit.wrapper.remove(); } catch (_) { /* 已被移除 */ }
      el.removeAttribute('data-shinkansen-dual-source');
      if (STATE.translationCache) STATE.translationCache.delete(el);
      // dual 的原段落 innerHTML 沒被改過；萬一被改過才寫回
      const orig = STATE.originalHTML && STATE.originalHTML.get(el);
      // AMO source review: orig 是本擴充功能翻譯前自己存下的 el.innerHTML，不含使用者輸入
      if (typeof orig === 'string' && el.innerHTML !== orig) el.innerHTML = orig;
    } else if (hit.kind === 'nv') {
      const backup = STATE.nodeValueMutateBackup.get(el) || [];
      backup.forEach(({ node, originalValue }) => {
        if (node) { try { node.nodeValue = originalValue; } catch (_) { /* node 已失效 */ } }
      });
      STATE.nodeValueMutateBackup.delete(el);
      el.removeAttribute('data-shinkansen-nodevalue-mutated');
    } else {
      const orig = STATE.originalHTML.get(el);
      // AMO source review: 同上，來源是 STATE.originalHTML
      if (typeof orig === 'string' && el.innerHTML !== orig) el.innerHTML = orig;
      el.removeAttribute('data-shinkansen-translated');
    }
    try { SK.restoreLocaleStyling && SK.restoreLocaleStyling(el); } catch (_) { /* 略 */ }
    forgetEl(el);
    if (!el.hasAttribute('translate')) {
      el.setAttribute('translate', 'no');
      marked.add(el);
    }
    return true;
  }

  SK.forkAfterRestorePage = function forkAfterRestorePage() {
    for (const el of marked) {
      try { if (el.getAttribute('translate') === 'no') el.removeAttribute('translate'); } catch (_) { /* 略 */ }
    }
    marked.clear();
  };

  // ── 剪貼簿 ──────────────────────────────────────────────
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 改用 execCommand */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    document.documentElement.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    if (saved && sel) { sel.removeAllRanges(); sel.addRange(saved); }
    return ok;
  }

  function translatedTextOf(hit) {
    if (!hit) return '';
    if (hit.kind === 'dual' && hit.wrapper) return (hit.wrapper.innerText || hit.wrapper.textContent || '').trim();
    return (hit.el.innerText || hit.el.textContent || '').trim();
  }

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  let pointerTarget = null;
  let contextTarget = null;
  document.addEventListener('mousemove', (e) => { pointerTarget = e.target; }, { passive: true, capture: true });
  document.addEventListener('contextmenu', (e) => { contextTarget = e.target; }, { capture: true });

  function sameShortcut(a, b) {
    return !!a && !!b && a.code === b.code && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.ctrl === !!b.ctrl && !!a.meta === !!b.meta;
  }

  document.addEventListener('keydown', (e) => {
    const sc = cfg.copyShortcut;
    const lib = window.__SKShortcuts;
    if (!sc || !lib || e.defaultPrevented || e.repeat || !lib.matches(e, sc)) return;
    // 跟上游自訂的翻譯快速鍵撞鍵時讓上游優先
    if (Object.values(upstreamShortcuts || {}).some((u) => sameShortcut(u, sc))) return;
    if (isEditable(document.activeElement) || isEditable(e.target)) return;
    // 劃詞卡片在 closed shadow root 裡：activeElement 與 target 都被換成宿主元素，看不出是在輸入框打字
    if (SK.forkStudyHost && typeof e.composedPath === 'function' && e.composedPath().includes(SK.forkStudyHost)) return;
    const target = pointerTarget && pointerTarget.isConnected ? pointerTarget : null;
    if (!target || (SK.forkStudyHost && SK.forkStudyHost.contains(target))) return;
    const hit = find(target);
    const text = hit ? translatedTextOf(hit) : ((blockOf(target) || {}).innerText || '').trim();
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    copyText(text).then((ok) => {
      if (!ok) return;
      try {
        SK.showToast('success', SK.t(hit ? 'fork.para.copied' : 'fork.para.copiedOriginal'), { autoHideMs: 1500 });
      } catch (_) { /* toast 失敗不影響複製 */ }
    });
  }, true);

  // 右鍵選單「還原這一段」
  try {
    browser.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'FORK_RESTORE_PARAGRAPH') return undefined;
      const hit = find(contextTarget);
      const ok = restore(hit);
      try {
        SK.showToast(ok ? 'success' : 'error', SK.t(ok ? 'fork.para.restored' : 'fork.para.notTranslated'), { autoHideMs: 2000 });
      } catch (_) { /* 略 */ }
      return undefined;
    });
  } catch (_) { /* 略 */ }

  SK.forkParagraph = { find, restore, blockOf, copyText, translatedTextOf };
})(window.__SK);
