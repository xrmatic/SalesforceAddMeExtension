/**
 * Background service worker for the Salesforce AddMe extension.
 *
 * Responsibilities
 * ----------------
 * 1. Register and handle the context menu "Send to Salesforce" item.
 * 2. Periodically poll all authenticated Salesforce instances to verify
 *    connection health and silently refresh tokens when possible.
 * 3. Relay messages between the content script and the popup/options pages.
 * 4. Handle extension install / update lifecycle events.
 *
 * All modules are imported as ES modules (MV3 supports type: "module" workers).
 */

import { MENU_IDS, POLL_ALARM_NAME, POLL_INTERVAL_MINUTES } from './modules/constants.js';
import { getInstances, getActiveInstanceId, cacheSelectedText } from './modules/storage.js';
import { isAuthenticated, refreshAccessToken } from './modules/auth.js';
import { checkConnection } from './modules/salesforce.js';

// ─── Extension lifecycle ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  setupContextMenu();

  // Start the connection-health alarm on first install / update.
  chrome.alarms.create(POLL_ALARM_NAME, {
    delayInMinutes:  1,
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });

  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
  ensurePollingAlarm();
});

// ─── Context menu ─────────────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       MENU_IDS.SEND_TO_SF,
      title:    'Send to Salesforce',
      contexts: ['selection'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_IDS.SEND_TO_SF) return;

  const selectedText = info.selectionText;
  if (!selectedText?.trim()) return;

  // Cache selected text so the popup can pick it up.
  try {
    await cacheSelectedText(selectedText.trim());
  } catch (err) {
    console.error('[AddMe] Failed to cache selected text:', err);
  }

  // Open the popup via an action – the popup will read from session storage.
  // We can't directly open the popup, so we open a side-panel-style popup page.
  chrome.action.openPopup().catch(() => {
    // openPopup is not available in all contexts; open as a standalone window.
    chrome.windows.create({
      url:    chrome.runtime.getURL('popup.html'),
      type:   'popup',
      width:  480,
      height: 640,
    });
  });
});

// ─── Connection health polling ────────────────────────────────────────────────

function ensurePollingAlarm() {
  chrome.alarms.get(POLL_ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(POLL_ALARM_NAME, {
        delayInMinutes:  1,
        periodInMinutes: POLL_INTERVAL_MINUTES,
      });
    }
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM_NAME) return;
  await pollAllInstances();
});

async function pollAllInstances() {
  let instances;
  try {
    instances = await getInstances();
  } catch (err) {
    console.warn('[AddMe] Could not load instances for polling:', err);
    return;
  }

  for (const instance of instances) {
    try {
      const authed = await isAuthenticated(instance.id);
      if (!authed) {
        // Try a silent refresh to restore the session.
        await refreshAccessToken(instance.id);
      }

      // Ping the org to confirm the token is valid.
      const healthy = await checkConnection(instance.id);
      if (!healthy) {
        console.warn(`[AddMe] Instance "${instance.name}" connection check failed`);
        await notifyConnectionIssue(instance);
      }
    } catch (err) {
      // Refresh failed – no stored refresh token or token revoked.
      console.warn(`[AddMe] Instance "${instance.name}" needs re-authentication:`, err.message);
      await notifyConnectionIssue(instance);
    }
  }
}

async function notifyConnectionIssue(instance) {
  const activeId = await getActiveInstanceId().catch(() => null);
  if (activeId !== instance.id) return; // Only alert for the active instance.

  chrome.notifications.create(`addme_conn_${instance.id}`, {
    type:    'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title:   'Salesforce Connection Issue',
    message: `Connection to "${instance.name}" was lost. Please re-authenticate in the Options page.`,
    priority: 2,
  });
}

// ─── Message relay ────────────────────────────────────────────────────────────

/**
 * Central message handler.  The popup and options pages communicate with
 * background state via chrome.runtime.sendMessage.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // keep channel open for async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'POLL_NOW': {
      await pollAllInstances();
      return { ok: true };
    }

    case 'GET_ACTIVE_INSTANCE': {
      const id        = await getActiveInstanceId();
      const instances = await getInstances();
      const instance  = instances.find((i) => i.id === id) ?? null;
      const authed    = instance ? await isAuthenticated(id) : false;
      return { instance, authed };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ─── Notification click → open options ───────────────────────────────────────

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith('addme_conn_')) {
    chrome.runtime.openOptionsPage();
    chrome.notifications.clear(notificationId);
  }
});
