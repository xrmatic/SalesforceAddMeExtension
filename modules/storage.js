/**
 * Secure storage abstraction for the Salesforce AddMe extension.
 *
 * Sensitive data tiers
 * --------------------
 * 1. Access tokens  → chrome.storage.session  (cleared when browser closes)
 * 2. Refresh tokens → chrome.storage.local    (AES-GCM encrypted)
 * 3. Settings/config→ chrome.storage.local    (plain JSON, no PII)
 *
 * All PII (tokens, selected text) is kept only in memory or session storage
 * unless the user explicitly enables "remember me" for refresh tokens.
 */

import {
  encryptString,
  decryptString,
  generateInstallSecret,
} from './crypto.js';

import { STORAGE_KEYS, SESSION_KEYS } from './constants.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Promisify chrome.storage.local.get */
function localGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

/** Promisify chrome.storage.local.set */
function localSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** Promisify chrome.storage.local.remove */
function localRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** Promisify chrome.storage.session.get */
function sessionGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(keys, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

/** Promisify chrome.storage.session.set */
function sessionSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.set(items, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** Promisify chrome.storage.session.remove */
function sessionRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.remove(keys, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

// ─── Install secret ───────────────────────────────────────────────────────────

/**
 * Return the per-installation encryption secret, creating it on first call.
 * @returns {Promise<string>} 64-char hex secret
 */
export async function getInstallSecret() {
  const data = await localGet([STORAGE_KEYS.INSTALL_SECRET]);
  if (data[STORAGE_KEYS.INSTALL_SECRET]) return data[STORAGE_KEYS.INSTALL_SECRET];

  const secret = generateInstallSecret();
  await localSet({ [STORAGE_KEYS.INSTALL_SECRET]: secret });
  return secret;
}

// ─── Salesforce instance config ───────────────────────────────────────────────

/**
 * Return all saved Salesforce instance configs.
 * @returns {Promise<Array<{id, name, loginUrl, clientId, rememberTokens}>>}
 */
export async function getInstances() {
  const data = await localGet([STORAGE_KEYS.INSTANCES]);
  return data[STORAGE_KEYS.INSTANCES] ?? [];
}

/**
 * Persist the instances array.
 * @param {Array} instances
 */
export async function saveInstances(instances) {
  await localSet({ [STORAGE_KEYS.INSTANCES]: instances });
}

/**
 * Get the ID of the currently active Salesforce instance.
 * @returns {Promise<string|null>}
 */
export async function getActiveInstanceId() {
  const data = await localGet([STORAGE_KEYS.ACTIVE_INSTANCE]);
  return data[STORAGE_KEYS.ACTIVE_INSTANCE] ?? null;
}

/**
 * Set the active Salesforce instance.
 * @param {string} instanceId
 */
export async function setActiveInstanceId(instanceId) {
  await localSet({ [STORAGE_KEYS.ACTIVE_INSTANCE]: instanceId });
}

// ─── Access tokens (session storage – volatile) ───────────────────────────────

/**
 * Retrieve the in-session access token for an instance.
 * @param {string} instanceId
 * @returns {Promise<{accessToken, instanceUrl, issuedAt}|null>}
 */
export async function getSessionToken(instanceId) {
  const data = await sessionGet([SESSION_KEYS.TOKENS]);
  const map  = data[SESSION_KEYS.TOKENS] ?? {};
  return map[instanceId] ?? null;
}

/**
 * Persist an access token in session storage (not persisted across restarts).
 * @param {string} instanceId
 * @param {{accessToken: string, instanceUrl: string, issuedAt: number}} tokenData
 */
export async function setSessionToken(instanceId, tokenData) {
  const data = await sessionGet([SESSION_KEYS.TOKENS]);
  const map  = data[SESSION_KEYS.TOKENS] ?? {};
  map[instanceId] = tokenData;
  await sessionSet({ [SESSION_KEYS.TOKENS]: map });
}

/**
 * Remove the session token for a given instance (logout / token invalid).
 * @param {string} instanceId
 */
export async function clearSessionToken(instanceId) {
  const data = await sessionGet([SESSION_KEYS.TOKENS]);
  const map  = data[SESSION_KEYS.TOKENS] ?? {};
  delete map[instanceId];
  await sessionSet({ [SESSION_KEYS.TOKENS]: map });
}

// ─── Refresh tokens (local storage – AES-GCM encrypted) ──────────────────────

/**
 * Save an encrypted refresh token for an instance.
 * Only call this when the user has opted in to "remember tokens".
 * @param {string} instanceId
 * @param {string} refreshToken
 */
export async function saveRefreshToken(instanceId, refreshToken) {
  const secret  = await getInstallSecret();
  const encrypted = await encryptString(refreshToken, secret);

  const data = await localGet([STORAGE_KEYS.REFRESH_TOKENS]);
  const map  = data[STORAGE_KEYS.REFRESH_TOKENS] ?? {};
  map[instanceId] = encrypted;
  await localSet({ [STORAGE_KEYS.REFRESH_TOKENS]: map });
}

/**
 * Retrieve and decrypt the stored refresh token for an instance.
 * @param {string} instanceId
 * @returns {Promise<string|null>}
 */
export async function getRefreshToken(instanceId) {
  const data = await localGet([STORAGE_KEYS.REFRESH_TOKENS]);
  const map  = data[STORAGE_KEYS.REFRESH_TOKENS] ?? {};
  if (!map[instanceId]) return null;

  const secret = await getInstallSecret();
  try {
    return await decryptString(map[instanceId], secret);
  } catch {
    // If decryption fails (key rotation, corruption), treat as no token.
    return null;
  }
}

/**
 * Remove the refresh token for an instance (logout).
 * @param {string} instanceId
 */
export async function clearRefreshToken(instanceId) {
  const data = await localGet([STORAGE_KEYS.REFRESH_TOKENS]);
  const map  = data[STORAGE_KEYS.REFRESH_TOKENS] ?? {};
  delete map[instanceId];
  await localSet({ [STORAGE_KEYS.REFRESH_TOKENS]: map });
}

// ─── Selected text (session – PII) ────────────────────────────────────────────

/**
 * Temporarily cache selected text from the content script.
 * Stored in chrome.storage.session so it is automatically cleared on browser close.
 * @param {string} text
 */
export async function cacheSelectedText(text) {
  await sessionSet({ [SESSION_KEYS.SELECTED_TEXT]: text });
}

/**
 * Read and clear the cached selected text (one-shot).
 * @returns {Promise<string|null>}
 */
export async function consumeSelectedText() {
  const data = await sessionGet([SESSION_KEYS.SELECTED_TEXT]);
  const text = data[SESSION_KEYS.SELECTED_TEXT] ?? null;
  if (text !== null) await sessionRemove([SESSION_KEYS.SELECTED_TEXT]);
  return text;
}

// ─── Full instance logout ─────────────────────────────────────────────────────

/**
 * Completely sign out from one instance – removes session token, refresh token.
 * @param {string} instanceId
 */
export async function logoutInstance(instanceId) {
  await clearSessionToken(instanceId);
  await clearRefreshToken(instanceId);
}

/**
 * Remove an instance configuration and all associated credentials.
 * @param {string} instanceId
 */
export async function removeInstance(instanceId) {
  await logoutInstance(instanceId);
  const instances = await getInstances();
  const updated   = instances.filter((i) => i.id !== instanceId);
  await saveInstances(updated);

  const activeId = await getActiveInstanceId();
  if (activeId === instanceId) {
    const next = updated[0];
    await setActiveInstanceId(next ? next.id : null);
  }
}
