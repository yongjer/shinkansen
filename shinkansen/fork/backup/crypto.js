// fork/backup/crypto.js — 備份檔內金鑰的加密（WebCrypto：PBKDF2-SHA256 推導金鑰 + AES-GCM）
//
// 只有使用者勾選「備份包含 API 金鑰」時才會用到，密語由使用者自訂、不會儲存。
// 密語遺失就無法解開金鑰（設定本身仍可還原）。

export const KDF_ITERATIONS = 310_000; // OWASP 2023 對 PBKDF2-HMAC-SHA256 的建議下限
export const MIN_PASSPHRASE_LENGTH = 8;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToBase64(str) {
  return bytesToBase64(enc.encode(str));
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJson(value, passphrase, { iterations = KDF_ITERATIONS } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error('passphrase too short');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iter: iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(data),
  };
}

export async function decryptJson(envelope, passphrase) {
  if (!envelope || envelope.alg !== 'AES-GCM' || envelope.kdf !== 'PBKDF2-SHA256') {
    throw new Error('unsupported envelope');
  }
  const iter = Number(envelope.iter);
  if (!Number.isInteger(iter) || iter < 100_000 || iter > 10_000_000) throw new Error('bad iteration count');
  const key = await deriveKey(String(passphrase || ''), base64ToBytes(envelope.salt), iter);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.data));
  } catch {
    const err = new Error('wrong passphrase or corrupted data');
    err.code = 'badPassphrase';
    throw err;
  }
  return JSON.parse(dec.decode(plain));
}
