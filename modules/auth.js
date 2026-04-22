/**
 * Salesforce OAuth 2.0 PKCE authentication for the Salesforce AddMe extension.
 *
 * Flow
 * ----
 * 1. The options page calls `startOAuthFlow(instance)`.
 * 2. We generate a PKCE verifier + challenge and launch `chrome.identity.launchWebAuthFlow`.
 * 3. Salesforce redirects to the extension callback URL with `code=…`.
 * 4. We exchange the code for access + refresh tokens via the token endpoint.
 * 5. Access token → chrome.storage.session (volatile).
 *    Refresh token → chrome.storage.local encrypted (if rememberTokens is true).
 *
 * Token refresh
 * -------------
 * `refreshAccessToken(instanceId)` is called by the connection-health poller
 * or on 401 responses.  If the refresh token is missing the function throws
 * so the caller can prompt the user to re-authenticate.
 */

import { generateCodeVerifier, deriveCodeChallenge } from './crypto.js';
import {
  getSessionToken,
  setSessionToken,
  clearSessionToken,
  saveRefreshToken,
  getRefreshToken,
  clearRefreshToken,
  getInstances,
} from './storage.js';
import { SF_OAUTH_SCOPES, OAUTH_TIMEOUT_MS } from './constants.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the Salesforce authorisation URL.
 */
function buildAuthUrl(loginUrl, clientId, redirectUri, codeChallenge) {
  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    redirect_uri:          redirectUri,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    scope:                 SF_OAUTH_SCOPES,
  });
  return `${loginUrl.replace(/\/$/, '')}/services/oauth2/authorize?${params}`;
}

/**
 * Parse the code from the redirect URL returned by chrome.identity.launchWebAuthFlow.
 * @param {string} responseUrl
 * @returns {string} authorisation code
 */
function extractCodeFromResponse(responseUrl) {
  const url    = new URL(responseUrl);
  const code   = url.searchParams.get('code');
  const error  = url.searchParams.get('error');
  const desc   = url.searchParams.get('error_description');

  if (error)  throw new Error(`OAuth error: ${error} – ${desc ?? ''}`);
  if (!code)  throw new Error('No authorisation code in callback URL');
  return code;
}

/**
 * Exchange an authorisation code for tokens.
 * @returns {Promise<{access_token, refresh_token, instance_url, issued_at}>}
 */
async function exchangeCodeForTokens(loginUrl, clientId, redirectUri, code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    code,
    code_verifier: codeVerifier,
  });

  const resp = await fetch(
    `${loginUrl.replace(/\/$/, '')}/services/oauth2/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  return resp.json();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initiate the OAuth PKCE flow for a given instance config.
 *
 * @param {{id, name, loginUrl, clientId, rememberTokens}} instance
 * @returns {Promise<void>}  resolves on success, rejects on failure/timeout
 */
export async function startOAuthFlow(instance) {
  const { id, loginUrl, clientId, rememberTokens } = instance;

  const redirectUri     = chrome.identity.getRedirectURL();
  const codeVerifier    = generateCodeVerifier();
  const codeChallenge   = await deriveCodeChallenge(codeVerifier);
  const authUrl         = buildAuthUrl(loginUrl, clientId, redirectUri, codeChallenge);

  // Wrap launchWebAuthFlow in a timeout-aware promise.
  const responseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('OAuth flow timed out')),
      OAUTH_TIMEOUT_MS,
    );

    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (url) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!url) {
          reject(new Error('OAuth flow cancelled or returned no URL'));
        } else {
          resolve(url);
        }
      },
    );
  });

  const code   = extractCodeFromResponse(responseUrl);
  const tokens = await exchangeCodeForTokens(
    loginUrl, clientId, redirectUri, code, codeVerifier,
  );

  // Store access token in session storage.
  await setSessionToken(id, {
    accessToken:  tokens.access_token,
    instanceUrl:  tokens.instance_url ?? loginUrl,
    issuedAt:     tokens.issued_at ?? Date.now(),
  });

  // Optionally persist encrypted refresh token.
  if (rememberTokens && tokens.refresh_token) {
    await saveRefreshToken(id, tokens.refresh_token);
  }
}

/**
 * Attempt to refresh the access token using a stored refresh token.
 *
 * @param {string} instanceId
 * @returns {Promise<{accessToken, instanceUrl, issuedAt}>}
 * @throws if no refresh token is available or the refresh request fails.
 */
export async function refreshAccessToken(instanceId) {
  const instances = await getInstances();
  const instance  = instances.find((i) => i.id === instanceId);
  if (!instance)  throw new Error(`Unknown instance: ${instanceId}`);

  const refreshToken = await getRefreshToken(instanceId);
  if (!refreshToken) throw new Error('No refresh token stored – please re-authenticate');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     instance.clientId,
    refresh_token: refreshToken,
  });

  const resp = await fetch(
    `${instance.loginUrl.replace(/\/$/, '')}/services/oauth2/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );

  if (!resp.ok) {
    // Refresh token may be revoked – clear it.
    await clearRefreshToken(instanceId);
    await clearSessionToken(instanceId);
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  const tokens = await resp.json();
  const tokenData = {
    accessToken: tokens.access_token,
    instanceUrl: tokens.instance_url ?? instance.loginUrl,
    issuedAt:    tokens.issued_at ?? Date.now(),
  };
  await setSessionToken(instanceId, tokenData);

  // Update the stored refresh token if the server rotated it.
  if (tokens.refresh_token) {
    await saveRefreshToken(instanceId, tokens.refresh_token);
  }

  return tokenData;
}

/**
 * Revoke the access token from Salesforce and clear local storage.
 *
 * @param {string} instanceId
 */
export async function revokeToken(instanceId) {
  const session = await getSessionToken(instanceId);

  if (session) {
    try {
      const instances = await getInstances();
      const instance  = instances.find((i) => i.id === instanceId);
      if (instance) {
        await fetch(
          `${instance.loginUrl.replace(/\/$/, '')}/services/oauth2/revoke`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    new URLSearchParams({ token: session.accessToken }),
          },
        );
      }
    } catch {
      // Best-effort revocation; always clear local state regardless.
    }
  }

  await clearSessionToken(instanceId);
  await clearRefreshToken(instanceId);
}

/**
 * Get a valid access token for an instance.
 * Tries session storage first; falls back to token refresh if available.
 *
 * @param {string} instanceId
 * @returns {Promise<{accessToken, instanceUrl}>}
 * @throws if not authenticated
 */
export async function getValidToken(instanceId) {
  let session = await getSessionToken(instanceId);

  if (!session) {
    // Try to silently refresh.
    try {
      session = await refreshAccessToken(instanceId);
    } catch {
      throw new Error('Not authenticated – please log in from the Options page.');
    }
  }

  return session;
}

/**
 * Return true if the instance currently has a valid session token.
 * @param {string} instanceId
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated(instanceId) {
  const session = await getSessionToken(instanceId);
  return !!session;
}
