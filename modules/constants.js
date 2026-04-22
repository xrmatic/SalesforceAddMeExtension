/**
 * Shared constants for the Salesforce AddMe extension.
 * Centralised here so every module pulls from one source of truth.
 */

/** Salesforce REST API version used for all requests. */
export const SF_API_VERSION = 'v59.0';

/** Maximum number of auto-retry attempts on transient HTTP errors (429 / 5xx). */
export const MAX_RETRY_ATTEMPTS = 3;

/** Base delay (ms) for exponential back-off between retries. */
export const RETRY_BASE_DELAY_MS = 1000;

/** How long the PKCE OAuth flow is allowed to run before timing out (ms). */
export const OAUTH_TIMEOUT_MS = 120_000;

/** Alarm name used by the background service-worker for connection polling. */
export const POLL_ALARM_NAME = 'sf_connection_poll';

/** How often (minutes) to poll the connected Salesforce instance. */
export const POLL_INTERVAL_MINUTES = 5;

/** Maximum duplicate records to surface to the user before offering "create new". */
export const DUPLICATE_CHECK_LIMIT = 5;

/** chrome.storage.local key names for non-sensitive, persistent data. */
export const STORAGE_KEYS = {
  /** Array of configured Salesforce instance objects (no tokens stored here). */
  INSTANCES: 'sf_instances',
  /** ID of the instance currently in use. */
  ACTIVE_INSTANCE: 'sf_active_instance',
  /**
   * A random 256-bit secret generated once per installation, stored as hex.
   * Used as the basis for deriving the encryption key for refresh tokens.
   */
  INSTALL_SECRET: 'sf_install_secret',
  /** Encrypted refresh-token map keyed by instance ID. */
  REFRESH_TOKENS: 'sf_refresh_tokens',
};

/** chrome.storage.session key names for volatile, sensitive data. */
export const SESSION_KEYS = {
  /**
   * Object mapping instance ID → { access_token, instance_url, issued_at }.
   * chrome.storage.session is cleared automatically when the browser closes.
   */
  TOKENS: 'sf_session_tokens',
  /** Last text captured from the active tab (cleared after use). */
  SELECTED_TEXT: 'sf_selected_text',
};

/** Context-menu item IDs. */
export const MENU_IDS = {
  SEND_TO_SF: 'addme_send_to_salesforce',
};

/** Standard Salesforce objects the extension supports by default. */
export const DEFAULT_OBJECTS = ['Account', 'Contact', 'Lead', 'Opportunity'];

/**
 * Field-mapping templates for common Salesforce objects.
 * Maps a parsed-entity key to the Salesforce API field name.
 * The popup uses this to pre-fill field rows.
 */
export const OBJECT_FIELD_MAPS = {
  Lead: {
    firstName:   'FirstName',
    lastName:    'LastName',
    email:       'Email',
    phone:       'Phone',
    mobilePhone: 'MobilePhone',
    title:       'Title',
    company:     'Company',
    website:     'Website',
    street:      'Street',
    city:        'City',
    state:       'State',
    postalCode:  'PostalCode',
    country:     'Country',
    description: 'Description',
  },
  Contact: {
    firstName:   'FirstName',
    lastName:    'LastName',
    email:       'Email',
    phone:       'Phone',
    mobilePhone: 'MobilePhone',
    title:       'Title',
    website:     'Website',
    street:      'MailingStreet',
    city:        'MailingCity',
    state:       'MailingState',
    postalCode:  'MailingPostalCode',
    country:     'MailingCountry',
    description: 'Description',
  },
  Account: {
    company:   'Name',
    phone:     'Phone',
    website:   'Website',
    street:    'BillingStreet',
    city:      'BillingCity',
    state:     'BillingState',
    postalCode:'BillingPostalCode',
    country:   'BillingCountry',
    description:'Description',
  },
  Opportunity: {
    company:    'Name',
    description:'Description',
  },
};

/** Salesforce duplicate-check field per object (used in SOQL WHERE clause). */
export const DUPLICATE_KEY_FIELDS = {
  Lead:        'Email',
  Contact:     'Email',
  Account:     'Name',
  Opportunity: 'Name',
};

/** Scopes requested from Salesforce during OAuth. */
export const SF_OAUTH_SCOPES = 'api refresh_token offline_access';
