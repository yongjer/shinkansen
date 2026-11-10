// fork/pages/settings.js — 驛傳設定頁
//
// 一般設定存 storage.sync 'fork'；金鑰與密碼存 storage.local 'forkSecrets'（不同步、預設不進備份）；
// 額外服務的自訂 prompt 存 storage.local 'forkProviderPrompts'。結構見 fork/settings/schema.js。
// 與上游設定頁相同採自動儲存（變更後 400 ms 寫入）。

import { browser } from '../../lib/compat.js';
import { DEFAULT_SETTINGS, LOCAL_SETTINGS_KEYS, splitSettingsPatch, detectDefaultTargetLanguage } from '../../lib/storage.js';
import { sanitizeImport } from '../../options/import-sanitize.js';
import {
  FORK_SYNC_KEY, FORK_SECRETS_KEY, FORK_PROVIDER_PROMPTS_KEY, FORK_BACKUP_STATE_KEY, MAX_PROVIDERS,
  mergeForkSettings, sanitizeForkSettings, sanitizeSecrets, sanitizeProviderPrompts, newProviderId,
} from '../settings/schema.js';
import { SOURCE_LANGS, chromeTarget, chromeSource } from '../engines/lang.js';
import { DEFAULT_RATE_LIMITS } from '../engines/registry.js';
import { CHAIN_CANDIDATES } from '../engines/chain.js';
import { buildBackup, parseBackup, summarizeBackup, restoreBackup, BACKUP_FILENAME } from '../backup/backup-core.js';
import { MIN_PASSPHRASE_LENGTH } from '../backup/crypto.js';
import { createWebdavClient } from '../backup/webdav.js';
import { buildAuthUrl, parseAuthRedirect, createDriveClient } from '../backup/gdrive.js';
import { MODEL_PRICING, getModalityPricing } from '../../lib/model-pricing.js';
import { PREBUILT_VOICES } from '../tts/gemini-tts.js';
import { PRONUNCIATIONS_KEY, sanitizePronunciations, MAX_PRONUNCIATIONS } from '../tts/pronounce.js';
import { TTS_MODELS, FORK_EXPLAIN_PROMPT_KEY, sanitizeExplainPrompt } from '../settings/schema.js';

const I18N = window.__SK.i18n;
const $ = (id) => document.getElementById(id);
let uiLang = 'zh-TW';
const _t = (key, params) => I18N.t(key, params, uiLang);

// 下拉選單中的機器翻譯引擎（Google 是上游原本的選項，用「維持原設定」代表）
const MT_CHOICES = ['microsoft-edge', 'azure', 'deepl', 'deeplx', 'chrome-translator', 'free-chain'];
const LANG_NATIVE = {
  'zh-TW': '繁體中文', 'zh-CN': '简体中文', en: 'English', ja: '日本語', ko: '한국어',
  es: 'Español', fr: 'Français', de: 'Deutsch',
};

const S = {
  fork: mergeForkSettings(null),
  secrets: sanitizeSecrets(null),
  prompts: {},
  backupState: {},
  presets: DEFAULT_SETTINGS.translatePresets,
  target: 'zh-TW',
  status: null, // FORK_ENGINE_STATUS 回應
  pron: [],          // storage.local forkPronunciations（編輯中的列可能還沒填完）
  explainPrompt: '', // storage.local forkExplainPrompt
  geminiModel: '',   // 上游 Gemini 主設定的模型（AI 閱讀卡預設沿用）
};

const engineLabel = (id) => _t(`fork.engine.${id}.name`);

// ── 讀取 ──────────────────────────────────────────────────
async function loadState() {
  const [sync, local] = await Promise.all([
    browser.storage.sync.get([FORK_SYNC_KEY, 'translatePresets', 'uiLanguage', 'targetLanguage', 'geminiConfig']),
    browser.storage.local.get([FORK_SECRETS_KEY, FORK_PROVIDER_PROMPTS_KEY, FORK_BACKUP_STATE_KEY, PRONUNCIATIONS_KEY, FORK_EXPLAIN_PROMPT_KEY]),
  ]);
  S.pron = sanitizePronunciations(local[PRONUNCIATIONS_KEY]);
  S.explainPrompt = sanitizeExplainPrompt(local[FORK_EXPLAIN_PROMPT_KEY]);
  S.geminiModel = sync.geminiConfig?.model || DEFAULT_SETTINGS.geminiConfig?.model || '';
  S.fork = mergeForkSettings(sync[FORK_SYNC_KEY]);
  S.secrets = sanitizeSecrets(local[FORK_SECRETS_KEY]);
  S.prompts = sanitizeProviderPrompts(local[FORK_PROVIDER_PROMPTS_KEY]);
  S.backupState = (local[FORK_BACKUP_STATE_KEY] && typeof local[FORK_BACKUP_STATE_KEY] === 'object') ? local[FORK_BACKUP_STATE_KEY] : {};
  S.presets = Array.isArray(sync.translatePresets) && sync.translatePresets.length
    ? sync.translatePresets : DEFAULT_SETTINGS.translatePresets;
  S.target = sync.targetLanguage || detectDefaultTargetLanguage();
  uiLang = I18N.getUiLanguage(sync.uiLanguage || 'auto');
}

// ── 儲存（自動）────────────────────────────────────────────
const dirty = new Set();
let saveTimer = null;
let saveBarTimer = null;

function showSaveBar(state, text) {
  const bar = $('save-bar');
  clearTimeout(saveBarTimer);
  bar.hidden = false;
  bar.className = `save-bar ${state === 'saved' ? 'saved' : 'dirty'}`;
  bar.textContent = text;
  if (state === 'saved') saveBarTimer = setTimeout(() => { bar.hidden = true; }, 1500);
}

function markDirty(part) {
  dirty.add(part);
  showSaveBar('dirty', _t('options.action.dirtyBar'));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { flush(); }, 400);
}

async function flush() {
  clearTimeout(saveTimer);
  if (!dirty.size) return;
  const parts = new Set(dirty);
  dirty.clear();
  try {
    if (parts.has('fork')) {
      await browser.storage.sync.set({ [FORK_SYNC_KEY]: sanitizeForkSettings(S.fork).clean });
    }
    if (parts.has('secrets')) {
      await browser.storage.local.set({ [FORK_SECRETS_KEY]: sanitizeSecrets(S.secrets) });
    }
    if (parts.has('prompts')) {
      await browser.storage.local.set({ [FORK_PROVIDER_PROMPTS_KEY]: sanitizeProviderPrompts(S.prompts) });
    }
    if (parts.has('pron')) {
      await browser.storage.local.set({ [PRONUNCIATIONS_KEY]: sanitizePronunciations(S.pron) });
    }
    if (parts.has('explainPrompt')) {
      await browser.storage.local.set({ [FORK_EXPLAIN_PROMPT_KEY]: sanitizeExplainPrompt(S.explainPrompt) });
    }
    showSaveBar('saved', _t('options.action.savedBar'));
    refreshStatus();
  } catch (err) {
    showSaveBar('error', _t('options.action.saveFailed', { error: err?.message || String(err) }));
  }
}

// ── 小工具 ────────────────────────────────────────────────
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[last] = value;
}
function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
function setResult(el, state, text) {
  if (!el) return;
  el.hidden = false;
  el.dataset.state = state;
  el.textContent = text;
}
function errorText(resp) {
  if (!resp) return _t('fork.test.noResponse');
  return I18N.bgErrorMessage(resp, uiLang) || resp.message || resp.error || _t('fork.test.noResponse');
}
async function send(type, payload) {
  try {
    return await browser.runtime.sendMessage({ type, payload });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c) n.appendChild(c);
  return n;
}
function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(uiLang);
  } catch {
    return String(iso);
  }
}

// ── 一般欄位（data-bind → S.fork；data-secret → S.secrets）─────
function fillBoundFields() {
  for (const node of document.querySelectorAll('[data-bind]')) {
    const v = getPath(S.fork, node.dataset.bind);
    if (node.type === 'checkbox') node.checked = !!v;
    else node.value = v ?? '';
    node.removeAttribute('aria-invalid');
  }
  for (const node of document.querySelectorAll('[data-secret]')) {
    node.value = S.secrets[node.dataset.secret] || '';
  }
  $('backup-passphrase-row').hidden = !S.fork.backup.includeKeys;
}

function onBoundChange(node) {
  const path = node.dataset.bind;
  let value;
  if (node.type === 'checkbox') {
    value = node.checked;
  } else {
    value = node.value.trim();
    if (node.hasAttribute('data-url') && value && !isHttpUrl(value)) {
      node.setAttribute('aria-invalid', 'true');
      return;
    }
    node.removeAttribute('aria-invalid');
  }
  setPath(S.fork, path, value);
  if (path === 'backup.includeKeys') $('backup-passphrase-row').hidden = !value;
  markDirty('fork');
}

function onSecretChange(node) {
  const field = node.dataset.secret;
  const value = node.value.trim();
  if (value) S.secrets[field] = value;
  else delete S.secrets[field];
  markDirty('secrets');
}

// ── 來源語言 ──────────────────────────────────────────────
function renderSourceLang() {
  const sel = $('source-lang');
  sel.textContent = '';
  for (const code of SOURCE_LANGS) {
    sel.appendChild(el('option', { value: code, text: code === 'auto' ? _t('fork.lang.auto') : LANG_NATIVE[code] || code }));
  }
  sel.value = S.fork.mt.sourceLang;
}

// ── 引擎卡片：速率上限 + 測試 ─────────────────────────────
function buildEngineExtras() {
  for (const card of document.querySelectorAll('.engine-card[data-engine]')) {
    const id = card.dataset.engine;
    if (!card.hasAttribute('data-no-rate')) {
      const def = DEFAULT_RATE_LIMITS[id] || { rps: 0, rpm: 0 };
      const row = el('div', { class: 'rate-row' }, [
        el('span', { 'data-i18n': 'fork.rate.label' }),
        el('label', {}, [
          el('small', { class: 'muted', 'data-i18n': 'fork.rate.rps' }),
          el('input', { type: 'number', min: 0, max: 100, step: 1, placeholder: String(def.rps), dataset: { rate: id, rateField: 'rps' } }),
        ]),
        el('label', {}, [
          el('small', { class: 'muted', 'data-i18n': 'fork.rate.rpm' }),
          el('input', { type: 'number', min: 0, max: 6000, step: 1, placeholder: String(def.rpm), dataset: { rate: id, rateField: 'rpm' } }),
        ]),
        el('small', { class: 'muted', 'data-i18n': 'fork.rate.hint' }),
      ]);
      card.appendChild(row);
    }
    const testRow = el('div', { class: 'test-row' }, [
      el('button', { type: 'button', class: 'ghost-btn', 'data-test': id, 'data-i18n': 'options.action.test' }),
    ]);
    if (id === 'chrome-translator') {
      testRow.prepend(el('button', { type: 'button', class: 'ghost-btn', id: 'ct-check', 'data-i18n': 'fork.ct.check' }));
    }
    card.appendChild(testRow);
    card.appendChild(el('div', { class: 'api-test-result', 'data-result': id, hidden: true }));
  }
}

function fillRateFields() {
  for (const input of document.querySelectorAll('[data-rate]')) {
    const v = S.fork.mt.rateLimits[input.dataset.rate]?.[input.dataset.rateField];
    input.value = v === undefined ? '' : String(v);
  }
}

function onRateChange(input) {
  const id = input.dataset.rate;
  const card = input.closest('.engine-card');
  const rpsIn = card.querySelector('[data-rate-field="rps"]');
  const rpmIn = card.querySelector('[data-rate-field="rpm"]');
  const def = DEFAULT_RATE_LIMITS[id] || { rps: 0, rpm: 0 };
  if (rpsIn.value === '' && rpmIn.value === '') {
    delete S.fork.mt.rateLimits[id];
  } else {
    // 只填一欄時，另一欄寫入預設值（避免把 DeepLX 預設的每秒上限意外改成不限）
    const clamp = (v, max) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));
    S.fork.mt.rateLimits[id] = {
      rps: rpsIn.value === '' ? def.rps : clamp(rpsIn.value, 100),
      rpm: rpmIn.value === '' ? def.rpm : clamp(rpmIn.value, 6000),
    };
  }
  markDirty('fork');
}

// ── 引擎狀態 ──────────────────────────────────────────────
async function refreshStatus() {
  const resp = await send('FORK_ENGINE_STATUS');
  if (!resp?.ok) return;
  S.status = resp;
  for (const card of document.querySelectorAll('.engine-card[data-engine]')) {
    const id = card.dataset.engine;
    if (id === 'chrome-translator') continue;
    const st = card.querySelector('.engine-status');
    const text = statusText(id);
    st.textContent = text.text;
    st.dataset.state = text.state;
  }
  renderChain();
  renderPresets();
}

function statusText(id) {
  const configured = S.status?.configured?.[id];
  const h = S.status?.health?.[id];
  if (h?.cooldownUntil && h.cooldownUntil > Date.now()) {
    return { state: 'warn', text: _t('fork.status.cooldown', { min: Math.max(1, Math.ceil((h.cooldownUntil - Date.now()) / 60000)) }) };
  }
  if (configured === false) return { state: 'warn', text: _t('fork.status.notConfigured') };
  if (configured === true) return { state: 'ok', text: _t('fork.status.ready') };
  return { state: '', text: '' };
}

// ── 翻譯預設 ──────────────────────────────────────────────
const SLOT_ORDER = [2, 1, 3];
const SLOT_NAME_KEY = { 2: 'options.preset.primary', 1: 'options.preset.slot2', 3: 'options.preset.slot3' };
const UPSTREAM_ENGINE_KEY = {
  gemini: 'options.preset.engineGemini',
  google: 'options.preset.engineGoogle',
  'openai-compat': 'options.preset.engineCustom',
};

function renderPresets() {
  const box = $('preset-rows');
  box.textContent = '';
  for (const slot of SLOT_ORDER) {
    const preset = S.presets.find((p) => Number(p?.slot) === slot) || { slot, engine: 'gemini', label: '' };
    const name = _t(SLOT_NAME_KEY[slot]) + (preset.label ? ` · ${preset.label}` : '');
    const upstream = UPSTREAM_ENGINE_KEY[preset.engine] ? _t(UPSTREAM_ENGINE_KEY[preset.engine]) : String(preset.engine || '');
    const row = el('div', { class: 'preset-row', dataset: { slot: String(slot) } }, [
      el('div', { class: 'preset-name', text: name }),
      el('div', { class: 'preset-upstream', text: _t('fork.presets.upstream', { engine: upstream }) }),
    ]);
    const current = S.fork.presetEngines[String(slot)] || '';
    if (preset.engine === 'google' || preset.engine === 'openai-compat') {
      const sel = el('select', { 'data-preset-slot': String(slot) });
      if (preset.engine === 'google') {
        sel.appendChild(el('option', { value: '', text: _t('fork.presets.keepGoogle') }));
        for (const id of MT_CHOICES) {
          const st = S.status?.configured?.[id] === false ? ` — ${_t('fork.status.notConfigured')}` : '';
          sel.appendChild(el('option', { value: id, text: engineLabel(id) + st }));
        }
        sel.value = MT_CHOICES.includes(current) ? current : '';
      } else {
        sel.appendChild(el('option', { value: '', text: _t('fork.presets.keepCustom') }));
        for (const p of S.fork.providers) {
          sel.appendChild(el('option', { value: p.id, text: p.label || p.model || _t('fork.providers.untitled') }));
        }
        sel.value = S.fork.providers.some((p) => p.id === current) ? current : '';
      }
      row.appendChild(sel);
    } else {
      row.appendChild(el('div', { class: 'preset-note', text: _t('fork.presets.geminiNote') }));
    }
    box.appendChild(row);
  }
}

// ── 免費引擎備援 ──────────────────────────────────────────
function renderChain() {
  const list = $('chain-list');
  list.textContent = '';
  const order = S.fork.mt.chain;
  order.forEach((id, i) => {
    const disabled = S.fork.mt.chainDisabled.includes(id);
    const st = statusText(id);
    const li = el('li', { dataset: { engine: id, disabled: String(disabled) } }, [
      el('label', {}, [
        el('input', { type: 'checkbox', 'data-chain-toggle': id, checked: !disabled }),
        el('span', { class: 'chain-name', text: engineLabel(id) }),
        el('span', { class: 'engine-status', text: st.text, dataset: { state: st.state } }),
      ]),
      el('button', { type: 'button', class: 'ghost-btn', 'data-chain-move': '-1', 'data-engine': id, disabled: i === 0, 'aria-label': _t('fork.chain.up'), text: '↑' }),
      el('button', { type: 'button', class: 'ghost-btn', 'data-chain-move': '1', 'data-engine': id, disabled: i === order.length - 1, 'aria-label': _t('fork.chain.down'), text: '↓' }),
    ]);
    list.appendChild(li);
  });
}

function moveChain(id, delta) {
  const order = [...S.fork.mt.chain];
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  S.fork.mt.chain = order;
  renderChain();
  markDirty('fork');
}

function toggleChain(id, enabled) {
  const set = new Set(S.fork.mt.chainDisabled);
  if (enabled) set.delete(id);
  else set.add(id);
  S.fork.mt.chainDisabled = CHAIN_CANDIDATES.filter((x) => set.has(x));
  renderChain();
  markDirty('fork');
}

// ── 其他 OpenAI 相容服務 ───────────────────────────────────
function providerField(p, { field, labelKey, type = 'text', placeholderKey, attrs = {} }) {
  const value = p[field];
  return el('label', {}, [
    el('span', { 'data-i18n': labelKey }),
    el('input', {
      type,
      spellcheck: 'false',
      'data-provider-field': field,
      'data-i18n-attr-placeholder': placeholderKey,
      value: value === null || value === undefined ? '' : String(value),
      ...attrs,
    }),
  ]);
}

function renderProviders() {
  const list = $('provider-list');
  list.textContent = '';
  for (const p of S.fork.providers) {
    const thinking = el('select', { 'data-provider-field': 'thinkingLevel' });
    for (const [v, key] of [['off', 'options.cp.thinkingOff'], ['auto', 'options.cp.thinkingAuto'], ['low', 'options.cp.thinkingLow'], ['medium', 'options.cp.thinkingMid'], ['high', 'options.cp.thinkingHigh']]) {
      thinking.appendChild(el('option', { value: v, 'data-i18n': key }));
    }
    const prompt = el('textarea', { rows: 4, 'data-provider-prompt': '', 'data-i18n-attr-placeholder': 'fork.providers.promptPlaceholder' });
    prompt.value = S.prompts[p.id] || '';
    const card = el('div', { class: 'provider-card', dataset: { provider: p.id } }, [
      el('div', { class: 'provider-head' }, [
        el('input', { type: 'text', 'data-provider-field': 'label', value: p.label, 'data-i18n-attr-placeholder': 'fork.providers.labelPlaceholder', 'aria-label': _t('fork.providers.label') }),
        el('button', { type: 'button', class: 'ghost-btn', 'data-provider-remove': p.id, 'data-i18n': 'fork.providers.remove' }),
      ]),
      providerField(p, { field: 'baseUrl', labelKey: 'options.cp.baseUrlLabel', placeholderKey: 'options.cp.baseUrlPlaceholder', attrs: { 'data-url': true } }),
      providerField(p, { field: 'model', labelKey: 'options.cp.modelLabel', placeholderKey: 'options.cp.modelPlaceholder' }),
      el('label', {}, [
        el('span', { 'data-i18n': 'options.cp.apiKeyLabel' }),
        el('span', { class: 'api-key-row' }, [
          el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'data-provider-key': p.id, value: S.secrets.providerKeys[p.id] || '' }),
          el('button', { type: 'button', class: 'ghost-btn', 'data-toggle-secret': true, 'data-i18n': 'options.action.show' }),
        ]),
        el('small', { class: 'muted', 'data-i18n': 'fork.field.keyHint' }),
      ]),
      el('div', { class: 'provider-grid' }, [
        providerField(p, { field: 'temperature', labelKey: 'options.cp.tempLabel', type: 'number', attrs: { min: 0, max: 2, step: 0.1 } }),
        el('label', {}, [el('span', { 'data-i18n': 'options.cp.thinkingLabel' }), thinking]),
        providerField(p, { field: 'inputPerMTok', labelKey: 'options.cp.pricing.inputLabel', type: 'number', attrs: { min: 0, step: 0.01 } }),
        providerField(p, { field: 'outputPerMTok', labelKey: 'options.cp.pricing.outputLabel', type: 'number', attrs: { min: 0, step: 0.01 } }),
      ]),
      el('label', {}, [
        el('span', { 'data-i18n': 'options.cp.systemPromptLabel' }),
        prompt,
        el('small', { class: 'muted', 'data-i18n': 'fork.providers.promptHint' }),
      ]),
      el('div', { class: 'test-row' }, [
        el('button', { type: 'button', class: 'ghost-btn', 'data-provider-test': p.id, 'data-i18n': 'options.action.test' }),
      ]),
      el('div', { class: 'api-test-result', 'data-result': `provider:${p.id}`, hidden: true }),
    ]);
    thinking.value = p.thinkingLevel;
    list.appendChild(card);
  }
  I18N.applyI18n(list, uiLang);
  $('provider-add').disabled = S.fork.providers.length >= MAX_PROVIDERS;
  $('provider-max').hidden = S.fork.providers.length < MAX_PROVIDERS;
  $('provider-max').textContent = _t('fork.providers.max', { max: MAX_PROVIDERS });
}

function onProviderFieldChange(node) {
  const card = node.closest('[data-provider]');
  const p = S.fork.providers.find((x) => x.id === card?.dataset.provider);
  if (!p) return;
  const field = node.dataset.providerField;
  if (field === 'temperature') {
    p.temperature = node.value === '' ? null : Math.min(2, Math.max(0, Number(node.value) || 0));
  } else if (field === 'inputPerMTok' || field === 'outputPerMTok') {
    p[field] = Math.min(1000, Math.max(0, Number(node.value) || 0));
  } else if (field === 'baseUrl') {
    const v = node.value.trim();
    if (v && !isHttpUrl(v)) {
      node.setAttribute('aria-invalid', 'true');
      return;
    }
    node.removeAttribute('aria-invalid');
    p.baseUrl = v;
  } else {
    p[field] = node.value.trim();
  }
  if (field === 'label' || field === 'model') renderPresets();
  markDirty('fork');
}

function addProvider() {
  if (S.fork.providers.length >= MAX_PROVIDERS) return;
  S.fork.providers.push({
    id: newProviderId(), label: '', baseUrl: '', model: '', temperature: null,
    inputPerMTok: 0, outputPerMTok: 0, thinkingLevel: 'off',
  });
  renderProviders();
  renderPresets();
  markDirty('fork');
  const last = $('provider-list').lastElementChild?.querySelector('input');
  last?.focus();
}

function removeProvider(id) {
  const p = S.fork.providers.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(_t('fork.providers.removeConfirm', { label: p.label || p.model || _t('fork.providers.untitled') }))) return;
  S.fork.providers = S.fork.providers.filter((x) => x.id !== id);
  for (const slot of Object.keys(S.fork.presetEngines)) {
    if (S.fork.presetEngines[slot] === id) S.fork.presetEngines[slot] = '';
  }
  delete S.secrets.providerKeys[id];
  delete S.prompts[id];
  renderProviders();
  renderPresets();
  markDirty('fork');
  markDirty('secrets');
  markDirty('prompts');
}

async function testProvider(id) {
  const p = S.fork.providers.find((x) => x.id === id);
  const resultEl = document.querySelector(`[data-result="provider:${id}"]`);
  if (!p) return;
  setResult(resultEl, 'loading', _t('options.action.testingConnect'));
  const resp = await send('TEST_CUSTOM_PROVIDER', { baseUrl: p.baseUrl, model: p.model, apiKey: S.secrets.providerKeys[id] || '' });
  if (resp?.ok) {
    const text = resp.code === 'okUsage' ? _t('options.action.connectOkUsage', resp.params || {}) : _t('options.action.connectOk');
    setResult(resultEl, 'ok', text);
  } else {
    setResult(resultEl, 'fail', _t('fork.test.fail', { error: errorText(resp) }));
  }
}

// ── 引擎測試 ──────────────────────────────────────────────
async function testEngine(id) {
  await flush();
  const resultEl = document.querySelector(`[data-result="${id}"]`);
  setResult(resultEl, 'loading', _t('options.action.testing'));
  if (id === 'chrome-translator') return testChromeTranslator(resultEl);
  const resp = await send('FORK_TEST_ENGINE', { engine: id });
  if (resp?.ok) {
    const params = { ms: resp.ms, text: resp.translation };
    const text = resp.servedBy && resp.servedBy !== id
      ? _t('fork.test.okVia', { ...params, engine: engineLabel(resp.servedBy) })
      : _t('fork.test.ok', params);
    setResult(resultEl, 'ok', text);
  } else {
    setResult(resultEl, 'fail', _t('fork.test.fail', { error: errorText(resp) }));
  }
  refreshStatus();
}

// Chrome 內建翻譯在本頁直接呼叫（與 content script 相同的 Translator API）
function ctPair() {
  const src = S.fork.mt.sourceLang === 'auto' ? (S.target === 'en' ? 'ja' : 'en') : S.fork.mt.sourceLang;
  return { sourceLanguage: chromeSource(src), targetLanguage: chromeTarget(S.target) };
}

async function checkChromeTranslator() {
  const st = $('ct-status');
  if (typeof self.Translator === 'undefined') {
    st.textContent = _t('fork.ct.noApi');
    st.dataset.state = 'warn';
    return null;
  }
  const pair = ctPair();
  let a;
  try {
    a = await self.Translator.availability(pair);
  } catch {
    a = 'unavailable';
  }
  const map = { available: ['ok', 'fork.ct.available'], downloadable: ['', 'fork.ct.downloadable'], downloading: ['', 'fork.ct.downloading'] };
  const [state, key] = map[a] || ['warn', 'fork.ct.unavailable'];
  st.textContent = `${_t(key)}（${pair.sourceLanguage} → ${pair.targetLanguage}）`;
  st.dataset.state = state;
  return a;
}

async function testChromeTranslator(resultEl) {
  const a = await checkChromeTranslator();
  if (!a || a === 'unavailable') {
    setResult(resultEl, 'fail', _t('fork.test.fail', { error: $('ct-status').textContent }));
    return;
  }
  try {
    const t0 = performance.now();
    const tr = await self.Translator.create(ctPair());
    const sample = ctPair().sourceLanguage === 'ja' ? 'こんにちは、世界。これは翻訳のテストです。' : 'Hello, world. This is a test of the translation service.';
    const out = await tr.translate(sample);
    tr.destroy?.();
    setResult(resultEl, 'ok', _t('fork.test.ok', { ms: Math.round(performance.now() - t0), text: out }));
    checkChromeTranslator();
  } catch (err) {
    setResult(resultEl, 'fail', _t('fork.test.fail', { error: err?.message || String(err) }));
  }
}

// ── 備份 ──────────────────────────────────────────────────
const statusEl = () => $('backup-status');

function backupError(err) {
  const code = err?.code;
  const known = ['auth', 'network', 'badUrl', 'notJson', 'notBackup', 'newerVersion', 'badPassphrase', 'passphraseRequired', 'conflict', 'authDenied', 'scopeMissing'];
  if (known.includes(code)) {
    return _t(`fork.backup.err.${code}`, { status: err.status || '', error: err.message || '' });
  }
  if (err?.status) return _t('fork.backup.err.http', { status: err.status });
  return err?.message || String(err);
}

async function saveBackupState(patch) {
  S.backupState = { ...S.backupState, ...patch };
  await browser.storage.local.set({ [FORK_BACKUP_STATE_KEY]: S.backupState });
  renderBackupState();
}

function renderBackupState() {
  const w = S.backupState.webdav;
  $('webdav-last').textContent = w?.at ? _t(w.op === 'restore' ? 'fork.backup.lastRestore' : 'fork.backup.lastUpload', { time: formatTime(w.at) }) : '';
  const g = S.backupState.gdrive;
  $('gdrive-last').textContent = g?.at ? _t(g.op === 'restore' ? 'fork.backup.lastRestore' : 'fork.backup.lastUpload', { time: formatTime(g.at) }) : '';
}

async function makeBackupText() {
  await flush();
  const includeKeys = !!S.fork.backup.includeKeys;
  const passphrase = $('backup-passphrase').value;
  if (includeKeys && passphrase.length < MIN_PASSPHRASE_LENGTH) {
    const err = new Error('passphrase');
    err.code = 'passphraseRequired';
    throw err;
  }
  const data = await buildBackup(
    { storage: browser.storage, localSettingsKeys: LOCAL_SETTINGS_KEYS },
    { includeKeys, passphrase, extVersion: browser.runtime.getManifest().version },
  );
  return JSON.stringify(data, null, 2);
}

async function withBusy(btn, fn) {
  const buttons = document.querySelectorAll('#sec-backup button');
  buttons.forEach((b) => { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; });
  setResult(statusEl(), 'loading', _t('fork.backup.working'));
  try {
    await fn();
  } catch (err) {
    setResult(statusEl(), 'fail', _t('fork.backup.failed', { error: backupError(err) }));
  } finally {
    buttons.forEach((b) => { b.disabled = b.dataset.wasDisabled === '1'; delete b.dataset.wasDisabled; });
    updateDriveButtons();
  }
}

async function exportLocal() {
  const text = await makeBackupText();
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = el('a', { href: url, download: BACKUP_FILENAME.replace('.json', `-${stamp}.json`) });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setResult(statusEl(), 'ok', _t('fork.backup.exported'));
}

// 還原流程：解析 → 對話框確認（可選擇一併還原金鑰）→ 寫入
let pendingRestore = null;

function openRestoreDialog(data, onDone) {
  const sum = summarizeBackup(data);
  $('restore-summary').textContent = _t('fork.restore.summary', {
    time: formatTime(sum.createdAt), version: sum.extVersion || '?', count: sum.settingKeys, providers: sum.providers,
  });
  $('restore-keys-block').hidden = !sum.hasSecrets;
  $('restore-no-keys').hidden = sum.hasSecrets;
  $('restore-with-keys').checked = false;
  $('restore-passphrase-row').hidden = true;
  $('restore-passphrase').value = '';
  $('restore-error').hidden = true;
  pendingRestore = { data, onDone };
  $('restore-dialog').showModal();
}

async function confirmRestore() {
  if (!pendingRestore) return;
  const { data, onDone } = pendingRestore;
  const restoreKeys = !!data.secrets && $('restore-with-keys').checked;
  const btn = $('restore-confirm');
  btn.disabled = true;
  try {
    await flush();
    const result = await restoreBackup(data, {
      storage: browser.storage,
      sanitizeImport: (raw) => sanitizeImport(raw, _t),
      splitSettingsPatch,
    }, { restoreKeys, passphrase: $('restore-passphrase').value });
    $('restore-dialog').close();
    pendingRestore = null;
    await loadState();
    renderAll();
    const lines = [_t(result.restoredKeys ? 'fork.restore.doneWithKeys' : 'fork.restore.done')];
    if (result.warnings.length) lines.push(_t('fork.restore.warnings', { list: result.warnings.join('、') }));
    if (result.clearedKeys.length) lines.push(_t('fork.restore.cleared', { list: result.clearedKeys.map(clearedLabel).join('、') }));
    setResult(statusEl(), result.warnings.length ? 'loading' : 'ok', lines.join('\n'));
    if (onDone) await onDone();
  } catch (err) {
    const box = $('restore-error');
    box.hidden = false;
    box.textContent = backupError(err);
  } finally {
    btn.disabled = false;
  }
}

function clearedLabel(k) {
  if (k === 'customProvider') return _t('options.preset.engineCustom');
  if (k.startsWith('provider:')) {
    return _t('fork.providers.heading') + ` (${k.slice('provider:'.length)})`;
  }
  return engineLabel(k);
}

async function importLocalFile(file) {
  const text = await file.text();
  const data = parseBackup(text);
  setResult(statusEl(), 'loading', _t('fork.backup.confirmPending'));
  openRestoreDialog(data);
}

// WebDAV
function webdavClient() {
  const cfg = S.fork.backup.webdav;
  return createWebdavClient({ url: cfg.url, username: cfg.username, password: S.secrets.webdavPassword || '', dir: cfg.dir || 'ekiden' });
}

async function webdavTest() {
  await flush();
  const c = webdavClient();
  await c.test();
  setResult(statusEl(), 'ok', _t('fork.backup.connOk', { folder: c.folder }));
}

async function webdavUpload() {
  const text = await makeBackupText();
  const c = webdavClient();
  const remote = await c.head(BACKUP_FILENAME);
  const known = S.backupState.webdav?.etag || '';
  if (remote && remote.etag && remote.etag !== known) {
    if (!confirm(_t('fork.backup.conflict', { time: remote.lastModified || '?' }))) {
      setResult(statusEl(), 'loading', _t('fork.backup.cancelled'));
      return;
    }
  }
  const { etag } = await c.put(BACKUP_FILENAME, text);
  await saveBackupState({ webdav: { etag, at: new Date().toISOString(), op: 'upload' } });
  setResult(statusEl(), 'ok', _t('fork.backup.uploaded'));
}

async function webdavRestore() {
  await flush();
  const c = webdavClient();
  const got = await c.get(BACKUP_FILENAME);
  if (!got) {
    setResult(statusEl(), 'fail', _t('fork.backup.notFound'));
    return;
  }
  const data = parseBackup(got.text);
  setResult(statusEl(), 'loading', _t('fork.backup.confirmPending'));
  openRestoreDialog(data, () => saveBackupState({ webdav: { etag: got.etag, at: new Date().toISOString(), op: 'restore' } }));
}

// Google Drive（選用；token 只放記憶體）
let driveToken = null;

function identityApi() {
  return (typeof chrome !== 'undefined' && chrome.identity) || (typeof browser !== 'undefined' && browser.identity) || null;
}

function redirectUri() {
  const id = identityApi();
  if (id?.getRedirectURL) return id.getRedirectURL();
  return `https://${browser.runtime.id}.chromiumapp.org/`;
}

function updateDriveButtons() {
  const connected = !!(driveToken && driveToken.expiresAt > Date.now());
  $('gdrive-upload').disabled = !connected;
  $('gdrive-restore').disabled = !connected;
  $('gdrive-disconnect').hidden = !connected;
  $('gdrive-connect').textContent = connected ? _t('fork.backup.gdriveConnected') : _t('fork.backup.gdriveConnect');
}

async function driveConnect() {
  // permissions.request 必須在使用者點擊的同一個同步流程內呼叫（Firefox 尤其嚴格），所以放在第一個 await 之前
  const clientId = S.fork.backup.gdrive.clientId;
  if (!clientId) throw Object.assign(new Error(_t('fork.backup.gdriveNoClientId')), { code: '' });
  const granted = await browser.permissions.request({ permissions: ['identity'] });
  await flush();
  if (!granted) throw Object.assign(new Error(_t('fork.backup.gdrivePermDenied')), { code: '' });
  const id = identityApi();
  if (!id?.launchWebAuthFlow) throw Object.assign(new Error(_t('fork.backup.gdrivePermDenied')), { code: '' });
  $('gdrive-redirect').value = redirectUri();
  const redirected = await id.launchWebAuthFlow({ url: buildAuthUrl(clientId, redirectUri()), interactive: true });
  driveToken = parseAuthRedirect(redirected);
  setResult(statusEl(), 'ok', _t('fork.backup.gdriveConnected'));
}

function driveClient() {
  return createDriveClient({
    getToken: async () => {
      if (!driveToken || driveToken.expiresAt <= Date.now()) {
        driveToken = null;
        throw Object.assign(new Error('token expired'), { code: 'auth', status: 401 });
      }
      return driveToken.token;
    },
  });
}

async function driveUpload() {
  const text = await makeBackupText();
  const c = driveClient();
  const existing = await c.find(BACKUP_FILENAME);
  const known = S.backupState.gdrive?.modifiedTime || '';
  if (existing && existing.modifiedTime !== known) {
    if (!confirm(_t('fork.backup.conflict', { time: formatTime(existing.modifiedTime) }))) {
      setResult(statusEl(), 'loading', _t('fork.backup.cancelled'));
      return;
    }
  }
  const r = await c.upload(BACKUP_FILENAME, text, existing?.id);
  await saveBackupState({ gdrive: { fileId: r.id, modifiedTime: r.modifiedTime || '', at: new Date().toISOString(), op: 'upload' } });
  setResult(statusEl(), 'ok', _t('fork.backup.uploaded'));
}

async function driveRestore() {
  await flush();
  const c = driveClient();
  const f = await c.find(BACKUP_FILENAME);
  const text = f ? await c.download(f.id) : null;
  if (!text) {
    setResult(statusEl(), 'fail', _t('fork.backup.notFound'));
    return;
  }
  const data = parseBackup(text);
  setResult(statusEl(), 'loading', _t('fork.backup.confirmPending'));
  openRestoreDialog(data, () => saveBackupState({ gdrive: { fileId: f.id, modifiedTime: f.modifiedTime || '', at: new Date().toISOString(), op: 'restore' } }));
}

async function driveDisconnect() {
  driveToken = null;
  try { await browser.permissions.remove({ permissions: ['identity'] }); } catch { /* 略 */ }
  updateDriveButtons();
  setResult(statusEl(), 'ok', _t('fork.backup.gdriveDisconnected'));
}

// ── 劃詞卡片 / 朗讀 / AI 閱讀卡 / 段落工具 ─────────────────
const STUDY_FIXED = ['preset', 'gemini', 'custom'];
const SAMPLE_TTS = 'Ekiden is a long-distance relay race that started in Japan.';

function fillSelect(sel, options, value) {
  sel.textContent = '';
  for (const [v, label] of options) sel.appendChild(el('option', { value: v, text: label }));
  if (options.some(([v]) => v === value)) sel.value = value;
}

function renderStudyEngine() {
  const options = STUDY_FIXED.map((v) => [v, _t(`fork.study.engine.${v}`)]);
  options.push(['google', engineLabel('google')]);
  for (const id of MT_CHOICES) options.push([id, engineLabel(id)]);
  for (const p of S.fork.providers) options.push([`fork-cp:${p.id}`, `${_t('fork.study.engine.provider')}: ${p.label || p.model || p.id}`]);
  fillSelect($('study-engine'), options, S.fork.study.engine);
}

function usd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function renderStudyOptions() {
  renderStudyEngine();
  fillSelect($('study-second-lang'), Object.entries(LANG_NATIVE), S.fork.study.secondLang);
  fillSelect($('tts-model'), TTS_MODELS.map((m) => {
    const p = getModalityPricing(m);
    const price = p ? ` — ${_t('fork.tts.price', { input: usd(p.input?.text ?? 0), output: usd(p.output?.audio ?? 0) })}` : '';
    return [m, m + price];
  }), S.fork.tts.model);
  fillSelect($('tts-voice'), PREBUILT_VOICES.map((v) => [v, v]), S.fork.tts.voice);
  const dl = $('explain-model-list');
  dl.textContent = '';
  for (const m of Object.keys(MODEL_PRICING)) dl.appendChild(el('option', { value: m }));
  $('explain-model').placeholder = S.geminiModel || '';
  $('explain-model-hint').textContent = _t('fork.explain.modelHint', { model: S.geminiModel || '—' });
  $('explain-prompt').value = S.explainPrompt;
  renderCopyShortcut();
  updateStudyVisibility();
}

function updateStudyVisibility() {
  const trig = S.fork.study.trigger;
  for (const n of document.querySelectorAll('[data-show-trigger]')) n.hidden = n.dataset.showTrigger !== trig;
}

function renderCopyShortcut() {
  const sc = S.fork.paragraph.copyShortcut;
  const lib = window.__SKShortcuts;
  $('para-copy-shortcut').value = sc && lib ? lib.format(sc) : '';
}

function onCopyShortcutKey(e) {
  if (e.key === 'Tab') return;
  e.preventDefault();
  const lib = window.__SKShortcuts;
  const sc = lib && lib.eventToShortcut(e);
  if (!sc) return;
  if (!sc.alt && !sc.ctrl && !sc.meta) {
    setResult($('tts-result'), 'error', _t('fork.para.shortcutNeedsModifier'));
    return;
  }
  S.fork.paragraph.copyShortcut = sc;
  renderCopyShortcut();
  markDirty('fork');
}

function renderPron() {
  const list = $('pron-list');
  list.textContent = '';
  S.pron.forEach((row, i) => {
    const mode = el('select', { 'data-pron-field': 'mode', 'data-pron-idx': i, 'aria-label': _t('fork.pron.mode') }, [
      el('option', { value: 'ipa', text: _t('fork.pron.mode.ipa') }),
      el('option', { value: 'respell', text: _t('fork.pron.mode.respell') }),
    ]);
    mode.value = row.mode;
    list.appendChild(el('div', { class: 'pron-row' }, [
      el('input', { type: 'text', spellcheck: 'false', maxlength: 80, value: row.term, 'data-pron-field': 'term', 'data-pron-idx': i, placeholder: _t('fork.pron.termPlaceholder'), 'aria-label': _t('fork.pron.term') }),
      mode,
      el('input', { type: 'text', spellcheck: 'false', maxlength: 160, value: row.value, 'data-pron-field': 'value', 'data-pron-idx': i, placeholder: _t(row.mode === 'ipa' ? 'fork.pron.ipaPlaceholder' : 'fork.pron.respellPlaceholder'), 'aria-label': _t('fork.pron.value'), class: row.mode === 'ipa' ? 'ipa' : '' }),
      el('button', { type: 'button', class: 'ghost-btn', 'data-pron-try': i, text: _t('fork.tts.try') }),
      el('button', { type: 'button', class: 'ghost-btn', 'data-pron-remove': i, text: _t('fork.providers.remove') }),
    ]));
  });
  $('pron-add').disabled = S.pron.length >= MAX_PRONUNCIATIONS;
}

function onPronChange(node) {
  const i = Number(node.dataset.pronIdx);
  if (!S.pron[i]) return;
  S.pron[i][node.dataset.pronField] = node.value;
  if (node.dataset.pronField === 'mode') renderPron();
  markDirty('pron');
}

let audioCtx = null;
async function playTts(text, mode = 'normal') {
  const out = $('tts-result');
  setResult(out, 'loading', _t('fork.tts.generating'));
  await flush(); // 讀音表要先存好，背景端才會套用
  const resp = await send('FORK_TTS', { text, mode });
  if (!resp?.ok) {
    setResult(out, 'error', errorText(resp));
    return;
  }
  try {
    if (resp.engine === 'browser') {
      const u = new SpeechSynthesisUtterance(resp.text);
      u.rate = mode === 'slow' ? 0.65 : 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      setResult(out, 'ok', _t('fork.tts.browserPlayed', { text: resp.text }));
      return;
    }
    const bin = atob(resp.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    audioCtx ||= new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const buf = await audioCtx.decodeAudioData(bytes.buffer);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
    setResult(out, 'ok', _t(resp.cached ? 'fork.tts.playedCached' : 'fork.tts.played'));
  } catch (err) {
    setResult(out, 'error', err?.message || String(err));
  }
}

async function refreshLearnCount() {
  const r = await send('FORK_LEARN_COUNT');
  $('learn-count').textContent = r?.ok ? _t('fork.learn.count', { count: r.count }) : '';
}

// ── 事件 ──────────────────────────────────────────────────
function wireEvents() {
  document.addEventListener('change', (e) => {
    const n = e.target;
    if (n.matches('[data-bind]')) {
      onBoundChange(n);
      if (n.dataset.bind === 'study.trigger') updateStudyVisibility();
    } else if (n.matches('[data-pron-field]')) onPronChange(n);
    else if (n.id === 'study-engine') {
      S.fork.study.engine = n.value;
      markDirty('fork');
    } else if (n.id === 'explain-prompt') {
      S.explainPrompt = n.value;
      markDirty('explainPrompt');
    }
    else if (n.matches('[data-secret]')) onSecretChange(n);
    else if (n.matches('[data-rate]')) onRateChange(n);
    else if (n.matches('[data-chain-toggle]')) toggleChain(n.dataset.chainToggle, n.checked);
    else if (n.matches('[data-provider-field]')) onProviderFieldChange(n);
    else if (n.matches('[data-provider-key]')) {
      const v = n.value.trim();
      if (v) S.secrets.providerKeys[n.dataset.providerKey] = v;
      else delete S.secrets.providerKeys[n.dataset.providerKey];
      markDirty('secrets');
    } else if (n.matches('[data-provider-prompt]')) {
      const id = n.closest('[data-provider]').dataset.provider;
      if (n.value.trim()) S.prompts[id] = n.value;
      else delete S.prompts[id];
      markDirty('prompts');
    } else if (n.matches('[data-preset-slot]')) {
      S.fork.presetEngines[n.dataset.presetSlot] = n.value;
      markDirty('fork');
    } else if (n.id === 'source-lang') {
      S.fork.mt.sourceLang = n.value;
      markDirty('fork');
    } else if (n.id === 'backup-file' && n.files?.[0]) {
      const f = n.files[0];
      n.value = '';
      withBusy(null, () => importLocalFile(f));
    }
  });

  document.addEventListener('click', (e) => {
    const n = e.target.closest('button');
    if (!n) return;
    if (n.hasAttribute('data-toggle-secret')) {
      const input = n.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      n.textContent = _t(show ? 'options.action.hide' : 'options.action.show');
    } else if (n.dataset.test) testEngine(n.dataset.test);
    else if (n.dataset.chainMove) moveChain(n.dataset.engine, Number(n.dataset.chainMove));
    else if (n.dataset.providerRemove) removeProvider(n.dataset.providerRemove);
    else if (n.dataset.providerTest) testProvider(n.dataset.providerTest);
    else if (n.id === 'provider-add') addProvider();
    else if (n.id === 'ct-check') checkChromeTranslator();
    else if (n.id === 'backup-export') withBusy(n, exportLocal);
    else if (n.id === 'backup-import') $('backup-file').click();
    else if (n.id === 'webdav-test') withBusy(n, webdavTest);
    else if (n.id === 'webdav-upload') withBusy(n, webdavUpload);
    else if (n.id === 'webdav-restore') withBusy(n, webdavRestore);
    else if (n.id === 'gdrive-connect') withBusy(n, driveConnect);
    else if (n.id === 'gdrive-upload') withBusy(n, driveUpload);
    else if (n.id === 'gdrive-restore') withBusy(n, driveRestore);
    else if (n.id === 'gdrive-disconnect') driveDisconnect();
    else if (n.id === 'restore-confirm') confirmRestore();
    else if (n.id === 'pron-add') {
      S.pron.push({ term: '', mode: 'ipa', value: '' });
      renderPron();
      $('pron-list').lastElementChild?.querySelector('input')?.focus();
    } else if (n.dataset.pronRemove !== undefined) {
      S.pron.splice(Number(n.dataset.pronRemove), 1);
      renderPron();
      markDirty('pron');
    } else if (n.dataset.pronTry !== undefined) {
      const row = S.pron[Number(n.dataset.pronTry)];
      if (row?.term) playTts(row.term);
    } else if (n.id === 'tts-try' || n.id === 'tts-try-slow') {
      playTts($('tts-sample').value.trim() || SAMPLE_TTS, n.id === 'tts-try-slow' ? 'slow' : 'normal');
    } else if (n.id === 'tts-clear-cache') {
      send('FORK_TTS_CLEAR_CACHE').then((r) => setResult($('tts-result'), r?.ok ? 'ok' : 'error', r?.ok ? _t('fork.tts.cacheCleared') : errorText(r)));
    } else if (n.id === 'para-copy-clear') {
      S.fork.paragraph.copyShortcut = null;
      renderCopyShortcut();
      markDirty('fork');
    }
    else if (n.id === 'restore-cancel') {
      $('restore-dialog').close();
      pendingRestore = null;
      setResult(statusEl(), 'loading', _t('fork.backup.cancelled'));
    }
  });

  $('para-copy-shortcut').addEventListener('keydown', onCopyShortcutKey);
  $('study-engine').addEventListener('focus', renderStudyEngine); // 同頁新增 / 改名的服務要出現在清單裡

  $('restore-with-keys').addEventListener('change', (e) => {
    $('restore-passphrase-row').hidden = !e.target.checked;
  });

  // 其他頁面改了翻譯預設或介面語言 → 重畫
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.translatePresets) {
      const v = changes.translatePresets.newValue;
      S.presets = Array.isArray(v) && v.length ? v : DEFAULT_SETTINGS.translatePresets;
      renderPresets();
    }
    if (changes.uiLanguage) {
      uiLang = I18N.getUiLanguage(changes.uiLanguage.newValue || 'auto');
      renderAll();
    }
    if (changes.targetLanguage) S.target = changes.targetLanguage.newValue || S.target;
  });

  window.addEventListener('beforeunload', () => { if (dirty.size) flush(); });
}

function renderAll() {
  document.documentElement.lang = uiLang;
  I18N.applyI18n(document, uiLang);
  document.title = `${_t('fork.settings.title')} — ${_t('fork.brand')}`;
  fillBoundFields();
  fillRateFields();
  renderSourceLang();
  renderPresets();
  renderChain();
  renderProviders();
  renderStudyOptions();
  renderPron();
  renderBackupState();
  updateDriveButtons();
  $('gdrive-redirect').value = redirectUri();
}

async function init() {
  await loadState();
  buildEngineExtras();
  wireEvents();
  renderAll();
  refreshStatus();
  refreshLearnCount();
  if (typeof self.Translator !== 'undefined') checkChromeTranslator();
  else {
    $('ct-status').textContent = _t('fork.ct.noApi');
    $('ct-status').dataset.state = 'warn';
  }
}

init();
