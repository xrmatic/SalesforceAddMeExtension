# Salesforce AddMe – Edge/Chrome Browser Extension

Capture selected text from any web page and push it directly to your Salesforce org as a structured record — Leads, Contacts, Accounts, Opportunities, or any custom object — with intelligent field mapping, duplicate detection, and upsert support.

---

## Features

| Feature | Details |
|---|---|
| **Text parsing** | Regex-based extraction of emails, phones, names, companies, job titles, street addresses, and URLs — no external NLP libraries |
| **Object selection** | Dynamically fetches all createable standard and custom objects from your org |
| **Field mapping** | Pre-fills fields from parsed entities with confidence indicators; fully editable before submission |
| **Duplicate detection** | SOQL pre-check before upsert; shows existing matches and lets you choose to update or create |
| **Upsert** | Prefers `PATCH /{object}/{externalIdField}/{value}` so records are idempotent |
| **OAuth 2.0 PKCE** | Authentication via `chrome.identity.launchWebAuthFlow` — no password ever stored |
| **Connection polling** | Background alarm pings the org every 5 minutes; notifies you on connection loss |
| **Secure storage** | Access tokens → `chrome.storage.session` (auto-cleared on browser close). Refresh tokens → AES-256-GCM encrypted in `chrome.storage.local`. Selected text → session memory only |
| **Context menu** | Right-click any selected text → "Send to Salesforce" |
| **Multiple instances** | Add as many orgs (Production, Sandboxes, custom domains) as needed |

---

## Prerequisites

- Microsoft Edge ≥ 116 or Google Chrome ≥ 116 (Manifest V3)
- A Salesforce org with a **Connected App** configured (see below)

---

## Installation (Developer / Sideload)

1. Clone or download this repository.
2. Open **Edge** → `edge://extensions/` (or Chrome → `chrome://extensions/`).
3. Enable **Developer mode** (toggle top-right).
4. Click **Load unpacked** and select the repository root folder.
5. Note the **Extension ID** displayed under the card — you will need it for the Connected App.

---

## Setting Up the Salesforce Connected App

1. In **Salesforce Setup**, search for **App Manager** → **New Connected App**.
2. Fill in the basic info, then enable **OAuth Settings**.
3. For **Callback URL**, use:
   ```
   https://<YOUR_EXTENSION_ID>.chromiumapp.org/
   ```
   You can find the exact URL on the extension's **Options page** → Add Instance form.
4. Select at least these OAuth scopes:
   - `api`
   - `refresh_token, offline_access`
5. **Save** the Connected App and copy the **Consumer Key** (Client ID).

---

## Configuration

1. Click the extension icon → **⚙ Settings** (or right-click → Options).
2. Click **+ Add Instance**.
3. Enter:
   - **Display Name** (e.g. "Production")
   - **Login URL** — `https://login.salesforce.com` (production) or `https://test.salesforce.com` (sandbox) or your custom domain
   - **Connected App Client ID** — the Consumer Key from above
4. Optionally enable **Remember authentication** to store an encrypted refresh token so sessions survive browser restarts.
5. Click **Save & Authenticate** — a Salesforce login window will appear.

---

## Usage

### Via popup

1. Select text on any web page.
2. Click the **Salesforce AddMe** toolbar icon.
3. The selected text is pre-loaded and parsed automatically. Click **Parse & Map Fields**.
4. Choose the target **Salesforce Object** (Lead, Contact, Account, …).
5. Review / edit the field mapping table.
6. Click **Check for Duplicates** (optional but recommended).
7. Click **Send to Salesforce ✓**.

### Via context menu

1. Select text on a page.
2. Right-click → **Send to Salesforce** — the popup opens with the text pre-loaded.

---

## Privacy & Security

- No data is ever sent to third-party servers.
- Tokens are **never stored in plain text**.
- PII (selected text, tokens) is kept in session memory only, or encrypted before persisting.
- The extension uses the **Web Crypto API** (AES-256-GCM + HKDF-SHA-256) for all encryption — no external crypto libraries.

---

## Project Structure

```
manifest.json          # Extension manifest (MV3)
background.js          # Service worker: alarms, context menu, message relay
content.js             # Content script: captures page selection
popup.html / .js / .css # Main popup (4-step workflow)
options.html / .js / .css # Settings page (instance management)
modules/
  constants.js         # Shared constants & field-map templates
  crypto.js            # AES-GCM encryption, PKCE helpers (Web Crypto API)
  storage.js           # Secure storage abstraction
  auth.js              # OAuth 2.0 PKCE flow + token management
  salesforce.js        # Salesforce REST API client
  parser.js            # Regex text-entity extractor
icons/
  icon16.png
  icon48.png
  icon128.png
```

---

## Development

No build step is required — the extension is plain ES-module JavaScript.

To lint with the Node.js ecosystem:
```bash
npm install --save-dev eslint
npx eslint modules/ background.js popup.js options.js content.js
```

---

## License

MIT
