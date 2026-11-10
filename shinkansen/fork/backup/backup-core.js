// fork/backup/backup-core.js — 驛傳備份檔的產生與還原（本機檔案 / WebDAV / Google Drive 共用）
//
// 內容（format 'ekiden-backup' v1）：
//   settings  與上游「匯出設定」相同：storage.sync 全部 + 固定術語表 / 禁用詞（local），
//             不含 Gemini apiKey、Instapaper 帳號連結；驛傳的 'fork' 設定也在其中
//   forkLocal 存在 storage.local 的驛傳設定：額外 OpenAI 相容服務的自訂 prompt、
//             自訂讀音表、AI 閱讀卡的自訂指示（後兩項是第 2 階段加的；舊備份沒有就不動目前的值）
//   secrets   **預設 null**。使用者勾選「包含 API 金鑰」時，才把金鑰以使用者自訂密語加密後放入
//             （Gemini / 自訂模型 / 驛傳各服務的金鑰；WebDAV 密碼本身永不放入）
//
// 還原一律經過上游 sanitizeImport（已含驛傳 'fork' 規則），不認識的欄位丟掉。
// 安全規則比照上游匯入：服務網址換到不同網域、而備份沒有一併還原金鑰時，清掉該服務的舊金鑰，
// 避免既有金鑰被送到備份檔指定的另一台主機。

import { encryptJson, decryptJson, MIN_PASSPHRASE_LENGTH } from './crypto.js';
import {
  FORK_SYNC_KEY, FORK_SECRETS_KEY, FORK_PROVIDER_PROMPTS_KEY, FORK_EXPLAIN_PROMPT_KEY,
  sanitizeSecrets, sanitizeProviderPrompts, sanitizeExplainPrompt, mergeForkSettings,
} from '../settings/schema.js';
import { PRONUNCIATIONS_KEY, sanitizePronunciations } from '../tts/pronounce.js';

export const BACKUP_FORMAT = 'ekiden-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_FILENAME = 'ekiden-backup.json';

// 與上游 options.js 匯出規則一致：Instapaper 帳號連結不進備份
const EXCLUDED_SYNC_KEYS = ['apiKey', 'instapaperToken', 'instapaperTokenSecret', 'instapaperUsername'];

function originOf(u) {
  try { return new URL(String(u || '').trim()).origin; } catch { return null; }
}

/**
 * @param {object} deps
 * @param {object} deps.storage   { sync: {get}, local: {get} }
 * @param {string[]} deps.localSettingsKeys  上游 LOCAL_SETTINGS_KEYS
 * @param {object} opts
 * @param {boolean} opts.includeKeys
 * @param {string} [opts.passphrase]  includeKeys 時必填
 * @param {string} [opts.extVersion]
 * @param {number} [opts.now]
 */
export async function buildBackup(deps, { includeKeys = false, passphrase = '', extVersion = '', now = Date.now() } = {}) {
  const { storage, localSettingsKeys } = deps;
  const settings = await storage.sync.get(null);
  const localSettings = await storage.local.get([
    ...localSettingsKeys, FORK_PROVIDER_PROMPTS_KEY, PRONUNCIATIONS_KEY, FORK_EXPLAIN_PROMPT_KEY,
  ]);
  for (const k of localSettingsKeys) {
    if (Object.prototype.hasOwnProperty.call(localSettings, k)) settings[k] = localSettings[k];
  }
  for (const k of EXCLUDED_SYNC_KEYS) delete settings[k];

  let secrets = null;
  if (includeKeys) {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      const err = new Error('passphrase required');
      err.code = 'passphraseRequired';
      throw err;
    }
    const local = await storage.local.get(['apiKey', 'customProviderApiKey', FORK_SECRETS_KEY]);
    const forkSecrets = sanitizeSecrets(local[FORK_SECRETS_KEY]);
    delete forkSecrets.webdavPassword;
    secrets = await encryptJson({
      apiKey: typeof local.apiKey === 'string' ? local.apiKey : '',
      customProviderApiKey: typeof local.customProviderApiKey === 'string' ? local.customProviderApiKey : '',
      forkSecrets,
    }, passphrase);
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date(now).toISOString(),
    extVersion,
    settings,
    forkLocal: {
      providerPrompts: sanitizeProviderPrompts(localSettings[FORK_PROVIDER_PROMPTS_KEY]),
      pronunciations: sanitizePronunciations(localSettings[PRONUNCIATIONS_KEY]),
      explainPrompt: sanitizeExplainPrompt(localSettings[FORK_EXPLAIN_PROMPT_KEY]),
    },
    secrets,
  };
}

export function parseBackup(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    const err = new Error('not JSON');
    err.code = 'notJson';
    throw err;
  }
  if (!data || data.format !== BACKUP_FORMAT || typeof data.settings !== 'object') {
    const err = new Error('not an Ekiden backup');
    err.code = 'notBackup';
    throw err;
  }
  if (data.version > BACKUP_VERSION) {
    const err = new Error('backup is from a newer version');
    err.code = 'newerVersion';
    throw err;
  }
  return data;
}

/** 備份摘要（還原前給使用者確認用）。 */
export function summarizeBackup(data) {
  const fork = mergeForkSettings(data.settings?.fork);
  return {
    createdAt: data.createdAt || '',
    extVersion: data.extVersion || '',
    settingKeys: Object.keys(data.settings || {}).length,
    providers: fork.providers.length,
    hasSecrets: !!data.secrets,
  };
}

/**
 * @param {object} data  parseBackup 的結果
 * @param {object} deps
 * @param {object} deps.storage  { sync: {get,set}, local: {get,set,remove} }
 * @param {Function} deps.sanitizeImport  (raw) => { clean, warnings }（已綁 _t / SC 的上游函式）
 * @param {Function} deps.splitSettingsPatch
 * @param {object} opts
 * @param {boolean} [opts.restoreKeys]
 * @param {string} [opts.passphrase]
 * @returns {Promise<{ warnings: string[], restoredKeys: boolean, clearedKeys: string[] }>}
 */
export async function restoreBackup(data, deps, { restoreKeys = false, passphrase = '' } = {}) {
  const { storage, sanitizeImport, splitSettingsPatch } = deps;
  const raw = { ...(data.settings || {}) };
  for (const k of EXCLUDED_SYNC_KEYS) delete raw[k];

  // 先解密（密語錯誤時整個還原中止，不寫入一半）
  let secrets = null;
  if (restoreKeys && data.secrets) {
    secrets = await decryptJson(data.secrets, passphrase);
  }

  const { clean, warnings } = sanitizeImport(raw);

  // 目前的狀態（判斷服務網址是否換了網域）
  const cur = await storage.sync.get(['customProvider', FORK_SYNC_KEY]);
  const curFork = mergeForkSettings(cur[FORK_SYNC_KEY]);
  const curLocal = await storage.local.get(['customProviderApiKey', FORK_SECRETS_KEY]);
  const curSecrets = sanitizeSecrets(curLocal[FORK_SECRETS_KEY]);
  const clearedKeys = [];

  const { syncPart, localPart } = splitSettingsPatch(clean);
  if (Object.keys(localPart).length) await storage.local.set(localPart);
  if (Object.keys(syncPart).length) await storage.sync.set(syncPart);

  const forkLocal = data.forkLocal || {};
  const localPatch = { [FORK_PROVIDER_PROMPTS_KEY]: sanitizeProviderPrompts(forkLocal.providerPrompts) };
  if (Object.prototype.hasOwnProperty.call(forkLocal, 'pronunciations')) {
    localPatch[PRONUNCIATIONS_KEY] = sanitizePronunciations(forkLocal.pronunciations);
  }
  if (Object.prototype.hasOwnProperty.call(forkLocal, 'explainPrompt')) {
    localPatch[FORK_EXPLAIN_PROMPT_KEY] = sanitizeExplainPrompt(forkLocal.explainPrompt);
  }
  await storage.local.set(localPatch);

  if (secrets) {
    const restored = sanitizeSecrets(secrets.forkSecrets);
    if (curSecrets.webdavPassword) restored.webdavPassword = curSecrets.webdavPassword; // WebDAV 密碼不隨備份移動
    const patch = { [FORK_SECRETS_KEY]: restored };
    if (typeof secrets.apiKey === 'string' && secrets.apiKey) patch.apiKey = secrets.apiKey;
    if (typeof secrets.customProviderApiKey === 'string') patch.customProviderApiKey = secrets.customProviderApiKey;
    await storage.local.set(patch);
    return { warnings, restoredKeys: true, clearedKeys };
  }

  // 沒還原金鑰：網址換網域的服務清掉舊金鑰
  const nextCpUrl = clean.customProvider?.baseUrl;
  if (typeof nextCpUrl === 'string' && curLocal.customProviderApiKey
      && originOf(nextCpUrl) !== originOf(cur.customProvider?.baseUrl)) {
    await storage.local.remove('customProviderApiKey');
    clearedKeys.push('customProvider');
  }
  if (clean.fork) {
    const next = clean.fork;
    const s = { ...curSecrets, providerKeys: { ...curSecrets.providerKeys } };
    let changed = false;
    for (const [id, key] of Object.entries(curSecrets.providerKeys)) {
      const before = curFork.providers.find((p) => p.id === id);
      const after = next.providers.find((p) => p.id === id);
      if (key && (!after || !before || originOf(after.baseUrl) !== originOf(before.baseUrl))) {
        delete s.providerKeys[id];
        clearedKeys.push(`provider:${id}`);
        changed = true;
      }
    }
    if (s.deeplxToken && originOf(next.mt.deeplx.url) !== originOf(curFork.mt.deeplx.url)) {
      delete s.deeplxToken;
      clearedKeys.push('deeplx');
      changed = true;
    }
    if (s.azureKey && (next.mt.azure.endpoint || '') !== (curFork.mt.azure.endpoint || '')) {
      delete s.azureKey;
      clearedKeys.push('azure');
      changed = true;
    }
    if (changed) await storage.local.set({ [FORK_SECRETS_KEY]: s });
  }
  return { warnings, restoredKeys: false, clearedKeys };
}
