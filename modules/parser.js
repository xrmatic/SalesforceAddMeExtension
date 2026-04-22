/**
 * Text parsing engine for the Salesforce AddMe extension.
 *
 * Given a block of free-form text (e.g. selected from a web page), this module
 * extracts structured entities and returns a confidence-weighted record that
 * can be mapped directly onto Salesforce field values.
 *
 * No external NLP / ML libraries are used – extraction relies on carefully
 * crafted regular expressions and heuristics.
 */

// ─── Regex patterns ───────────────────────────────────────────────────────────

const RE = {
  email: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,

  // Covers US / CA / intl formats:  +1 (555) 123-4567 | 555.123.4567 | ext 42
  phone: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?:\s?(?:x|ext\.?)\s?\d{1,5})?/g,

  // LinkedIn, Twitter/X, GitHub, personal sites
  linkedIn: /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|pub|company)\/[A-Za-z0-9_\-%.]+\/?/gi,
  twitter:  /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+\/?/gi,
  github:   /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_\-]+\/?/gi,
  url:      /https?:\/\/(?:www\.)?[-A-Za-z0-9@:%._+~#=]{1,256}\.[A-Za-z0-9()]{1,6}\b[-A-Za-z0-9()@:%_+.~#?&/=]*/g,

  // Full street address pattern.  Built from these named sub-parts:
  //   \b\d{1,6}            — house number (up to 6 digits)
  //   \s+                  — whitespace separator
  //   (?:[A-Za-z0-9#.]+\s+){1,6}  — 1-6 street-name tokens (handles multi-word names)
  //   (?:Street|St|…|Trl)  — required street-type suffix
  //   \b\.?                — word boundary, optional trailing period
  //   (?:\s+(?:Ste|…)\s*\w+)?  — optional unit/suite/apt qualifier
  // Examples: "123 Main Street", "456 Oak Ave Ste 5", "1 Infinite Loop"
  streetAddress:
    /\b\d{1,6}\s+(?:[A-Za-z0-9#.]+\s+){1,6}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Court|Ct|Place|Pl|Way|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Loop|Trail|Trl)\b\.?(?:\s+(?:Ste|Suite|Apt|Apt\.|Unit|#)\s*\w+)?/gi,

  // City, State  — state must be a 2-letter abbreviation (validated against
  // US_STATES / CA provinces in extractAddressComponents).  Restricting to
  // 2-letter codes avoids false positives where a proper noun like "Mountain"
  // is consumed as a long-form state name, corrupting subsequent matches.
  cityState:
    /\b([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?),\s*([A-Z]{2})\b/g,

  zipCode: /\b\d{5}(?:-\d{4})?\b/g,

  // ISO / US date formats
  date: /\b(?:\d{4}[-/]\d{2}[-/]\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi,
};

// ─── Lookup tables ────────────────────────────────────────────────────────────

const TITLE_KEYWORDS = new Set([
  'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CIO', 'CISO', 'CPO',
  'VP', 'SVP', 'EVP', 'AVP',
  'President', 'Vice President',
  'Director', 'Senior Director', 'Managing Director',
  'Manager', 'Senior Manager', 'General Manager',
  'Engineer', 'Software Engineer', 'Senior Engineer', 'Principal Engineer',
  'Developer', 'Lead Developer', 'Full Stack Developer',
  'Architect', 'Solution Architect', 'Enterprise Architect',
  'Designer', 'UX Designer', 'Product Designer',
  'Analyst', 'Business Analyst', 'Data Analyst', 'Systems Analyst',
  'Consultant', 'Senior Consultant', 'Principal Consultant',
  'Specialist', 'Coordinator', 'Associate', 'Assistant',
  'Executive', 'Officer', 'Lead', 'Senior', 'Junior', 'Principal', 'Staff',
  'Scientist', 'Data Scientist', 'Researcher',
  'Professor', 'Doctor', 'Physician', 'Attorney', 'Counsel',
  'Founder', 'Co-Founder', 'Owner', 'Partner',
  'Account Executive', 'Account Manager', 'Sales Manager',
  'Product Manager', 'Program Manager', 'Project Manager',
  'Head of Engineering', 'Head of Sales', 'Head of Marketing',
]);

const COMPANY_SUFFIXES = new Set([
  'Inc', 'Inc.', 'Incorporated',
  'LLC', 'L.L.C.',
  'Corp', 'Corp.', 'Corporation',
  'Ltd', 'Ltd.', 'Limited',
  'LP', 'L.P.', 'LLP', 'L.L.P.',
  'Co', 'Co.', 'Company',
  'Group', 'Holdings', 'Solutions', 'Services', 'Technologies', 'Technology',
  'Systems', 'Consulting', 'International', 'Industries', 'Enterprises',
  'Associates', 'Partners', 'Foundation', 'Agency', 'Studio', 'Labs', 'Lab',
]);

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
  // Canadian provinces
  'AB','BC','MB','NB','NL','NT','NS','NU','ON','PE','QC','SK','YT',
]);

// ─── Utility helpers ──────────────────────────────────────────────────────────

function extractAll(text, regex) {
  // Reset lastIndex before use.
  regex.lastIndex = 0;
  const matches = [];
  let m;
  while ((m = regex.exec(text)) !== null) matches.push(m[0].trim());
  return [...new Set(matches)]; // deduplicate
}

function stripMatchesFrom(text, matches) {
  let cleaned = text;
  for (const m of matches) cleaned = cleaned.replaceAll(m, ' ');
  return cleaned;
}

/**
 * Naïvely check whether a word looks like a proper noun
 * (starts with uppercase, remainder lowercase, not all-caps abbreviation).
 */
function isProperNoun(word) {
  return /^[A-Z][a-z]{1,}$/.test(word);
}

// ─── Company extraction ───────────────────────────────────────────────────────

/**
 * Attempt to find company / organisation names.
 * Looks for known suffixes and returns the preceding 1-5 capitalised words.
 */
function extractCompanies(text) {
  const companies = [];
  const suffixPattern = [...COMPANY_SUFFIXES]
    .map((s) => s.replace('.', '\\.'))
    .join('|');
  const re = new RegExp(
    `([A-Z][A-Za-z0-9&' ]{2,40})\\s+(?:${suffixPattern})(?:[,\\s]|$)`,
    'g',
  );

  let m;
  while ((m = re.exec(text)) !== null) {
    const candidate = m[0].trim().replace(/[,\s]+$/, '');
    if (candidate) companies.push(candidate);
  }

  // Also look for patterns like "at Acme", "@ Acme", "with Acme"
  const atRe = /\b(?:at|@|with|for|from)\s+([A-Z][A-Za-z0-9&' ]{2,40})\b/g;
  while ((m = atRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!companies.includes(candidate)) companies.push(candidate);
  }

  return [...new Set(companies)];
}

// ─── Name extraction ──────────────────────────────────────────────────────────

/**
 * Attempt to extract a human name from the text.
 * Looks for 2-3 consecutive proper nouns that are not company names,
 * cities, state abbreviations, or title keywords.
 * Returns { firstName, lastName } or null.
 */
function extractName(text, { companies = [], titles = [] } = {}) {
  // Remove known entities so they don't confuse name detection.
  let clean = text;
  for (const co of companies) clean = clean.replaceAll(co, ' ');
  for (const t  of titles)    clean = clean.replaceAll(t,  ' ');

  const tokens = clean
    .replace(/[,;:!?()[\]{}"]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);

  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];

    if (!isProperNoun(a) || !isProperNoun(b)) continue;

    // Skip common non-name proper nouns.
    if (US_STATES.has(a) || US_STATES.has(b)) continue;

    // Ignore single-char tokens (initials handled below).
    if (a.length < 2 || b.length < 2) continue;

    // Optional middle initial / name.
    const c = tokens[i + 2];
    if (c && isProperNoun(c) && !US_STATES.has(c) && c.length >= 2) {
      return { firstName: a, middleName: b, lastName: c };
    }

    return { firstName: a, lastName: b };
  }

  return null;
}

// ─── Title extraction ─────────────────────────────────────────────────────────

function extractTitles(text) {
  const found = [];
  const upper = text.toUpperCase();
  for (const title of TITLE_KEYWORDS) {
    if (upper.includes(title.toUpperCase())) found.push(title);
  }
  // Prefer longer matches (more specific titles).
  found.sort((a, b) => b.length - a.length);
  return found.slice(0, 3);
}

// ─── Address components ───────────────────────────────────────────────────────

function extractAddressComponents(text) {
  const streetAddresses = extractAll(text, RE.streetAddress);
  const zipCodes        = extractAll(text, RE.zipCode);

  // City / State pairs.  Validate the state token against the known set so
  // patterns like "Jane Doe, VP" are not mistaken for "City, State".
  const cities  = [];
  const states  = [];
  const csRe    = new RegExp(RE.cityState.source, RE.cityState.flags);
  let m;
  while ((m = csRe.exec(text)) !== null) {
    const stateCandidate = m[2].trim().toUpperCase();
    if (!US_STATES.has(stateCandidate)) continue; // reject non-state tokens
    cities.push(m[1].trim());
    states.push(stateCandidate);
  }

  return {
    street:     streetAddresses[0] ?? null,
    city:       cities[0]   ?? null,
    state:      states[0]   ?? null,
    postalCode: zipCodes[0] ?? null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse free-form text and return a structured entity object.
 *
 * @param {string} rawText
 * @returns {{
 *   email:       string|null,
 *   phone:       string|null,
 *   website:     string|null,
 *   linkedIn:    string|null,
 *   firstName:   string|null,
 *   middleName:  string|null,
 *   lastName:    string|null,
 *   title:       string|null,
 *   company:     string|null,
 *   street:      string|null,
 *   city:        string|null,
 *   state:       string|null,
 *   postalCode:  string|null,
 *   country:     string|null,
 *   description: string,
 *   _raw:        string,
 *   _confidence: Record<string, number>
 * }}
 */
export function parseText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return emptyResult(rawText ?? '');
  }

  const text = rawText.trim();

  // --- Emails ----------------------------------------------------------------
  const emails    = extractAll(text, RE.email);
  const email     = emails[0] ?? null;

  // --- Phones ----------------------------------------------------------------
  const phones    = extractAll(text, RE.phone);
  const phone     = phones[0] ?? null;

  // --- URLs ------------------------------------------------------------------
  const linkedIns = extractAll(text, RE.linkedIn);
  const twitters  = extractAll(text, RE.twitter);
  const githubs   = extractAll(text, RE.github);

  // Extract generic URLs last, excluding specialised ones already captured.
  let allUrls     = extractAll(text, RE.url);
  allUrls = allUrls.filter(
    (u) => !linkedIns.includes(u) && !twitters.includes(u) && !githubs.includes(u),
  );
  // Prefer non-social URLs as "website".
  const website   = allUrls[0] ?? null;
  const linkedIn  = linkedIns[0] ?? null;

  // --- Titles ----------------------------------------------------------------
  const titles    = extractTitles(text);
  const title     = titles[0] ?? null;

  // --- Companies -------------------------------------------------------------
  const companies = extractCompanies(text);
  const company   = companies[0] ?? null;

  // --- Names -----------------------------------------------------------------
  const nameResult = extractName(text, { companies, titles });

  // --- Addresses -------------------------------------------------------------
  const addr = extractAddressComponents(text);

  // --- Guess country ---------------------------------------------------------
  // Very rough heuristic: if we have a US state abbreviation, assume US.
  let country = null;
  if (addr.state && US_STATES.has(addr.state.toUpperCase())) country = 'US';

  // --- Confidence scores (0-1) -----------------------------------------------
  const confidence = {
    email:      email      ? 0.95 : 0,
    phone:      phone      ? 0.85 : 0,
    website:    website    ? 0.80 : 0,
    linkedIn:   linkedIn   ? 0.90 : 0,
    firstName:  nameResult ? 0.65 : 0,
    lastName:   nameResult ? 0.65 : 0,
    title:      title      ? 0.70 : 0,
    company:    company    ? 0.60 : 0,
    street:     addr.street     ? 0.75 : 0,
    city:       addr.city       ? 0.70 : 0,
    state:      addr.state      ? 0.70 : 0,
    postalCode: addr.postalCode ? 0.80 : 0,
    country:    country         ? 0.50 : 0,
  };

  return {
    email,
    phone,
    mobilePhone: phones[1] ?? null,
    website,
    linkedIn,
    firstName:   nameResult?.firstName  ?? null,
    middleName:  nameResult?.middleName ?? null,
    lastName:    nameResult?.lastName   ?? null,
    title,
    company,
    street:      addr.street,
    city:        addr.city,
    state:       addr.state,
    postalCode:  addr.postalCode,
    country,
    description: text.slice(0, 255), // first 255 chars as fallback description
    _raw:        text,
    _confidence: confidence,
  };
}

function emptyResult(raw) {
  return {
    email: null, phone: null, mobilePhone: null, website: null, linkedIn: null,
    firstName: null, middleName: null, lastName: null, title: null, company: null,
    street: null, city: null, state: null, postalCode: null, country: null,
    description: raw.slice(0, 255),
    _raw: raw,
    _confidence: {},
  };
}

/**
 * Given parsed entities and an object field-map (from constants.js),
 * return a { sfFieldName: value } object ready for the Salesforce API.
 *
 * @param {ReturnType<parseText>} parsed
 * @param {Record<string,string>} fieldMap  e.g. OBJECT_FIELD_MAPS.Lead
 * @returns {Record<string,string>}
 */
export function applyFieldMap(parsed, fieldMap) {
  const record = {};
  for (const [entityKey, sfField] of Object.entries(fieldMap)) {
    const val = parsed[entityKey];
    if (val !== null && val !== undefined && String(val).trim() !== '') {
      record[sfField] = String(val).trim();
    }
  }
  return record;
}
