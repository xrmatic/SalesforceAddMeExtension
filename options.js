/**
 * Options page script for the Salesforce AddMe extension.
 *
 * Handles:
 *  - Listing configured Salesforce instances with live connection status
 *  - Adding / editing instances (inline form)
 *  - OAuth authentication per instance
 *  - Instance deletion / logout
 *  - Tab navigation between "Instances" and "About"
 */

import {
  getInstances,
  saveInstances,
  getActiveInstanceId,
  setActiveInstanceId,
  logoutInstance,
  removeInstance,
}                              from './modules/storage.js';
import { startOAuthFlow }      from './modules/auth.js';
import { checkConnection }     from './modules/salesforce.js';
import { isAuthenticated }     from './modules/auth.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  instanceList:      $('instanceList'),
  noInstancesMsg:    $('noInstancesMsg'),
  btnAddInstance:    $('btnAddInstance'),
  instanceForm:      $('instanceForm'),
  formTitle:         $('formTitle'),
  iName:             $('iName'),
  iLoginUrl:         $('iLoginUrl'),
  iClientId:         $('iClientId'),
  iCallbackUrl:      $('iCallbackUrl'),
  iRememberTokens:   $('iRememberTokens'),
  btnSaveInstance:   $('btnSaveInstance'),
  btnCancelForm:     $('btnCancelForm'),
  btnCopyCallback:   $('btnCopyCallback'),
  formError:         $('formError'),
  loadingOverlay:    $('loadingOverlay'),
  loadingMsg:        $('loadingMsg'),
  toast:             $('toast'),
  versionText:       $('versionText'),
};

/** ID of the instance currently being edited (null = add new). */
let editingId = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Tab navigation
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Populate callback URL field.
  els.iCallbackUrl.value = chrome.identity.getRedirectURL();

  // Show extension version.
  const manifest = chrome.runtime.getManifest();
  if (els.versionText) {
    els.versionText.textContent = `Version ${manifest.version}`;
  }

  // Wire buttons.
  els.btnAddInstance.addEventListener('click', showAddForm);
  els.btnSaveInstance.addEventListener('click', onSaveInstance);
  els.btnCancelForm.addEventListener('click',  hideForm);
  els.btnCopyCallback.addEventListener('click', copyCallbackUrl);

  await renderInstanceList();
}

// ─── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('nav-item--active'));

  const panel = $(`tab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`);
  if (panel) panel.classList.remove('hidden');

  const btn = document.querySelector(`[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('nav-item--active');
}

// ─── Instance list ────────────────────────────────────────────────────────────

async function renderInstanceList() {
  const instances = await getInstances();
  const activeId  = await getActiveInstanceId();

  // Clear existing cards (not the empty message).
  els.instanceList.querySelectorAll('.instance-card').forEach((c) => c.remove());
  els.noInstancesMsg.classList.toggle('hidden', instances.length > 0);

  for (const instance of instances) {
    const card = await buildInstanceCard(instance, activeId);
    els.instanceList.appendChild(card);
  }
}

async function buildInstanceCard(instance, activeId) {
  const isActive = instance.id === activeId;
  const authed   = await isAuthenticated(instance.id);

  const card = document.createElement('div');
  card.className = `instance-card${isActive ? ' instance-card--active' : ''}`;
  card.dataset.id = instance.id;

  // Info
  const info = document.createElement('div');
  info.className = 'instance-card__info';
  info.innerHTML = `
    <div class="instance-card__name">${escapeHtml(instance.name)}</div>
    <div class="instance-card__url">${escapeHtml(instance.loginUrl)}</div>
  `;

  // Status
  const statusDiv = document.createElement('div');
  statusDiv.className = 'instance-card__status';

  const dot = document.createElement('span');
  dot.className = `status-dot ${authed ? 'status-dot--auth' : 'status-dot--error'}`;

  const statusText = document.createElement('span');
  statusText.textContent = authed ? 'Authenticated' : 'Not connected';
  statusText.id = `statusText_${instance.id}`;

  statusDiv.appendChild(dot);
  statusDiv.appendChild(statusText);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'instance-card__actions';

  if (!isActive) {
    const useBtn = makeBtn('Use', 'btn--secondary btn--sm', async () => {
      await setActiveInstanceId(instance.id);
      await renderInstanceList();
      showToast('Active instance changed', 'success');
    });
    actions.appendChild(useBtn);
  }

  const authLabel = authed ? 'Re-auth' : 'Authenticate';
  const authBtn = makeBtn(authLabel, 'btn--primary btn--sm', () => authenticateInstance(instance));
  actions.appendChild(authBtn);

  if (authed) {
    const pingBtn = makeBtn('Ping', 'btn--secondary btn--sm', () => pingInstance(instance));
    actions.appendChild(pingBtn);
  }

  const editBtn = makeBtn('Edit', 'btn--secondary btn--sm', () => showEditForm(instance));
  actions.appendChild(editBtn);

  const delBtn = makeBtn('Delete', 'btn--danger btn--sm', () => deleteInstance(instance));
  actions.appendChild(delBtn);

  card.appendChild(info);
  card.appendChild(statusDiv);
  card.appendChild(actions);
  return card;
}

// ─── Authenticate ─────────────────────────────────────────────────────────────

async function authenticateInstance(instance) {
  showLoading(`Authenticating "${instance.name}"…`);
  try {
    await startOAuthFlow(instance);
    showToast(`Authenticated to ${instance.name}`, 'success');
    await renderInstanceList();
  } catch (err) {
    showToast(`Authentication failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function pingInstance(instance) {
  showLoading(`Pinging "${instance.name}"…`);
  try {
    const ok = await checkConnection(instance.id);
    showToast(ok ? `${instance.name}: Connected ✓` : `${instance.name}: Connection failed`, ok ? 'success' : 'error');
  } catch (err) {
    showToast(`Ping failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// ─── Add / Edit form ──────────────────────────────────────────────────────────

function showAddForm() {
  editingId = null;
  els.formTitle.textContent = 'Add Salesforce Instance';
  els.iName.value          = '';
  els.iLoginUrl.value      = 'https://login.salesforce.com';
  els.iClientId.value      = '';
  els.iRememberTokens.checked = false;
  hideFormError();
  els.instanceForm.classList.remove('hidden');
  els.iName.focus();
}

function showEditForm(instance) {
  editingId = instance.id;
  els.formTitle.textContent  = 'Edit Instance';
  els.iName.value            = instance.name;
  els.iLoginUrl.value        = instance.loginUrl;
  els.iClientId.value        = instance.clientId;
  els.iRememberTokens.checked = instance.rememberTokens ?? false;
  hideFormError();
  els.instanceForm.classList.remove('hidden');
  els.iName.focus();
}

function hideForm() {
  els.instanceForm.classList.add('hidden');
  editingId = null;
  hideFormError();
}

async function onSaveInstance() {
  const name           = els.iName.value.trim();
  const loginUrl       = els.iLoginUrl.value.trim().replace(/\/$/, '');
  const clientId       = els.iClientId.value.trim();
  const rememberTokens = els.iRememberTokens.checked;

  // Validate
  if (!name)      return showFormError('Display name is required.');
  if (!loginUrl)  return showFormError('Login URL is required.');
  if (!clientId)  return showFormError('Connected App Client ID is required.');

  try { new URL(loginUrl); }
  catch { return showFormError('Login URL must be a valid HTTPS URL.'); }

  if (!loginUrl.startsWith('https://')) {
    return showFormError('Login URL must start with https://.');
  }

  const instances = await getInstances();

  let instance;
  if (editingId) {
    const idx = instances.findIndex((i) => i.id === editingId);
    if (idx === -1) return showFormError('Instance not found.');
    instance = { ...instances[idx], name, loginUrl, clientId, rememberTokens };
    instances[idx] = instance;
  } else {
    instance = { id: generateId(), name, loginUrl, clientId, rememberTokens };
    instances.push(instance);
  }

  await saveInstances(instances);

  // Set as active if it is the first instance.
  const activeId = await getActiveInstanceId();
  if (!activeId) await setActiveInstanceId(instance.id);

  hideForm();
  await renderInstanceList();

  // Immediately launch OAuth flow.
  showToast('Saved – launching authentication…', 'success');
  await authenticateInstance(instance);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

async function deleteInstance(instance) {
  if (!confirm(`Delete instance "${instance.name}"? This will remove all stored credentials.`)) {
    return;
  }
  await removeInstance(instance.id);
  await renderInstanceList();
  showToast(`"${instance.name}" removed`, 'success');
}

// ─── Copy callback URL ────────────────────────────────────────────────────────

async function copyCallbackUrl() {
  try {
    await navigator.clipboard.writeText(els.iCallbackUrl.value);
    showToast('Callback URL copied to clipboard', 'success');
  } catch {
    // Fallback: select the text.
    els.iCallbackUrl.select();
    showToast('Press Ctrl+C to copy', 'success');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBtn(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.className   = `btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function generateId() {
  return `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Form error ─────────────────────────────────────────────────────────────

function showFormError(msg) {
  els.formError.textContent = msg;
  els.formError.classList.remove('hidden');
}
function hideFormError() {
  els.formError.classList.add('hidden');
  els.formError.textContent = '';
}

// ── Loading ────────────────────────────────────────────────────────────────

function showLoading(msg = 'Loading…') {
  els.loadingMsg.textContent = msg;
  els.loadingOverlay.classList.remove('hidden');
}
function hideLoading() {
  els.loadingOverlay.classList.add('hidden');
}

// ── Toast ──────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg, type = 'info') {
  clearTimeout(toastTimer);
  els.toast.textContent = msg;
  els.toast.className = `toast toast--${type}`;
  els.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 4000);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

init().catch((err) => {
  console.error('[AddMe] Options init failed:', err);
});
