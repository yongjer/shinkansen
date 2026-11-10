// fork/content/study-card.js — 劃詞卡片：譯文、複製、朗讀（正常 / 慢速 / 重播）、加入學習中心、AI 解釋與追問
//
// 觸發方式（驛傳設定頁「劃詞卡片」，fork.study.trigger）：
//   select    選取文字後出現小按鈕（selectMode 'icon'），或直接開卡片（'card'）
//   dblclick  雙擊文字
//   longpress 在文字上按住滑鼠不動（longPressMs）
//   middle    在選取範圍或文字上按滑鼠中鍵（連結上的中鍵照常開新分頁）
//   modifier  按住修飾鍵（modifierKey）拖曳選取
//   off       不自動出現（右鍵選單「翻譯選取文字」仍可用）
//
// 卡片放在 closed Shadow DOM 裡，掛在 <html> 底下（不放 <body>，避免干擾網頁與上游的段落偵測）。
// 翻譯直接送上游既有的 TRANSLATE_BATCH / TRANSLATE_BATCH_GOOGLE / TRANSLATE_BATCH_CUSTOM，
// 與整頁翻譯共用快取、術語表、禁用詞與用量紀錄。朗讀與 AI 解釋走 FORK_TTS / FORK_EXPLAIN
// （fork/bg/study.js）。音訊用 Web Audio 播放（不建立 <audio>，不受網頁 media-src CSP 影響）。

(function (SK) {
  'use strict';
  if (!SK || SK.__ekidenStudyLoaded) return;
  SK.__ekidenStudyLoaded = true;
  const STATE = SK.STATE || {};

  // 與 fork/settings/schema.js FORK_DEFAULTS 相同（content script 不能 import ES module，
  // fork-tests 的 mirror 測試鎖住兩份一致）
  const DEFAULTS = {
    study: { trigger: 'select', selectMode: 'icon', modifierKey: 'alt', longPressMs: 500, engine: 'preset', bidirectional: false, secondLang: 'en' },
    explain: { contextScope: 'paragraph' },
  };
  SK._forkStudyDefaults = DEFAULTS;
  const TRIGGERS = ['select', 'dblclick', 'longpress', 'middle', 'modifier', 'off'];
  const MOD_PROP = { alt: 'altKey', shift: 'shiftKey', ctrl: 'ctrlKey' };
  const MAX_TEXT = 2000;
  const MAX_CONTEXT = 4000;

  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  function applyFork(fork) {
    const st = (fork && fork.study) || {};
    const ex = (fork && fork.explain) || {};
    cfg = {
      study: {
        ...DEFAULTS.study,
        ...st,
        trigger: TRIGGERS.includes(st.trigger) ? st.trigger : DEFAULTS.study.trigger,
        modifierKey: MOD_PROP[st.modifierKey] ? st.modifierKey : DEFAULTS.study.modifierKey,
        longPressMs: Number(st.longPressMs) >= 250 ? Number(st.longPressMs) : DEFAULTS.study.longPressMs,
      },
      explain: { ...DEFAULTS.explain, ...ex },
    };
  }
  try {
    browser.storage.sync.get('fork').then((r) => applyFork(r && r.fork)).catch(() => {});
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.fork) applyFork(changes.fork.newValue);
    });
  } catch (_) { /* 略 */ }

  const t = (key, params) => {
    try { return SK.t(key, params); } catch (_) { return key; }
  };
  const errText = (resp) => {
    try { return SK.i18n.bgErrorMessage(resp) || resp.error || t('common.errorUnknown'); } catch (_) { return (resp && resp.error) || 'error'; }
  };

  async function send(type, payload) {
    try {
      const r = await browser.runtime.sendMessage({ type, payload });
      return r || { ok: false, error: 'no response' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  // ── 語言 ────────────────────────────────────────────────
  function normLang(code) {
    const c = String(code || '').toLowerCase();
    if (!c || c === 'und') return '';
    if (c === 'zh-tw' || c === 'zh-hk' || c.startsWith('zh-hant')) return 'zh-TW';
    if (c.startsWith('zh')) return 'zh-CN';
    return c.split('-')[0];
  }
  const baseOf = (l) => (String(l || '').toLowerCase().startsWith('zh') ? 'zh' : String(l || '').toLowerCase().split('-')[0]);
  // 選取的文字通常很短，CLD（i18n.detectLanguage）對短字串常猜錯（例如把 "relay race" 判成塞爾維亞文）。
  // 判斷順序：
  //   1. 中日韓文字看字元：有假名 → ja、有諺文 → ko；只有漢字時參考所在元素的 lang（日文頁面的漢字詞是日文），
  //      否則依繁簡字形分 zh-TW / zh-CN
  //   2. 其他文字：所在元素（或整頁）的 lang 屬性當提示；CLD 結果與提示同語言、或文字夠長且 CLD 有把握時才採用 CLD
  const TRAD_ONLY = /[們這說會國過還個來時對開關與學實點體發經麼為]/;
  const SIMP_ONLY = /[们这说会国过还个来时对开关与学实点体发经么为]/;
  function hintLang(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    const withLang = el && el.closest ? el.closest('[lang]') : null;
    return normLang((withLang && withLang.getAttribute('lang')) || document.documentElement.lang);
  }
  function scriptLang(text, hint) {
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text) && !/[A-Za-z\u00c0-\u024f\u0400-\u04ff]{3,}/.test(text)) {
      if (hint === 'ja' || hint === 'ko') return hint;
      if (TRAD_ONLY.test(text) && !SIMP_ONLY.test(text)) return 'zh-TW';
      if (SIMP_ONLY.test(text) && !TRAD_ONLY.test(text)) return 'zh-CN';
      if (hint.startsWith('zh')) return hint;
      const target = STATE.targetLanguage || '';
      return target.startsWith('zh') ? target : 'zh-TW';
    }
    return '';
  }
  async function detectLang(text, node) {
    const hint = hintLang(node);
    const byScript = scriptLang(text, hint);
    if (byScript) return byScript;
    try {
      const r = await browser.i18n.detectLanguage(text);
      const top = r && r.languages && r.languages[0];
      if (top && top.language && top.language !== 'und') {
        const n = normLang(top.language);
        if (hint && baseOf(n) === baseOf(hint)) return hint;
        const long = text.length >= 40 || text.split(/\s+/).length >= 6;
        if (!hint || (long && r.isReliable)) return n;
      }
    } catch (_) { /* 用提示 */ }
    return hint || 'en';
  }
  function langName(code) {
    try {
      const ui = (STATE && STATE.uiLanguage) || navigator.language;
      return new Intl.DisplayNames([ui === 'auto' ? navigator.language : ui], { type: 'language' }).of(code) || code;
    } catch (_) {
      return code;
    }
  }
  const BCP47 = { 'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES', fr: 'fr-FR', de: 'de-DE' };

  // ── 選取與段落上下文 ─────────────────────────────────────
  let host = null;
  let root = null;
  const isOurs = (e) => !!host && (e.target === host || (e.composedPath && e.composedPath().includes(host)));

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function snapshotSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    if (isEditable(document.activeElement)) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const anchor = range.commonAncestorContainer;
    const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    if (el && (isEditable(el) || (el.closest && el.closest('input,textarea,[contenteditable=""],[contenteditable="true"]')))) return null;
    if (host && host.contains(el)) return null;
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return { text: text.slice(0, MAX_TEXT), range, rect: copyRect(range.getBoundingClientRect()), endRect: copyRect(rect) };
  }
  function copyRect(r) {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function wordRangeAt(x, y) {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || node.nodeType !== 3 || !node.nodeValue) return null;
    const text = node.nodeValue;
    const langEl = node.parentElement && node.parentElement.closest('[lang]');
    const lang = (langEl && langEl.getAttribute('lang')) || document.documentElement.lang || undefined;
    let start = -1;
    let end = -1;
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      try {
        for (const s of new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)) {
          if (offset >= s.index && offset <= s.index + s.segment.length && s.isWordLike) {
            start = s.index;
            end = s.index + s.segment.length;
            break;
          }
        }
      } catch (_) { /* 改用 regex */ }
    }
    if (start < 0) {
      const re = /[\p{L}\p{N}'’-]/u;
      start = offset;
      end = offset;
      while (start > 0 && re.test(text[start - 1])) start--;
      while (end < text.length && re.test(text[end])) end++;
      if (start === end) return null;
    }
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    // caret API 會吸附到最近的文字；確認游標真的在這個詞上
    const r = range.getBoundingClientRect();
    if (x < r.left - 4 || x > r.right + 4 || y < r.top - 4 || y > r.bottom + 4) return null;
    return range;
  }

  function selectRange(range) {
    const sel = window.getSelection();
    if (!sel) return null;
    sel.removeAllRanges();
    sel.addRange(range);
    return snapshotSelection();
  }

  function pointInSelection(x, y) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    for (const r of sel.getRangeAt(0).getClientRects()) {
      if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
    }
    return false;
  }

  const blockOf = (node) => (SK.forkParagraph ? SK.forkParagraph.blockOf(node) : (node.nodeType === 1 ? node : node.parentElement));
  const wrapperTag = () => (SK.TRANSLATION_WRAPPER_TAG || '').toUpperCase();
  const textOf = (el) => (el && el.tagName !== wrapperTag() ? (el.innerText || el.textContent || '').trim() : '');

  function windowAround(text, needle, max) {
    if (text.length <= max) return text;
    const i = Math.max(0, text.toLowerCase().indexOf(needle.toLowerCase().slice(0, 50)));
    const start = Math.max(0, Math.min(text.length - max, i - Math.floor(max / 2)));
    return text.slice(start, start + max);
  }

  function contextFor(snap, scope) {
    if (scope === 'none' || !snap.range) return { text: '', els: [] };
    const el = blockOf(snap.range.commonAncestorContainer);
    if (!el) return { text: '', els: [] };
    const els = [el];
    if (scope === 'nearby') {
      if (el.previousElementSibling) els.unshift(el.previousElementSibling);
      if (el.nextElementSibling) els.push(el.nextElementSibling);
    }
    const text = els.map(textOf).filter(Boolean).join('\n\n');
    return { text: windowAround(text, snap.text, MAX_CONTEXT), els };
  }

  // ── 音訊 ────────────────────────────────────────────────
  let audioCtx = null;
  let currentSource = null;
  function stopAudio() {
    try { if (currentSource) currentSource.stop(); } catch (_) { /* 已停止 */ }
    currentSource = null;
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) { /* 略 */ }
  }
  async function decodeBase64Audio(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return audioCtx.decodeAudioData(bytes.buffer);
  }
  function playBuffer(buf) {
    stopAudio();
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
    currentSource = src;
  }
  function speakBrowser(text, lang, mode) {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return false;
    stopAudio();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = BCP47[lang] || lang || document.documentElement.lang || 'en-US';
    u.rate = mode === 'slow' ? 0.65 : 1;
    const voice = (synth.getVoices() || []).find((v) => v.lang && baseOf(v.lang) === baseOf(u.lang));
    if (voice) u.voice = voice;
    synth.speak(u);
    return true;
  }

  // ── 卡片 UI ─────────────────────────────────────────────
  const CSS = `
:host { all: initial; }
.wrap { --bg:#fff; --fg:#1d1d1f; --muted:#6b6b70; --bd:#d9d9de; --chip:#f1f1f4; --accent:#0b62d6; --accent-fg:#fff; --hl:#fff2b3; --err:#b3261e;
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Noto Sans TC", "PingFang TC", "Hiragino Sans", "Noto Sans JP", sans-serif; color: var(--fg); }
@media (prefers-color-scheme: dark) {
  .wrap { --bg:#202124; --fg:#e8eaed; --muted:#a0a4ab; --bd:#3c4043; --chip:#2d2f33; --accent:#8ab4f8; --accent-fg:#202124; --hl:#5b4b00; --err:#f28b82; }
}
.icon { position: fixed; z-index: 2147483647; width: 30px; height: 30px; padding: 0; border-radius: 50%; border: 1px solid var(--bd);
  background: var(--bg); box-shadow: 0 2px 8px rgba(0,0,0,.18); cursor: pointer; display: grid; place-items: center; }
.icon img { width: 18px; height: 18px; pointer-events: none; }
.icon:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.card { position: fixed; z-index: 2147483647; box-sizing: border-box; width: min(400px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: auto;
  background: var(--bg); color: var(--fg); border: 1px solid var(--bd); border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.22); padding: 12px 14px; }
.head { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.head .langs { flex: 1; }
.x { border: 0; background: transparent; color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.x:hover { background: var(--chip); }
.src { margin: 6px 0 0; color: var(--muted); font-size: 13px; max-height: 4.6em; overflow: hidden; overflow-wrap: anywhere; }
.tr { margin: 6px 0 0; font-size: 15px; overflow-wrap: anywhere; white-space: pre-wrap; }
.note { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.tools { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tools button, .mini, .ask button, .regen { font: inherit; font-size: 12.5px; border: 1px solid var(--bd); background: var(--bg); color: var(--fg);
  border-radius: 999px; padding: 3px 10px; cursor: pointer; }
.tools button:hover, .mini:hover, .regen:hover { background: var(--chip); }
.tools button[disabled] { opacity: .55; cursor: default; }
.tools .primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.status { min-height: 1.2em; margin-top: 6px; font-size: 12px; color: var(--muted); }
.status[data-state="error"] { color: var(--err); }
.ex { margin-top: 10px; border-top: 1px solid var(--bd); padding-top: 8px; }
.ex h4 { margin: 10px 0 2px; font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: .02em; }
.ex p { margin: 2px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.ipa { font-family: "Charis SIL", "Doulos SIL", "Gentium Plus", "Noto Sans", "Lucida Sans Unicode", system-ui, sans-serif; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.chip { font: inherit; text-align: left; border: 1px solid var(--bd); background: var(--chip); color: var(--fg); border-radius: 8px; padding: 3px 8px; cursor: pointer; }
.chip .role { display: block; font-size: 11px; color: var(--muted); }
.chip[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.chipnote { margin-top: 4px; font-size: 13px; min-height: 1.2em; }
.hint { font-size: 11px; color: var(--muted); }
.exs { margin: 2px 0 0; padding-left: 18px; }
.exs li { margin: 3px 0; }
.exs .t { color: var(--muted); display: block; }
.mini { padding: 0 6px; margin-left: 4px; font-size: 11px; }
.cite { font: inherit; font-size: 12.5px; border: 1px dashed var(--bd); background: transparent; color: var(--fg); border-radius: 6px; padding: 2px 6px; cursor: pointer; text-align: left; }
.cite:hover { background: var(--chip); }
.raw { white-space: pre-wrap; font-size: 13px; }
.qa { margin-top: 8px; }
.qa .q { font-weight: 600; margin-top: 8px; }
.ask { display: flex; gap: 6px; margin-top: 8px; }
.ask input { flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 4px 8px; border: 1px solid var(--bd); border-radius: 8px; background: var(--bg); color: var(--fg); }
.row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
`;

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children || [])) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('ekiden-study');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.appendChild(el('style', { text: CSS }));
    root.appendChild(el('div', { class: 'wrap' }));
    document.documentElement.appendChild(host);
    SK.forkStudyHost = host;
  }
  const wrap = () => root.querySelector('.wrap');

  // ── 小按鈕（trigger 'select' + 'icon'）───────────────────
  let iconEl = null;
  let iconSnap = null;
  function hideIcon() {
    if (iconEl) iconEl.remove();
    iconEl = null;
    iconSnap = null;
  }
  function showIcon(snap) {
    ensureHost();
    hideIcon();
    iconSnap = snap;
    let src = '';
    try { src = browser.runtime.getURL('icons/icon-48.png'); } catch (_) { /* 擴充功能已重新載入 */ }
    const img = el('img', { alt: '', src });
    img.addEventListener('error', () => { img.remove(); iconEl && (iconEl.textContent = '譯'); });
    iconEl = el('button', { class: 'icon', type: 'button', 'aria-label': t('fork.card.iconLabel'), title: t('fork.card.iconLabel') }, [img]);
    // mousedown 不讓頁面的選取被清掉
    iconEl.addEventListener('mousedown', (e) => e.preventDefault());
    iconEl.addEventListener('click', (e) => {
      e.preventDefault();
      const s = iconSnap;
      hideIcon();
      if (s) openCard(s);
    });
    const r = snap.endRect;
    const x = Math.min(window.innerWidth - 38, Math.max(4, r.right + 4));
    const y = r.bottom + 36 < window.innerHeight ? r.bottom + 4 : Math.max(4, r.top - 34);
    iconEl.style.left = `${x}px`;
    iconEl.style.top = `${y}px`;
    wrap().appendChild(iconEl);
  }

  // ── 卡片狀態 ────────────────────────────────────────────
  let card = null; // { node, snap, lang, ctx, translation, explainCard, history, lastClip, ... }

  function closeCard() {
    stopAudio();
    if (card && card.node) card.node.remove();
    card = null;
    clearCiteHighlight();
  }

  function setStatus(text, state) {
    if (!card) return;
    const s = card.node.querySelector('.status');
    s.textContent = text || '';
    if (state) s.dataset.state = state;
    else delete s.dataset.state;
  }

  function position() {
    if (!card) return;
    const n = card.node;
    const r = card.snap.rect;
    const w = n.offsetWidth;
    const h = n.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = Math.min(Math.max(8, r.left), vw - w - 8);
    let top = r.bottom + 8;
    if (top + h > vh - 8) {
      const above = r.top - 8 - h;
      top = above >= 8 ? above : Math.max(8, vh - 8 - h);
    }
    n.style.left = `${Math.max(8, left)}px`;
    n.style.top = `${top}px`;
  }

  function toolButton(name, labelKey, onClick, extra) {
    return el('button', { type: 'button', 'data-act': name, onclick: onClick, ...(extra || {}) }, [t(labelKey)]);
  }

  async function openCard(snap) {
    ensureHost();
    hideIcon();
    closeCard();
    const target = STATE.targetLanguage || 'zh-TW';
    const ctx = contextFor(snap, cfg.explain.contextScope);
    const hit = SK.forkParagraph && snap.range ? SK.forkParagraph.find(snap.range.startContainer) : null;
    const node = el('div', { class: 'card', role: 'dialog', 'aria-label': t('fork.card.dialogLabel') });
    card = { node, snap, lang: '', ctx, translation: '', explainCard: null, history: [], lastClip: null, hit, target, busy: {} };
    const thisCard = card;

    const langs = el('span', { class: 'langs' }, ['…']);
    node.appendChild(el('div', { class: 'head' }, [
      langs,
      el('button', { class: 'x', type: 'button', 'aria-label': t('fork.card.close'), title: t('fork.card.close'), onclick: closeCard }, ['×']),
    ]));
    node.appendChild(el('p', { class: 'src', text: snap.text }));
    const tr = el('p', { class: 'tr', 'aria-live': 'polite' }, [t('fork.card.translating')]);
    node.appendChild(tr);
    const note = el('p', { class: 'note', hidden: true });
    node.appendChild(note);

    const tools = el('div', { class: 'tools' });
    tools.appendChild(toolButton('speak', 'fork.card.speak', () => speak('normal')));
    tools.appendChild(toolButton('slow', 'fork.card.slow', () => speak('slow')));
    tools.appendChild(toolButton('replay', 'fork.card.replay', () => speak('replay')));
    tools.appendChild(toolButton('copy', 'fork.card.copy', copyTranslation));
    tools.appendChild(toolButton('save', 'fork.card.save', saveToLearn));
    tools.appendChild(toolButton('explain', 'fork.card.explain', () => runExplain(false), { class: 'primary' }));
    if (hit) tools.appendChild(toolButton('restore', 'fork.card.restore', restoreParagraph));
    node.appendChild(tools);
    node.appendChild(el('div', { class: 'status', role: 'status' }));
    node.appendChild(el('div', { class: 'ex', hidden: true }));
    wrap().appendChild(node);
    position();

    const lang = await detectLang(snap.text, snap.range ? snap.range.commonAncestorContainer : null);
    if (card !== thisCard) return;
    card.lang = lang;
    langs.textContent = `${langName(lang)} → ${langName(target)}`;
    try {
      const r = await translateSnippet(snap.text, lang);
      if (card !== thisCard) return;
      card.translation = r.text;
      tr.textContent = r.text || '—';
      if (r.forkTarget) {
        langs.textContent = `${langName(lang)} → ${langName(r.forkTarget)}`;
        note.hidden = false;
        note.textContent = t('fork.card.bidiNote', { lang: langName(lang), second: langName(r.forkTarget) });
      }
    } catch (err) {
      if (card !== thisCard) return;
      tr.textContent = '';
      setStatus(err.message || String(err), 'error');
    }
    position();
  }

  // ── 翻譯 ────────────────────────────────────────────────
  async function resolveEngine() {
    const sel = cfg.study.engine || 'preset';
    if (sel === 'preset') {
      let presets = SK.DEFAULT_PRESETS || [];
      try {
        const r = await browser.storage.sync.get('translatePresets');
        if (Array.isArray(r.translatePresets) && r.translatePresets.length) presets = r.translatePresets;
      } catch (_) { /* 用預設 */ }
      const p = presets.find((x) => x && x.slot === 2) || { engine: 'google' };
      const forkSel = (SK.forkResolvePreset && await SK.forkResolvePreset(2, p.engine)) || {};
      if (p.engine === 'google') return { kind: 'mt', mtEngine: forkSel.mtEngine || 'google' };
      if (p.engine === 'openai-compat') return { kind: 'custom', modelOverride: forkSel.modelOverride || null };
      return { kind: 'gemini', model: p.model || null };
    }
    if (sel === 'gemini') return { kind: 'gemini', model: null };
    if (sel === 'custom') return { kind: 'custom', modelOverride: null };
    if (sel.startsWith('fork-cp:')) return { kind: 'custom', modelOverride: sel };
    return { kind: 'mt', mtEngine: sel };
  }

  async function translateSnippet(text, lang) {
    const eng = await resolveEngine();
    const target = STATE.targetLanguage || 'zh-TW';
    let forkTarget = '';
    if (cfg.study.bidirectional && eng.kind === 'mt' && eng.mtEngine !== 'chrome-translator' && baseOf(lang) === baseOf(target)) {
      const second = cfg.study.secondLang;
      forkTarget = second && baseOf(second) !== baseOf(target) ? second : (baseOf(target) === 'en' ? 'zh-TW' : 'en');
    }
    let resp;
    if (eng.kind === 'mt' && eng.mtEngine === 'chrome-translator') {
      resp = await SK.forkInterceptMt({ type: 'TRANSLATE_BATCH_GOOGLE', payload: { texts: [text], mtEngine: 'chrome-translator' } });
    } else if (eng.kind === 'mt') {
      const payload = { texts: [text] };
      if (eng.mtEngine !== 'google' || forkTarget) payload.mtEngine = eng.mtEngine;
      if (forkTarget) payload.forkTarget = forkTarget;
      resp = await send('TRANSLATE_BATCH_GOOGLE', payload);
    } else if (eng.kind === 'custom') {
      resp = await send('TRANSLATE_BATCH_CUSTOM', eng.modelOverride ? { texts: [text], modelOverride: eng.modelOverride } : { texts: [text] });
    } else {
      resp = await send('TRANSLATE_BATCH', eng.model ? { texts: [text], modelOverride: eng.model } : { texts: [text] });
    }
    if (!resp || !resp.ok) throw new Error(errText(resp));
    const out = Array.isArray(resp.result) ? String(resp.result[0] || '') : '';
    // 機器翻譯的 【N】 標記只在整頁序列化時出現；卡片的純文字不會有，保險起見拿掉
    return { text: out.replace(/【\/?\*?\d+】/g, '').trim(), forkTarget, engine: eng };
  }

  // ── 朗讀 ────────────────────────────────────────────────
  async function speak(mode, text) {
    if (!card) return;
    const thisCard = card;
    const isOwnText = !text;
    if (mode === 'replay') {
      const clip = card.lastClip;
      if (!clip) return speak('normal');
      setStatus(t('fork.card.replaying'));
      if (clip.kind === 'audio') {
        try { playBuffer(clip.buffer); } catch (err) { setStatus(String(err.message || err), 'error'); }
      } else if (!speakBrowser(clip.text, clip.lang, clip.mode)) {
        setStatus(t('fork.card.noVoice'), 'error');
      }
      return;
    }
    if (card.busy.tts) return;
    card.busy.tts = true;
    setStatus(t('fork.card.loadingAudio'));
    try {
      const resp = await send('FORK_TTS', { text: text || card.snap.text, mode });
      if (card !== thisCard) return;
      if (!resp.ok) { setStatus(errText(resp), 'error'); return; }
      if (resp.engine === 'browser') {
        const lang = card.lang; // 例句與選取的文字同一種語言
        if (!speakBrowser(resp.text, lang, mode)) { setStatus(t('fork.card.noVoice'), 'error'); return; }
        if (isOwnText) card.lastClip = { kind: 'browser', text: resp.text, lang, mode };
        setStatus(t(resp.reason === 'noKey' ? 'fork.card.browserVoiceNoKey' : 'fork.card.browserVoice'));
        return;
      }
      const buf = await decodeBase64Audio(resp.audio);
      if (card !== thisCard) return;
      playBuffer(buf);
      if (isOwnText) card.lastClip = { kind: 'audio', buffer: buf, mode };
      setStatus(t(resp.cached ? 'fork.card.playingCached' : 'fork.card.playing'));
    } catch (err) {
      if (card === thisCard) setStatus(String((err && err.message) || err), 'error');
    } finally {
      thisCard.busy.tts = false;
    }
  }

  // ── 複製 / 學習中心 / 還原段落 ─────────────────────────
  async function copyTranslation() {
    if (!card) return;
    const text = card.translation || card.snap.text;
    const ok = SK.forkParagraph ? await SK.forkParagraph.copyText(text) : false;
    setStatus(t(ok ? 'fork.card.copied' : 'fork.card.copyFailed'), ok ? null : 'error');
  }

  async function saveToLearn() {
    if (!card) return;
    const btn = card.node.querySelector('[data-act="save"]');
    btn.disabled = true;
    const resp = await send('FORK_LEARN_SAVE', {
      text: card.snap.text,
      translation: card.translation,
      lang: card.lang,
      context: card.ctx.text,
      card: card.explainCard || undefined,
    });
    if (!card) return;
    if (!resp.ok) {
      btn.disabled = false;
      setStatus(errText(resp), 'error');
      return;
    }
    btn.textContent = t('fork.card.savedShort');
    setStatus(t(resp.created ? 'fork.card.saved' : 'fork.card.savedUpdated'));
  }

  function restoreParagraph() {
    if (!card || !card.hit) return;
    const ok = SK.forkParagraph.restore(card.hit);
    const btn = card.node.querySelector('[data-act="restore"]');
    if (btn) btn.remove();
    card.hit = null;
    setStatus(t(ok ? 'fork.card.restored' : 'fork.para.notTranslated'), ok ? null : 'error');
  }

  // ── AI 解釋 ─────────────────────────────────────────────
  function exPanel() {
    return card && card.node.querySelector('.ex');
  }

  function section(titleKey, body) {
    return [el('h4', { text: t(titleKey) }), body];
  }

  function citeButtons(quotes) {
    if (!quotes || !quotes.length) return null;
    return el('div', { class: 'chips' }, quotes.map((q) => el('button', {
      type: 'button',
      class: 'cite',
      title: t('fork.card.citeJump'),
      onclick: () => jumpToQuote(q),
    }, [`「${q}」`])));
  }

  function structureView(parts) {
    const box = el('div', {});
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': t('fork.card.sec.structure') });
    const noteP = el('p', { class: 'chipnote', 'aria-live': 'polite' });
    const buttons = parts.map((p, i) => el('button', {
      type: 'button',
      class: 'chip',
      tabindex: i === 0 ? '0' : '-1',
      'aria-pressed': 'false',
    }, [el('span', { class: 'role', text: p.role || '·' }), p.text]));
    const select = (i, focus) => {
      buttons.forEach((b, j) => {
        b.setAttribute('aria-pressed', j === i ? 'true' : 'false');
        b.tabIndex = j === i ? 0 : -1;
      });
      noteP.textContent = parts[i].note || '';
      if (focus) buttons[i].focus();
    };
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => select(i, false));
      b.addEventListener('focus', () => select(i, false));
    });
    chips.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(root.activeElement);
      if (i < 0) return;
      let j = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = Math.min(buttons.length - 1, i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = Math.max(0, i - 1);
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = buttons.length - 1;
      if (j < 0) return;
      e.preventDefault();
      select(j, true);
    });
    buttons.forEach((b) => chips.appendChild(b));
    box.appendChild(chips);
    box.appendChild(noteP);
    box.appendChild(el('p', { class: 'hint', text: t('fork.card.structureHint') }));
    if (buttons.length) select(0, false);
    return box;
  }

  function renderExplain(c) {
    const ex = exPanel();
    ex.textContent = '';
    ex.hidden = false;
    if (c.translation) ex.append(...section('fork.card.sec.aiTranslation', el('p', { text: c.translation })));
    if (c.meaning) ex.append(...section('fork.card.sec.meaning', el('p', { text: c.meaning })));
    const pr = c.pronunciation || {};
    if (pr.ipa || pr.stress) {
      const box = el('div', {});
      if (pr.ipa) box.appendChild(el('p', { class: 'ipa', text: pr.ipa }));
      if (pr.stress) box.appendChild(el('p', { text: pr.stress }));
      ex.append(...section('fork.card.sec.pronunciation', box));
    }
    if (c.structure && c.structure.length) ex.append(...section('fork.card.sec.structure', structureView(c.structure)));
    if (c.usage) ex.append(...section('fork.card.sec.usage', el('p', { text: c.usage })));
    if (c.examples && c.examples.length) {
      const ul = el('ul', { class: 'exs' }, c.examples.map((e) => el('li', {}, [
        e.source,
        el('button', { type: 'button', class: 'mini', 'aria-label': t('fork.card.speakExample'), title: t('fork.card.speakExample'), onclick: () => speak('normal', e.source) }, ['▶']),
        e.translation ? el('span', { class: 't', text: e.translation }) : null,
      ])));
      ex.append(...section('fork.card.sec.examples', ul));
    }
    const cites = citeButtons(c.citations);
    if (cites) ex.append(...section('fork.card.sec.citations', cites));
    appendFollowupUi(ex);
  }

  function renderRaw(raw) {
    const ex = exPanel();
    ex.textContent = '';
    ex.hidden = false;
    ex.appendChild(el('p', { class: 'hint', text: t('fork.card.rawFallback') }));
    ex.appendChild(el('p', { class: 'raw', text: raw }));
    const row = el('div', { class: 'row' }, [el('button', { type: 'button', class: 'regen', onclick: () => runExplain(true) }, [t('fork.card.regenerate')])]);
    ex.appendChild(row);
  }

  function appendFollowupUi(ex) {
    const qa = el('div', { class: 'qa' });
    for (const turn of card.history) renderTurn(qa, turn);
    ex.appendChild(qa);
    const input = el('input', { type: 'text', 'aria-label': t('fork.card.followupPlaceholder'), placeholder: t('fork.card.followupPlaceholder'), maxlength: '1000' });
    const submit = () => {
      const q = input.value.trim();
      if (q) { input.value = ''; runFollowup(q); }
    };
    // 事件被 retarget 成 <ekiden-study>，網頁的快速鍵判斷不出焦點在輸入框，所以不讓它冒泡出去
    for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    });
    ex.appendChild(el('form', { class: 'ask', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      input,
      el('button', { type: 'submit', 'data-act': 'ask' }, [t('fork.card.ask')]),
    ]));
    ex.appendChild(el('div', { class: 'row' }, [
      el('button', { type: 'button', class: 'regen', 'data-act': 'regenerate', onclick: () => runExplain(true) }, [t('fork.card.regenerate')]),
      el('span', { class: 'hint', text: card.model ? t('fork.card.model', { model: card.model }) : '' }),
    ]));
  }

  function renderTurn(qa, turn) {
    qa.appendChild(el('p', { class: 'q', text: turn.q }));
    for (const para of String(turn.a || '').split(/\n{2,}/)) qa.appendChild(el('p', { text: para }));
    const cites = citeButtons(turn.citations);
    if (cites) qa.appendChild(cites);
  }

  async function runExplain(regenerate) {
    if (!card || card.busy.explain) return;
    const thisCard = card;
    card.busy.explain = true;
    if (regenerate) card.history = [];
    setStatus(t('fork.card.explaining'));
    const ex = exPanel();
    ex.hidden = false;
    if (!card.explainCard || regenerate) ex.textContent = t('fork.card.explaining');
    try {
      const resp = await send('FORK_EXPLAIN', {
        text: card.snap.text,
        context: card.ctx.text,
        title: document.title,
        sourceLang: card.lang,
      });
      if (card !== thisCard) return;
      if (!resp.ok) {
        ex.textContent = '';
        setStatus(errText(resp), 'error');
        return;
      }
      card.model = resp.model || '';
      if (resp.card) {
        card.explainCard = resp.card;
        renderExplain(resp.card);
        setStatus('');
      } else {
        card.explainCard = null;
        renderRaw(resp.raw || '');
        setStatus('');
      }
    } finally {
      thisCard.busy.explain = false;
      if (card === thisCard) position();
    }
  }

  async function runFollowup(question) {
    if (!card || !card.explainCard || card.busy.ask) return;
    const thisCard = card;
    card.busy.ask = true;
    const qa = card.node.querySelector('.qa');
    const pending = el('p', { class: 'q', text: question });
    const thinking = el('p', { class: 'hint', text: t('fork.card.thinking') });
    qa.append(pending, thinking);
    try {
      const resp = await send('FORK_EXPLAIN', {
        text: card.snap.text,
        context: card.ctx.text,
        title: document.title,
        sourceLang: card.lang,
        card: card.explainCard,
        history: card.history,
        question,
      });
      if (card !== thisCard) return;
      pending.remove();
      thinking.remove();
      if (!resp.ok) { setStatus(errText(resp), 'error'); return; }
      const turn = { q: question, a: resp.answer || '', citations: resp.citations || [] };
      card.history.push(turn);
      renderTurn(qa, turn);
      setStatus('');
    } finally {
      thisCard.busy.ask = false;
    }
  }

  // ── 引用跳回原文 ────────────────────────────────────────
  let citeHighlightSet = false;
  function clearCiteHighlight() {
    if (citeHighlightSet && typeof CSS !== 'undefined' && CSS.highlights) {
      try { CSS.highlights.delete('ekiden-cite'); } catch (_) { /* 略 */ }
    }
    citeHighlightSet = false;
  }
  function ensureHighlightStyle() {
    if (document.getElementById('ekiden-cite-style')) return;
    const s = document.createElement('style');
    s.id = 'ekiden-cite-style';
    s.textContent = '::highlight(ekiden-cite){background-color:#ffe066;color:inherit;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function findQuoteRange(quote, els) {
    const want = String(quote || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!want) return null;
    for (const root of els) {
      if (!root || !root.isConnected) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const map = []; // 正規化字串每個字元 → [node, offset]
      let norm = '';
      let lastSpace = true;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const v = n.nodeValue;
        for (let i = 0; i < v.length; i++) {
          const ch = v[i];
          if (/\s/.test(ch)) {
            if (lastSpace) continue;
            norm += ' ';
            lastSpace = true;
          } else {
            norm += ch.toLowerCase();
            lastSpace = false;
          }
          map.push([n, i]);
        }
      }
      const at = norm.indexOf(want);
      if (at < 0) continue;
      const [sn, so] = map[at];
      const [en, eo] = map[at + want.length - 1];
      const range = document.createRange();
      range.setStart(sn, so);
      range.setEnd(en, eo + 1);
      return range;
    }
    return null;
  }

  function jumpToQuote(quote) {
    if (!card) return;
    const range = findQuoteRange(quote, card.ctx.els);
    if (!range) { setStatus(t('fork.card.citeNotFound'), 'error'); return; }
    const target = range.startContainer.parentElement;
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function') {
      ensureHighlightStyle();
      CSS.highlights.set('ekiden-cite', new Highlight(range));
      citeHighlightSet = true;
    } else {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setStatus(t('fork.card.citeShown'));
  }

  // ── 觸發 ────────────────────────────────────────────────
  let down = null;
  let longTimer = null;
  let suppressClick = false;
  let suppressAux = false;

  function cancelLong() {
    clearTimeout(longTimer);
    longTimer = null;
  }

  document.addEventListener('mousedown', (e) => {
    if (isOurs(e)) return;
    hideIcon();
    if (card) closeCard();
    const trig = cfg.study.trigger;
    down = { x: e.clientX, y: e.clientY, button: e.button, t: Date.now() };
    if (trig === 'longpress' && e.button === 0 && !isEditable(e.target)) {
      cancelLong();
      longTimer = setTimeout(() => {
        longTimer = null;
        const snap = pointInSelection(down.x, down.y) ? snapshotSelection() : (() => {
          const r = wordRangeAt(down.x, down.y);
          return r ? selectRange(r) : null;
        })();
        if (snap) {
          suppressClick = true;
          openCard(snap);
        }
      }, cfg.study.longPressMs);
    }
    if (trig === 'middle' && e.button === 1 && !isEditable(e.target)) {
      let snap = null;
      if (pointInSelection(e.clientX, e.clientY)) snap = snapshotSelection();
      else if (!(e.target.closest && e.target.closest('a[href],button,input,textarea,select,[contenteditable]'))) {
        const r = wordRangeAt(e.clientX, e.clientY);
        if (r) snap = selectRange(r);
      }
      if (snap) {
        e.preventDefault(); // 不啟動自動捲動 / 貼上
        suppressAux = true; // 選取範圍在連結上時，也不要開新分頁
        openCard(snap);
      }
    }
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (longTimer && down && (Math.abs(e.clientX - down.x) > 6 || Math.abs(e.clientY - down.y) > 6)) cancelLong();
  }, { passive: true, capture: true });

  document.addEventListener('mouseup', (e) => {
    cancelLong();
    if (isOurs(e) || e.button !== 0) return;
    const trig = cfg.study.trigger;
    if (trig !== 'select' && trig !== 'modifier') return;
    if (trig === 'modifier' && !e[MOD_PROP[cfg.study.modifierKey]]) return;
    // 等瀏覽器更新選取範圍
    setTimeout(() => {
      const snap = snapshotSelection();
      if (!snap) return;
      if (trig === 'select' && cfg.study.selectMode !== 'card') showIcon(snap);
      else openCard(snap);
    }, 0);
  }, true);

  document.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    if (isOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('auxclick', (e) => {
    if (!suppressAux || e.button !== 1) return;
    suppressAux = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('dblclick', (e) => {
    if (isOurs(e) || cfg.study.trigger !== 'dblclick') return;
    setTimeout(() => {
      const snap = snapshotSelection();
      if (snap) openCard(snap);
    }, 0);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (card || iconEl)) {
      hideIcon();
      closeCard();
      return;
    }
    if (iconEl && !isOurs(e)) hideIcon();
  }, true);

  window.addEventListener('scroll', () => { if (iconEl) hideIcon(); }, { passive: true, capture: true });

  // 右鍵選單「翻譯選取文字」
  try {
    browser.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'FORK_CARD_OPEN') return undefined;
      let snap = snapshotSelection();
      const want = String((msg.payload && msg.payload.text) || '').replace(/\s+/g, ' ').trim();
      if (!snap && want) {
        const w = window.innerWidth;
        snap = { text: want.slice(0, MAX_TEXT), range: null, rect: { left: w / 2 - 200, top: 80, right: w / 2 + 200, bottom: 80, width: 400, height: 0 } };
        snap.endRect = snap.rect;
      }
      if (snap) openCard(snap);
      return undefined;
    });
  } catch (_) { /* 略 */ }

  // 測試用（isolated world 才看得到；closed shadow root 從網頁拿不到）
  SK._forkStudy = {
    get root() { return root; },
    get card() { return card; },
    get config() { return cfg; },
    openFromSelection() { const s = snapshotSelection(); if (s) return openCard(s); return null; },
    rectOf(act) {
      const b = card && card.node.querySelector(`[data-act="${act}"]`);
      if (!b) return null;
      b.scrollIntoView({ block: 'nearest' }); // 卡片內容超過高度時會捲動
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    iconRect() {
      if (!iconEl) return null;
      const r = iconEl.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    close: closeCard,
  };
})(window.__SK);
