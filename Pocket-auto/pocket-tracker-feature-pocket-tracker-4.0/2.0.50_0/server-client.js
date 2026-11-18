const API_BASE = 'https://api.pockettraderobot.online';
const ADMIN_URL = 'https://admin.pockettraderobot.online';
const SUPPORT_URL = 'https://t.me/TradeRobotSoftwareSupport';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const SERVER_CLIENT_BUILD = '2.0.50-statusbar-recovery-20260916';
const LEGAL_CONSENT_VERSION = '2026-09-03-v8-pocket-trade-robot-pc-privacy';
const LEGAL_DISCLOSURE_PREFERENCE_KEY = 'ptLegalDisclosurePreference';
const LEGAL_DISCLOSURE_PREFERENCE_SCHEMA = 1;
const LEGAL_PERSISTENT_STORAGE_KEYS = Object.freeze([
  'ptLegalConsent',
  LEGAL_DISCLOSURE_PREFERENCE_KEY,
  'ptLegalDisclosureDontShowAgain',
  'ptLegalDisclosureDontShowAgainVersion',
  'ptLegalConsentModalAccepted',
  'ptLegalConsentModalVersion',
  'ptLegalConsentModalAcceptedAt'
]);
const PRIVACY_URL = 'https://api.pockettraderobot.online/privacy/pocket-trade-robot-pc';
const TERMS_URL = 'https://api.pockettraderobot.online/terms';
const RISK_URL = 'https://api.pockettraderobot.online/risk';
const AFFILIATE_DISCLOSURE_URL = 'https://api.pockettraderobot.online/affiliate-disclosure';
const CURRENT_AFFILIATE_REGISTRATION_URL = 'https://u3.shortink.io/register?utm_campaign=863136&utm_source=affiliate&utm_medium=sr&a=2ZMIhcmXbAnA1h&al=1791102&ac=softwaretraffic&cid=976392';
const CURRENT_AFFILIATE_CAMPAIGN_ID = '863136';
const CURRENT_AFFILIATE_CODE = '2ZMIhcmXbAnA1h';
const DEFAULT_WS_URL = 'wss://ws.pockettraderobot.online/ws/v1/signals';
const PREMIUM_CACHE_GRACE_MS = 15 * 60 * 1000;
const SERVER_SYNC_TIMEOUT_MS = 30000;
const SERVER_HEALTH_TIMEOUT_MS = 7000;
const SERVER_SYNC_ATTEMPT_TIMEOUT_MS = 6000;
const SERVER_SYNC_RETRY_DELAYS_MS = Object.freeze([400, 1200]);
const SERVER_HEALTH_RETRY_DELAYS_MS = Object.freeze([350]);
const SERVER_SYNC_MIN_INTERVAL_MS = 30000;
const SERVER_TRANSIENT_BACKOFF_MS = 5000;
const SERVER_RATE_LIMIT_BACKOFF_MS = 90000;
const SERVER_DEVICE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const FREE_MAX_ASSETS = 30;
let syncInFlight = null;
// A force-bootstrap request must never be swallowed by an already running public
// health sync. Revisions let concurrent callers join safely and schedule exactly
// the follow-up bootstrap generations that actually arrived while busy.
let syncForceRequestedRevision = 0;
let syncForceCompletedRevision = 0;
let lastSyncStartedAt = 0;
let nextSyncAllowedAt = 0;
let initializeServerClientInFlight = null;

const FREE_ENTITLEMENT = Object.freeze({
  plan: 'FREE',
  premium: false,
  source: 'free',
  status: 'active',
  accessState: 'FREE_PENDING_TRIAL',
  registrationRequired: false,
  realTradingAllowed: false,
  pauseReason: null,
  expiresAt: null,
  limits: { maxAssets: FREE_MAX_ASSETS, maxDailyTrades: 50, maxDevices: null },
  features: {
    ai: false,
    strategyBuilder: false,
    autoTrading: false,
    realTrading: false,
    basicStrategies: true,
    premiumStrategies: false
  },
  devices: { used: null, allowed: null },
  affiliate: {
    registered: false,
    qualifyingDeposit: 0,
    eligible: false,
    publicMinDepositUsd: 10,
    registrationUrl: ''
  },
  trial: { available: false, automatic: true, hours: 24, used: false, active: false, expired: false, activatedAt: null, expiresAt: null, remainingSeconds: 0 },
  supportUrl: SUPPORT_URL
});

function isCurrentLegalConsent(consent) {
  return Boolean(
    consent?.accepted === true
    && consent?.version === LEGAL_CONSENT_VERSION
    && consent?.adultConfirmed === true
    && consent?.riskAccepted === true
    && consent?.pocketOfferAccepted === true
    && consent?.termsAccepted === true
    && consent?.privacyAccepted === true
    && consent?.affiliateDisclosureAccepted === true
  );
}

function storedLegalDisclosurePreference(stored = {}) {
  const preference = stored?.[LEGAL_DISCLOSURE_PREFERENCE_KEY];
  const dontShowAgain = preference?.schemaVersion === LEGAL_DISCLOSURE_PREFERENCE_SCHEMA
    ? preference?.dontShowAgain === true
    : stored?.ptLegalConsent?.disclosureDontShowAgain === true || stored?.ptLegalDisclosureDontShowAgain === true;
  return { preference: preference || null, dontShowAgain };
}

async function readLegalStorage(keys, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 60 * attempt));
    }
  }
  throw lastError || new Error('LEGAL_CONSENT_LOCAL_READ_FAILED');
}

export async function getLegalConsent() {
  const stored = await readLegalStorage([
    'ptLegalConsent',
    LEGAL_DISCLOSURE_PREFERENCE_KEY,
    'ptLegalDisclosureDontShowAgain'
  ]);
  const ptLegalConsent = stored?.ptLegalConsent || null;
  const accepted = isCurrentLegalConsent(ptLegalConsent);
  const disclosure = storedLegalDisclosurePreference(stored);
  return {
    accepted,
    version: LEGAL_CONSENT_VERSION,
    consent: ptLegalConsent,
    dontShowAgain: accepted && disclosure.dontShowAgain,
    preference: disclosure.preference,
    urls: { privacy: PRIVACY_URL, terms: TERMS_URL, risk: RISK_URL, affiliate: AFFILIATE_DISCLOSURE_URL }
  };
}

export async function getRuntimeInfo() {
  const legal = await getLegalConsent();
  const state = await readServerState();
  return {
    buildId: SERVER_CLIENT_BUILD,
    extensionVersion: EXTENSION_VERSION,
    serverStateSchema: 2,
    serverStateVersion: Number(state?.version || 2),
    legalConsentVersion: LEGAL_CONSENT_VERSION,
    legalAccepted: legal.accepted === true,
    apiBase: API_BASE,
    wsUrl: DEFAULT_WS_URL
  };
}

export async function acceptLegalConsent(payload = {}) {
  const acceptedAt = nowIso();
  const previous = await readLegalStorage([
    'ptLegalConsent',
    LEGAL_DISCLOSURE_PREFERENCE_KEY,
    'ptLegalDisclosureDontShowAgain'
  ]);
  const previousDisclosure = storedLegalDisclosurePreference(previous);
  const dontShowAgain = typeof payload.dontShowAgain === 'boolean'
    ? payload.dontShowAgain
    : previousDisclosure.dontShowAgain;
  const consent = {
    accepted: true,
    version: LEGAL_CONSENT_VERSION,
    acceptedAt,
    adultConfirmed: payload.adultConfirmed === true,
    riskAccepted: payload.riskAccepted === true,
    pocketOfferAccepted: payload.pocketOfferAccepted === true,
    termsAccepted: payload.termsAccepted === true,
    privacyAccepted: payload.privacyAccepted === true,
    affiliateDisclosureAccepted: payload.affiliateDisclosureAccepted === true,
    disclosureDontShowAgain: dontShowAgain,
    language: String(payload.language || 'ru').slice(0, 8)
  };
  if (!isCurrentLegalConsent(consent)) {
    throw new Error('Необходимо подтвердить все обязательные условия');
  }
  const preference = {
    schemaVersion: LEGAL_DISCLOSURE_PREFERENCE_SCHEMA,
    dontShowAgain,
    consentVersion: LEGAL_CONSENT_VERSION,
    savedAt: acceptedAt
  };
  // Consent and the durable UI preference must become visible in one storage
  // change. Two separate writes allow another Pocket tab to reopen the modal in
  // the short interval after consent is saved but before the preference exists.
  await chrome.storage.local.set({
    ptLegalConsent: consent,
    [LEGAL_DISCLOSURE_PREFERENCE_KEY]: preference
  });
  const verified = await readLegalStorage(['ptLegalConsent', LEGAL_DISCLOSURE_PREFERENCE_KEY]);
  if (!isCurrentLegalConsent(verified?.ptLegalConsent)
    || verified?.[LEGAL_DISCLOSURE_PREFERENCE_KEY]?.schemaVersion !== LEGAL_DISCLOSURE_PREFERENCE_SCHEMA
    || verified?.[LEGAL_DISCLOSURE_PREFERENCE_KEY]?.dontShowAgain !== dontShowAgain) {
    throw new Error('LEGAL_CONSENT_LOCAL_SAVE_FAILED');
  }
  return consent;
}

async function requireLegalConsent() {
  const state = await getLegalConsent();
  if (!state.accepted) {
    const error = new Error('LEGAL_CONSENT_REQUIRED');
    error.code = 'LEGAL_CONSENT_REQUIRED';
    throw error;
  }
  return state;
}

function safeExternalUrl(value, allowedHosts = null) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    if (allowedHosts && !allowedHosts.includes(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function isCurrentAffiliateRegistrationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'u3.shortink.io'
      && String(url.searchParams.get('utm_campaign') || '') === CURRENT_AFFILIATE_CAMPAIGN_ID
      && String(url.searchParams.get('a') || '') === CURRENT_AFFILIATE_CODE;
  } catch {
    return false;
  }
}

async function openSafeUrl(value, allowedHosts = null) {
  const url = safeExternalUrl(value, allowedHosts);
  if (!url) throw new Error('Недопустимая или небезопасная ссылка');
  await chrome.tabs.create({ url, active: true });
  return { ok: true };
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function randomId() {
  return `${crypto.randomUUID?.() || randomHex(16)}`;
}

function isBridgeConnected(state) {
  return Boolean(
    state?.connection?.connected &&
    state?.socket?.authenticated &&
    state?.socket?.readyState === 1 &&
    state?.account?.uid != null
  );
}

function latestTradeIso(state) {
  const deals = [
    ...(Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals : []),
    ...(Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals : [])
  ];
  const maxTs = deals.reduce((max, deal) => {
    const value = Number(deal?.closeTimestamp || deal?.openTimestamp || 0);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
  return maxTs > 0 ? new Date(maxTs * 1000).toISOString() : null;
}

async function ensureDeviceIdentity() {
  const stored = await chrome.storage.local.get('ptDeviceIdentity');
  const existing = stored.ptDeviceIdentity;
  if (existing?.installationId) {
    const normalized = {
      installationId: String(existing.installationId),
      createdAt: existing.createdAt || nowIso(),
      platform: existing.platform || navigator.userAgentData?.platform || navigator.platform || 'Chrome'
    };
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
      await chrome.storage.local.set({ ptDeviceIdentity: normalized });
    }
    return normalized;
  }

  const identity = {
    installationId: `pt_${randomId()}`,
    createdAt: nowIso(),
    platform: navigator.userAgentData?.platform || navigator.platform || 'Chrome'
  };
  await chrome.storage.local.set({ ptDeviceIdentity: identity });
  return identity;
}

async function ensureAffiliateIdentity() {
  const stored = await chrome.storage.local.get('ptAffiliateIdentity');
  const existing = stored.ptAffiliateIdentity;
  if (existing?.clickId && String(existing.clickId).length >= 20) return existing;
  const identity = {
    clickId: `pt_click_${randomHex(18)}`,
    createdAt: nowIso()
  };
  await chrome.storage.local.set({ ptAffiliateIdentity: identity });
  return identity;
}

async function readRawServerState() {
  const { ptServerState } = await chrome.storage.local.get('ptServerState');
  return normalizeStoredServerState(ptServerState);
}

async function readServerState() {
  const stored = await chrome.storage.local.get(['ptServerState', 'poBridgeState']);
  const state = normalizeStoredServerState(stored.ptServerState);
  const context = serverAccountContext(stored.poBridgeState || null);
  if (!state || !context) return state;
  const storedUid = String(state.pocketUid || '').trim();
  const sessionMismatch = Boolean(state.sessionToken && !stateHasSessionForUid(state, context.uid));
  if ((storedUid && storedUid !== context.uid) || sessionMismatch) {
    // Never return credentials belonging to another live Pocket account, even
    // during the short interval before the storage change listener runs.
    return emptyServerState({
      serverReachable: Boolean(state.serverReachable),
      lastHealthAt: state.lastHealthAt || null,
      accountConnected: true,
      pocketUid: context.uid,
      accountMode: context.mode,
      accountKey: context.key,
      lastError: 'SERVER_SESSION_REFRESHING'
    });
  }
  return normalizeStoredServerState({
    ...state,
    pocketUid: context.uid,
    accountMode: context.mode,
    accountKey: context.key
  });
}

function emptyServerState(patch = {}) {
  const next = {
    version: 2,
    clientBuild: SERVER_CLIENT_BUILD,
    online: false,
    serverReachable: false,
    accountConnected: false,
    authenticated: false,
    lastHealthAt: null,
    lastSyncAt: null,
    lastError: null,
    sessionToken: null,
    sessionUid: null,
    pocketUid: null,
    accountMode: null,
    accountKey: null,
    apiBase: API_BASE,
    lastTransportError: null,
    transientFailureCount: 0,
    entitlement: structuredClone(FREE_ENTITLEMENT),
    strategies: [],
    deletedCustomStrategyIds: [],
    release: null,
    broadcasts: [],
    wsUrl: DEFAULT_WS_URL,
    adminUrl: ADMIN_URL,
    supportUrl: SUPPORT_URL,
    ...patch,
    updatedAt: nowIso()
  };
  next.entitlement = normalizeEntitlementLimits(next.entitlement);
  next.wsUrl = canonicalSignalWsUrl(next.wsUrl);
  next.adminUrl = ADMIN_URL;
  next.supportUrl = SUPPORT_URL;
  return next;
}

function canonicalSignalWsUrl(value) {
  try {
    const url = new URL(String(value || DEFAULT_WS_URL));
    if (url.protocol === 'wss:' && url.hostname.toLowerCase() === 'ws.pockettraderobot.online') {
      return url.href;
    }
  } catch {}
  return DEFAULT_WS_URL;
}

function normalizeStoredServerState(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = { ...value };
  const pocketUid = raw.pocketUid == null ? '' : String(raw.pocketUid).trim();
  // Version 1 did not persist sessionUid. A recently authenticated legacy state
  // can be migrated only to the UID it already names; a later account switch is
  // handled atomically by bindServerAccountContext().
  const legacySessionUid = !raw.sessionUid && raw.sessionToken && raw.authenticated === true && pocketUid
    ? pocketUid
    : '';
  const sessionUid = String(raw.sessionUid || legacySessionUid || '').trim();
  const tokenMatchesUid = Boolean(raw.sessionToken && pocketUid && sessionUid === pocketUid);
  const next = emptyServerState({
    ...raw,
    version: 2,
    pocketUid: pocketUid || null,
    sessionUid: sessionUid || null,
    wsUrl: canonicalSignalWsUrl(raw.wsUrl)
  });
  if (!tokenMatchesUid) {
    next.online = false;
    next.authenticated = false;
    next.sessionToken = null;
    next.sessionUid = null;
    next.entitlement = normalizeEntitlementLimits(structuredClone(FREE_ENTITLEMENT));
    next.strategies = [];
    next.deletedCustomStrategyIds = [];
    next.broadcasts = [];
    next.wsUrl = DEFAULT_WS_URL;
  } else {
    next.online = Boolean(next.online && next.authenticated);
  }
  return next;
}

async function replaceServerState(patch = {}) {
  const next = emptyServerState(patch);
  await chrome.storage.local.set({ ptServerState: next });
  return next;
}

async function saveServerState(patch) {
  const previous = await readServerState();
  const next = normalizeStoredServerState(emptyServerState({ ...(previous || {}), ...patch }));
  await chrome.storage.local.set({ ptServerState: next });
  return next;
}

async function serverSessionStillCurrent(sessionState) {
  if (!sessionState?.sessionToken) return false;
  const { poBridgeState } = await chrome.storage.local.get('poBridgeState');
  const context = serverAccountContext(poBridgeState || null);
  if (!context || !stateHasSessionForUid(sessionState, context.uid)) return false;
  const requestKey = String(sessionState.accountKey || '').trim();
  return !requestKey || requestKey === context.key;
}

async function saveServerStateForSession(patch, sessionState) {
  if (!await serverSessionStillCurrent(sessionState)) {
    const { poBridgeState } = await chrome.storage.local.get('poBridgeState');
    return bindServerAccountContext(poBridgeState || null);
  }
  return saveServerState({
    ...patch,
    pocketUid: sessionState.pocketUid,
    sessionUid: sessionState.sessionUid,
    sessionToken: sessionState.sessionToken,
    accountMode: sessionState.accountMode || null,
    accountKey: sessionState.accountKey || null
  });
}

function serverAccountContext(bridgeState) {
  if (!isBridgeConnected(bridgeState)) return null;
  const uid = String(bridgeState?.account?.uid ?? '').trim();
  if (!uid) return null;
  const mode = String(bridgeState?.account?.mode || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
  return { uid, mode, key: `${uid}:${mode}` };
}

function stateHasSessionForUid(state, uid) {
  const expectedUid = String(uid || '').trim();
  return Boolean(
    expectedUid
    && state?.sessionToken
    && String(state?.sessionUid || '').trim() === expectedUid
    && String(state?.pocketUid || '').trim() === expectedUid
  );
}

export async function bindServerAccountContext(bridgeState) {
  const context = serverAccountContext(bridgeState);
  const previous = await readRawServerState();
  if (!context) {
    if (!previous?.sessionToken && !previous?.pocketUid) return previous;
    return replaceServerState({
      serverReachable: Boolean(previous?.serverReachable),
      lastHealthAt: previous?.lastHealthAt || null,
      lastError: 'ACCOUNT_NOT_CONNECTED'
    });
  }

  const previousUid = String(previous?.pocketUid || '').trim();
  const sessionUid = String(previous?.sessionUid || '').trim();
  const uidChanged = Boolean((previousUid && previousUid !== context.uid) || (sessionUid && sessionUid !== context.uid));
  if (uidChanged || (previous?.sessionToken && !stateHasSessionForUid(previous, context.uid))) {
    return replaceServerState({
      serverReachable: Boolean(previous?.serverReachable),
      accountConnected: true,
      pocketUid: context.uid,
      accountMode: context.mode,
      accountKey: context.key,
      lastHealthAt: previous?.lastHealthAt || null,
      lastError: 'SERVER_SESSION_REFRESHING'
    });
  }

  if (
    previous
    && String(previous.pocketUid || '') === context.uid
    && String(previous.accountMode || '') === context.mode
    && String(previous.accountKey || '') === context.key
  ) {
    return previous;
  }
  return saveServerState({
    accountConnected: true,
    pocketUid: context.uid,
    accountMode: context.mode,
    accountKey: context.key
  });
}

function isTransientApiError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const status = Number(error?.status || 0);
  return error?.code === 'API_TIMEOUT'
    || message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network error')
    || message.includes('load failed')
    || message.includes('connection reset')
    || message.includes('connection aborted')
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

function isRetryableTransportError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const status = Number(error?.status || 0);
  return error?.code === 'API_TIMEOUT'
    || message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network error')
    || message.includes('load failed')
    || message.includes('connection reset')
    || message.includes('connection aborted')
    || status === 408
    || status === 425
    || status >= 500;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

let activeApiBase = API_BASE;

function orderedApiBases() {
  // api.* and ws.* terminate on the same protected backend, but Chrome keeps a
  // separate TLS/HTTP connection pool for each hostname.  The second hostname
  // therefore heals a poisoned/stale connection (seen after a server/IP change
  // and after VPN reconnects) without weakening authentication or CORS.
  const bases = [API_BASE, 'https://ws.pockettraderobot.online'];
  return [...new Set([activeApiBase, ...bases].filter(Boolean))];
}

async function apiFromBase(baseUrl, path, options, headers, timeoutMs, noTimeout) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = noTimeout ? null : setTimeout(() => {
    timedOut = true;
    try { controller.abort('PT_API_TIMEOUT'); } catch { controller.abort(); }
  }, timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.detail || data.error || `HTTP_${response.status}`);
      error.status = response.status;
      error.data = data;
      error.apiBase = baseUrl;
      const retryAfterRaw = response.headers.get('Retry-After');
      const retryAfterSeconds = Number(retryAfterRaw);
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        error.retryAfterMs = Math.ceil(retryAfterSeconds * 1000);
      }
      throw error;
    }
    activeApiBase = baseUrl;
    return data;
  } catch (error) {
    if (timedOut || (!noTimeout && error?.name === 'AbortError')) {
      const timeoutError = new Error(`API_TIMEOUT_${timeoutMs}MS`);
      timeoutError.code = 'API_TIMEOUT';
      timeoutError.apiBase = baseUrl;
      throw timeoutError;
    }
    if (error && !error.apiBase) error.apiBase = baseUrl;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function api(path, options = {}, token = null) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const noTimeout = options.timeoutMs === 0 || options.noTimeout === true;
  const timeoutMs = noTimeout ? 0 : Math.max(3000, Number(options.timeoutMs) || SERVER_SYNC_TIMEOUT_MS);
  let lastError = null;
  const failures = [];
  const bases = orderedApiBases();
  for (let index = 0; index < bases.length; index += 1) {
    const baseUrl = bases[index];
    try {
      return await apiFromBase(baseUrl, path, options, headers, timeoutMs, noTimeout);
    } catch (error) {
      lastError = error;
      failures.push(`${baseUrl}: ${String(error?.message || error)}`);
      // A real HTTP answer (401/403/429/4xx) is authoritative. Fail over only
      // for a broken connection, timeout, or a temporary 5xx proxy/upstream.
      if (index >= bases.length - 1 || !isRetryableTransportError(error)) {
        if (failures.length > 1 && error) error.transportFailures = [...failures];
        throw error;
      }
    }
  }
  if (lastError && failures.length > 1) lastError.transportFailures = failures;
  throw lastError || new Error('SERVER_REQUEST_FAILED');
}

async function apiWithTransientRetry(path, options = {}, token = null, retryDelays = SERVER_SYNC_RETRY_DELAYS_MS) {
  let lastError = null;
  const delays = Array.isArray(retryDelays) ? retryDelays : [];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await api(path, options, token);
    } catch (error) {
      lastError = error;
      if (attempt >= delays.length || !isRetryableTransportError(error)) throw error;
      await waitMs(delays[attempt]);
    }
  }
  throw lastError || new Error('SERVER_REQUEST_FAILED');
}

const SERVER_RECOVERY_ALARM = 'pt-server-recovery';

function scheduleServerRecoveryAlarm(failureCount = 1) {
  const count = Math.max(1, Math.min(10, Math.floor(Number(failureCount) || 1)));
  const delayMs = Math.min(30000, 4000 * (2 ** Math.min(3, count - 1)));
  try {
    chrome.alarms?.create?.(SERVER_RECOVERY_ALARM, { when: Date.now() + delayMs });
  } catch {}
  return delayMs;
}

function clearServerRecoveryAlarm() {
  try { void chrome.alarms?.clear?.(SERVER_RECOVERY_ALARM); } catch {}
}

function bootstrapPayload(bridgeState, affiliateIdentity = null, deviceIdentity = null) {
  const account = bridgeState?.account || {};
  return {
    pocketUid: String(account.uid || ''),
    installationId: String(deviceIdentity?.installationId || ''),
    version: EXTENSION_VERSION,
    platform: navigator.userAgentData?.platform || navigator.platform || 'Chrome',
    mode: account.mode || null,
    balance: typeof account.balance === 'number' ? account.balance : null,
    currency: account.currency || null,
    lastTradeAt: latestTradeIso(bridgeState),
    clickId: affiliateIdentity?.clickId || null
  };
}

function heartbeatPayload(bridgeState, selectedAssets = []) {
  const account = bridgeState?.account || {};
  return {
    version: EXTENSION_VERSION,
    mode: account.mode || null,
    balance: typeof account.balance === 'number' ? account.balance : null,
    currency: account.currency || null,
    selectedAssets: Array.isArray(selectedAssets) ? [...new Set(selectedAssets)] : []
  };
}

function serverNotificationId(item) {
  const rawId = String(item?.id ?? item?.notificationId ?? '').trim();
  if (rawId) return `server-notification-${rawId}`;
  const seed = `${item?.title || ''}|${item?.body || item?.message || ''}|${item?.created_at || item?.createdAt || ''}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `server-notification-${(hash >>> 0).toString(16)}`;
}

function safeNotificationUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function rebrandLegacyServerText(value = '') {
  return String(value || '')
    .replace(/Perfect Trade Binary Bot/gi, 'Pocket TRADE ROBOT')
    .replace(/Perfect Trade Robot/gi, 'Pocket TRADE ROBOT')
    .replace(/Perfect Trade/gi, 'Pocket TRADE ROBOT');
}

function isRetiredMirrorPermissionNotification(title = '', message = '') {
  const text = `${String(title || '')} ${String(message || '')}`.toLowerCase();
  // Mirror support is retired. Do not surface any server/legacy system popup that
  // mentions a mirror or a rotating po-*** host, even when wording changes.
  return /(?:зеркал|mirror|po-[a-z0-9-]+\.(?:com|net|org|io|co|trade|click|top|site|online|pro|app|xyz|info|live|link|space|icu))/.test(text);
}

export async function ingestServerNotifications(items, { showSystemPopup = true } = {}) {
  const incoming = Array.isArray(items) ? items.filter((item) => item && typeof item === 'object') : [];
  if (!incoming.length) return { added: 0 };
  const stored = await chrome.storage.local.get(['ptNotificationHistory', 'ptSeenServerNotifications', 'ptServerNotificationActions']);
  const history = Array.isArray(stored.ptNotificationHistory) ? stored.ptNotificationHistory : [];
  const seen = new Set(Array.isArray(stored.ptSeenServerNotifications) ? stored.ptSeenServerNotifications.map(String) : []);
  const actions = stored.ptServerNotificationActions && typeof stored.ptServerNotificationActions === 'object'
    ? { ...stored.ptServerNotificationActions }
    : {};
  const added = [];
  const suppressedMirrorIds = new Set();

  for (const item of incoming.slice().sort((a, b) => Date.parse(a.created_at || a.createdAt || 0) - Date.parse(b.created_at || b.createdAt || 0))) {
    const id = serverNotificationId(item);
    if (seen.has(id)) continue;
    const title = rebrandLegacyServerText(item.title || 'Pocket TRADE ROBOT').trim().slice(0, 180) || 'Pocket TRADE ROBOT';
    const message = rebrandLegacyServerText(item.body || item.message || '').trim().slice(0, 5000);
    if (!message) continue;
    if (isRetiredMirrorPermissionNotification(title, message)) {
      seen.add(id);
      suppressedMirrorIds.add(id);
      delete actions[id];
      await chrome.notifications?.clear?.(id).catch(() => null);
      continue;
    }
    const createdAt = item.created_at || item.createdAt || new Date().toISOString();
    const actionUrl = safeNotificationUrl(item.button_url || item.buttonUrl);
    const buttonText = String(item.button_text || item.buttonText || 'Открыть').trim().slice(0, 80) || 'Открыть';
    const event = { id, serverId: item.id ?? null, kind: 'system', title, message, createdAt, read: false, actionUrl, buttonText };
    added.push(event);
    seen.add(id);
    if (actionUrl) actions[id] = actionUrl;
  }

  if (!added.length && !suppressedMirrorIds.size) return { added: 0 };
  const addedIds = new Set(added.map((item) => String(item.id)));
  const nextHistory = [...[...added].reverse(), ...history.filter((item) => {
    const id = String(item?.id || '');
    if (addedIds.has(id) || suppressedMirrorIds.has(id)) return false;
    return !isRetiredMirrorPermissionNotification(item?.title, item?.message);
  })].slice(0, 100);
  const seenList = [...seen].slice(-500);
  const actionEntries = Object.entries(actions).filter(([key]) => seen.has(key)).slice(-200);
  await chrome.storage.local.set({
    ptNotificationHistory: nextHistory,
    ptSeenServerNotifications: seenList,
    ptServerNotificationActions: Object.fromEntries(actionEntries)
  });

  if (showSystemPopup && chrome.notifications?.create) {
    for (const event of added) {
      const options = {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon128.png'),
        title: event.title,
        message: event.message.slice(0, 240),
        contextMessage: 'Pocket TRADE ROBOT',
        priority: 2
      };
      if (event.actionUrl) options.buttons = [{ title: event.buttonText || 'Открыть' }];
      await chrome.notifications.create(event.id, options).catch(() => null);
    }
  }
  return { added: added.length, suppressedMirror: suppressedMirrorIds.size, events: added };
}

function normalizeEntitlementLimits(entitlement) {
  const base = entitlement && typeof entitlement === 'object' ? structuredClone(entitlement) : structuredClone(FREE_ENTITLEMENT);
  const premium = Boolean(base.premium || String(base.plan || '').toUpperCase() === 'PREMIUM');
  base.limits = base.limits && typeof base.limits === 'object' ? { ...base.limits } : {};
  if (premium) {
    if (base.limits.maxAssets === undefined) base.limits.maxAssets = null;
  } else {
    const current = Number(base.limits.maxAssets);
    base.limits.maxAssets = Number.isFinite(current) && current > 0 ? Math.min(FREE_MAX_ASSETS, Math.floor(current)) : FREE_MAX_ASSETS;
    if (base.limits.maxDailyTrades === undefined || base.limits.maxDailyTrades === null) base.limits.maxDailyTrades = 50;
  }
  return base;
}

async function probeServerHealth() {
  try {
    const data = await apiWithTransientRetry(
      '/api/health',
      { method: 'GET', timeoutMs: Math.min(SERVER_HEALTH_TIMEOUT_MS, 4500) },
      null,
      SERVER_HEALTH_RETRY_DELAYS_MS
    );
    return { ok: true, data, checkedAt: nowIso() };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), checkedAt: nowIso() };
  }
}

function mergeServerResponse(previous, data, context, token = null) {
  const uid = String(context?.uid || '').trim();
  const sameSession = stateHasSessionForUid(previous, uid) ? previous : null;
  const sessionToken = token || sameSession?.sessionToken || null;
  return normalizeStoredServerState(emptyServerState({
    ...(sameSession || {}),
    online: true,
    serverReachable: true,
    accountConnected: true,
    authenticated: true,
    lastHealthAt: nowIso(),
    syncDegraded: false,
    lastSyncAt: nowIso(),
    lastError: null,
    apiBase: activeApiBase,
    lastTransportError: null,
    transientFailureCount: 0,
    pocketUid: uid,
    accountMode: context?.mode || null,
    accountKey: context?.key || null,
    sessionUid: uid,
    sessionToken,
    entitlement: normalizeEntitlementLimits(data.entitlement || sameSession?.entitlement || structuredClone(FREE_ENTITLEMENT)),
    strategies: Array.isArray(data.strategies) ? data.strategies : (sameSession?.strategies || []),
    deletedCustomStrategyIds: Array.isArray(data.deletedCustomStrategyIds)
      ? data.deletedCustomStrategyIds.map(String).filter(Boolean)
      : (sameSession?.deletedCustomStrategyIds || []),
    release: data.release || sameSession?.release || null,
    broadcasts: Array.isArray(data.broadcasts) ? data.broadcasts : (sameSession?.broadcasts || []),
    wsUrl: canonicalSignalWsUrl(data.wsUrl || sameSession?.wsUrl || DEFAULT_WS_URL)
  }));
}

async function syncServerInternal({ forceBootstrap = false } = {}) {
  const now = Date.now();
  let previousBeforeChecks = await readServerState();

  const consentState = await getLegalConsent();
  if (!consentState.accepted) {
    clearServerRecoveryAlarm();
    if (now < nextSyncAllowedAt && previousBeforeChecks?.lastHealthAt) {
      return previousBeforeChecks;
    }
    const health = await probeServerHealth();
    nextSyncAllowedAt = Date.now() + SERVER_SYNC_MIN_INTERVAL_MS;
    return replaceServerState({
      online: false,
      serverReachable: health.ok,
      accountConnected: false,
      authenticated: false,
      lastHealthAt: health.checkedAt,
      syncDegraded: false,
      lastError: 'LEGAL_CONSENT_REQUIRED',
      sessionToken: null,
      pocketUid: null,
      entitlement: structuredClone(FREE_ENTITLEMENT)
    });
  }

  const stored = await chrome.storage.local.get(['poBridgeState', 'poBridgeSettings']);
  const bridgeState = stored.poBridgeState || null;
  const selectedAssets = stored.poBridgeSettings?.selectedAssets || [];
  const context = serverAccountContext(bridgeState);
  const bridgeConnected = Boolean(context);
  const uid = context?.uid || null;

  if (bridgeConnected) {
    previousBeforeChecks = await bindServerAccountContext(bridgeState);
  }
  const previousError = String(previousBeforeChecks?.lastError || '');
  const hardBackoff = previousError === 'rate_limit_exceeded';

  // FINAL6: heal stale ACCOUNT_NOT_CONNECTED/session_missing states.
  // In MV3 the service worker can run sync before poBridgeState becomes fully
  // authenticated. That creates ACCOUNT_NOT_CONNECTED and the 30s throttle then
  // blocks the immediate real bootstrap after the account connects.
  const staleAccountError = bridgeConnected && /ACCOUNT_NOT_CONNECTED|session_missing|SERVER_OFFLINE/i.test(previousError);
  const missingSessionForUid = bridgeConnected && (
    !stateHasSessionForUid(previousBeforeChecks, uid)
    || previousBeforeChecks?.online !== true
  );
  if (staleAccountError || missingSessionForUid) {
    forceBootstrap = true;
  }

  if (now < nextSyncAllowedAt && (!forceBootstrap || hardBackoff)) {
    return previousBeforeChecks || saveServerState({});
  }
  if (!forceBootstrap && previousBeforeChecks && now - lastSyncStartedAt < SERVER_SYNC_MIN_INTERVAL_MS) {
    return previousBeforeChecks;
  }
  lastSyncStartedAt = now;

  if (!bridgeConnected) {
    clearServerRecoveryAlarm();
    // Public API reachability is independent from Pocket account authorization.
    // This keeps the server link alive before the user explicitly presses CONNECT.
    const health = await probeServerHealth();
    nextSyncAllowedAt = Date.now() + SERVER_SYNC_MIN_INTERVAL_MS;
    return replaceServerState({
      online: false,
      serverReachable: health.ok,
      accountConnected: false,
      authenticated: false,
      lastHealthAt: health.checkedAt,
      lastError: 'ACCOUNT_NOT_CONNECTED',
      entitlement: structuredClone(FREE_ENTITLEMENT),
      sessionToken: null,
      pocketUid: null
    });
  }

  const [affiliateIdentity, deviceIdentity] = await Promise.all([
    ensureAffiliateIdentity(),
    ensureDeviceIdentity()
  ]);
  const previous = previousBeforeChecks || await readServerState();
  let sessionRejected = false;

  try {
    let data;
    let token = stateHasSessionForUid(previous, uid) ? previous.sessionToken : null;
    const canHeartbeat = !forceBootstrap && Boolean(token);
    if (canHeartbeat) {
      try {
        data = await apiWithTransientRetry('/api/v1/device/heartbeat', {
          method: 'POST',
          body: JSON.stringify(heartbeatPayload(bridgeState, selectedAssets)),
          timeoutMs: SERVER_SYNC_ATTEMPT_TIMEOUT_MS
        }, token);
      } catch (error) {
        if (error.status !== 401 && error.status !== 403) throw error;
        sessionRejected = true;
        token = null;
      }
    }
    if (!data) {
      data = await apiWithTransientRetry('/api/v1/device/bootstrap', {
        method: 'POST',
        body: JSON.stringify(bootstrapPayload(bridgeState, affiliateIdentity, deviceIdentity)),
        timeoutMs: SERVER_SYNC_ATTEMPT_TIMEOUT_MS
      });
      token = String(data?.sessionToken || '').trim();
      if (!token) throw new Error('SERVER_SESSION_TOKEN_MISSING');
    }

    const latestStored = await chrome.storage.local.get('poBridgeState');
    const latestContext = serverAccountContext(latestStored.poBridgeState || null);
    if (!latestContext || latestContext.key !== context.key) {
      return bindServerAccountContext(latestStored.poBridgeState || null);
    }
    await ingestServerNotifications(data.notifications, { showSystemPopup: true }).catch(() => null);
    const next = mergeServerResponse(previous, data, context, token);
    nextSyncAllowedAt = Date.now() + SERVER_SYNC_MIN_INTERVAL_MS;
    await chrome.storage.local.set({
      ptServerState: next,
      poBridgeSettings: {
        ...(stored.poBridgeSettings || {}),
        accessTier: next.entitlement?.premium ? 'PREMIUM' : 'FREE'
      }
    });
    clearServerRecoveryAlarm();
    return next;
  } catch (error) {
    const message = String(error?.message || error);
    const latestStored = await chrome.storage.local.get('poBridgeState');
    const latestContext = serverAccountContext(latestStored.poBridgeState || null);
    if (!latestContext || latestContext.key !== context.key) {
      return bindServerAccountContext(latestStored.poBridgeState || null);
    }
    const lastSyncAt = Date.parse(previous?.lastSyncAt || '');
    const cachedSessionUsable = Boolean(
      !sessionRejected
      &&
      stateHasSessionForUid(previous, uid)
      && Number.isFinite(lastSyncAt)
      && Date.now() - lastSyncAt <= PREMIUM_CACHE_GRACE_MS
    );
    const retryableTransportFailure = isRetryableTransportError(error);
    const retryableSessionFailure = retryableTransportFailure || message === 'SERVER_SESSION_TOKEN_MISSING';
    if (error?.status === 429 || message === 'rate_limit_exceeded') {
      nextSyncAllowedAt = Date.now() + Math.max(Number(error?.retryAfterMs) || 0, SERVER_RATE_LIMIT_BACKOFF_MS);
    } else if (retryableSessionFailure) {
      nextSyncAllowedAt = Date.now() + SERVER_TRANSIENT_BACKOFF_MS;
    } else {
      nextSyncAllowedAt = Date.now() + SERVER_SYNC_MIN_INTERVAL_MS;
    }
    const health = await probeServerHealth();
    const transientFailureCount = retryableSessionFailure
      ? Math.max(1, Math.min(10, Math.floor(Number(previous?.transientFailureCount) || 0) + 1))
      : 0;
    if (retryableSessionFailure) scheduleServerRecoveryAlarm(transientFailureCount);
    else clearServerRecoveryAlarm();
    const effectiveError = retryableSessionFailure && health.ok ? 'SERVER_SESSION_REFRESHING' : message;
    const transportError = retryableSessionFailure && Array.isArray(error?.transportFailures)
      ? error.transportFailures.join(' | ')
      : retryableSessionFailure ? message : null;
    const failurePatch = {
      online: cachedSessionUsable,
      serverReachable: health.ok,
      accountConnected: true,
      authenticated: cachedSessionUsable,
      lastHealthAt: health.checkedAt,
      syncDegraded: cachedSessionUsable || health.ok,
      lastError: effectiveError,
      lastTransportError: transportError,
      transientFailureCount,
      apiBase: activeApiBase,
      pocketUid: uid,
      accountMode: context.mode,
      accountKey: context.key
    };
    if (!cachedSessionUsable) {
      return replaceServerState({
        ...failurePatch,
        entitlement: structuredClone(FREE_ENTITLEMENT),
        wsUrl: DEFAULT_WS_URL
      });
    }
    return saveServerState(failurePatch);
  }
}

export async function syncServer(options = {}) {
  const wantsForceBootstrap = options?.forceBootstrap === true;
  const requestedRevision = wantsForceBootstrap ? ++syncForceRequestedRevision : 0;

  while (true) {
    // Join the current sync first. If this caller requested a force-bootstrap
    // after that sync had already started, loop once more instead of silently
    // losing the stronger request.
    if (syncInFlight) {
      const currentResult = await syncInFlight;
      if (!wantsForceBootstrap || syncForceCompletedRevision >= requestedRevision) {
        return currentResult;
      }
      continue;
    }

    const shouldForceBootstrap = wantsForceBootstrap
      || syncForceRequestedRevision > syncForceCompletedRevision;
    const forceRevision = shouldForceBootstrap
      ? syncForceRequestedRevision
      : syncForceCompletedRevision;
    const task = syncServerInternal({ ...options, forceBootstrap: shouldForceBootstrap });
    syncInFlight = task;
    try {
      const result = await task;
      if (shouldForceBootstrap) {
        syncForceCompletedRevision = Math.max(syncForceCompletedRevision, forceRevision);
      }
      if (!wantsForceBootstrap || syncForceCompletedRevision >= requestedRevision) {
        return result;
      }
    } finally {
      if (syncInFlight === task) syncInFlight = null;
    }
  }
}

function cachedPremiumAllowed(serverState) {
  if (!serverState?.entitlement?.premium || !serverState?.lastSyncAt) return false;
  return Date.now() - Date.parse(serverState.lastSyncAt) <= PREMIUM_CACHE_GRACE_MS;
}

export async function getServerState({ sync = false } = {}) {
  if (sync) await syncServer();
  const state = await readServerState();
  const normalizedState = {
    ...(state || {
      online: false,
      entitlement: structuredClone(FREE_ENTITLEMENT),
      strategies: [],
      broadcasts: [],
      release: null,
      wsUrl: 'wss://ws.pockettraderobot.online/ws/v1/signals'
    })
  };
  normalizedState.entitlement = normalizeEntitlementLimits(normalizedState.entitlement);
  return {
    ...normalizedState,
    adminUrl: ADMIN_URL,
    supportUrl: SUPPORT_URL
  };
}

export async function getServerAccess() {
  const serverState = await getServerState();
  let entitlement = normalizeEntitlementLimits(serverState.entitlement || structuredClone(FREE_ENTITLEMENT));
  if (!serverState.online && entitlement.premium && !cachedPremiumAllowed(serverState)) {
    entitlement = normalizeEntitlementLimits(structuredClone(FREE_ENTITLEMENT));
  }
  return { serverState: { ...serverState, entitlement }, entitlement };
}

export async function getReferralProgram({ retried = false } = {}) {
  let serverState = await readServerState();
  if (!serverState?.sessionToken) {
    serverState = await syncServer({ forceBootstrap: false }).catch(() => serverState);
  }
  if (!serverState?.sessionToken) throw new Error('REFERRAL_ACCOUNT_NOT_CONNECTED');
  try {
    const data = await api('/api/v1/referral-program', {
      method: 'GET',
      timeoutMs: 15000
    }, serverState.sessionToken);
    if (!await serverSessionStillCurrent(serverState)) throw new Error('SERVER_ACCOUNT_CHANGED');
    return data;
  } catch (error) {
    if (!retried && (error?.status === 401 || error?.status === 403)) {
      const refreshed = await syncServer({ forceBootstrap: true }).catch(() => null);
      if (refreshed?.sessionToken) return getReferralProgram({ retried: true });
    }
    throw error;
  }
}

export async function requestTradePermit(payload, { retried = false } = {}) {
  try { await requireLegalConsent(); } catch {
    return { ok: false, allowed: false, reason: 'LEGAL_CONSENT_REQUIRED', error: 'Сначала примите условия, политику конфиденциальности и предупреждение о рисках.' };
  }
  let serverState = await readServerState();
  const executionDeadlineMs = Number(payload?.executionDeadlineMs);
  const hasExecutionDeadline = Number.isFinite(executionDeadlineMs) && executionDeadlineMs > 0;
  const remainingMs = () => hasExecutionDeadline ? executionDeadlineMs - Date.now() : Infinity;
  if (hasExecutionDeadline && remainingMs() <= 2500) {
    return { ok: false, allowed: false, reason: 'SIGNAL_EXPIRED', error: 'Сигнал устарел до запроса разрешения' };
  }
  if (!serverState?.sessionToken && !hasExecutionDeadline) serverState = await syncServer({ forceBootstrap: true });
  if (!serverState?.online || !serverState?.sessionToken) {
    if (!hasExecutionDeadline) serverState = await syncServer({ forceBootstrap: true }).catch(() => serverState);
    if (!serverState?.online || !serverState?.sessionToken) {
      return { ok: false, allowed: false, reason: 'SERVER_OFFLINE', error: 'Сервер лицензий недоступен. Автоторговля временно ожидает восстановление сессии.' };
    }
  }
  try {
    if (hasExecutionDeadline && remainingMs() <= 3500) {
      return { ok: false, allowed: false, reason: 'SIGNAL_EXPIRED', error: 'Сигнал устарел перед запросом разрешения' };
    }
    const timeoutMs = hasExecutionDeadline
      ? Math.max(3000, Math.min(SERVER_SYNC_TIMEOUT_MS, remainingMs() - 750))
      : SERVER_SYNC_TIMEOUT_MS;
    const data = await api('/api/v1/trading/permit', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs
    }, serverState.sessionToken);
    if (!await serverSessionStillCurrent(serverState)) {
      return { ok: false, allowed: false, reason: 'ACCOUNT_CHANGED', error: 'Аккаунт изменился во время проверки. Сигнал отменён.' };
    }
    if (data.entitlement) await saveServerStateForSession({ entitlement: data.entitlement, online: true, lastSyncAt: nowIso(), lastError: null }, serverState);
    return { ok: true, ...data, error: data.allowed ? null : humanReason(data.reason) };
  } catch (error) {
    if (!hasExecutionDeadline && !retried && (error.status === 401 || error.status === 403)) {
      serverState = await syncServer({ forceBootstrap: true });
      if (serverState?.online && serverState?.sessionToken) {
        return requestTradePermit(payload, { retried: true });
      }
    }
    return { ok: false, allowed: false, reason: 'SERVER_ERROR', error: String(error?.message || error) };
  }
}

export async function consumeTradeExecutionTicket(ticket, options = {}) {
  const value = String(ticket || '').trim();
  if (value.length < 32) {
    return { ok: false, error: 'Сервер не выдал разрешение на исполнение сделки' };
  }

  let lastError = null;
  const executionDeadlineMs = Number(options?.executionDeadlineMs);
  const hasExecutionDeadline = Number.isFinite(executionDeadlineMs) && executionDeadlineMs > 0;
  const remainingMs = () => hasExecutionDeadline ? executionDeadlineMs - Date.now() : Infinity;
  const timeouts = [18000, 12000];
  for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
    if (hasExecutionDeadline && remainingMs() <= 4000) {
      return { ok: false, error: 'SIGNAL_EXPIRED: недостаточно времени для подтверждения разрешения' };
    }
    try {
      const timeoutMs = hasExecutionDeadline
        ? Math.max(3000, Math.min(timeouts[attempt], remainingMs() - 1000))
        : timeouts[attempt];
      const data = await api('/api/v1/trading/consume', {
        method: 'POST',
        body: JSON.stringify({ ticket: value }),
        timeoutMs
      });
      if (data?.ok !== true) {
        const detail = data?.detail ?? data?.error ?? data?.reason ?? 'TRADE_TICKET_REJECTED';
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300));
      }
      return { ok: true, permit: data };
    } catch (error) {
      lastError = error;
      const retryable = isTransientApiError(error);
      if (retryable && attempt + 1 < timeouts.length && (!hasExecutionDeadline || remainingMs() > 4500)) {
        await waitMs(250);
        continue;
      }
      if (retryable) {
        return { ok: false, error: 'TRADE_TICKET_TIMEOUT: сервер не подтвердил разрешение вовремя; сделка не открыта' };
      }
      return { ok: false, error: String(error?.message || error) };
    }
  }
  return { ok: false, error: String(lastError?.message || lastError || 'TRADE_TICKET_UNAVAILABLE') };
}

export async function reportTrade(payload) {
  const serverState = await readServerState();
  if (!serverState?.sessionToken) return { ok: false, skipped: true };
  try {
    const data = await api('/api/v1/trading/report', {
      method: 'POST',
      body: JSON.stringify(payload)
    }, serverState.sessionToken);
    if (data.entitlement) await saveServerStateForSession({ entitlement: data.entitlement, online: true, lastSyncAt: nowIso(), lastError: null }, serverState);
    return data;
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export async function getSignalSocketTicket() {
  await requireLegalConsent();
  let serverState = await readServerState();
  if (!serverState?.sessionToken) serverState = await syncServer({ forceBootstrap: false });
  if (!serverState?.online || !serverState?.sessionToken) throw new Error('Сервер сигналов недоступен');
  let data = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      data = await api('/api/v1/ws/ticket', { method: 'POST', body: '{}', timeoutMs: 15000 }, serverState.sessionToken);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !isTransientApiError(error)) throw error;
      const retryDelay = Math.max(Number(error?.retryAfterMs) || 0, attempt === 0 ? 650 : 1600);
      await waitMs(retryDelay);
    }
  }
  if (!data) throw lastError || new Error('Сервер не выдал билет WebSocket');
  if (!await serverSessionStillCurrent(serverState)) throw new Error('SERVER_ACCOUNT_CHANGED');
  // URL() для wss обрабатывается отдельно, поэтому проверяем явно.
  const rawWs = String(data.wsUrl || serverState.wsUrl || '');
  if (!rawWs.startsWith('wss://ws.pockettraderobot.online/')) throw new Error('Недопустимый адрес WebSocket');
  if (!data.ticket) throw new Error('Сервер не выдал одноразовый билет WebSocket');
  return { ticket: String(data.ticket), wsUrl: rawWs, expiresAt: data.expiresAt || null };
}

export async function deleteAccountData() {
  await requireLegalConsent();
  const serverState = await readServerState();
  if (!serverState?.sessionToken) throw new Error('Сначала подключите аккаунт');
  const result = await api('/api/v1/account/data', { method: 'DELETE' }, serverState.sessionToken);
  // Destructive privacy action: erase account-linked local state as well.
  // Remove only non-legal keys instead of clear()+restore(). The old two-step
  // sequence exposed a real interval with no consent/preference; another open
  // tab could observe it and recreate the six-item modal. Legal acknowledgement
  // and its explicit per-device display preference are not account-linked data.
  const allStored = await chrome.storage.local.get(null);
  const retainedKeys = new Set(LEGAL_PERSISTENT_STORAGE_KEYS);
  const accountLinkedKeys = Object.keys(allStored || {}).filter((key) => !retainedKeys.has(key));
  if (accountLinkedKeys.length) await chrome.storage.local.remove(accountLinkedKeys);
  return result;
}

const STRATEGY_GLOBAL_EXECUTION_FIELDS = Object.freeze([
  'amountMode','fixedAmount','amount','balancePercent',
  'duration','execution','expirationMode','expirationMultiplier','minPayout',
  'maxAmount','maxConcurrent','maxTrades','maxLossStreak','maxWinStreak',
  'takeProfit','stopLoss','onePerAsset','confidence','minConfidence',
  'martingale','recovery','recoveryConfig','recoveryDurationMode',
  'recoveryMode','recoveryValue','recoverySteps','recoveryPlan',
  'recoveryAfterMax','recoveryStartedAt','recoveryFollowSignal',
  'recoveryAllowConcurrent','recoveryScopeStrategyId','recoveryScopeAsset'
]);

function sanitizeCustomStrategyPayload(payload = {}) {
  const next = payload && typeof payload === 'object' ? { ...payload } : {};
  const config = next.config && typeof next.config === 'object' && !Array.isArray(next.config) ? { ...next.config } : {};
  const legacyExecution = config.execution && typeof config.execution === 'object' && !Array.isArray(config.execution) ? config.execution : {};
  if (config.expiration == null) {
    const rawExpiration = config.duration ?? legacyExecution.duration ?? legacyExecution.expiration;
    const parsedExpiration = Number(rawExpiration);
    if (Number.isFinite(parsedExpiration) && parsedExpiration > 0) config.expiration = Math.max(1, Math.min(86400, Math.round(parsedExpiration)));
  }
  if (config.cooldown == null && Number.isFinite(Number(legacyExecution.cooldown))) config.cooldown = Math.max(0, Number(legacyExecution.cooldown));
  for (const key of STRATEGY_GLOBAL_EXECUTION_FIELDS) delete config[key];
  config.decisionMode = 'direction_only';
  next.config = config;
  return next;
}

export async function saveCustomStrategy(payload) {
  let serverState = await readServerState();
  if (!serverState?.sessionToken) serverState = await syncServer({ forceBootstrap: false });
  if (!serverState?.sessionToken) throw new Error('Сначала подключите аккаунт Pocket Option');
  const sanitizedPayload = sanitizeCustomStrategyPayload(payload);
  const data = await api('/api/v1/strategies/custom', {
    method: 'POST',
    body: JSON.stringify(sanitizedPayload)
  }, serverState.sessionToken);
  if (!await serverSessionStillCurrent(serverState)) throw new Error('SERVER_ACCOUNT_CHANGED');
  const next = await saveServerStateForSession({
    online: true,
    lastSyncAt: nowIso(),
    lastError: null,
    strategies: Array.isArray(data.strategies) ? data.strategies : serverState.strategies,
    deletedCustomStrategyIds: Array.isArray(data.deletedCustomStrategyIds)
      ? data.deletedCustomStrategyIds.map(String).filter(Boolean)
      : (serverState.deletedCustomStrategyIds || []).filter((id) => String(id) !== String(data?.strategy?.id || sanitizedPayload.id || ''))
  }, serverState);
  return { ...data, serverState: next };
}

function isCustomStrategyAlreadyMissing(error) {
  const status = Number(error?.status || 0);
  let payload = '';
  try { payload = JSON.stringify(error?.data || ''); } catch {}
  const text = `${String(error?.message || '')} ${payload}`.toLowerCase();
  return text.includes('custom_strategy_not_found')
    || text.includes('custom strategy not found')
    || text.includes('пользовательская стратегия не найдена')
    || (status === 404 && text.includes('strategy'));
}

export async function deleteCustomStrategy(strategyId) {
  const normalizedId = String(strategyId || '').trim();
  if (!normalizedId) throw new Error('custom_strategy_id_required');
  let serverState = await readServerState();
  if (!serverState?.sessionToken) serverState = await syncServer({ forceBootstrap: false });
  if (!serverState?.sessionToken) throw new Error('Сначала подключите аккаунт Pocket Option');

  let data;
  try {
    data = await api(`/api/v1/strategies/custom/${encodeURIComponent(normalizedId)}`, {
      method: 'DELETE'
    }, serverState.sessionToken);
  } catch (error) {
    // DELETE must be idempotent. If the record is already absent on the server,
    // the requested end state has already been reached. Continue with local
    // cleanup instead of trapping the user with an undeletable ghost card.
    if (!isCustomStrategyAlreadyMissing(error)) throw error;
    data = {
      deleted: true,
      alreadyMissing: true,
      strategyId: normalizedId,
      strategies: Array.isArray(serverState.strategies)
        ? serverState.strategies.filter((item) => String(item?.id || '') !== normalizedId)
        : serverState.strategies,
      deletedCustomStrategyIds: [...new Set([...(serverState.deletedCustomStrategyIds || []).map(String), normalizedId])]
    };
  }

  const nextStrategies = Array.isArray(data?.strategies)
    ? data.strategies
    : (Array.isArray(serverState.strategies)
      ? serverState.strategies.filter((item) => String(item?.id || '') !== normalizedId)
      : serverState.strategies);
  if (!await serverSessionStillCurrent(serverState)) throw new Error('SERVER_ACCOUNT_CHANGED');
  const next = await saveServerStateForSession({
    online: true,
    lastSyncAt: nowIso(),
    lastError: null,
    strategies: nextStrategies,
    deletedCustomStrategyIds: Array.isArray(data?.deletedCustomStrategyIds)
      ? data.deletedCustomStrategyIds.map(String).filter(Boolean)
      : [...new Set([...(serverState.deletedCustomStrategyIds || []).map(String), normalizedId])]
  }, serverState);
  return { ...data, deleted: true, strategyId: normalizedId, serverState: next };
}

export async function activateTrial() {
  let serverState = await syncServer({ forceBootstrap: true });
  if (!serverState?.sessionToken) throw new Error('Сначала подключите аккаунт Pocket Option');
  const data = await api('/api/v1/trial/activate', { method: 'POST', body: '{}' }, serverState.sessionToken);
  if (!await serverSessionStillCurrent(serverState)) throw new Error('SERVER_ACCOUNT_CHANGED');
  serverState = await saveServerStateForSession({
    online: true,
    lastSyncAt: nowIso(),
    lastError: null,
    entitlement: normalizeEntitlementLimits(data.entitlement || serverState.entitlement)
  }, serverState);
  return serverState;
}

export async function checkRelease() {
  let serverState = await readServerState();
  if (!serverState?.sessionToken) serverState = await syncServer({ forceBootstrap: false });
  if (!serverState?.sessionToken) return serverState?.release || null;
  try {
    const release = await api('/api/v1/releases/current', { method: 'GET' }, serverState.sessionToken);
    await saveServerStateForSession({ release, online: true, lastSyncAt: nowIso(), lastError: null }, serverState);
    return release;
  } catch {
    return serverState?.release || null;
  }
}

export async function openSupport() {
  return openSafeUrl(SUPPORT_URL, ['t.me']);
}

export async function openAffiliate() {
  await requireLegalConsent();
  const state = await readServerState();
  const url = state?.entitlement?.affiliate?.registrationUrl;
  // Do not reopen a pre-rebrand registration URL cached in ptServerState. This
  // generic CTA can safely use the current campaign; the staged public flow below
  // still requires a fresh server-issued clickId.
  return openSafeUrl(
    isCurrentAffiliateRegistrationUrl(url) ? url : CURRENT_AFFILIATE_REGISTRATION_URL,
    ['u3.shortink.io']
  );
}

const AFFILIATE_PREPARED_KEY = 'ptAffiliatePrepared';

export async function getPreparedAffiliatePublic() {
  const stored = await chrome.storage.local.get(AFFILIATE_PREPARED_KEY);
  const prepared = stored?.[AFFILIATE_PREPARED_KEY];
  const clickId = String(prepared?.clickId || '');
  const registrationUrl = String(prepared?.registrationUrl || '');
  if (clickId.length < 20 || !isCurrentAffiliateRegistrationUrl(registrationUrl)) {
    if (prepared) await chrome.storage.local.remove(AFFILIATE_PREPARED_KEY);
    return null;
  }
  return {
    clickId,
    registrationUrl,
    generatedAt: prepared?.generatedAt || null,
    locale: prepared?.locale || 'ru'
  };
}

export async function generateAffiliatePublic(locale = 'ru') {
  await requireLegalConsent();
  const affiliateIdentity = await ensureAffiliateIdentity();
  const normalizedLocale = locale === 'en' ? 'en' : 'ru';
  const data = await api('/api/v1/public/affiliate-link', {
    method: 'POST',
    body: JSON.stringify({
      clickId: affiliateIdentity.clickId,
      locale: normalizedLocale,
      version: EXTENSION_VERSION
    })
  });
  const registrationUrl = String(data?.registrationUrl || '');
  if (!registrationUrl) throw new Error('Партнёрская ссылка ещё не настроена на сервере');
  if (!isCurrentAffiliateRegistrationUrl(registrationUrl)) {
    await chrome.storage.local.remove(AFFILIATE_PREPARED_KEY).catch(() => null);
    throw new Error('Сервер вернул устаревшую партнёрскую ссылку. Обновите статус и сгенерируйте ссылку ещё раз.');
  }
  const prepared = {
    clickId: affiliateIdentity.clickId,
    registrationUrl,
    generatedAt: nowIso(),
    locale: normalizedLocale
  };
  await chrome.storage.local.set({ [AFFILIATE_PREPARED_KEY]: prepared });
  return { ok: true, ...prepared };
}

export async function openPreparedAffiliatePublic() {
  await requireLegalConsent();
  const prepared = await getPreparedAffiliatePublic();
  if (!prepared?.registrationUrl) throw new Error('Сначала примите 5 условий и сгенерируйте партнёрскую ссылку');
  await openSafeUrl(prepared.registrationUrl, ['u3.shortink.io']);
  return { ok: true, ...prepared };
}

export async function openAffiliatePublic(locale = 'ru') {
  // Compatibility path: prepare only. Opening is allowed only via the explicit staged action.
  return generateAffiliatePublic(locale);
}

export async function openAdmin() {
  return openSafeUrl(ADMIN_URL, ['admin.pockettraderobot.online']);
}

export async function openUpdate() {
  const state = await readServerState();
  const url = state?.release?.updateUrl;
  if (!url) throw new Error('Ссылка на обновление ещё не опубликована');
  return openSafeUrl(url);
}

export function humanReason(reason) {
  const labels = {
    DAILY_TRADE_LIMIT: 'Лимит FREE: 50 сделок в сутки на DEMO. Внесите депозит от $10 для полного Premium без тарифного лимита.',
    REGISTRATION_REQUIRED: 'TRIAL Premium завершён. Зарегистрируйте новый аккаунт Pocket Option по партнёрской ссылке Pocket TRADE ROBOT, чтобы продолжить торговлю.',
    REAL_TRADING_REQUIRES_DEPOSIT: 'REAL-торговля станет доступна после подтверждённого депозита от $10. До этого используйте DEMO-счёт.',
    ACCOUNT_BLOCKED: 'Доступ для этого UID заблокирован',
    SERVER_OFFLINE: 'Сервер лицензий недоступен',
    DUPLICATE_REQUEST: 'Эта торговая команда уже была обработана',
    LEGAL_CONSENT_REQUIRED: 'Сначала примите условия и предупреждение о рисках',
    STRATEGY_PROFILE_MISMATCH: 'Выбранные TF анализа и экспирация несовместимы с профилем стратегии или недоступны для текущего актива.',
    asset_limit_reached: 'Достигнут лимит активов текущей конфигурации'
  };
  return labels[reason] || String(reason || 'Операция запрещена сервером');
}

export function compareVersions(left, right) {
  const a = String(left || '0').split('.').map((v) => Number(v) || 0);
  const b = String(right || '0').split('.').map((v) => Number(v) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return 1;
    if ((a[i] || 0) < (b[i] || 0)) return -1;
  }
  return 0;
}

export async function initializeServerClient() {
  if (initializeServerClientInFlight) return initializeServerClientInFlight;
  initializeServerClientInFlight = (async () => {
    chrome.alarms.create('pt-server-sync', { periodInMinutes: 2 });
    chrome.alarms.create('pt-release-check', { periodInMinutes: 30 });
    // Отдельный watchdog будит Manifest V3 service worker и восстанавливает
    // сигнальный канал после его выгрузки браузером или длительного простоя.
    chrome.alarms.create('pt-signal-watchdog', { periodInMinutes: 1 });

    // Persist the v2/canonical form immediately on every worker generation.
    // Merely normalizing a legacy v1 object in memory left old autorobot URLs
    // and an unbound token in diagnostics until the next successful POST.
    const stored = await chrome.storage.local.get(['ptServerState', 'poBridgeState']).catch(() => ({}));
    const raw = stored.ptServerState;
    const normalized = normalizeStoredServerState(raw);
    const needsMigration = Boolean(raw && normalized && (
      Number(raw.version) !== 2
      || String(raw.clientBuild || '') !== SERVER_CLIENT_BUILD
      || String(raw.wsUrl || '') !== String(normalized.wsUrl || '')
      || String(raw.adminUrl || '') !== ADMIN_URL
      || String(raw.supportUrl || '') !== SUPPORT_URL
      || String(raw.sessionUid || '') !== String(normalized.sessionUid || '')
      || Boolean(raw.sessionToken) !== Boolean(normalized.sessionToken)
    ));
    if (needsMigration) {
      await chrome.storage.local.set({ ptServerState: normalized });
    }
    if (serverAccountContext(stored.poBridgeState || null)) {
      await bindServerAccountContext(stored.poBridgeState);
    }
    return normalized;
  })();
  try {
    return await initializeServerClientInFlight;
  } catch (error) {
    initializeServerClientInFlight = null;
    throw error;
  }
}







// ===================== Strategy Tester PRO v1.0.69 =====================
export async function getStrategyTesterConfig() {
  let serverState = await readServerState();
  if (!serverState?.sessionToken) serverState = await syncServer({ forceBootstrap: true }).catch(() => serverState);
  if (!serverState?.sessionToken) throw new Error('Сначала подключите аккаунт Pocket Option и серверную сессию');
  return api('/api/v1/strategy-tester/config', { method: 'GET', timeoutMs: 15000 }, serverState.sessionToken);
}

export async function runStrategyTester(payload = {}) {
  let serverState = await readServerState();
  if (!serverState?.sessionToken) serverState = await syncServer({ forceBootstrap: true }).catch(() => serverState);
  if (!serverState?.sessionToken) throw new Error('Сначала подключите аккаунт Pocket Option и серверную сессию');
  return api('/api/v1/strategy-tester/run', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
    // Large portfolio matrices can legitimately take many minutes. The UI keeps
    // showing elapsed time, so the extension must not abort a healthy server job.
    timeoutMs: 0,
    noTimeout: true
  }, serverState.sessionToken);
}

// ===================== Pocket TRADE ROBOT Remote Control v1.0.62 =====================
const REMOTE_CONTROL_URL = 'https://remote.pockettraderobot.online';
const REMOTE_API_BASE = 'https://remote.pockettraderobot.online';

async function remoteApi(path, options = {}, remoteContext = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (remoteContext.uid) headers.set('X-PT-Remote-UID', String(remoteContext.uid));
  if (remoteContext.installationId) headers.set('X-PT-Installation-ID', String(remoteContext.installationId));
  if (remoteContext.password) headers.set('X-PT-Remote-Password', String(remoteContext.password));
  const controller = new AbortController();
  const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 15000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort('PT_REMOTE_TIMEOUT'); } catch { controller.abort(); }
  }, timeoutMs);
  try {
    const response = await fetch(`${REMOTE_API_BASE}${path}`, {
      ...options,
      headers,
      cache: 'no-store',
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.detail || data.error || `REMOTE_HTTP_${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (timedOut || error?.name === 'AbortError') {
      const timeoutError = new Error(`REMOTE_TIMEOUT_${timeoutMs}MS`);
      timeoutError.code = 'REMOTE_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function remoteAuthContext(preferredUid = null) {
  const [remoteStored, serverState, identity] = await Promise.all([
    chrome.storage.local.get('ptRemoteControl'),
    readServerState(),
    ensureDeviceIdentity()
  ]);
  const remote = remoteStored.ptRemoteControl || {};
  const boundUid = String(remote.uid || '').trim();
  const serverUid = String(serverState?.pocketUid || '').trim();
  const payloadUid = String(preferredUid || '').trim();
  const mismatch = Boolean(
    (boundUid && serverUid && boundUid !== serverUid)
    || (boundUid && payloadUid && boundUid !== payloadUid)
    || (serverUid && payloadUid && serverUid !== payloadUid)
  );
  return {
    uid: mismatch ? null : (payloadUid || serverUid || boundUid || null),
    installationId: identity.installationId,
    password: remote.password || '',
    remote,
    serverState,
    identity,
    error: mismatch ? 'REMOTE_UID_MISMATCH' : null,
    boundUid: boundUid || null,
    serverUid: serverUid || null,
    payloadUid: payloadUid || null
  };
}


function remotePasswordCandidate() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
}

async function prepareRemotePassword({ rotate = false } = {}) {
  const stored = await chrome.storage.local.get('ptRemoteControl');
  const current = stored.ptRemoteControl || {};
  if (!rotate && current.password && String(current.password).length >= 12) {
    return { current, candidate: { ...current } };
  }
  return {
    current,
    candidate: {
      ...current,
      password: remotePasswordCandidate(),
      passwordGeneratedAt: nowIso(),
      enabled: Boolean(current.enabled),
      remoteUrl: REMOTE_CONTROL_URL
    }
  };
}

export async function getRemoteControlLocalState() {
  const [remoteStored, serverState, identity] = await Promise.all([
    chrome.storage.local.get('ptRemoteControl'),
    readServerState(),
    ensureDeviceIdentity()
  ]);
  const remote = remoteStored.ptRemoteControl || {};
  return {
    enabled: Boolean(remote.enabled),
    password: remote.password || '',
    passwordGeneratedAt: remote.passwordGeneratedAt || null,
    remoteUrl: REMOTE_CONTROL_URL,
    installationId: identity.installationId,
    uid: remote.uid || serverState?.pocketUid || null,
    serverOnline: Boolean(serverState?.online),
    entitlement: serverState?.entitlement || structuredClone(FREE_ENTITLEMENT),
    lastEnabledAt: remote.lastEnabledAt || null,
    lastServerProfile: remote.lastServerProfile || null,
    lastStatusPushAt: remote.lastStatusPushAt || null,
    lastStatusAckAt: remote.lastStatusAckAt || null,
    lastStatusErrorAt: remote.lastStatusErrorAt || null,
    lastError: remote.lastError || null
  };
}

export async function enableRemoteControl({ rotate = false } = {}) {
  // Remote Control must use a main-server token issued for the exact same
  // local installationId. A forced bootstrap repairs older uid-only tokens.
  const serverState = await syncServer({ forceBootstrap: true });
  const identity = await ensureDeviceIdentity();
  const uid = serverState?.pocketUid || null;
  if (!uid) throw new Error('Сначала подключите аккаунт Pocket Option');
  if (!serverState?.sessionToken) {
    throw new Error(serverState?.lastError || 'MAIN_SESSION_TOKEN_MISSING');
  }
  const entitlement = serverState?.entitlement || {};
  const remoteAllowed = Boolean(entitlement.premium || entitlement.remoteControl || entitlement.features?.remoteControl);
  if (!remoteAllowed) throw new Error('Remote Control доступен только в TRIAL, Premium или по отдельной подписке Remote Control.');

  const { current, candidate } = await prepareRemotePassword({ rotate });
  try {
    const data = await remoteApi('/api/v1/remote/enable', {
      method: 'POST',
      body: JSON.stringify({
        uid,
        installationId: identity.installationId,
        password: candidate.password,
        sessionToken: serverState.sessionToken,
        extensionVersion: EXTENSION_VERSION,
        entitlement: serverState?.entitlement || null,
        deviceName: navigator.userAgentData?.platform || navigator.platform || 'Chrome'
      }),
      timeoutMs: 15000
    }, { uid, installationId: identity.installationId, password: candidate.password });
    if (data?.ok !== true) throw new Error(data?.error || 'REMOTE_ENABLE_FAILED');

    const next = {
      ...candidate,
      enabled: true,
      uid: String(uid),
      installationId: identity.installationId,
      lastEnabledAt: nowIso(),
      lastError: null,
      lastServerProfile: data.profile || null,
      remoteUrl: data.remoteUrl || REMOTE_CONTROL_URL
    };
    // Persist a new password only after the Remote API confirms activation.
    await chrome.storage.local.set({ ptRemoteControl: next });
    return { ok: true, ...data, local: next };
  } catch (error) {
    const failed = {
      ...current,
      enabled: Boolean(current.enabled),
      lastError: String(error?.message || error),
      lastEnableAttemptAt: nowIso(),
      remoteUrl: current.remoteUrl || REMOTE_CONTROL_URL
    };
    await chrome.storage.local.set({ ptRemoteControl: failed });
    throw error;
  }
}

export async function disableRemoteControl() {
  const serverState = await readServerState();
  let warning = null;
  if (serverState?.sessionToken) {
    const ctx = await remoteAuthContext();
    try {
      const result = await remoteApi('/api/v1/remote/disable', { method: 'POST', body: '{}', timeoutMs: 12000 }, ctx);
      if (result?.ok !== true) throw new Error(result?.error || 'REMOTE_DISABLE_FAILED');
    } catch (error) {
      warning = String(error?.message || error);
    }
  }
  const stored = await chrome.storage.local.get('ptRemoteControl');
  const next = {
    ...(stored.ptRemoteControl || {}),
    enabled: false,
    disabledAt: nowIso(),
    lastError: warning
  };
  await chrome.storage.local.set({ ptRemoteControl: next });
  return { ok: true, local: next, warning };
}

export async function rotateRemoteControlPassword() {
  return enableRemoteControl({ rotate: true });
}

export async function pushRemoteControlStatus(payload) {
  const stored = await chrome.storage.local.get('ptRemoteControl');
  const current = stored.ptRemoteControl || {};
  if (!current.enabled) return { ok: true, skipped: true };
  // Do not disable Remote Control merely because the cached main-server state
  // is temporarily absent/offline after a service-worker restart. The Remote
  // server performs the authoritative entitlement check on every request.
  const payloadUid = payload?.account?.uid || null;
  const ctx = await remoteAuthContext(payloadUid);
  if (ctx.error) {
    const failed = { ...current, lastError: ctx.error, lastStatusErrorAt: nowIso() };
    await chrome.storage.local.set({ ptRemoteControl: failed });
    return { ok: false, skipped: true, error: ctx.error };
  }
  if (!ctx.uid || !ctx.password) {
    const failed = { ...current, lastError: 'remote_auth_missing', lastStatusErrorAt: nowIso() };
    await chrome.storage.local.set({ ptRemoteControl: failed });
    return { ok: false, skipped: true, error: 'remote_auth_missing' };
  }
  try {
    const result = await remoteApi('/api/v1/remote/status', {
      method: 'POST',
      body: JSON.stringify({ ...(payload || {}), uid: ctx.uid, installationId: ctx.installationId }),
      timeoutMs: 10000
    }, ctx);
    const pushedAt = nowIso();
    await chrome.storage.local.set({
      ptRemoteControl: {
        ...current,
        enabled: true,
        uid: String(ctx.uid),
        installationId: ctx.installationId,
        lastStatusPushAt: pushedAt,
        lastStatusAckAt: result?.updatedAt || pushedAt,
        lastStatusErrorAt: null,
        lastError: null
      }
    });
    return result;
  } catch (error) {
    const failedAt = nowIso();
    const message = String(error?.message || error);
    const accessRevoked = error?.status === 403 && /REMOTE_CONTROL_REQUIRES_PREMIUM_OR_MODULE/.test(message);
    await chrome.storage.local.set({
      ptRemoteControl: {
        ...current,
        enabled: accessRevoked ? false : true,
        uid: current.uid || ctx.uid || null,
        installationId: current.installationId || ctx.installationId,
        disabledAt: accessRevoked ? failedAt : current.disabledAt,
        lastStatusErrorAt: failedAt,
        lastError: message
      }
    });
    throw error;
  }
}

export async function getRemoteControlPendingCommands() {
  const stored = await chrome.storage.local.get('ptRemoteControl');
  if (!stored.ptRemoteControl?.enabled) return { ok: true, commands: [] };
  const ctx = await remoteAuthContext();
  if (ctx.error) return { ok: false, commands: [], error: ctx.error };
  if (!ctx.uid || !ctx.password) return { ok: false, commands: [], error: 'remote_auth_missing' };
  return remoteApi('/api/v1/remote/commands/pending', { method: 'GET', timeoutMs: 10000 }, ctx);
}

export async function ackRemoteControlCommand(commandId, payload) {
  const ctx = await remoteAuthContext();
  if (ctx.error) return { ok: false, skipped: true, error: ctx.error };
  if (!ctx.uid || !ctx.password) return { ok: false, skipped: true, error: 'remote_auth_missing' };
  return remoteApi(`/api/v1/remote/commands/${encodeURIComponent(commandId)}/ack`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
    timeoutMs: 10000
  }, ctx);
}

export async function openRemoteControl() {
  return openSafeUrl(REMOTE_CONTROL_URL, ['remote.pockettraderobot.online']);
}
