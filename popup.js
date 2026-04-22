/**
 * Popup script for the Salesforce AddMe extension.
 *
 * Workflow (4 steps):
 *  1. Capture / paste selected text.  Parse it and show inferred fields.
 *  2. User picks the Salesforce object; field-mapping table is shown.
 *  3. Optional duplicate check.
 *  4. Submit (upsert) to Salesforce.
 *
 * All network calls go through salesforce.js; auth state is managed via auth.js.
 * No PII is written to DOM storage – all transient state lives in JS variables.
 */

import { parseText, applyFieldMap }          from './modules/parser.js';
import { consumeSelectedText }               from './modules/storage.js';
import {
  getInstances,
  getActiveInstanceId,
  setActiveInstanceId,
}                                             from './modules/storage.js';
import { isAuthenticated, getValidToken }    from './modules/auth.js';
import {
  listObjects,
  describeObject,
  findDuplicates,
  upsertRecord,
  updateRecord,
  checkConnection,
}                                             from './modules/salesforce.js';
import {
  DEFAULT_OBJECTS,
  OBJECT_FIELD_MAPS,
  DUPLICATE_KEY_FIELDS,
}                                             from './modules/constants.js';

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ id: string, name: string, loginUrl: string, clientId: string } | null} */
let activeInstance = null;
let isAuthed       = false;

/** Parsed entity result from parser.js */
let parsedData     = null;

/** Currently selected Salesforce object name */
let currentObject  = null;

/** Array of { sfField, value } rows currently shown in the field table */
let fieldRows      = [];

/** Object field metadata from describeObject() */
let objectFields   = [];

/** Duplicate records found in Salesforce */
let duplicates     = [];

/** ID of the record chosen for update (null → create) */
let updateTargetId = null;

let currentStep    = 1;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  noInstanceSection: $('noInstanceSection'),
  authSection:       $('authSection'),
  authMsg:           $('authMsg'),
  mainSection:       $('mainSection'),
  selectedText:      $('selectedText'),
  btnParse:          $('btnParse'),
  objectSelect:      $('objectSelect'),
  fieldsContainer:   $('fieldsContainer'),
  btnCheckDuplicates:$('btnCheckDuplicates'),
  duplicatesContainer:$('duplicatesContainer'),
  noDuplicatesHint:  $('noDuplicatesHint'),
  upsertOptions:     $('upsertOptions'),
  updateRadio:       $('updateRadio'),
  updateTargetLabel: $('updateTargetLabel'),
  btnSubmit:         $('btnSubmit'),
  submitResult:      $('submitResult'),
  btnBack:           $('btnBack'),
  progressDots:      $('progressDots'),
  connectionBadge:   $('connectionBadge'),
  btnOptions:        $('btnOptions'),
  btnGoOptions:      $('btnGoOptions'),
  btnGoAuth:         $('btnGoAuth'),
  loadingOverlay:    $('loadingOverlay'),
  loadingMsg:        $('loadingMsg'),
  errorToast:        $('errorToast'),
  step1:             $('step1'),
  step2:             $('step2'),
  step3:             $('step3'),
  step4:             $('step4'),
};

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init() {
  try {
    // Load active instance
    const instanceId = await getActiveInstanceId();
    const instances  = await getInstances();
    activeInstance   = instances.find((i) => i.id === instanceId) ?? null;

    if (!activeInstance) {
      showSection('noInstance');
      return;
    }

    isAuthed = await isAuthenticated(activeInstance.id);
    if (!isAuthed) {
      els.authMsg.textContent = `Please authenticate to "${activeInstance.name}".`;
      showSection('auth');
      return;
    }

    showSection('main');
    updateConnectionBadge(true);
    await populateObjectSelector();
    await prefillSelectedText();
    goToStep(1);
  } catch (err) {
    showError(`Initialisation failed: ${err.message}`);
  }
}

// ─── Section visibility ───────────────────────────────────────────────────────

function showSection(section) {
  els.noInstanceSection.classList.toggle('hidden', section !== 'noInstance');
  els.authSection.classList.toggle('hidden',       section !== 'auth');
  els.mainSection.classList.toggle('hidden',       section !== 'main');
}

// ─── Step navigation ──────────────────────────────────────────────────────────

const STEPS = [els.step1, els.step2, els.step3, els.step4];
const NUM_STEPS = 4;

function goToStep(n) {
  currentStep = Math.max(1, Math.min(NUM_STEPS, n));

  STEPS.forEach((el, idx) => {
    el.classList.toggle('hidden', idx + 1 !== currentStep);
  });

  // Step 3 (duplicates) is only shown when there are duplicates.
  if (currentStep === 3 && duplicates.length === 0) {
    currentStep = 4;
    goToStep(4);
    return;
  }

  renderProgressDots();
  els.btnBack.classList.toggle('hidden', currentStep === 1);
}

function renderProgressDots() {
  els.progressDots.innerHTML = '';
  for (let i = 1; i <= NUM_STEPS; i++) {
    const dot = document.createElement('span');
    dot.className = `progress-dot${i === currentStep ? ' progress-dot--active' : ''}`;
    els.progressDots.appendChild(dot);
  }
}

// ─── Selected text & parsing ──────────────────────────────────────────────────

async function prefillSelectedText() {
  // 1. Check session cache (set by context-menu handler or prior visit).
  const cached = await consumeSelectedText();
  if (cached) {
    els.selectedText.value = cached;
    return;
  }

  // 2. Ask the content script for the current page selection.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_LAST_SELECTED_TEXT' });
    if (resp?.text) els.selectedText.value = resp.text;
  } catch {
    // Content script may not be injected on chrome:// pages – ignore.
  }
}

async function onParse() {
  const rawText = els.selectedText.value.trim();
  if (!rawText) {
    showError('Please enter or select some text to parse.');
    return;
  }

  parsedData = parseText(rawText);
  await buildFieldRows();
  goToStep(2);
}

// ─── Object selector ──────────────────────────────────────────────────────────

async function populateObjectSelector() {
  showLoading('Loading objects…');
  try {
    const remoteObjects = await listObjects(activeInstance.id);
    els.objectSelect.innerHTML = '';

    // Standard objects first (from our default list), then custom.
    const stdNames    = new Set(DEFAULT_OBJECTS);
    const stdObjects  = remoteObjects.filter((o) => stdNames.has(o.name));
    const custObjects = remoteObjects.filter((o) => o.name.endsWith('__c'));

    const addGroup = (label, items) => {
      if (!items.length) return;
      const grp = document.createElement('optgroup');
      grp.label = label;
      items.forEach(({ name, label: lbl }) => {
        const opt = document.createElement('option');
        opt.value       = name;
        opt.textContent = `${lbl ?? name} (${name})`;
        grp.appendChild(opt);
      });
      els.objectSelect.appendChild(grp);
    };

    addGroup('Standard Objects', stdObjects);
    addGroup('Custom Objects',   custObjects);

    // Default to Lead if available.
    const leadOpt = [...els.objectSelect.options].find((o) => o.value === 'Lead');
    if (leadOpt) els.objectSelect.value = 'Lead';

    await onObjectChange();
  } catch (err) {
    showError(`Could not load objects: ${err.message}`);
    // Fallback: add default objects manually.
    els.objectSelect.innerHTML = '';
    DEFAULT_OBJECTS.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      els.objectSelect.appendChild(opt);
    });
  } finally {
    hideLoading();
  }
}

async function onObjectChange() {
  currentObject = els.objectSelect.value;
  if (!currentObject) return;

  showLoading('Loading fields…');
  try {
    objectFields = await describeObject(activeInstance.id, currentObject);
  } catch {
    objectFields = [];
  } finally {
    hideLoading();
  }

  if (parsedData) await buildFieldRows();
}

// ─── Field mapping ────────────────────────────────────────────────────────────

async function buildFieldRows() {
  if (!parsedData || !currentObject) return;

  const fieldMap = OBJECT_FIELD_MAPS[currentObject] ?? {};
  const mapped   = applyFieldMap(parsedData, fieldMap);

  fieldRows = Object.entries(mapped).map(([sfField, value]) => ({
    sfField,
    value,
    confidence: parsedData._confidence[
      Object.keys(fieldMap).find((k) => fieldMap[k] === sfField)
    ] ?? 0,
  }));

  renderFieldRows();
}

function renderFieldRows() {
  els.fieldsContainer.innerHTML = '';

  fieldRows.forEach((row, idx) => {
    const div = document.createElement('div');
    div.className = 'field-row';

    // Field label
    const labelDiv = document.createElement('div');
    labelDiv.className = 'field-label-text';
    labelDiv.title = row.sfField;
    labelDiv.textContent = row.sfField;

    // Confidence dot
    const dot = document.createElement('span');
    dot.className = `confidence-dot ${confidenceClass(row.confidence)}`;
    dot.title = `Confidence: ${Math.round(row.confidence * 100)}%`;
    labelDiv.appendChild(dot);

    // Value input
    const input = document.createElement('input');
    input.type      = 'text';
    input.className = 'form-field-input';
    input.value     = row.value ?? '';
    input.setAttribute('aria-label', row.sfField);
    input.addEventListener('input', () => { fieldRows[idx].value = input.value; });

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className   = 'field-remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title       = 'Remove field';
    removeBtn.setAttribute('aria-label', `Remove ${row.sfField}`);
    removeBtn.addEventListener('click', () => {
      fieldRows.splice(idx, 1);
      renderFieldRows();
    });

    div.appendChild(labelDiv);
    div.appendChild(input);
    div.appendChild(removeBtn);
    els.fieldsContainer.appendChild(div);
  });

  // "Add field" row
  const addRow = document.createElement('div');
  addRow.className = 'add-field-row';

  const addSelect = document.createElement('select');
  addSelect.className = 'form-select add-field-select';
  addSelect.setAttribute('aria-label', 'Add Salesforce field');

  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '— Add field —';
  addSelect.appendChild(emptyOpt);

  const alreadyAdded = new Set(fieldRows.map((r) => r.sfField));
  objectFields
    .filter((f) => f.createable && !alreadyAdded.has(f.name))
    .sort((a, b) => a.label.localeCompare(b.label))
    .forEach(({ name, label }) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = `${label} (${name})`;
      addSelect.appendChild(opt);
    });

  addSelect.addEventListener('change', () => {
    const sfField = addSelect.value;
    if (!sfField) return;
    fieldRows.push({ sfField, value: '', confidence: 0 });
    renderFieldRows();
  });

  addRow.appendChild(addSelect);
  els.fieldsContainer.appendChild(addRow);
}

function confidenceClass(score) {
  if (score >= 0.75) return 'conf-high';
  if (score >= 0.45) return 'conf-medium';
  return 'conf-low';
}

// ─── Duplicate check ──────────────────────────────────────────────────────────

async function onCheckDuplicates() {
  if (!currentObject) return;

  const record = buildRecordFromRows();
  showLoading('Checking for duplicates…');

  try {
    duplicates = await findDuplicates(activeInstance.id, currentObject, record);
  } catch (err) {
    showError(`Duplicate check failed: ${err.message}`);
    duplicates = [];
  } finally {
    hideLoading();
  }

  renderDuplicates();
  goToStep(3);
}

function renderDuplicates() {
  els.duplicatesContainer.innerHTML = '';
  els.noDuplicatesHint.classList.toggle('hidden', duplicates.length > 0);

  duplicates.forEach((rec) => {
    const item = document.createElement('div');
    item.className = 'dup-item';

    const info = document.createElement('div');
    info.className = 'dup-item__info';

    const name = document.createElement('div');
    name.className = 'dup-item__name';
    name.textContent = rec.Name ?? rec.Email ?? rec.Id;
    info.appendChild(name);

    const sub = document.createElement('div');
    sub.className = 'dup-item__sub';
    const parts = [rec.Email, rec.Phone, rec.Company, rec.Title].filter(Boolean);
    sub.textContent = parts.join(' · ');
    info.appendChild(sub);

    const useBtn = document.createElement('button');
    useBtn.className   = 'btn btn--secondary dup-item__btn';
    useBtn.textContent = 'Use';
    useBtn.setAttribute('aria-label', `Update ${rec.Name ?? rec.Id}`);
    useBtn.addEventListener('click', () => selectDuplicateForUpdate(rec));

    item.appendChild(info);
    item.appendChild(useBtn);
    els.duplicatesContainer.appendChild(item);
  });
}

function selectDuplicateForUpdate(rec) {
  updateTargetId = rec.Id;
  els.updateRadio.checked    = true;
  els.upsertOptions.classList.remove('hidden');
  els.updateTargetLabel.textContent = rec.Name ?? rec.Email ?? rec.Id;
  goToStep(4);
}

// ─── Build record payload ─────────────────────────────────────────────────────

function buildRecordFromRows() {
  const record = {};
  for (const { sfField, value } of fieldRows) {
    const v = String(value ?? '').trim();
    if (v) record[sfField] = v;
  }
  return record;
}

// ─── Submit ───────────────────────────────────────────────────────────────────

async function onSubmit() {
  const record = buildRecordFromRows();

  if (!Object.keys(record).length) {
    showError('No field values to submit.');
    return;
  }

  const mode = document.querySelector('input[name="upsertMode"]:checked')?.value ?? 'create';

  showLoading('Submitting to Salesforce…');
  els.btnSubmit.disabled = true;

  try {
    let resultId;

    if (mode === 'update' && updateTargetId) {
      await updateRecord(activeInstance.id, currentObject, updateTargetId, record);
      resultId = updateTargetId;
    } else {
      // Prefer upsert via the duplicate-key field (e.g. Email for Lead/Contact).
      const keyField = DUPLICATE_KEY_FIELDS[currentObject];
      const keyValue = keyField ? record[keyField] : null;

      const result = await upsertRecord(
        activeInstance.id, currentObject, record, keyField, keyValue,
      );
      resultId = result?.id ?? result?.Id ?? 'Unknown';
    }

    showSubmitResult(true, `Record ${mode === 'update' ? 'updated' : 'saved'} successfully.\nSalesforce ID: ${resultId}`);
  } catch (err) {
    showSubmitResult(false, `Submission failed: ${err.message}`);
  } finally {
    hideLoading();
    els.btnSubmit.disabled = false;
  }
}

function showSubmitResult(success, msg) {
  els.submitResult.classList.remove('hidden', 'result--success', 'result--error');
  els.submitResult.classList.add(success ? 'result--success' : 'result--error');
  els.submitResult.textContent = msg;
}

// ─── Connection badge ─────────────────────────────────────────────────────────

function updateConnectionBadge(connected) {
  els.connectionBadge.classList.remove('badge--online', 'badge--offline', 'badge--error');
  els.connectionBadge.classList.add(connected ? 'badge--online' : 'badge--error');
  els.connectionBadge.title = connected ? 'Connected' : 'Connection issue';
}

async function refreshConnectionStatus() {
  if (!activeInstance || !isAuthed) return;
  try {
    const ok = await checkConnection(activeInstance.id);
    updateConnectionBadge(ok);
  } catch {
    updateConnectionBadge(false);
  }
}

// ─── Loading / toast helpers ──────────────────────────────────────────────────

function showLoading(msg = 'Loading…') {
  els.loadingMsg.textContent = msg;
  els.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  els.loadingOverlay.classList.add('hidden');
}

let toastTimer;
function showError(msg) {
  clearTimeout(toastTimer);
  els.errorToast.textContent = msg;
  els.errorToast.classList.remove('hidden', 'toast--error');
  els.errorToast.classList.add('toast--error');
  toastTimer = setTimeout(() => els.errorToast.classList.add('hidden'), 5000);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

els.btnOptions.addEventListener('click',          () => chrome.runtime.openOptionsPage());
els.btnGoOptions.addEventListener('click',        () => chrome.runtime.openOptionsPage());
els.btnGoAuth.addEventListener('click',           () => chrome.runtime.openOptionsPage());
els.btnParse.addEventListener('click',            onParse);
els.objectSelect.addEventListener('change',       onObjectChange);
els.btnCheckDuplicates.addEventListener('click',  onCheckDuplicates);
els.btnSubmit.addEventListener('click',           onSubmit);

els.btnBack.addEventListener('click', () => {
  if (currentStep > 1) goToStep(currentStep - 1);
});

// Periodically refresh connection badge while popup is open.
setInterval(refreshConnectionStatus, 30_000);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

init().catch((err) => showError(err.message));
