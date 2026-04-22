/**
 * Cryptographic utilities using the browser's built-in Web Crypto API.
 * No external libraries are used.
 *
 * Strategy
 * --------
 * A random 256-bit "install secret" is generated once and stored in
 * chrome.storage.local.  When we need to encrypt/decrypt, we derive an
 * AES-GCM key from that secret + a fixed "purpose" string via HKDF so that
 * different data classes can use different derived keys without extra secrets.
 *
 * Ciphertext layout (all binary concatenated, then base64url-encoded):
 *   [ 12-byte IV ][ N-byte AES-GCM ciphertext+tag ]
 */

const HKDF_INFO_REFRESH_TOKEN = new TextEncoder().encode('sf-addme-refresh-token-v1');
const AES_KEY_BITS = 256;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a Uint8Array to a hex string. */
export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Convert a hex string to a Uint8Array. */
export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Encode bytes to base64url (no padding). */
export function base64urlEncode(bytes) {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Decode base64url to Uint8Array. */
export function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen  = (4 - (padded.length % 4)) % 4;
  const b64     = padded + '='.repeat(padLen);
  const binary  = atob(b64);
  const bytes   = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

/** Generate a cryptographically random PKCE code verifier (43-128 chars). */
export function generateCodeVerifier() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(48));
  return base64urlEncode(randomBytes);
}

/** Derive the S256 code challenge from a verifier. */
export async function deriveCodeChallenge(verifier) {
  const encoded  = new TextEncoder().encode(verifier);
  const digest   = await crypto.subtle.digest('SHA-256', encoded);
  return base64urlEncode(new Uint8Array(digest));
}

// ─── Install secret ───────────────────────────────────────────────────────────

/** Generate a fresh 256-bit install secret as a hex string. */
export function generateInstallSecret() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// ─── Key derivation ───────────────────────────────────────────────────────────

/**
 * Derive an AES-GCM key from the install secret (hex) using HKDF-SHA-256.
 * @param {string} secretHex  - The 64-char hex install secret.
 * @param {Uint8Array} info   - Context/purpose bytes (domain separation).
 * @returns {Promise<CryptoKey>}
 */
async function deriveAesKey(secretHex, info) {
  const rawSecret = hexToBytes(secretHex);

  // Import the raw secret as an HKDF key.
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    rawSecret,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );

  // Derive the final AES-GCM key.
  return crypto.subtle.deriveKey(
    {
      name:   'HKDF',
      hash:   'SHA-256',
      salt:   new Uint8Array(32), // zero salt – the info provides domain separation
      info,
    },
    hkdfKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt a plain-text string using AES-GCM.
 * @param {string} plaintext   - Data to encrypt.
 * @param {string} secretHex   - 64-char hex install secret.
 * @returns {Promise<string>}  - base64url-encoded ciphertext blob.
 */
export async function encryptString(plaintext, secretHex) {
  const key       = await deriveAesKey(secretHex, HKDF_INFO_REFRESH_TOKEN);
  const iv        = crypto.getRandomValues(new Uint8Array(12));
  const encoded   = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  // Concatenate IV + ciphertext then base64url-encode.
  const combined = new Uint8Array(iv.byteLength + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.byteLength);
  return base64urlEncode(combined);
}

/**
 * Decrypt a base64url-encoded AES-GCM ciphertext blob.
 * @param {string} ciphertextB64 - Output of encryptString.
 * @param {string} secretHex     - 64-char hex install secret.
 * @returns {Promise<string>}    - Original plaintext.
 */
export async function decryptString(ciphertextB64, secretHex) {
  const key      = await deriveAesKey(secretHex, HKDF_INFO_REFRESH_TOKEN);
  const combined = base64urlDecode(ciphertextB64);
  const iv       = combined.slice(0, 12);
  const cipher   = combined.slice(12);

  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plainBuf);
}

// ─── SHA-256 hashing (non-secret, e.g. for cache keys) ───────────────────────

/**
 * Compute a hex SHA-256 hash of a string.  Used for building non-sensitive
 * composite cache / storage keys without exposing raw data.
 */
export async function sha256Hex(str) {
  const encoded = new TextEncoder().encode(str);
  const buf     = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(buf));
}
