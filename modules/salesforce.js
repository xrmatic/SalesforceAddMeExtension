/**
 * Salesforce REST API client for the Salesforce AddMe extension.
 *
 * All public functions accept an `instanceId` string and resolve the
 * corresponding access token internally via `getValidToken()`.
 *
 * Conventions
 * -----------
 * - HTTP 401 → token refresh is attempted once automatically.
 * - HTTP 429 / 5xx → exponential back-off + retry.
 * - All sensitive values (tokens, record IDs) are treated as opaque strings.
 * - No external HTTP libraries are used – plain fetch() only.
 */

import { getValidToken, refreshAccessToken } from './auth.js';
import {
  SF_API_VERSION,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  DUPLICATE_CHECK_LIMIT,
  DUPLICATE_KEY_FIELDS,
} from './constants.js';

// ─── Internal request helper ──────────────────────────────────────────────────

/**
 * Make an authenticated Salesforce REST API request with retry logic.
 *
 * @param {string}  instanceId
 * @param {string}  path       - API path (relative to /services/data/<version>/)
 * @param {object}  [options]  - fetch options (method, headers, body, etc.)
 * @param {boolean} [retry401] - whether to attempt one token refresh on 401
 * @returns {Promise<any>}     - parsed JSON response
 */
async function sfRequest(instanceId, path, options = {}, retry401 = true) {
  let { accessToken, instanceUrl } = await getValidToken(instanceId);

  const baseUrl = `${instanceUrl.replace(/\/$/, '')}/services/data/${SF_API_VERSION}`;
  const url     = path.startsWith('http') ? path : `${baseUrl}/${path.replace(/^\//, '')}`;

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    const resp = await fetch(url, {
      ...options,
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept:         'application/json',
        ...options.headers,
      },
    });

    if (resp.status === 401 && retry401) {
      // Attempt silent token refresh, then retry once.
      try {
        ({ accessToken } = await refreshAccessToken(instanceId));
        return sfRequest(instanceId, path, options, false);
      } catch (e) {
        throw new Error('Session expired – please re-authenticate.');
      }
    }

    if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
      // Back-off before retry.
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      lastError = new Error(`HTTP ${resp.status} – retrying…`);
      continue;
    }

    if (!resp.ok) {
      let detail = '';
      try {
        const errBody = await resp.json();
        detail = Array.isArray(errBody)
          ? errBody.map((e) => `${e.errorCode}: ${e.message}`).join('; ')
          : JSON.stringify(errBody);
      } catch {
        detail = await resp.text().catch(() => '');
      }
      throw new Error(`Salesforce API error (${resp.status}): ${detail}`);
    }

    if (resp.status === 204) return null; // No Content (e.g. DELETE)

    return resp.json();
  }

  throw lastError ?? new Error('Request failed after maximum retries');
}

// ─── Object metadata ──────────────────────────────────────────────────────────

/**
 * Return the global object list (name, label, createable, updateable).
 * @returns {Promise<Array<{name, label, createable, updateable}>>}
 */
export async function listObjects(instanceId) {
  const data = await sfRequest(instanceId, 'sobjects');
  return (data.sobjects ?? [])
    .filter((o) => o.createable)
    .map(({ name, label, createable, updateable }) => ({ name, label, createable, updateable }));
}

/**
 * Return field metadata for a specific SObject.
 * @param {string} objectName  e.g. 'Lead'
 * @returns {Promise<Array<{name, label, type, required, updateable}>>}
 */
export async function describeObject(instanceId, objectName) {
  const data = await sfRequest(instanceId, `sobjects/${objectName}/describe`);
  return (data.fields ?? []).map(({ name, label, type, nillable, updateable, createable }) => ({
    name,
    label,
    type,
    required: !nillable,
    updateable,
    createable,
  }));
}

// ─── SOQL query ───────────────────────────────────────────────────────────────

/**
 * Execute a SOQL query and return the records array.
 * @param {string} soql
 * @returns {Promise<Array<Record<string,any>>>}
 */
export async function query(instanceId, soql) {
  const encoded = encodeURIComponent(soql);
  const data    = await sfRequest(instanceId, `query?q=${encoded}`);
  return data.records ?? [];
}

// ─── Duplicate checking ────────────────────────────────────────────────────────

/**
 * Search for potential duplicate records before upserting.
 *
 * @param {string} instanceId
 * @param {string} objectName  e.g. 'Lead'
 * @param {Record<string,any>} record  Field values to check
 * @returns {Promise<Array<{Id, Name|Email|…}>>}  Matching existing records
 */
export async function findDuplicates(instanceId, objectName, record) {
  const keyField = DUPLICATE_KEY_FIELDS[objectName];
  if (!keyField) return []; // No key field configured for this object.

  const keyValue = record[keyField];
  if (!keyValue) return [];

  // Determine which fields to retrieve for display.
  const displayFields = ['Id', 'Name', 'Email', 'Phone', 'Company', 'Title']
    .filter((f) => f !== keyField);

  const soql = `SELECT Id, ${[keyField, ...displayFields].join(', ')}
                FROM ${objectName}
                WHERE ${keyField} = '${escapeSoqlValue(String(keyValue))}'
                LIMIT ${DUPLICATE_CHECK_LIMIT}`;

  try {
    return await query(instanceId, soql);
  } catch {
    // If the query fails (field not on object, etc.) return empty.
    return [];
  }
}

// ─── CRUD / Upsert ────────────────────────────────────────────────────────────

/**
 * Create a new SObject record.
 * @returns {Promise<{id, success, errors}>}
 */
export async function createRecord(instanceId, objectName, fields) {
  return sfRequest(instanceId, `sobjects/${objectName}`, {
    method: 'POST',
    body:   JSON.stringify(fields),
  });
}

/**
 * Update an existing SObject record.
 * @param {string} recordId  Salesforce 18-char ID
 * @returns {Promise<null>}  204 No Content on success
 */
export async function updateRecord(instanceId, objectName, recordId, fields) {
  // Remove read-only Id from patch body if present.
  const { Id: _id, ...patchFields } = fields;
  return sfRequest(instanceId, `sobjects/${objectName}/${recordId}`, {
    method: 'PATCH',
    body:   JSON.stringify(patchFields),
  });
}

/**
 * Upsert a record by an external-ID field.
 * Falls back to create if no external ID field is available.
 *
 * @param {string} instanceId
 * @param {string} objectName
 * @param {Record<string,any>} fields
 * @param {string|null} [externalIdField]  e.g. 'Email' for Lead
 * @param {string|null} [externalIdValue]
 * @returns {Promise<{id, created, success, errors}|null>}
 */
export async function upsertRecord(
  instanceId,
  objectName,
  fields,
  externalIdField = null,
  externalIdValue = null,
) {
  if (externalIdField && externalIdValue) {
    const { Id: _id, ...upsertFields } = fields;
    const safePath = `sobjects/${objectName}/${externalIdField}/${encodeURIComponent(String(externalIdValue))}`;
    return sfRequest(instanceId, safePath, {
      method: 'PATCH',
      body:   JSON.stringify(upsertFields),
    });
  }

  // No external ID – plain create.
  return createRecord(instanceId, objectName, fields);
}

/**
 * Delete a record by ID.
 * @returns {Promise<null>}
 */
export async function deleteRecord(instanceId, objectName, recordId) {
  return sfRequest(instanceId, `sobjects/${objectName}/${recordId}`, {
    method: 'DELETE',
  });
}

// ─── Connection health ────────────────────────────────────────────────────────

/**
 * Ping Salesforce to verify the current access token is valid.
 * Uses the lightweight /limits endpoint.
 *
 * @returns {Promise<boolean>}  true = connected, false = not
 */
export async function checkConnection(instanceId) {
  try {
    await sfRequest(instanceId, 'limits', {}, false);
    return true;
  } catch {
    return false;
  }
}

// ─── SOSL cross-object search ─────────────────────────────────────────────────

/**
 * Perform a SOSL search across multiple objects.
 *
 * @param {string} instanceId
 * @param {string} searchTerm
 * @param {string[]} objects  e.g. ['Account', 'Contact', 'Lead']
 * @returns {Promise<Array<{type, records}>>}
 */
export async function soslSearch(instanceId, searchTerm, objects = ['Account', 'Contact', 'Lead']) {
  const returning = objects
    .map((o) => `${o}(Id, Name LIMIT 5)`)
    .join(', ');
  const sosl = `FIND {${escapeSOSLTerm(searchTerm)}} IN ALL FIELDS RETURNING ${returning}`;
  const encoded = encodeURIComponent(sosl);

  try {
    const data = await sfRequest(instanceId, `search?q=${encoded}`);
    return data.searchRecords ?? [];
  } catch {
    return [];
  }
}

// ─── SOQL helpers ─────────────────────────────────────────────────────────────

/** Escape a value for use inside a SOQL string literal. */
function escapeSoqlValue(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Escape a term for use inside a SOSL FIND clause. */
function escapeSOSLTerm(str) {
  return str.replace(/[?&|!{}[\]()^~*:\\"'+-]/g, (ch) => `\\${ch}`);
}

// ─── Custom-object helpers ────────────────────────────────────────────────────

/**
 * Return only custom objects (API names ending with __c) that are createable.
 * @returns {Promise<Array<{name, label}>>}
 */
export async function listCustomObjects(instanceId) {
  const all = await listObjects(instanceId);
  return all.filter((o) => o.name.endsWith('__c'));
}
