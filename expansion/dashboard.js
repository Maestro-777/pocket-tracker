'use strict';

const VERSION = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '2.0.50');
// Keep an internal build marker because the user intentionally keeps the public
// manifest version may stay unchanged while testing hotfix packages. It lets diagnostics
// distinguish the repaired runtime from an older archive with the same version.
const BUILD_ID = 'expansion-local-1.0.3-audit1';
const $ = (id) => document.getElementById(id);
const DASHBOARD_MESSAGE_TIMEOUT_MS = 12000;
const DASHBOARD_NETWORK_MESSAGE_TIMEOUTS = Object.freeze({
  PT_SERVER_SYNC: 85000,
  PT_ACTIVATE_TRIAL: 115000,
  PT_SAVE_CUSTOM_STRATEGY: 75000,
  PT_DELETE_CUSTOM_STRATEGY: 75000,
  PT_CHECK_UPDATE: 75000,
  PT_GENERATE_AFFILIATE_PUBLIC: 45000,
  PT_DELETE_ACCOUNT_DATA: 45000,
  PO_GET_ACCESS_STATE: 80000,
  PT_GET_REFERRAL_PROGRAM: 65000,
  PT_STRATEGY_TESTER_CONFIG: 65000
});
const DASHBOARD_RENDER_MIN_INTERVAL_MS = 750;
const DASHBOARD_HEARTBEAT_INTERVAL_MS = 5000;
const DASHBOARD_ERROR_LOG_LIMIT = 40;
const IS_EMBEDDED_TERMINAL = new URLSearchParams(location.search).get('terminal') === '1';

if (IS_EMBEDDED_TERMINAL) document.body.dataset.terminalEmbedded = 'true';
document.body.classList.add('premiumRegistrationChecking');

let dashboardHeartbeatTimer = null;
let dashboardRenderTimer = null;
let dashboardRenderQueued = false;
let dashboardLastRenderAt = 0;
let dashboardLastError = null;
let dashboardRefreshFailures = 0;
let dashboardRecoveryVisible = false;
let dashboardSelfRecoveryTimer = null;
let dashboardBridgeHealInFlight = false;
let premiumRegistrationAccessResolved = false;

function errorText(error) {
  if (!error) return 'Неизвестная ошибка';
  return String(error?.message || error?.reason || error).slice(0, 1000);
}

function dashboardNetworkMessageTimeout(message) {
  const type = String(message?.type || '');
  if (type === 'PT_GET_SERVER_STATE' && message?.sync === true) return 85000;
  return Number(DASHBOARD_NETWORK_MESSAGE_TIMEOUTS[type] || 0);
}

function dashboardRuntimeMessageTimeout(message, options = {}) {
  if (options.noTimeout === true || options.timeoutMs === 0) return 0;
  const requested = Number(options.timeoutMs);
  const explicit = Number.isFinite(requested) && requested > 0 ? requested : 0;
  return Math.max(DASHBOARD_MESSAGE_TIMEOUT_MS, explicit, dashboardNetworkMessageTimeout(message));
}


function isRuntimeOrBridgeGoneError(error) {
  if (error?.code === 'BACKGROUND_RESPONSE_TIMEOUT') return error?.networkBacked !== true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('receiving end does not exist')
    || message.includes('extension context invalidated')
    || message.includes('context invalidated')
    || message.includes('could not establish connection')
    || message.includes('tab_message_timeout')
    || message.includes('background_timeout');
}

function isTabMessageTimeoutError(error) {
  return /TAB_MESSAGE_TIMEOUT_\d+MS/i.test(errorText(error));
}

function scheduleDashboardSelfRecovery(reason = '') {
  if (dashboardSelfRecoveryTimer) return;
  try {
    const key = 'ptDashboardSelfRecoveryAt';
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Number.isFinite(last) && Date.now() - last < 90000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {}
  dashboardSelfRecoveryTimer = setTimeout(() => {
    try { location.reload(); } catch {}
  }, 1400);
}

async function healPocketBridge(reason = 'dashboard') {
  if (dashboardBridgeHealInFlight) return { ok: false, skipped: true, reason: 'heal_in_flight' };
  dashboardBridgeHealInFlight = true;
  try {
    if (!pocketTab?.id) await findPocketTab().catch(() => null);
    if (!pocketTab?.id) return { ok: false, error: 'pocket_tab_missing' };
    return await sendRuntimeMessageSafe({ type: 'PO_ENSURE_TAB_BRIDGE', tabId: pocketTab.id, reason }, { attempts: 1, timeoutMs: 32000 });
  } finally {
    dashboardBridgeHealInFlight = false;
  }
}


async function recordDashboardError(error, context = 'dashboard') {
  const entry = {
    context,
    message: errorText(error),
    code: String(error?.code || ''),
    operation: String(error?.operation || ''),
    timeoutMs: Number(error?.timeoutMs || 0),
    stack: String(error?.stack || '').slice(0, 5000),
    version: VERSION,
    url: location.href,
    visibility: document.visibilityState,
    createdAt: new Date().toISOString()
  };
  dashboardLastError = entry;
  try {
    const stored = await chrome.storage.local.get('ptDashboardErrorLog');
    const list = Array.isArray(stored.ptDashboardErrorLog) ? stored.ptDashboardErrorLog : [];
    list.push(entry);
    await chrome.storage.local.set({ ptDashboardErrorLog: list.slice(-DASHBOARD_ERROR_LOG_LIMIT) });
  } catch {
    // Диагностика не должна сама ломать интерфейс.
  }
  return entry;
}

function showDashboardRecovery(error, message = '', mode = 'standard') {
  dashboardRecoveryVisible = true;
  dashboardRecoveryMode = mode === 'runtime-mismatch' ? 'runtime-mismatch' : 'standard';
  document.body.dataset.uiHealth = 'degraded';
  const panel = $('uiRecovery');
  const messageNode = $('uiRecoveryMessage');
  const detailsNode = $('uiRecoveryDetails');
  const titleNode = panel?.querySelector('.uiRecoveryBody h3');
  const eyebrowNode = panel?.querySelector('.uiRecoveryBody .eyebrow');
  const retryButton = $('uiRecoveryRetry');
  const reloadButton = $('uiRecoveryReload');
  if (titleNode) titleNode.textContent = dashboardRecoveryMode === 'runtime-mismatch'
    ? 'Требуется перезапуск расширения'
    : 'Восстанавливаем большое окно';
  if (eyebrowNode) eyebrowNode.textContent = dashboardRecoveryMode === 'runtime-mismatch'
    ? 'Обновление торгового ядра'
    : 'Защита интерфейса';
  if (retryButton) retryButton.textContent = dashboardRecoveryMode === 'runtime-mismatch' ? 'Проверить снова' : 'Восстановить';
  if (reloadButton) reloadButton.textContent = dashboardRecoveryMode === 'runtime-mismatch' ? 'Перезапустить расширение' : 'Перезапустить окно';
  if (messageNode) messageNode.textContent = message || 'Торговое ядро продолжает работать отдельно. Панель повторно получает состояние.';
  if (detailsNode) detailsNode.textContent = error ? errorText(error) : '';
  if (panel) panel.hidden = false;
}

function hideDashboardRecovery() {
  dashboardRecoveryVisible = false;
  dashboardRecoveryMode = 'standard';
  document.body.dataset.uiHealth = 'ok';
  const panel = $('uiRecovery');
  if (panel) panel.hidden = true;
}

async function publishDashboardHeartbeat(status = 'ready') {
  try {
    await chrome.storage.session.set({
      ptDashboardHeartbeat: {
        status,
        version: VERSION,
        updatedAt: Date.now(),
        visibility: document.visibilityState,
        recoveryVisible: dashboardRecoveryVisible
      }
    });
  } catch {
    // Service worker может кратковременно перезапускаться.
  }
}

function startDashboardHeartbeat() {
  void publishDashboardHeartbeat('ready');
  clearInterval(dashboardHeartbeatTimer);
  clearInterval(trialCountdownTimer);
  trialCountdownTimer = null;
  dashboardHeartbeatTimer = setInterval(() => void publishDashboardHeartbeat('ready'), DASHBOARD_HEARTBEAT_INTERVAL_MS);
}

function sendRuntimeMessageOnce(message, timeoutMs = DASHBOARD_MESSAGE_TIMEOUT_MS) {
  if (timeoutMs === 0) return chrome.runtime.sendMessage(message);
  let timer = null;
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Фоновый процесс не ответил вовремя. Соединение восстанавливается автоматически.');
        error.code = 'BACKGROUND_RESPONSE_TIMEOUT';
        error.operation = String(message?.type || 'UNKNOWN');
        error.timeoutMs = timeoutMs;
        error.networkBacked = dashboardNetworkMessageTimeout(message) > 0;
        reject(error);
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function sendRuntimeMessageSafe(message, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 1);
  const noTimeout = options.timeoutMs === 0 || options.noTimeout === true;
  const timeoutMs = noTimeout ? 0 : Math.max(1000, Number(options.timeoutMs) || DASHBOARD_MESSAGE_TIMEOUT_MS);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sendRuntimeMessageOnce(message, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  if (isRuntimeOrBridgeGoneError(lastError)) scheduleDashboardSelfRecovery(lastError);
  throw lastError || new Error('BACKGROUND_UNAVAILABLE');
}


const LEGAL_CONSENT_FIELD_IDS = ['legalAdult', 'legalRisk', 'legalPocketOffer', 'legalTerms', 'legalPrivacy', 'legalAffiliate'];
const LEGAL_CONSENT_VERSION = 'local-v1';
const LEGAL_DISCLOSURE_PREFERENCE_KEY = 'ptLegalDisclosurePreference';
const LEGAL_DISCLOSURE_PREFERENCE_SCHEMA = 1;
let legalConsentAccepted = false;
let legalConsentBound = false;

function closeConsentLanguageMenu() {
  const menu = $('consentLanguageMenu');
  const trigger = $('consentLanguageTrigger');
  if (menu) menu.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
}

function legalConsentFields() {
  return LEGAL_CONSENT_FIELD_IDS.map((id) => $(id)).filter(Boolean);
}

function buildLegalConsentPayload() {
  return {
    adultConfirmed: Boolean($('legalAdult')?.checked),
    riskAccepted: Boolean($('legalRisk')?.checked),
    pocketOfferAccepted: Boolean($('legalPocketOffer')?.checked),
    termsAccepted: Boolean($('legalTerms')?.checked),
    privacyAccepted: Boolean($('legalPrivacy')?.checked),
    affiliateDisclosureAccepted: Boolean($('legalAffiliate')?.checked),
    language: window.PTI18n?.locale || 'ru'
  };
}

function isCurrentLegalConsent(consent) {
  return Boolean(
    consent?.accepted === true
    && consent?.version === LEGAL_CONSENT_VERSION
    && consent.adultConfirmed === true
    && consent.riskAccepted === true
    && consent.pocketOfferAccepted === true
    && consent.termsAccepted === true
    && consent.privacyAccepted === true
    && consent.affiliateDisclosureAccepted === true
  );
}

async function persistLegalConsentLocally(payload) {
  const previous = await chrome.storage.local.get([
    'ptLegalConsent',
    LEGAL_DISCLOSURE_PREFERENCE_KEY,
    'ptLegalDisclosureDontShowAgain'
  ]);
  const previousPreference = previous?.[LEGAL_DISCLOSURE_PREFERENCE_KEY];
  const dontShowAgain = typeof payload.dontShowAgain === 'boolean'
    ? payload.dontShowAgain
    : previousPreference?.schemaVersion === LEGAL_DISCLOSURE_PREFERENCE_SCHEMA
      ? previousPreference?.dontShowAgain === true
      : previous?.ptLegalConsent?.disclosureDontShowAgain === true || previous?.ptLegalDisclosureDontShowAgain === true;
  const acceptedAt = new Date().toISOString();
  const consent = {
    accepted: true,
    version: LEGAL_CONSENT_VERSION,
    acceptedAt,
    disclosureDontShowAgain: dontShowAgain,
    ...payload
  };
  if (!isCurrentLegalConsent(consent)) throw new Error('LEGAL_CONSENT_INCOMPLETE');
  const preference = {
    schemaVersion: LEGAL_DISCLOSURE_PREFERENCE_SCHEMA,
    dontShowAgain,
    consentVersion: LEGAL_CONSENT_VERSION,
    savedAt: acceptedAt
  };
  await chrome.storage.local.set({
    ptLegalConsent: consent,
    [LEGAL_DISCLOSURE_PREFERENCE_KEY]: preference
  });
  const stored = await chrome.storage.local.get(['ptLegalConsent', LEGAL_DISCLOSURE_PREFERENCE_KEY]);
  if (!isCurrentLegalConsent(stored?.ptLegalConsent)
    || stored?.[LEGAL_DISCLOSURE_PREFERENCE_KEY]?.schemaVersion !== LEGAL_DISCLOSURE_PREFERENCE_SCHEMA
    || stored?.[LEGAL_DISCLOSURE_PREFERENCE_KEY]?.dontShowAgain !== dontShowAgain) {
    throw new Error('LEGAL_CONSENT_LOCAL_SAVE_FAILED');
  }
  return stored.ptLegalConsent;
}

async function readLegalConsentLocally(attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const stored = await chrome.storage.local.get('ptLegalConsent');
      return { ok: true, consent: stored?.ptLegalConsent || null };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 60 * attempt));
    }
  }
  return { ok: false, consent: null, error: lastError };
}

function refreshLegalConsentControls() {
  const fields = legalConsentFields();
  const selected = fields.filter((field) => field.checked).length;
  const ready = fields.length === LEGAL_CONSENT_FIELD_IDS.length && selected === fields.length;
  const progress = $('legalConsentProgress');
  const button = $('acceptLegalConsent');
  const status = $('legalConsentStatus');
  const selectAll = $('legalSelectAll');
  if (progress) progress.textContent = `${selected}/${LEGAL_CONSENT_FIELD_IDS.length}`;
  if (button) button.disabled = !ready;
  if (selectAll) {
    selectAll.checked = ready;
    selectAll.indeterminate = selected > 0 && !ready;
    selectAll.setAttribute('aria-checked', selectAll.indeterminate ? 'mixed' : (ready ? 'true' : 'false'));
  }
  if (status) status.textContent = ready
    ? uiText('Все 6 обязательных пунктов отмечены.', 'All 6 required items are checked.')
    : uiText('Отметьте все обязательные пункты.', 'Select all required items.');
  return ready;
}

function setLegalConsentVisible(visible) {
  const modal = $('legalConsentModal');
  if (!modal) return;
  modal.hidden = !visible;
  document.body.classList.toggle('legalConsentOpen', visible);
  if (!visible) closeConsentLanguageMenu();
  if (visible) {
    window.PTI18n?.refresh?.();
    requestAnimationFrame(() => ($('legalSelectAll') || $('legalAdult') || $('acceptLegalConsent'))?.focus());
  }
}

function bindLegalConsentUi() {
  if (legalConsentBound) return;
  legalConsentBound = true;
  for (const field of legalConsentFields()) field.addEventListener('change', refreshLegalConsentControls);
  $('legalSelectAll')?.addEventListener('change', (event) => {
    const checked = Boolean(event.currentTarget.checked);
    for (const field of legalConsentFields()) field.checked = checked;
    refreshLegalConsentControls();
  });
  $('consentLanguageTrigger')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('consentLanguageMenu');
    const trigger = event.currentTarget;
    const opening = Boolean(menu?.hidden);
    if (menu) menu.hidden = !opening;
    trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (opening) menu?.querySelector('.languageChoice.active')?.focus();
  });
  $('consentLanguageMenu')?.querySelectorAll('[data-language-choice]').forEach((button) => button.addEventListener('click', () => closeConsentLanguageMenu()));
  document.addEventListener('click', (event) => {
    if (!$('consentLanguagePicker')?.contains(event.target)) closeConsentLanguageMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || $('consentLanguageMenu')?.hidden) return;
    closeConsentLanguageMenu();
    $('consentLanguageTrigger')?.focus();
  });
  $('acceptLegalConsent')?.addEventListener('click', async () => {
    if (!refreshLegalConsentControls()) return;
    const button = $('acceptLegalConsent');
    const status = $('legalConsentStatus');
    if (button) button.disabled = true;
    if (status) status.textContent = uiText('Сохраняем подтверждение…', 'Saving confirmation…');
    try {
      const payload = buildLegalConsentPayload();
      try {
        const response = await sendRuntimeMessageSafe({
          type: 'PT_ACCEPT_LEGAL_CONSENT',
          payload
        }, { attempts: 2, timeoutMs: 10000 });
        if (!response?.ok || !isCurrentLegalConsent(response?.consent)) throw new Error(response?.error || 'LEGAL_CONSENT_SAVE_FAILED');
      } catch {
        // Some MV3 service workers are still starting when the install screen is
        // confirmed. Consent is local state, so persist and verify it directly.
        await persistLegalConsentLocally(payload);
      }
      legalConsentAccepted = true;
      setLegalConsentVisible(false);
      toast(uiText('Условия подтверждены. Добро пожаловать!', 'Terms confirmed. Welcome!'), 'ok');
      void refreshState();
    } catch (error) {
      if (status) status.textContent = errorText(error);
      refreshLegalConsentControls();
    }
  });
}

async function initializeLegalConsentGate() {
  bindLegalConsentUi();
  const initialLocal = await readLegalConsentLocally();
  if (isCurrentLegalConsent(initialLocal.consent)) {
    legalConsentAccepted = true;
    setLegalConsentVisible(false);
    return true;
  }
  let runtimeError = null;
  try {
    const response = await sendRuntimeMessageSafe({ type: 'PT_GET_LEGAL_CONSENT' }, { attempts: 2, timeoutMs: 10000 });
    legalConsentAccepted = Boolean(response?.ok && response?.accepted && isCurrentLegalConsent(response?.consent));
    if (legalConsentAccepted) {
      setLegalConsentVisible(false);
      return true;
    }
  } catch (error) {
    runtimeError = error;
  }
  // A response can race another tab accepting the terms, and an error response
  // is not the same as a definitive negative. Re-read the durable local record
  // before deciding to display the modal.
  const latestLocal = await readLegalConsentLocally();
  legalConsentAccepted = isCurrentLegalConsent(latestLocal.consent);
  if (legalConsentAccepted) {
    setLegalConsentVisible(false);
    return true;
  }
  setLegalConsentVisible(true);
  refreshLegalConsentControls();
  if (runtimeError && !initialLocal.ok && !latestLocal.ok) {
    const status = $('legalConsentStatus');
    if (status) status.textContent = uiText('Не удалось проверить подтверждение условий.', 'Unable to verify the terms confirmation.');
  }
  return false;
}

function sendTabMessageOnce(tabId, message, timeoutMs = DASHBOARD_MESSAGE_TIMEOUT_MS) {
  let timer = null;
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TAB_MESSAGE_TIMEOUT_${timeoutMs}MS`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function safeRenderNow() {
  dashboardRenderQueued = false;
  dashboardLastRenderAt = Date.now();
  try {
    renderAll();
  } catch (error) {
    void recordDashboardError(error, 'renderAll');
    showDashboardRecovery(error, 'Не удалось обновить один из блоков панели. Автоторговля продолжает работать.');
  }
}

window.addEventListener('error', (event) => {
  const error = event.error || new Error(event.message || 'UI_ERROR');
  void recordDashboardError(error, 'window.error');
  const shell = document.querySelector('.appShell');
  if (!shell || shell.getClientRects().length === 0 || document.body.dataset.uiHealth === 'booting') {
    showDashboardRecovery(error, 'Интерфейс столкнулся с ошибкой и выполняет безопасное восстановление.');
  } else {
    toast('Ошибка одного из блоков записана в диагностику. Панель продолжает работу.', 'error');
    requestRender();
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error(errorText(event.reason));
  void recordDashboardError(error, 'unhandledrejection');
  const shell = document.querySelector('.appShell');
  if (!shell || shell.getClientRects().length === 0 || document.body.dataset.uiHealth === 'booting') {
    showDashboardRecovery(error, 'Фоновый запрос панели завершился ошибкой. Торговля не остановлена.');
  } else {
    toast('Временная ошибка запроса. Используются последние сохранённые данные.', 'error');
  }
});

document.addEventListener('click', (event) => {
  const id = event.target?.id;
  if (id === 'uiRecoveryClose') hideDashboardRecovery();
  if (id === 'uiRecoveryReload') {
    if (dashboardRecoveryMode === 'runtime-mismatch') void restartExtensionRuntimeSafely();
    else location.reload();
  }
  if (id === 'uiRecoveryCopy') void downloadDiagnostics().catch(() => null);
  if (id === 'uiRecoveryRetry') {
    if (runtimeCompatibility.mixed) showRuntimeMismatchRecovery();
    else hideDashboardRecovery();
    void (async () => {
      try {
        await loadStored();
        await healPocketBridge('manual_recovery').catch(() => null);
        inputsReady = false;
        await refreshState();
        if (runtimeCompatibility?.mixed) showRuntimeMismatchRecovery();
        else hideDashboardRecovery();
      } catch (error) {
        await recordDashboardError(error, 'manual-recovery');
        showDashboardRecovery(error, 'Повторное подключение пока не удалось. Можно перезапустить только окно — торговля продолжит работу.');
      }
    })();
  }
});

function normalizeCandleOffset(value, legacyMode = 'closed') {
  const number = Number(value);
  if ([0, -1, -2].includes(number)) return number;
  return legacyMode === 'current' ? 0 : -1;
}

function candleOffsetLabel(value) {
  const offset = normalizeCandleOffset(value);
  return offset === 0 ? '0 — текущая свеча' : offset === -2 ? '−2 — предыдущая закрытая' : '−1 — последняя закрытая';
}


const ALLOWED_EXPIRATION_SECONDS = Object.freeze([3, 5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 2700, 3600, 7200, 10800, 14400, 86400]);
const ALLOWED_ANALYSIS_PERIOD_SECONDS = Object.freeze([5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 14400, 86400]);
const FULL_MARKET_HISTORY_PERIODS = ALLOWED_ANALYSIS_PERIOD_SECONDS;


function normalizeAnalysisPeriodSeconds(value, fallback = 60) {
  const raw = Number(value);
  const base = Number.isFinite(raw) && raw > 0 ? raw : Number(fallback) || 60;
  const rounded = Math.round(base);
  if (ALLOWED_ANALYSIS_PERIOD_SECONDS.includes(rounded)) return rounded;
  const higher = ALLOWED_ANALYSIS_PERIOD_SECONDS.find((item) => item >= rounded);
  return higher || ALLOWED_ANALYSIS_PERIOD_SECONDS[ALLOWED_ANALYSIS_PERIOD_SECONDS.length - 1];
}

function normalizeExpirationSeconds(value, fallback = 60) {
  const raw = Number(value);
  const base = Number.isFinite(raw) && raw > 0 ? raw : Number(fallback) || 60;
  const rounded = Math.round(base);
  if (ALLOWED_EXPIRATION_SECONDS.includes(rounded)) return rounded;
  const higher = ALLOWED_EXPIRATION_SECONDS.find((item) => item >= rounded);
  return higher || ALLOWED_EXPIRATION_SECONDS[ALLOWED_EXPIRATION_SECONDS.length - 1];
}

const MIN_TRADE_PAYOUT = 75;

const DEFAULT_RECOVERY_PLAN = [
    { multiplier: 2, duration: 0, minPayout: MIN_TRADE_PAYOUT },
    { multiplier: 4, duration: 0, minPayout: MIN_TRADE_PAYOUT },
    { multiplier: 8, duration: 0, minPayout: MIN_TRADE_PAYOUT },
    { multiplier: 16, duration: 0, minPayout: MIN_TRADE_PAYOUT },
    { multiplier: 32, duration: 0, minPayout: MIN_TRADE_PAYOUT }
  ];

const MAX_RECOVERY_MULTIPLIER = 100;



function inferCustomStrategyExpiration(config = {}, name = '') {
  const explicit = Number(config?.expiration ?? config?.duration ?? config?.execution?.duration ?? config?.execution?.expiration);
  if (Number.isFinite(explicit) && explicit > 0) return normalizeExpirationSeconds(explicit, explicit);
  const label = String(name || config?.name || config?.title || '').toUpperCase();
  if (/EXP\s*30\s*SEC/.test(label)) return 30;
  const minuteMatch = label.match(/EXP\s*M(1|2|3|5|10|15|30)(?:\D|$)/);
  if (minuteMatch) return Number(minuteMatch[1]) * 60;
  const timeframe = Number(config?.timeframe);
  if (Number.isFinite(timeframe) && timeframe > 0) return normalizeExpirationSeconds(timeframe, timeframe);
  return 60;
}

function isThreeCandleStrategyConfig(config = {}, name = '') {
  const mode = String(config?.engineMode || config?.strategyEngine || '').toLowerCase();
  const label = String(name || config?.name || config?.title || '').toUpperCase();
  return ['three_candle_ema_position_v1', 'three_candle_ema9_medium_v2', 'three_candle_ema14_medium_v3'].includes(mode)
    || /^3CANDLE(?:\s|_|-)TRAND(?:\s|_|-)(?:M(?:1|2|3|5|10|15|30)|(?:5|10|15|30)S)(?:\s|_|-)(?:BUY|SELL)$/.test(label);
}

const CUSTOM_STRATEGY_MARTINGALE_FIELDS = Object.freeze([
  'martingale','recovery','recoveryConfig','recoveryDurationMode',
  'recoveryMode','recoveryValue','recoverySteps','recoveryPlan',
  'recoveryAfterMax','recoveryStartedAt','recoveryFollowSignal',
  'recoveryAllowConcurrent','recoveryScopeStrategyId','recoveryScopeAsset'
]);

function importedStrategyContainsMartingale(raw) {
  const candidates = [raw, raw?.config, raw?.data].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  return candidates.some((candidate) => CUSTOM_STRATEGY_MARTINGALE_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(candidate, key)));
}

function sanitizeCustomStrategyGlobalFields(config = {}) {
  const next = { ...plainObject(config) };
  const legacyExecution = plainObject(next.execution);
  if (next.expiration == null) {
    next.expiration = inferCustomStrategyExpiration(next, next.name || next.title || '');
  }
  if (next.cooldown == null && Number.isFinite(Number(legacyExecution.cooldown))) {
    next.cooldown = Math.max(0, Number(legacyExecution.cooldown));
  }
  for (const key of [
    'amountMode','fixedAmount','amount','balancePercent',
    'duration','execution','expirationMode','expirationMultiplier','minPayout',
    'maxAmount','maxConcurrent','maxTrades','maxLossStreak','maxWinStreak',
    'takeProfit','stopLoss','onePerAsset',
    ...CUSTOM_STRATEGY_MARTINGALE_FIELDS,
    'confidence','minConfidence'
  ]) delete next[key];
  next.decisionMode = 'direction_only';
  return next;
}

function migrateThreeCandleStrategyConfig(config = {}, name = '') {
  if (!isThreeCandleStrategyConfig(config, name)) return config;
  const label = String(name || config?.name || config?.title || '').toUpperCase();
  const direction = String(config?.direction || '').toLowerCase() === 'put' || /SELL/.test(label) ? 'put' : 'call';
  const relation = direction === 'put' ? 'below' : 'above';
  const candleDirection = direction === 'put' ? 'red' : 'green';
  const timeframe = normalizeAnalysisPeriodSeconds(config?.timeframe, 60);
  const expiration = inferCustomStrategyExpiration(config, name);
  const entryLabel = direction === 'put' ? 'SELL' : 'BUY';
  const positionLabel = direction === 'put' ? 'ниже' : 'выше';
  const colorLabel = direction === 'put' ? 'красные' : 'зелёные';
  const timeframeLabel = ({ 60: 'M1', 120: 'M2', 180: 'M3', 300: 'M5' })[timeframe] || `${timeframe}S`;
  const canonicalName = `3Candle Trand ${timeframeLabel} ${direction === 'put' ? 'Sell' : 'Buy'}`;
  const sequenceParams = {
    candles: Array.from({ length: 3 }, () => ({ direction: candleDirection, body: 'medium', relation: 'none' })),
    entry: direction,
    confirm: 'closed',
    label: `3 medium ${candleDirection} candles ${relation} EMA 14`,
    positionToEma: { count: 3, emaPeriod: 14, relation, scope: 'body' }
  };
  return {
    ...config,
    name: canonicalName,
    description: `Три подряд закрытые ${colorLabel} свечи со средним телом, расположенные реальным телом ${positionLabel} EMA 14 на текущем TF.`,
    logic: 'all',
    direction,
    timeframe,
    timeframeMode: 'fixed',
    candleOffset: -1,
    candleMode: 'closed',
    confirmations: 1,
    mtf: 'off',
    trendFilter: 'off',
    expirationMode: 'fixed',
    expiration,
    duration: expiration,
    engineMode: 'three_candle_ema14_medium_v3',
    threeCandleEma: {
      count: 3,
      currentEmaPeriod: 14,
      candlePosition: 'body',
      candleDirection,
      bodySize: 'medium',
      relation,
      mediumBodyMinRatio: 0.35,
      mediumBodyMaxRatio: 0.75
    },
    rules: [
      {
        indicator: 'candleSequence',
        indicatorLabel: 'Свечная последовательность',
        operator: 'signal',
        value: `3 ${colorLabel} средние свечи телом ${positionLabel} EMA 14 → ${entryLabel}`,
        period: 3,
        weight: 5,
        timeframe: 'current',
        params: JSON.stringify(sequenceParams),
        source: 'close',
        signalMode: direction === 'put' ? 'confirmSell' : 'confirmBuy',
        group: 'A'
      }
    ]
  };
}

function migrateCustomStrategyExpirationItem(item) {
  if (!item || typeof item !== 'object') return item;
  const config = item.config && typeof item.config === 'object' ? item.config : item;
  const expiration = inferCustomStrategyExpiration(config, item.name || item.title);
  const expirationConfig = { ...config, expirationMode: 'fixed', expiration, duration: expiration };
  const nextConfig = sanitizeCustomStrategyGlobalFields(
    migrateThreeCandleStrategyConfig(expirationConfig, item.name || item.title)
  );
  const isThreeCandle = isThreeCandleStrategyConfig(nextConfig, item.name || item.title || nextConfig.name);
  return item.config && typeof item.config === 'object'
    ? {
      ...item,
      ...(isThreeCandle ? { name: nextConfig.name, title: nextConfig.name, description: nextConfig.description } : {}),
      expirationMode: 'fixed',
      expiration: nextConfig.expiration,
        engineMode: nextConfig.engineMode,
        config: nextConfig
      }
    : nextConfig;
}

function migrateLegacyRecoveryPlanV4(plan, riskDefaultsVersion) {
  if (Number(riskDefaultsVersion || 0) >= 4 || !Array.isArray(plan) || plan.length < 5) return plan;
  const legacyDefault = [2, 4, 8, 16, 20].every((value, index) => Math.abs((Number(plan[index]?.multiplier) || 0) - value) < 0.0001);
  if (legacyDefault) plan[4] = { ...plan[4], multiplier: 32 };
  return plan;
}

function normalizeRecoveryPlan(rawPlan, legacy = {}) {
  const source = Array.isArray(rawPlan) ? rawPlan : [];
  const legacyMode = String(legacy.recoveryMode || 'off');
  const legacyValue = Math.max(1, Number(legacy.recoveryValue) || 2);
  return DEFAULT_RECOVERY_PLAN.map((fallback, index) => {
    const raw = source[index] && typeof source[index] === 'object' ? source[index] : {};
    let multiplier = Number(raw.multiplier);
    if (!Number.isFinite(multiplier) && legacyMode === 'multiplier') multiplier = Math.pow(legacyValue, index + 1);
    const rawMinPayout = Number(raw.minPayout);
    return {
      multiplier: Math.min(MAX_RECOVERY_MULTIPLIER, Math.max(1, Number.isFinite(multiplier) ? multiplier : fallback.multiplier)),
      duration: 0,
      // Each Martingale step keeps its own payout threshold, but execution can
      // never be configured below the global 75% safety floor.
      minPayout: Math.min(100, Math.max(MIN_TRADE_PAYOUT, Number.isFinite(rawMinPayout) ? rawMinPayout : fallback.minPayout))
    };
  });
}


const DEFAULT_AUTO = {
  enabled: false,
  strategyId: '',
  strategyIds: [],
  strategyMode: 'best',
  candleMode: 'closed',
  candleOffset: -1,
  amountMode: 'fixed',
  amount: 1,
  balancePercent: 1,
  maxAmount: 10,
  expirationMode: 'fixed',
  expirationMultiplier: 0,
  duration: 60,
  period: 60,
  strategyProfiles: {},
  profileSettingsVersion: 1,
  cooldown: 5,
  maxConcurrent: 1,
  minPayout: 75,
  direction: 'both',
  takeProfit: 0,
  stopLoss: 0,
  maxTrades: 0,
  maxLossStreak: 0,
  maxWinStreak: 0,
  recoveryMode: 'off',
  recoveryValue: 2,
  recoverySteps: 0,
  recoveryPlan: normalizeRecoveryPlan(null),
  recoveryAfterMax: 'stop',
  recoveryFollowSignal: false,
  recoveryStartedAt: null,
  onePerAsset: true,
  sessionStartedAt: null,
  riskDefaultsVersion: 7
};

const DEFAULT_SETTINGS = {
  createdAt: new Date().toISOString(),
  asset: 'EURUSD_otc',
  amount: 1,
  duration: 60,
  period: 60,
  confirmTrades: true,
  statusBarVisibilityVersion: 0,
  statusBarVisible: true,
  tradeResultNotifications: true,
  statusBarCompact: false,
  interfaceDensity: 'compact',
  statusBarPosition: null,
  profitResetMode: 'daily',
  currencyOverride: 'AUTO',
  accessTier: 'FREE',
  serverRequired: true,
  selectedAssets: ['EURUSD_otc'],
  activeStrategyId: '',
  activeBuiltInStrategy: '',
  autoTrade: { ...DEFAULT_AUTO },
  builderStrategies: []
};

const TAB_INFO = {
  account: ['Аккаунт Pocket Option', 'Подключение', 'Подключение аккаунта и проверка Premium-доступа.'],
  market: ['Рынок Pocket Option', 'Рынок и данные', 'Выберите активы: нужные графики и таймфреймы подключатся автоматически по стратегиям.'],
  trade: ['Pocket TRADE ROBOT Engine', 'Торговля', 'Автоматическая торговля по ближайшему направлению и защита капитала.'],
  strategies: ['Стратегии и конструктор', 'Стратегии', 'Готовые серверные режимы, собственные правила и сохранённые стратегии.'],
  tester: ['Strategy Tester PRO', 'Strategy Tester', 'Тест и калибровка всех стратегий под все доступные таймфреймы и экспирации.'],
  statistics: ['Журнал результатов', 'Статистика', 'Открытые и закрытые сделки, серии, Win Rate и финансовый результат.'],
  premium: ['Premium Pocket TRADE ROBOT', 'Получить Premium', 'Официальная регистрация, условия доступа и проверка активации.'],
  notifications: ['Центр событий', 'Уведомления', 'Доступ, подключение, стратегии, сделки и системные сообщения.'],
  contacts: ['Pocket TRADE ROBOT', 'Контакты', 'Официальный сайт, сообщества, почта и техническая поддержка.'],
  remote: ['Pocket TRADE ROBOT Remote Control', 'Remote Control', 'Удалённое управление расширением с телефона.'],
  settings: ['Параметры продукта', 'Настройки', 'Интерфейс, тариф, обновления и поддержка.']
};

TAB_INFO.referral = [
  'Pocket TRADE ROBOT Referral',
  'Реферальная программа',
  'Приглашения, подтверждённый прогресс и повторяемые Premium-награды.'
];

let referralProgramState = null;
let referralProgramLoading = false;
let referralRecoveryRouteActive = safeSessionGet('poActiveTab') === 'referral';

function isReferralRecoveryRouteActive() {
  return referralRecoveryRouteActive && (
    safeSessionGet('poActiveTab') === 'referral'
    || $('view-referral')?.classList.contains('active')
  );
}

const BUILT_IN_STRATEGIES = [
  { id: 'builtin-trend', title: 'Trend Fusion', icon: '↗', color: 'blue', description: 'EMA 9/21/50, ADX/DI, MACD, RSI, откат, старший период и уровни.', badge: 'TREND', implemented: true, engineReady: true },
  { id: 'builtin-smartflow', title: 'M1 SmartFlow 2–3M', icon: 'SF', color: 'green', description: 'M1-анализ с экспирацией 2–3 минуты: откат по тренду, liquidity trap, пробой+ретест и M5-фильтр.', badge: 'M1 2–3M', implemented: true, engineReady: true },
  { id: 'builtin-liquidity', title: 'M1 Liquidity Sniper 2M', icon: 'LS', color: 'gold', description: 'Premium M1-снайпер по ложному пробою: уровни, Bollinger/Keltner, RSI 7, тиковое подтверждение и строгий AntiNoise.', badge: 'SNIPER · PREMIUM', premium: true, implemented: true, engineReady: true },
  { id: 'builtin-otc', title: 'Impulse Breakout', icon: 'ϟ', color: 'violet', description: 'Пробой уровней 50 свечей, ATR, ускорение тиков, активность и защита от позднего входа.', badge: 'BREAKOUT', implemented: true, engineReady: true },
  { id: 'builtin-smart', title: 'Heiken Ashi Reversal', icon: 'HA', color: 'pink', description: 'Чистая Heiken Ashi стратегия без AI: Keltner 17/10×2, уровни 50 свечей, пробой/возврат и RSI.', badge: 'HEIKEN', implemented: true, engineReady: true },
  { id: 'builtin-pattern', title: 'Pattern Pulse Scalper 5s', icon: '▰', color: 'cyan', description: 'Частые входы по фигурам технического анализа, свечным паттернам, пробою/ретесту, тиковому ускорению и фильтру выплаты актива. Оптимально для OTC 5 секунд.', badge: 'PATTERN 5s', implemented: true, engineReady: true },
  { id: 'builtin-ai', title: 'Pocket TRADE ROBOT AI Analysis', icon: 'AI', color: 'gold', description: 'Отдельная AI-стратегия: LSTM при наличии обученной модели или многосигнальный ensemble по тренду, импульсу, уровням, волатильности и тикам.', badge: 'AI · PREMIUM', ai: true, premium: true, implemented: true, engineReady: true }
];

const TESTER_TIMEFRAMES = [
  [5, '5s'], [10, '10s'], [15, '15s'], [30, '30s'], [60, 'M1'], [120, 'M2'], [180, 'M3'], [300, 'M5'], [600, 'M10'], [900, 'M15'], [1800, 'M30'], [3600, '1H'], [14400, '4H'], [86400, 'D1']
];
const TESTER_EXPIRATIONS = [
  [3, '3s'], [5, '5s'], [10, '10s'], [15, '15s'], [30, '30s'], [60, '1m'], [120, '2m'], [180, '3m'], [300, '5m'], [600, '10m'], [900, '15m'], [1800, '30m'], [3600, '1H'], [14400, '4H'], [86400, 'D1']
];
const TESTER_HISTORY_MIN = 60;
const TESTER_HISTORY_MAX = 5000;
let testerHistoryRecords = {};
let testerHistorySignature = '';
let testerLastResult = null;
let testerInputsReady = false;
let testerServerCatalog = [];
let testerConfigLoading = false;
let testerSelectedAssets = new Set();
let testerAssetsExplicitlyCleared = false;
let testerAssetSearchQuery = '';
const TESTER_MAX_ASSETS = 10;
let testerStrategySearchQuery = '';
let testerBusy = false;
let testerBusyStartedAt = 0;
let testerBusyMessage = '';
let testerBusyTimer = null;

const INDICATORS = [
  ['price', 'Цена / свеча (OHLC)'],
  ['sma', 'SMA'],
  ['ema', 'EMA'],
  ['wma', 'WMA'],
  ['hma', 'Hull MA'],
  ['dema', 'DEMA'],
  ['tema', 'TEMA'],
  ['vwap', 'VWAP'],
  ['alligator', 'Alligator / Аллигатор'],
  ['rsi', 'RSI'],
  ['stochastic', 'Stochastic'],
  ['stochRsi', 'Stochastic RSI'],
  ['macd', 'MACD'],
  ['awesome', 'Awesome Oscillator'],
  ['momentum', 'Momentum'],
  ['roc', 'Rate of Change'],
  ['cci', 'CCI'],
  ['mfi', 'Money Flow Index'],
  ['williams', 'Williams %R'],
  ['adx', 'ADX / DI'],
  ['vortex', 'Vortex'],
  ['supertrend', 'Supertrend'],
  ['parabolicSar', 'Parabolic SAR'],
  ['ichimoku', 'Ichimoku'],
  ['bollinger', 'Bollinger Bands'],
  ['keltner', 'Keltner Channel'],
  ['heikenAshi', 'Heiken Ashi'],
  ['donchian', 'Donchian Channel'],
  ['atr', 'ATR / волатильность'],
  ['stddev', 'Standard Deviation'],
  ['obv', 'OBV'],
  ['volume', 'Объём / активность'],
  ['tickRate', 'Частота тиков'],
  ['tickAcceleration', 'Ускорение тиков'],
  ['support', 'Поддержка / сопротивление'],
  ['pivot', 'Pivot Points'],
  ['fractals', 'Fractals'],
  ['zigzag', 'ZigZag'],
  ['trendline', 'Трендовая линия'],
  ['breakout', 'Пробой уровня'],
  ['retest', 'Ретест уровня'],
  ['falseBreakout', 'Ложный пробой'],
  ['liquidity', 'Ликвидность / sweep'],
  ['orderBlock', 'Order Block'],
  ['priceAction', 'Price Action'],
  ['candlePattern', 'Свечной паттерн'],
  ['candleSequence', 'Свечная последовательность'],
  ['chartPattern', 'Графическая фигура'],
  ['doubleTopBottom', 'Double Top / Bottom'],
  ['headShoulders', 'Head & Shoulders'],
  ['triangleWedge', 'Triangle / Wedge'],
  ['flagPennant', 'Flag / Pennant'],
  ['channelPattern', 'Trend Channel'],
  ['cupHandle', 'Cup & Handle'],
  ['diamondPattern', 'Diamond'],
  ['marketRegime', 'Режим рынка'],
  ['payout', 'Мин. выплата актива'],
  ['mtfTrend', 'Тренд старшего таймфрейма'],
  ['aiScore', 'AI Score', true]
];

const BUILDER_HIDDEN_INDICATORS = new Set();
const BUILDER_OPERATOR_OPTIONS = {
  price: ['above','below','crossUp','crossDown','rising','falling'],
  ema: ['above','below','crossUp','crossDown','rising','falling'],
  sma: ['above','below','crossUp','crossDown','rising','falling'],
  wma: ['above','below','crossUp','crossDown','rising','falling'],
  hma: ['above','below','crossUp','crossDown','rising','falling'],
  dema: ['above','below','crossUp','crossDown','rising','falling'],
  tema: ['above','below','crossUp','crossDown','rising','falling'],
  vwap: ['above','below','crossUp','crossDown'],
  alligator: ['signal','crossUp','crossDown','rising','falling'],
  rsi: ['signal','above','below','turnsUp','turnsDown'],
  stochastic: ['signal','crossUp','crossDown','turnsUp','turnsDown'],
  stochRsi: ['signal','crossUp','crossDown','turnsUp','turnsDown'],
  macd: ['signal','above','below','crossUp','crossDown','rising','falling'],
  awesome: ['signal','above','below','rising','falling'],
  momentum: ['signal','above','below','rising','falling'],
  roc: ['signal','above','below','rising','falling'],
  cci: ['signal','above','below','turnsUp','turnsDown'],
  mfi: ['signal','above','below','turnsUp','turnsDown'],
  williams: ['signal','above','below','turnsUp','turnsDown'],
  adx: ['above','rising','falling','signal'],
  vortex: ['signal','crossUp','crossDown','rising','falling'],
  supertrend: ['signal','crossUp','crossDown','above','below'],
  parabolicSar: ['signal','crossUp','crossDown','above','below'],
  ichimoku: ['signal','crossUp','crossDown','above','below'],
  bollinger: ['signal','above','below'],
  keltner: ['signal','above','below'],
  donchian: ['signal','above','below'],
  atr: ['above','below','rising','falling'],
  stddev: ['above','below','rising','falling'],
  obv: ['signal','crossUp','crossDown','rising','falling'],
  volume: ['above','rising','signal'],
  tickRate: ['above','rising','signal'],
  tickAcceleration: ['above','rising','signal'],
  payout: ['above'],
  marketRegime: ['signal'],
  mtfTrend: ['signal','rising','falling'],
  aiScore: ['above','signal'],
  candleSequence: ['signal'],
  candlePattern: ['signal'],
  heikenAshi: ['signal'],
  priceAction: ['signal'],
  chartPattern: ['signal'],
  doubleTopBottom: ['signal'],
  headShoulders: ['signal'],
  triangleWedge: ['signal'],
  flagPennant: ['signal'],
  channelPattern: ['signal'],
  cupHandle: ['signal'],
  diamondPattern: ['signal'],
  support: ['signal','above','below'],
  pivot: ['signal','above','below'],
  fractals: ['signal'],
  zigzag: ['signal'],
  trendline: ['signal','above','below'],
  breakout: ['signal','above','below'],
  retest: ['signal'],
  falseBreakout: ['signal'],
  liquidity: ['signal'],
  orderBlock: ['signal']
};

const OPERATOR_LABELS = {
  above: 'выше',
  below: 'ниже',
  crossUp: 'пересекает вверх',
  crossDown: 'пересекает вниз',
  rising: 'растёт',
  falling: 'падает',
  turnsUp: 'разворачивается вверх',
  turnsDown: 'разворачивается вниз',
  between: 'в диапазоне',
  outside: 'вне диапазона',
  signal: 'даёт сигнал'
};

const RULE_SOURCES = Object.freeze(['close', 'open', 'high', 'low', 'hl2', 'ohlc4', 'ticks', 'payout']);
const RULE_SIGNAL_MODES = Object.freeze(['auto', 'confirmBuy', 'confirmSell', 'filterOnly', 'reversal']);
const RULE_SOURCE_LABELS = Object.freeze({
  close: 'Close',
  open: 'Open',
  high: 'High',
  low: 'Low',
  hl2: 'HL2',
  ohlc4: 'OHLC4',
  ticks: 'Ticks',
  payout: 'Выплата'
});
const RULE_SIGNAL_MODE_LABELS = Object.freeze({
  auto: 'Авто BUY/SELL',
  confirmBuy: 'Подтверждать BUY',
  confirmSell: 'Подтверждать SELL',
  filterOnly: 'Только фильтр',
  reversal: 'Разворотный сигнал'
});

function normalizeRuleSource(value) {
  const source = String(value || 'close');
  return RULE_SOURCES.includes(source) ? source : 'close';
}

function normalizeRuleSignalMode(value) {
  const mode = String(value || 'auto');
  return RULE_SIGNAL_MODES.includes(mode) ? mode : 'auto';
}

const PRESETS = {
  trend: {
    name: 'Trend + Pullback', logic: 'all', direction: 'both', confirmations: 2, mtf: '5x', regime: 'trend',
    timeframe: 60, expiration: 60, marketType: 'all', minPayout: 70, volatility: 'normal',
    rules: [
      { indicator: 'ema', operator: 'above', value: 'EMA 21', period: 9, weight: 2, timeframe: 'current' },
      { indicator: 'adx', operator: 'above', value: '22', period: 14, weight: 1, timeframe: 'current' },
      { indicator: 'priceAction', operator: 'signal', value: 'pullback', period: 5, weight: 2, timeframe: 'current' }
    ]
  },
  reversal: {
    name: 'RSI Reversal', logic: 'all', direction: 'both', confirmations: 2, mtf: '2x', regime: 'range',
    timeframe: 60, expiration: 60, marketType: 'all', minPayout: 70, volatility: 'normal',
    patterns: ['engulfing', 'pinbar'],
    rules: [
      { indicator: 'rsi', operator: 'signal', value: '30 / 70', period: 14, weight: 2, timeframe: 'current' },
      { indicator: 'bollinger', operator: 'signal', value: 'outer band', period: 20, weight: 2, timeframe: 'current' },
      { indicator: 'candlePattern', operator: 'signal', value: 'reversal', period: 3, weight: 1, timeframe: 'current' }
    ]
  },
  breakout: {
    name: 'Breakout PRO', logic: 'all', direction: 'both', confirmations: 3, mtf: '5x', regime: 'impulse',
    timeframe: 60, expiration: 60, marketType: 'all', minPayout: 75, volatility: 'expanding',
    patterns: ['breakoutRetest', 'liquiditySweep'],
    rules: [
      { indicator: 'support', operator: 'signal', value: 'breakout + retest', period: 30, weight: 3, timeframe: 'current' },
      { indicator: 'atr', operator: 'rising', value: 'volatility', period: 14, weight: 1, timeframe: 'current' },
      { indicator: 'tickAcceleration', operator: 'signal', value: 'impulse', period: 20, weight: 2, timeframe: 'current' }
    ]
  },
  otc: {
    name: 'OTC Fast', logic: 'score', direction: 'both', confirmations: 2, mtf: '2x', regime: 'any',
    timeframe: 15, expiration: 30, marketType: 'otc', minPayout: 70, volatility: 'any',
    rules: [
      { indicator: 'ema', operator: 'crossUp', value: 'EMA 13', period: 5, weight: 2, timeframe: 'current' },
      { indicator: 'rsi', operator: 'signal', value: '45 / 55', period: 7, weight: 1, timeframe: 'current' },
      { indicator: 'candlePattern', operator: 'signal', value: 'impulse', period: 3, weight: 2, timeframe: 'current' }
    ]
  },
  impulse: {
    name: 'Impulse Hunter', logic: 'score', direction: 'both', confirmations: 3, mtf: '2x', regime: 'impulse',
    timeframe: 5, expiration: 15, marketType: 'all', minPayout: 75, volatility: 'expanding',
    patterns: ['marubozu'],
    rules: [
      { indicator: 'tickAcceleration', operator: 'above', value: '1.8x average', period: 30, weight: 3, timeframe: 'current' },
      { indicator: 'atr', operator: 'rising', value: 'ATR expansion', period: 14, weight: 2, timeframe: 'current' },
      { indicator: 'ema', operator: 'above', value: 'EMA 21', period: 9, weight: 1, timeframe: 'current' }
    ]
  },
  heiken: {
    name: 'Heiken Keltner Matrix', logic: 'all', direction: 'both', confirmations: 3, mtf: '2x', regime: 'any',
    timeframe: 15, expiration: 30, expirationMultiplier: 0, marketType: 'all', minPayout: 75, volatility: 'normal',
    patterns: ['heikenReversal'],
    rules: [
      { indicator: 'keltner', operator: 'signal', value: 'EMA 17 / ATR 10 / x2', period: 17, weight: 3, timeframe: 'current' },
      { indicator: 'heikenAshi', operator: 'signal', value: 'подтверждённый разворот', period: 2, weight: 3, timeframe: 'current' },
      { indicator: 'support', operator: 'signal', value: 'уровни последних 50 свечей', period: 50, weight: 2, timeframe: 'current' },
      { indicator: 'breakout', operator: 'signal', value: 'пробой или возврат', period: 50, weight: 2, timeframe: 'current' }
    ]
  },
  patternScalper: {
    name: 'Pattern Pulse Scalper 5s', logic: 'score', direction: 'both', confirmations: 2, mtf: '2x', regime: 'any',
    timeframe: 5, candleOffset: 0, expiration: 5, marketType: 'otc', minPayout: 75, volatility: 'normal', tickAcceleration: 'confirm',
    patterns: ['pinbar', 'engulfing', 'doubleTop', 'doubleBottom', 'triangle', 'flagPennant', 'breakoutRetest', 'falseBreakout', 'liquiditySweep'],
    patternSettings: { searchMode: 'soft', lookback: 100, touches: 2, tolerance: 25, confirmation: 'any', strength: 58, freshOnly: true, role: 'confirm' },
    rules: [
      { indicator: 'chartPattern', operator: 'signal', value: 'auto figure', period: 100, weight: 3, timeframe: 'current', params: 'lookback=100, tolerance=25, confirmation=any' },
      { indicator: 'candlePattern', operator: 'signal', value: 'reversal / continuation', period: 3, weight: 2, timeframe: 'current', params: 'pinbar=true, engulfing=true, dojiFilter=true' },
      { indicator: 'tickAcceleration', operator: 'above', value: '1.2x', period: 10, weight: 2, timeframe: 'current', params: 'window=10, multiplier=1.2' },
      { indicator: 'payout', operator: 'above', value: '75', period: 1, weight: 1, timeframe: 'current', params: 'min=75' }
    ]
  },
  levels: {
    name: 'Levels + Retest', logic: 'all', direction: 'both', confirmations: 3, mtf: '5x', regime: 'any',
    timeframe: 300, expiration: 300, marketType: 'live', minPayout: 75, volatility: 'normal',
    patterns: ['breakoutRetest', 'falseBreakout'],
    rules: [
      { indicator: 'support', operator: 'signal', value: 'level within 0.15 ATR', period: 100, weight: 3, timeframe: 'current' },
      { indicator: 'retest', operator: 'signal', value: 'confirmed retest', period: 20, weight: 3, timeframe: 'current' },
      { indicator: 'mtfTrend', operator: 'signal', value: 'aligned', period: 1, weight: 2, timeframe: '5x' }
    ]
  }
};

let settings = mergeSettings(DEFAULT_SETTINGS, {});
let state = null;
let profitStats = null;
let access = { tier: 'FREE', premium: false, limits: { maxAssets: 30, maxDailyTrades: 50, aiEnabled: false }, usage: { tradeCount: 0, dayKey: '' } };
let ledger = { closedDeals: [], openDeals: [], summary: {}, today: {} };
let autoStatus = null;
let serverState = null;
let runtimeInfo = null;
let runtimeCompatibility = { status: 'unknown', mixed: false, reason: null };
let dashboardRecoveryMode = 'standard';
let runtimeReloadBusy = false;
let signalDiagnostics = null;
let pocketPartnersStatus = { settings: {}, state: {} };
let premiumAffiliatePrepared = null;
let strategyCalibration = { version: 1, processedDealIds: [], profiles: {} };
let accessNotification = null;
let pocketTab = null;
let selectedAssets = new Set();
const collapsedAssetCategories = new Set();
const FREE_MAX_ASSETS = 30;
const PREMIUM_ACCESS_CACHE_GRACE_MS = 15 * 60 * 1000;

function normalizeAccessLimitsForUi(value) {
  const next = value && typeof value === 'object' ? { ...value } : {};
  next.limits = next.limits && typeof next.limits === 'object' ? { ...next.limits } : {};
  const premium = Boolean(next.premium || String(next.tier || '').toUpperCase() === 'PREMIUM');
  if (!premium) {
    const rawMax = Number(next.limits.maxAssets);
    next.limits.maxAssets = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(FREE_MAX_ASSETS, Math.floor(rawMax)) : FREE_MAX_ASSETS;
  }
  return next;
}

function accessStateRevisionMs(value) {
  if (!value || typeof value !== 'object') return 0;
  return Math.max(
    Number.isFinite(Date.parse(value.updatedAt || '')) ? Date.parse(value.updatedAt) : 0,
    Number.isFinite(Date.parse(value.lastSyncAt || '')) ? Date.parse(value.lastSyncAt) : 0,
    Number.isFinite(Date.parse(value.entitlement?.serverTime || '')) ? Date.parse(value.entitlement.serverTime) : 0
  );
}

function serverEntitlementTrustedForUi(value) {
  const entitlement = value?.entitlement;
  if (!entitlement || typeof entitlement !== 'object') return false;
  const status = String(entitlement.status || 'active').toLowerCase();
  const accessState = String(entitlement.accessState || '').toUpperCase();
  // Restrictive updates are always safe to apply immediately. Premium updates
  // must match the same short cache window used by server-client.js and retain
  // an authenticated session, so a stale storage snapshot cannot unlock UI.
  if (!entitlement.premium || status === 'blocked' || status === 'paused' || accessState === 'BLOCKED' || accessState === 'PREMIUM_PAUSED') return true;
  const lastSyncAt = Date.parse(value.lastSyncAt || '');
  return Boolean(value.sessionToken
    && Number.isFinite(lastSyncAt)
    && Date.now() - lastSyncAt >= 0
    && Date.now() - lastSyncAt <= PREMIUM_ACCESS_CACHE_GRACE_MS);
}

function reconcileAccessWithServerState(currentAccess, nextServerState) {
  if (!nextServerState?.entitlement || !serverEntitlementTrustedForUi(nextServerState)) return currentAccess;
  const currentSnapshot = currentAccess?.serverState;
  if (currentSnapshot && accessStateRevisionMs(nextServerState) < accessStateRevisionMs(currentSnapshot)) return currentAccess;
  const entitlement = nextServerState.entitlement;
  const premium = Boolean(entitlement.premium || String(entitlement.plan || '').toUpperCase() === 'PREMIUM');
  const features = entitlement.features && typeof entitlement.features === 'object' ? entitlement.features : {};
  const entitlementLimits = entitlement.limits && typeof entitlement.limits === 'object' ? entitlement.limits : {};
  return normalizeAccessLimitsForUi({
    ...(currentAccess || {}),
    tier: premium ? 'PREMIUM' : 'FREE',
    premium,
    status: entitlement.status || 'active',
    source: entitlement.source || (premium ? 'premium' : 'free'),
    pauseReason: entitlement.pauseReason || null,
    expiresAt: entitlement.expiresAt || null,
    accessState: entitlement.accessState || null,
    registrationRequired: Boolean(entitlement.registrationRequired),
    realTradingAllowed: Boolean(features.realTrading ?? entitlement.realTradingAllowed ?? premium),
    entitlement,
    serverOnline: Boolean(nextServerState.online),
    serverState: nextServerState,
    limits: {
      ...(currentAccess?.limits || {}),
      ...entitlementLimits,
      aiEnabled: Boolean(features.ai ?? premium),
      strategyBuilder: Boolean(features.strategyBuilder ?? premium),
      autoTrading: features.autoTrading !== false,
      realTrading: Boolean(features.realTrading ?? entitlement.realTradingAllowed ?? premium),
      basicStrategies: features.basicStrategies !== false
    }
  });
}

function currentEntitlement() {
  return access?.entitlement || serverState?.entitlement || {};
}

function isLocalExpansionMode() {
  return serverState?.localOnly === true || String(currentEntitlement()?.source || '').toLowerCase() === 'local';
}

let builderRules = [];
let editingStrategyId = null;
let pendingConfirmation = null;
let pollTimer = null;
let trialCountdownTimer = null;
let trialClockAnchor = null;
let trialExpirySyncAt = 0;
let refreshBusy = false;
let inputsReady = false;
let renderDeferred = false;
let lastTradeClickAt = 0;
let accountConnectionBusy = false;
let manualTradeBusy = false;
let serverSyncBusy = false;
let trialActivationBusy = false;
let notificationHistory = [];
let autoCompatibilityNotice = null;
let focusedAutoProfileStrategyId = null;
let transferHistory = [];
let pendingStrategyImport = null;
function mergeSettings(base, value) {
  const incoming = value && typeof value === 'object' ? value : {};
  const auto = { ...base.autoTrade, ...(incoming.autoTrade || {}) };
  auto.decisionMode = 'direction_only';
  delete auto.minConfidence;
  const riskDefaultsVersion = Number(auto.riskDefaultsVersion || 0);
  if (riskDefaultsVersion < 2) {
    if (Number(auto.maxTrades) === 10) auto.maxTrades = 0;
    if (Number(auto.maxLossStreak) === 3) auto.maxLossStreak = 0;
  }
  const legacyRecoveryMode = String(auto.recoveryMode || 'off');
  auto.recoveryPlan = migrateLegacyRecoveryPlanV4(normalizeRecoveryPlan(auto.recoveryPlan, auto), riskDefaultsVersion);
  auto.recoverySteps = Math.min(5, Math.max(0, Number(auto.recoverySteps) || 0));
  auto.recoveryMode = auto.recoverySteps > 0 && ['steps','multiplier','custom','martingale'].includes(legacyRecoveryMode) ? 'steps' : 'off';
  // Старый fixedStep невозможно безопасно перенести без знания базовой суммы.
  if (riskDefaultsVersion < 3 && legacyRecoveryMode === 'fixedStep') auto.recoveryMode = 'off';
  auto.recoveryAfterMax = auto.recoveryAfterMax === 'reset' ? 'reset' : 'stop';
  // v1.0.80 defaults: one visible step and follow-signal disabled. Migrate the
  // previous UI defaults once so an update does not keep showing 3 steps / ON.
  if (riskDefaultsVersion < 7) {
    // Preserve the existing global step count and multipliers; only migrate the
    // old follow-signal default to OFF.
    auto.recoveryFollowSignal = false;
  } else {
    auto.recoveryFollowSignal = auto.recoveryFollowSignal === true;
  }
  if (auto.recoveryMode === 'steps') {
    const recoveryStarted = Date.parse(auto.recoveryStartedAt || '');
    const sessionStarted = Date.parse(auto.sessionStartedAt || '');
    if (!Number.isFinite(recoveryStarted)) auto.recoveryStartedAt = Number.isFinite(sessionStarted) ? new Date(sessionStarted).toISOString() : new Date().toISOString();
  } else {
    auto.recoveryStartedAt = null;
  }
  auto.maxWinStreak = 0;
  auto.minPayout = MIN_TRADE_PAYOUT;
  auto.recoveryPlan = normalizeRecoveryPlan(auto.recoveryPlan, auto);
  auto.riskDefaultsVersion = 7;
  // v1.0.56: execution expiration is fixed by default; legacy 'strategy' mode is migrated to fixed.
  auto.expirationMode = auto.expirationMode === 'multiplier' ? 'multiplier' : 'fixed';
  auto.expirationMultiplier = Math.min(10, Math.max(0, Number(auto.expirationMultiplier) || 0));
  auto.duration = normalizeExpirationSeconds(auto.duration, 60);
  auto.period = normalizeAnalysisPeriodSeconds(auto.period, 60);
  auto.maxConcurrent = Math.min(20, Math.max(1, Number(auto.maxConcurrent) || 1));
  auto.strategyProfiles = normalizeStoredStrategyProfiles(auto.strategyProfiles, auto);
  auto.profileSettingsVersion = 1;
  auto.minPayout = MIN_TRADE_PAYOUT;
  if (auto.enabled && !Number.isFinite(Date.parse(auto.sessionStartedAt || ''))) auto.sessionStartedAt = new Date().toISOString();
  if (!auto.enabled) auto.sessionStartedAt = null;
  let strategyIds = Array.isArray(auto.strategyIds) ? auto.strategyIds.filter(Boolean).map(String) : [];
  if (!strategyIds.length && auto.strategyId) strategyIds.push(String(auto.strategyId));
  // v1.0.14: прежний builtin-ai был Heiken Ashi. Один раз переносим старый выбор
  // на свободную Heiken Ashi стратегию; новый builtin-ai теперь отдельный AI Analysis.
  const catalogVersion = Number(incoming.strategyCatalogVersion ?? base.strategyCatalogVersion ?? 0);
  if (catalogVersion < 2 && strategyIds.includes('builtin-ai')) {
    strategyIds = strategyIds.map((id) => id === 'builtin-ai' ? 'builtin-smart' : id);
  }
  auto.strategyIds = [...new Set(strategyIds)];
  auto.strategyId = auto.strategyIds[0] || '';
  auto.strategyMode = auto.strategyIds.length > 1 ? 'independent' : (['best', 'independent'].includes(auto.strategyMode) ? auto.strategyMode : 'best');
  auto.candleOffset = normalizeCandleOffset(auto.candleOffset, auto.candleMode);
  auto.candleMode = auto.candleOffset === 0 ? 'current' : 'closed';
  const effectiveActive = incoming.activeStrategyId ?? base.activeStrategyId ?? '';
  const effectiveBuiltIn = incoming.activeBuiltInStrategy ?? base.activeBuiltInStrategy ?? '';
  const migratedActive = catalogVersion < 2 && effectiveActive === 'builtin-ai' ? 'builtin-smart' : effectiveActive;
  const migratedBuiltIn = catalogVersion < 2 && effectiveBuiltIn === 'builtin-ai' ? 'builtin-smart' : effectiveBuiltIn;
  return {
    ...base,
    ...incoming,
    strategyCatalogVersion: 3,
    statusBarLayoutVersion: 2,
    statusBarVisibilityVersion: 1,
    statusBarVisible: Number(incoming.statusBarVisibilityVersion ?? base.statusBarVisibilityVersion ?? 0) < 1
      ? true
      : (incoming.statusBarVisible ?? base.statusBarVisible) !== false,
    statusBarCompact: Number(incoming.statusBarLayoutVersion ?? base.statusBarLayoutVersion ?? 0) < 2 ? false : (incoming.statusBarCompact ?? base.statusBarCompact) === true,
    interfaceDensity: 'compact',
    activeStrategyId: migratedActive || '',
    activeBuiltInStrategy: migratedBuiltIn || '',
    period: normalizeAnalysisPeriodSeconds(incoming.period ?? auto.period ?? base.period, 60),
    selectedAssets: cleanAssetSelection(Array.isArray(incoming.selectedAssets) ? incoming.selectedAssets : [...base.selectedAssets]),
    autoTrade: auto,
    builderStrategies: (Array.isArray(incoming.builderStrategies) ? incoming.builderStrategies : [...base.builderStrategies]).map(migrateCustomStrategyExpirationItem)
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function normalizeUiAsset(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').replace(/\u00a0/g, ' ').trim();
  if (!normalized || normalized.length > 120) return null;
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}


function isAllowedProductAsset(symbol) {
  // MARKET v1.0.66: show and allow the full Pocket Option catalog.
  // Restrict only malformed/control strings, not product classes.
  const raw = String(symbol || '').normalize('NFKC').replace(/\u00a0/g, ' ').trim();
  if (!raw || raw.length > 120) return false;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
  return /^[#]?[A-Za-z0-9][A-Za-z0-9._-]*(?:_otc)?$/i.test(raw);
}

function cleanAssetSelection(values) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const asset = normalizeUiAsset(raw);
    if (!asset || seen.has(asset) || !isAllowedProductAsset(asset)) continue;
    seen.add(asset);
    result.push(asset);
  }
  return result;
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteOptional(value) {
  if (value == null || value === '') return null;
  return finite(value, null);
}

function runtimeMessage(message, options = {}) {
  return sendRuntimeMessageSafe(message, {
    ...options,
    timeoutMs: dashboardRuntimeMessageTimeout(message, options)
  });
}

async function tabMessage(message, options = {}) {
  if (!pocketTab?.id) throw new Error('Вкладка Pocket Option не найдена');
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DASHBOARD_MESSAGE_TIMEOUT_MS);
  try {
    return await sendTabMessageOnce(pocketTab.id, message, timeoutMs);
  } catch (error) {
    if (options.heal === false || !isRuntimeOrBridgeGoneError(error)) throw error;
    await healPocketBridge('tab_message_recovery').catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 650));
    return await sendTabMessageOnce(pocketTab.id, message, Math.max(timeoutMs, 7000));
  }
}

function pocketOriginPattern(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    const supported = host === 'pocketoption.com' || host.endsWith('.pocketoption.com')
      || host === 'po.trade' || host.endsWith('.po.trade');
    return supported ? `${url.origin}/*` : null;
  } catch {
    return null;
  }
}

async function ensurePocketBridge() {
  await findPocketTab();
  if (!pocketTab?.id || !pocketTab?.url) throw new Error('Сначала откройте торговый терминал Pocket Option');
  const origin = pocketOriginPattern(pocketTab.url);
  if (!origin) throw new Error('Открытая вкладка не распознана как терминал Pocket Option');
  // Supported hosts are declared statically in manifest.json.
  // v1.0.80 never asks the user to "allow this domain".
  const result = await runtimeMessage({ type: 'PO_ENSURE_TAB_BRIDGE', tabId: pocketTab.id });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось подключить расширение к текущему зеркалу');
  const waitUntil = Date.now() + (result.reloaded ? 18000 : 6000);
  while (Date.now() < waitUntil) {
    const response = await tabMessage({ type: 'PO_GET_STATE' }).catch(() => null);
    const ready = Boolean(response?.state?.connection?.authCaptured || response?.state?.socket?.authenticated);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return result;
}

function stateTimeMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value > 1_000_000_000_000 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recentMarketAlive(maxAgeMs = 120000) {
  const values = [stateTimeMs(state?.market?.streamUpdatedAt), stateTimeMs(state?.socket?.lastIncomingAt)];
  const subscriptions = state?.market?.subscriptions || {};
  for (const item of Object.values(subscriptions)) {
    values.push(stateTimeMs(item?.streamUpdatedAt));
    values.push(stateTimeMs(item?.lastTickTime));
  }
  const latest = Math.max(0, ...values.filter(Number.isFinite));
  return latest > 0 && Date.now() - latest <= maxAgeMs;
}

function isPocketBackgroundHold() {
  return Boolean(state?.connection?.requested
    && state?.account?.uid != null
    && (state?.connection?.backgroundPaused
      || state?.page?.visibility === 'hidden'
      || state?.environment?.visibility === 'hidden'));
}

function isConnected() {
  const accountIdentity = Boolean(state?.account?.uid != null && state?.account?.sessionCaptured === true);
  const hardConnected = Boolean(accountIdentity && state?.connection?.connected && state?.socket?.authenticated && state?.socket?.readyState === 1);
  const backgroundGrace = Boolean(accountIdentity && state?.connection?.requested && state?.connection?.reconnecting && state?.socket?.authenticated && recentMarketAlive());
  return hardConnected || backgroundGrace || (accountIdentity && isPocketBackgroundHold());
}

function currentAccountScopeKey() {
  const uid = state?.account?.uid;
  if (uid == null) return null;
  const mode = String(state?.account?.mode || (state?.account?.isDemo === false ? 'REAL' : state?.account?.isDemo === true ? 'DEMO' : '')).trim().toUpperCase();
  return `${uid}:${mode}`;
}

function ledgerMatchesCurrentAccount() {
  const key = currentAccountScopeKey();
  return Boolean(key && String(ledger?.accountKey || '').trim() === key);
}

function profitStatsMatchesCurrentAccount() {
  const key = currentAccountScopeKey();
  return Boolean(key && String(profitStats?.accountKey || '').trim() === key);
}

function scopedLedgerClosedDeals() {
  return ledgerMatchesCurrentAccount() && Array.isArray(ledger?.closedDeals) ? ledger.closedDeals : [];
}

function scopedLedgerOpenDeals() {
  return ledgerMatchesCurrentAccount() && Array.isArray(ledger?.openDeals) ? ledger.openDeals : [];
}

function currentCurrency() {
  if (settings.currencyOverride && settings.currencyOverride !== 'AUTO') return settings.currencyOverride;
  const accountUid = state?.account?.uid != null ? String(state.account.uid) : '';
  const accountDemo = state?.account?.isDemo;
  const pools = [
    ...(Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals.slice().reverse() : []),
    ...(Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals.slice().reverse() : []),
    ...scopedLedgerClosedDeals().slice().reverse(),
    ...scopedLedgerOpenDeals().slice().reverse()
  ];
  let dealCurrency = null;
  for (const deal of pools) {
    if (accountUid && deal?.uid != null && String(deal.uid) !== accountUid) continue;
    if (accountDemo != null && deal?.isDemo != null && Boolean(Number(deal.isDemo) || deal.isDemo === true) !== Boolean(accountDemo)) continue;
    const code = String(deal?.currency || '').trim().toUpperCase();
    if (code) { dealCurrency = code; break; }
  }
  const trustedProfitCurrency = profitStatsMatchesCurrentAccount() ? profitStats?.currency : null;
  return state?.account?.currency || trustedProfitCurrency || dealCurrency || 'USD';
}

function currencySymbol(currency = currentCurrency()) {
  const code = String(currency || '').toUpperCase();
  return ({ USD: '$', EUR: '€', RUB: '₽', GBP: '£', JPY: '¥', BRL: 'R$', INR: '₹', KZT: '₸', UAH: '₴', CNY: '¥', KRW: '₩', TRY: '₺', PLN: 'zł', CHF: 'CHF', AED: 'د.إ', SAR: 'ر.س' })[code] || code || '$';
}

function currencySuffix(currency = currentCurrency()) {
  const code = String(currency || '').toUpperCase();
  if (!code || code === 'AUTO') return '';
  const symbol = ({ USD: '$', EUR: '€', RUB: '₽', GBP: '£', JPY: '¥', BRL: 'R$', INR: '₹', KZT: '₸', UAH: '₴', CNY: '¥', KRW: '₩', TRY: '₺', PLN: 'zł', CHF: 'CHF', AED: 'د.إ', SAR: 'ر.س' })[code];
  return symbol || ` ${code}`;
}

function interfaceLocale() {
  return ({ ru: 'ru-RU', en: 'en-GB', es: 'es-ES', hi: 'hi-IN', ar: 'ar-SA' })[window.PTI18n?.locale] || 'ru-RU';
}

const STATISTICS_TIME_ZONE = 'Europe/Moscow';

function statisticsMoscowDayKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STATISTICS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function formatNumber(value, digits = 2) {
  const number = finite(value);
  if (number == null) return '—';
  return number.toLocaleString(interfaceLocale(), { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function formatMoney(value, currency = currentCurrency(), signed = false) {
  const number = finite(value);
  if (number == null) return '—';
  const sign = signed && number > 0 ? '+' : '';
  return `${sign}${formatNumber(number, 2)} ${currencySymbol(currency)}`;
}

function formatTime(timestamp) {
  const value = finite(timestamp);
  if (!value) return '—';
  const date = new Date(value > 1e12 ? value : value * 1000);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(interfaceLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function directionLabel(action) {
  return action === 'put' ? 'SELL / PUT' : action === 'call' ? 'BUY / CALL' : '—';
}

function openDealExpiration(deal) {
  const explicit = finite(deal?.expirationTimestamp);
  if (explicit && explicit > 0) return explicit;
  const opened = finite(deal?.openTimestamp);
  const duration = finite(deal?.duration);
  return opened && duration && duration > 0 ? opened + duration : null;
}

function openDealStillActive(deal) {
  if (!deal || deal.status === 'closed' || deal.closeTimestamp) return false;
  const expiration = openDealExpiration(deal);
  const brokerOffset = finite(state?.market?.brokerClockOffsetSec, 0);
  const brokerNow = Math.floor(Date.now() / 1000) + brokerOffset;
  if (!expiration) {
    const opened = finite(deal?.openTimestamp);
    return !deal.optimistic || !opened || brokerNow - opened <= 6 * 60 * 60;
  }
  return brokerNow <= expiration + (deal.optimistic ? 20 : 120);
}


function dealIdentityKey(deal) {
  const id = String(deal?.id || deal?.dealId || '').trim();
  if (id) return `id:${id}`;
  const requestId = String(deal?.requestId || '').trim();
  if (requestId && !['0', 'null', 'undefined'].includes(requestId.toLowerCase())) return `request:${requestId}`;
  return `finger:${deal?.asset || ''}:${deal?.action || ''}:${finite(deal?.amount, 0)}:${finite(deal?.openTimestamp, 0)}`;
}

function sameClosedDeal(left, right) {
  if (!left || !right) return false;
  const leftId = String(left.id || left.dealId || '').trim();
  const rightId = String(right.id || right.dealId || '').trim();
  if (leftId && rightId && leftId === rightId) return true;
  const leftRequest = String(left.requestId || '').trim();
  const rightRequest = String(right.requestId || '').trim();
  if (leftRequest && rightRequest && leftRequest === rightRequest) return true;
  if ((left.asset || '') !== (right.asset || '')) return false;
  if (left.action && right.action && left.action !== right.action) return false;
  if (left.amount != null && right.amount != null && Math.abs(Number(left.amount) - Number(right.amount)) > 1e-8) return false;
  const lo = finite(left.openTimestamp);
  const ro = finite(right.openTimestamp);
  if (lo && ro && Math.abs(lo - ro) > 20) return false;
  return true;
}

function statisticsTimestampSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && !/^[-+]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  if (raw > 1e15) return Math.floor(raw / 1e6);
  if (raw > 1e12) return Math.floor(raw / 1000);
  if (raw > 1e10) return Math.floor(raw / 1000);
  return Math.floor(raw);
}

function statisticsResetIdentityKey(deal) {
  if (!deal || typeof deal !== 'object') return null;
  const id = String(deal.id || deal.dealId || deal.ticket || '').trim();
  if (id) return `id:${id}`;
  const requestId = String(deal.requestId || deal.request_id || '').trim();
  if (requestId && !['0', 'null', 'undefined'].includes(requestId.toLowerCase())) return `request:${requestId}`;
  const asset = String(deal.asset || '').trim();
  const action = String(deal.action || '').trim();
  const amount = Number(deal.amount);
  const opened = statisticsTimestampSeconds(deal.openTimestamp || deal.openedAt);
  if (!asset && !action && !Number.isFinite(amount) && opened == null) return null;
  return `finger:${asset}:${action}:${Number.isFinite(amount) ? amount : ''}:${opened ?? ''}`;
}

function statisticsResetTimestamp() {
  if (!ledgerMatchesCurrentAccount()) return 0;
  return Math.max(0, statisticsTimestampSeconds(ledger?.resetTimestamp)
    ?? (ledger?.resetAt ? Math.floor(Date.parse(ledger.resetAt) / 1000) : 0));
}

function statisticsReferenceSeconds(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return statisticsTimestampSeconds(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function statisticsRealTimestampSeconds(value, deal = null, phase = '') {
  const timestamp = statisticsTimestampSeconds(value);
  if (timestamp == null) return null;
  const brokerOffset = finite(state?.market?.brokerClockOffsetSec, 0);
  const safeOffset = Math.abs(brokerOffset) <= 3 * 24 * 60 * 60 ? brokerOffset : 0;
  if (!safeOffset) return timestamp;
  const brokerAdjusted = timestamp - safeOffset;

  // Ledger rows can come from two clock domains: Pocket wall-clock seconds and
  // ordinary Unix epoch seconds returned by the server. Prefer stable real-time
  // anchors stored with the deal; unlike a now-only heuristic this also works
  // for historical rows.
  const references = [];
  const submittedAt = statisticsReferenceSeconds(deal?.submittedAt);
  const confirmedAt = statisticsReferenceSeconds(deal?.confirmedAt);
  const duration = finite(deal?.duration ?? deal?.signalExpiration, 0);
  if (phase === 'open') {
    if (submittedAt != null) references.push(submittedAt);
    if (confirmedAt != null) references.push(confirmedAt);
  } else if (phase === 'close') {
    if (confirmedAt != null) references.push(confirmedAt);
    if (submittedAt != null && duration > 0) references.push(submittedAt + duration);
    if (confirmedAt != null && duration > 0) references.push(confirmedAt + duration);
  }
  if (references.length) {
    const rawDistance = Math.min(...references.map((reference) => Math.abs(timestamp - reference)));
    const adjustedDistance = Math.min(...references.map((reference) => Math.abs(brokerAdjusted - reference)));
    if (adjustedDistance + 30 < rawDistance) return brokerAdjusted;
    if (rawDistance + 30 < adjustedDistance) return timestamp;
  }

  // Explicit provenance is stronger than distance-to-now and stays valid for
  // history. Official API/server rows are ordinary epoch seconds; Pocket page,
  // socket and broker UI rows carry the observed broker-wall-clock offset.
  const source = String(deal?.source || '').trim().toLowerCase();
  const executionSource = String(deal?.executionSource || '').trim().toLowerCase();
  const closeSource = String(deal?.closeConfirmationSource || '').trim().toLowerCase();
  const serverDomain = deal?.officialApi === true
    || executionSource === 'official_api'
    || ['official_api', 'server', 'server-ledger'].includes(source);
  const brokerDomain = deal?.brokerUiLive === true
    || ['broker_event', 'broker_socket', 'broker_ui'].includes(closeSource)
    || source === 'broker-ui-live'
    || source === 'autotrade';
  if (serverDomain) return timestamp;
  if (brokerDomain) return brokerAdjusted;

  const localNow = Math.floor(Date.now() / 1000);
  const brokerNow = localNow + safeOffset;
  const localDistance = Math.abs(timestamp - localNow);
  const brokerDistance = Math.abs(timestamp - brokerNow);
  // Near-live rows can be classified against both clocks. Do not apply this
  // comparison to old history: as time passes, either candidate can look closer
  // merely because it is earlier/later, not because it belongs to that clock.
  if (Math.min(localDistance, brokerDistance) <= 12 * 60 * 60) {
    if (brokerDistance + 30 < localDistance) return brokerAdjusted;
    if (localDistance + 30 < brokerDistance) return timestamp;
  }

  return timestamp;
}

function statisticsLocalDayKey(value, deal = null, phase = '') {
  const timestamp = statisticsRealTimestampSeconds(value, deal, phase);
  if (timestamp == null) return null;
  return statisticsMoscowDayKey(timestamp * 1000);
}

function formatStatisticsTime(value, deal = null, phase = '') {
  const timestamp = statisticsRealTimestampSeconds(value, deal, phase);
  if (timestamp == null) return '—';
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(interfaceLocale(), {
        timeZone: STATISTICS_TIME_ZONE,
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
}

function dealAfterStatisticsReset(deal) {
  const reset = statisticsResetTimestamp();
  if (!reset) return true;

  const identity = statisticsResetIdentityKey(deal);
  const resetKeys = ledgerMatchesCurrentAccount() && Array.isArray(ledger?.resetDealKeys) ? ledger.resetDealKeys : [];
  if (identity && resetKeys.includes(identity)) return false;

  const candidates = [
    [deal?.closeTimestamp, 'close'],
    [deal?.closedAt, 'close'],
    [deal?.openTimestamp, 'open'],
    [deal?.openedAt, 'open']
  ];
  for (const [value, phase] of candidates) {
    const timestamp = statisticsRealTimestampSeconds(value, deal, phase);
    if (timestamp != null) return timestamp >= reset;
  }
  return false;
}

function isRobotStatisticsDeal(deal) {
  const source = String(deal?.source || '').trim().toLowerCase();
  const requestId = String(deal?.requestId || '').trim();
  return Boolean(deal?.robotTrade === true || source === 'autotrade' || requestId.startsWith('pt_'));
}

function currentClosedDeals() {
  const sources = [
    ...scopedLedgerClosedDeals(),
    ...(Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals : [])
  ];
  const list = [];
  for (const deal of sources) {
    if (!deal || !isRobotStatisticsDeal(deal) || !dealAfterStatisticsReset(deal)) continue;
    const existingIndex = list.findIndex((item) => sameClosedDeal(item, deal));
    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...deal };
    } else {
      list.push(deal);
    }
  }
  return list.sort((a, b) => finite(a.closeTimestamp || a.openTimestamp, 0) - finite(b.closeTimestamp || b.openTimestamp, 0));
}

function sameExactTradeIdentity(left, right) {
  const leftId = String(left?.id || left?.dealId || '').trim();
  const rightId = String(right?.id || right?.dealId || '').trim();
  if (leftId && rightId && leftId === rightId) return true;
  const leftRequest = String(left?.requestId || '').trim();
  const rightRequest = String(right?.requestId || '').trim();
  return Boolean(leftRequest && rightRequest && leftRequest === rightRequest);
}

function mergeLiveBrokerDeals(deals = []) {
  if (!Array.isArray(deals) || !deals.length) return false;
  state.trades = state.trades || {};
  const existing = Array.isArray(state.trades.closedDeals) ? [...state.trades.closedDeals] : [];
  let changed = false;
  for (const deal of deals) {
    if (!deal || !dealAfterStatisticsReset(deal)) continue;
    const index = existing.findIndex((item) => isRobotStatisticsDeal(item) && sameExactTradeIdentity(item, deal));
    if (index < 0) continue;
    existing[index] = {
      ...existing[index],
      ...deal,
      source: 'autotrade',
      robotTrade: true,
      brokerUiLive: true,
      status: 'closed'
    };
    changed = true;
  }
  if (!changed) return false;
  state.trades.closedDeals = existing
    .sort((a, b) => finite(a.closeTimestamp || a.openTimestamp, 0) - finite(b.closeTimestamp || b.openTimestamp, 0))
    .slice(-1000);
  return true;
}

async function refreshLiveBrokerStatsForDashboard() {
  if (!document.querySelector('#view-statistics.active') || !pocketTab?.id) return;
  const response = await tabMessage({ type: 'PO_GET_LIVE_BROKER_STATS' }, { timeoutMs: 4500, heal: false }).catch(() => null);
  if (response?.ok && Array.isArray(response.deals)) mergeLiveBrokerDeals(response.deals);
  // Aggregate broker statistics include manual Pocket Option trades and must never
  // be used by Pocket TRADE ROBOT statistics. Robot P/L is built only from the
  // robot-only ledger matched by requestId/dealId.
  if (state?.trades) state.trades.statistics = null;
}

function currentOpenDeals() {
  const closed = [
    ...scopedLedgerClosedDeals(),
    ...(Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals : [])
  ];
  const closedIds = new Set(closed.map((deal) => String(deal?.id || '')).filter(Boolean));
  const map = new Map();
  const add = (deal) => {
    if (!isRobotStatisticsDeal(deal) || !dealAfterStatisticsReset(deal)) return;
    const id = String(deal?.id || deal?.dealId || deal?.requestId || '').trim();
    if (!id || closedIds.has(id) || !openDealStillActive(deal)) return;
    map.set(id, { ...(map.get(id) || {}), ...deal, id });
  };
  scopedLedgerOpenDeals().forEach(add);
  (Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals : []).forEach(add);

  const last = state?.trades?.lastResult || {};
  const lastId = String(last.dealId || last.requestId || '').trim();
  if (last.status === 'success' && isRobotStatisticsDeal(last) && lastId && !map.has(lastId) && !closedIds.has(lastId)) {
    const brokerOffset = finite(state?.market?.brokerClockOffsetSec, 0);
    const realOpened = Math.floor(Date.parse(last.time || '') / 1000);
    const openTimestamp = Number.isFinite(realOpened) ? realOpened + brokerOffset : Math.floor(Date.now() / 1000) + brokerOffset;
    add({
      id: lastId,
      requestId: last.requestId || null,
      asset: last.asset || null,
      action: last.action || null,
      amount: finite(last.amount),
      duration: finite(last.duration),
      openTimestamp,
      expirationTimestamp: finite(last.duration) ? openTimestamp + finite(last.duration) : null,
      currency: currentCurrency(),
      isDemo: state?.account?.isDemo,
      status: 'open',
      outcome: 'open',
      optimistic: true,
      confirmedAt: last.time || null
    });
  }
  return [...map.values()].sort((a, b) => finite(a.openTimestamp, 0) - finite(b.openTimestamp, 0));
}

function dealNet(deal) {
  const amount = Math.max(0, finite(deal?.amount, 0));
  const raw = finite(deal?.profit, 0);
  const percent = finiteOptional(deal?.percentProfit);
  const outcome = String(deal?.outcome || deal?.result || deal?.status || deal?.reason || '').toLowerCase();
  const open = finiteOptional(deal?.openPrice);
  const close = finiteOptional(deal?.closePrice);
  const equalPrices = open != null && close != null && Math.abs(open - close) <= Math.max(1e-10, Math.abs(open) * 1e-10);
  if (/return|refund|draw|tie|push|cancel|equal|возврат|ничья|отмена/.test(outcome) || equalPrices) return 0;
  if (amount > 0 && raw > 0 && Math.abs(raw - amount) <= Math.max(0.000001, amount * 0.000001)) return 0;
  if (outcome === 'loss') return raw < 0 ? raw : -amount;
  if (outcome === 'draw') return 0;
  if (outcome === 'win' || raw > 0) {
    if (amount > 0 && percent != null && percent > 0) {
      const expectedNet = amount * percent / 100;
      const expectedReturn = amount + expectedNet;
      return Math.abs(raw - expectedReturn) < Math.abs(raw - expectedNet) ? raw - amount : raw;
    }
    return amount > 0 && raw > amount * 1.01 ? raw - amount : raw;
  }
  if (raw < 0) return raw;
  if (deal?.closePrice != null && deal?.openPrice != null && deal?.action) {
    const delta = Number(deal.closePrice) - Number(deal.openPrice);
    if (delta === 0) return 0;
    const win = deal.action === 'call' ? delta > 0 : delta < 0;
    return win ? raw : -amount;
  }
  return raw;
}


function safeSessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function safeSessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch {}
}

function uiText(ru, en) {
  const current = window.PTI18n?.locale || 'ru';
  if (current === 'ru') return ru;
  if (current === 'en') return en;
  return window.PTI18n?.t?.(en) || en;
}

function legacyRuntimeEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  const schema = Number(value.version || 0);
  if (schema > 0 && schema < 2) return `server_state_schema_${schema}`;
  const endpoints = [value.apiBase, value.wsUrl, value.adminUrl, value.supportUrl]
    .map((item) => String(item || '').toLowerCase());
  if (endpoints.some((item) => item.includes('autorobot.online') || item.includes('autotradesupports'))) {
    return 'legacy_endpoint';
  }
  return null;
}

function assessRuntimeCompatibility(response, currentServerState, responseError = null) {
  const legacyReason = legacyRuntimeEvidence(currentServerState);
  if (legacyReason) return { status: 'mixed', mixed: true, reason: legacyReason };
  if (response?.ok === true && response.runtime) {
    const worker = response.runtime;
    if (String(worker.buildId || '') !== BUILD_ID) return { status: 'mixed', mixed: true, reason: 'build_id_mismatch' };
    if (Number(worker.serverStateSchema || 0) !== 2) return { status: 'mixed', mixed: true, reason: 'server_state_schema_mismatch' };
    if (String(worker.legalConsentVersion || '') !== LEGAL_CONSENT_VERSION) return { status: 'mixed', mixed: true, reason: 'legal_version_mismatch' };
    return { status: 'current', mixed: false, reason: null };
  }
  if (/UNKNOWN_MESSAGE/i.test(String(response?.error || responseError?.message || responseError || ''))) {
    return { status: 'mixed', mixed: true, reason: 'runtime_handshake_missing' };
  }
  return { status: 'transient', mixed: false, reason: responseError ? errorText(responseError) : 'runtime_info_unavailable' };
}

function runtimeReloadSafety() {
  const rawOpened = Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals.length : 0;
  const brokerOpen = Number(state?.trades?.statistics?.open ?? state?.trades?.open ?? state?.trades?.openedCount ?? 0);
  const effectiveOpen = currentOpenDeals().length;
  const autoEnabled = settings?.autoTrade?.enabled === true || autoStatus?.enabled === true;
  if (autoEnabled) return { safe: false, reason: uiText('Сначала выключите автоторговлю.', 'Disable auto trading first.') };
  if (rawOpened > 0 || (Number.isFinite(brokerOpen) && brokerOpen > 0) || effectiveOpen > 0) {
    return { safe: false, reason: uiText('Дождитесь закрытия всех сделок перед перезапуском.', 'Wait for all trades to close before restarting.') };
  }
  return { safe: true, reason: null };
}

function showRuntimeMismatchRecovery() {
  const reason = String(runtimeCompatibility?.reason || 'runtime_version_mismatch');
  showDashboardRecovery(
    new Error(`EXTENSION_RUNTIME_VERSION_MISMATCH: ${reason}`),
    uiText(
      'Файлы интерфейса обновились, но торговое ядро осталось от прежней сборки. Сохранённые условия и настройки не потеряны.',
      'The interface files were updated, but the trading core is still from the previous build. Saved terms and settings are preserved.'
    ),
    'runtime-mismatch'
  );
}

async function restartExtensionRuntimeSafely() {
  if (runtimeReloadBusy) return;
  const safety = runtimeReloadSafety();
  if (!safety.safe) {
    toast(safety.reason, 'error');
    return;
  }
  runtimeReloadBusy = true;
  try {
    await chrome.storage.local.set({
      ptRuntimeRecoveryRequested: {
        requestedAt: new Date().toISOString(),
        dashboardBuild: BUILD_ID,
        reason: runtimeCompatibility?.reason || 'manual_runtime_recovery'
      }
    });
    chrome.runtime.reload();
  } catch (error) {
    runtimeReloadBusy = false;
    await recordDashboardError(error, 'runtime-reload');
    toast(uiText('Не удалось перезапустить расширение.', 'Unable to restart the extension.'), 'error');
  }
}

function friendlyServerConnectionError(value) {
  const text = String(value || '').trim();
  if (runtimeCompatibility?.mixed) {
    return uiText('Обновите торговое ядро кнопкой «Перезапустить расширение»', 'Restart the extension to update the trading core');
  }
  if (!text) return uiText('Нет соединения с сервером', 'No server connection');
  if (/SERVER_SESSION_REFRESHING|session_missing_refreshing/i.test(text)) {
    return uiText('Обновляем сессию для текущего аккаунта…', 'Refreshing the session for this account…');
  }
  if (/ACCOUNT_NOT_CONNECTED/i.test(text)) {
    return uiText('Подключите аккаунт Pocket Option', 'Connect your Pocket Option account');
  }
  if (/LEGAL_CONSENT_REQUIRED/i.test(text)) {
    return uiText('Примите обязательные условия использования', 'Accept the required terms of use');
  }
  if (/rate_limit_exceeded|HTTP_429/i.test(text)) {
    return uiText('Сервер ограничил частые запросы. Повторим автоматически.', 'The server limited frequent requests. Retrying automatically.');
  }
  if (/failed to fetch|network\s*error|networkerror|load failed|connection (?:reset|aborted)|API_TIMEOUT|SERVER_OFFLINE/i.test(text)) {
    return uiText('Сеть временно недоступна. Подключение восстановится автоматически.', 'The network is temporarily unavailable. Connection will recover automatically.');
  }
  if (/SERVER_SESSION_TOKEN_MISSING|SESSION_BOOTSTRAP_FAILED/i.test(text)) {
    return uiText('Сервер не подтвердил сессию. Выполняется повторное подключение.', 'The server did not confirm the session. Reconnecting.');
  }
  return rebrandLegacyVisibleText(text);
}

function rebrandLegacyVisibleText(value = '') {
  return String(value || '')
    .replace(/Perfect Trade Binary Bot/gi, 'Pocket TRADE ROBOT')
    .replace(/Perfect Trade Robot/gi, 'Pocket TRADE ROBOT')
    .replace(/Perfect Trade/gi, 'Pocket TRADE ROBOT');
}

function friendlyUserMessage(message) {
  const text = String(message || '');
  // Краткие разрывы канала уже восстанавливаются автоматически. Не показываем
  // пользователю большой красный toast про «мост», пока фоновая диагностика
  // продолжает фиксировать исходную ошибку.
  if (/мост терминала.*временно|42\[?['"]?auth|42auth|auth.*пакет|пакет.*auth|websocket.*auth|receiving end does not exist/i.test(text)) return '';
  return rebrandLegacyVisibleText(text);
}

function toast(message, type = '') {
  const region = $('toastRegion');
  if (!region) return;
  const visibleMessage = friendlyUserMessage(message);
  if (!visibleMessage) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`.trim();
  node.textContent = visibleMessage;
  region.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function accessDisplay(entitlement = currentEntitlement()) {
  const status = String(entitlement.status || 'active').toLowerCase();
  const source = String(entitlement.source || 'free').toLowerCase();
  const accessState = String(entitlement.accessState || '').toUpperCase();
  if (status === 'blocked' || accessState === 'BLOCKED') return { code: 'blocked', badge: 'ДОСТУП', plan: 'ЗАБЛОКИРОВАН', status: 'Статус: заблокирован', description: 'Обратитесь в поддержку', active: false };
  if (accessState === 'TRIAL_ACTIVE' || (entitlement.premium && source === 'trial' && status === 'active')) return { code: 'trial', badge: 'TRIAL', plan: 'TRIAL PREMIUM', status: 'Статус: активирован', description: 'Все функции · DEMO и REAL без лимитов · 24 часа', active: true };
  if (entitlement.premium && status === 'active') return { code: 'premium', badge: 'PREMIUM', plan: 'PREMIUM', status: 'Статус: активирован', description: source === 'paid' ? 'Платный Premium активен' : source === 'owner' ? 'Доступ владельца · все функции' : 'AI · все стратегии · без тарифных лимитов', active: true };
  if (accessState === 'PREMIUM_PAUSED' || (source !== 'free' && status === 'paused')) return { code: 'paused', badge: 'PREMIUM', plan: 'PREMIUM · ПАУЗА', status: 'Статус: временно приостановлен', description: reasonText(entitlement.pauseReason) || 'Доступен ограниченный FREE-режим только на DEMO', active: false };
  if (accessState === 'AFFILIATE_REGISTERED' || entitlement.affiliate?.registered) return { code: 'affiliate', badge: 'FREE', plan: 'FREE', status: 'Регистрация подтверждена', description: 'Только DEMO · до 30 активов · 50 сделок в сутки', active: true };
  if (accessState === 'TRIAL_EXPIRED' || entitlement.trial?.expired) return { code: 'expired', badge: 'TRIAL', plan: 'TRIAL ЗАВЕРШЁН', status: 'Требуется регистрация', description: 'Зарегистрируйте новый аккаунт Pocket Option для продолжения торговли', active: false };
  return { code: 'free', badge: 'FREE', plan: 'FREE', status: 'Ожидание TRIAL', description: 'TRIAL Premium активируется автоматически после подключения UID', active: true };
}

async function clearRetiredFirstRunOnboarding() {
  await chrome.storage.local.remove('ptFirstRunOnboarding').catch(() => null);
}

function showFreeLimitModal(notice) {
  document.getElementById('freeLimitModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'freeLimitModal';
  modal.className = 'freeLimitOverlay';
  modal.innerHTML = `
    <div class="freeLimitDialog" role="dialog" aria-modal="true" aria-label="Дневной лимит FREE">
      <button class="freeLimitClose" type="button" aria-label="Закрыть">×</button>
      <div class="freeLimitBadge">FREE LIMIT</div>
      <h2>Дневной лимит FREE исчерпан</h2>
      <p>${escapeHtml(notice?.message || 'Сегодня использовано 50 из 50 FREE-сделок на DEMO. Внесите депозит от $10 для активации полного Premium без тарифного лимита.')}</p>
      <div class="freeLimitStats"><span>Сегодня</span><b>${escapeHtml(String(notice?.usedToday || 50))} / ${escapeHtml(String(notice?.limitToday || 50))}</b><small>сделок</small></div>
      <div class="freeLimitActions">
        <button class="primary" id="freeLimitOpenPremium" type="button">Проверить регистрацию / депозит</button>
      </div>
      <small class="freeLimitHint">Дневной FREE-лимит восстановится автоматически на следующие сутки. Premium снимает тарифный лимит.</small>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.freeLimitClose')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.remove(); });
  modal.querySelector('#freeLimitOpenPremium')?.addEventListener('click', () => { modal.remove(); setTab('premium'); });
}

function showAccessNotification(notice) {
  if (!notice?.id) return;
  const seen = safeSessionGet('ptAccessNoticeSeen');
  if (seen === notice.id) return;
  safeSessionSet('ptAccessNoticeSeen', notice.id);
  if (notice.kind === 'free_limit' || notice.reason === 'DAILY_TRADE_LIMIT') {
    showFreeLimitModal(notice);
    void recordNotification({ kind: 'access', title: notice.title || 'Дневной лимит FREE исчерпан', message: notice.message || '' });
    return;
  }
  const text = [notice.title, notice.message].filter(Boolean).join(' — ');
  const kind = notice.kind === 'premium' ? 'accessPremium' : notice.kind === 'paused' || notice.kind === 'blocked' ? 'accessPaused' : 'accessFree';
  toast(text, kind);
  void recordNotification({ kind: 'access', title: notice.title || 'Статус доступа', message: notice.message || '' });
}

function setClassState(node, className) {
  node.classList.remove('profit', 'loss', 'neutral');
  node.classList.add(className);
}

function onlineBalanceDelta() {
  return safeBalanceDelta();
}

function statsFinancialNet(summary = null) {
  // Robot statistics must never use whole-account balance delta because that also
  // includes manual Pocket Option trades, deposits and other account movements.
  // The journal is trusted only when explicitly scoped to the current UID:MODE.
  const ledgerNet = Number(summary?.net ?? (ledgerMatchesCurrentAccount() ? ledger?.today?.netProfit : null));
  return Number.isFinite(ledgerNet) ? ledgerNet : 0;
}

function pnlView() {
  const delta = statsFinancialNet();
  return {
    delta,
    title: delta < 0 ? 'Убыток онлайн' : 'Прибыль онлайн',
    className: delta < 0 ? 'loss' : delta > 0 ? 'profit' : 'neutral',
    value: `(${formatMoney(delta, currentCurrency(), true)})`
  };
}

function safeBalanceDelta() {
  if (!profitStatsMatchesCurrentAccount()) return 0;
  const rawDelta = finite(profitStats?.delta, 0);
  const baseline = Number(profitStats?.baselineBalance);
  const current = Number(profitStats?.currentBalance ?? state?.account?.balance);
  if (!Number.isFinite(baseline)) return 0;
  if (baseline === 0 && Number.isFinite(current) && current > 0 && Math.abs(rawDelta - current) < 0.01) return 0;
  return rawDelta;
}

function balanceDeltaView() {
  const delta = safeBalanceDelta();
  return {
    delta,
    className: delta < 0 ? 'loss' : delta > 0 ? 'profit' : 'neutral',
    value: `(${formatMoney(delta, currentCurrency(), true)})`
  };
}

async function saveSettings(patch) {
  const next = mergeSettings(settings, patch);
  settings = next;
  selectedAssets = new Set(cleanAssetSelection(settings.selectedAssets));
  await chrome.storage.local.set({ poBridgeSettings: settings });
  requestRender(true);
  return settings;
}

async function loadStored() {
  const stored = await chrome.storage.local.get(['poBridgeSettings', 'poProfitStats', 'poBridgeState', 'poTradeLedger', 'poAutoTradeStatus', 'ptServerState', 'ptSignalDiagnostics', 'ptAccessNotification', 'ptNotificationHistory', 'ptStrategyTransferHistory', 'ptRequestedDashboardTab', 'ptStrategyCalibration', 'ptPocketPartnersState']);
  settings = mergeSettings(DEFAULT_SETTINGS, stored.poBridgeSettings || {});
  profitStats = stored.poProfitStats || null;
  state = stored.poBridgeState || null;
  ledger = stored.poTradeLedger || ledger;
  autoStatus = stored.poAutoTradeStatus || null;
  serverState = stored.ptServerState || null;
  access = reconcileAccessWithServerState(access, serverState);
  signalDiagnostics = stored.ptSignalDiagnostics || null;
  strategyCalibration = stored.ptStrategyCalibration || strategyCalibration;
  pocketPartnersStatus.state = stored.ptPocketPartnersState || pocketPartnersStatus.state || {};
  accessNotification = stored.ptAccessNotification || null;
  notificationHistory = Array.isArray(stored.ptNotificationHistory) ? stored.ptNotificationHistory : [];
  transferHistory = Array.isArray(stored.ptStrategyTransferHistory) ? stored.ptStrategyTransferHistory : [];
  // Remove the retired wizard state so an old profile cannot block normal UI.
  await clearRetiredFirstRunOnboarding();
  selectedAssets = new Set(cleanAssetSelection(settings.selectedAssets));
  if (stored.ptRequestedDashboardTab && TAB_INFO[stored.ptRequestedDashboardTab]) {
    setTab(stored.ptRequestedDashboardTab);
    await chrome.storage.local.remove('ptRequestedDashboardTab');
  }
}

async function findPocketTab() {
  const result = await runtimeMessage({ type: 'PO_FIND_TAB' });
  pocketTab = result?.tab || null;
  return pocketTab;
}

function userIsInteracting() {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  return active.matches?.('select,input,textarea,[contenteditable="true"]') || Boolean(active.closest?.('.modal:not([hidden])'));
}

function requestRender(force = false) {
  if (!force && document.visibilityState !== 'visible') {
    renderDeferred = true;
    return;
  }
  if (!force && userIsInteracting()) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;
  dashboardRenderQueued = true;
  if (force) {
    clearTimeout(dashboardRenderTimer);
    dashboardRenderTimer = null;
    safeRenderNow();
    return;
  }
  if (dashboardRenderTimer) return;
  const elapsed = Date.now() - dashboardLastRenderAt;
  const delay = Math.max(0, DASHBOARD_RENDER_MIN_INTERVAL_MS - elapsed);
  dashboardRenderTimer = setTimeout(() => {
    dashboardRenderTimer = null;
    if (dashboardRenderQueued) safeRenderNow();
  }, delay);
}

async function refreshState() {
  if (refreshBusy) return;
  refreshBusy = true;
  let refreshError = null;
  try {
    try {
      await findPocketTab();
    } catch (error) {
      refreshError = error;
      pocketTab = null;
    }

    if (pocketTab?.id) {
      try {
        const response = await tabMessage({ type: 'PO_GET_STATE' }, { timeoutMs: 7000 });
        if (response?.state) state = response.state;
      } catch (error) {
        refreshError = refreshError || error;
        const fallback = await runtimeMessage({ type: 'PO_GET_LAST_STATE' }, { attempts: 3, timeoutMs: 15000 }).catch(() => null);
        state = fallback?.state || state;
        profitStats = fallback?.profitStats || profitStats;
      }
    } else {
      const fallback = await runtimeMessage({ type: 'PO_GET_LAST_STATE' }, { attempts: 3, timeoutMs: 15000 }).catch(() => null);
      state = fallback?.state || state;
      profitStats = fallback?.profitStats || profitStats;
    }

    await refreshLiveBrokerStatsForDashboard().catch(() => null);

    const [profitResponse, accessResponse, ledgerResponse, serverResponse, runtimeResponse] = await Promise.allSettled([
      runtimeMessage({ type: 'PO_GET_PROFIT_STATS' }, { attempts: 2, timeoutMs: 15000 }),
      runtimeMessage({ type: 'PO_GET_ACCESS_STATE' }, { attempts: 2, timeoutMs: 15000 }),
      runtimeMessage({ type: 'PO_GET_TRADE_LEDGER' }, { attempts: 2, timeoutMs: 15000 }),
      runtimeMessage({ type: 'PT_GET_SERVER_STATE', sync: false }, { attempts: 2, timeoutMs: 15000 }),
      runtimeMessage({ type: 'PT_GET_RUNTIME_INFO' }, { attempts: 2, timeoutMs: 8000 })
    ]);

    const profitValue = profitResponse.status === 'fulfilled' ? profitResponse.value : null;
    const accessValue = accessResponse.status === 'fulfilled' ? accessResponse.value : null;
    const ledgerValue = ledgerResponse.status === 'fulfilled' ? ledgerResponse.value : null;
    const serverValue = serverResponse.status === 'fulfilled' ? serverResponse.value : null;
    const runtimeValue = runtimeResponse.status === 'fulfilled' ? runtimeResponse.value : null;
    if (profitValue?.profitStats) profitStats = profitValue.profitStats;
    if (accessValue?.ok) {
      access = normalizeAccessLimitsForUi(accessValue);
      premiumRegistrationAccessResolved = true;
    }
    if (ledgerValue?.ledger) ledger = ledgerValue.ledger;
    if (serverValue?.serverState) {
      serverState = serverValue.serverState;
      if (serverState?.entitlement) premiumRegistrationAccessResolved = true;
    }
    if (runtimeValue?.ok && runtimeValue.runtime) runtimeInfo = runtimeValue.runtime;
    runtimeCompatibility = assessRuntimeCompatibility(
      runtimeValue,
      serverState,
      runtimeResponse.status === 'rejected' ? runtimeResponse.reason : null
    );
    access = reconcileAccessWithServerState(access, serverState);
    if (!premiumRegistrationAccessResolved) premiumRegistrationAccessResolved = true;

    const rejected = [profitResponse, accessResponse, ledgerResponse, serverResponse].find((item) => item.status === 'rejected');
    if (rejected && !refreshError) refreshError = rejected.reason;

    if (runtimeCompatibility.mixed) {
      dashboardRefreshFailures = 0;
      showRuntimeMismatchRecovery();
    } else if (refreshError) {
      dashboardRefreshFailures += 1;
      if (dashboardRefreshFailures >= 3) {
        if (dashboardRefreshFailures === 3 || dashboardRefreshFailures % 12 === 0) {
          await recordDashboardError(refreshError, 'refreshState');
        }
        showDashboardRecovery(refreshError, isRuntimeOrBridgeGoneError(refreshError) ? 'Восстанавливаем связь большого окна с торговым ядром. Если вкладка Pocket Option обновится — дождитесь графика.' : 'Панель временно потеряла связь с фоновым процессом. Торговое ядро продолжает работать.');
      }
    } else {
      dashboardRefreshFailures = 0;
      if (dashboardRecoveryVisible) hideDashboardRecovery();
    }
    requestRender();
    void publishDashboardHeartbeat(runtimeCompatibility.mixed || refreshError ? 'degraded' : 'ready');
  } catch (error) {
    premiumRegistrationAccessResolved = true;
    dashboardRefreshFailures += 1;
    await recordDashboardError(error, 'refreshState-fatal');
    showDashboardRecovery(error, 'Не удалось обновить данные панели. Показано последнее сохранённое состояние.');
    requestRender();
  } finally {
    refreshBusy = false;
  }
}

function scheduleDashboardPolling(delayMs = null) {
  clearTimeout(pollTimer);
  const interval = document.visibilityState === 'visible' ? 5000 : 20000;
  const delay = Math.max(1000, Number(delayMs) || interval);
  pollTimer = setTimeout(async () => {
    await refreshState();
    scheduleDashboardPolling();
  }, delay);
}

function setStrategyPanel(name = 'modes') {
  if (!['modes', 'builder', 'mine', 'exchange'].includes(name)) name = 'modes';
  document.querySelectorAll('[data-strategy-panel]').forEach((button) => button.classList.toggle('active', button.dataset.strategyPanel === name));
  document.querySelectorAll('.strategyPanel').forEach((panel) => panel.classList.toggle('active', panel.id === `strategy-panel-${name}`));
  safeSessionSet('ptStrategyPanel', name);
  document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'mine') renderSavedStrategies();
  if (name === 'exchange') renderTransferHistory();
}


function setPremiumRegistrationInteractionLock(locked) {
  const selectors = [
    '.sidebar',
    '.workspace > .header',
    'main.content > .view:not(#view-premium)'
  ];
  document.querySelectorAll(selectors.join(',')).forEach((node) => {
    node.inert = Boolean(locked);
    node.classList.toggle('premiumGateInert', Boolean(locked));
  });
}

function isPremiumRegistrationGateRequired() {
  const entitlement = currentEntitlement();
  const accessState = String(access.accessState || entitlement.accessState || serverState?.accessState || '').toUpperCase();
  const registered = Boolean(entitlement.affiliate?.registered || access.affiliate?.registered || serverState?.affiliate?.registered);
  const premium = Boolean(entitlement.premium || access.premium || serverState?.premium);
  const registrationRequired = Boolean(
    access.registrationRequired === true
    || entitlement.registrationRequired === true
    || serverState?.registrationRequired === true
  );
  const trialExpired = Boolean(accessState === 'TRIAL_EXPIRED' || entitlement.trial?.expired === true);
  return !premium && !registered && (trialExpired || registrationRequired);
}

function scrollPremiumRegistrationBelowStickyHeader({ behavior = 'smooth' } = {}) {
  const view = $('view-premium');
  const target = $('premiumRegistrationCard');
  const header = view?.querySelector('.premiumNotificationTop');
  if (!view || !target || !header) return;

  const align = () => {
    const viewRect = view.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const safeGap = 16;
    const stickyOffset = Math.ceil(headerRect.bottom - viewRect.top) + safeGap;
    view.style.setProperty('--premium-registration-sticky-offset', `${stickyOffset}px`);

    const targetRect = target.getBoundingClientRect();
    const nextTop = view.scrollTop + targetRect.top - viewRect.top - stickyOffset;
    view.scrollTo({ top: Math.max(0, nextTop), behavior });
  };

  requestAnimationFrame(() => requestAnimationFrame(align));
}

function openPremiumAccessNotification({ force = false, focusRegistration = false, locked = null } = {}) {
  const view = $('view-premium');
  if (!view) return;
  const entitlement = currentEntitlement();
  const accessState = String(entitlement.accessState || '').toUpperCase();
  const registered = Boolean(entitlement.affiliate?.registered);
  const gateLocked = locked == null ? isPremiumRegistrationGateRequired() : Boolean(locked);
  if (!force && !gateLocked && accessState !== 'TRIAL_EXPIRED' && !registered) return;
  const wasOpen = view.classList.contains('premiumNotificationOpen');
  const wasLocked = view.classList.contains('premiumRegistrationLocked');
  view.classList.add('premiumNotificationOpen');
  view.classList.toggle('premiumRegistrationLocked', gateLocked);
  setPremiumRegistrationInteractionLock(gateLocked);
  document.body.classList.add('premiumNotificationVisible');
  document.body.classList.toggle('premiumRegistrationLocked', gateLocked);
  view.setAttribute('aria-modal', gateLocked ? 'true' : 'false');
  view.removeAttribute('aria-hidden');
  const closeButton = $('premiumAccessClose');
  if (closeButton) closeButton.hidden = gateLocked;
  void loadPremiumAffiliatePrepared();
  // Do not reset the user's scroll position on every entitlement poll.
  // Focus/initial alignment is allowed only when the notification is first opened
  // or when its locked/unlocked state actually changes.
  const shouldInitialFocus = focusRegistration && (!wasOpen || wasLocked !== gateLocked);
  if (shouldInitialFocus) setTimeout(() => {
    if (gateLocked) view.scrollTo({ top: 0, behavior: 'auto' });
    else scrollPremiumRegistrationBelowStickyHeader({ behavior: 'smooth' });
  }, 80);
}

function closePremiumAccessNotification({ force = false } = {}) {
  if (!force && isPremiumRegistrationGateRequired()) {
    openPremiumAccessNotification({ force: true, focusRegistration: true, locked: true });
    return false;
  }
  $('view-premium')?.classList.remove('premiumNotificationOpen', 'premiumRegistrationLocked');
  document.body.classList.remove('premiumNotificationVisible', 'premiumRegistrationLocked');
  setPremiumRegistrationInteractionLock(false);
  const closeButton = $('premiumAccessClose');
  if (closeButton) closeButton.hidden = false;
  return true;
}

function syncPremiumRegistrationGate() {
  if (!premiumRegistrationAccessResolved) {
    document.body.classList.add('premiumRegistrationChecking');
    setPremiumRegistrationInteractionLock(true);
    return;
  }
  document.body.classList.remove('premiumRegistrationChecking');
  const entitlement = currentEntitlement();
  const accessState = String(entitlement.accessState || '').toUpperCase();
  const registered = Boolean(entitlement.affiliate?.registered);
  const gateTitle = $('premiumGateTitle');
  const gateText = $('premiumGateText');
  const title = $('premiumNotificationTitle');
  const subtitle = $('premiumNotificationSubtitle');
  if (accessState === 'TRIAL_ACTIVE') {
    if (gateTitle) gateTitle.textContent = 'TRIAL Premium активен автоматически';
    if (gateText) gateText.innerHTML = '<b>Все функции доступны без лимита</b> на DEMO и REAL до завершения 24-часового серверного таймера.';
    if (title) title.textContent = 'TRIAL Premium активен';
    if (subtitle) subtitle.textContent = 'После завершения здесь появится регистрация для продолжения торговли.';
  } else if (registered && !entitlement.premium) {
    if (gateTitle) gateTitle.textContent = 'Регистрация подтверждена';
    if (gateText) gateText.innerHTML = 'Доступна торговля только на <b>DEMO</b>: до <b>30 активов</b> и до <b>50 сделок в сутки</b>. Депозит <b>от $10</b> активирует полный Premium без тарифных лимитов.';
    if (title) title.textContent = 'Регистрация подтверждена';
    if (subtitle) subtitle.textContent = 'Осталось внести депозит от $10 и дождаться автоматической проверки.';
  } else if (entitlement.premium) {
    if (gateTitle) gateTitle.textContent = 'Premium-доступ активирован';
    if (gateText) gateText.innerHTML = '<b>Все функции доступны.</b> Сервер продолжает проверять баланс и активность согласно условиям Premium.';
    if (title) title.textContent = 'Premium активирован';
    if (subtitle) subtitle.textContent = 'Регистрация и депозит подтверждены сервером.';
  } else {
    if (gateTitle) gateTitle.textContent = 'Как продолжить после TRIAL';
    if (gateText) gateText.innerHTML = '<b>TRIAL Premium завершён.</b> Зарегистрируйте новый аккаунт Pocket Option по персональной партнёрской ссылке. После регистрации будет доступна торговля только на DEMO с лимитами 30 активов и 50 сделок в сутки, а депозит <b>от $10</b> активирует полный Premium.';
    if (title) title.textContent = 'TRIAL Premium завершён';
    if (subtitle) subtitle.textContent = 'Завершите регистрацию нового аккаунта Pocket Option для продолжения торговли.';
  }
  const gateRequired = isPremiumRegistrationGateRequired();
  if (gateRequired && isReferralRecoveryRouteActive()) {
    closePremiumAccessNotification({ force: true });
    return;
  }
  if (!gateRequired) setPremiumRegistrationInteractionLock(false);
  if (gateRequired) {
    openPremiumAccessNotification({ force: true, focusRegistration: true, locked: true });
  } else if ($('view-premium')?.classList.contains('premiumRegistrationLocked')) {
    closePremiumAccessNotification({ force: true });
  }
}

function setTab(name) {
  const referralRequested = name === 'referral';
  if (!referralRequested) referralRecoveryRouteActive = false;
  if (isPremiumRegistrationGateRequired() && !referralRequested) {
    openPremiumAccessNotification({ force: true, focusRegistration: true, locked: true });
    return;
  }
  if (referralRequested) {
    referralRecoveryRouteActive = true;
    closePremiumAccessNotification({ force: true });
  }
  if (name === 'premium') { openPremiumAccessNotification({ force: true, focusRegistration: true }); return; }
  if (!TAB_INFO[name]) name = 'account';
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll('[data-top-tab]').forEach((button) => button.classList.toggle('active', button.dataset.topTab === name));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  const [eyebrow, title, subtitle] = TAB_INFO[name];
  if ($('pageEyebrow')) $('pageEyebrow').textContent = eyebrow;
  if ($('pageTitle')) $('pageTitle').textContent = title;
  if ($('pageSubtitle')) $('pageSubtitle').textContent = subtitle;
  if ($('sectionSelect')) $('sectionSelect').value = name;
  safeSessionSet('poActiveTab', name);
  window.PTI18n?.refresh?.();
  requestRender(true);
  if (name === 'referral') void refreshReferralProgram({ silent: Boolean(referralProgramState) });
}

const REFERRAL_INVITES_PER_REWARD = 3;

function normalizeReferralProgram(data = {}) {
  const root = data?.program && typeof data.program === 'object' ? data.program : data;
  const progress = root?.progress && typeof root.progress === 'object' ? root.progress : {};
  const terms = root?.terms && typeof root.terms === 'object' ? root.terms : {};
  const reward = root?.reward && typeof root.reward === 'object' ? root.reward : {};
  // Product rule: every 3 confirmed referrals = 30 Premium days.
  // Ignore stale server/UI targets (for example 5) so all referral progress
  // in this client consistently uses the published 3-user cycle.
  const target = REFERRAL_INVITES_PER_REWARD;
  const hasQualifiedCount = root?.qualifiedCount != null || progress?.qualified != null;
  const qualified = Math.max(0, Number(root?.qualifiedCount ?? progress?.qualified) || 0);
  const registered = Math.max(0, Number(root?.registeredCount ?? progress?.registered) || 0);
  const pending = Math.max(0, Number(root?.pendingCount ?? progress?.pendingDeposit) || 0);
  const cyclesGranted = Math.max(0, Number(root?.cyclesGranted ?? reward?.cyclesGranted) || 0);
  const qualifiedRemainder = qualified % target;
  const expectedCycles = Math.floor(qualified / target);
  const derivedCycleProgress = expectedCycles > cyclesGranted && qualifiedRemainder === 0 && qualified > 0
    ? target
    : qualifiedRemainder;
  const fallbackCycleProgress = Number(typeof root?.progress === 'number' ? root.progress : progress?.current) || 0;
  const cycleProgress = Math.max(0, Math.min(target, hasQualifiedCount ? derivedCycleProgress : fallbackCycleProgress));
  const remaining = Math.max(0, target - cycleProgress);
  const rewardDays = Math.max(1, Number(reward?.days ?? terms?.rewardPremiumDays ?? root?.rewardDays) || 30);
  const totalRewardDays = Math.max(0, Number(root?.totalRewardDays ?? reward?.totalRewardDays) || (cyclesGranted * rewardDays));
  const nextMilestone = Math.max(target, (Math.floor(qualified / target) + 1) * target);
  const percent = Math.max(0, Math.min(100, (cycleProgress / target) * 100));
  return {
    target,
    qualified,
    cycleProgress,
    registered,
    pending,
    remaining,
    percent,
    cyclesGranted,
    totalRewardDays,
    nextMilestone,
    minimumDepositUsd: Math.max(0, Number(terms?.minimumDepositUsd ?? root?.minimumDepositUsd) || 10),
    rewardDays,
    shareUrl: String(root?.shareUrl ?? root?.link?.shareUrl ?? '').trim(),
    reward: {
      granted: Boolean(cyclesGranted > 0 || reward?.granted || ['granted', 'covered_by_permanent'].includes(String(reward?.status || '').toLowerCase())),
      status: String(reward?.status || ''),
      grantedAt: reward?.grantedAt || null,
      premiumExpiresAt: reward?.premiumExpiresAt || null
    }
  };
}

function referralDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(window.PTI18n?.locale === 'en' ? 'en' : 'ru', { dateStyle: 'medium' }).format(date);
}

function renderReferralProgram(program = referralProgramState) {
  const value = program || normalizeReferralProgram({});
  const linkReady = Boolean(value.shareUrl);
  if ($('referralQualified')) $('referralQualified').textContent = String(value.cycleProgress);
  if ($('referralTarget')) $('referralTarget').textContent = String(value.target);
  if ($('referralRegistered')) $('referralRegistered').textContent = String(value.registered);
  if ($('referralQualifiedTotal')) $('referralQualifiedTotal').textContent = String(value.qualified);
  if ($('referralPending')) $('referralPending').textContent = String(value.pending);
  if ($('referralRemaining')) $('referralRemaining').textContent = String(value.remaining);
  if ($('referralRewardsReceived')) $('referralRewardsReceived').textContent = uiText(`${value.totalRewardDays} дней`, `${value.totalRewardDays} days`);
  if ($('referralProgressTitle')) $('referralProgressTitle').textContent = value.remaining > 0
    ? uiText(`До следующей награды: ${value.remaining}`, `${value.remaining} confirmation${value.remaining === 1 ? '' : 's'} to the next reward`)
    : uiText('Цикл завершён — начисляем награду', 'Cycle complete — granting reward');
  if ($('referralProgressFill')) $('referralProgressFill').style.width = `${value.percent}%`;
  const track = $('referralProgressTrack');
  if (track) {
    track.setAttribute('aria-valuemax', String(value.target));
    track.setAttribute('aria-valuenow', String(value.cycleProgress));
    track.setAttribute('aria-valuetext', `${value.cycleProgress} / ${value.target}`);
  }
  if ($('referralShareUrl')) $('referralShareUrl').value = value.shareUrl;
  if ($('referralCopy')) $('referralCopy').disabled = !linkReady || referralProgramLoading;
  if ($('referralShare')) $('referralShare').disabled = !linkReady || referralProgramLoading;
  const rewardNode = $('referralReward');
  rewardNode?.classList.toggle('granted', value.reward.granted);
  const permanentCovered = value.reward.status.toLowerCase() === 'covered_by_permanent';
  if ($('referralRewardStatus')) $('referralRewardStatus').textContent = permanentCovered
    ? uiText('Постоянный Premium активен', 'Permanent Premium is active')
    : value.cyclesGranted > 0
      ? uiText(`Получено наград: ${value.cyclesGranted}`, `Rewards earned: ${value.cyclesGranted}`)
      : uiText('В процессе', 'In progress');
  if ($('referralRewardDetails')) {
    const grantedDate = referralDate(value.reward.grantedAt);
    $('referralRewardDetails').textContent = permanentCovered
      ? uiText(`Засчитано циклов: ${value.cyclesGranted}. Следующая награда — при ${value.nextMilestone} подтверждениях.`, `${value.cyclesGranted} cycle(s) counted. Next reward at ${value.nextMilestone} confirmations.`)
      : value.cyclesGranted > 0
        ? uiText(`Начислено ${value.totalRewardDays} дней Premium${grantedDate ? ` · ${grantedDate}` : ''}. Следующая награда — при ${value.nextMilestone} подтверждениях.`, `${value.totalRewardDays} Premium days granted${grantedDate ? ` · ${grantedDate}` : ''}. Next reward at ${value.nextMilestone} confirmations.`)
        : uiText(`Текущий цикл: ${value.cycleProgress} из ${value.target}.`, `Current cycle: ${value.cycleProgress} of ${value.target}.`);
  }
}

async function refreshReferralProgram({ silent = false } = {}) {
  if (referralProgramLoading) return referralProgramState;
  referralProgramLoading = true;
  const status = $('referralStatus');
  $('referralRefresh')?.setAttribute('disabled', '');
  if (!silent && status) {
    status.className = 'referralInlineStatus';
    status.textContent = uiText('Загружаем подтверждённые данные…', 'Loading confirmed data…');
  }
  try {
    const response = await runtimeMessage({ type: 'PT_GET_REFERRAL_PROGRAM' }, { attempts: 2, timeoutMs: 18000 });
    if (!response?.ok) throw new Error(response?.error || 'REFERRAL_LOAD_FAILED');
    referralProgramState = normalizeReferralProgram(response.program || response.result || response);
    renderReferralProgram(referralProgramState);
    if (status) {
      status.className = 'referralInlineStatus ok';
      status.textContent = uiText(
        `Условия: регистрация, депозит от $${referralProgramState.minimumDepositUsd} и подтверждение сервером.`,
        `Terms: registration, deposit from $${referralProgramState.minimumDepositUsd}, and server confirmation.`
      );
    }
    return referralProgramState;
  } catch (error) {
    renderReferralProgram(referralProgramState);
    if (status) {
      status.className = 'referralInlineStatus error';
      status.textContent = /ACCOUNT_NOT_CONNECTED|session_missing/i.test(String(error?.message || error))
        ? uiText('Сначала подключите аккаунт Pocket Option.', 'Connect your Pocket Option account first.')
        : uiText('Не удалось обновить данные. Проверьте соединение и повторите.', 'Could not refresh data. Check the connection and try again.');
    }
    return null;
  } finally {
    referralProgramLoading = false;
    $('referralRefresh')?.removeAttribute('disabled');
    if ($('referralCopy')) $('referralCopy').disabled = !referralProgramState?.shareUrl;
    if ($('referralShare')) $('referralShare').disabled = !referralProgramState?.shareUrl;
  }
}

async function copyReferralLink({ notify = true } = {}) {
  const value = String(referralProgramState?.shareUrl || $('referralShareUrl')?.value || '').trim();
  if (!value) return false;
  let copied = false;
  try { await navigator.clipboard.writeText(value); copied = true; } catch {}
  if (!copied) {
    const input = $('referralShareUrl');
    try { input?.focus(); input?.select(); copied = Boolean(document.execCommand('copy')); } catch {}
  }
  if (notify) toast(copied ? uiText('Ссылка скопирована.', 'Link copied.') : uiText('Не удалось скопировать ссылку.', 'Could not copy the link.'), copied ? 'ok' : 'error');
  return copied;
}

async function shareReferralLink() {
  const url = String(referralProgramState?.shareUrl || '').trim();
  if (!url) return;
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: 'Pocket TRADE ROBOT',
        text: uiText('Присоединяйся к Pocket TRADE ROBOT по моей ссылке:', 'Join Pocket TRADE ROBOT with my link:'),
        url
      });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  await copyReferralLink();
}

function initializeInputs() {
  if (inputsReady) return;
  $('marketPeriod').value = String(normalizeAnalysisPeriodSeconds(settings.period, 60));
  if ($('tradeAsset')) $('tradeAsset').value = settings.asset || selectedAssets.values().next().value || 'EURUSD_otc';
  if ($('tradeAmount')) $('tradeAmount').value = String(settings.amount ?? 1);
  if ($('tradeDuration')) $('tradeDuration').value = String(settings.duration ?? 60);
  $('statusBarVisible').checked = settings.statusBarVisible !== false;
  if ($('tradeResultNotifications')) $('tradeResultNotifications').checked = settings.tradeResultNotifications !== false;
  if ($('statusBarCompact')) $('statusBarCompact').checked = settings.statusBarCompact !== false;
  $('currencyOverride').value = settings.currencyOverride || 'AUTO';
  $('confirmTrades').checked = settings.confirmTrades !== false;
  $('profitResetMode').value = settings.profitResetMode === 'disconnect' ? 'disconnect' : 'daily';
  loadAutoInputs();
  void reconcileAutoStrategyCompatibility({ notify: false, persist: true, clearNoticeWhenValid: false });
  populateIndicatorOptions();
  inputsReady = true;
}


function applyInterfaceDensity() {
  // v2.0.22: у большой панели оставлен один стабильный компактный режим.
  settings.interfaceDensity = 'compact';
  document.body.dataset.density = 'compact';
}

function setupCollapsibleCards() {
  const saved = (() => {
    try { return JSON.parse(sessionStorage.getItem('ptCollapsedPanels') || '{}'); }
    catch { return {}; }
  })();
  document.querySelectorAll('.card[data-collapsible="true"]').forEach((card, index) => {
    if (card.dataset.collapseReady === '1') return;
    const head = card.querySelector(':scope > .sectionHead');
    if (!head) return;
    const panelId = card.id || `panel-${index}`;
    card.id = panelId;
    const body = document.createElement('div');
    body.className = 'collapsibleBody';
    [...card.children].filter((node) => node !== head).forEach((node) => body.appendChild(node));
    card.appendChild(body);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cardCollapseButton';
    button.title = 'Свернуть или развернуть блок';
    button.setAttribute('aria-label', 'Свернуть или развернуть блок');
    const controls = document.createElement('div');
    controls.className = 'sectionHeadControls';
    const existing = [...head.children].filter((child) => child !== head.firstElementChild);
    existing.forEach((child) => controls.appendChild(child));
    controls.appendChild(button);
    head.appendChild(controls);
    const update = (collapsed) => {
      card.classList.toggle('is-collapsed', collapsed);
      button.textContent = collapsed ? '⌄' : '⌃';
      button.title = collapsed ? 'Развернуть блок' : 'Свернуть блок';
    };
    update(Boolean(saved[panelId]));
    button.addEventListener('click', () => {
      const collapsed = !card.classList.contains('is-collapsed');
      saved[panelId] = collapsed;
      try { sessionStorage.setItem('ptCollapsedPanels', JSON.stringify(saved)); } catch {}
      update(collapsed);
    });
    card.dataset.collapseReady = '1';
  });
}

function renderAccess() {
  renderHeader();
  renderServerPanels();
  if (document.querySelector('.tab.active')?.dataset.tab === 'strategies') {
    renderStrategies();
    renderBuilder();
  }
}


function formatTrialRemaining(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function currentTrialRemaining(entitlement) {
  const expires = Date.parse(entitlement?.trial?.expiresAt || entitlement?.expiresAt || '');
  if (!Number.isFinite(expires)) return 0;
  const serverEpoch = Date.parse(entitlement?.serverTime || '');
  if (!trialClockAnchor || trialClockAnchor.expires !== expires || (Number.isFinite(serverEpoch) && trialClockAnchor.serverEpoch !== serverEpoch)) {
    trialClockAnchor = { expires, serverEpoch: Number.isFinite(serverEpoch) ? serverEpoch : Date.now(), perf: performance.now() };
  }
  const estimatedServerNow = trialClockAnchor.serverEpoch + Math.max(0, performance.now() - trialClockAnchor.perf);
  return Math.max(0, Math.floor((expires - estimatedServerNow) / 1000));
}

function renderTrialAccessIndicator() {
  const node = $('trialHeaderIndicator');
  if (!node) return;
  const entitlement = currentEntitlement();
  const accessState = String(entitlement.accessState || '').toUpperCase();
  node.classList.remove('expired', 'registered', 'premium');
  if (accessState === 'TRIAL_ACTIVE') {
    const remaining = currentTrialRemaining(entitlement);
    node.hidden = false;
    $('trialHeaderLabel').textContent = 'TRIAL PREMIUM';
    $('trialHeaderTime').textContent = formatTrialRemaining(remaining);
    if (remaining <= 0 && Date.now() - trialExpirySyncAt > 15000) {
      trialExpirySyncAt = Date.now();
      void runtimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: true }).catch(() => null);
    }
  } else if (accessState === 'TRIAL_EXPIRED') {
    node.hidden = false; node.classList.add('expired');
    $('trialHeaderLabel').textContent = 'TRIAL ЗАВЕРШЁН'; $('trialHeaderTime').textContent = 'РЕГИСТРАЦИЯ';
  } else if (accessState === 'AFFILIATE_REGISTERED' || (entitlement.affiliate?.registered && !entitlement.premium)) {
    node.hidden = false; node.classList.add('registered');
    $('trialHeaderLabel').textContent = 'FREE'; $('trialHeaderTime').textContent = `${Number(access.usage?.tradeCount || 0)}/50`;
  } else if (entitlement.premium) {
    node.hidden = false; node.classList.add('premium');
    $('trialHeaderLabel').textContent = 'PREMIUM'; $('trialHeaderTime').textContent = 'АКТИВЕН';
  } else {
    node.hidden = true;
  }
  if (!trialCountdownTimer) trialCountdownTimer = setInterval(() => renderTrialAccessIndicator(), 1000);
}

function renderHeader() {
  renderTrialAccessIndicator();
  const connected = isConnected();
  const waitingForLogin = Boolean(state?.connection?.waitingForLogin && !connected);
  const reconnecting = Boolean(state?.connection?.requested && state?.connection?.reconnecting);
  $('headerConnection').classList.toggle('on', connected);
  $('headerConnection').classList.toggle('reconnecting', (reconnecting || waitingForLogin) && !connected);
  $('headerConnectionText').textContent = connected ? 'Подключено' : waitingForLogin ? 'Ожидание входа…' : reconnecting ? 'Переподключение…' : 'Не подключено';
  const view = accessDisplay();
  if ($('planName')) $('planName').textContent = view.plan;
  if ($('planStatus')) $('planStatus').textContent = view.status;
  if ($('planDescription')) $('planDescription').textContent = view.description;
  if ($('planCard')) $('planCard').className = `planCard ${view.code}`;
  for (const id of ['strategyPlanPill', 'builderPlanPill']) {
    if (!$(id)) continue;
    $(id).textContent = view.code === 'paused' ? 'PREMIUM · ПАУЗА' : view.badge;
    $(id).className = `planPill ${view.code}`;
  }
  const used = Number(access.usage?.tradeCount || 0);
  const max = access.limits?.maxDailyTrades;
  if ($('tradeLimitBadge')) $('tradeLimitBadge').textContent = max == null ? (['premium','trial'].includes(view.code) ? `${view.badge} · без лимита` : 'Без тарифного лимита') : `${used}/${max} сегодня`;
}

function renderAccount() {
  const connected = isConnected();
  const waitingForLogin = Boolean(state?.connection?.waitingForLogin && !connected);
  const reconnecting = Boolean(state?.connection?.requested && state?.connection?.reconnecting);
  const account = state?.account || {};
  const pnl = pnlView();
  const backgroundHold = isPocketBackgroundHold();
  $('accountTitle').textContent = connected ? 'Аккаунт подключён' : waitingForLogin ? 'Ожидание входа в Pocket Option' : reconnecting ? 'Восстанавливаем соединение' : 'Аккаунт не подключён';
  $('accountSubtitle').textContent = backgroundHold
    ? 'Вкладка Pocket Option сейчас на фоне. Аккаунт не сбрасывается; активный поток восстановится автоматически при возврате к вкладке.'
    : connected
      ? 'Торговое соединение текущей авторизованной вкладки Pocket Option активно.'
      : waitingForLogin
        ? 'Зеркало и рыночный поток уже доступны. Войдите в свой аккаунт — после появления UID расширение автоматически переключится на авторизованный торговый сокет.'
        : reconnecting
          ? 'Pocket Option обновил канал. Расширение автоматически ищет новое соединение и восстанавливает подписки.'
          : 'Откройте Pocket Option, дождитесь загрузки графика и нажмите кнопку подключения.';
  $('accountLive').textContent = backgroundHold ? 'BACKGROUND' : connected ? 'ONLINE' : waitingForLogin ? 'WAITING' : reconnecting ? 'RECONNECT' : 'OFFLINE';
  $('accountLive').classList.toggle('on', connected);
  $('accountLive').classList.toggle('reconnecting', (reconnecting || waitingForLogin) && !connected);
  $('accountUid').textContent = connected ? account.uid ?? '—' : '—';
  $('accountMode').textContent = connected ? account.mode || '—' : '—';
  $('accountBalance').textContent = connected ? formatMoney(account.balance, currentCurrency()) : '—';
  $('accountPnlLabel').textContent = pnl.title;
  $('accountPnl').textContent = connected ? pnl.value : '(0)';
  setClassState($('accountPnl'), connected ? pnl.className : 'neutral');
  $('connectAccount').disabled = accountConnectionBusy;
  $('connectAccount').setAttribute('aria-busy', String(accountConnectionBusy));
  $('disconnectAccount').disabled = accountConnectionBusy || (!pocketTab?.id && !state?.connection?.requested);
  $('disconnectAccount').setAttribute('aria-busy', String(accountConnectionBusy));
}

function connectionTileState(id, stateName) {
  const node = $(id);
  if (!node) return;
  node.classList.remove('ok', 'warn', 'error', 'off');
  node.classList.add(stateName);
}

function renderConnectionCenter() {
  if (!$('connectionCenter')) return;
  const connected = isConnected();
  const reconnecting = Boolean(state?.connection?.requested && state?.connection?.reconnecting);
  const accessView = accessDisplay();
  const localMode = isLocalExpansionMode();
  const serverOnline = !localMode && Boolean(serverState?.online);
  const serverReachable = !localMode && Boolean(serverState?.serverReachable);
  const subscriptions = Object.values(state?.market?.subscriptions || {});
  const selectedCount = selectedAssets.size;
  const selectedSubscriptions = subscriptions.filter((item) => selectedAssets.has(String(item?.asset || '')));
  const requestedSubscriptions = selectedSubscriptions.filter((item) => Boolean(item?.requested || item?.subscribed || item?.streamActive)).length;
  const liveSubscriptions = selectedSubscriptions.filter((item) => Boolean(item?.streamActive) && Number(item?.tickCount || 0) > 0).length;
  const strategyIds = Array.isArray(settings.autoTrade?.strategyIds) && settings.autoTrade.strategyIds.length
    ? settings.autoTrade.strategyIds.map(String)
    : [settings.autoTrade?.strategyId || settings.activeStrategyId].filter(Boolean).map(String);
  const strategyItems = tradeStrategies().filter((item) => strategyIds.includes(String(item.id)));
  const strategyReady = Boolean(strategyItems.length && strategyItems.every((item) => item.engineReady));
  const autoEnabled = Boolean(settings.autoTrade?.enabled);
  const autoProblem = ['error', 'blocked', 'stopped'].includes(String(autoStatus?.state || ''));

  const readiness = [connected, localMode || serverOnline, selectedCount > 0, strategyIds.length > 0];
  const readyCount = readiness.filter(Boolean).length;
  $('connectionReadiness').textContent = uiText(`${readyCount}/4 К ЗАПУСКУ`, `${readyCount}/4 READY`);
  $('connectionReadiness').classList.toggle('on', readyCount === readiness.length);

  const entitlement = currentEntitlement();
  const expiresAt = Date.parse(entitlement.expiresAt || '');
  const expiryText = Number.isFinite(expiresAt)
    ? uiText(`до ${new Date(expiresAt).toLocaleDateString('ru-RU')}`, `until ${new Date(expiresAt).toLocaleDateString('en-GB')}`)
    : '';
  $('connectionAccessStatus').textContent = accessView.code === 'paused' ? 'PREMIUM · ПАУЗА' : accessView.plan;
  $('connectionAccessText').textContent = ['premium','trial'].includes(accessView.code)
    ? (accessView.code === 'trial' ? `Осталось ${formatTrialRemaining(currentTrialRemaining(entitlement))}` : (expiryText || uiText('Все функции доступны', 'All features available')))
    : accessView.code === 'paused'
      ? uiText('Доступ временно приостановлен', 'Access temporarily paused')
      : accessView.code === 'blocked'
        ? uiText('Обратитесь в поддержку', 'Contact support')
        : accessView.code === 'affiliate'
          ? uiText('Только DEMO: 30 активов · 50 сделок', 'DEMO only: 30 assets · 50 trades')
          : accessView.code === 'expired'
            ? uiText('Требуется регистрация', 'Registration required')
            : uiText('TRIAL активируется автоматически', 'Trial activates automatically');
  connectionTileState('connectionAccessTile', accessView.code === 'blocked' ? 'error' : ['paused','expired'].includes(accessView.code) ? 'warn' : 'ok');

  $('connectionServerStatus').textContent = localMode
    ? uiText('Локально', 'Local')
    : runtimeCompatibility.mixed
      ? uiText('Перезапуск', 'Restart required')
      : serverOnline
        ? uiText('Онлайн', 'Online')
        : serverReachable
          ? uiText('Сервер доступен', 'Server reachable')
          : uiText('Офлайн', 'Offline');
  $('connectionServerText').textContent = localMode
    ? uiText('Внешний сервер не используется · локальный режим активен', 'External server is not used · local mode active')
    : serverOnline
      ? uiText('Лицензия и сигналы доступны', 'Licence and signals available')
      : friendlyServerConnectionError(serverState?.lastError);
  connectionTileState('connectionServerTile', localMode ? 'ok' : runtimeCompatibility.mixed ? 'warn' : serverOnline ? 'ok' : serverReachable ? 'warn' : serverState ? 'error' : 'warn');

  $('connectionAssetsStatus').textContent = uiText(`${selectedCount} выбрано`, `${selectedCount} selected`);
  $('connectionAssetsText').textContent = selectedCount
    ? uiText(`${liveSubscriptions}/${selectedCount} live · запросы ${requestedSubscriptions}/${selectedCount}`, `${liveSubscriptions}/${selectedCount} live · requested ${requestedSubscriptions}/${selectedCount}`)
    : uiText('Выберите активы для анализа', 'Select assets for analysis');
  connectionTileState('connectionAssetsTile', !selectedCount ? 'off' : liveSubscriptions === selectedCount ? 'ok' : liveSubscriptions > 0 || connected ? 'warn' : 'off');

  $('connectionStrategiesStatus').textContent = !strategyIds.length
    ? uiText('Не выбраны', 'Not selected')
    : strategyIds.length === 1
      ? (strategyItems[0]?.title || uiText('1 стратегия', '1 strategy'))
      : uiText(`${strategyIds.length} выбрано`, `${strategyIds.length} selected`);
  $('connectionStrategiesText').textContent = !strategyIds.length
    ? uiText('Выберите режим анализа', 'Select an analysis mode')
    : strategyReady
      ? uiText('Серверные движки готовы', 'Server engines ready')
      : uiText('Ожидание готовности движка', 'Waiting for engine readiness');
  connectionTileState('connectionStrategiesTile', !strategyIds.length ? 'off' : strategyReady ? 'ok' : 'warn');

  const autoTitle = !autoEnabled
    ? uiText('Выключена', 'Disabled')
    : autoProblem
      ? uiText('Требует внимания', 'Needs attention')
      : uiText('Включена', 'Enabled');
  $('connectionAutoStatus').textContent = autoTitle;
  $('connectionAutoText').textContent = !autoEnabled
    ? uiText('Бот не открывает сделки', 'The bot does not open trades')
    : autoProblem
      ? (autoStatus?.message || uiText('Проверьте параметры запуска', 'Check launch settings'))
      : (autoStatus?.message || uiText('Автоматическое исполнение активно', 'Automatic execution is active'));
  connectionTileState('connectionAutoTile', !autoEnabled ? 'off' : autoProblem ? 'error' : 'ok');

  const closed = scopedLedgerClosedDeals();
  const open = currentOpenDeals();
  const todayKey = statisticsMoscowDayKey();
  const todayDeals = closed.filter((deal) => {
    const key = statisticsLocalDayKey(deal.closeTimestamp ?? deal.openTimestamp ?? deal.closedAt ?? deal.openedAt, deal, 'close');
    return key === todayKey;
  });
  const summary = summarizeDealList(todayDeals);
  $('connectionTodayTotal').textContent = String(summary.total);
  $('connectionTodayWinRate').textContent = `${formatNumber(summary.winRate, 1)}%`;
  $('connectionTodayNet').textContent = formatMoney(summary.net, currentCurrency(), true);
  setClassState($('connectionTodayNet'), summary.net < 0 ? 'loss' : summary.net > 0 ? 'profit' : 'neutral');
  $('connectionTodayOpen').textContent = String(open.length);

  const unread = notificationHistory.find((item) => !item.read);
  const noticeCard = $('connectionNoticeCard');
  noticeCard.hidden = !unread;
  if (unread) {
    $('connectionNoticeTitle').textContent = unread.title || 'Pocket TRADE ROBOT';
    $('connectionNoticeText').textContent = unread.message || uiText('Откройте центр уведомлений.', 'Open the notification centre.');
    $('connectionNoticeTime').textContent = unread.createdAt ? formatTime(Date.parse(unread.createdAt)) : '—';
  }

  const issues = [];
  if (reconnecting) issues.push(uiText('выполняется восстановление подключения Pocket Option', 'Pocket Option connection is being restored'));
  else if (state?.connection?.requested && !connected) issues.push(uiText('аккаунт Pocket Option не подключён', 'Pocket Option account is not connected'));
  if (runtimeCompatibility.mixed) {
    issues.push(uiText('требуется перезапустить расширение после обновления файлов', 'restart the extension after updating its files'));
  } else if (serverState && !serverOnline && !localMode) {
    issues.push(serverReachable
      ? uiText('сервер доступен, обновляется сессия текущего UID', 'the server is reachable and is refreshing the current UID session')
      : uiText('сервер Pocket TRADE ROBOT временно недоступен', 'Pocket TRADE ROBOT server is temporarily unavailable'));
  }
  if (autoEnabled && !selectedCount) issues.push(uiText('для автоторговли не выбраны активы', 'no assets are selected for auto trading'));
  if (autoEnabled && !strategyIds.length) issues.push(uiText('для автоторговли не выбрана стратегия', 'no strategy is selected for auto trading'));
  if (autoEnabled && autoProblem) issues.push(autoStatus?.message || uiText('автоторговля остановлена ошибкой или лимитом', 'auto trading stopped due to an error or limit'));
  const issueCard = $('connectionIssueCard');
  issueCard.hidden = !issues.length;
  if (issues.length) {
    $('connectionIssueTitle').textContent = uiText('Требуется внимание', 'Attention required');
    $('connectionIssueText').textContent = `${issues.map((item) => String(item).replace(/[.!]+$/, '')).join(' · ')}.`;
  }
}

function premiumStrategiesAvailable() {
  const entitlement = currentEntitlement();
  const features = entitlement.features || {};
  return Boolean(entitlement.premium || access.premium || features.premiumStrategies || features.ai);
}

function strategyLockedForAccess(item) {
  if (!item) return true;
  if (item.available === false) return true;
  const aiAllowed = Boolean(access.entitlement?.features?.ai ?? access.premium);
  if (item.ai && !aiAllowed) return true;
  if (item.premium && !premiumStrategiesAvailable()) return true;
  return false;
}

function serverStrategies() {
  const remote = Array.isArray(serverState?.strategies) && serverState.strategies.length ? serverState.strategies : [];
  const byId = new Map();

  // Локальный каталог всегда добавляется первым. Это защищает вкладку
  // «Автоторговля» от ситуации, когда серверный каталог ещё не обновился или
  // пользователь не заходил во вкладку «Стратегии»: Premium M1-стратегии всё
  // равно видны сразу после подтверждения Premium.
  for (const item of BUILT_IN_STRATEGIES) {
    byId.set(String(item.id), {
      ...item,
      available: item.premium || item.ai ? premiumStrategiesAvailable() : true,
      premium: Boolean(item.premium || item.ai),
      ai: Boolean(item.ai),
      custom: false,
      implemented: Boolean(item.implemented),
      engineReady: Boolean(item.engineReady)
    });
  }

  for (const remoteItem of remote) {
    const id = String(remoteItem.id || remoteItem.strategy_id || '').trim();
    if (!id) continue;
    const local = byId.get(id) || BUILT_IN_STRATEGIES.find((item) => item.id === id) || {};
    const custom = Boolean(remoteItem.custom || id.startsWith('custom-'));
    const premium = Boolean(remoteItem.premium ?? local.premium ?? remoteItem.ai ?? local.ai);
    byId.set(id, {
      ...local,
      ...remoteItem,
      id,
      title: remoteItem.title || remoteItem.name || local.title || id,
      description: remoteItem.description || local.description || (custom ? 'Пользовательская стратегия' : 'Серверная стратегия Pocket TRADE ROBOT'),
      icon: custom ? '✦' : (local.icon || (remoteItem.ai ? 'AI' : '↗')),
      color: custom ? 'custom' : (local.color || (remoteItem.ai ? 'violet' : 'blue')),
      badge: custom ? 'Моя стратегия' : remoteItem.ai ? 'AI · PREMIUM' : premium ? 'PREMIUM' : 'Базовая',
      custom,
      premium,
      ai: Boolean(remoteItem.ai ?? local.ai),
      available: remoteItem.available === false ? false : (premium ? premiumStrategiesAvailable() : true),
      implemented: Boolean(remoteItem.implemented ?? local.implemented ?? true),
      engineReady: Boolean(remoteItem.engineReady ?? local.engineReady ?? true)
    });
  }

  return [...byId.values()];
}

function localStrategyCatalogItem(item) {
  const rawId = String(item?.id || '').trim();
  const rawTitle = String(item?.title || item?.name || 'Imported strategy').trim();
  const id = rawId || `draft-${makeLocalId()}`;
  const serverSaved = id.startsWith('custom-') && item?.serverSaved !== false;
  const needsServerSave = !serverSaved;
  const canUseCustom = Boolean(access.entitlement?.features?.strategyBuilder ?? access.premium);
  const title = rawTitle || 'Imported strategy';
  const cfg = sanitizeCustomStrategyGlobalFields(item?.config && typeof item.config === 'object' ? item.config : item);
  return {
    id,
    title,
    name: title,
    description: item?.description || (serverSaved
      ? 'Импортированная пользовательская стратегия, сохранённая на сервере'
      : 'Импортированный черновик. Нажмите «Сохранить/Выбрать», чтобы опубликовать её на сервере и добавить в автоторговлю.'),
    icon: '✦',
    color: serverSaved ? 'custom' : 'violet',
    badge: serverSaved ? 'Моя стратегия' : 'Черновик · сохранить',
    custom: true,
    premium: true,
    needsServerSave,
    available: canUseCustom,
    implemented: serverSaved,
    engineReady: serverSaved,
    config: cfg
  };
}

function tradeStrategies() {
  const remote = serverStrategies();
  const byId = new Map(remote.map((item) => [String(item.id), item]));
  const local = Array.isArray(settings.builderStrategies) ? settings.builderStrategies : [];
  for (const item of local) {
    const normalized = localStrategyCatalogItem(item);
    if (!normalized) continue;
    const id = String(normalized.id);
    const existing = byId.get(id);
    // A server may return a UUID without `custom:true`. Local builder membership is
    // authoritative: preserve the server availability while keeping custom origin/config.
    byId.set(id, existing ? { ...existing, ...normalized, custom: true, config: normalized.config || existing.config } : normalized);
  }
  return [...byId.values()];
}

const AUTO_PROFILE_LOCK_CONTROL_IDS = Object.freeze([
  // These controls belong to the strategy currently in focus. Amount, risk and
  // Martingale remain global.
  'autoPeriod','autoCandleOffset','autoCooldown','autoDuration'
]);

function selectedStrategyIdsForAuto(auto = settings.autoTrade || {}) {
  return Array.isArray(auto.strategyIds) && auto.strategyIds.length
    ? [...new Set(auto.strategyIds.map(String).filter(Boolean))]
    : [auto.strategyId || settings.activeStrategyId].filter(Boolean).map(String);
}

function autoStrategyItem(strategyId) {
  return tradeStrategies().find((item) => String(item?.id || '') === String(strategyId || '')) || null;
}

function autoStrategyConfig(strategyId) {
  const item = autoStrategyItem(strategyId);
  return item?.config && typeof item.config === 'object' ? item.config : item?.custom ? item : null;
}

function isConstructorStrategyItem(strategyId, item = null) {
  const id = String(strategyId || '').trim();
  if (!id) return false;
  const strategyItem = item || autoStrategyItem(id);
  const source = String(strategyItem?.source || strategyItem?.strategySource || strategyItem?.origin || strategyItem?.kind || strategyItem?.type || '').toLowerCase();
  const local = Array.isArray(settings.builderStrategies) ? settings.builderStrategies : [];
  return id.startsWith('custom-')
    || id.startsWith('draft-')
    || local.some((entry) => String(entry?.id || entry?.strategy_id || '') === id)
    || strategyItem?.custom === true
    || strategyItem?.isCustom === true
    || strategyItem?.userStrategy === true
    || ['custom','constructor','builder','imported','personal','user'].includes(source);
}

function normalizeStoredStrategyProfiles(rawProfiles, fallbackAuto = {}) {
  const source = rawProfiles && typeof rawProfiles === 'object' && !Array.isArray(rawProfiles) ? rawProfiles : {};
  const result = {};
  for (const [rawId, rawProfile] of Object.entries(source)) {
    const id = String(rawId || '').trim();
    if (!id || !rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue;
    const candleOffset = normalizeCandleOffset(rawProfile.candleOffset, rawProfile.candleMode ?? fallbackAuto.candleMode);
    result[id] = {
      period: normalizeAnalysisPeriodSeconds(rawProfile.period ?? rawProfile.timeframe ?? fallbackAuto.period, 60),
      duration: normalizeExpirationSeconds(rawProfile.duration ?? rawProfile.expiration ?? fallbackAuto.duration, 60),
      candleOffset,
      candleMode: candleOffset === 0 ? 'current' : 'closed',
      cooldown: Math.max(0, Number.isFinite(Number(rawProfile.cooldown)) ? Number(rawProfile.cooldown) : Number(fallbackAuto.cooldown) || 0)
    };
  }
  return result;
}

function recommendedBuiltInExecutionProfile(strategyId, periodValue, durationValue) {
  const id = String(strategyId || '').trim();
  let period = normalizeAnalysisPeriodSeconds(periodValue, 60);
  let duration = normalizeExpirationSeconds(durationValue, period);
  if (['builtin-trend', 'builtin-otc', 'builtin-smart', 'builtin-ai'].includes(id)) {
    // These strategies use one execution scale. Keep the supported 5s -> 3s
    // fast profile; otherwise match expiration to the selected analysis TF.
    if (!(period === 5 && duration === 3)) duration = period;
  } else if (id === 'builtin-pattern') {
    period = 5;
    duration = 5;
  } else if (id === 'builtin-smartflow') {
    period = 60;
    if (![120, 180].includes(duration)) duration = 180;
  } else if (id === 'builtin-liquidity') {
    period = 60;
    duration = 120;
  }
  return { period, duration };
}

function autoStrategyExecutionProfile(strategyId, auto = settings.autoTrade || {}) {
  const id = String(strategyId || '').trim();
  const item = autoStrategyItem(id);
  const config = autoStrategyConfig(id) || {};
  const storedProfiles = normalizeStoredStrategyProfiles(auto.strategyProfiles, auto);
  const stored = storedProfiles[id] || {};
  const fallbackPeriod = normalizeAnalysisPeriodSeconds(auto.period ?? settings.period, 60);
  const fallbackDuration = normalizeExpirationSeconds(auto.duration ?? settings.duration, fallbackPeriod);
  const fallbackOffset = normalizeCandleOffset(auto.candleOffset, auto.candleMode);
  const fallbackCooldown = Math.max(0, Number(auto.cooldown) || 0);

  if (isConstructorStrategyItem(id, item)) {
    const candleOffset = normalizeCandleOffset(config.candleOffset, config.candleMode);
    return {
      strategyId: id,
      custom: true,
      period: normalizeAnalysisPeriodSeconds(config.timeframe, 60),
      duration: inferCustomStrategyExpiration(config, item?.title || item?.name || ''),
      candleOffset,
      candleMode: candleOffset === 0 ? 'current' : 'closed',
      cooldown: Math.max(0, Number.isFinite(Number(config.cooldown)) ? Number(config.cooldown) : 0)
    };
  }

  let period = normalizeAnalysisPeriodSeconds(stored.period ?? fallbackPeriod, fallbackPeriod);
  let duration = normalizeExpirationSeconds(stored.duration ?? fallbackDuration, fallbackDuration);
  if (id === 'builtin-pattern') {
    period = 5;
    duration = 5;
  } else if (id === 'builtin-smartflow') {
    period = 60;
    duration = [120, 180].includes(duration)
      ? duration
      : ([120, 180].includes(fallbackDuration) ? fallbackDuration : 180);
  } else if (id === 'builtin-liquidity') {
    period = 60;
    duration = 120;
  } else if (!['builtin-trend','builtin-otc','builtin-smart','builtin-ai'].includes(id)) {
    const explicitPeriod = Number(config.timeframe ?? config.analysisPeriod ?? config.period);
    const explicitDuration = Number(config.expiration ?? config.duration ?? config.execution?.duration ?? config.execution?.expiration);
    if (Number.isFinite(explicitPeriod) && explicitPeriod > 0) period = normalizeAnalysisPeriodSeconds(explicitPeriod, period);
    if (Number.isFinite(explicitDuration) && explicitDuration > 0) duration = normalizeExpirationSeconds(explicitDuration, duration);
  }
  const candleOffset = normalizeCandleOffset(stored.candleOffset ?? fallbackOffset, stored.candleMode ?? auto.candleMode);
  return {
    strategyId: id,
    custom: false,
    period,
    duration,
    candleOffset,
    candleMode: candleOffset === 0 ? 'current' : 'closed',
    cooldown: Math.max(0, Number.isFinite(Number(stored.cooldown)) ? Number(stored.cooldown) : fallbackCooldown)
  };
}

function repairedSelectedAutoStrategyProfiles(auto = settings.autoTrade || {}, strategyIds = selectedStrategyIdsForAuto(auto)) {
  const ids = [...new Set((strategyIds || []).map(String).filter(Boolean))];
  const profiles = normalizeStoredStrategyProfiles(auto.strategyProfiles, auto);
  let changed = false;
  for (const id of ids) {
    const item = autoStrategyItem(id);
    if (isConstructorStrategyItem(id, item)) continue;
    const current = autoStrategyExecutionProfile(id, { ...auto, strategyProfiles: profiles });
    const recommended = recommendedBuiltInExecutionProfile(id, current.period, current.duration);
    const nextProfile = {
      ...current,
      period: recommended.period,
      duration: recommended.duration
    };
    const previous = profiles[id];
    if (!previous
      || Number(previous.period) !== nextProfile.period
      || Number(previous.duration) !== nextProfile.duration
      || Number(previous.candleOffset) !== nextProfile.candleOffset
      || Number(previous.cooldown) !== nextProfile.cooldown) changed = true;
    profiles[id] = nextProfile;
  }
  const primary = ids[0] ? autoStrategyExecutionProfile(ids[0], { ...auto, strategyProfiles: profiles }) : null;
  return {
    changed,
    profiles,
    auto: {
      ...auto,
      strategyProfiles: profiles,
      profileSettingsVersion: 1,
      ...(primary ? {
        period: primary.period,
        duration: primary.duration,
        candleOffset: primary.candleOffset,
        candleMode: primary.candleMode,
        cooldown: primary.cooldown
      } : {})
    }
  };
}

function applyAutoProfileToVisibleControls(strategyId, auto) {
  const id = String(strategyId || '').trim();
  if (!id || String(focusedAutoProfileStrategyId || '') !== id) return;
  const profile = autoStrategyExecutionProfile(id, auto);
  if ($('autoPeriod')) $('autoPeriod').value = String(profile.period);
  if ($('autoDuration')) $('autoDuration').value = String(profile.duration);
  if ($('autoCandleOffset')) $('autoCandleOffset').value = String(profile.candleOffset);
  if ($('autoCooldown')) $('autoCooldown').value = String(profile.cooldown);
}

async function autoFixSelectedStrategyCompatibility({ notify = false, persist = true, updateControls = true, auto = null } = {}) {
  const base = auto && typeof auto === 'object' ? auto : (settings.autoTrade || {});
  const ids = selectedStrategyIdsForAuto(base);
  const repaired = repairedSelectedAutoStrategyProfiles(base, ids);
  settings.autoTrade = repaired.auto;
  if (updateControls && ids[0]) {
    if (!focusedAutoProfileStrategyId || !ids.includes(String(focusedAutoProfileStrategyId))) focusedAutoProfileStrategyId = ids[0];
    applyAutoProfileToVisibleControls(String(focusedAutoProfileStrategyId || ids[0]), repaired.auto);
  }
  if (persist && repaired.changed) {
    await saveSettings({
      autoTrade: repaired.auto,
      period: repaired.auto.period
    });
  }
  if (repaired.changed && notify) {
    const primary = ids[0] ? autoStrategyItem(ids[0]) : null;
    toast(`${primary?.title || 'Стратегия'}: TF анализа и экспирация согласованы автоматически.`, 'ok');
  }
  return repaired;
}

function autoStrategyProfileLocks(strategyId) {
  const id = String(strategyId || '').trim();
  const custom = isConstructorStrategyItem(id, autoStrategyItem(id));
  return {
    autoPeriod: custom || ['builtin-pattern','builtin-smartflow','builtin-liquidity'].includes(id),
    autoDuration: custom || ['builtin-pattern','builtin-liquidity'].includes(id),
    autoCandleOffset: custom,
    autoCooldown: custom
  };
}

function autoStrategyProfilesFromForm(auto = settings.autoTrade || {}) {
  const profiles = normalizeStoredStrategyProfiles(auto.strategyProfiles, auto);
  const id = String(focusedAutoProfileStrategyId || '').trim();
  if (!id || isConstructorStrategyItem(id, autoStrategyItem(id))) return profiles;
  const current = autoStrategyExecutionProfile(id, { ...auto, strategyProfiles: profiles });
  let period = normalizeAnalysisPeriodSeconds($('autoPeriod')?.value ?? current.period, current.period);
  let duration = normalizeExpirationSeconds($('autoDuration')?.value ?? current.duration, current.duration);
  if (id === 'builtin-pattern') {
    period = 5;
    duration = 5;
  } else if (id === 'builtin-smartflow') {
    period = 60;
    if (![120, 180].includes(duration)) duration = 180;
  } else if (id === 'builtin-liquidity') {
    period = 60;
    duration = 120;
  }
  const candleOffset = normalizeCandleOffset($('autoCandleOffset')?.value ?? current.candleOffset, current.candleMode);
  profiles[id] = {
    period,
    duration,
    candleOffset,
    candleMode: candleOffset === 0 ? 'current' : 'closed',
    cooldown: Math.max(0, Number($('autoCooldown')?.value) || 0)
  };
  return profiles;
}

function autoExecutionSettingsSnapshot(auto = settings.autoTrade || {}) {
  const strategyProfiles = autoStrategyProfilesFromForm(auto);
  const recoveryEnabledNode = $('autoRecoveryEnabled');
  const recoveryStepsNode = $('autoRecoverySteps');
  const formRecoveryAvailable = Boolean(recoveryEnabledNode && recoveryStepsNode && $('autoRecoveryMultiplier1'));
  const recoverySteps = formRecoveryAvailable
    ? (recoveryEnabledNode.checked ? Math.min(5, Math.max(1, Number(recoveryStepsNode.value) || 1)) : 0)
    : (auto?.recoveryMode === 'steps' ? Math.min(5, Math.max(0, Number(auto?.recoverySteps) || 0)) : 0);
  const recoveryPlan = formRecoveryAvailable ? recoveryPlanFromForm() : normalizeRecoveryPlan(auto?.recoveryPlan, auto);
  return {
    ...auto,
    period: normalizeAnalysisPeriodSeconds(auto?.period ?? settings.period, 60),
    duration: normalizeExpirationSeconds(auto?.duration ?? settings.duration, 60),
    strategyProfiles,
    profileSettingsVersion: 1,
    recoveryMode: recoverySteps > 0 ? 'steps' : 'off',
    recoverySteps,
    recoveryPlan,
    recoveryFollowSignal: formRecoveryAvailable ? $('autoRecoveryFollowSignal')?.checked === true : auto?.recoveryFollowSignal === true
  };
}

function activeAutoExecutionDurations(auto = settings.autoTrade || {}) {
  const snapshot = autoExecutionSettingsSnapshot(auto);
  const durations = selectedStrategyIdsForAuto(snapshot).map((id) => {
    const item = autoStrategyItem(id);
    if (isConstructorStrategyItem(id, item)) {
      return inferCustomStrategyExpiration(autoStrategyConfig(id) || {}, item?.title || item?.name || '');
    }
    const compatibility = autoStrategyCompatibility(id, snapshot, item);
    return compatibility.compatible ? compatibility.duration : null;
  }).filter((value) => Number.isFinite(value) && value > 0);
  return [...new Set(durations.length ? durations : [normalizeExpirationSeconds(snapshot.duration, 60)])];
}

function autoStrategyCompatibility(strategyId, auto = settings.autoTrade || {}, item = null) {
  const id = String(strategyId || '').trim();
  const strategyItem = item || autoStrategyItem(id);
  const custom = isConstructorStrategyItem(id, strategyItem);
  if (!id) return { compatible: false, custom, period: null, duration: null, durations: [], requirement: 'выберите стратегию' };
  if (custom) {
    const profile = autoStrategyExecutionProfile(id, auto);
    const period = profile.period;
    const duration = profile.duration;
    return { compatible: true, custom: true, period, duration, durations: [duration], requirement: 'индивидуальный профиль стратегии' };
  }

  const profile = autoStrategyExecutionProfile(id, auto);
  const period = profile.period;
  const duration = profile.duration;
  let compatible = true;
  let requirement = '';
  let durations = [duration];

  if (['builtin-trend','builtin-otc','builtin-smart'].includes(id)) {
    compatible = period === duration || (period === 5 && duration === 3);
    requirement = 'TF анализа = экспирации; исключение: анализ 5с → экспирация 3с';
  } else if (id === 'builtin-ai') {
    compatible = period === duration || (period === 5 && duration === 3);
    requirement = 'TF анализа = экспирации; исключение: анализ 5с → экспирация 3с';
  } else if (id === 'builtin-pattern') {
    compatible = period === 5 && duration === 5;
    requirement = 'только анализ 5с и экспирация 5с';
    durations = [5];
  } else if (id === 'builtin-smartflow') {
    compatible = period === 60 && [120, 180].includes(duration);
    requirement = 'анализ M1 и экспирация M2 или M3';
    durations = [120, 180];
  } else if (id === 'builtin-liquidity') {
    compatible = period === 60 && duration === 120;
    requirement = 'анализ M1 и экспирация M2';
    durations = [120];
  }

  return { compatible, custom: false, period, duration, durations, requirement };
}

function renderAutoStrategyCompatibilityNotice() {
  const box = $('autoStrategyCompatibilityNotice');
  const text = $('autoStrategyCompatibilityText');
  if (!box || !text) return;
  box.hidden = !autoCompatibilityNotice?.message;
  if (!box.hidden) text.textContent = autoCompatibilityNotice.message;
}

function incompatibleSelectedAutoStrategies(auto = settings.autoTrade || {}) {
  const snapshot = autoExecutionSettingsSnapshot(auto);
  return selectedStrategyIdsForAuto(auto)
    .map((id) => {
      const item = autoStrategyItem(id);
      const compatibility = autoStrategyCompatibility(id, snapshot, item);
      return { id, item, compatibility };
    })
    .filter((entry) => !entry.compatibility.compatible);
}

async function reconcileAutoStrategyCompatibility({ notify = true, persist = true, clearNoticeWhenValid = false } = {}) {
  const initialSnapshot = autoExecutionSettingsSnapshot(settings.autoTrade || {});
  const repair = await autoFixSelectedStrategyCompatibility({
    notify: false,
    persist: false,
    updateControls: true,
    auto: initialSnapshot
  });
  const snapshot = autoExecutionSettingsSnapshot(repair.auto);
  settings.autoTrade = {
    ...repair.auto,
    strategyProfiles: snapshot.strategyProfiles,
    profileSettingsVersion: 1
  };
  const incompatible = incompatibleSelectedAutoStrategies(snapshot);
  if (!incompatible.length) {
    if (clearNoticeWhenValid) autoCompatibilityNotice = null;
    if (persist && repair.changed) {
      await saveSettings({ autoTrade: settings.autoTrade, period: settings.autoTrade.period });
    }
    renderAutoStrategyCompatibilityNotice();
    renderAutoStrategyOptions();
    updateAutoStrategyExecutionProfileUi();
    if (notify && repair.changed) toast('TF анализа и экспирация выбранной стратегии согласованы автоматически.', 'ok');
    return [];
  }

  settings.autoTrade = {
    ...settings.autoTrade,
    strategyProfiles: snapshot.strategyProfiles,
    profileSettingsVersion: 1
  };

  const details = incompatible.map((entry) => `${entry.item?.title || entry.id}: ${entry.compatibility.requirement}`).join(' · ');
  autoCompatibilityNotice = {
    message: `Настройки пока несовместимы: ${details}. Стратегии сохранены — завершите выбор TF и экспирации.`
  };

  if (persist) {
    await saveSettings({
      autoTrade: settings.autoTrade
    });
  }
  renderStrategies();
  renderAutoStrategyOptions();
  updateAutoStrategyExecutionProfileUi();
  renderAutoStrategyCompatibilityNotice();
  if (notify) toast(autoCompatibilityNotice.message, 'error');
  return incompatible;
}

function autoStrategyAnalysisPeriod(strategyId, auto = settings.autoTrade || {}) {
  return autoStrategyExecutionProfile(strategyId, auto).period;
}

function autoStrategyCandleOffset(strategyId, auto = settings.autoTrade || {}) {
  return autoStrategyExecutionProfile(strategyId, auto).candleOffset;
}

function autoRuleAnalysisPeriod(value, basePeriod) {
  const base = normalizeAnalysisPeriodSeconds(basePeriod, 60);
  const raw = String(value ?? 'current').trim().toLowerCase();
  if (!raw || ['current','same','same_tf','analysis'].includes(raw)) return base;
  if (raw === '2x') return normalizeAnalysisPeriodSeconds(base * 2, base);
  if (raw === '5x') return normalizeAnalysisPeriodSeconds(base * 5, base);
  if (raw === '15m') return 900;
  if (raw === '1h') return 3600;
  if (raw === '4h') return 14400;
  if (raw === 'd1' || raw === '1d') return 86400;
  return normalizeAnalysisPeriodSeconds(raw, base);
}

function autoRequiredTargetPeriods(strategyId, basePeriod) {
  const config = autoStrategyConfig(strategyId);
  const periods = [normalizeAnalysisPeriodSeconds(basePeriod, 60)];
  for (const rule of Array.isArray(config?.rules) ? config.rules : []) {
    if (rule && typeof rule === 'object') periods.push(autoRuleAnalysisPeriod(rule.timeframe, basePeriod));
  }
  return [...new Set(periods.filter((value) => Number.isFinite(value) && value > 0))];
}

function autoSubscriptionPlan(auto = settings.autoTrade || {}) {
  const ids = selectedStrategyIdsForAuto(auto);
  const strategyPeriods = Object.fromEntries(ids.map((id) => [id, autoStrategyAnalysisPeriod(id, auto)]));
  const offsets = Object.fromEntries(ids.map((id) => [id, autoStrategyCandleOffset(id, auto)]));
  const requiredPeriodSet = new Set();
  for (const id of ids) {
    const sourcePeriod = Number(strategyPeriods[id]) || 60;
    requiredPeriodSet.add(sourcePeriod);
    autoRequiredTargetPeriods(id, sourcePeriod).forEach((period) => requiredPeriodSet.add(period));
  }
  if (!requiredPeriodSet.size) requiredPeriodSet.add(normalizeAnalysisPeriodSeconds(auto.period, 60));
  const requiredPeriods = [...requiredPeriodSet]
    .map((period) => normalizeAnalysisPeriodSeconds(period, 60))
    .filter((period) => FULL_MARKET_HISTORY_PERIODS.includes(period))
    .sort((a, b) => a - b);
  const primaryPeriod = requiredPeriods[0] || 60;
  const historyOffsets = Object.fromEntries(requiredPeriods.map((period) => [period, 180]));
  for (const id of ids) {
    const sourcePeriod = Number(strategyPeriods[id]) || primaryPeriod;
    const targetCandles = Number(offsets[id]) === -2 ? 61 : 60;
    let requiredHistory = 180;
    for (const requiredTarget of autoRequiredTargetPeriods(id, sourcePeriod)) {
      if (requiredTarget < sourcePeriod || requiredTarget % sourcePeriod !== 0) continue;
      const ratio = Math.max(1, requiredTarget / sourcePeriod);
      requiredHistory = Math.max(requiredHistory, Math.ceil((targetCandles + 1) * ratio) + 4);
    }
    historyOffsets[sourcePeriod] = Math.min(5000, Math.max(Number(historyOffsets[sourcePeriod]) || 0, requiredHistory));
  }
  return {
    sourcePeriod: primaryPeriod,
    primaryPeriod,
    requiredPeriods,
    historyOffsets,
    historyOffset: Math.max(...Object.values(historyOffsets).map(Number).filter(Number.isFinite), 180),
    periods: strategyPeriods,
    offsets
  };
}

function updateAutoStrategyExecutionProfileUi() {
  const ids = selectedStrategyIdsForAuto(settings.autoTrade || {});
  if (!focusedAutoProfileStrategyId || !ids.includes(String(focusedAutoProfileStrategyId))) {
    focusedAutoProfileStrategyId = ids[0] || null;
  }
  const focusedId = String(focusedAutoProfileStrategyId || '');
  const focusedItem = focusedId ? autoStrategyItem(focusedId) : null;
  const focusedCustom = Boolean(focusedId && isConstructorStrategyItem(focusedId, focusedItem));
  const focusedProfile = focusedId ? autoStrategyExecutionProfile(focusedId, settings.autoTrade || {}) : null;
  const locks = autoStrategyProfileLocks(focusedId);
  const customCount = ids.filter((id) => isConstructorStrategyItem(id, autoStrategyItem(id))).length;
  const mixed = customCount > 0 && customCount < ids.length;
  const notice = $('autoStrategyProfileNotice');
  if (notice) {
    notice.hidden = ids.length === 0;
    notice.classList.toggle('mixed', mixed);
    if (focusedCustom) {
      notice.innerHTML = `<b>${escapeHtml(uiText('🔒 Индивидуальный профиль', '🔒 Individual profile'))}: ${escapeHtml(focusedItem?.title || focusedId)}</b><span>${escapeHtml(uiText(
        'TF анализа, экспирация, свеча и пауза берутся из конструктора и не могут быть перезаписаны глобальными настройками.',
        'Analysis timeframe, expiration, candle and cooldown come from the builder and cannot be overwritten by global settings.'
      ))}</span>`;
    } else if (focusedId) {
      const compatibility = autoStrategyCompatibility(focusedId, settings.autoTrade || {}, focusedItem);
      notice.innerHTML = compatibility.compatible
        ? `<b>${escapeHtml(uiText('📌 Индивидуальный профиль', '📌 Individual profile'))}: ${escapeHtml(focusedItem?.title || focusedId)}</b><span>${escapeHtml(uiText(
          'Сейчас редактируются только параметры этой стратегии. Нажмите на другую выбранную стратегию, чтобы открыть её профиль.',
          'Only this strategy profile is being edited. Click another selected strategy to open its profile.'
        ))}</span>`
        : `<b>${escapeHtml(uiText('⛔ Недоступно', '⛔ Unavailable'))}: ${escapeHtml(focusedItem?.title || focusedId)}</b><span>${escapeHtml(uiText('Нужно', 'Required'))}: ${escapeHtml(compatibility.requirement)}. ${escapeHtml(uiText(
          'Стратегия останется выбранной, но не будет исполняться до исправления настроек.',
          'The strategy remains selected but will not run until its profile is corrected.'
        ))}</span>`;
    }
  }

  AUTO_PROFILE_LOCK_CONTROL_IDS.forEach((id) => {
    const control = $(id);
    if (!control) return;
    control.disabled = Boolean(locks[id]);
    control.title = locks[id]
      ? (focusedCustom
        ? uiText('Параметр сохранён внутри выбранной пользовательской стратегии.', 'This setting is stored in the selected custom strategy.')
        : uiText('Этот параметр зафиксирован правилами выбранной базовой стратегии.', 'This setting is fixed by the selected built-in strategy.'))
      : `${uiText('Индивидуальный параметр стратегии', 'Individual strategy setting')} ${focusedItem?.title || focusedId || ''}`;
  });

  const profileSignature = focusedProfile
    ? JSON.stringify([focusedId, focusedProfile.period, focusedProfile.duration, focusedProfile.candleOffset, focusedProfile.cooldown])
    : '';
  const workspace = $('autoTradeWorkspace');
  if (workspace && workspace.dataset.loadedStrategyProfile !== profileSignature) {
    if ($('autoPeriod') && focusedProfile) $('autoPeriod').value = String(focusedProfile.period);
    if ($('autoDuration') && focusedProfile) $('autoDuration').value = String(focusedProfile.duration);
    if ($('autoCandleOffset') && focusedProfile) $('autoCandleOffset').value = String(focusedProfile.candleOffset);
    if ($('autoCooldown') && focusedProfile) $('autoCooldown').value = String(focusedProfile.cooldown);
    workspace.dataset.loadedStrategyProfile = profileSignature;
  }

  const durationField = $('autoDurationField');
  if (durationField) {
    durationField.classList.toggle('strategyExpirationLocked', Boolean(locks.autoDuration));
    durationField.querySelector('.strategyExpirationLockHint')?.remove();
    if (locks.autoDuration) {
      const note = document.createElement('small');
      note.className = 'fieldHint strategyExpirationLockHint';
      note.textContent = focusedCustom
        ? uiText('Заблокировано: используется экспирация из конструктора.', 'Locked: expiration from the strategy builder is used.')
        : uiText('Экспирация зафиксирована правилами этой стратегии.', 'Expiration is fixed by this strategy.');
      durationField.appendChild(note);
    }
  }
  $('autoTradeWorkspace')?.classList.toggle('customProfileLocked', focusedCustom);

  const modeControl = $('autoStrategyMode');
  if (modeControl) {
    const forceIndependent = ids.length > 1;
    if (forceIndependent) {
      modeControl.value = 'independent';
      modeControl.disabled = true;
      modeControl.title = uiText(
        'При выборе нескольких стратегий каждая исполняется независимо.',
        'When multiple strategies are selected, each one runs independently.'
      );
      if (settings.autoTrade?.strategyMode !== 'independent') settings.autoTrade = { ...settings.autoTrade, strategyMode: 'independent' };
    } else {
      modeControl.disabled = false;
      modeControl.title = '';
    }
  }
}

function testerStrategyCatalog() {
  const byId = new Map();
  const add = (item, source = '') => {
    if (!item) return;
    const id = String(item.id || item.strategy_id || '').trim();
    if (!id) return;
    const previous = byId.get(id) || {};
    byId.set(id, {
      ...previous,
      ...item,
      id,
      title: item.title || item.name || previous.title || id,
      name: item.name || item.title || previous.name || id,
      description: item.description || previous.description || (item.custom ? 'Пользовательская стратегия из конструктора / импорта' : 'Стратегия Pocket TRADE ROBOT'),
      testerSource: source || item.testerSource || previous.testerSource || '',
      custom: Boolean(item.custom || previous.custom || id.startsWith('custom-')),
      premium: Boolean(item.premium || previous.premium || item.ai || previous.ai),
      available: item.available === false ? false : previous.available === false ? false : true,
      config: item.config || previous.config || (item.custom ? item : null)
    });
  };
  tradeStrategies().forEach((item) => add(item, item.custom ? 'Мои стратегии' : 'Базовые'));
  testerServerCatalog.forEach((item) => add(item, item.custom ? 'Мои стратегии' : 'Базовые'));
  (Array.isArray(settings.builderStrategies) ? settings.builderStrategies : []).forEach((item) => add(localStrategyCatalogItem(item), 'Конструктор / импорт'));
  return [...byId.values()];
}


function testerHasAccess() {
  const entitlement = currentEntitlement();
  const features = entitlement.features || {};
  return Boolean(entitlement.premium || access.premium || features.strategyTester);
}

function selectedValuesFromChecks(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)]
    .map((item) => Number(item.value))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function updateTesterPillStates(rootId) {
  const root = $(rootId);
  if (!root) return;
  root.querySelectorAll('.testerCheck').forEach((label) => {
    const input = label.querySelector('input');
    label.classList.toggle('selected', Boolean(input?.checked));
  });
}

function syncTesterAssetsInput() {
  const values = [...testerSelectedAssets].filter(Boolean);
  if ($('testerAssets')) $('testerAssets').value = values.join(', ');
  if ($('testerAssetCounter')) $('testerAssetCounter').textContent = `${Math.min(values.length, TESTER_MAX_ASSETS)}/${TESTER_MAX_ASSETS} выбрано`;
}

function testerAssetsFromInput() {
  const raw = String($('testerAssets')?.value || '').trim();
  const list = raw ? raw.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean) : [...testerSelectedAssets];
  return [...new Set(list)].slice(0, TESTER_MAX_ASSETS);
}

function testerAssetUniverse() {
  const list = normalizedAssetList();
  if (list.length) return list;
  return [...selectedAssets].map((symbol) => ({ symbol, name: symbol, category: /_otc$/i.test(symbol) ? 'OTC / Прочее' : 'Выбранные активы', active: true }));
}

function testerMinPayoutValue() {
  return Math.max(0, Math.min(100, Number($('testerMinPayout')?.value) || 0));
}

function testerPayoutOf(asset) {
  const value = Number(asset?.payout ?? asset?.profitPercent ?? asset?.percentProfit);
  return Number.isFinite(value) ? value : -1;
}

function testerSelectableAssets(category = null, { onlyMarket = false } = {}) {
  const minPayout = testerMinPayoutValue();
  const marketSet = new Set(cleanAssetSelection([...selectedAssets]));
  return testerAssetUniverse()
    .filter((asset) => asset && asset.active !== false && isAllowedProductAsset(asset.symbol))
    .filter((asset) => !category || (asset.category || (/_otc$/i.test(asset.symbol) ? 'OTC / Прочее' : 'Прочее')) === category)
    .filter((asset) => !onlyMarket || marketSet.has(asset.symbol))
    .filter((asset) => testerPayoutOf(asset) < 0 || testerPayoutOf(asset) >= minPayout)
    .sort((a, b) => testerPayoutOf(b) - testerPayoutOf(a) || String(a.symbol).localeCompare(String(b.symbol), 'ru'));
}

function setTesterAssetsBest(list) {
  testerAssetsExplicitlyCleared = false;
  testerSelectedAssets = new Set((Array.isArray(list) ? list : []).map((asset) => typeof asset === 'string' ? asset : asset?.symbol).filter(Boolean).slice(0, TESTER_MAX_ASSETS));
  syncTesterAssetsInput();
  renderTesterAssetCatalog();
}

function ensureTesterDefaultAssets() {
  if (testerSelectedAssets.size || testerAssetsExplicitlyCleared) return;
  const bestMarket = testerSelectableAssets(null, { onlyMarket: true });
  const bestAll = testerSelectableAssets();
  const defaults = (bestMarket.length ? bestMarket : bestAll).slice(0, TESTER_MAX_ASSETS).map((asset) => asset.symbol);
  testerSelectedAssets = new Set(defaults);
  syncTesterAssetsInput();
}

function renderTesterAssetCatalog() {
  const root = $('testerAssetCatalog');
  if (!root) return;
  ensureTesterDefaultAssets();
  const query = testerAssetSearchQuery.trim().toLowerCase();
  const universe = testerAssetUniverse();
  const filtered = universe.filter((asset) => !query || `${asset.symbol} ${asset.name || ''} ${asset.category || ''}`.toLowerCase().includes(query));
  if (!universe.length) {
    root.innerHTML = '<div class="empty">Подключите Pocket Option — активы загрузятся автоматически.</div>';
    syncTesterAssetsInput();
    return;
  }
  if (!filtered.length) {
    root.innerHTML = '<div class="empty">По вашему поиску активы не найдены.</div>';
    syncTesterAssetsInput();
    return;
  }
  const order = ['Валютные OTC', 'Валюты', 'Металлы', 'Сырьё', 'Акции', 'Криптовалюты', 'Индексы', 'OTC / Прочее', 'Выбранные активы', 'Прочее'];
  const groups = new Map();
  for (const asset of filtered) {
    const category = asset.category || (/_otc$/i.test(asset.symbol) ? 'OTC / Прочее' : 'Прочее');
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(asset);
  }
  const categories = [...groups.keys()].sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)) || a.localeCompare(b, 'ru'));
  root.innerHTML = categories.map((category) => {
    const assets = groups.get(category).slice().sort((a, b) => testerPayoutOf(b) - testerPayoutOf(a) || String(a.symbol).localeCompare(String(b.symbol), 'ru'));
    const selectedCount = assets.filter((asset) => testerSelectedAssets.has(asset.symbol)).length;
    const selectableCount = testerSelectableAssets(category).length;
    return `<section class="testerAssetGroup assetGroup" data-tester-category="${escapeHtml(category)}"><div class="testerAssetGroupTitle assetGroupTitle"><button type="button" data-tester-toggle-category="${escapeHtml(category)}">▾ ${escapeHtml(category)} <span>${selectedCount}/${assets.length} · доступно ${selectableCount}</span></button><div class="assetGroupActions"><button type="button" data-tester-select-category="${escapeHtml(category)}">Выбрать лучшие</button><button type="button" data-tester-clear-category="${escapeHtml(category)}">Снять раздел</button></div></div><div class="testerAssetGrid assetGrid">${assets.map((asset) => {
      const checked = testerSelectedAssets.has(asset.symbol);
      const disabled = asset.active === false;
      const payout = asset.payout == null ? 'мин. выплата актива —' : `мин. выплата актива ${formatNumber(asset.payout, 1)}%`;
      return `<button class="assetItem testerAssetItem ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}" type="button" data-tester-asset="${escapeHtml(asset.symbol)}" ${disabled ? 'disabled' : ''}><div><b>${escapeHtml(asset.symbol)}</b><small>${escapeHtml(asset.name || asset.symbol)} · ${escapeHtml(payout)}</small></div></button>`;
    }).join('')}</div></section>`;
  }).join('');
  syncTesterAssetsInput();
}

function testerSelectedStrategyIds() {
  const checked = [...document.querySelectorAll('input[data-tester-strategy]:checked')].map((item) => String(item.value || '').trim()).filter(Boolean);
  if (checked.length) return [...new Set(checked)];
  return [...($('testerStrategies')?.selectedOptions || [])].map((item) => item.value).filter(Boolean);
}

function syncTesterStrategySelectFromCards() {
  const ids = new Set(testerSelectedStrategyIds());
  const select = $('testerStrategies');
  if (select) [...select.options].forEach((option) => { option.selected = ids.has(option.value); });
  document.querySelectorAll('.testerStrategyCard').forEach((card) => {
    const input = card.querySelector('input[data-tester-strategy]');
    card.classList.toggle('selected', Boolean(input?.checked));
  });
  if ($('testerStrategyCounter')) $('testerStrategyCounter').textContent = `${ids.size} выбрано`;
}

async function refreshTesterConfig() {
  if (testerConfigLoading) return;
  testerConfigLoading = true;
  try {
    const result = await runtimeMessage({ type: 'PT_STRATEGY_TESTER_CONFIG' }, { timeoutMs: 20000 });
    if (result?.ok) {
      testerServerCatalog = Array.isArray(result.strategies) ? result.strategies : [];
      if (result.entitlement) {
        access.entitlement = result.entitlement;
        access.premium = Boolean(result.entitlement.premium);
      }
      renderTesterStrategyOptions();
      renderAccess();
    }
  } catch (error) {
    console.warn('[PT] Strategy Tester config failed', error);
  } finally {
    testerConfigLoading = false;
  }
}

function initializeTesterInputs() {
  if (testerInputsReady || !$('testerTimeframes')) return;
  $('testerTimeframes').innerHTML = TESTER_TIMEFRAMES.map(([value, label]) => `<label class="testerCheck testerChoiceButton"><input type="checkbox" name="testerTf" value="${value}" ${value === 60 ? 'checked' : ''}/><span>${label}</span></label>`).join('');
  $('testerExpirations').innerHTML = TESTER_EXPIRATIONS.map(([value, label]) => `<label class="testerCheck testerChoiceButton"><input type="checkbox" name="testerExp" value="${value}" ${value === 60 ? 'checked' : ''}/><span>${label}</span></label>`).join('');
  updateTesterPillStates('testerTimeframes');
  updateTesterPillStates('testerExpirations');
  ensureTesterDefaultAssets();
  renderTesterAssetCatalog();
  testerInputsReady = true;
}

function testerStrategySupportsLocalEngine(item) {
  const config = item?.config && typeof item.config === 'object' ? item.config : item;
  return isThreeCandleStrategyConfig(config || {}, item?.title || item?.name || config?.name || '');
}

function renderTesterStrategyOptions() {
  const select = $('testerStrategies');
  const grid = $('testerStrategyGrid');
  if (!select && !grid) return;
  const chosen = new Set(testerSelectedStrategyIds());
  const query = testerStrategySearchQuery.trim().toLowerCase();
  const items = testerStrategyCatalog();
  const visible = items.filter((item) => !query || `${item.title || ''} ${item.description || ''} ${item.badge || ''}`.toLowerCase().includes(query));
  const defaultIds = new Set(items.filter(testerStrategySupportsLocalEngine).slice(0, 3).map((item) => String(item.id)));
  if (select) {
    select.innerHTML = items.map((item) => {
      const selected = chosen.has(String(item.id)) || (!chosen.size && defaultIds.has(String(item.id)));
      const tag = item.custom ? (item.needsServerSave ? 'Draft' : 'My strategy') : item.ai ? 'AI' : item.premium ? 'Premium' : 'Base';
      const supported = testerStrategySupportsLocalEngine(item);
      return `<option value="${escapeHtml(item.id)}" ${selected && supported ? 'selected' : ''} ${supported ? '' : 'disabled'}>${escapeHtml(item.title)} · ${tag}${supported ? '' : ' · нет локального алгоритма'}</option>`;
    }).join('');
  }
  if (grid) {
    grid.innerHTML = visible.length ? visible.map((item) => {
      const id = String(item.id || '');
      const selected = chosen.has(id) || (!chosen.size && defaultIds.has(id));
      const tag = item.custom ? (item.needsServerSave ? 'Draft' : 'My strategy') : item.ai ? 'AI' : item.premium ? 'Premium' : 'Base';
      const source = item.testerSource || (item.custom ? 'Мои стратегии' : 'Базовые');
      const icon = escapeHtml(item.icon || (item.ai ? 'AI' : '▦'));
      const supported = testerStrategySupportsLocalEngine(item);
      return `<label class="testerStrategyCard ${selected && supported ? 'selected' : ''} ${supported ? '' : 'disabled'}"><input type="checkbox" data-tester-strategy value="${escapeHtml(id)}" ${selected && supported ? 'checked' : ''} ${supported ? '' : 'disabled'}/><div class="testerStrategyIcon">${icon}</div><div class="testerStrategyBody"><b>${escapeHtml(item.title || id)}</b><small>${escapeHtml(item.description || tag)}</small><span>${escapeHtml(source)} · ${escapeHtml(tag)}${item.badge ? ` · ${escapeHtml(item.badge)}` : ''}${supported ? ' · локальный движок' : ' · алгоритм ещё не перенесён'}</span></div></label>`;
    }).join('') : '<div class="empty">Стратегии не найдены.</div>';
  }
  syncTesterStrategySelectFromCards();
}

function renderStrategyTester() {
  initializeTesterInputs();
  if (!testerServerCatalog.length) refreshTesterConfig();
  renderTesterStrategyOptions();
  renderTesterAssetCatalog();
  updateTesterPillStates('testerTimeframes');
  updateTesterPillStates('testerExpirations');
  const allowed = testerHasAccess();
  const testerRoot = $('view-tester');
  if (testerRoot) {
    testerRoot.querySelectorAll('button, input, select, textarea').forEach((node) => {
      if (node.id !== 'openPremiumFromTester') node.disabled = !allowed;
    });
    testerRoot.classList.toggle('testerLocked', !allowed);
  }
  if ($('testerAccessBadge')) {
    $('testerAccessBadge').textContent = allowed ? 'ДОСТУП АКТИВЕН' : 'ЗАКРЫТО · PREMIUM';
    $('testerAccessBadge').classList.toggle('on', allowed);
  }
  if ($('testerAccessState')) {
    $('testerAccessState').innerHTML = allowed
      ? '<b>Доступ активен</b><span>Premium или отдельная подписка Strategy Tester PRO.</span>'
      : '<b>Нужен Premium</b><span>Откройте вкладку Premium, чтобы проверить доступ или активировать пробный период.</span>';
  }
  if (!testerAssetsExplicitlyCleared && !testerSelectedAssets.size && selectedAssets.size) { setTesterAssetsBest(testerSelectableAssets(null, { onlyMarket: true }).slice(0, TESTER_MAX_ASSETS)); }
}

function setTesterProgress(text, type = '') {
  if (testerBusy && (!type || type === 'running')) {
    testerBusyMessage = String(text || testerBusyMessage || 'Выполняется расчёт…');
    renderTesterBusyProgress();
    return;
  }
  const node = $('testerProgress');
  if (!node) return;
  node.textContent = text;
  node.className = `testerProgress ${type || ''}`.trim();
}

function formatTesterElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function renderTesterBusyProgress() {
  const node = $('testerProgress');
  if (!node || !testerBusy) return;
  const elapsed = formatTesterElapsed(Date.now() - testerBusyStartedAt);
  const waiting = uiText(
    'Расчёт может занять длительное время. Не закрывайте окно — дождитесь результата.',
    'The calculation may take a long time. Keep this window open and wait for the result.'
  );
  const elapsedLabel = uiText('Прошло', 'Elapsed');
  node.textContent = `${testerBusyMessage} ${waiting} ${elapsedLabel}: ${elapsed}.`;
  node.className = 'testerProgress running';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-busy', 'true');
}

function setTesterButtonsBusy(busy) {
  for (const id of ['testerCollectHistory', 'testerRun']) {
    const button = $(id);
    if (!button) continue;
    button.disabled = Boolean(busy);
    button.classList.toggle('isBusy', Boolean(busy));
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
}

function beginTesterBusy(message) {
  if (testerBusy) return false;
  testerBusy = true;
  testerBusyStartedAt = Date.now();
  testerBusyMessage = String(message || uiText('Подготавливаем тест…', 'Preparing the test…'));
  setTesterButtonsBusy(true);
  clearInterval(testerBusyTimer);
  testerBusyTimer = setInterval(renderTesterBusyProgress, 1000);
  renderTesterBusyProgress();
  return true;
}

function finishTesterBusy(text, type = 'ok') {
  clearInterval(testerBusyTimer);
  testerBusyTimer = null;
  testerBusy = false;
  testerBusyStartedAt = 0;
  testerBusyMessage = '';
  setTesterButtonsBusy(false);
  const node = $('testerProgress');
  node?.removeAttribute('aria-busy');
  setTesterProgress(text, type);
}

function normalizedTesterHistoryLimit(announceCorrection = false) {
  const input = $('testerHistoryLimit');
  const raw = Math.floor(Number(input?.value) || TESTER_HISTORY_MAX);
  const normalized = Math.max(TESTER_HISTORY_MIN, Math.min(TESTER_HISTORY_MAX, raw));
  if (input && Number(input.value) !== normalized) input.value = String(normalized);
  if (announceCorrection && raw !== normalized) {
    toast(uiText(
      `Через текущий поток Pocket Option доступно максимум ${TESTER_HISTORY_MAX.toLocaleString('ru-RU')} свечей на один актив и таймфрейм. Значение скорректировано.`,
      `The current Pocket Option stream provides up to ${TESTER_HISTORY_MAX.toLocaleString('en-US')} candles per asset and timeframe. The value was adjusted.`
    ), 'info');
  }
  return normalized;
}

function testerHistorySelectionSignature(assets, periods, historyOffset) {
  return JSON.stringify({
    assets: [...new Set((Array.isArray(assets) ? assets : []).map(String))].sort(),
    periods: [...new Set((Array.isArray(periods) ? periods : []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b),
    historyOffset: Number(historyOffset) || TESTER_HISTORY_MAX
  });
}

async function collectTesterHistoryFromUi() {
  if (!testerHasAccess()) {
    setTab('premium');
    throw new Error('Strategy Tester PRO доступен только в TRIAL, Premium или по отдельной подписке.');
  }
  const assets = testerAssetsFromInput();
  const periods = selectedValuesFromChecks('testerTf');
  const historyOffset = normalizedTesterHistoryLimit(true);
  if (!assets.length) throw new Error('Выберите активы для тестера');
  if (!periods.length) throw new Error('Выберите хотя бы один таймфрейм истории свечей');
  setTesterProgress(uiText(
    `Загружаем историю: ${assets.length} активов × ${periods.length} таймфрейм…`,
    `Loading history: ${assets.length} assets × ${periods.length} timeframes…`
  ));
  const collectionTimeoutMs = Math.max(
    45000,
    periods.length * Math.max(10000, assets.length * 2600) + 10000
  );
  const result = await runtimeMessage(
    { type: 'PT_TESTER_COLLECT_HISTORY', payload: { assets, periods, historyOffset } },
    { timeoutMs: collectionTimeoutMs }
  );
  if (!result?.ok) throw new Error(result?.error || 'История свечей не получена');
  testerHistoryRecords = result.records || {};
  testerHistorySignature = testerHistorySelectionSignature(assets, periods, historyOffset);
  const recordList = Object.values(testerHistoryRecords);
  const candleCounts = recordList.map((item) => Array.isArray(item?.candles) ? item.candles.length : 0);
  const total = candleCounts.reduce((sum, count) => sum + count, 0);
  const maximum = candleCounts.length ? Math.max(...candleCounts) : 0;
  const loadedMessage = uiText(
    `История загружена: ${recordList.length} наборов, ${total.toLocaleString('ru-RU')} свечей всего; до ${maximum.toLocaleString('ru-RU')} в одном наборе из запрошенных ${historyOffset.toLocaleString('ru-RU')}.`,
    `History loaded: ${recordList.length} datasets, ${total.toLocaleString('en-US')} candles total; up to ${maximum.toLocaleString('en-US')} in one dataset out of ${historyOffset.toLocaleString('en-US')} requested.`
  );
  setTesterProgress(loadedMessage, testerBusy ? 'running' : 'ok');
  return testerHistoryRecords;
}

async function runStrategyTesterFromUi() {
  if (!testerHasAccess()) {
    setTab('premium');
    throw new Error('Strategy Tester PRO доступен пользователям Premium');
  }
  const strategyIds = testerSelectedStrategyIds();
  const catalog = testerStrategyCatalog();
  const selectedCatalog = catalog.filter((item) => strategyIds.includes(String(item.id)));
  const inlineStrategies = selectedCatalog
    .filter((item) => item.custom && item.config)
    .map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      config: item.config,
      custom: true
    }));
  const assets = testerAssetsFromInput();
  const timeframes = selectedValuesFromChecks('testerTf');
  const expirations = selectedValuesFromChecks('testerExp');
  if (!strategyIds.length) throw new Error('Выберите стратегии для теста');
  if (!assets.length) throw new Error('Выберите активы');
  if (!timeframes.length) throw new Error('Выберите хотя бы один таймфрейм');
  if (!expirations.length) throw new Error('Выберите хотя бы одну экспирацию');
  const requestedHistoryLimit = normalizedTesterHistoryLimit(true);
  const requestedHistorySignature = testerHistorySelectionSignature(assets, timeframes, requestedHistoryLimit);
  if (!Object.keys(testerHistoryRecords || {}).length || testerHistorySignature !== requestedHistorySignature) {
    await collectTesterHistoryFromUi();
  }
  setTesterProgress(uiText(
    'Локальный движок проверяет сигналы по историческим свечам…',
    'The local engine is evaluating historical candle signals…'
  ));
  const testerPayload = {
    strategyIds, inlineStrategies, assets, timeframes, expirations,
    amount: Number($('testerAmount')?.value) || 1,
    minPayout: Number($('testerMinPayout')?.value) || 0,
    history: testerHistoryRecords,
    historyLimit: requestedHistoryLimit,
    strategyDefinitions: selectedCatalog.map((item) => ({
      ...item,
      config: item.config || (item.custom ? item : null)
    }))
  };
  const unsupported = selectedCatalog.filter((item) => !testerStrategySupportsLocalEngine(item));
  if (unsupported.length) {
    throw new Error(`Локальный тестер пока поддерживает только стратегии с алгоритмом 3-Candle EMA14. Не поддерживаются: ${unsupported.map((item) => item.title || item.id).join(', ')}.`);
  }
  setTesterProgress('Локальный движок рассчитывает сигналы по закрытым свечам и проверяет исход на экспирации…');
  const result = runLocalStrategyTester(testerPayload, selectedCatalog);
  testerLastResult = result;
  renderTesterResults(result);
  const completedMessage = result.localFallback
    ? `Локальный тест завершён: ${result.summary?.results || 0} связок.`
    : `Тест завершён: ${result.summary?.results || 0} связок.`;
  setTesterProgress(completedMessage, testerBusy ? 'running' : 'ok');
  return result;
}


function testerLocalErrorEligible(text) {
  return /локальн|server.*strategy.?tester|strategy.?tester.*(?:disabled|unavailable|not implemented)/i.test(String(text || ''));
}

function testerStrategyTitleById(id, catalog) {
  const found = (catalog || []).find((item) => String(item.id) === String(id));
  return found?.title || String(id || 'Strategy');
}

function testerEmaSeries(candles, period) {
  const length = Math.max(2, Math.round(Number(period) || 14));
  const alpha = 2 / (length + 1);
  let ema = null;
  return candles.map((candle) => {
    const close = Number(candle?.close);
    if (!Number.isFinite(close)) return null;
    ema = ema == null ? close : close * alpha + ema * (1 - alpha);
    return ema;
  });
}

function testerThreeCandleSignal(candles, emaValues, index, config) {
  const spec = config?.threeCandleEma || {};
  const count = Math.max(3, Math.round(Number(spec.count) || 3));
  const emaPeriod = Math.max(2, Math.round(Number(spec.currentEmaPeriod) || 14));
  const relation = String(spec.relation || (config?.direction === 'put' ? 'below' : 'above')).toLowerCase() === 'below' ? 'below' : 'above';
  const requiredColor = relation === 'below' ? 'red' : 'green';
  const minBody = Math.max(0.05, Math.min(0.90, Number(spec.mediumBodyMinRatio) || 0.35));
  const maxBody = Math.max(minBody, Math.min(0.98, Number(spec.mediumBodyMaxRatio) || 0.75));
  if (index < Math.max(count - 1, emaPeriod - 1)) return null;
  for (let n = index - count + 1; n <= index; n += 1) {
    const candle = candles[n];
    const ema = emaValues[n];
    if (!candle || !Number.isFinite(ema)) return null;
    const open = Number(candle.open), close = Number(candle.close);
    const high = Number(candle.high), low = Number(candle.low);
    const green = close > open, red = close < open;
    if (requiredColor === 'green' ? !green : !red) return null;
    const range = high - low;
    const bodyRatio = range > 0 ? Math.abs(close - open) / range : 0;
    if (bodyRatio < minBody || bodyRatio > maxBody) return null;
    const bodyLow = Math.min(open, close), bodyHigh = Math.max(open, close);
    if (relation === 'above' ? bodyLow <= ema : bodyHigh >= ema) return null;
  }
  return relation === 'above' ? 'call' : 'put';
}

function testerLatestContinuousCandles(candles, period) {
  const ordered = Array.isArray(candles) ? candles : [];
  if (ordered.length <= 1) return ordered;
  const continuous = [ordered[ordered.length - 1]];
  const maxGap = Math.max(60, Number(period) * 8);
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const older = ordered[index];
    const newer = continuous[0];
    const gap = newer.time - older.time;
    const reference = Math.max(Math.abs(newer.open), Math.abs(newer.close), 1e-9);
    const priceJump = Math.abs(older.close - newer.open) / reference;
    if (gap <= 0 || gap > maxGap || priceJump > 0.35) break;
    continuous.unshift(older);
    if (continuous.length >= 5000) break;
  }
  return continuous;
}

function emptyTesterStats(extra = {}) {
  return { trades: 0, wins: 0, losses: 0, draws: 0, netProfit: 0, equity: 0, peak: 0, maxDrawdown: 0, ...extra };
}

function finalizeTesterStats(row) {
  const trades = Math.max(0, Number(row.trades) || 0);
  row.winRate = trades ? (Number(row.wins || 0) / trades * 100) : 0;
  const profit = row.profitKnown === false ? 0 : Number(row.netProfit || 0);
  const drawdown = row.profitKnown === false ? 0 : Math.abs(Number(row.maxDrawdown || 0));
  row.score = row.winRate * 0.62 + Math.max(-80, profit) * 2.2 - drawdown * 0.7 + Math.min(18, trades / 10) + Math.min(10, Number(row.assetCount || 1) * 0.35);
  return row;
}

function runLocalStrategyTester(payload = {}, catalog = []) {
  const strategyIds = Array.isArray(payload.strategyIds) ? payload.strategyIds.map(String).filter(Boolean) : [];
  const assets = Array.isArray(payload.assets) ? payload.assets.map(String).filter(Boolean) : [];
  const timeframes = Array.isArray(payload.timeframes) ? payload.timeframes.map(Number).filter((v) => Number.isFinite(v) && v > 0) : [];
  const expirations = Array.isArray(payload.expirations) ? payload.expirations.map(Number).filter((v) => Number.isFinite(v) && v > 0) : [];
  const amount = Math.max(0.01, Number(payload.amount) || 1);
  const minPayout = Math.max(0, Number(payload.minPayout) || 0);
  const history = payload.history || {};
  const definitions = new Map((catalog || []).map((item) => [String(item.id), item]));
  const unsupported = strategyIds.filter((id) => !testerStrategySupportsLocalEngine(definitions.get(id)));
  if (unsupported.length) {
    throw new Error(`Нет перенесённого локального алгоритма для стратегий: ${unsupported.map((id) => testerStrategyTitleById(id, catalog)).join(', ')}. Они отключены в этом тестере, чтобы не выдавать приблизительные результаты за реальные.`);
  }
  const detailResults = [];
  const portfolio = new Map();
  let skipped = 0;
  let payoutUnknown = 0;

  for (const strategyId of strategyIds) {
    const item = definitions.get(strategyId);
    const rawConfig = item?.config && typeof item.config === 'object' ? item.config : item;
    const config = migrateThreeCandleStrategyConfig(rawConfig || {}, item?.title || item?.name || '');
    const configuredPeriod = normalizeAnalysisPeriodSeconds(config.timeframe, 60);
    const emaPeriod = Math.max(2, Math.round(Number(config?.threeCandleEma?.currentEmaPeriod) || 14));
    const count = Math.max(3, Math.round(Number(config?.threeCandleEma?.count) || 3));
    for (const asset of assets) {
      for (const period of timeframes) {
        if (period !== configuredPeriod) { skipped += expirations.length; continue; }
        const record = history[`${asset}|${period}`] || {};
        const candles = testerLatestContinuousCandles(
          (Array.isArray(record.candles) ? record.candles : [])
            .map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
            .filter((c) => Number.isFinite(c.time)
              && [c.open,c.high,c.low,c.close].every(Number.isFinite)
              && c.high >= c.low
              && c.high >= Math.max(c.open, c.close)
              && c.low <= Math.min(c.open, c.close))
            .sort((a,b) => a.time-b.time)
            .filter((c,i,a) => i === 0 || c.time !== a[i-1].time),
          period
        );
        if (candles.length < Math.max(emaPeriod + count + 2, 20)) { skipped += expirations.length; continue; }
        const rawPayout = Number(record.payout);
        const marketAsset = testerAssetUniverse().find((entry) => String(entry?.symbol) === asset);
        const marketPayout = testerPayoutOf(marketAsset);
        const payout = Number.isFinite(rawPayout) && rawPayout > 0 ? rawPayout : (marketPayout > 0 ? marketPayout : null);
        if (payout != null && payout < minPayout) { skipped += expirations.length; continue; }
        if (payout == null && minPayout > 0) { payoutUnknown += expirations.length; skipped += expirations.length; continue; }
        const emaValues = testerEmaSeries(candles, emaPeriod);
        for (const expiration of expirations) {
          const ratio = expiration / period;
          const shift = Math.round(ratio);
          if (shift < 1 || Math.abs(ratio - shift) > 1e-9) { skipped += 1; continue; }
          const payoutKnown = payout != null;
          const row = emptyTesterStats({
            strategyId,
            strategyTitle: testerStrategyTitleById(strategyId, catalog),
            asset,
            period,
            timeframeLabel: formatDuration(period),
            expiration,
            expirationLabel: formatDuration(expiration),
            payout: payoutKnown ? payout : null,
            profitKnown: payoutKnown,
            events: []
          });
          const cooldown = Math.max(0, Number(config.cooldown) || 0);
          let lastSignalTime = -Infinity;
          for (let i = Math.max(emaPeriod - 1, count - 1); i + shift < candles.length; i += 1) {
            const direction = testerThreeCandleSignal(candles, emaValues, i, config);
            if (!direction) continue;
            const signalTime = candles[i].time;
            if (cooldown > 0 && signalTime - lastSignalTime < cooldown) continue;
            lastSignalTime = signalTime;
            const entryCandle = candles[i + 1];
            const exitCandle = candles[i + shift];
            const entry = Number(entryCandle.open);
            const exit = Number(exitCandle.close);
            if (!Number.isFinite(entry) || !Number.isFinite(exit)) continue;
            row.trades += 1;
            let outcome = 'draw';
            if (exit !== entry) {
              const won = direction === 'call' ? exit > entry : exit < entry;
              outcome = won ? 'win' : 'loss';
              if (won) row.wins += 1; else row.losses += 1;
            } else row.draws += 1;
            const pnl = payoutKnown ? (outcome === 'win' ? amount * payout / 100 : outcome === 'loss' ? -amount : 0) : null;
            if (payoutKnown) {
              row.netProfit += pnl;
              row.equity += pnl;
              row.peak = Math.max(row.peak, row.equity);
              row.maxDrawdown = Math.min(row.maxDrawdown, row.equity - row.peak);
            }
            row.events.push({ time: exitCandle.time, outcome, pnl });
          }
          if (!row.trades) { skipped += 1; continue; }
          const rowEvents = row.events.slice();
          delete row.events;
          finalizeTesterStats(row);
          if (!payoutKnown) { row.netProfit = null; row.maxDrawdown = null; }
          detailResults.push(row);
          const key = `${strategyId}|${period}|${expiration}`;
          if (!portfolio.has(key)) portfolio.set(key, {
            ...emptyTesterStats({
              strategyId,
              strategyTitle: row.strategyTitle,
              asset: `Все выбранные активы`,
              assetCount: 0,
              assetsTested: [],
              portfolio: true,
              period,
              timeframeLabel: formatDuration(period),
              expiration,
              expirationLabel: formatDuration(expiration),
              profitKnown: true,
              events: []
            })
          });
          const agg = portfolio.get(key);
          agg.trades += row.trades;
          agg.wins += row.wins;
          agg.losses += row.losses;
          agg.draws += row.draws;
          agg.assetsTested.push(asset);
          agg.assetCount = agg.assetsTested.length;
          if (!payoutKnown) agg.profitKnown = false;
          else {
            for (const event of rowEvents) agg.events.push({ ...event, asset });
          }
        }
      }
    }
  }
  const results = [...portfolio.values()].map((row) => {
    row.assetsTested = [...new Set(row.assetsTested)];
    row.assetCount = row.assetsTested.length;
    if (row.profitKnown === false) { row.netProfit = null; row.maxDrawdown = null; }
    else {
      row.netProfit = 0; row.equity = 0; row.peak = 0; row.maxDrawdown = 0;
      row.events.sort((a,b) => Number(a.time)-Number(b.time));
      for (const event of row.events) {
        const pnl = Number(event.pnl) || 0;
        row.netProfit += pnl; row.equity += pnl;
        row.peak = Math.max(row.peak, row.equity);
        row.maxDrawdown = Math.min(row.maxDrawdown, row.equity-row.peak);
      }
    }
    delete row.events;
    return finalizeTesterStats(row);
  }).sort((a,b) => Number(b.score||0)-Number(a.score||0));
  detailResults.sort((a,b) => Number(b.score||0)-Number(a.score||0));
  const best = results[0] || null;
  return {
    ok: true,
    localFallback: true,
    localEngine: 'three-candle-ema14-v3',
    results,
    detailResults,
    best,
    recommendation: best ? { strategyId: best.strategyId, timeframe: best.period, expiration: best.expiration, minPayout, assets: best.assetsTested || assets } : null,
    summary: {
      results: results.length,
      detailResults: detailResults.length,
      assets: assets.length,
      skippedCombinations: skipped,
      payoutUnknown,
      precision: 'OHLC · EMA14 · payout snapshot',
      message: results.length
        ? `Локальный тест завершён по точным правилам 3-Candle EMA: ${detailResults.length} результатов по активам, ${results.length} портфельных связок. Вход — открытие следующей свечи; исход — закрытие свечи по экспирации.${skipped ? ` Пропущено комбинаций: ${skipped} (несовместимый TF/экспирация или недостаточная история).` : ''}`
        : `Нет сделок для выбранной матрицы. Проверьте, что история содержит достаточно закрытых свечей, выбран TF стратегии и экспирация кратна TF свечи.`
    }
  };
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function renderTesterResults(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const top = rows.slice(0, 50);
  if ($('testerResultTitle')) $('testerResultTitle').textContent = rows.length ? `Найдено ${rows.length} результатов` : 'Нет результатов';
  if ($('testerResultSummary')) $('testerResultSummary').textContent = result?.summary?.message || 'Матрица теста завершена.';
  if ($('testerPrecision')) $('testerPrecision').textContent = result?.summary?.precision || 'CANDLE';
  if ($('testerResultRows')) $('testerResultRows').innerHTML = top.map((row) => `<tr>
    <td>${escapeHtml(row.strategyTitle || row.strategyId || '—')}</td><td>${escapeHtml(row.asset || '—')}</td><td>${escapeHtml(row.timeframeLabel || formatDuration(row.period))}</td><td>${escapeHtml(row.expirationLabel || formatDuration(row.expiration))}</td><td>${row.trades || 0}</td><td>${formatNumber(row.winRate || 0, 1)}%</td><td class="${row.profitKnown === false ? '' : Number(row.netProfit || 0) >= 0 ? 'profit' : 'loss'}">${row.profitKnown === false ? '—' : formatMoney(row.netProfit || 0, currentCurrency(), true)}</td><td>${row.profitKnown === false ? '—' : formatMoney(row.maxDrawdown || 0, currentCurrency(), true)}</td><td>${formatNumber(row.score || 0, 1)}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="empty">Нет сделок по выбранной матрице. Увеличьте историю или выберите больше активов.</td></tr>';
  const best = result?.best;
  if ($('testerBestBox')) {
    $('testerBestBox').hidden = !best;
    $('testerBestBox').innerHTML = best ? `<b>🏆 Лучшие настройки по выбранным парам:</b> ${escapeHtml(best.strategyTitle || best.strategyId)} · ${escapeHtml(best.asset)} · ${escapeHtml(best.timeframeLabel)} → ${escapeHtml(best.expirationLabel)} · Winrate ${formatNumber(best.winRate, 1)}% · Profit ${formatMoney(best.netProfit, currentCurrency(), true)}<br><small>Рекомендация: применить этот общий профиль к выбранному набору пар: таймфрейм ${escapeHtml(best.timeframeLabel)}, экспирацию ${escapeHtml(best.expirationLabel)}, мин. выплату актива ${escapeHtml(String(result.recommendation?.minPayout ?? '—'))}%.</small>` : '';
  }
}

function renderStrategies() {
  const activeIds = new Set((Array.isArray(settings.autoTrade?.strategyIds) && settings.autoTrade.strategyIds.length ? settings.autoTrade.strategyIds : [settings.activeStrategyId || settings.autoTrade?.strategyId]).filter(Boolean));
  const query = String($('strategySearch')?.value || '').trim().toLowerCase();
  const filter = $('strategyFilter')?.value || 'all';
  const items = tradeStrategies().filter((item) => {
    const matchesQuery = !query || `${item.title} ${item.description} ${item.badge || ''}`.toLowerCase().includes(query);
    const matchesFilter = filter === 'all'
      || (filter === 'basic' && !item.premium && !item.custom)
      || (filter === 'premium' && item.premium && !item.custom)
      || (filter === 'custom' && item.custom)
      || (filter === 'ai' && item.ai);
    return matchesQuery && matchesFilter;
  });

  const cards = items.map((item) => {
    const locked = strategyLockedForAccess(item);
    const active = activeIds.has(item.id);
    const engineReady = Boolean(item.engineReady);
    const needsSave = Boolean(item.custom && !engineReady);
    const stateText = locked ? 'Premium' : active ? 'Выбрана' : needsSave ? 'Сохранить' : engineReady ? 'Выбрать' : 'Недоступна';
    const kind = item.custom ? 'Моя' : item.ai ? 'AI' : item.premium ? 'Premium' : 'Базовая';
    return `<article class="strategyCard compact ${escapeHtml(item.color || '')} ${locked ? 'locked' : ''} ${active ? 'selected' : ''}" data-strategy-id="${escapeHtml(item.id)}" role="button" tabindex="${locked ? '-1' : '0'}" aria-pressed="${active ? 'true' : 'false'}">
      <div class="strategyTop">
        <div class="strategyIcon">${escapeHtml(item.icon || (item.custom ? '✦' : '↗'))}</div>
        <div class="strategyText"><div class="strategyTitleRow"><h4>${escapeHtml(item.title)}</h4><span class="strategyKind">${escapeHtml(kind)}</span></div>
        <p>${escapeHtml(item.description || 'Серверная стратегия Pocket TRADE ROBOT')}</p></div>
      </div>
      <div class="strategyMeta"><span>${item.custom ? `${item.config?.rules?.length || 0} условий` : escapeHtml(item.badge || 'Серверная')} · ${engineReady ? 'Онлайн-анализ свечей' : needsSave ? 'Нужно сохранить на сервере' : 'Движок недоступен'}</span>
      <button data-strategy-id="${escapeHtml(item.id)}" class="${active ? 'active' : ''}" ${locked ? 'disabled' : ''}>${escapeHtml(stateText)}</button></div>
    </article>`;
  });
  $('strategyGrid').innerHTML = cards.join('') || '<div class="empty">По этому фильтру стратегии не найдены.</div>';
  if ($('strategyCount')) $('strategyCount').textContent = `${items.length} ${items.length === 1 ? 'стратегия' : 'стратегий'}`;

  const quickCards = tradeStrategies().map((item) => {
    const locked = strategyLockedForAccess(item);
    const active = activeIds.has(item.id);
    const engineReady = Boolean(item.engineReady);
    const needsSave = Boolean(item.custom && !engineReady);
    return `<div class="quickStrategyItem ${active ? 'active' : ''} ${locked ? 'locked' : ''}">
      <span class="qIcon">${escapeHtml(item.icon || (item.custom ? '✦' : '↗'))}</span>
      <span class="qBody"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(engineReady ? (item.custom ? 'Моя серверная стратегия' : item.ai ? 'AI · Premium' : 'Серверный движок активен') : needsSave ? 'Черновик · сохранить на сервере' : 'Тестовый канал · движок готовится')}</small></span>
      <button data-trade-strategy-id="${escapeHtml(item.id)}" class="${active ? 'active' : ''}" ${locked ? 'disabled' : ''}>${locked ? 'Закрыто' : active ? 'Выбрана' : needsSave ? 'Сохранить' : engineReady ? 'Выбрать' : 'Для теста'}</button>
    </div>`;
  });
  if ($('tradeStrategyGrid')) $('tradeStrategyGrid').innerHTML = quickCards.join('') || '<div class="empty">Серверный каталог стратегий пока недоступен.</div>';
  if ($('tradeStrategyPlan')) $('tradeStrategyPlan').textContent = access.tier || 'FREE';
}

function logicLabel(value) {
  return value === 'any' ? 'OR' : value === 'score' ? 'Score' : 'AND';
}

function renderAutoTrade() {
  const auto = { ...DEFAULT_AUTO, ...(settings.autoTrade || {}) };
  $('autoEnabled').checked = Boolean(auto.enabled);
  const enabled = Boolean(auto.enabled);
  const diagnosticsFreshAt = Math.max(Date.parse(signalDiagnostics?.lastMessageAt || '') || 0, Date.parse(signalDiagnostics?.lastEngineAt || '') || 0);
  const diagnosticsOnline = diagnosticsFreshAt > 0 && Date.now() - diagnosticsFreshAt <= 90000;
  $('autoState').classList.toggle('on', enabled && (diagnosticsOnline || !['blocked', 'error', 'stopped'].includes(autoStatus?.state)));
  const strategyIds = Array.isArray(auto.strategyIds) && auto.strategyIds.length ? auto.strategyIds : [auto.strategyId].filter(Boolean);
  const selectedStrategies = tradeStrategies().filter((item) => strategyIds.includes(item.id));
  const engineReady = Boolean(selectedStrategies.length && selectedStrategies.every((item) => item.engineReady));
  const lastSignalMessageAt = Date.parse(signalDiagnostics?.lastMessageAt || '');
  const lastEngineAt = Date.parse(signalDiagnostics?.lastEngineAt || '');
  const signalFresh = [lastSignalMessageAt, lastEngineAt].some((value) => Number.isFinite(value) && Date.now() - value <= 90000);
  const diagnosticStatus = String(signalDiagnostics?.status || 'idle');
  const signalOnline = diagnosticStatus === 'online' || (diagnosticStatus === 'subscribing' && signalFresh) || signalFresh;
  const transientSignalState = ['connecting', 'subscribing', 'reconnecting'].includes(diagnosticStatus);
  const staleOfflineStatus = enabled && signalOnline && ['offline', 'error'].includes(String(autoStatus?.state || ''));
  const runtimeMessage = enabled
    ? (staleOfflineStatus
      ? (lastEngineAt ? 'Сервер сигналов подключён · онлайн-анализ выполняется' : 'Сервер сигналов подключён')
      : autoStatus?.message || (transientSignalState
        ? (diagnosticStatus === 'subscribing' ? 'Подписка на серверные сигналы…' : 'Подключение канала сигналов…')
        : engineReady
          ? 'Движок анализирует текущую или закрытую свечу, тики, уровни и фильтры выбранной стратегии.'
          : 'Серверный движок выбранной стратегии временно недоступен.'))
    : 'Бот не открывает сделки автоматически';
  const effectiveState = staleOfflineStatus ? 'scanning' : String(autoStatus?.state || '');
  const runtimeTitle = !enabled ? 'Выключена' : effectiveState === 'trade' ? 'Сделка отправлена' : effectiveState === 'blocked' ? 'Ограничена' : effectiveState === 'stopped' ? 'Остановлена лимитом' : effectiveState === 'error' ? 'Ошибка' : 'Включена';
  $('autoState').innerHTML = `<i></i><div><b>${escapeHtml(runtimeTitle)}</b><small>${escapeHtml(runtimeMessage)}</small></div>`;
  if ($('autoPrerequisite')) {
    const checks = [
      [isConnected(), 'Аккаунт'],
      [Boolean(selectedAssets.size), 'Активы'],
      [Boolean(strategyIds.length), strategyIds.length > 1 ? `${strategyIds.length} стратегии` : 'Стратегия'],
      [Boolean(serverState?.online), 'Сервер'],
      [signalOnline, signalOnline ? 'Канал' : transientSignalState ? 'Канал…' : 'Канал'],
      [engineReady, 'Движок']
    ];
    $('autoPrerequisite').innerHTML = checks.map(([ok, label]) => `<span class="${ok ? 'ok' : 'warn'}"><i>${ok ? '✓' : '!'}</i>${escapeHtml(label)}</span>`).join('');
  }
  if ($('engineBadge')) {
    const analysisOnline = enabled && engineReady && signalOnline;
    $('engineBadge').textContent = analysisOnline ? 'АНАЛИЗ ОНЛАЙН' : enabled ? 'ОЖИДАНИЕ' : 'ВЫКЛ';
    $('engineBadge').classList.toggle('on', analysisOnline);
  }
  if ($('autoRecoveryRuntime')) {
    const recoveryEnabled = auto.recoveryMode === 'steps' && Number(auto.recoverySteps) > 0;
    const recoveryStep = Math.max(0, Number(autoStatus?.recoveryStep) || 0);
    const recoveryBranches = Math.max(0, Number(autoStatus?.recoveryBranches) || 0);
    const awaitingResult = autoStatus?.recoveryAwaitingResult === true;
    const message = String(autoStatus?.message || '');
    let recoveryText = 'Мартингейл выключен';
    if (recoveryEnabled) {
      if (awaitingResult) recoveryText = 'Ждём закрытия сделки стратегии перед следующим входом';
      else if (recoveryStep > 0 && autoStatus?.state === 'trade') recoveryText = `Открыт шаг ${recoveryStep}/${Math.max(1, Number(auto.recoverySteps) || 1)}${recoveryBranches ? ` · активных веток ${recoveryBranches}` : ''}`;
      else if (/Мартингейл/i.test(message)) recoveryText = message;
      else if (recoveryBranches > 0) recoveryText = `Ожидают восстановления: ${recoveryBranches}`;
      else recoveryText = 'Активных веток нет · после LOSS будет подготовлен шаг 1';
    }
    $('autoRecoveryRuntime').textContent = recoveryText;
  }
  const maxAssets = access.limits?.maxAssets;
  const maxTrades = access.limits?.maxDailyTrades;
  const entitlement = currentEntitlement();
  const accessState = String(entitlement.accessState || '').toUpperCase();
  if (access.premium) {
    $('autoLimitPanel').innerHTML = '<b>PREMIUM:</b> все активы и сделки без тарифных ограничений. Доступны DEMO и REAL, все 4 стратегии, включая отдельную AI Analysis, и конструктор.';
  } else if (accessState === 'TRIAL_EXPIRED' || entitlement.registrationRequired) {
    $('autoLimitPanel').innerHTML = '<b>TRIAL завершён:</b> для продолжения автоторговли подтвердите регистрацию нового аккаунта Pocket Option по партнёрской программе.';
  } else {
    const assetText = Number.isFinite(Number(maxAssets)) ? `до ${Number(maxAssets)} активов` : 'лимит активов определяется сервером';
    const tradeText = Number.isFinite(Number(maxTrades)) ? `до ${Number(maxTrades)} сделок в сутки на DEMO` : 'суточный лимит сделок определяется сервером';
    $('autoLimitPanel').innerHTML = `<b>FREE:</b> ${assetText}, ${tradeText}. Доступен только DEMO; REAL, AI Analysis, конструктор, Tester PRO и Remote Control недоступны до Premium или отдельной подписки модуля.`;
  }
}

function loadAutoInputs() {
  const auto = { ...DEFAULT_AUTO, ...(settings.autoTrade || {}) };
  const strategyIds = Array.isArray(auto.strategyIds) && auto.strategyIds.length
    ? auto.strategyIds.map(String).filter(Boolean)
    : [auto.strategyId || settings.activeStrategyId].filter(Boolean).map(String);
  $('autoEnabled').checked = Boolean(auto.enabled);
  $('autoPeriod').value = String(normalizeAnalysisPeriodSeconds(auto.period, 60));
  $('autoAmountMode').value = auto.amountMode === 'balancePercent' ? 'balancePercent' : 'fixed';
  $('autoAmount').value = String(auto.amount ?? 1);
  $('autoBalancePercent').value = String(auto.balancePercent ?? 1);
  syncAutoAmountModeUi({ resetInactive: true });
  $('autoMaxAmount').value = String(Math.max(Number(auto.maxAmount ?? 0) || 0, auto.amountMode === 'fixed' ? Number(auto.amount ?? 1) || 1 : 0) || 10);
  $('autoDuration').value = String(normalizeExpirationSeconds(auto.duration, 60));
  $('autoCooldown').value = String(auto.cooldown ?? 5);
  $('autoConcurrent').value = String(auto.maxConcurrent ?? 1);
  $('autoDirection').value = auto.direction || 'both';
  $('autoTakeProfit').value = String(auto.takeProfit ?? 0);
  $('autoStopLoss').value = String(auto.stopLoss ?? 0);
  $('autoMaxTrades').value = String(auto.maxTrades ?? 0);
  $('autoMaxLossStreak').value = String(auto.maxLossStreak ?? 0);
  const recoveryPlan = normalizeRecoveryPlan(auto.recoveryPlan, auto);
  const recoveryEnabled = auto.recoveryMode === 'steps' && Number(auto.recoverySteps) > 0;
  $('autoRecoveryEnabled').checked = recoveryEnabled;
  $('autoRecoverySteps').value = String(recoveryEnabled
    ? Math.min(5, Math.max(1, Number(auto.recoverySteps) || 1))
    : 1);
  $('autoRecoveryAfterMax').value = auto.recoveryAfterMax === 'reset' ? 'reset' : 'stop';
  if ($('autoRecoveryFollowSignal')) $('autoRecoveryFollowSignal').checked = auto.recoveryFollowSignal === true;
  recoveryPlan.forEach((step, index) => {
    const number = index + 1;
    $(`autoRecoveryMultiplier${number}`).value = String(step.multiplier);
    if ($(`autoRecoveryMinPayout${number}`)) $(`autoRecoveryMinPayout${number}`).value = String(step.minPayout);
  });
  $('autoOnePerAsset').checked = auto.onePerAsset !== false;
  renderRecoveryControls();
  if ($('autoStrategyMode')) $('autoStrategyMode').value = strategyIds.length > 1 ? 'independent' : (auto.strategyMode === 'independent' ? 'independent' : 'best');
  if ($('autoTradeWorkspace')) $('autoTradeWorkspace').dataset.loadedStrategyProfile = '';
  updateAutoStrategyExecutionProfileUi();
  renderAutoStrategyCompatibilityNotice();
}


function recoveryPlanFromForm() {
  return [1, 2, 3, 4, 5].map((number, index) => ({
    multiplier: Math.min(MAX_RECOVERY_MULTIPLIER, Math.max(1, Number($(`autoRecoveryMultiplier${number}`)?.value) || DEFAULT_RECOVERY_PLAN[index].multiplier)),
    duration: 0,
    minPayout: Math.min(100, Math.max(MIN_TRADE_PAYOUT, Number($(`autoRecoveryMinPayout${number}`)?.value) || DEFAULT_RECOVERY_PLAN[index].minPayout))
  }));
}

function activeRecoveryStepCountFromForm() {
  return $('autoRecoveryEnabled')?.checked
    ? Math.min(5, Math.max(1, Number($('autoRecoverySteps')?.value) || 1))
    : 0;
}

function requiredRecoveryMaxAmount(base = baseAmountPreview(), plan = recoveryPlanFromForm(), steps = activeRecoveryStepCountFromForm()) {
  if (!steps) return Math.max(.01, Number(base) || 1);
  const maxMultiplier = Math.max(1, ...plan.slice(0, steps).map((step) => Number(step?.multiplier) || 1));
  return Math.max(.01, Math.round((Number(base) || 1) * maxMultiplier * 100) / 100);
}

function normalizeRecoveryMaxAmount(rawMaxAmount, base, plan, steps) {
  const baseAmount = Math.max(.01, Number(base) || 1);
  const configured = Math.max(.01, Number(rawMaxAmount) || baseAmount);
  const required = requiredRecoveryMaxAmount(baseAmount, plan, steps);
  // v1.0.62 FINAL: Martingale cap must always cover the highest active step.
  // Example: base 80, steps x2/x4 => maxAmount 320; x2/x4/x8 => 640.
  // This prevents an old/manual cap from silently cutting recovery steps back to base.
  if (steps > 0) return Math.max(configured, required);
  return Math.max(configured, baseAmount);
}

function syncAutoAmountModeUi({ resetInactive = true } = {}) {
  const mode = $('autoAmountMode')?.value === 'balancePercent' ? 'balancePercent' : 'fixed';
  const fixedInput = $('autoAmount');
  const percentInput = $('autoBalancePercent');
  const fixedField = document.querySelector('[data-auto-amount-field="fixed"]');
  const percentField = document.querySelector('[data-auto-amount-field="balancePercent"]');

  if (mode === 'balancePercent') {
    if (resetInactive && fixedInput) fixedInput.value = '0';
    if (fixedInput) fixedInput.disabled = true;
    if (percentInput) {
      percentInput.disabled = false;
      if (!(Number(percentInput.value) > 0)) percentInput.value = '1';
    }
    fixedField?.classList.add('modeInactive');
    percentField?.classList.remove('modeInactive');
  } else {
    if (resetInactive && percentInput) percentInput.value = '0';
    if (percentInput) percentInput.disabled = true;
    if (fixedInput) {
      fixedInput.disabled = false;
      if (!(Number(fixedInput.value) > 0)) fixedInput.value = '1';
    }
    percentField?.classList.add('modeInactive');
    fixedField?.classList.remove('modeInactive');
  }
}

function baseAmountPreview() {
  const mode = $('autoAmountMode')?.value;
  if (mode === 'balancePercent') {
    const balance = Math.max(0, Number(state?.account?.balance) || 0);
    return balance * Math.max(.01, Number($('autoBalancePercent')?.value) || 1) / 100;
  }
  return Math.max(.01, Number($('autoAmount')?.value) || 1);
}

function formatPreviewAmount(value) {
  const currency = state?.account?.currency || settings.currencyOverride || '';
  const suffix = currencySuffix(currency === 'AUTO' ? '' : currency);
  return `${Number(value || 0).toFixed(2)}${suffix}`;
}

function renderRecoveryControls() {
  const panel = $('martingalePanel');
  if (!panel) return;
  const enabled = Boolean($('autoRecoveryEnabled')?.checked);
  const steps = Math.min(5, Math.max(1, Number($('autoRecoverySteps')?.value) || 1));
  const plan = recoveryPlanFromForm();
  const base = baseAmountPreview();
  const baseAmountMode = $('autoAmountMode')?.value === 'balancePercent' ? 'balancePercent' : 'fixed';
  const rawMaxAmount = Math.max(.01, Number($('autoMaxAmount')?.value) || base);
  const maxAmount = normalizeRecoveryMaxAmount(rawMaxAmount, base, plan, enabled ? steps : 0);
  if (enabled && $('autoMaxAmount') && Math.abs(Number($('autoMaxAmount').value || 0) - maxAmount) > .0001) {
    $('autoMaxAmount').value = String(maxAmount);
  }
  panel.classList.toggle('isOff', !enabled);
  let total = Math.min(base, maxAmount);
  const sequence = [`База ${formatPreviewAmount(Math.min(base, maxAmount))}`];
  document.querySelectorAll('[data-recovery-step]').forEach((card) => {
    const number = Number(card.dataset.recoveryStep);
    const visible = number <= steps;
    const active = enabled && visible;
    card.hidden = !visible;
    card.classList.toggle('isHidden', !visible);
    card.classList.toggle('isDisabled', !active);
    card.querySelectorAll('input,select').forEach((control) => { control.disabled = !active; });
    const raw = base * plan[number - 1].multiplier;
    const actual = Math.min(raw, maxAmount);
    const capped = raw > maxAmount + .0001;
    const label = $(`autoRecoveryAmount${number}`);
    if (label) label.textContent = `×${plan[number - 1].multiplier} · ${formatPreviewAmount(actual)}${capped ? ' (лимит)' : ''}`;
    if (active) {
      total += actual;
      sequence.push(`Шаг ${number} ${formatPreviewAmount(actual)}`);
    }
  });
  const summary = $('autoRecoverySummary');
  if (summary) {
    const first = summary.querySelector('b');
    if (first) first.textContent = enabled ? sequence.join(' → ') : 'Мартингейл выключен';
  }
  const worst = $('autoRecoveryWorstCase');
  if (worst) worst.textContent = enabled ? formatPreviewAmount(total) : formatPreviewAmount(base);
}



function selectedAutoStrategyIdsFromUi() {
  return [...document.querySelectorAll('#autoStrategyChecklist .autoStrategyOption.selected[data-auto-strategy]')].map((button) => button.dataset.autoStrategy);
}

async function persistAutoStrategyMode(rawValue, { notify = true } = {}) {
  const selectedCount = selectedStrategyIdsForAuto(settings.autoTrade || {}).length;
  const mode = selectedCount > 1 ? 'independent' : (['best', 'independent'].includes(rawValue) ? rawValue : 'best');
  settings.autoTrade = { ...settings.autoTrade, strategyMode: mode };
  await saveSettings({ autoTrade: settings.autoTrade });
  if (notify) {
    const labels = { best: 'Лучший сигнал', independent: 'Каждая стратегия отдельно' };
    toast(selectedCount > 1 ? 'Несколько стратегий всегда работают независимо.' : `Режим объединения: ${labels[mode]}`, 'ok');
  }
  return mode;
}

async function persistAutoCandleOffset(rawValue, { notify = true } = {}) {
  if ($('autoCandleOffset')) $('autoCandleOffset').value = String(normalizeCandleOffset(rawValue, settings.autoTrade?.candleMode));
  const auto = await persistFocusedAutoStrategyProfile();
  const profile = autoStrategyExecutionProfile(focusedAutoProfileStrategyId, auto);
  if (notify) toast(`${autoStrategyItem(focusedAutoProfileStrategyId)?.title || 'Стратегия'}: ${candleOffsetLabel(profile.candleOffset)}`, 'ok');
  return profile.candleOffset;
}

async function persistFocusedAutoStrategyProfile({ notify = false } = {}) {
  const snapshot = autoExecutionSettingsSnapshot(settings.autoTrade || {});
  const primaryId = selectedStrategyIdsForAuto(snapshot)[0] || '';
  const primaryProfile = primaryId ? autoStrategyExecutionProfile(primaryId, snapshot) : null;
  const nextAuto = {
    ...settings.autoTrade,
    strategyProfiles: snapshot.strategyProfiles,
    profileSettingsVersion: 1,
    // Legacy scalar fields mirror the first selected strategy. New code uses the
    // per-strategy map, while older server builds still receive a safe fallback.
    period: primaryProfile?.period ?? snapshot.period,
    duration: primaryProfile?.duration ?? snapshot.duration,
    candleOffset: primaryProfile?.candleOffset ?? normalizeCandleOffset(snapshot.candleOffset, snapshot.candleMode),
    candleMode: (primaryProfile?.candleOffset ?? normalizeCandleOffset(snapshot.candleOffset, snapshot.candleMode)) === 0 ? 'current' : 'closed',
    cooldown: primaryProfile?.cooldown ?? Math.max(0, Number(snapshot.cooldown) || 0)
  };
  settings.autoTrade = nextAuto;
  if (primaryProfile) settings.period = primaryProfile.period;
  await saveSettings({ autoTrade: nextAuto, period: primaryProfile?.period ?? settings.period });
  if (notify) toast(`Профиль «${autoStrategyItem(focusedAutoProfileStrategyId)?.title || focusedAutoProfileStrategyId}» сохранён.`, 'ok');
  return nextAuto;
}

function renderAutoStrategyOptions() {
  const localNotice = $('autoLocalEngineNotice');
  if (localNotice) {
    const localMode = String(currentEntitlement()?.source || '').toLowerCase() === 'local';
    localNotice.hidden = !localMode;
    localNotice.textContent = localMode
      ? uiText(
          'Автономный режим: автоторговля работает только с локально реализованной стратегией 3-Candle EMA14. Серверные стратегии и AI не запускаются и не заменяются приблизительными сигналами.',
          'Offline mode: auto trading supports only the locally implemented 3-Candle EMA14 strategy. Server strategies and AI are not run or replaced with approximate signals.'
        )
      : '';
  }
  const auto = { ...DEFAULT_AUTO, ...(settings.autoTrade || {}) };
  const selected = new Set(Array.isArray(auto.strategyIds) && auto.strategyIds.length ? auto.strategyIds.map(String) : [auto.strategyId || settings.activeStrategyId].filter(Boolean).map(String));
  if (!focusedAutoProfileStrategyId || !selected.has(String(focusedAutoProfileStrategyId))) focusedAutoProfileStrategyId = [...selected][0] || null;
  const items = tradeStrategies().filter((item) => !strategyLockedForAccess(item));
  $('autoStrategyChecklist').innerHTML = items.length ? items.map((item) => {
    const compatibility = autoStrategyCompatibility(item.id, auto, item);
    const checked = selected.has(String(item.id));
    const focused = String(focusedAutoProfileStrategyId || '') === String(item.id);
    const needsSave = Boolean(item.custom && !item.engineReady);
    const incompatible = checked && !compatibility.compatible;
    const subtitle = incompatible
      ? `Недоступно · ${compatibility.requirement}`
      : (needsSave ? 'Черновик · сохранить на сервере' : (item.badge || (item.ai ? 'AI' : 'Серверная')));
    const stateLabel = incompatible ? 'Недоступна' : checked ? 'Выбрана' : needsSave ? 'Сохранить' : 'Выбрать';
    const cardTitle = incompatible
      ? compatibility.requirement
      : checked
        ? uiText(
          'Нажмите на карточку, чтобы открыть настройки. Для отключения используйте кнопку справа.',
          'Click the card to open its settings. Use the button on the right to disable it.'
        )
        : uiText(
          'Нажмите на карточку, чтобы выбрать стратегию и открыть её настройки.',
          'Click the card to select the strategy and open its settings.'
        );
    const toggleTitle = checked
      ? uiText('Отключить стратегию', 'Disable strategy')
      : uiText('Добавить стратегию', 'Add strategy');
    return `<div class="autoStrategyOption ${checked ? 'selected' : ''} ${incompatible ? 'incompatible' : ''} ${focused ? 'focused' : ''}" data-auto-strategy="${escapeHtml(item.id)}" role="button" tabindex="0" aria-current="${focused ? 'true' : 'false'}" title="${escapeHtml(cardTitle)}"><span class="autoStrategyBody"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(subtitle)}</small></span><button type="button" class="autoStrategyState autoStrategyToggle" aria-pressed="${checked ? 'true' : 'false'}" title="${escapeHtml(toggleTitle)}">${escapeHtml(stateLabel)}</button></div>`;
  }).join('') : '<div class="empty">Нет доступных стратегий</div>';
  const strategyMode = selected.size > 1 ? 'independent' : (auto.strategyMode === 'independent' ? 'independent' : 'best');
  if ($('autoStrategyMode')) $('autoStrategyMode').value = strategyMode;
  updateAutoStrategyExecutionProfileUi();
  renderAutoStrategyCompatibilityNotice();
}

function populateIndicatorOptions() {
  const select = $('ruleIndicator');
  if (!select) return;
  const current = select.value || select.dataset.lastValue || '';
  const availableValues = new Set(INDICATORS.map(([value]) => value).filter((value) => !BUILDER_HIDDEN_INDICATORS.has(value)));
  const groups = [
    ['Базовые данные', ['price', 'payout', 'volume']],
    ['Скользящие и тренд', ['sma', 'ema', 'wma', 'hma', 'dema', 'tema', 'vwap', 'alligator', 'supertrend', 'parabolicSar', 'ichimoku']],
    ['Осцилляторы', ['rsi', 'stochastic', 'stochRsi', 'macd', 'awesome', 'momentum', 'roc', 'cci', 'mfi', 'williams', 'adx', 'vortex']],
    ['Каналы и волатильность', ['bollinger', 'keltner', 'donchian', 'atr', 'stddev']],
    ['Объём, тики и импульс', ['obv', 'tickRate', 'tickAcceleration']],
    ['Уровни и Price Action', ['support', 'pivot', 'fractals', 'zigzag', 'trendline', 'breakout', 'retest', 'falseBreakout', 'liquidity', 'orderBlock', 'priceAction', 'candlePattern', 'candleSequence', 'chartPattern', 'doubleTopBottom', 'headShoulders', 'triangleWedge', 'flagPennant', 'channelPattern', 'cupHandle', 'diamondPattern']],
    ['Фильтры режима и AI', ['marketRegime', 'mtfTrend', 'aiScore']]
  ];
  const meta = new Map(INDICATORS.map(([value, label, premium]) => [value, { label, premium }]));
  const seen = new Set();
  const optionHtml = (value) => {
    const item = meta.get(value);
    if (!item) return '';
    seen.add(value);
    const locked = Boolean(item.premium && !access.premium);
    return `<option value="${escapeHtml(value)}" ${locked ? 'disabled' : ''}>${escapeHtml(item.label)}${locked ? ' · PREMIUM' : ''}</option>`;
  };
  const grouped = groups.map(([title, values]) => {
    const options = values.filter((value) => availableValues.has(value)).map(optionHtml).join('');
    return options ? `<optgroup label="${escapeHtml(title)}">${options}</optgroup>` : '';
  }).join('');
  const rest = INDICATORS.filter(([value]) => !seen.has(value)).map(([value]) => optionHtml(value)).join('');
  select.innerHTML = `<option value="" disabled>Выберите индикатор / фильтр</option>${grouped}${rest}`;
  const canRestore = current && availableValues.has(current) && !select.querySelector(`option[value="${CSS.escape(current)}"]`)?.disabled;
  select.value = canRestore ? current : '';
  select.dataset.lastValue = select.value || '';
}


function populateRuleOperatorOptions(indicator) {
  const select = $('ruleOperator');
  if (!select) return;
  const current = select.value || 'signal';
  const allowed = BUILDER_OPERATOR_OPTIONS[indicator] || ['signal'];
  select.innerHTML = allowed.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(OPERATOR_LABELS[value] || value)}</option>`).join('');
  select.value = allowed.includes(current) ? current : allowed[0];
}

function updateRuleContextFields(indicator) {
  const source = $('ruleSource');
  const sourceField = source?.closest('label');
  if (sourceField) sourceField.hidden = false;
  if (source) {
    source.disabled = false;
    source.value = normalizeRuleSource(source.value);
  }
  const mode = $('ruleSignalMode');
  const modeField = mode?.closest('label');
  if (modeField) modeField.hidden = false;
  if (mode) {
    mode.disabled = false;
    mode.value = normalizeRuleSignalMode(mode.value);
  }
  const value = $('ruleValue');
  const period = $('rulePeriod');
  const params = $('ruleParams');
  const simpleSignal = ['candleSequence','candlePattern','heikenAshi','priceAction','chartPattern','doubleTopBottom','headShoulders','triangleWedge','flagPennant','channelPattern','cupHandle','diamondPattern','support','pivot','fractals','zigzag','trendline','breakout','retest','falseBreakout','liquidity','orderBlock','marketRegime','mtfTrend'].includes(indicator);
  if (value?.closest('label')) value.closest('label').hidden = false;
  if (period?.closest('label')) period.closest('label').hidden = indicator === 'payout' || indicator === 'marketRegime' || indicator === 'aiScore';
  if (params?.closest('label')) params.closest('label').hidden = false;
  if (simpleSignal && value && !value.value.trim()) value.value = 'auto';
}

function syncRuleSourceSelection() {
  const source = normalizeRuleSource($('ruleSource')?.value);
  if ($('ruleSource')) $('ruleSource').value = source;
  if ($('ruleIndicator')?.value === 'price') {
    const value = $('ruleValue');
    const params = $('ruleParams');
    if (value && (value.dataset.autofill === '1' || RULE_SOURCES.includes(String(value.value || '').toLowerCase()))) {
      value.value = source;
      value.dataset.autofill = '1';
    }
    if (params && (params.dataset.autofill === '1' || /(^|,\s*)source\s*=/i.test(params.value))) {
      const nextSourceParam = `source=${source}`;
      params.value = params.value.trim()
        ? params.value.replace(/(^|,\s*)source\s*=\s*[^,]+/i, (match, prefix) => `${prefix}${nextSourceParam}`)
        : nextSourceParam;
      params.dataset.autofill = '1';
    }
  }
  updateRuleComposerPreview();
}

function indicatorDefaults(indicator) {
  return {
    price: { period: 1, value: 'close', params: 'source=close' },
    sma: { period: 20, value: 'SMA 20', params: 'period=20' },
    ema: { period: 20, value: 'EMA 20', params: 'period=20' },
    wma: { period: 20, value: 'WMA 20', params: 'period=20' },
    hma: { period: 21, value: 'HMA 21', params: 'period=21' },
    dema: { period: 20, value: 'DEMA 20', params: 'period=20' },
    tema: { period: 20, value: 'TEMA 20', params: 'period=20' },
    vwap: { period: 14, value: 'VWAP', params: 'session=current' },
    alligator: { period: 13, value: 'Jaw 13 / Teeth 8 / Lips 5', params: 'jaw=13, teeth=8, lips=5, jawShift=8, teethShift=5, lipsShift=3' },
    rsi: { period: 14, value: '30 / 70', params: 'period=14, buyBelow=30, sellAbove=70' },
    stochastic: { period: 14, value: '20 / 80', params: 'k=14, d=3, smooth=3, buyBelow=20, sellAbove=80' },
    stochRsi: { period: 14, value: '20 / 80', params: 'rsi=14, k=3, d=3' },
    macd: { period: 12, value: 'MACD signal', params: 'fast=12, slow=26, signal=9' },
    awesome: { period: 34, value: 'zero / saucer', params: 'fast=5, slow=34' },
    momentum: { period: 10, value: '0', params: 'period=10' },
    roc: { period: 9, value: '0', params: 'period=9' },
    cci: { period: 20, value: '-100 / 100', params: 'period=20' },
    mfi: { period: 14, value: '20 / 80', params: 'period=14' },
    williams: { period: 14, value: '-80 / -20', params: 'period=14' },
    adx: { period: 14, value: '22', params: 'period=14, di=true' },
    vortex: { period: 14, value: 'VI cross', params: 'period=14' },
    supertrend: { period: 10, value: 'trend flip', params: 'atr=10, multiplier=3' },
    parabolicSar: { period: 14, value: 'SAR flip', params: 'step=0.02, max=0.2' },
    ichimoku: { period: 9, value: 'cloud breakout', params: 'tenkan=9, kijun=26, senkou=52' },
    bollinger: { period: 20, value: 'outer band', params: 'period=20, deviation=2' },
    keltner: { period: 20, value: 'channel touch', params: 'ema=20, atr=10, multiplier=2' },
    donchian: { period: 20, value: 'channel breakout', params: 'lookback=20' },
    atr: { period: 14, value: 'volatility expansion', params: 'period=14, compare=avg' },
    stddev: { period: 20, value: 'volatility', params: 'period=20' },
    obv: { period: 20, value: 'OBV direction', params: 'period=20' },
    volume: { period: 20, value: 'volume spike', params: 'period=20, multiplier=1.5' },
    tickRate: { period: 10, value: 'tick activity', params: 'window=10, multiplier=1.3' },
    tickAcceleration: { period: 10, value: '1.8x average', params: 'window=10, multiplier=1.8' },
    support: { period: 50, value: 'level touch', params: 'lookback=100, touch=2, tolerance=0.1%' },
    pivot: { period: 20, value: 'pivot reaction', params: 'lookback=20' },
    fractals: { period: 5, value: 'fractal break', params: 'left=2, right=2' },
    zigzag: { period: 12, value: 'swing direction', params: 'depth=12, deviation=5' },
    trendline: { period: 50, value: 'trendline touch', params: 'lookback=50, touches=2' },
    breakout: { period: 50, value: 'breakout + retest', params: 'lookback=100, retest=true' },
    retest: { period: 50, value: 'confirmed retest', params: 'lookback=100, tolerance=0.1%' },
    falseBreakout: { period: 50, value: 'false breakout', params: 'lookback=100, returnInside=true' },
    liquidity: { period: 50, value: 'sweep', params: 'lookback=50, sweep=true' },
    orderBlock: { period: 50, value: 'OB reaction', params: 'lookback=80, mitigation=true' },
    priceAction: { period: 20, value: 'pullback / impulse', params: 'pattern=pullback, confirmation=2' },
    candlePattern: { period: 3, value: 'reversal / continuation', params: 'engulfing=true, doji=true, stars=true' },
    candleSequence: { period: 3, value: 'custom sequence', params: '{"candles":[{"direction":"green","body":"medium"},{"direction":"green","relation":"ratio_prev","min":1.5,"max":2.0},{"direction":"green","relation":"ratio_prev","min":1.5,"max":2.0}],"entry":"put","confirm":"closed"}' },
    chartPattern: { period: 100, value: 'auto figure', params: 'lookback=100, tolerance=25, confirmation=any' },
    doubleTopBottom: { period: 100, value: 'top / bottom', params: 'lookback=100, tolerance=25, touches=2' },
    headShoulders: { period: 100, value: 'H&S / inverse', params: 'lookback=100, shoulderTolerance=30' },
    triangleWedge: { period: 100, value: 'compression breakout', params: 'lookback=100, tolerance=25' },
    flagPennant: { period: 60, value: 'flag continuation', params: 'lookback=60, pole=impulse, channel=compact' },
    channelPattern: { period: 80, value: 'channel touch/break', params: 'lookback=80, touches=2' },
    cupHandle: { period: 100, value: 'cup handle breakout', params: 'lookback=100, handleMax=30' },
    diamondPattern: { period: 100, value: 'diamond breakout', params: 'lookback=100, expansion=true, compression=true' },
    marketRegime: { period: 60, value: 'trend / range', params: 'trendMin=60, rangeMax=40' },
    payout: { period: 1, value: '>= minimum', params: 'min=75' },
    mtfTrend: { period: 50, value: 'aligned', params: 'higherTf=5x, strength=60' },
    aiScore: { period: 1, value: '70', params: 'minScore=70, model=ensemble' }
  }[indicator] || { period: 14, value: '', params: 'period=14' };
}

function syncRuleDefaultsForIndicator() {
  const indicator = $('ruleIndicator')?.value || '';
  const period = $('rulePeriod');
  const value = $('ruleValue');
  const params = $('ruleParams');
  if (!indicator) {
    populateRuleOperatorOptions('');
    updateRuleContextFields('');
    if (period && period.dataset.autofill === '1') period.value = '';
    if (value && value.dataset.autofill === '1') value.value = '';
    if (params) {
      params.placeholder = 'Выберите индикатор — параметры подставятся автоматически';
      if (params.dataset.autofill === '1') params.value = '';
    }
    updateRuleComposerPreview();
    return;
  }
  populateRuleOperatorOptions(indicator);
  updateRuleContextFields(indicator);
  const defaults = indicatorDefaults(indicator);
  if (period && (!Number(period.value) || period.dataset.autofill === '1')) {
    period.value = String(defaults.period || 14);
    period.dataset.autofill = '1';
  }
  if (value && (!value.value.trim() || value.dataset.autofill === '1')) {
    value.value = defaults.value || '';
    value.dataset.autofill = '1';
  }
  if (params) {
    params.placeholder = defaults.params || 'period=14, level=70, deviation=2';
    if (!params.value.trim() || params.dataset.autofill === '1') {
      params.value = defaults.params || '';
      params.dataset.autofill = '1';
    }
  }
  if (indicator === 'price') syncRuleSourceSelection();
  updateRuleComposerPreview();
}

function updateRuleComposerPreview() {
  const preview = $('ruleComposerPreview');
  if (!preview) return;
  const indicator = $('ruleIndicator')?.value || '';
  if (!indicator) {
    preview.innerHTML = `<b>Выберите индикатор / фильтр</b><small>После выбора автоматически появятся период, уровень и индивидуальные параметры.</small>`;
    return;
  }
  const operator = $('ruleOperator')?.value || 'signal';
  const value = $('ruleValue')?.value || '';
  const period = $('rulePeriod')?.value || '—';
  const timeframe = $('ruleTimeframe')?.value || 'current';
  const params = $('ruleParams')?.value || '';
  const source = normalizeRuleSource($('ruleSource')?.value);
  const signalMode = normalizeRuleSignalMode($('ruleSignalMode')?.value);
  preview.innerHTML = `<b>${escapeHtml(indicatorLabel(indicator))}</b> ${escapeHtml(OPERATOR_LABELS[operator] || operator)} <b>${escapeHtml(value || 'условие')}</b><small>Период ${escapeHtml(period)} · таймфрейм ${escapeHtml(timeframe === 'current' ? 'текущий' : formatDuration(Number(timeframe)))} · источник ${escapeHtml(RULE_SOURCE_LABELS[source] || source)} · ${escapeHtml(RULE_SIGNAL_MODE_LABELS[signalMode] || signalMode)}${params ? ` · ${escapeHtml(params)}` : ''}</small>`;
}

function indicatorLabel(value) {
  return INDICATORS.find((item) => item[0] === value)?.[1] || value;
}

function selectedBuilderPatterns() {
  return [...document.querySelectorAll('#builderPatterns input[type="checkbox"]:checked')].map((input) => input.value);
}

function refreshBuilderPatternVisuals() {
  document.querySelectorAll('#builderPatterns input[type="checkbox"]').forEach((input) => {
    const label = input.closest('label');
    if (label) label.classList.toggle('is-selected', Boolean(input.checked));
  });
}

function setBuilderPatterns(values = []) {
  const selected = new Set(Array.isArray(values) ? values : []);
  document.querySelectorAll('#builderPatterns input[type="checkbox"]').forEach((input) => {
    input.checked = selected.has(input.value);
  });
  refreshBuilderPatternVisuals();
}



function patternSettingsFromForm() {
  const pick = (id, fallback) => ($(id)?.value ?? fallback);
  return {
    searchMode: ['auto','strict','soft'].includes(String(pick('builderPatternSearchMode','auto'))) ? String(pick('builderPatternSearchMode','auto')) : 'auto',
    lookback: Math.min(100, Math.max(10, Number(pick('builderPatternLookback',100)) || 100)),
    touches: Math.min(6, Math.max(2, Number(pick('builderPatternTouches',2)) || 2)),
    tolerance: Math.min(80, Math.max(5, Number(pick('builderPatternTolerance',25)) || 25)),
    confirmation: ['breakout','retest','reversal','any'].includes(String(pick('builderPatternConfirmation','breakout'))) ? String(pick('builderPatternConfirmation','breakout')) : 'breakout',
    strength: Math.min(95, Math.max(40, Number(pick('builderPatternStrength',60)) || 60)),
    freshOnly: String(pick('builderPatternFresh','1')) !== '0',
    role: ['confirm','primary','filter'].includes(String(pick('builderPatternRole','confirm'))) ? String(pick('builderPatternRole','confirm')) : 'confirm'
  };
}

function setBuilderPatternSettings(settings = {}) {
  const values = {
    builderPatternSearchMode: settings.searchMode || 'auto',
    builderPatternLookback: String(Math.min(100, Math.max(10, Number(settings.lookback) || 100))),
    builderPatternTouches: String(Math.min(6, Math.max(2, Number(settings.touches) || 2))),
    builderPatternTolerance: String(Math.min(80, Math.max(5, Number(settings.tolerance) || 25))),
    builderPatternConfirmation: settings.confirmation || 'breakout',
    builderPatternStrength: String(Math.min(95, Math.max(40, Number(settings.strength) || 60))),
    builderPatternFresh: settings.freshOnly === false ? '0' : '1',
    builderPatternRole: settings.role || 'confirm'
  };
  for (const [id, value] of Object.entries(values)) if ($(id)) $(id).value = value;
}

function updateBuilderSummary() {
  if (!$('builderSummary')) return;
  const patterns = selectedBuilderPatterns();
  const ps = patternSettingsFromForm();
  $('builderSummary').textContent = `${builderRules.length} условий · ${patterns.length} паттернов · поиск ${ps.lookback} свечей`;
}

function renderRules() {
  const rulesNode = $('rulesList');
  if (!rulesNode) return;
  rulesNode.innerHTML = builderRules.length
    ? builderRules.map((rule, index) => {
      const params = rule.params ? ` · параметры: ${rule.params}` : '';
      const sourceValue = normalizeRuleSource(rule.source);
      const modeValue = normalizeRuleSignalMode(rule.signalMode);
      const source = ` · источник ${RULE_SOURCE_LABELS[sourceValue] || sourceValue}`;
      const mode = ` · ${RULE_SIGNAL_MODE_LABELS[modeValue] || modeValue}`;
      const group = rule.group ? ` · группа ${rule.group}` : '';
      const title = rule.indicatorLabel || indicatorLabel(rule.indicator);
      return `<div class="rule"><div><b>${escapeHtml(title)} ${escapeHtml(OPERATOR_LABELS[rule.operator] || rule.operator)} ${escapeHtml(rule.value || '')}</b><small>ID ${escapeHtml(rule.indicator)} · период ${escapeHtml(rule.period)} · вес ${escapeHtml(rule.weight)} · таймфрейм ${escapeHtml(rule.timeframe || 'current')}${escapeHtml(group)}${escapeHtml(params)}${escapeHtml(source)}${escapeHtml(mode)}</small></div><button data-remove-rule="${index}" title="Удалить">✕</button></div>`;
    }).join('')
    : '<div class="empty builderEmptyState"><b>Условий пока нет</b><span>Добавьте первое условие выше или выберите готовый шаблон. Минимум нужен основной сигнал A.</span></div>';
  updateBuilderSummary();
}

function allCustomStrategiesForTransfer() {
  const remoteCustom = serverStrategies().filter((item) => item.custom);
  const localDrafts = (settings.builderStrategies || []).filter((local) => !remoteCustom.some((remote) => remote.id === local.id));
  return [
    ...remoteCustom.map((item) => ({ id: item.id, name: item.title, ...(item.config || {}), description: item.description, serverSaved: true })),
    ...localDrafts.map((item) => ({ ...item, serverSaved: String(item.id || '').startsWith('custom-') }))
  ];
}

function renderSavedStrategies() {
  const list = allCustomStrategiesForTransfer();
  $('savedStrategiesList').innerHTML = list.length
    ? list.map((item) => {
      const serverSaved = String(item.id || '').startsWith('custom-') || item.serverSaved === true;
      const status = serverSaved ? 'Серверная · доступна в торговых режимах' : 'Черновик · сохраните на сервере';
      const activateDisabled = serverSaved ? '' : 'disabled title="Сначала нажмите «Изменить» и сохраните на сервере"';
      return `<div class="savedItem"><h4>${escapeHtml(item.name || item.title)}</h4><p>${escapeHtml(`${status} · ${item.rules?.length || 0} условий · ${logicLabel(item.logic)} · ${item.direction === 'call' ? 'BUY' : item.direction === 'put' ? 'SELL' : 'BUY/SELL'} · ${candleOffsetLabel(item.candleOffset ?? (item.candleMode === 'current' ? 0 : -1))}`)}</p><div class="actions"><button data-builder-action="activate" data-id="${escapeHtml(item.id)}" ${activateDisabled}>Выбрать</button><button data-builder-action="edit" data-id="${escapeHtml(item.id)}">Изменить</button><button data-builder-action="export" data-id="${escapeHtml(item.id)}">Экспорт JSON</button><button data-builder-action="delete" data-id="${escapeHtml(item.id)}">Удалить</button></div></div>`;
    }).join('')
    : '<div class="empty">Сохранённых стратегий пока нет.</div>';
}


function showBuilderReadyForTester(strategyId, name = '') {
  const button = $('builderReadyForTester');
  if (!button) return;
  button.hidden = false;
  button.dataset.strategyId = String(strategyId || '').trim();
  button.dataset.strategyName = String(name || '').trim();
}

function hideBuilderReadyForTester() {
  const button = $('builderReadyForTester');
  if (!button) return;
  button.hidden = true;
  button.dataset.strategyId = '';
  button.dataset.strategyName = '';
}

function openSavedStrategyInTester(strategyId) {
  const id = String(strategyId || '').trim();
  if (!id) {
    toast('Сначала сохраните стратегию на сервере.', 'error');
    return;
  }
  setTab('tester');
  initializeTesterInputs();
  refreshTesterConfig();
  renderTesterStrategyOptions();
  document.querySelectorAll('input[data-tester-strategy]').forEach((input) => { input.checked = String(input.value) === id; });
  const select = $('testerStrategies');
  if (select) [...select.options].forEach((option) => { option.selected = String(option.value) === id; });
  syncTesterStrategySelectFromCards();
  setTesterProgress('Стратегия выбрана и готова к тестированию.', 'ok');
  document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function formatDuration(seconds) {
  if (Number(seconds) === 0) return 'как анализ';
  const value = Math.max(1, Number(seconds) || 1);
  if (value < 60) return `${value} сек`;
  if (value % 3600 === 0) return `${value / 3600} ч`;
  if (value % 60 === 0) return `${value / 60} мин`;
  return `${value} сек`;
}

function updateBuilderConditionalFields() {
  const assetMode = $('builderAssetMode')?.value || 'selected';
  const setVisible = (id, visible) => {
    const node = $(id);
    if (!node) return;
    node.hidden = !visible;
    node.classList.toggle('fieldHidden', !visible);
  };
  setVisible('builderAssetsField', assetMode === 'custom');
}

function renderBuilder() {
  updateBuilderConditionalFields();
  const available = Boolean(access.entitlement?.features?.strategyBuilder ?? access.premium);
  if ($('builderPlanPill')) $('builderPlanPill').textContent = access.tier || 'FREE';
  $('builderLock').hidden = available;
  $('builderContent').classList.toggle('locked', !available);
  populateIndicatorOptions();
  syncRuleDefaultsForIndicator();
  renderRules();
  renderSavedStrategies();
  updateBuilderSummary();
}

function normalizedAssetList() {
  const list = Array.isArray(state?.market?.assetList) ? state.market.assetList : [];
  const seen = new Set();
  const result = [];
  const knownCurrencies = new Set(['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD','CNY','HKD','SGD','NOK','SEK','DKK','PLN','TRY','ZAR','MXN','BRL','INR','COP','CLP','ARS','PEN','AED','SAR','QAR','KWD','BHD','OMR','THB','IDR','MYR','PHP','KRW','TWD','CZK','HUF','RON','ILS','BDT','DZD','EGP','PKR','VND','YER','LBP','TND','MAD','JOD','IRR','SYP','NGN','KES','UAH','RUB']);
  const cryptoCodes = new Set(['BTC','ETH','LTC','DOGE','SOL','XRP','ADA','BNB','DOT','AVAX','TRX','TON','BCH','DASH','MATIC','POL','LINK','LNK','ETC','XLM','ATOM','UNI','AAVE','FIL','NEAR','APT','ARB','OP','SHIB','USDT','USDC','DAI','BITB']);
  const normalizedCode = (symbol) => String(symbol || '').replace(/_otc$/i, '').replace(/^#/, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const isKnownForexPair = (symbol) => {
    const base = normalizedCode(symbol);
    return base.length === 6 && knownCurrencies.has(base.slice(0, 3)) && knownCurrencies.has(base.slice(3, 6));
  };
  const isKnownCrypto = (raw, symbol) => {
    const type = String(raw?.type || '').toLowerCase();
    const code = normalizedCode(symbol);
    const text = `${symbol || ''} ${raw?.name || ''} ${raw?.category || ''}`.toUpperCase();
    if (/crypt|coin|token|digital/.test(type) || /\b(CRYPTO|BITCOIN|ETHEREUM|LITECOIN|DOGECOIN|SOLANA|RIPPLE|CARDANO|POLKADOT|AVALANCHE|CHAINLINK)\b/.test(text)) return true;
    if (cryptoCodes.has(code)) return true;
    return [...cryptoCodes].some((crypto) => code.startsWith(crypto) || code.endsWith(crypto));
  };
  const classify = (raw, symbol) => {
    const existingCategory = String(raw?.category || '').trim();
    if (existingCategory) return existingCategory;
    const type = String(raw?.type || '').toLowerCase();
    const text = `${symbol} ${raw?.name || ''}`.toUpperCase();
    const isOtc = Boolean(raw?.isOtc) || /_otc$/i.test(symbol) || /\bOTC\b/.test(text);
    if (/(XAU|XAG|XPT|XPD|GOLD|SILVER|PLATIN|PALLAD)/.test(text)) return 'Металлы';
    if (/commod|energy|agric|oil|gas/.test(type) || /(OIL|BRENT|WTI|GAS|CORN|WHEAT|COFFEE|SUGAR|COTTON|CRUDE|XNG)/.test(text)) return 'Сырьё';
    if (isKnownForexPair(symbol) || /^(currency|currencies|forex)$/.test(type.trim())) return isOtc ? 'Валютные OTC' : 'Валюты';
    if (isKnownCrypto(raw, symbol)) return 'Криптовалюты';
    if (/index|indice/.test(type) || /(SP500|NAS|DJI|D30|E35|E50|F40|JPN225|AUS200|VIX|100GBP)/.test(text)) return 'Индексы';
    if (/stock|share|equity/.test(type) || /^#/.test(symbol)) return 'Акции';
    return isOtc ? 'OTC / Прочее' : 'Прочее';
  };
  for (const raw of list) {
    const symbol = normalizeUiAsset(raw?.symbol);
    if (!symbol || seen.has(symbol) || !isAllowedProductAsset(symbol)) continue;
    seen.add(symbol);
    result.push({ ...raw, symbol, category: classify(raw, symbol) });
  }
  return result;
}

function renderAssetCatalog() {
  const list = normalizedAssetList();
  const query = $('assetSearch')?.value?.trim().toLowerCase() || '';
  const filtered = list.filter((asset) => !query || `${asset.symbol} ${asset.name} ${asset.category}`.toLowerCase().includes(query));
  const groups = new Map();
  for (const asset of filtered) {
    const category = asset.category || (asset.isOtc ? 'OTC' : 'Прочие');
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(asset);
  }
  if (!list.length) {
    $('assetCatalog').innerHTML = '<div class="empty">Подключите аккаунт — полный список активов загрузится из Pocket Option автоматически.</div>';
    return;
  }
  if (!filtered.length) {
    $('assetCatalog').innerHTML = '<div class="empty">По вашему запросу активы не найдены.</div>';
    return;
  }
  const order = ['Валютные OTC', 'Валюты', 'Металлы', 'Сырьё', 'Акции', 'Криптовалюты', 'Индексы', 'OTC / Прочее', 'Прочее'];
  const categories = [...groups.keys()].sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)) || a.localeCompare(b, 'ru'));
  $('assetCatalog').innerHTML = categories.map((category) => {
    const assets = groups.get(category);
    const collapsed = collapsedAssetCategories.has(category);
    const selectedCount = assets.filter((asset) => selectedAssets.has(asset.symbol)).length;
    return `<section class="assetGroup ${collapsed ? 'collapsed' : ''}" data-category="${escapeHtml(category)}"><div class="assetGroupTitle"><button type="button" data-toggle-category="${escapeHtml(category)}">${collapsed ? '▸' : '▾'} ${escapeHtml(category)} <span>${selectedCount}/${assets.length}</span></button><div class="assetGroupActions"><button type="button" data-select-category="${escapeHtml(category)}">Выбрать все</button><button type="button" data-clear-category="${escapeHtml(category)}">Снять</button></div></div><div class="assetGrid">${assets.map((asset) => {
      const checked = selectedAssets.has(asset.symbol);
      const disabled = asset.active === false;
      const payout = asset.payout == null ? 'мин. выплата актива —' : `мин. выплата актива ${formatNumber(asset.payout, 1)}%`;
      return `<button class="assetItem ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}" type="button" data-asset="${escapeHtml(asset.symbol)}" aria-pressed="${checked ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}><div><b>${escapeHtml(asset.symbol)}</b><small>${escapeHtml(asset.name || asset.symbol)} · ${escapeHtml(payout)}</small></div></button>`;
    }).join('')}</div></section>`;
  }).join('');
}

function renderMarket() {
  const maxAssets = access.limits?.maxAssets;
  $('assetCounter').textContent = `${selectedAssets.size} выбрано`;
  $('subscriptionLimit').textContent = maxAssets == null ? (access.premium ? 'PREMIUM: все активы доступны' : 'Лимит активов определяется сервером') : `FREE: максимум ${maxAssets} активов`;
  renderAssetCatalog();
  const subscriptions = state?.market?.subscriptions || {};
  const assetList = Array.isArray(state?.market?.assetList) ? state.market.assetList : [];
  const assetBySymbol = new Map(assetList.map((asset) => [String(asset?.symbol || ''), asset]));
  const subscriptionRequested = (item) => Boolean(item?.requested || item?.subscribed || item?.streamActive);
  const subscriptionFromCache = (item) => item?.source === 'cache-bridge' || item?.marketDataSource === 'CasheOTC.json' || item?.marketDataSource === 'cashe.json';
  const subscriptionUnavailable = (item) => item?.unavailableOnPocket === true;
  const subscriptionBelowPayout = (item) => {
    const payout = Number(assetBySymbol.get(String(item?.asset || ''))?.payout);
    return Number.isFinite(payout) && payout < MIN_TRADE_PAYOUT && !subscriptionUnavailable(item);
  };
  const subscriptionLive = (item) => !subscriptionUnavailable(item) && !subscriptionBelowPayout(item)
    && Boolean(item?.streamActive)
    && (subscriptionFromCache(item) ? item?.cacheBridgeFresh === true : Number(item?.tickCount || 0) > 0);
  const subscriptionItems = selectedAssets.size
    ? [...selectedAssets].map((asset) => {
        const source = subscriptions[asset] && typeof subscriptions[asset] === 'object' ? subscriptions[asset] : {};
        const marketAsset = assetBySymbol.get(asset) || null;
        return {
          asset,
          ...source,
          unavailableOnPocket: marketAsset?.active === false
        };
      })
    : Object.values(subscriptions).map((item) => ({
        ...item,
        unavailableOnPocket: assetBySymbol.get(String(item?.asset || ''))?.active === false
      }));
  const allItems = subscriptionItems.sort((a, b) => Number(subscriptionLive(b)) - Number(subscriptionLive(a)) || Number(subscriptionRequested(b)) - Number(subscriptionRequested(a)) || Number(subscriptionUnavailable(a)) - Number(subscriptionUnavailable(b)) || Number(subscriptionBelowPayout(a)) - Number(subscriptionBelowPayout(b)) || String(a.asset).localeCompare(String(b.asset)));
  const filter = $('streamFilter')?.value || 'all';
  const items = allItems.filter((item) => filter === 'live' ? subscriptionLive(item) : filter === 'connecting' ? (!subscriptionLive(item) && !subscriptionUnavailable(item) && !subscriptionBelowPayout(item)) : true);
  const totalCount = allItems.length;
  const requestedCount = allItems.filter(subscriptionRequested).length;
  const liveCount = allItems.filter(subscriptionLive).length;
  const unavailableCount = allItems.filter(subscriptionUnavailable).length;
  const belowPayoutCount = allItems.filter(subscriptionBelowPayout).length;
  const freshHistoryCount = allItems.filter((item) => {
    const received = Date.parse(item.historyReceivedAt || '');
    return Number.isFinite(received) && Date.now() - received <= 120000;
  }).length;
  const connectingCount = Math.max(0, totalCount - liveCount - unavailableCount - belowPayoutCount);
  $('streamsTag').textContent = `${liveCount}/${totalCount} LIVE`;
  $('streamsTag').classList.toggle('on', liveCount > 0);
  if ($('streamSummary')) {
    $('streamSummary').textContent = state?.connection?.reconnecting
      ? 'Автопереподключение основного потока…'
      : `Запрошено ${requestedCount}/${totalCount} · live ${liveCount}/${totalCount}${connectingCount ? ` · подключаются ${connectingCount}` : ''}${belowPayoutCount ? ` · анализ приостановлен: ${belowPayoutCount}` : ''}${unavailableCount ? ` · временно недоступны на Pocket Option: ${unavailableCount}` : ''}`;
  }
  $('streamsList').innerHTML = items.length ? items.map((item) => {
    const live = subscriptionLive(item);
    const requested = subscriptionRequested(item);
    const unavailable = subscriptionUnavailable(item);
    const belowPayout = subscriptionBelowPayout(item);
    const fromCache = subscriptionFromCache(item);
    const historyReceived = Date.parse(item.historyReceivedAt || '');
    const scanning = Number.isFinite(historyReceived) && Date.now() - historyReceived <= 120000;
    const status = unavailable
      ? 'Временно недоступен на Pocket Option'
      : belowPayout
        ? `Payout ниже ${MIN_TRADE_PAYOUT}% · анализ приостановлен`
        : live
          ? 'Анализ активен'
          : scanning
            ? 'История обновлена · подключение источника'
            : state?.connection?.reconnecting
              ? 'Переподключение…'
              : requested
                ? 'Источник свечей подключается'
                : 'Подключение источника';
    const payout = assetBySymbol.get(String(item.asset || ''))?.payout;
    return `<div class="streamItem ${unavailable || belowPayout ? 'unavailable' : ''}"><div class="streamHead"><b>${escapeHtml(item.asset)}</b><span class="streamState ${live ? 'live' : ''} ${unavailable || belowPayout ? 'unavailable' : ''}">${escapeHtml(status)}</span></div><div class="streamMetrics"><div><small>Цена</small><strong>${formatNumber(item.lastPrice, 8)}</strong></div><div><small>Мин. выплата актива</small><strong>${payout == null ? '—' : `${formatNumber(payout, 1)}%`}</strong></div></div></div>`;
  }).join('') : '<div class="empty">Нет подписок для выбранного фильтра.</div>';
  requestAnimationFrame(updateStreamCarouselControls);
  populateTradeAssets();
}

function updateStreamCarouselControls() {
  const list = $('streamsList');
  const previous = $('streamsPrev');
  const next = $('streamsNext');
  if (!list || !previous || !next) return;
  const maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);
  previous.disabled = list.scrollLeft <= 4;
  next.disabled = list.scrollLeft >= maxScroll - 4;
}

function scrollStreamCarousel(direction) {
  const list = $('streamsList');
  if (!list) return;
  const firstCard = list.querySelector('.streamItem');
  const cardWidth = firstCard?.getBoundingClientRect().width || Math.max(240, list.clientWidth * .32);
  list.scrollBy({ left: direction * (cardWidth + 10) * 2, behavior: 'smooth' });
  window.setTimeout(updateStreamCarouselControls, 320);
}

function formatPeriod(period) {
  const value = Number(period || 0);
  if (value < 60) return `${value}с`;
  if (value % 3600 === 0) return `${value / 3600}ч`;
  return `${value / 60}м`;
}

function populateTradeAssets() {
  const list = normalizedAssetList();
  $('tradeAssetOptions').innerHTML = list.map((asset) => `<option value="${escapeHtml(asset.symbol)}">${escapeHtml(asset.name || asset.symbol)}</option>`).join('');
}

function statusLabel(status) {
  return ({ sent: 'Отправлено', success: 'Открыта', failed: 'Ошибка', unconfirmed: 'Не подтверждена', timeout: 'Тайм-аут' })[status] || status || '—';
}


function strategyTitleForDeal(deal) {
  const id = String(deal?.strategyId || deal?.strategy_id || deal?.calibrationApplied?.strategyId || '').trim();
  if (!id) return '—';
  const item = serverStrategies().find((strategy) => String(strategy.id || '') === id)
    || BUILT_IN_STRATEGIES.find((strategy) => String(strategy.id || '') === id);
  return item?.title || id;
}

function dealExpirationSeconds(deal) {
  const explicit = finite(deal?.signalExpiration ?? deal?.duration);
  if (explicit && explicit > 0) return normalizeExpirationSeconds(explicit, explicit);
  const expiry = finite(deal?.expirationTimestamp);
  const opened = finite(deal?.openTimestamp);
  if (expiry && opened && expiry > opened) return normalizeExpirationSeconds(expiry - opened, expiry - opened);
  return null;
}

function formatExpiration(value) {
  const seconds = finite(value);
  return seconds && seconds > 0 ? formatPeriod(seconds) : '—';
}

function setTextSafe(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setClassStateSafe(id, stateName) {
  const element = $(id);
  if (element) setClassState(element, stateName);
}

function renderStatistics() {
  const closed = currentClosedDeals();
  const open = currentOpenDeals();
  const todayKey = statisticsMoscowDayKey();
  const todayDeals = closed.filter((deal) => {
    const key = statisticsLocalDayKey(deal.closeTimestamp ?? deal.openTimestamp ?? deal.closedAt ?? deal.openedAt, deal, 'close');
    return key === todayKey;
  });
  const summary = summarizeDealList(todayDeals);
  const liveSummary = {
    total: summary.total,
    wins: summary.wins,
    losses: summary.losses,
    draws: summary.draws,
    net: summary.net,
    winRate: summary.winRate
  };
  const decisiveLive = liveSummary.wins + liveSummary.losses;
  liveSummary.winRate = decisiveLive ? liveSummary.wins / decisiveLive * 100 : summary.winRate;

  // Верхние карточки строятся только по автосделкам Pocket TRADE ROBOT.
  // Ручные сделки Pocket Option и общий баланс аккаунта сюда не подмешиваются.
  setTextSafe('statTodayTotal', String(liveSummary.total));
  setTextSafe('statWins', String(liveSummary.wins));
  setTextSafe('statLosses', String(liveSummary.losses));
  setTextSafe('statWinRate', `${formatNumber(liveSummary.winRate, 1)}%`);
  const financialNet = statsFinancialNet(liveSummary);
  setTextSafe('statNet', formatMoney(financialNet, currentCurrency(), true));
  setClassStateSafe('statNet', financialNet < 0 ? 'loss' : financialNet > 0 ? 'profit' : 'neutral');
  const statNetNode = $('statNet');
  if (statNetNode) statNetNode.title = `Только сделки Pocket TRADE ROBOT: ${formatMoney(liveSummary.net, currentCurrency(), true)} · ручные сделки Pocket Option исключены`;
  setTextSafe('statOpen', String(open.length));
  setTextSafe('statSummaryUpdated', `Онлайн ${new Date().toLocaleTimeString(interfaceLocale(), { timeZone: STATISTICS_TIME_ZONE, hour: '2-digit', minute: '2-digit' })}`);

  const openRows = $('openDealsRows');
  if (openRows) {
    openRows.innerHTML = open.length ? open.slice().reverse().map((deal) => `<tr><td>${formatStatisticsTime(deal.openTimestamp, deal, 'open')}</td><td>${escapeHtml(deal.asset || '—')}</td><td>${escapeHtml(strategyTitleForDeal(deal))}</td><td>${directionLabel(deal.action)}</td><td>${formatMoney(deal.amount, deal.currency || currentCurrency())}</td><td>${formatExpiration(dealExpirationSeconds(deal))}</td><td>${formatNumber(deal.openPrice, 8)}</td><td>${deal.isDemo === false ? 'REAL' : 'DEMO'}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">Открытых сделок нет.</td></tr>';
  }

  const closedRows = $('closedDealsRows');
  if (closedRows) {
    closedRows.innerHTML = closed.length ? closed.slice(-300).reverse().map((deal) => {
      const net = dealNet(deal);
      const outcome = net > 0 ? 'Победа' : net < 0 ? 'Поражение' : 'Возврат';
      return `<tr><td>${formatStatisticsTime(deal.closeTimestamp || deal.openTimestamp, deal, 'close')}</td><td>${escapeHtml(deal.asset || '—')}</td><td>${escapeHtml(strategyTitleForDeal(deal))}</td><td>${directionLabel(deal.action)}</td><td>${formatMoney(deal.amount, deal.currency || currentCurrency())}</td><td>${formatExpiration(dealExpirationSeconds(deal))}</td><td class="${net > 0 ? 'profit' : net < 0 ? 'loss' : ''}">${outcome}</td><td class="${net > 0 ? 'profit' : net < 0 ? 'loss' : ''}">${formatMoney(net, deal.currency || currentCurrency(), true)}</td><td>${formatNumber(deal.openPrice, 8)} → ${formatNumber(deal.closePrice, 8)}</td></tr>`;
    }).join('') : '<tr><td colspan="9" class="empty">Закрытых сделок пока нет.</td></tr>';
  }
}

function summarizeDealList(deals) {
  const summary = { total: deals.length, wins: 0, losses: 0, draws: 0, net: 0, winRate: 0 };
  for (const deal of deals) {
    const net = dealNet(deal);
    summary.net += net;
    if (net > 0) summary.wins += 1;
    else if (net < 0) summary.losses += 1;
    else summary.draws += 1;
  }
  const decisive = summary.wins + summary.losses;
  summary.winRate = decisive ? summary.wins / decisive * 100 : 0;
  return summary;
}

function renderTrade() {
  if ($('tradeMode')) $('tradeMode').textContent = isConnected() ? state?.account?.mode || '—' : '—';
  const tradeRows = $('tradeRows');
  if (!tradeRows) return;
  const results = Array.isArray(state?.trades?.recentResults) ? state.trades.recentResults : [];
  tradeRows.innerHTML = results.length ? results.slice().reverse().map((result) => `<tr><td>${result.time ? new Date(result.time).toLocaleTimeString(interfaceLocale()) : '—'}</td><td>${escapeHtml(statusLabel(result.status))}</td><td>${escapeHtml(result.asset || '—')}</td><td>${directionLabel(result.action)}</td><td>${formatMoney(result.amount, currentCurrency())}</td><td>${result.duration || '—'} сек</td><td>${escapeHtml(String(result.dealId || result.requestId || '—').slice(0, 18))}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">Команды ещё не отправлялись.</td></tr>';
}

function reasonText(reason) {
  const labels = {
    ACCOUNT_BLOCKED: 'UID заблокирован администратором.',
    REAL_BALANCE_BELOW_1_USD: 'REAL-баланс ниже $1. Premium восстановится автоматически после выполнения условия.',
    INACTIVE_72_HOURS: 'Нет подтверждённой активности более 72 часов. Premium восстановится автоматически после новой активности.',
    INACTIVE_24_HOURS: 'Нет подтверждённой активности более 72 часов. Premium восстановится автоматически после новой активности.'
  };
  return labels[reason] || reason || '';
}

function compareVersions(left, right) {
  const a = String(left || '0').split('.').map((value) => Number(value) || 0);
  const b = String(right || '0').split('.').map((value) => Number(value) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

function renderServerPanels() {
  const entitlement = currentEntitlement();
  const localMode = isLocalExpansionMode();
  const online = !localMode && Boolean(serverState?.online);
  const reachable = !localMode && Boolean(serverState?.serverReachable);
  const accessView = accessDisplay(entitlement);
  if ($('serverOnlineTag')) {
    $('serverOnlineTag').textContent = localMode ? 'LOCAL' : online ? 'ONLINE' : reachable ? 'SYNC' : 'OFFLINE';
    $('serverOnlineTag').classList.toggle('on', online);
  }
  if ($('serverPlan')) $('serverPlan').textContent = accessView.code === 'paused' ? 'PREMIUM · ПАУЗА' : accessView.plan;
  if ($('serverSource')) $('serverSource').textContent = localMode ? 'Локальный владелец' : ({ owner: 'Владелец', affiliate: 'По регистрации и депозиту', paid: 'Платный доступ', manual: 'Выдан вручную', trial: 'Пробный доступ', free: 'Бесплатный' })[entitlement.source] || entitlement.source || 'Бесплатный';
  if ($('serverLicenseStatus')) $('serverLicenseStatus').textContent = accessView.status.replace('Статус: ', '');
  if ($('serverDevices')) $('serverDevices').textContent = 'UID only';
  if ($('serverLicenseMessage')) $('serverLicenseMessage').textContent = localMode
    ? 'Локальный режим активен. Лицензионный сервер не используется; внешние серверные сигналы и AI недоступны.'
    : !online
      ? friendlyServerConnectionError(serverState?.lastError)
      : (entitlement.display?.message || entitlement.pauseReason)
        ? rebrandLegacyVisibleText(entitlement.display?.message || reasonText(entitlement.pauseReason))
        : entitlement.premium
          ? 'Premium-доступ подтверждён.'
          : 'Ожидание серверного статуса доступа.';
  const affiliate = entitlement.affiliate || {};
  if ($('getAffiliatePremium')) {
    $('getAffiliatePremium').disabled = Boolean(entitlement.premium); // v1.0.59: public affiliate link can be generated even before serverState has registrationUrl
    $('getAffiliatePremium').textContent = entitlement.premium ? 'Premium получен' : 'Открыть партнёрскую регистрацию Pocket Option для Premium-доступа';
  }
  if ($('quickAffiliatePremium')) {
    $('quickAffiliatePremium').disabled = Boolean(entitlement.premium); // v1.0.59: do not block registration CTA when registrationUrl is generated on click
    $('quickAffiliatePremium').textContent = entitlement.premium ? 'Premium уже активирован' : 'Партнёрская регистрация Pocket Option для Premium-функций';
  }
  if ($('quickActivateTrial')) {
    $('quickActivateTrial').hidden = true;
  }
  if ($('premiumQuickTitle')) $('premiumQuickTitle').textContent = entitlement.premium ? 'Premium-доступ активирован' : 'Получить Premium-доступ';
  if ($('premiumQuickText')) $('premiumQuickText').textContent = entitlement.premium
    ? 'Все доступные функции вашего тарифа уже активны на этом UID.'
    : 'TRIAL Premium активируется автоматически при первом подключении UID. После 24 часов регистрация открывает торговлю только на DEMO с лимитами 30 активов и 50 сделок в сутки, а подтверждённый депозит от $10 активирует полный Premium.';
  $('premiumQuickBar')?.classList.toggle('premiumActive', Boolean(entitlement.premium));
  if ($('activateTrial')) $('activateTrial').hidden = true;
  if ($('openAdmin')) $('openAdmin').hidden = true;
  const release = serverState?.release || access.serverState?.release || null;
  const latest = release?.latestVersion || VERSION;
  const updateAvailable = compareVersions(latest, VERSION) > 0;
  const mandatory = Boolean(release?.mandatory && compareVersions(release?.minimumVersion, VERSION) > 0);
  $('releaseTitle').textContent = updateAvailable ? `Доступна версия ${latest}` : `Установлена версия ${VERSION}`;
  $('releaseStatus').textContent = mandatory ? 'Обновление обязательно для продолжения работы.' : updateAvailable ? 'Доступно новое обновление расширения.' : 'Установлена актуальная версия.';
  $('releaseNotes').innerHTML = Array.isArray(release?.notes) ? release.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('') : '';
  $('openUpdate').hidden = !updateAvailable || !release?.updateUrl;
  document.querySelector('.updateCard')?.classList.toggle('mandatoryUpdate', mandatory);
  const broadcasts = Array.isArray(serverState?.broadcasts) ? serverState.broadcasts : [];
  $('broadcastList').innerHTML = broadcasts.length ? broadcasts.map((item) => {
    const buttonUrl = safeHttpsUrl(item.button_url);
    return `<div class="broadcastItem"><h4>${escapeHtml(rebrandLegacyVisibleText(item.title || 'Сообщение Pocket TRADE ROBOT'))}</h4><p>${escapeHtml(rebrandLegacyVisibleText(item.body || ''))}</p>${buttonUrl ? `<a href="${escapeHtml(buttonUrl)}" target="_blank" rel="noopener noreferrer">Открыть →</a>` : ''}</div>`;
  }).join('') : '<div class="empty">Новых объявлений нет.</div>';
}

function renderOfficialApiSettings() {
  const apiSettings = pocketPartnersStatus?.settings || {};
  const apiState = pocketPartnersStatus?.state || {};
  if (!$('officialApiUid')) return;
  $('officialApiUid').value = apiSettings.uid || '';
  $('officialApiToken').placeholder = apiSettings.accessToken === '[SET]' ? 'Токен сохранён · оставьте пустым, чтобы не менять' : 'Вставьте токен для теста';
  $('officialApiToken').value = '';
  $('officialApiAllowReal').checked = apiSettings.allowRealTrading === true;
  const status = apiState.authenticated ? 'AUTH OK' : apiState.connected ? 'SOCKET' : apiState.status || 'WAIT API TOKEN';
  const lastError = apiState.lastError ? escapeHtml(apiState.lastError) : '—';
  const userId = apiState.userData?.userId || apiState.userData?.real?.uid || apiSettings.uid || '—';
  const realLogin = apiState.userData?.real?.login || '—';
  const assetsCount = apiState.assetsCount || 0;
  $('officialApiDetails').innerHTML = `<div><span>Исполнение</span><b>Только официальный API</b></div><div><span>Статус</span><b>${escapeHtml(status)}</b></div><div><span>UID</span><b>${escapeHtml(String(userId))}</b></div><div><span>Real login</span><b>${escapeHtml(String(realLogin))}</b></div><div><span>Активы из API</span><b>${assetsCount}</b></div><div><span>Последняя ошибка</span><b>${lastError}</b></div>`;
}

function renderSettings() {
  $('statusBarVisible').checked = settings.statusBarVisible !== false;
  if ($('tradeResultNotifications')) $('tradeResultNotifications').checked = settings.tradeResultNotifications !== false;
  if ($('statusBarCompact')) $('statusBarCompact').checked = settings.statusBarCompact !== false;
  $('currencyOverride').value = settings.currencyOverride || 'AUTO';
  $('confirmTrades').checked = settings.confirmTrades !== false;
  $('profitResetMode').value = settings.profitResetMode === 'disconnect' ? 'disconnect' : 'daily';
  const accessView = accessDisplay();
  $('accessOverview').innerHTML = `<b>${escapeHtml(accessView.plan)}</b><br>${escapeHtml(accessView.description)}`;
  const entitlement = currentEntitlement();
  const sourceLabel = ({ owner: 'Владелец', affiliate: 'По регистрации и депозиту', paid: 'Платный доступ', manual: 'Выдан вручную', trial: 'Пробный доступ', free: 'Бесплатный' })[entitlement.source] || 'Бесплатный';
  const statusLabelText = entitlement.status === 'paused' ? 'Временно приостановлен' : entitlement.status === 'blocked' ? 'Заблокирован' : 'Активен';
  $('licenseDetails').innerHTML = `<div><span>Тип доступа</span><b>${escapeHtml(sourceLabel)}</b></div><div><span>Статус</span><b>${escapeHtml(statusLabelText)}</b></div><div><span>Пояснение</span><b>${escapeHtml(reasonText(entitlement.pauseReason) || '—')}</b></div><div><span>Привязка</span><b>Только UID</b></div>`;
  const pnl = balanceDeltaView();
  $('settingsPnl').textContent = pnl.value;
  setClassState($('settingsPnl'), pnl.className);
  $('settingsBaseline').textContent = profitStats?.baselineBalance == null ? 'Стартовый баланс —' : `Стартовый баланс ${formatMoney(profitStats.baselineBalance, currentCurrency())}`;
  renderOfficialApiSettings();
}


function renderAll() {
  applyInterfaceDensity();
  initializeInputs();
  renderHeader();
  renderServerPanels();
  syncPremiumRegistrationGate();
  const active = document.querySelector('.tab.active')?.dataset.tab || safeSessionGet('poActiveTab') || 'account';
  if (active === 'account') { renderAccount(); renderConnectionCenter(); }
  else if (active === 'market') renderMarket();
  else if (active === 'trade') {
    renderStrategies();
    renderAutoStrategyOptions();
    renderAutoTrade();
    renderTrade();
  } else if (active === 'strategies') {
    renderStrategies();
    renderBuilder();
    renderTransferHistory();
  } else if (active === 'tester') {
    renderStrategyTester();
  } else if (active === 'statistics') renderStatistics();
  else if (active === 'remote') renderRemoteControl();
  else if (active === 'premium') renderServerPanels();
  else if (active === 'notifications') renderNotifications();
  else if (active === 'contacts') renderNotifications();
  else if (active === 'settings') renderSettings();
  window.PTI18n?.refresh?.();
}

async function connectAccount() {
  if (accountConnectionBusy) return;
  accountConnectionBusy = true;
  requestRender(true);
  try {
    toast('Проверяю текущий терминал и подключаю аккаунт…');
    const bridge = await ensurePocketBridge();
    if (bridge?.reloaded) toast('Текущее зеркало подготовлено. Терминал перезагружен, завершаю подключение…');
    const result = await tabMessage({ type: 'PO_CONNECT' });
    if (!result?.ok) throw new Error(result?.error || 'Подключение не выполнено');
    if (result?.waitingAuth || result?.status === 'waiting_auth') {
      toast('Зеркало подключено. Войдите в Pocket Option — аккаунт подхватится автоматически.', 'ok');
      setTimeout(refreshState, 500);
      return;
    }
    toast('Аккаунт подключён. Проверяю серверный доступ…', 'ok');
    setTimeout(async () => { await runtimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: true }).catch(() => null); await refreshState(); }, 900);
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    accountConnectionBusy = false;
    requestRender(true);
  }
}

async function disconnectAccount() {
  if (accountConnectionBusy) return;
  if (!pocketTab?.id) {
    toast('Вкладка Pocket Option не найдена.', 'error');
    return;
  }
  accountConnectionBusy = true;
  requestRender(true);
  try {
    const result = await tabMessage({ type: 'PO_DISCONNECT' });
    if (!result?.ok) throw new Error(result?.error || 'Отключение не выполнено');
    toast('Аккаунт отключён от бота.', 'ok');
    setTimeout(refreshState, 150);
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    accountConnectionBusy = false;
    requestRender(true);
  }
}

async function subscribeSelectedAssets() {
  if (!isConnected()) {
    toast('Сначала подключите аккаунт.', 'error');
    return;
  }
  const assets = cleanAssetSelection([...selectedAssets]);
  if (!assets.length) {
    toast('Выберите хотя бы один актив.', 'error');
    return;
  }
  if (assets.length !== selectedAssets.size) {
    selectedAssets = new Set(assets);
    settings.selectedAssets = assets;
    await chrome.storage.local.set({ poBridgeSettings: settings });
  }
  const max = access.limits?.maxAssets;
  if (max != null && assets.length > max) {
    toast(`Тариф FREE позволяет выбрать максимум ${max} активов.`, 'error');
    return;
  }
  const plan = autoSubscriptionPlan(settings.autoTrade || {});
  const period = plan.primaryPeriod;
  try {
    $('subscribeAssets').disabled = true;
    $('subscribeAssets').textContent = 'Подключаем графики…';
    let result;
    try {
      result = await tabMessage({
        type: 'PO_SUBSCRIBE',
        payload: {
          assets,
          period,
          primaryPeriod: period,
          periods: plan.requiredPeriods,
          historyOffsets: plan.historyOffsets,
          historyOffset: plan.historyOffsets?.[period] || 180,
          autoManagePeriods: true
        }
      }, { timeoutMs: 45000, heal: false });
    } catch (error) {
      if (!isTabMessageTimeoutError(error)) throw error;
      await saveSettings({ selectedAssets: assets, asset: assets[0], period });
      toast('Pocket Option временно задержал подтверждение подписки. Подключение продолжается автоматически.', 'ok');
      setTimeout(refreshState, 600);
      setTimeout(refreshState, 2200);
      return;
    }
    if (!result?.ok) throw new Error(result?.error || 'Графики не подключены');
    const acceptedAssets = cleanAssetSelection(result.assets || assets);
    const skippedCount = Array.isArray(result.skippedAssets) ? result.skippedAssets.length : 0;
    selectedAssets = new Set(acceptedAssets);
    await saveSettings({ selectedAssets: acceptedAssets, asset: acceptedAssets[0], period });
    if ($('tradeAsset')) $('tradeAsset').value = acceptedAssets[0];
    const eligibleCount = Number(result.eligibleAssetCount ?? acceptedAssets.length) || 0;
    const payoutFilteredCount = Number(result.payoutFilteredAssetCount ?? 0) || 0;
    const unavailableCount = Number(result.unavailableAssetCount ?? 0) || 0;
    const unknownCount = Number(result.payoutUnknownAssetCount ?? 0) || 0;
    const waitingCount = payoutFilteredCount + unavailableCount + unknownCount + skippedCount;
    toast(
      `Графики подключены: ${acceptedAssets.length}. Анализ и нужные таймфреймы настроены автоматически`
      + `${eligibleCount ? ` · готовы сейчас: ${eligibleCount}` : ''}`
      + `${waitingCount ? ` · ожидают доступности: ${waitingCount}` : ''}.`,
      'ok'
    );
    setTimeout(refreshState, 350);
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    $('subscribeAssets').disabled = false;
    $('subscribeAssets').textContent = 'Подключить графики';
  }
}

function selectAsset(symbol, checked) {
  const normalizedSymbol = normalizeUiAsset(symbol);
  if (!normalizedSymbol) {
    toast('Этот элемент не является торговым активом и был пропущен.', 'error');
    renderMarket();
    return;
  }
  symbol = normalizedSymbol;
  const max = access.limits?.maxAssets;
  if (checked && max != null && !selectedAssets.has(symbol) && selectedAssets.size >= max) {
    toast(`FREE: можно выбрать максимум ${max} активов.`, 'error');
    renderMarket();
    return;
  }
  if (checked) selectedAssets.add(symbol); else selectedAssets.delete(symbol);
  settings.selectedAssets = [...selectedAssets];
  void chrome.storage.local.set({ poBridgeSettings: settings });
  renderMarket();
}

function selectAllAvailableAssets() {
  const all = normalizedAssetList().filter((asset) => asset.active !== false).map((asset) => asset.symbol);
  const max = access.limits?.maxAssets;
  const picked = max == null ? all : all.slice(0, max);
  selectedAssets = new Set(picked);
  settings.selectedAssets = [...selectedAssets];
  void chrome.storage.local.set({ poBridgeSettings: settings });
  renderMarket();
  toast(`Выбрано доступных активов: ${selectedAssets.size}${max != null && all.length > max ? ` из ${all.length} по лимиту тарифа` : ''}.`, 'ok');
}

function selectCategoryAssets(category, checked) {
  const categoryAssets = normalizedAssetList().filter((asset) => (asset.category || (asset.isOtc ? 'OTC' : 'Прочие')) === category && asset.active !== false);
  const max = access.limits?.maxAssets;
  if (checked) {
    for (const asset of categoryAssets) {
      if (max != null && selectedAssets.size >= max && !selectedAssets.has(asset.symbol)) break;
      selectedAssets.add(asset.symbol);
    }
  } else {
    for (const asset of categoryAssets) selectedAssets.delete(asset.symbol);
  }
  settings.selectedAssets = [...selectedAssets];
  void chrome.storage.local.set({ poBridgeSettings: settings });
  if (checked && max != null && categoryAssets.length > max) toast(`FREE: можно выбрать максимум ${max} активов.`, 'ok');
  renderMarket();
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  clearBuilder();
  $('builderName').value = preset.name;
  $('builderLogic').value = preset.logic;
  $('builderDirection').value = preset.direction;
  $('builderConfirmations').value = String(preset.confirmations);
  $('builderMtf').value = preset.mtf;
  $('builderRegime').value = preset.regime;
  $('builderTimeframe').value = String(preset.timeframe || 60);
  if ($('builderCandleOffset')) $('builderCandleOffset').value = String(normalizeCandleOffset(preset.candleOffset, preset.candleMode));
  $('builderMarketType').value = preset.marketType || 'all';
  $('builderVolatility').value = preset.volatility || 'any';
  setBuilderPatterns(preset.patterns || []);
  setBuilderPatternSettings(preset.patternSettings || {});
  builderRules = preset.rules.map((item) => ({ timeframe: 'current', ...item, indicatorLabel: item.indicatorLabel || indicatorLabel(item.indicator) }));
  editingStrategyId = null;
  renderRules();
  updateBuilderConditionalFields();
  toast(`Шаблон «${preset.name}» загружен.`, 'ok');
}


function candleSequenceRelationConfig(value) {
  switch (String(value || 'none')) {
    case 'ratio_1_5_2': return { relation: 'ratio_prev', min: 1.5, max: 2.0 };
    case 'ratio_1_35_2_4': return { relation: 'ratio_prev', min: 1.35, max: 2.4 };
    case 'greater_prev': return { relation: 'greater_prev', min: 1.05 };
    case 'smaller_prev': return { relation: 'smaller_prev', max: 0.95 };
    case 'engulf_prev_3': return { relation: 'engulf_prev_3', min: 0.7 };
    default: return { relation: 'none' };
  }
}

function updateCandleSequenceDesigner() {
  const count = Math.min(5, Math.max(2, Number($('candleSeqCount')?.value) || 3));
  document.querySelectorAll('[data-candle-seq-row]').forEach((row) => {
    const index = Number(row.dataset.candleSeqRow || 0);
    row.hidden = index > count;
    const small = row.querySelector('header small');
    if (small) small.textContent = index === 1 ? 'самая старая' : index === count ? 'последняя закрытая' : '';
  });
}

function buildCandleSequenceRuleFromUi() {
  const count = Math.min(5, Math.max(2, Number($('candleSeqCount')?.value) || 3));
  const candles = [];
  for (let index = 1; index <= count; index += 1) {
    const body = String($(`candleSeqBody${index}`)?.value || 'any');
    const direction = String($(`candleSeqDir${index}`)?.value || 'any');
    const relation = candleSequenceRelationConfig($(`candleSeqRel${index}`)?.value);
    candles.push({ direction, body, ...relation });
  }
  return {
    candles,
    entry: String($('candleSeqEntry')?.value || 'auto'),
    confirm: 'closed',
    label: `${count} candle custom sequence`
  };
}

function addCandleSequenceRuleFromUi() {
  const sequence = buildCandleSequenceRuleFromUi();
  const count = sequence.candles.length;
  builderRules.push({
    indicator: 'candleSequence',
    indicatorLabel: 'Свечная последовательность',
    operator: 'signal',
    value: `${count} свечей → ${sequence.entry === 'put' ? 'SELL' : sequence.entry === 'call' ? 'BUY' : 'AUTO'}`,
    period: count,
    weight: Math.min(20, Math.max(1, Number($('candleSeqWeight')?.value) || 5)),
    timeframe: 'current',
    params: JSON.stringify(sequence),
    source: 'close',
    signalMode: sequence.entry === 'put' ? 'confirmSell' : sequence.entry === 'call' ? 'confirmBuy' : 'auto',
    group: String($('candleSeqGroup')?.value || 'A').trim() || 'A'
  });
  renderRules();
  toast('Свечная последовательность добавлена как условие входа.', 'ok');
}

function applyCandleSequencePreset(name) {
  if (!$('candleSeqCount')) return;
  const isBuy = String(name || '').toLowerCase().includes('buy');
  const isEngulf = String(name || '').toLowerCase().includes('engulf');
  const trendColor = isBuy ? 'red' : 'green';
  const confirmColor = isBuy ? 'green' : 'red';
  $('candleSeqEntry').value = isBuy ? 'call' : 'put';
  $('candleSeqGroup').value = 'A';
  $('candleSeqWeight').value = '5';
  if (isEngulf) {
    $('candleSeqCount').value = '4';
    for (let index = 1; index <= 3; index += 1) {
      $(`candleSeqDir${index}`).value = trendColor;
      $(`candleSeqBody${index}`).value = 'any';
      $(`candleSeqRel${index}`).value = 'none';
    }
    $('candleSeqDir4').value = confirmColor;
    $('candleSeqBody4').value = 'large';
    $('candleSeqRel4').value = 'engulf_prev_3';
  } else {
    $('candleSeqCount').value = '3';
    for (let index = 1; index <= 3; index += 1) {
      $(`candleSeqDir${index}`).value = trendColor;
      $(`candleSeqBody${index}`).value = index === 1 ? 'medium' : 'any';
      $(`candleSeqRel${index}`).value = index === 1 ? 'none' : 'ratio_1_5_2';
    }
  }
  updateCandleSequenceDesigner();
}

function addBuilderRule() {
  try {
    const indicatorSelect = $('ruleIndicator');
    const indicator = indicatorSelect?.value || indicatorSelect?.dataset?.lastValue || '';
    if (!indicator) {
      toast('Сначала выберите индикатор или фильтр для условия входа.', 'error');
      indicatorSelect?.focus();
      return;
    }
  if (indicator === 'aiScore' && !(access.entitlement?.features?.ai ?? access.premium)) {
    toast('AI Score доступен только в PREMIUM.', 'error');
    return;
  }
  const period = Math.max(1, Number($('rulePeriod').value) || 14);
  const weight = Math.min(20, Math.max(1, Number($('ruleWeight').value) || 1));
  builderRules.push({
    indicator,
    indicatorLabel: indicatorLabel(indicator),
    operator: $('ruleOperator').value,
    value: $('ruleValue').value.trim(),
    period,
    weight,
    timeframe: $('ruleTimeframe').value || 'current',
    params: $('ruleParams')?.value?.trim() || '',
    source: normalizeRuleSource($('ruleSource')?.value),
    signalMode: normalizeRuleSignalMode($('ruleSignalMode')?.value),
    group: $('ruleGroup')?.value?.trim() || ''
  });
    $('ruleValue').value = '';
    $('ruleValue').dataset.autofill = '1';
    renderRules();
    syncRuleDefaultsForIndicator();
    toast('Условие добавлено в стратегию.', 'ok');
  } catch (error) {
    console.error('addBuilderRule failed', error);
    toast(`Не удалось добавить условие: ${error?.message || error}`, 'error');
  }
}

function clearBuilder() {
  editingStrategyId = null;
  builderRules = [];
  const defaults = {
    builderName: 'Моя стратегия',
    builderDescription: '',
    builderLogic: 'all',
    builderDirection: 'both',
    builderTimeframe: '60',
    builderCandleOffset: '-1',
    builderMarketType: 'all',
    builderAssetMode: 'selected',
    builderAssets: '',
    builderConfirmations: '2',
    builderMtf: 'off',
    builderRegime: 'any',
    builderTrendFilter: 'off',
    builderVolatility: 'any',
    builderTickAcceleration: 'off',
    builderSession: 'any',
    builderStartTime: '00:00',
    builderEndTime: '23:59',
    builderSignalTtl: '5',
    builderCooldown: '10',
    builderReentry: 'off',
    builderExpiration: '60',
    ruleSource: 'close',
    ruleSignalMode: 'auto',
  };
  for (const [id, value] of Object.entries(defaults)) if ($(id)) $(id).value = value;
  if ($('builderLateEntryFilter')) $('builderLateEntryFilter').checked = true;
  if ($('builderUseAi')) $('builderUseAi').checked = false;
  if ($('builderNewsFilter')) $('builderNewsFilter').checked = false;
  setBuilderPatterns([]);
  setBuilderPatternSettings({});
  hideBuilderReadyForTester();
  renderRules();
  updateBuilderConditionalFields();
}


function builderConfigFromForm() {
  const builderTimeframeValue = String($('builderTimeframe')?.value || '60');
  const builderTimeframeMode = 'fixed';
  const fixedBuilderTimeframe = builderTimeframeValue === 'user'
    ? normalizeAnalysisPeriodSeconds(settings.autoTrade?.period || settings.period || 60, 60)
    : (Number(builderTimeframeValue) || 60);
  return {
    name: $('builderName').value.trim(),
    description: $('builderDescription').value.trim(),
    logic: $('builderLogic').value,
    direction: $('builderDirection').value,
    timeframe: fixedBuilderTimeframe,
    timeframeMode: builderTimeframeMode,
    candleOffset: normalizeCandleOffset($('builderCandleOffset')?.value),
    candleMode: normalizeCandleOffset($('builderCandleOffset')?.value) === 0 ? 'current' : 'closed',
    levelLookback: 50,
    keltner: { emaPeriod: 17, atrPeriod: 10, multiplier: 2 },
    marketType: $('builderMarketType').value,
    assetMode: $('builderAssetMode').value,
    assets: $('builderAssets').value.split(',').map((value) => value.trim()).filter(Boolean),
    rules: builderRules.map((rule) => ({ ...rule })),
    patterns: selectedBuilderPatterns(),
    patternSettings: patternSettingsFromForm(),
    confirmations: Math.max(1, Number($('builderConfirmations').value) || 1),
    decisionMode: 'direction_only',
    mtf: $('builderMtf').value,
    regime: $('builderRegime').value,
    trendFilter: $('builderTrendFilter').value,
    volatility: $('builderVolatility').value,
    tickAcceleration: $('builderTickAcceleration').value,
    session: $('builderSession').value,
    startTime: $('builderStartTime').value || '00:00',
    endTime: $('builderEndTime').value || '23:59',
    signalTtl: Math.max(1, Number($('builderSignalTtl').value) || 5),
    // Expiration belongs to this strategy. Amount, limits and the complete
    // Martingale plan remain global in the Trading section.
    expiration: normalizeExpirationSeconds($('builderExpiration')?.value, 60),
    cooldown: Math.max(0, Number($('builderCooldown').value) || 0),
    reentry: $('builderReentry').value,
    lateEntryFilter: $('builderLateEntryFilter').checked,
    usesAi: $('builderUseAi').checked,
    newsFilter: $('builderNewsFilter').checked,
    updatedAt: new Date().toISOString()
  };
}

function validateBuilderConfig(config, notify = true) {
  const errors = [];
  if (!config.name) errors.push('Введите название стратегии');
  if (!config.rules.length) errors.push('Добавьте хотя бы одно условие');
  if (config.timeframe <= 0) errors.push('Проверьте таймфрейм анализа');
  if (!Number.isFinite(Number(config.expiration)) || Number(config.expiration) <= 0) errors.push('Проверьте экспирацию стратегии');
  if (config.usesAi && !(access.entitlement?.features?.ai ?? access.premium)) errors.push('AI-проверка доступна только в Premium');
  if (notify) toast(errors.length ? errors.join('. ') : 'Настройки стратегии заполнены корректно.', errors.length ? 'error' : 'ok');
  return errors;
}

async function saveBuilderStrategy() {
  if (!(access.entitlement?.features?.strategyBuilder ?? access.premium)) return toast('Конструктор стратегий доступен только в PREMIUM.', 'error');
  const config = sanitizeCustomStrategyGlobalFields(builderConfigFromForm());
  const errors = validateBuilderConfig(config, false);
  if (errors.length) return toast(errors.join('. '), 'error');

  const payload = {
    id: editingStrategyId && String(editingStrategyId).startsWith('custom-') ? editingStrategyId : undefined,
    name: config.name,
    description: config.description,
    config
  };
  $('saveStrategy').disabled = true;
  $('saveStrategy').textContent = 'Сохраняю...';
  try {
    const result = await runtimeMessage({ type: 'PT_SAVE_CUSTOM_STRATEGY', payload });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить стратегию');
    serverState = result.serverState || serverState;
    const saved = result.strategy || {};
    const savedId = String(saved.id || payload.id || config.id || `custom-${makeLocalId()}`);
    const localItem = { ...config, id: savedId, name: config.name, title: config.name, serverSaved: true, config };
    const list = [...(settings.builderStrategies || [])].filter((item) => item.id !== localItem.id && item.id !== editingStrategyId);
    list.push(localItem);
    await saveSettings({
      builderStrategies: list,
      activeStrategyId: localItem.id,
      autoTrade: { ...settings.autoTrade, strategyId: localItem.id }
    });
    toast(`Стратегия «${config.name}» сохранена на сервере и выбрана.`, 'ok');
    clearBuilder();
    showBuilderReadyForTester(localItem.id, config.name);
    setTab('strategies');
    setStrategyPanel('builder');
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    $('saveStrategy').disabled = false;
    $('saveStrategy').textContent = 'Сохранить на сервере';
  }
}

function fillBuilderFromItem(item) {
  const config = item.config || item;
  editingStrategyId = item.id;
  builderRules = (config.rules || []).map((rule) => ({ timeframe: 'current', ...rule, indicatorLabel: rule.indicatorLabel || indicatorLabel(rule.indicator) }));
  const values = {
    builderName: config.name || item.title || 'Моя стратегия',
    builderDescription: config.description || item.description || '',
    builderLogic: config.logic || 'all',
    builderDirection: config.direction || 'both',
    builderTimeframe: config.timeframeMode === 'user' ? 'user' : String(config.timeframe || 60),
    builderCandleOffset: String(normalizeCandleOffset(config.candleOffset, config.candleMode)),
    builderMarketType: config.marketType || 'all',
    builderAssetMode: config.assetMode || 'selected',
    builderAssets: (config.assets || []).join(', '),
    builderConfirmations: String(config.confirmations || 2),
    builderMtf: config.mtf || 'off',
    builderRegime: config.regime || 'any',
    builderTrendFilter: config.trendFilter || 'off',
    builderVolatility: config.volatility || 'any',
    builderTickAcceleration: config.tickAcceleration || 'off',
    builderSession: config.session || 'any',
    builderStartTime: config.startTime || '00:00',
    builderEndTime: config.endTime || '23:59',
    builderSignalTtl: String(config.signalTtl || 5),
    builderCooldown: String(config.cooldown ?? 10),
    builderReentry: config.reentry || 'off',
    builderExpiration: String(inferCustomStrategyExpiration(config, config.name || item.title)),
  };
  for (const [id, value] of Object.entries(values)) if ($(id)) $(id).value = value;
  $('builderLateEntryFilter').checked = config.lateEntryFilter !== false;
  $('builderUseAi').checked = Boolean(config.usesAi);
  $('builderNewsFilter').checked = Boolean(config.newsFilter);
  if ($('builderExpiration')) $('builderExpiration').value = String(inferCustomStrategyExpiration(config, config.name || item.title));
  setBuilderPatterns(config.patterns || []);
  setBuilderPatternSettings(config.patternSettings || {});
  renderRules();
}

async function builderAction(action, id) {
  if (!(access.entitlement?.features?.strategyBuilder ?? access.premium)) return toast('Конструктор стратегий доступен только в PREMIUM.', 'error');
  const item = tradeStrategies().find((strategy) => strategy.id === id)
    || (settings.builderStrategies || []).find((strategy) => strategy.id === id);
  if (!item) return;
  if (action === 'activate') {
    let activeId = String(id || '');
    if (!activeId.startsWith('custom-')) {
      const savedId = await ensureCustomStrategyServerSaved(activeId);
      if (!savedId) return;
      activeId = savedId;
    }
    await saveSettings({ activeStrategyId: activeId, autoTrade: { ...settings.autoTrade, strategyId: activeId, strategyIds: [activeId] } });
    renderStrategies();
    renderAutoStrategyOptions();
    toast(`Стратегия «${item.title || item.name}» выбрана.`, 'ok');
  } else if (action === 'edit') {
    fillBuilderFromItem(item);
    setTab('strategies');
    setStrategyPanel('builder');
  } else if (action === 'export') {
    exportSingleStrategy(item);
  } else if (action === 'delete') {
    try {
      let alreadyMissing = false;
      if (String(id).startsWith('custom-')) {
        const result = await runtimeMessage({ type: 'PT_DELETE_CUSTOM_STRATEGY', strategyId: id });
        if (!result?.ok) {
          const errorText = String(result?.error || '');
          const missing = /custom_strategy_not_found|custom strategy not found|пользовательская стратегия не найдена/i.test(errorText);
          if (!missing) throw new Error(errorText || 'Не удалось удалить стратегию');
          alreadyMissing = true;
        } else {
          alreadyMissing = result?.alreadyMissing === true;
          serverState = result.serverState || serverState;
        }
      }

      const normalizedId = String(id || '');
      const next = (settings.builderStrategies || []).filter((strategy) => String(strategy?.id || '') !== normalizedId);
      const strategyIds = selectedStrategyIdsForAuto(settings.autoTrade || {}).filter((strategyId) => String(strategyId) !== normalizedId);
      const strategyProfiles = { ...(settings.autoTrade?.strategyProfiles || {}) };
      delete strategyProfiles[normalizedId];
      const patch = {
        builderStrategies: next,
        autoTrade: {
          ...settings.autoTrade,
          strategyIds,
          strategyId: String(settings.autoTrade?.strategyId || '') === normalizedId
            ? (strategyIds[0] || '')
            : settings.autoTrade?.strategyId,
          strategyProfiles,
          enabled: strategyIds.length ? settings.autoTrade?.enabled === true : false
        }
      };
      if (String(settings.activeStrategyId || '') === normalizedId) patch.activeStrategyId = strategyIds[0] || '';
      if (String(editingStrategyId || '') === normalizedId) clearBuilder();

      await saveSettings(patch);
      renderSavedStrategies();
      renderStrategies();
      renderAutoStrategyOptions();
      loadAutoInputs();
      toast(alreadyMissing
        ? 'Стратегия уже отсутствовала на сервере. Локальная запись и её настройки удалены.'
        : 'Стратегия удалена.', 'ok');
    } catch (error) {
      toast(error.message || String(error), 'error');
    }
  }
}


const STRATEGY_SCHEMA_VERSION = 1;
const MAX_STRATEGY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_STRATEGIES = 100;
const MAX_STRATEGY_DESCRIPTION_CHARS = 2000;

function makeLocalId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function safeFileName(value, fallback = 'strategy') {
  const clean = String(value || '').normalize('NFKC').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return clean || fallback;
}

function uniqueImportedName(value, usedNames) {
  const original = String(value || uiText('Импортированная стратегия', 'Imported strategy')).trim().slice(0, 80);
  const suffix = uiText(' (импорт)', ' (import)');
  let candidate = original;
  if (!usedNames.has(candidate.toLocaleLowerCase())) {
    usedNames.add(candidate.toLocaleLowerCase());
    return candidate;
  }
  const base = original.endsWith(suffix) ? original : `${original}${suffix}`;
  candidate = base.slice(0, 80);
  let index = 2;
  while (usedNames.has(candidate.toLocaleLowerCase())) {
    const numbered = ` ${index++}`;
    candidate = `${base.slice(0, Math.max(1, 80 - numbered.length))}${numbered}`;
  }
  usedNames.add(candidate.toLocaleLowerCase());
  return candidate;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedImportedRule(raw) {
  const item = plainObject(raw);
  const indicator = String(item.indicator || item.name || item.type || '').slice(0, 60);
  const allowedIndicators = new Set(INDICATORS.map((row) => row[0]));
  if (!allowedIndicators.has(indicator)) throw new Error(`Неизвестный индикатор в импортируемой стратегии: ${indicator || 'не указан'}`);
  if (!Object.hasOwn(OPERATOR_LABELS, item.operator)) throw new Error(`Неизвестный оператор для ${indicator}: ${String(item.operator || 'не указан')}`);
  const allowedTfs = ['current','5','10','15','30','60','120','180','300','600','900','1800','3600','14400','86400','2x','5x','15m','1h','4h','d1'];
  const rawTimeframe = String(item.timeframe ?? 'current');
  if (!allowedTfs.includes(rawTimeframe)) throw new Error(`Неподдерживаемый таймфрейм правила ${indicator}: ${rawTimeframe}`);
  return {
    indicator,
    indicatorLabel: indicatorLabel(indicator),
    operator: item.operator,
    value: String(item.value ?? item.signal ?? item.condition ?? ''),
    period: Math.min(1000, Math.max(1, Number(item.period) || 14)),
    weight: Math.min(20, Math.max(1, Number(item.weight) || 1)),
    timeframe: rawTimeframe,
    params: typeof item.params === 'string' ? item.params : (item.params && typeof item.params === 'object' ? JSON.stringify(item.params) : ''),
    source: normalizeRuleSource(item.source),
    signalMode: normalizeRuleSignalMode(item.signalMode),
    group: String(item.group || '').slice(0, 24)
  };
}

function normalizedImportedClockTime(value, fallback, fieldLabel) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new Error(`Некорректное время ${fieldLabel}: ${normalized}`);
  }
  return normalized;
}

function normalizeImportedConfig(raw, fallbackName = 'Импортированная стратегия') {
  const source = plainObject(raw?.config || raw);
  const name = String(source.name || raw?.name || raw?.title || fallbackName).trim().slice(0, 80) || fallbackName;
  const description = String(source.description || raw?.description || 'Импортировано из JSON');
  if (description.length > MAX_STRATEGY_DESCRIPTION_CHARS) {
    throw new Error(`Описание стратегии длиннее ${MAX_STRATEGY_DESCRIPTION_CHARS} символов.`);
  }
  const patternsAllowed = new Set(['pinbar','engulfing','doji','hammer','morningEvening','threeSoldiersCrows','insideOutside','marubozu','doubleTopBottom','doubleTop','doubleBottom','tripleTop','tripleBottom','headShoulders','inverseHeadShoulders','roundingTop','roundingBottom','cupHandle','invertedCupHandle','triangle','ascendingTriangle','descendingTriangle','risingWedge','fallingWedge','bullChannel','bearChannel','rectangle','broadening','flagPennant','bullFlag','bearFlag','pennant','breakoutRetest','falseBreakout','liquiditySweep','orderBlock','diamondTop','diamondBottom','trendChange','heikenReversal']);
  const assets = cleanAssetSelection(Array.isArray(source.assets) ? source.assets.map((item) => typeof item === 'string' ? item : item?.symbol || item?.asset || item?.name) : []);
  const hasTimeframeMode = Object.prototype.hasOwnProperty.call(source, 'timeframeMode');
  const hasLevelLookback = Object.prototype.hasOwnProperty.call(source, 'levelLookback');
  const hasKeltner = Object.prototype.hasOwnProperty.call(source, 'keltner');
  const strategyExpiration = inferCustomStrategyExpiration(source, name);
  const normalized = {
    name,
    description,
    logic: ['all','any','score','groups'].includes(source.logic) ? source.logic : 'all',
    direction: ({ buy: 'call', sell: 'put' }[String(source.direction || '').toLowerCase()] || (['both','call','put'].includes(String(source.direction || '').toLowerCase()) ? String(source.direction).toLowerCase() : 'both')),
    timeframe: normalizeAnalysisPeriodSeconds(source.timeframe, 300),
    timeframeMode: 'fixed',
    candleOffset: normalizeCandleOffset(source.candleOffset, source.candleMode),
    candleMode: normalizeCandleOffset(source.candleOffset, source.candleMode) === 0 ? 'current' : 'closed',
    levelLookback: Math.min(1000, Math.max(1, Number(source.levelLookback) || 50)),
    keltner: {
      emaPeriod: Math.min(1000, Math.max(1, Number(source.keltner?.emaPeriod) || 17)),
      atrPeriod: Math.min(1000, Math.max(1, Number(source.keltner?.atrPeriod) || 10)),
      multiplier: Math.min(100, Math.max(0.01, Number(source.keltner?.multiplier) || 2))
    },
    marketType: ['all','live','otc'].includes(source.marketType) ? source.marketType : 'all',
    assetMode: ['selected','all','custom'].includes(source.assetMode) ? source.assetMode : (assets.length ? 'custom' : 'selected'),
    assets,
    rules: (Array.isArray(source.rules) ? source.rules : []).map(normalizedImportedRule),
    patterns: (Array.isArray(source.patterns) ? source.patterns : []).filter((item) => patternsAllowed.has(item)),
    patternSettings: {
      searchMode: ['auto','strict','soft'].includes(source.patternSettings?.searchMode) ? source.patternSettings.searchMode : 'auto',
      lookback: Math.min(100, Math.max(10, Number(source.patternSettings?.lookback) || 100)),
      touches: Math.min(6, Math.max(2, Number(source.patternSettings?.touches) || 2)),
      tolerance: Math.min(80, Math.max(5, Number(source.patternSettings?.tolerance) || 25)),
      confirmation: ['breakout','retest','reversal','any'].includes(source.patternSettings?.confirmation) ? source.patternSettings.confirmation : 'breakout',
      strength: Math.min(95, Math.max(40, Number(source.patternSettings?.strength) || 60)),
      freshOnly: source.patternSettings?.freshOnly !== false,
      role: ['confirm','primary','filter'].includes(source.patternSettings?.role) ? source.patternSettings.role : 'confirm'
    },
    confirmations: Math.min(30, Math.max(1, Number(source.confirmations) || 2)),
    decisionMode: 'direction_only',
    mtf: ['off','2x','5x','15m','1h','4h'].includes(source.mtf) ? source.mtf : 'off',
    regime: ['any','trend','range','impulse','lowvol','highvol'].includes(source.regime) ? source.regime : 'any',
    trendFilter: ['off','with','counter','adaptive'].includes(source.trendFilter) ? source.trendFilter : 'off',
    volatility: ['any','normal','expanding','high','low'].includes(source.volatility) ? source.volatility : 'any',
    tickAcceleration: ['off','confirm','required'].includes(source.tickAcceleration) ? source.tickAcceleration : 'off',
    session: ['any','asia','london','newyork','overlap'].includes(source.session) ? source.session : 'any',
    startTime: normalizedImportedClockTime(source.startTime, '00:00', 'начала сессии'),
    endTime: normalizedImportedClockTime(source.endTime, '23:59', 'окончания сессии'),
    signalTtl: Math.min(300, Math.max(1, Number(source.signalTtl) || 5)),
    // Expiration is individual. Legacy files without it are migrated from the
    // strategy name (EXP M1/M2/...) or from their fixed analysis timeframe.
    expirationMode: 'fixed',
    expiration: strategyExpiration,
    duration: strategyExpiration,
    cooldown: Math.max(0, Number.isFinite(Number(source.cooldown)) ? Number(source.cooldown) : 10),
    reentry: ['off','same','next','confirm','sameSignal','nextCandle','reconfirm'].includes(source.reentry) ? source.reentry : 'off',
    lateEntryFilter: source.lateEntryFilter !== false,
    usesAi: Boolean(source.usesAi),
    newsFilter: Boolean(source.newsFilter),
    importedAt: new Date().toISOString(),
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : new Date().toISOString()
  };
  // Old 1.0.70 exports had no timeframeMode. Keep that omission so a pure
  // import -> export round-trip does not rewrite legacy fixed-TF profiles.
  if (!hasTimeframeMode) delete normalized.timeframeMode;
  if (!hasLevelLookback) delete normalized.levelLookback;
  if (!hasKeltner) delete normalized.keltner;
  // 3CANDLE exports from older builds may carry EMA9 and/or EMA21 rules.
  // Migrate them to the exact user-defined model at import time and during every
  // settings load: three closed green/red medium-body candles whose real bodies stay above/below EMA14 on the current TF. No higher-TF/EMA21 filter.
  return sanitizeCustomStrategyGlobalFields(migrateThreeCandleStrategyConfig(normalized, name));
}

function convertLegacyStrategy(raw) {
  const data = plainObject(raw?.data);
  const legacyIndicators = Array.isArray(raw?.indicators) ? raw.indicators : [];
  const legacyRegulations = Array.isArray(raw?.regulations) ? raw.regulations : [];
  const rules = legacyIndicators.map((item) => normalizedImportedRule({
    indicator: item?.indicator || item?.name || item?.type,
    operator: item?.operator || item?.condition || 'signal',
    value: item?.value ?? item?.signal ?? item?.settings,
    period: item?.period,
    weight: item?.weight,
    timeframe: item?.timeframe
  }));
  const regulation = plainObject(legacyRegulations[0]);
  return normalizeImportedConfig({
    name: data.userTitle || data.title || 'Импортированная стратегия',
    description: uiText('Импортировано из legacy JSON', 'Imported from legacy JSON'),
    assets: raw.assets,
    rules,
    candleMode: regulation.candleMode,
    timeframe: regulation.timeframe || regulation.period
  });
}

function validateStrategySchemaVersion(raw) {
  if (raw?.schemaVersion == null) return;
  const version = Number(raw.schemaVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error('Некорректная версия схемы стратегии.');
  if (version > STRATEGY_SCHEMA_VERSION) {
    throw new Error(`Файл использует schemaVersion ${version}, а эта версия расширения поддерживает до ${STRATEGY_SCHEMA_VERSION}. Обновите расширение.`);
  }
}

function parseStrategyDocument(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('JSON должен содержать объект.');
  if (
    raw.format === 'pocket-trade-robot-strategy'
    || raw.format === 'auto-trade-robot-strategy'
    || raw.format === 'apex-trading-strategy'
    || raw.format === 'perfect-trade-strategy'
  ) {
    validateStrategySchemaVersion(raw);
    const source = raw.strategy || raw.data;
    return {
      sourceFormat: 'Pocket TRADE ROBOT',
      strategies: [normalizeImportedConfig(source)],
      ignoredMartingaleCount: importedStrategyContainsMartingale(source) ? 1 : 0
    };
  }
  if (
    raw.format === 'pocket-trade-robot-strategy-bundle'
    || raw.format === 'auto-trade-robot-strategy-bundle'
    || raw.format === 'apex-trading-strategy-bundle'
    || raw.format === 'perfect-trade-strategy-bundle'
  ) {
    validateStrategySchemaVersion(raw);
    const list = Array.isArray(raw.strategies) ? raw.strategies : [];
    if (!list.length) throw new Error('Пакет не содержит стратегий.');
    if (list.length > MAX_IMPORT_STRATEGIES) throw new Error(`В одном пакете разрешено не более ${MAX_IMPORT_STRATEGIES} стратегий.`);
    return {
      sourceFormat: 'Pocket TRADE ROBOT bundle',
      strategies: list.map((item, index) => normalizeImportedConfig(item?.strategy || item, `Стратегия ${index + 1}`)),
      ignoredMartingaleCount: list.filter((item) => importedStrategyContainsMartingale(item?.strategy || item)).length
    };
  }
  if (raw.type === 'personal' && raw.data && ('indicators' in raw || 'regulations' in raw || 'martingale' in raw)) {
    return {
      sourceFormat: 'Legacy personal',
      strategies: [convertLegacyStrategy(raw)],
      ignoredMartingaleCount: importedStrategyContainsMartingale(raw) ? 1 : 0
    };
  }
  if (raw.config || raw.rules || raw.name) {
    return {
      sourceFormat: 'Generic JSON',
      strategies: [normalizeImportedConfig(raw)],
      ignoredMartingaleCount: importedStrategyContainsMartingale(raw) ? 1 : 0
    };
  }
  throw new Error('Формат стратегии не распознан.');
}

function strategyConfigFingerprint(value) {
  const source = { ...plainObject(value?.config || value) };
  const ignored = new Set([
    'id','strategy_id','name','title','description',
    'importedAt','updatedAt','createdAt','serverSaved','importError',
    'amountMode','fixedAmount','amount','balancePercent',
    'expirationMode','expirationMultiplier',
    'minPayout','maxAmount','maxConcurrent','maxTrades',
    'maxLossStreak','maxWinStreak','takeProfit','stopLoss','onePerAsset',
    'martingale','recovery','recoveryConfig','recoveryDurationMode',
    'recoveryMode','recoveryValue','recoverySteps','recoveryPlan',
    'recoveryAfterMax','recoveryStartedAt','recoveryFollowSignal',
    'recoveryAllowConcurrent','recoveryScopeStrategyId','recoveryScopeAsset'
  ]);
  const legacyExecution = plainObject(source.execution);
  if (source.expiration == null) {
    const rawExpiration = source.duration ?? legacyExecution.duration ?? legacyExecution.expiration;
    const parsedExpiration = Number(rawExpiration);
    if (Number.isFinite(parsedExpiration) && parsedExpiration > 0) source.expiration = Math.round(parsedExpiration);
  }
  if (source.cooldown == null && legacyExecution.cooldown != null) source.cooldown = legacyExecution.cooldown;
  for (const key of ['timeframe','expiration','cooldown','candleOffset']) {
    if (source[key] == null || source[key] === '') continue;
    const parsed = Number(source[key]);
    if (Number.isFinite(parsed)) source[key] = Math.round(parsed);
  }
  delete source.duration;
  delete source.execution;
  delete source.confidence;
  delete source.minConfidence;
  source.decisionMode = 'direction_only';
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.keys(item)
        .filter((key) => !ignored.has(key))
        .sort()
        .map((key) => [key, normalize(item[key])])
    );
  };
  return JSON.stringify(normalize(source));
}

function exportEnvelope(item) {
  const config = sanitizeCustomStrategyGlobalFields(normalizeImportedConfig(item?.config || item, item?.title || item?.name || 'Стратегия'));
  delete config.importedAt;
  return {
    format: 'pocket-trade-robot-strategy',
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    product: 'Pocket TRADE ROBOT',
    extensionVersion: VERSION,
    strategy: {
      id: String(item?.id || ''),
      name: config.name,
      description: config.description,
      config
    }
  };
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function recordTransfer(kind, title, details) {
  transferHistory = [{ id: makeLocalId(), kind, title, details, time: new Date().toISOString() }, ...transferHistory].slice(0, 30);
  await chrome.storage.local.set({ ptStrategyTransferHistory: transferHistory });
  renderTransferHistory();
  await recordNotification({ kind: 'strategy', title, message: details });
}

function renderTransferHistory() {
  if (!$('transferHistory')) return;
  $('transferHistory').innerHTML = transferHistory.length ? transferHistory.map((item) => `<div class="transferEvent"><span>${item.kind === 'import' ? '⇩' : '⇧'}</span><div><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.details || '')}</small></div><time>${formatTime(Date.parse(item.time))}</time></div>`).join('') : `<div class="empty">${uiText('Операций пока нет.', 'No operations yet.')}</div>`;
  window.PTI18n?.refresh?.();
}

function exportSingleStrategy(item) {
  const payload = exportEnvelope(item);
  downloadJson(`${safeFileName(payload.strategy.name)}.pocket-trade-robot.json`, payload);
  void recordTransfer('export', uiText('Стратегия экспортирована', 'Strategy exported'), payload.strategy.name);
}

function exportBuilderDraft() {
  const config = sanitizeCustomStrategyGlobalFields(builderConfigFromForm());
  if (!config.name) return toast('Введите название стратегии.', 'error');
  exportSingleStrategy({ id: editingStrategyId || '', name: config.name, config });
}

function exportAllStrategies() {
  const list = allCustomStrategiesForTransfer();
  if (!list.length) return toast('Нет стратегий для экспорта.', 'error');
  const payload = {
    format: 'pocket-trade-robot-strategy-bundle',
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    product: 'Pocket TRADE ROBOT',
    extensionVersion: VERSION,
    strategies: list.map((item) => exportEnvelope(item).strategy)
  };
  downloadJson(`pocket-trade-robot-strategies-${new Date().toISOString().slice(0,10)}.json`, payload);
  void recordTransfer('export', uiText('Создана резервная копия', 'Backup created'), uiText(`${list.length} стратегий`, `${list.length} strategies`));
}

function showStrategyImportPreview(parsed) {
  pendingStrategyImport = parsed;
  const first = parsed.strategies[0];
  $('strategyImportTitle').textContent = parsed.strategies.length > 1
    ? uiText(`Импортировать ${parsed.strategies.length} стратегий?`, `Import ${parsed.strategies.length} strategies?`)
    : uiText(`Импортировать «${first.name}»?`, `Import “${first.name}”?`);
  $('strategyImportPreview').innerHTML = `<div><small>${uiText('Формат', 'Format')}</small><b>${escapeHtml(parsed.sourceFormat)}</b></div><div><small>${uiText('Стратегий', 'Strategies')}</small><b>${parsed.strategies.length}</b></div><div><small>${uiText('Условий', 'Rules')}</small><b>${parsed.strategies.reduce((sum, item) => sum + item.rules.length, 0)}</b></div><div><small>${uiText('Режим свечи', 'Candle mode')}</small><b>${escapeHtml(candleOffsetLabel(first.candleOffset ?? (first.candleMode === 'current' ? 0 : -1)))}</b></div>`;
  const empty = parsed.strategies.filter((item) => !item.rules.length).length;
  const notices = [];
  if (Number(parsed.ignoredMartingaleCount) > 0) {
    notices.push(uiText(
      `В ${parsed.ignoredMartingaleCount} ${parsed.ignoredMartingaleCount === 1 ? 'стратегии найден' : 'стратегиях найден'} встроенный Мартингейл. Он будет удалён из стратегии; текущие глобальные настройки Мартингейла не изменятся.`,
      `Embedded Martingale settings were found in ${parsed.ignoredMartingaleCount} ${parsed.ignoredMartingaleCount === 1 ? 'strategy' : 'strategies'}. They will be removed from the strategy, and the current global Martingale settings will remain unchanged.`
    ));
  }
  if (empty) {
    notices.push(uiText(`${empty} стратегий не содержат условий. Они будут добавлены как черновики — настройте их перед сохранением на сервере.`, `${empty} strategies contain no rules. They will be added as drafts; configure them before saving to the server.`));
  } else {
    notices.push(uiText('После импорта стратегии появятся в разделе «Мои стратегии». Проверьте настройки перед запуском на DEMO.', 'Imported strategies will appear under My strategies. Review them before running on DEMO.'));
  }
  $('strategyImportWarning').textContent = notices.join(' ');
  $('strategyImportModal').hidden = false;
}

async function handleStrategyFile(file) {
  if (!file) return;
  if (file.size > MAX_STRATEGY_FILE_BYTES) throw new Error('Файл больше 2 MB.');
  const text = await file.text();
  const raw = JSON.parse(text);
  showStrategyImportPreview(parseStrategyDocument(raw));
}

async function confirmStrategyImport() {
  if (!pendingStrategyImport) return;
  if (!(access.entitlement?.features?.strategyBuilder ?? access.premium)) {
    $('strategyImportModal').hidden = true;
    pendingStrategyImport = null;
    toast('Импорт пользовательских стратегий доступен вместе с конструктором Premium.', 'error');
    showPremiumRegistration();
    return;
  }
  const existingStrategies = allCustomStrategiesForTransfer();
  const usedNames = new Set(existingStrategies.map((item) => String(item?.name || item?.title || '').trim().toLocaleLowerCase()).filter(Boolean));
  const existingByFingerprint = new Map(existingStrategies.map((item) => [strategyConfigFingerprint(item), item]));
  const imported = [];
  const skipped = [];
  const failed = [];
  for (const config of pendingStrategyImport.strategies) {
    const strategyConfig = sanitizeCustomStrategyGlobalFields(config);
    const fingerprint = strategyConfigFingerprint(strategyConfig);
    const existing = existingByFingerprint.get(fingerprint);
    if (existing) {
      skipped.push(existing);
      continue;
    }
    const name = uniqueImportedName(strategyConfig.name, usedNames);
    const normalizedConfig = sanitizeCustomStrategyGlobalFields({ ...strategyConfig, name });
    try {
      const result = await runtimeMessage({
        type: 'PT_SAVE_CUSTOM_STRATEGY',
        payload: { name, description: normalizedConfig.description || '', config: normalizedConfig }
      });
      if (!result?.ok) throw new Error(result?.error || 'server_save_failed');
      serverState = result.serverState || serverState;
      const saved = result.strategy || {};
      if (result.duplicate === true) {
        skipped.push(saved);
        existingByFingerprint.set(fingerprint, saved);
        continue;
      }
      const savedId = String(saved.id || `custom-${makeLocalId()}`);
      const entry = { ...normalizedConfig, id: savedId, name, title: name, serverSaved: true, config: normalizedConfig };
      imported.push(entry);
      existingByFingerprint.set(fingerprint, entry);
    } catch (error) {
      failed.push(name);
      const entry = { ...normalizedConfig, id: `draft-${makeLocalId()}`, name, title: name, serverSaved: false, config: normalizedConfig, importError: String(error?.message || error) };
      imported.push(entry);
      existingByFingerprint.set(fingerprint, entry);
    }
  }
  if (!imported.length && skipped.length) {
    $('strategyImportModal').hidden = true;
    pendingStrategyImport = null;
    await recordTransfer('import', uiText('Повторный импорт пропущен', 'Duplicate import skipped'), uiText(`${skipped.length} стратегий уже существуют`, `${skipped.length} strategies already exist`));
    toast(uiText('Такие стратегии уже существуют — дубли не созданы.', 'These strategies already exist; no duplicates were created.'), 'ok');
    return;
  }
  const next = [...(settings.builderStrategies || []).filter((item) => !imported.some((entry) => entry.id === item.id)), ...imported].slice(-200);
  const firstReady = imported.find((item) => String(item.id || '').startsWith('custom-'));
  const patch = { builderStrategies: next };
  if (firstReady) {
    patch.activeStrategyId = firstReady.id;
    patch.autoTrade = {
      ...settings.autoTrade,
      strategyId: firstReady.id,
      strategyIds: [firstReady.id]
    };
  }
  await saveSettings(patch);
  $('strategyImportModal').hidden = true;
  pendingStrategyImport = null;
  await recordTransfer('import', uiText('Стратегии импортированы', 'Strategies imported'), failed.length
    ? uiText(`${imported.length - failed.length} сохранено на сервере, ${failed.length} черновик(ов), ${skipped.length} дублей пропущено`, `${imported.length - failed.length} saved on server, ${failed.length} draft(s), ${skipped.length} duplicate(s) skipped`)
    : uiText(`${imported.length} сохранено на сервере, ${skipped.length} дублей пропущено`, `${imported.length} saved on server, ${skipped.length} duplicate(s) skipped`));
  toast(failed.length
    ? uiText(`Импортировано: ${imported.length}. Часть осталась черновиком — откройте и сохраните на сервере.`, `Imported: ${imported.length}. Some stayed drafts — open and save on server.`)
    : uiText(`Импортировано и добавлено в торговые режимы: ${imported.length}.`, `Imported and added to trading modes: ${imported.length}.`), failed.length ? 'error' : 'ok');
  renderSavedStrategies();
  renderStrategies();
  renderAutoStrategyOptions();
  loadAutoInputs();
  setTab('strategies');
  if (firstReady) {
    setStrategyPanel('modes');
  } else if (imported.length === 1) {
    fillBuilderFromItem(imported[0]);
    editingStrategyId = imported[0].id;
    setStrategyPanel('builder');
  } else {
    setStrategyPanel('mine');
  }
}

async function recordNotification({ kind = 'system', title, message }) {
  const event = { id: makeLocalId(), kind, title: String(title || 'Pocket TRADE ROBOT'), message: String(message || ''), createdAt: new Date().toISOString(), read: false };
  notificationHistory = [event, ...notificationHistory].slice(0, 100);
  await chrome.storage.local.set({ ptNotificationHistory: notificationHistory });
  renderNotifications();
}

function renderNotifications() {
  if (!$('notificationFeed')) return;
  const filter = $('notificationFilter')?.value || 'all';
  const list = notificationHistory.filter((item) => filter === 'all' || item.kind === filter);
  const unread = notificationHistory.filter((item) => !item.read).length;
  $('notificationUnreadBadge').textContent = uiText(`${unread} новых`, `${unread} new`);
  if ($('notificationConnection')) $('notificationConnection').textContent = isConnected() ? uiText('Подключено','Connected') : state?.connection?.reconnecting ? uiText('Переподключение','Reconnecting') : uiText('Отключено','Disconnected');
  if ($('notificationServer')) $('notificationServer').textContent = isLocalExpansionMode()
    ? uiText('Локально','Local')
    : runtimeCompatibility.mixed
      ? uiText('Нужен перезапуск','Restart required')
      : serverState?.online
        ? uiText('Онлайн','Online')
        : serverState?.serverReachable
          ? uiText('Обновление сессии','Session refresh')
          : uiText('Офлайн','Offline');
  if ($('notificationAuto')) $('notificationAuto').textContent = settings.autoTrade?.enabled ? uiText('Включена','Enabled') : uiText('Выключена','Disabled');
  if ($('notificationLastTime')) $('notificationLastTime').textContent = notificationHistory[0]?.createdAt ? formatTime(Date.parse(notificationHistory[0].createdAt)) : '—';
  $('notificationFeed').innerHTML = list.length ? list.map((item) => { const actionUrl = safeHttpsUrl(item.actionUrl); return `<article class="notificationItem ${item.read ? '' : 'unread'}" data-kind="${escapeHtml(item.kind)}"><span class="notificationIcon">${item.kind === 'trade' ? '↗' : item.kind === 'access' ? '♛' : item.kind === 'strategy' ? 'ƒ' : item.kind === 'connection' ? '⌁' : 'i'}</span><div><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.message)}</p>${actionUrl ? `<a class="notificationLink" href="${escapeHtml(actionUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.buttonText || 'Открыть')} →</a>` : ''}</div><time>${formatTime(Date.parse(item.createdAt))}</time></article>`; }).join('') : '<div class="empty">Событий пока нет.</div>';
  window.PTI18n?.refresh?.();
}

function serverCustomStrategies() {
  return (Array.isArray(serverState?.strategies) ? serverState.strategies : [])
    .filter((item) => String(item?.id || item?.strategy_id || '').startsWith('custom-'));
}

async function replaceLocalCustomStrategyId(oldId, newId, source, normalizedConfig = null) {
  const fromId = String(oldId || '').trim();
  const toId = String(newId || '').trim();
  if (!fromId || !toId) return toId || fromId;
  const rawConfig = normalizedConfig || sanitizeCustomStrategyGlobalFields(source?.config && typeof source.config === 'object' ? source.config : source || {});
  const name = String(source?.name || source?.title || rawConfig.name || 'Моя стратегия').trim();
  const localItem = {
    ...rawConfig,
    id: toId,
    name,
    title: name,
    description: String(source?.description || rawConfig.description || ''),
    serverSaved: true,
    config: rawConfig
  };
  const nextStrategies = [
    ...(settings.builderStrategies || []).filter((item) => {
      const value = String(item?.id || item?.strategy_id || '');
      return value !== fromId && value !== toId;
    }),
    localItem
  ].slice(-200);
  const selectedIds = Array.isArray(settings.autoTrade?.strategyIds)
    ? settings.autoTrade.strategyIds.map(String)
    : [settings.autoTrade?.strategyId].filter(Boolean).map(String);
  const repairedIds = [...new Set(selectedIds.map((value) => value === fromId ? toId : value).filter(Boolean))];
  await saveSettings({
    builderStrategies: nextStrategies,
    activeStrategyId: String(settings.activeStrategyId || '') === fromId ? toId : settings.activeStrategyId,
    activeBuiltInStrategy: String(settings.activeBuiltInStrategy || '') === fromId ? toId : settings.activeBuiltInStrategy,
    autoTrade: {
      ...settings.autoTrade,
      strategyId: String(settings.autoTrade?.strategyId || '') === fromId ? toId : (repairedIds[0] || settings.autoTrade?.strategyId || ''),
      strategyIds: repairedIds
    }
  });
  return toId;
}

async function ensureCustomStrategyServerSaved(strategyId, { notify = true } = {}) {
  const id = String(strategyId || '').trim();
  if (!id) return null;
  const canUseCustom = Boolean(access.entitlement?.features?.strategyBuilder ?? access.premium);
  if (!canUseCustom) {
    if (notify) toast('Пользовательские стратегии доступны только в PREMIUM.', 'error');
    return null;
  }
  const source = (settings.builderStrategies || []).find((strategy) => String(strategy?.id || strategy?.strategy_id || '') === id)
    || tradeStrategies().find((strategy) => String(strategy?.id || strategy?.strategy_id || '') === id);
  const serverCatalog = serverCustomStrategies();
  const exactServerItem = serverCatalog.find((item) => String(item?.id || item?.strategy_id || '') === id);
  if (id.startsWith('custom-') && exactServerItem) return id;
  if (!source) {
    if (notify) toast('Стратегия не найдена локально и не может быть восстановлена.', 'error');
    return null;
  }

  const rawConfig = source.config && typeof source.config === 'object' ? source.config : source;
  const cfg = sanitizeCustomStrategyGlobalFields(rawConfig);
  const fingerprint = strategyConfigFingerprint(cfg);
  const sourceNameKey = String(source.name || source.title || cfg.name || '').trim().toLocaleLowerCase();
  const sameServerStrategy = serverCatalog.find((item) => {
    const serverNameKey = String(item?.name || item?.title || item?.config?.name || '').trim().toLocaleLowerCase();
    return Boolean(sourceNameKey && serverNameKey === sourceNameKey && strategyConfigFingerprint(item) === fingerprint);
  });
  if (sameServerStrategy) {
    const matchedId = String(sameServerStrategy.id || sameServerStrategy.strategy_id || '').trim();
    if (matchedId) {
      await replaceLocalCustomStrategyId(id, matchedId, source, cfg);
      if (notify && matchedId !== id) toast('Локальная стратегия повторно связана с её серверной копией.', 'ok');
      return matchedId;
    }
  }

  const name = String(source.name || source.title || cfg.name || 'Imported strategy').trim();
  try {
    const payload = {
      ...(id.startsWith('custom-') ? { id } : {}),
      name,
      description: source.description || cfg.description || '',
      config: sanitizeCustomStrategyGlobalFields({ ...cfg, name })
    };
    const result = await runtimeMessage({
      type: 'PT_SAVE_CUSTOM_STRATEGY',
      payload
    }, { attempts: 2, timeoutMs: 15000 });
    if (!result?.ok) throw new Error(result?.error || 'server_save_failed');
    serverState = result.serverState || serverState;
    const saved = result.strategy || {};
    const savedId = String(saved.id || id || `custom-${makeLocalId()}`);
    await replaceLocalCustomStrategyId(id, savedId, source, sanitizeCustomStrategyGlobalFields({ ...cfg, name }));
    if (notify) toast(`Стратегия «${name}» сохранена на сервере и доступна в торговых режимах.`, 'ok');
    return savedId;
  } catch (error) {
    if (notify) toast(error.message || 'Не удалось сохранить стратегию на сервере.', 'error');
    return null;
  }
}

async function repairMissingServerCustomStrategies() {
  if (repairMissingServerCustomStrategies.running) return false;
  repairMissingServerCustomStrategies.running = true;
  try {
    const serverIds = new Set(serverCustomStrategies().map((item) => String(item?.id || item?.strategy_id || '')).filter(Boolean));
    const candidates = (settings.builderStrategies || []).filter((item) => {
      const id = String(item?.id || item?.strategy_id || '');
      if (!id || item?.serverSaved !== true) return false;
      return !id.startsWith('custom-') || !serverIds.has(id);
    });
    let changed = false;
    for (const item of candidates.slice(0, 10)) {
      const oldId = String(item?.id || item?.strategy_id || '');
      const savedId = await ensureCustomStrategyServerSaved(oldId, { notify: false });
      if (savedId && savedId !== oldId) changed = true;
      else if (savedId) changed = true;
    }
    if (changed) {
      renderSavedStrategies();
      renderStrategies();
      renderAutoStrategyOptions();
      loadAutoInputs();
    }
    return changed;
  } finally {
    repairMissingServerCustomStrategies.running = false;
  }
}


async function synchronizeCustomStrategyCatalog() {
  if (synchronizeCustomStrategyCatalog.running) return false;
  synchronizeCustomStrategyCatalog.running = true;
  try {
    const remoteItems = serverCustomStrategies();
    const remoteIds = new Set(remoteItems.map((item) => String(item?.id || item?.strategy_id || '')).filter(Boolean));
    const deletedIds = new Set((Array.isArray(serverState?.deletedCustomStrategyIds) ? serverState.deletedCustomStrategyIds : []).map(String).filter(Boolean));
    const originalLocal = Array.isArray(settings.builderStrategies) ? settings.builderStrategies : [];
    const originalById = new Map(originalLocal.map((item) => [String(item?.id || item?.strategy_id || ''), item]));
    const nextById = new Map();
    let changed = false;

    for (const item of originalLocal) {
      const id = String(item?.id || item?.strategy_id || '');
      if (id && deletedIds.has(id)) {
        changed = true;
        continue;
      }
      if (id) nextById.set(id, item);
    }

    for (const remote of remoteItems) {
      const id = String(remote?.id || remote?.strategy_id || '').trim();
      if (!id || deletedIds.has(id)) continue;
      const previous = originalById.get(id) || {};
      const rawConfig = remote?.config && typeof remote.config === 'object' ? remote.config : remote;
      const config = sanitizeCustomStrategyGlobalFields(rawConfig);
      const name = String(remote?.name || remote?.title || config?.name || previous?.name || 'Моя стратегия').trim();
      const localItem = {
        ...config,
        id,
        name,
        title: name,
        description: String(remote?.description || config?.description || previous?.description || ''),
        serverSaved: true,
        importedAt: previous?.importedAt || null,
        serverSyncedAt: previous?.serverSyncedAt || new Date().toISOString(),
        config
      };
      const current = nextById.get(id);
      const currentComparable = current ? { ...current, serverSyncedAt: null } : null;
      const nextComparable = { ...localItem, serverSyncedAt: null };
      if (!current || JSON.stringify(currentComparable) !== JSON.stringify(nextComparable)) changed = true;
      nextById.set(id, localItem);
    }

    const deletedSelected = selectedStrategyIdsForAuto(settings.autoTrade || {}).filter((id) => deletedIds.has(String(id)));
    const patch = {};
    if (changed) patch.builderStrategies = [...nextById.values()].slice(-200);
    if (deletedSelected.length) {
      const remainingIds = selectedStrategyIdsForAuto(settings.autoTrade || {}).filter((id) => !deletedIds.has(String(id)));
      const profiles = { ...(settings.autoTrade?.strategyProfiles || {}) };
      for (const id of deletedSelected) delete profiles[String(id)];
      patch.autoTrade = {
        ...settings.autoTrade,
        strategyIds: remainingIds,
        strategyId: remainingIds[0] || '',
        strategyProfiles: profiles,
        enabled: remainingIds.length ? settings.autoTrade?.enabled === true : false
      };
      if (deletedIds.has(String(settings.activeStrategyId || ''))) patch.activeStrategyId = remainingIds[0] || '';
      changed = true;
    }
    if (changed) await saveSettings(patch);

    const localAfterMerge = Array.isArray(settings.builderStrategies) ? settings.builderStrategies : [];
    let repaired = false;
    for (const item of localAfterMerge.slice(0, 200)) {
      const id = String(item?.id || item?.strategy_id || '');
      if (!id || item?.serverSaved !== true || deletedIds.has(id) || remoteIds.has(id)) continue;
      const savedId = await ensureCustomStrategyServerSaved(id, { notify: false });
      if (savedId) repaired = true;
    }
    if (changed || repaired) {
      renderSavedStrategies();
      renderStrategies();
      renderAutoStrategyOptions();
      loadAutoInputs();
    }
    return changed || repaired;
  } finally {
    synchronizeCustomStrategyCatalog.running = false;
  }
}

async function repairLegacyImportedStrategyIds() {
  if (repairLegacyImportedStrategyIds.running) return false;
  repairLegacyImportedStrategyIds.running = true;
  try {
    const legacy = (settings.builderStrategies || []).filter((item) => item?.serverSaved === true && !String(item?.id || '').startsWith('custom-'));
    if (!legacy.length) return false;
    let changed = false;
    for (const item of legacy.slice(0, 5)) {
      const savedId = await ensureCustomStrategyServerSaved(String(item.id || ''), { notify: false });
      if (savedId) changed = true;
    }
    if (changed) {
      renderSavedStrategies();
      renderStrategies();
      renderAutoStrategyOptions();
    }
    return changed;
  } finally {
    repairLegacyImportedStrategyIds.running = false;
  }
}

async function chooseStrategy(id) {
  let activeId = String(id || '').trim();
  let item = tradeStrategies().find((strategy) => strategy.id === activeId);
  if (!item) return toast('Стратегия не найдена в каталоге.', 'error');
  if (strategyLockedForAccess(item)) return toast('Эта стратегия доступна только в PREMIUM.', 'error');
  if (item.custom && !activeId.startsWith('custom-')) {
    const savedId = await ensureCustomStrategyServerSaved(activeId);
    if (!savedId) return;
    activeId = savedId;
    item = tradeStrategies().find((strategy) => strategy.id === activeId) || item;
  }
  const candidate = {
    ...settings.autoTrade,
    strategyId: activeId,
    strategyIds: [activeId]
  };
  const repaired = repairedSelectedAutoStrategyProfiles(candidate, [activeId]);
  const compatibility = autoStrategyCompatibility(activeId, repaired.auto, item);
  if (!compatibility.compatible) return toast(`${item.title}: не удалось автоматически применить совместимый профиль (${compatibility.requirement}).`, 'error');
  focusedAutoProfileStrategyId = activeId;
  applyAutoProfileToVisibleControls(activeId, repaired.auto);
  await saveSettings({ activeStrategyId: activeId, autoTrade: repaired.auto, period: repaired.auto.period });
  renderStrategies();
  renderAutoStrategyOptions();
  toast(item.custom
    ? 'Пользовательская стратегия выбрана для автоторговли.'
    : `${item.title}: стратегия выбрана, TF анализа и экспирация согласованы автоматически.`, 'ok');
}

async function handleAutoEnabledChange() {
  const desired = $('autoEnabled').checked;
  if (desired && !isConnected()) {
    $('autoEnabled').checked = false;
    toast('Сначала подключите аккаунт Pocket Option.', 'error');
    setTab('account');
    return;
  }
  if (desired && !selectedAssets.size) {
    $('autoEnabled').checked = false;
    toast('Сначала выберите хотя бы один актив во вкладке «Рынок и данные».', 'error');
    setTab('market');
    return;
  }
  if (desired && !selectedAutoStrategyIdsFromUi().length) {
    $('autoEnabled').checked = false;
    toast('Сначала выберите стратегию.', 'error');
    setTab('strategies');
    return;
  }
  await saveAutoTrade();
}

function autoTradeFromForm() {
  const executionSnapshot = autoExecutionSettingsSnapshot(settings.autoTrade || {});
  const strategyIds = selectedAutoStrategyIdsFromUi();
  const primaryProfile = strategyIds[0]
    ? autoStrategyExecutionProfile(strategyIds[0], executionSnapshot)
    : null;
  const amountMode = $('autoAmountMode').value === 'balancePercent' ? 'balancePercent' : 'fixed';
  syncAutoAmountModeUi({ resetInactive: true });
  const fixedAmount = amountMode === 'fixed' ? Math.max(0.01, Number($('autoAmount').value) || 1) : 0;
  const balancePercent = amountMode === 'balancePercent'
    ? Math.min(10, Math.max(0.01, Number($('autoBalancePercent').value) || 1))
    : 0;
  const recoveryEnabled = $('autoRecoveryEnabled').checked;
  const recoverySteps = recoveryEnabled ? Math.min(5, Math.max(1, Number($('autoRecoverySteps').value) || 1)) : 0;
  const recoveryPlan = recoveryPlanFromForm();
  const baseForCap = amountMode === 'balancePercent' ? baseAmountPreview() : fixedAmount;
  const rawMaxAmount = Math.max(0.01, Number($('autoMaxAmount').value) || baseForCap);
  const effectiveMaxAmount = normalizeRecoveryMaxAmount(rawMaxAmount, baseForCap, recoveryPlan, recoverySteps);
  if ($('autoMaxAmount') && Math.abs(Number($('autoMaxAmount').value || 0) - effectiveMaxAmount) > .0001) {
    $('autoMaxAmount').value = String(effectiveMaxAmount);
  }
  return {
    enabled: $('autoEnabled').checked,
    strategyIds,
    strategyId: strategyIds[0] || '',
    strategyMode: strategyIds.length > 1 ? 'independent' : (['best','independent'].includes($('autoStrategyMode')?.value) ? $('autoStrategyMode').value : 'best'),
    strategyProfiles: executionSnapshot.strategyProfiles,
    profileSettingsVersion: 1,
    candleOffset: primaryProfile?.candleOffset ?? normalizeCandleOffset(executionSnapshot.candleOffset, executionSnapshot.candleMode),
    candleMode: (primaryProfile?.candleOffset ?? normalizeCandleOffset(executionSnapshot.candleOffset, executionSnapshot.candleMode)) === 0 ? 'current' : 'closed',
    period: primaryProfile?.period ?? executionSnapshot.period,
    amountMode,
    amount: fixedAmount,
    balancePercent,
    maxAmount: effectiveMaxAmount,
    // Global expiration is consumed only by compatible built-in strategies.
    // Constructor/imported strategies keep the expiration saved in their profile.
    expirationMode: 'fixed',
    expirationMultiplier: 0,
    duration: primaryProfile?.duration ?? executionSnapshot.duration,
    decisionMode: 'direction_only',
    cooldown: primaryProfile?.cooldown ?? Math.max(0, Number(executionSnapshot.cooldown) || 0),
    maxConcurrent: Math.min(20, Math.max(1, Number($('autoConcurrent').value) || 1)),
    minPayout: MIN_TRADE_PAYOUT,
    direction: $('autoDirection').value,
    takeProfit: Math.max(0, Number($('autoTakeProfit').value) || 0),
    stopLoss: Math.max(0, Number($('autoStopLoss').value) || 0),
    maxTrades: Math.max(0, Number($('autoMaxTrades').value) || 0),
    maxLossStreak: Math.max(0, Number($('autoMaxLossStreak').value) || 0),
    maxWinStreak: 0,
    recoveryMode: recoveryEnabled ? 'steps' : 'off',
    recoveryValue: 2,
    recoverySteps,
    recoveryPlan,
    recoveryAfterMax: $('autoRecoveryAfterMax').value === 'reset' ? 'reset' : 'stop',
    recoveryFollowSignal: $('autoRecoveryFollowSignal')?.checked === true,
    recoveryStartedAt: recoveryEnabled
      ? (settings.autoTrade?.recoveryMode === 'steps' && Number.isFinite(Date.parse(settings.autoTrade?.recoveryStartedAt || ''))
        ? settings.autoTrade.recoveryStartedAt
        : new Date().toISOString())
      : null,
    onePerAsset: $('autoOnePerAsset').checked,
    sessionStartedAt: $('autoEnabled').checked
      ? (settings.autoTrade?.enabled ? (settings.autoTrade?.sessionStartedAt || new Date().toISOString()) : new Date().toISOString())
      : null,
    riskDefaultsVersion: 7
  };
}

async function persistAutoTradeControls({ notify = false } = {}) {
  const fromForm = autoTradeFromForm();
  const auto = repairedSelectedAutoStrategyProfiles(fromForm, fromForm.strategyIds).auto;
  await saveSettings({
    autoTrade: auto,
    activeStrategyId: auto.strategyIds[0] || settings.activeStrategyId,
    period: auto.period
  });
  if (notify) toast('Настройки автоторговли сохранены · режим ближайшего направления BUY/SELL', 'ok');
  return auto;
}

async function saveAutoTrade() {
  let auto = autoTradeFromForm();
  if (auto.enabled && !auto.strategyIds.length) return toast('Выберите хотя бы одну стратегию перед включением автоторговли.', 'error');
  if (auto.enabled) {
    const repairedIds = [];
    for (const strategyId of auto.strategyIds) {
      if (isConstructorStrategyItem(strategyId)) {
        const savedId = await ensureCustomStrategyServerSaved(strategyId, { notify: true });
        if (!savedId) {
          if ($('autoEnabled')) $('autoEnabled').checked = false;
          return;
        }
        repairedIds.push(savedId);
      } else repairedIds.push(strategyId);
    }
    auto.strategyIds = [...new Set(repairedIds.filter(Boolean))];
    auto.strategyId = auto.strategyIds[0] || '';
    auto.strategyMode = auto.strategyIds.length > 1 ? 'independent' : auto.strategyMode;
  }
  const repaired = repairedSelectedAutoStrategyProfiles(auto, auto.strategyIds);
  auto = repaired.auto;
  if (auto.strategyIds[0]) applyAutoProfileToVisibleControls(auto.strategyIds[0], auto);
  const compatibleStrategyIds = auto.strategyIds.filter((id) => autoStrategyCompatibility(id, auto, autoStrategyItem(id)).compatible);
  if (auto.enabled && compatibleStrategyIds.length !== auto.strategyIds.length) {
    $('autoEnabled').checked = false;
    auto.enabled = false;
    await reconcileAutoStrategyCompatibility({ notify: true, persist: false });
    return;
  }
  if (auto.enabled && !selectedAssets.size) return toast('Сначала выберите активы и нажмите «Подключить графики».', 'error');
  if (access.limits?.maxAssets != null && selectedAssets.size > access.limits.maxAssets) return toast('Превышен лимит пар тарифа.', 'error');
  await saveSettings({
    autoTrade: auto,
    activeStrategyId: auto.strategyIds[0] || settings.activeStrategyId,
    period: auto.period
  });

  if (auto.enabled && isConnected() && selectedAssets.size) {
    const assets = [...selectedAssets];
    const plan = autoSubscriptionPlan(auto);
    let subscription;
    try {
      subscription = await tabMessage({
        type: 'PO_SUBSCRIBE',
        payload: {
          assets,
          period: plan.primaryPeriod,
          primaryPeriod: plan.primaryPeriod,
          periods: plan.requiredPeriods,
          historyOffsets: plan.historyOffsets,
          historyOffset: plan.historyOffsets?.[plan.primaryPeriod] || plan.historyOffset,
          autoManagePeriods: true
        }
      }, { timeoutMs: 45000, heal: false });
    } catch (error) {
      if (!isTabMessageTimeoutError(error)) throw error;
      subscription = { ok: true, pending: true };
      toast('Pocket Option временно задержал подтверждение рыночной подписки. Автоторговля остаётся включённой, подключение продолжается.', 'ok');
      setTimeout(refreshState, 700);
      setTimeout(refreshState, 2400);
    }
    if (!subscription?.ok) {
      $('autoEnabled').checked = false;
      auto.enabled = false;
      await saveSettings({ autoTrade: auto });
      toast(`Не удалось запустить рыночные потоки: ${subscription?.error || 'неизвестная ошибка'}`, 'error');
      return;
    }
  }

  toast(auto.enabled
    ? `Автоторговля включена. История загружена, сервер анализирует ${candleOffsetLabel(settings.autoTrade?.candleOffset ?? (settings.autoTrade?.candleMode === 'current' ? 0 : -1))} выбранных активов.`
    : 'Автоторговля выключена.', 'ok');
}

function askConfirmation(payload) {
  return new Promise((resolve) => {
    pendingConfirmation = { payload, resolve };
    const call = payload.action === 'call';
    $('confirmIcon').textContent = call ? '▲' : '▼';
    $('confirmIcon').classList.toggle('put', !call);
    $('confirmTitle').textContent = call ? 'Открыть BUY / CALL?' : 'Открыть SELL / PUT?';
    $('confirmMode').textContent = state?.account?.mode || '—';
    $('confirmAsset').textContent = payload.asset;
    $('confirmAmount').textContent = formatMoney(payload.amount, currentCurrency());
    $('confirmDuration').textContent = `${payload.duration} сек`;
    $('rememberChoice').checked = false;
    $('confirmModal').hidden = false;
  });
}

function closeConfirmation(accepted) {
  if (!pendingConfirmation) return;
  const pending = pendingConfirmation;
  pendingConfirmation = null;
  $('confirmModal').hidden = true;
  pending.resolve({ accepted, remember: accepted && $('rememberChoice').checked });
}

async function executeTrade(action) {
  const now = performance.now();
  if (manualTradeBusy || now - lastTradeClickAt < 250) return;
  lastTradeClickAt = now;
  const payload = {
    asset: $('tradeAsset').value.trim(),
    amount: Number($('tradeAmount').value),
    duration: Number($('tradeDuration').value),
    action,
    source: 'manual'
  };
  if (!isConnected()) return toast('Сначала подключите аккаунт.', 'error');
  if (!payload.asset || !Number.isFinite(payload.amount) || payload.amount <= 0 || !Number.isFinite(payload.duration) || payload.duration < 1) return toast('Проверьте актив, сумму и экспирацию.', 'error');
  manualTradeBusy = true;
  if ($('buy')) $('buy').disabled = true;
  if ($('sell')) $('sell').disabled = true;
  try {
    if (settings.confirmTrades) {
      const answer = await askConfirmation(payload);
      if (!answer.accepted) return;
      if (answer.remember) await saveSettings({ confirmTrades: false });
    }
    const result = await tabMessage({ type: 'PO_TRADE', payload });
    if (!result?.ok) throw new Error(result?.error || 'Сделка не отправлена');
    await saveSettings({ asset: payload.asset, amount: payload.amount, duration: payload.duration });
    toast(`${action === 'call' ? 'BUY' : 'SELL'} ${payload.asset}: команда отправлена.`, 'ok');
    setTimeout(refreshState, 120);
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    manualTradeBusy = false;
    if ($('buy')) $('buy').disabled = false;
    if ($('sell')) $('sell').disabled = false;
  }
}

function redactDiagnosticValue(value, key = '', depth = 0, seen = new WeakSet()) {
  const keyText = String(key);
  const safeStatusKey = /^(authenticated|authenticatedAt|authCaptured|authConfirmed|accountAuth|marketAuth|sessionCaptured|sessionPresent|sessionStartedAt)$/i;
  const sensitiveKey = /(password|passcode|secret|authorization|cookie|seed|private.?key|api.?key|card|cvv|credential|authRaw|authPayload|jwt|bearer|refresh.?token|access.?token|session.?token|ssid|(^|[_-])token($|[_-]))/i;
  if (!safeStatusKey.test(keyText) && sensitiveKey.test(keyText)) return '[REDACTED]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=:-]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:token|session|ssid|auth|authorization|jwt|key)=)[^&\s#]+/gi, '$1[REDACTED]');
    return cleaned.length > 12000 ? `${cleaned.slice(0, 12000)}…[TRUNCATED]` : cleaned;
  }
  if (typeof value !== 'object') return String(value);
  if (depth >= 8) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const list = value.slice(-250).map((item, index) => redactDiagnosticValue(item, String(index), depth + 1, seen));
    if (value.length > 250) list.unshift(`[TRUNCATED_${value.length - 250}_ITEMS]`);
    seen.delete(value);
    return list;
  }
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactDiagnosticValue(childValue, childKey, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function diagnosticText(value, fallback = '—') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}

function diagnosticDate(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : `${parsed.toLocaleString(interfaceLocale())} (${parsed.toISOString()})`;
}

function diagnosticListText(value, fallback = '—') {
  const list = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  const normalized = list.map((item) => diagnosticText(item, '')).filter(Boolean);
  return normalized.length ? normalized.join(', ') : fallback;
}

function buildDiagnosticReport(diagnostic) {
  const account = diagnostic.state?.account || {};
  const connection = diagnostic.state?.connection || {};
  const socket = diagnostic.state?.socket || {};
  const entitlement = diagnostic.access?.entitlement || diagnostic.serverState?.entitlement || {};
  const signal = diagnostic.signalDiagnostics || {};
  const auto = diagnostic.autoStatus || {};
  const dashboard = diagnostic.dashboardHealth || {};
  const recentErrors = Array.isArray(dashboard.recentErrors) ? dashboard.recentErrors : [];
  const recentDeals = Array.isArray(diagnostic.ledger?.closedDeals) ? diagnostic.ledger.closedDeals.slice(-20) : [];
  const statusPnl = Number(diagnostic.ledger?.today?.netProfit || 0);
  const lines = [
    'Pocket TRADE ROBOT — ДАННЫЕ ДЛЯ ДИАГНОСТИКИ РАЗРАБОТЧИКУ',
    '=====================================================',
    '',
    'Файл сформирован расширением автоматически. Редактировать его не нужно.',
    'Отправьте этот TXT-файл разработчику вместе с кратким описанием проблемы и скриншотом.',
    'Пароли, коды 2FA, cookies и секретные токены в отчёт не добавляются.',
    '',
    '[1. ОСНОВНАЯ ИНФОРМАЦИЯ]',
    `Дата формирования: ${diagnosticDate(diagnostic.capturedAt)}`,
    `Версия расширения: ${diagnosticText(diagnostic.extensionVersion)}`,
    `Сборка: ${diagnosticText(diagnostic.buildId)}`,
    `Сборка фонового ядра: ${diagnosticText(diagnostic.runtimeInfo?.buildId)}`,
    `Совместимость ядра: ${diagnosticText(diagnostic.runtimeCompatibility?.status)}`,
    `Причина рассинхронизации: ${diagnosticText(diagnostic.runtimeCompatibility?.reason)}`,
    `ID расширения: ${diagnosticText(diagnostic.extensionId)}`,
    `UID Pocket Option: ${diagnosticText(account.uid || diagnostic.serverState?.pocketUid)}`,
    `Режим счёта: ${diagnosticText(account.mode)}`,
    `Баланс: ${diagnosticText(account.balance)} ${diagnosticText(account.currency, '')}`.trim(),
    `Тариф: ${diagnosticText(diagnostic.access?.tier)}`,
    `Premium активен: ${diagnosticText(diagnostic.access?.premium ?? entitlement.premium)}`,
    `Страница Pocket Option: ${diagnosticText(diagnostic.pageTab?.url)}`,
    '',
    '[2. ПОДКЛЮЧЕНИЕ И СЕРВЕР]',
    `Аккаунт подключён: ${diagnosticText(connection.connected)}`,
    `Запрошено подключение: ${diagnosticText(connection.requested)}`,
    `Переподключение: ${diagnosticText(connection.reconnecting)}`,
    `WebSocket авторизован: ${diagnosticText(socket.authenticated)}`,
    `WebSocket readyState: ${diagnosticText(socket.readyState)}`,
    `Локальный режим: ${diagnosticText(diagnostic.serverState?.localOnly === true)}`,
    `Сервер Pocket TRADE ROBOT онлайн: ${diagnosticText(diagnostic.serverState?.localOnly ? false : diagnostic.serverState?.online)}`,
    `API сервера доступен: ${diagnosticText(diagnostic.serverState?.localOnly ? false : diagnostic.serverState?.serverReachable)}`,
    `Активный API адрес: ${diagnosticText(diagnostic.serverState?.apiBase)}`,
    `UID серверной сессии: ${diagnosticText(diagnostic.serverState?.sessionUid)}`,
    `Последняя ошибка сервера: ${diagnosticText(diagnostic.serverState?.lastError)}`,
    `Последняя транспортная ошибка: ${diagnosticText(diagnostic.serverState?.lastTransportError)}`,
    `Версия схемы серверного состояния: ${diagnosticText(diagnostic.serverState?.version)}`,
    `Юридическое согласие текущей версии: ${diagnosticText(diagnostic.legalConsent?.accepted)}`,
    `Версия юридического согласия: ${diagnosticText(diagnostic.legalConsent?.version)}`,
    '',
    '[3. АВТОТОРГОВЛЯ И СИГНАЛЬНЫЙ КАНАЛ]',
    `Автоторговля включена: ${diagnosticText(diagnostic.settings?.autoTrade?.enabled)}`,
    `Состояние автоторговли: ${diagnosticText(auto.state)}`,
    `Сообщение автоторговли: ${diagnosticText(auto.message)}`,
    `Статус сигнального канала: ${diagnosticText(signal.status)}`,
    `Последнее сообщение канала: ${diagnosticDate(signal.lastMessageAt)}`,
    `Последняя активность движка: ${diagnosticDate(signal.lastEngineAt)}`,
    `Последняя ошибка канала: ${diagnosticText(signal.lastError || signal.error)}`,
    `Pocket Partners API: ${diagnosticText(diagnostic.pocketPartnersStatus?.state?.status || 'off')}`,
    `Pocket Partners authenticated: ${diagnosticText(diagnostic.pocketPartnersStatus?.state?.authenticated)}`,
    `Снимков отправлено: ${diagnosticText(signal.snapshotsSent, '0')}`,
    `Отклонённых снимков: ${diagnosticText(signal.snapshotErrors, '0')}`,
    `Таймаутов очереди: ${diagnosticText(signal.snapshotTimeouts, '0')}`,
    `Реальных восстановлений канала: ${diagnosticText(signal.recoveryCount, '0')}`,
    `Старых сигналов другой подписки отброшено: ${diagnosticText(signal.staleSignals, '0')}`,
    `Очередь исполнения сейчас: ${diagnosticText(diagnostic.state?.autoExecutionDiagnostics?.queueDepth, '0')}`,
    `Получено сигналов клиентом: ${diagnosticText(diagnostic.state?.autoExecutionDiagnostics?.decisions?.received, '0')}`,
    `Открыто сделок клиентом: ${diagnosticText(diagnostic.state?.autoExecutionDiagnostics?.decisions?.opened, '0')}`,
    `Заменено более свежими сигналами: ${diagnosticText(diagnostic.state?.autoExecutionDiagnostics?.decisions?.replacedByNewer, '0')}`,
    `Отброшено по старой конфигурации: ${diagnosticText(diagnostic.state?.autoExecutionDiagnostics?.decisions?.droppedOldConfig, '0')}`,
    `Отброшено по сроку сигнала: ${diagnosticText(diagnostic.state?.autoExecutionDiagnostics?.decisions?.droppedExpired, '0')}`,
    `Выбранные активы: ${diagnosticListText(diagnostic.selectedAssets)}`,
    `Выбранные стратегии: ${diagnosticListText(diagnostic.selectedStrategyIds)}`,
    '',
    '[4. ИНТЕРФЕЙС И ОШИБКИ]',
    `Состояние панели: ${diagnosticText(dashboard.bodyState)}`,
    `Неудачных обновлений панели: ${diagnosticText(dashboard.refreshFailures, '0')}`,
    `Экран восстановления показан: ${diagnosticText(dashboard.recoveryVisible)}`,
    `Последняя ошибка панели: ${diagnosticText(dashboard.lastError?.message || dashboard.lastError)}`,
    `Количество ошибок текущей версии: ${recentErrors.length}`,
    `Исторических ошибок от старых версий: ${diagnosticText(dashboard.historicalErrorCount, '0')}`,
    ''
  ];

  if (recentErrors.length) {
    lines.push('Последние ошибки интерфейса:');
    recentErrors.slice(-20).forEach((error, index) => {
      lines.push(`${index + 1}. [${diagnosticText(error.createdAt)}] ${diagnosticText(error.context)} — ${diagnosticText(error.message)}`);
      if (error.stack) lines.push(`   Stack: ${String(error.stack).replace(/\s+/g, ' ').slice(0, 1800)}`);
    });
  } else {
    lines.push('Последние ошибки интерфейса: не зафиксированы.');
  }

  lines.push(
    '',
    '[5. СТАТИСТИКА]',
    `P/L в статус-баре: ${diagnosticText(statusPnl, '0')} ${diagnosticText(diagnostic.profitStats?.currency || account.currency, '')}`.trim(),
    `Результат закрытых сделок сегодня: ${diagnosticText(diagnostic.ledger?.today?.netProfit, '0')} ${diagnosticText(diagnostic.profitStats?.currency || account.currency, '')}`.trim(),
    `Изменение баланса от точки отсчёта: ${diagnosticText(diagnostic.profitStats?.delta, '0')} ${diagnosticText(diagnostic.profitStats?.currency || account.currency, '')}`.trim(),
    `Открытых сделок (эффективно): ${Array.isArray(diagnostic.ledger?.openDeals) ? diagnostic.ledger.openDeals.length : 0}`,
    `Открытых сделок в состоянии брокера: ${diagnosticText(diagnostic.tradeTelemetry?.brokerOpenCount, '0')}`,
    `Оптимистически подтверждённых открытых: ${diagnosticText(diagnostic.tradeTelemetry?.optimisticOpenCount, '0')}`,
    `Последний снимок открытых сделок: ${diagnosticDate(diagnostic.tradeTelemetry?.lastOpenSnapshotAt)}`,
    `Количество в последнем снимке: ${diagnosticText(diagnostic.tradeTelemetry?.lastOpenSnapshotCount, '0')}`,
    `Закрытых сделок в локальном журнале: ${Array.isArray(diagnostic.ledger?.closedDeals) ? diagnostic.ledger.closedDeals.length : 0}`,
    `Последних сделок включено в отчёт: ${recentDeals.length}`,
    '',
    '[6. СРЕДА]',
    `Браузер: ${diagnosticText(diagnostic.environment?.userAgent)}`,
    `Язык: ${diagnosticText(diagnostic.environment?.language)}`,
    `Часовой пояс: ${diagnosticText(diagnostic.environment?.timeZone)}`,
    `Онлайн браузера: ${diagnosticText(diagnostic.environment?.online)}`,
    '',
    '[7. ПОЛНЫЕ ТЕХНИЧЕСКИЕ ДАННЫЕ JSON]',
    'Ниже находится технический снимок состояния для разработчика.',
    '',
    JSON.stringify(diagnostic, null, 2),
    '',
    'КОНЕЦ ОТЧЁТА'
  );
  return lines.join('\r\n');
}

async function downloadDiagnostics() {
  try {
    const liveDiagnostics = await runtimeMessage({ type: 'PT_GET_SIGNAL_DIAGNOSTICS' }).catch(() => null);
    if (liveDiagnostics?.ok) signalDiagnostics = liveDiagnostics.diagnostics || signalDiagnostics;
    const uiStored = await chrome.storage.local.get(['ptDashboardErrorLog', 'ptLegalConsent']).catch(() => ({}));
    const heartbeatStored = await chrome.storage.session.get('ptDashboardHeartbeat').catch(() => ({}));
    const allDashboardErrors = Array.isArray(uiStored.ptDashboardErrorLog) ? uiStored.ptDashboardErrorLog : [];
    const currentDashboardErrors = allDashboardErrors.filter((item) => String(item?.version || '') === VERSION);
    const historicalDashboardErrors = allDashboardErrors.filter((item) => String(item?.version || '') !== VERSION);
    const rawDiagnostic = {
      reportFormat: 'Pocket TRADE ROBOT Diagnostic TXT v2',
      extensionVersion: VERSION,
      buildId: BUILD_ID,
      extensionId: chrome.runtime.id,
      runtimeInfo,
      runtimeCompatibility,
      legalConsent: {
        accepted: isCurrentLegalConsent(uiStored.ptLegalConsent),
        version: String(uiStored.ptLegalConsent?.version || ''),
        acceptedAt: uiStored.ptLegalConsent?.acceptedAt || null,
        adultConfirmed: uiStored.ptLegalConsent?.adultConfirmed === true,
        riskAccepted: uiStored.ptLegalConsent?.riskAccepted === true,
        pocketOfferAccepted: uiStored.ptLegalConsent?.pocketOfferAccepted === true,
        termsAccepted: uiStored.ptLegalConsent?.termsAccepted === true,
        privacyAccepted: uiStored.ptLegalConsent?.privacyAccepted === true,
        affiliateDisclosureAccepted: uiStored.ptLegalConsent?.affiliateDisclosureAccepted === true
      },
      capturedAt: new Date().toISOString(),
      environment: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        online: navigator.onLine,
        visibility: document.visibilityState
      },
      dashboardHealth: {
        bodyState: document.body.dataset.uiHealth || null,
        refreshFailures: dashboardRefreshFailures,
        recoveryVisible: dashboardRecoveryVisible,
        lastError: dashboardLastError,
        heartbeat: heartbeatStored.ptDashboardHeartbeat || null,
        recentErrors: currentDashboardErrors.slice(-20),
        historicalErrorCount: historicalDashboardErrors.length,
        historicalErrorVersions: [...new Set(historicalDashboardErrors.map((item) => String(item?.version || 'unknown')))].slice(-10)
      },
      pageTab: pocketTab ? { title: pocketTab.title, url: pocketTab.url } : null,
      state,
      access: { ...access, serverState: undefined },
      serverState,
      autoStatus,
      signalDiagnostics,
      pocketPartnersStatus,
      strategyCalibration: {
        ...strategyCalibration,
        processedDealIds: Array.isArray(strategyCalibration?.processedDealIds) ? strategyCalibration.processedDealIds.slice(-50) : [],
        profiles: strategyCalibration?.profiles || {}
      },
      ledger: {
        ...(ledgerMatchesCurrentAccount() ? ledger : { version: 5, robotOnly: true, accountKey: currentAccountScopeKey(), uid: state?.account?.uid ?? null, mode: state?.account?.mode ?? null, today: {}, summary: {} }),
        closedDeals: scopedLedgerClosedDeals().slice(-100),
        openDeals: currentOpenDeals().slice(-50)
      },
      tradeTelemetry: {
        brokerOpenCount: Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals.length : 0,
        ledgerOpenCount: scopedLedgerOpenDeals().length,
        effectiveOpenCount: currentOpenDeals().length,
        optimisticOpenCount: currentOpenDeals().filter((deal) => deal?.optimistic).length,
        lastOpenSnapshotAt: state?.trades?.lastOpenSnapshotAt || null,
        lastOpenSnapshotCount: finite(state?.trades?.lastOpenSnapshotCount, 0),
        lastTradeResult: state?.trades?.lastResult || null,
        recentTradeEvents: Array.isArray(state?.diagnostics?.recentTradeEvents) ? state.diagnostics.recentTradeEvents.slice(-40) : [],
        tradeSamples: Array.isArray(state?.diagnostics?.tradeSamples) ? state.diagnostics.tradeSamples.slice(-20) : []
      },
      profitStats: profitStatsMatchesCurrentAccount()
        ? profitStats
        : { version: 2, accountKey: currentAccountScopeKey(), uid: state?.account?.uid ?? null, mode: state?.account?.mode ?? null, currency: state?.account?.currency || currentCurrency(), baselineBalance: null, currentBalance: finite(state?.account?.balance), delta: 0, resetReason: 'diagnostic-account-scope', updatedAt: new Date().toISOString() },
      settings,
      selectedAssets: Array.from(selectedAssets || []),
      selectedStrategyIds: Array.isArray(settings?.autoTrade?.strategyIds) && settings.autoTrade.strategyIds.length
        ? [...settings.autoTrade.strategyIds]
        : [settings?.autoTrade?.strategyId].filter(Boolean)
    };
    const diagnostic = redactDiagnosticValue(rawDiagnostic);
    const report = buildDiagnosticReport(diagnostic);
    const blob = new Blob([`\uFEFF${report}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Данные для диагностики разработчику.txt';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('TXT-файл диагностики скачан. Отправьте его разработчику.', 'ok');
  } catch (error) {
    await recordDashboardError(error, 'download-diagnostics').catch(() => null);
    toast(`Не удалось скачать данные диагностики: ${error.message}`, 'error');
  }
}

async function resetProfit() {
  const result = await runtimeMessage({ type: 'PO_RESET_PROFIT_STATS' });
  if (!result?.ok) return toast(result?.error || 'Не удалось сбросить точку отсчёта баланса.', 'error');
  profitStats = result.profitStats || null;
  requestRender(true);
  toast('Точка отсчёта баланса обновлена.', 'ok');
}

async function resetTradeLedger() {
  const result = await runtimeMessage({ type: 'PO_RESET_TRADE_LEDGER' });
  if (!result?.ok) return toast(result?.error || 'Не удалось очистить статистику.', 'error');
  ledger = result.ledger || ledger;
  profitStats = result.profitStats || profitStats;
  if (state?.trades) {
    state = {
      ...state,
      trades: {
        ...state.trades,
        openedCount: 0,
        closedCount: 0,
        successCount: 0,
        failedCount: 0,
        unconfirmedCount: 0,
        openedDeals: [],
        closedDeals: [],
        recentResults: [],
        lastResult: null,
        statistics: { draws: 0, invested: 0, losses: 0, netProfit: 0, open: 0, total: 0, winRate: 0, wins: 0 }
      }
    };
  }
  requestRender(true);
  toast('Локальная статистика сделок очищена. Точка отсчёта PnL обновлена.', 'ok');
}

// Навигация
if ($('sectionSelect') && !$('sectionSelect').querySelector('option[value="referral"]')) {
  const option = document.createElement('option');
  option.value = 'referral';
  option.textContent = 'Реферальная программа';
  $('sectionSelect').append(option);
}
for (const button of document.querySelectorAll('.tab')) button.addEventListener('click', () => setTab(button.dataset.tab));
if ($('sectionSelect')) $('sectionSelect').addEventListener('change', (event) => setTab(event.target.value));
document.querySelectorAll('[data-connection-tab]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.connectionTab !== 'access-status') return setTab(button.dataset.connectionTab);
  const entitlement = currentEntitlement();
  const accessState = String(entitlement.accessState || '').toUpperCase();
  if (['TRIAL_EXPIRED','AFFILIATE_REGISTERED','PREMIUM_PAUSED'].includes(accessState)) {
    openPremiumAccessNotification({ force: true, focusRegistration: accessState !== 'PREMIUM_PAUSED' });
    return;
  }
  const view = accessDisplay(entitlement);
  toast(view.code === 'trial' ? `TRIAL Premium активен. Осталось ${formatTrialRemaining(currentTrialRemaining(entitlement))}.` : view.description, view.code === 'blocked' ? 'error' : 'ok');
}));
setTab(safeSessionGet('poActiveTab') || 'account');

$('connectAccount').addEventListener('click', connectAccount);
$('disconnectAccount').addEventListener('click', disconnectAccount);
// v1.0.50+: external CTA links are real <a target="_blank"> anchors.
// This keeps them clickable even if the MV3 service worker is sleeping or restarting.
$('reloadTerminal').addEventListener('click', async () => {
  const result = await runtimeMessage({ type: 'PO_RELOAD_TAB', tabId: pocketTab?.id });
  toast(result?.ok ? 'Терминал перезагружается. Дождитесь графика и подключитесь заново.' : result?.error || 'Не удалось перезагрузить терминал', result?.ok ? 'ok' : 'error');
});

$('assetSearch').addEventListener('input', renderAssetCatalog);
let lastMarketPeriodChangeAt = 0;

async function resubscribeForAnalysisPeriod(period) {
  if (!pocketTab?.id) return;
  await chrome.tabs.sendMessage(pocketTab.id, { type: 'PT_FORCE_TIMEFRAME_RESUBSCRIBE', period }).catch(() => null);
}

$('marketPeriod').addEventListener('change', async (event) => {
  lastMarketPeriodChangeAt = Date.now();
  const period = Math.max(1, Number(event.target.value) || 60);
  settings.period = period;
  settings.autoTrade = { ...settings.autoTrade, period };
  await saveSettings({ period, autoTrade: settings.autoTrade });
  await resubscribeForAnalysisPeriod(period);
});

// Повторный выбор того же значения в native select не вызывает change.
// На blur повторяем подписку на текущий TF без изменения настроек.
$('marketPeriod').addEventListener('blur', async (event) => {
  if (Date.now() - lastMarketPeriodChangeAt < 700) return;
  const period = Math.max(1, Number(event.target.value) || 60);
  await resubscribeForAnalysisPeriod(period);
});
$('assetCatalog').addEventListener('change', (event) => {
  const input = event.target.closest('input[data-asset]');
  if (input) selectAsset(input.dataset.asset, input.checked);
});
$('assetCatalog').addEventListener('click', (event) => {
  const selectButton = event.target.closest('button[data-select-category]');
  if (selectButton) return selectCategoryAssets(selectButton.dataset.selectCategory, true);
  const clearButton = event.target.closest('button[data-clear-category]');
  if (clearButton) return selectCategoryAssets(clearButton.dataset.clearCategory, false);
  const toggleButton = event.target.closest('button[data-toggle-category]');
  if (toggleButton) {
    const category = toggleButton.dataset.toggleCategory;
    if (collapsedAssetCategories.has(category)) collapsedAssetCategories.delete(category); else collapsedAssetCategories.add(category);
    renderAssetCatalog();
    return;
  }
  const assetButton = event.target.closest('button[data-asset]');
  if (assetButton && !assetButton.disabled) {
    const symbol = assetButton.dataset.asset;
    return selectAsset(symbol, !selectedAssets.has(symbol));
  }
});
$('selectAllAssets')?.addEventListener('click', selectAllAvailableAssets);
$('clearAssets').addEventListener('click', () => {
  selectedAssets.clear();
  settings.selectedAssets = [];
  void chrome.storage.local.set({ poBridgeSettings: settings });
  renderMarket();
});
$('subscribeAssets').addEventListener('click', subscribeSelectedAssets);
$('streamFilter')?.addEventListener('change', renderMarket);
$('streamsPrev')?.addEventListener('click', () => scrollStreamCarousel(-1));
$('streamsNext')?.addEventListener('click', () => scrollStreamCarousel(1));
$('streamsList')?.addEventListener('scroll', updateStreamCarouselControls, { passive: true });
$('streamsList')?.addEventListener('wheel', (event) => {
  const list = $('streamsList');
  if (!list || list.scrollWidth <= list.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);
  const canScroll = event.deltaY > 0 ? list.scrollLeft < maxScroll - 2 : list.scrollLeft > 2;
  if (!canScroll) return;
  event.preventDefault();
  list.scrollLeft += event.deltaY;
}, { passive: false });
window.addEventListener('resize', updateStreamCarouselControls);
async function setServerStrategySelection(strategyId, selected, { notify = true } = {}) {
  let activeId = String(strategyId || '').trim();
  let item = tradeStrategies().find((strategy) => strategy.id === activeId);
  if (!item || strategyLockedForAccess(item)) {
    renderAutoStrategyOptions();
    if (notify) toast('Эта стратегия доступна только в Premium.', 'error');
    return false;
  }
  if (selected && item.custom && !activeId.startsWith('custom-')) {
    const savedId = await ensureCustomStrategyServerSaved(activeId, { notify });
    if (!savedId) {
      renderAutoStrategyOptions();
      return false;
    }
    activeId = savedId;
    item = tradeStrategies().find((strategy) => strategy.id === activeId) || item;
  }

  const current = new Set(
    Array.isArray(settings.autoTrade?.strategyIds) && settings.autoTrade.strategyIds.length
      ? settings.autoTrade.strategyIds.map(String)
      : [settings.autoTrade?.strategyId || settings.activeStrategyId].filter(Boolean).map(String)
  );

  focusedAutoProfileStrategyId = String(activeId);
  if (selected) current.add(String(activeId));
  else current.delete(String(activeId));

  const strategyIds = [...current];
  settings.activeStrategyId = strategyIds[0] || '';
  settings.activeBuiltInStrategy = strategyIds[0] || '';
  settings.autoTrade = { ...settings.autoTrade, strategyIds, strategyId: strategyIds[0] || '', strategyMode: strategyIds.length > 1 ? 'independent' : (settings.autoTrade?.strategyMode || 'best') };

  await saveSettings({
    activeStrategyId: settings.activeStrategyId,
    activeBuiltInStrategy: settings.activeBuiltInStrategy,
    autoTrade: settings.autoTrade,
    strategyCatalogVersion: 3
  });
  renderStrategies();
  renderAutoStrategyOptions();
  updateAutoStrategyExecutionProfileUi();
  if (notify) {
    const compatibility = autoStrategyCompatibility(activeId, autoExecutionSettingsSnapshot(settings.autoTrade || {}), item);
    if (selected && !compatibility.compatible) toast(`${item.title} выбрана, но пока недоступна: ${compatibility.requirement}.`, 'error');
    else toast(selected ? `Добавлена стратегия: ${item.title}` : `Стратегия отключена: ${item.title}`, 'ok');
  }
  return true;
}

function focusAutoStrategyProfile(strategyId) {
  const id = String(strategyId || '').trim();
  if (!id) return;
  focusedAutoProfileStrategyId = id;
  if ($('autoTradeWorkspace')) $('autoTradeWorkspace').dataset.loadedStrategyProfile = '';
  document.querySelectorAll('#autoStrategyChecklist .autoStrategyOption').forEach((item) => {
    const focused = String(item.dataset.autoStrategy || '') === id;
    item.classList.toggle('focused', focused);
    item.setAttribute('aria-current', focused ? 'true' : 'false');
  });
  updateAutoStrategyExecutionProfileUi();
}

$('autoStrategyChecklist')?.addEventListener('click', (event) => {
  const card = event.target.closest('.autoStrategyOption[data-auto-strategy]');
  if (!card) return;
  const strategyId = String(card.dataset.autoStrategy || '');
  const toggle = event.target.closest('.autoStrategyToggle');
  const alreadySelected = card.classList.contains('selected');
  focusAutoStrategyProfile(strategyId);

  // Clicking a selected card only opens its individual settings. Selection is
  // changed explicitly by the right-hand button. Clicking an unselected card
  // performs the natural first action: select it and open its profile.
  if (!toggle && alreadySelected) return;
  const selected = toggle ? !alreadySelected : true;
  card.classList.toggle('selected', selected);
  const stateNode = card.querySelector('.autoStrategyState');
  if (stateNode) {
    stateNode.textContent = selected ? 'Выбрана' : 'Выбрать';
    stateNode.setAttribute('aria-pressed', selected ? 'true' : 'false');
    stateNode.title = selected
      ? uiText('Отключить стратегию', 'Disable strategy')
      : uiText('Добавить стратегию', 'Add strategy');
  }
  void setServerStrategySelection(strategyId, selected, { notify: false }).then((ok) => {
    if (!ok) renderAutoStrategyOptions();
  });
});

$('autoStrategyChecklist')?.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key) || event.target.closest('.autoStrategyToggle')) return;
  const card = event.target.closest('.autoStrategyOption[data-auto-strategy]');
  if (!card) return;
  event.preventDefault();
  card.click();
});

$('autoStrategyMode')?.addEventListener('change', (event) => {
  const mode = ['best', 'independent'].includes(event.target.value) ? event.target.value : 'best';
  // Обновляем локальное состояние до следующего renderAll, иначе ежесекундная
  // перерисовка возвращала select на сохранённое значение «best».
  settings.autoTrade = { ...settings.autoTrade, strategyMode: mode };
  void persistAutoStrategyMode(mode);
});

$('autoCandleOffset')?.addEventListener('change', (event) => {
  const candleOffset = normalizeCandleOffset(event.target.value, settings.autoTrade?.candleMode);
  settings.autoTrade = { ...settings.autoTrade, candleOffset, candleMode: candleOffset === 0 ? 'current' : 'closed' };
  void persistAutoCandleOffset(candleOffset);
});

async function selectServerStrategy(strategyId) {
  focusedAutoProfileStrategyId = String(strategyId || '');
  const current = new Set(
    Array.isArray(settings.autoTrade?.strategyIds) && settings.autoTrade.strategyIds.length
      ? settings.autoTrade.strategyIds.map(String)
      : [settings.autoTrade?.strategyId || settings.activeStrategyId].filter(Boolean).map(String)
  );
  return setServerStrategySelection(strategyId, !current.has(String(strategyId)));
}

$('strategyGrid').addEventListener('click', (event) => {
  const target = event.target.closest('[data-strategy-id]');
  if (!target || target.closest('.strategyCard')?.classList.contains('locked')) return;
  void selectServerStrategy(target.dataset.strategyId || target.closest('.strategyCard')?.dataset.strategyId);
});
$('strategyGrid').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('.strategyCard[data-strategy-id]');
  if (!card || card.classList.contains('locked')) return;
  event.preventDefault();
  void selectServerStrategy(card.dataset.strategyId);
});

$('strategySearch').addEventListener('input', renderStrategies);
$('strategyFilter').addEventListener('change', renderStrategies);
$('openBuilderFromStrategies')?.addEventListener('click', () => { setTab('strategies'); setStrategyPanel('builder'); });

$('tradeStrategyGrid')?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-trade-strategy-id]');
  if (button) void selectServerStrategy(button.dataset.tradeStrategyId);
});



document.querySelectorAll('[data-top-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.topTab)));
document.querySelectorAll('[data-strategy-panel]').forEach((button) => button.addEventListener('click', () => setStrategyPanel(button.dataset.strategyPanel)));
$('createCustomStrategy')?.addEventListener('click', () => { clearBuilder(); setTab('strategies'); setStrategyPanel('builder'); });
document.querySelectorAll('[data-scroll-target]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-scroll-target]').forEach((item) => item.classList.toggle('active', item === button));
  document.getElementById(button.dataset.scrollTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}));
document.querySelectorAll('[data-builder-step-target]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-builder-step-target]').forEach((item) => item.classList.toggle('active', item === button));
  document.getElementById(button.dataset.builderStepTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

function openStrategyFilePicker() { $('strategyJsonFile')?.click(); }
for (const id of ['importStrategyJson','importStrategyFromBuilder','exchangeImportJson']) $(id)?.addEventListener('click', openStrategyFilePicker);
$('strategyJsonFile')?.addEventListener('change', async (event) => {
  try { await handleStrategyFile(event.target.files?.[0]); }
  catch (error) { toast(error?.message || 'Не удалось прочитать JSON.', 'error'); void recordNotification({ kind: 'strategy', title: 'Ошибка импорта', message: error?.message || String(error) }); }
  finally { event.target.value = ''; }
});
for (const id of ['exportAllStrategies','exchangeExportAll']) $(id)?.addEventListener('click', exportAllStrategies);
for (const id of ['exportBuilderStrategy','exchangeExportCurrent']) $(id)?.addEventListener('click', exportBuilderDraft);
$('confirmStrategyImport')?.addEventListener('click', () => void confirmStrategyImport());
$('cancelStrategyImport')?.addEventListener('click', () => { pendingStrategyImport = null; $('strategyImportModal').hidden = true; });
$('strategyImportModal')?.addEventListener('click', (event) => { if (event.target === $('strategyImportModal')) { pendingStrategyImport = null; $('strategyImportModal').hidden = true; } });
$('clearTransferHistory')?.addEventListener('click', async () => { transferHistory = []; await chrome.storage.local.set({ ptStrategyTransferHistory: [] }); renderTransferHistory(); });
$('notificationFilter')?.addEventListener('change', renderNotifications);
$('markNotificationsRead')?.addEventListener('click', async () => { notificationHistory = notificationHistory.map((item) => ({ ...item, read: true })); await chrome.storage.local.set({ ptNotificationHistory: notificationHistory }); renderNotifications(); });
$('clearNotifications')?.addEventListener('click', async () => { notificationHistory = []; await chrome.storage.local.set({ ptNotificationHistory: [] }); renderNotifications(); });

$('saveAutoTrade').addEventListener('click', saveAutoTrade);
$('autoEnabled').addEventListener('change', () => { void handleAutoEnabledChange(); });

for (const id of ['autoAmount','autoBalancePercent','autoMaxAmount','autoRecoveryMultiplier1','autoRecoveryMultiplier2','autoRecoveryMultiplier3','autoRecoveryMultiplier4','autoRecoveryMultiplier5','autoRecoveryMinPayout1','autoRecoveryMinPayout2','autoRecoveryMinPayout3','autoRecoveryMinPayout4','autoRecoveryMinPayout5']) {
  $(id)?.addEventListener('input', renderRecoveryControls);
}

function increaseRecoverySteps(selectId, { enableId = null, max = 5, onMaxMessage = 'Доступно максимум 5 шагов Мартингейла.' } = {}) {
  const select = $(selectId);
  if (!select) return;
  if (enableId && $(enableId)) $(enableId).checked = true;
  const current = Math.min(max, Math.max(1, Number(select.value) || 1));
  if (current >= max) {
    toast(onMaxMessage, 'error');
    return;
  }
  select.value = String(current + 1);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}



// Amount modes are mutually exclusive by design: selecting one always resets
// the inactive value to zero so a stale hidden value can never be used by mistake.
$('autoAmountMode')?.addEventListener('change', () => {
  syncAutoAmountModeUi({ resetInactive: true });
  renderRecoveryControls();
});

// Persist execution controls immediately so the engine and the visible form stay
// synchronized without a separate Save click.
for (const id of [
  'autoAmountMode','autoAmount','autoBalancePercent','autoMaxAmount',
  'autoConcurrent','autoDirection','autoTakeProfit',
  'autoStopLoss','autoMaxTrades','autoMaxLossStreak','autoRecoveryEnabled',
  'autoRecoverySteps','autoRecoveryAfterMax','autoRecoveryFollowSignal','autoOnePerAsset',
  'autoRecoveryMultiplier1',
  'autoRecoveryMultiplier2',
  'autoRecoveryMultiplier3',
  'autoRecoveryMultiplier4',
  'autoRecoveryMultiplier5',
  'autoRecoveryMinPayout1',
  'autoRecoveryMinPayout2',
  'autoRecoveryMinPayout3',
  'autoRecoveryMinPayout4',
  'autoRecoveryMinPayout5'
]) {
  $(id)?.addEventListener('change', () => {
    renderRecoveryControls();
    const profileSensitive = id === 'autoRecoveryEnabled'
      || id === 'autoRecoverySteps';
    if (!profileSensitive) {
      void persistAutoTradeControls();
      return;
    }
    const snapshot = autoExecutionSettingsSnapshot(settings.autoTrade || {});
    settings.autoTrade = {
      ...settings.autoTrade,
      recoveryMode: snapshot.recoveryMode,
      recoverySteps: snapshot.recoverySteps,
      recoveryPlan: snapshot.recoveryPlan,
      recoveryFollowSignal: snapshot.recoveryFollowSignal
    };
    void reconcileAutoStrategyCompatibility({ notify: true, persist: true, clearNoticeWhenValid: true })
      .then(() => persistAutoTradeControls({ notify: false }))
      .catch((error) => toast(error?.message || String(error), 'error'));
  });
}


for (const id of ['autoPeriod', 'autoDuration', 'autoCooldown']) {
  $(id)?.addEventListener('change', () => {
    const strategyId = String(focusedAutoProfileStrategyId || '');
    if (['builtin-trend','builtin-otc','builtin-smart','builtin-ai'].includes(strategyId)) {
      const period = normalizeAnalysisPeriodSeconds($('autoPeriod')?.value, 60);
      const duration = normalizeExpirationSeconds($('autoDuration')?.value, period);
      if (id === 'autoPeriod' && !(period === 5 && duration === 3)) {
        $('autoDuration').value = String(period);
      } else if (id === 'autoDuration' && duration !== period && !(period === 5 && duration === 3)) {
        if (ALLOWED_ANALYSIS_PERIOD_SECONDS.includes(duration)) $('autoPeriod').value = String(duration);
        else {
          $('autoDuration').value = String(period);
          toast('Для этой стратегии TF анализа и экспирация должны совпадать.', 'error');
        }
      }
    }
    const snapshot = autoExecutionSettingsSnapshot(settings.autoTrade || {});
    settings.autoTrade = {
      ...settings.autoTrade,
      strategyProfiles: snapshot.strategyProfiles,
      profileSettingsVersion: 1
    };
    void reconcileAutoStrategyCompatibility({ notify: true, persist: true, clearNoticeWhenValid: true })
      .then(() => persistFocusedAutoStrategyProfile({ notify: false }))
      .catch((error) => toast(error?.message || String(error), 'error'));
  });
}


function showBuilderHelpPopup(kind, anchor) {
  document.querySelector('.builderHelpPopup')?.remove();
  const title = kind === 'group' ? 'Группы A / B / C' : 'Логика условий';
  const body = kind === 'group'
    ? '<b>A</b> — основной сигнал. <b>B</b> — подтверждение. <b>C</b> — фильтр качества. В режиме групп должны сработать все непустые группы, но внутри одной группы достаточно любого условия.'
    : '<b>AND</b> — все условия вместе. <b>OR</b> — любое условие. <b>Баллы</b> — вес условий суммируется. <b>Группы</b> — A AND B AND C, внутри каждой группы OR.';
  const node = document.createElement('div');
  node.className = 'builderHelpPopup';
  node.innerHTML = `<button type="button" aria-label="Закрыть">×</button><h4>${title}</h4><p>${body}</p>`;
  document.body.appendChild(node);
  const rect = anchor?.getBoundingClientRect?.() || { left: 24, top: 80, bottom: 100 };
  const left = Math.min(window.innerWidth - 330, Math.max(12, rect.left));
  const top = Math.min(window.innerHeight - 170, Math.max(12, rect.bottom + 8));
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.querySelector('button')?.addEventListener('click', () => node.remove());
  setTimeout(() => document.addEventListener('click', function closeHelp(event) {
    if (!node.contains(event.target) && !event.target.closest('.miniHelp')) { node.remove(); document.removeEventListener('click', closeHelp, true); }
  }, true), 0);
}

document.addEventListener('click', (event) => {
  const help = event.target?.closest?.('.miniHelp[data-help]');
  if (!help) return;
  event.preventDefault();
  event.stopPropagation();
  showBuilderHelpPopup(help.dataset.help, help);
}, true);

for (const button of document.querySelectorAll('[data-preset]')) button.addEventListener('click', () => applyPreset(button.dataset.preset));
function handleAddRuleButtonEvent(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const now = Date.now();
  if (handleAddRuleButtonEvent.lastAt && now - handleAddRuleButtonEvent.lastAt < 250) return;
  handleAddRuleButtonEvent.lastAt = now;
  addBuilderRule();
}
$('addRule')?.addEventListener('click', handleAddRuleButtonEvent, true);
$('addRule')?.addEventListener('pointerup', handleAddRuleButtonEvent, true);
document.addEventListener('click', (event) => {
  const button = event.target?.closest?.('#addRule,[data-builder-direct-action="add-rule"]');
  if (button) handleAddRuleButtonEvent(event);
}, true);
function handleRuleIndicatorChange(event) {
  const select = event.currentTarget;
  select.dataset.lastValue = select.value || '';
  if ($('rulePeriod')) $('rulePeriod').dataset.autofill = '1';
  if ($('ruleValue')) $('ruleValue').dataset.autofill = '1';
  if ($('ruleParams')) $('ruleParams').dataset.autofill = '1';
  syncRuleDefaultsForIndicator();
}
$('ruleIndicator')?.addEventListener('change', handleRuleIndicatorChange);
$('ruleIndicator')?.addEventListener('input', handleRuleIndicatorChange);
$('candleSeqCount')?.addEventListener('change', updateCandleSequenceDesigner);
$('addCandleSequenceRule')?.addEventListener('click', addCandleSequenceRuleFromUi);
$('candleSeqPresetAcceleration')?.addEventListener('click', () => applyCandleSequencePreset('accelerationSell'));
$('candleSeqPresetAccelerationBuy')?.addEventListener('click', () => applyCandleSequencePreset('accelerationBuy'));
$('candleSeqPresetEngulf')?.addEventListener('click', () => applyCandleSequencePreset('engulfSell'));
$('candleSeqPresetEngulfBuy')?.addEventListener('click', () => applyCandleSequencePreset('engulfBuy'));
updateCandleSequenceDesigner();
$('ruleOperator')?.addEventListener('change', updateRuleComposerPreview);
$('ruleTimeframe')?.addEventListener('change', updateRuleComposerPreview);
$('ruleSource')?.addEventListener('change', syncRuleSourceSelection);
$('ruleSignalMode')?.addEventListener('change', updateRuleComposerPreview);
$('rulePeriod')?.addEventListener('input', () => { $('rulePeriod').dataset.autofill = '0'; updateRuleComposerPreview(); });
$('ruleValue')?.addEventListener('input', () => { $('ruleValue').dataset.autofill = '0'; updateRuleComposerPreview(); });
$('ruleParams')?.addEventListener('input', () => { $('ruleParams').dataset.autofill = '0'; updateRuleComposerPreview(); });
// v1.0.55 constructor hotfix: keep entry-condition controls independent from the indicator select hit area.
['ruleOperator','ruleValue','rulePeriod','ruleWeight','ruleTimeframe','ruleParams','ruleSource','ruleSignalMode','ruleGroup'].forEach((id) => {
  const control = $(id);
  if (control) {
    control.addEventListener('pointerdown', (event) => event.stopPropagation());
    control.addEventListener('click', (event) => event.stopPropagation());
  }
});
document.querySelectorAll('#builderPatterns input[type="checkbox"]').forEach((input) => input.addEventListener('change', () => { refreshBuilderPatternVisuals(); updateBuilderSummary(); }));
refreshBuilderPatternVisuals();
['builderPatternSearchMode','builderPatternLookback','builderPatternTouches','builderPatternTolerance','builderPatternConfirmation','builderPatternStrength','builderPatternFresh','builderPatternRole'].forEach((id) => $(id)?.addEventListener('change', updateBuilderSummary));
$('selectAllPatterns')?.addEventListener('click', () => {
  document.querySelectorAll('#builderPatterns input[type="checkbox"]').forEach((input) => { input.checked = true; });
  refreshBuilderPatternVisuals();
  updateBuilderSummary();
  toast('Все фигуры технического анализа выбраны.', 'ok');
});
$('clearAllPatterns')?.addEventListener('click', () => {
  document.querySelectorAll('#builderPatterns input[type="checkbox"]').forEach((input) => { input.checked = false; });
  refreshBuilderPatternVisuals();
  updateBuilderSummary();
  toast('Фигуры технического анализа очищены.', 'ok');
});
$('clearPatterns')?.addEventListener('click', () => { setBuilderPatterns([]); updateBuilderSummary(); toast('Фигуры сняты.', 'ok'); });
['builderAssetMode'].forEach((id) => $(id)?.addEventListener('change', updateBuilderConditionalFields));
$('validateStrategy').addEventListener('click', () => validateBuilderConfig(builderConfigFromForm(), true));
$('rulesList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-rule]');
  if (!button) return;
  builderRules.splice(Number(button.dataset.removeRule), 1);
  renderRules();
});
$('saveStrategy').addEventListener('click', saveBuilderStrategy);
$('clearBuilder').addEventListener('click', clearBuilder);
$('builderReadyForTester')?.addEventListener('click', () => openSavedStrategyInTester($('builderReadyForTester')?.dataset?.strategyId));
$('savedStrategiesList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-builder-action]');
  if (button) void builderAction(button.dataset.builderAction, button.dataset.id);
});

$('buy')?.addEventListener('click', () => void executeTrade('call'));
$('sell')?.addEventListener('click', () => void executeTrade('put'));
$('cancelTrade')?.addEventListener('click', () => closeConfirmation(false));
$('confirmTrade')?.addEventListener('click', () => closeConfirmation(true));
$('confirmModal')?.addEventListener('click', (event) => { if (event.target === $('confirmModal')) closeConfirmation(false); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('confirmModal') && !$('confirmModal').hidden) closeConfirmation(false); });

$('statusBarVisible').addEventListener('change', (event) => saveSettings({ statusBarVisible: event.target.checked }));
$('tradeResultNotifications')?.addEventListener('change', async (event) => {
  await saveSettings({ tradeResultNotifications: event.target.checked });
  toast(event.target.checked ? 'Уведомления о результатах включены.' : 'Уведомления о результатах выключены.', 'ok');
});
$('statusBarCompact')?.addEventListener('change', (event) => saveSettings({ statusBarCompact: event.target.checked }));
$('currencyOverride').addEventListener('change', (event) => saveSettings({ currencyOverride: event.target.value }));
$('confirmTrades').addEventListener('change', (event) => saveSettings({ confirmTrades: event.target.checked }));
$('profitResetMode').addEventListener('change', async (event) => {
  await saveSettings({ profitResetMode: event.target.value === 'disconnect' ? 'disconnect' : 'daily' });
  setTimeout(refreshState, 250);
  toast('Режим автосброса изменён.', 'ok');
});
$('officialApiSave')?.addEventListener('click', savePocketPartnersFromForm);
$('officialApiConnect')?.addEventListener('click', connectPocketPartnersFromForm);
$('officialApiDisconnect')?.addEventListener('click', disconnectPocketPartnersFromForm);
async function refreshPocketPartnersStatus(silent = true) {
  try {
    const result = await runtimeMessage({ type: 'PT_POCKET_PARTNERS_STATUS' });
    if (result?.ok) {
      pocketPartnersStatus = { settings: result.settings || {}, state: result.state || {} };
      requestRender(true);
      if (!silent) toast('Статус Pocket Partners API обновлён.', 'ok');
    }
    return result;
  } catch (error) {
    if (!silent) toast(error.message || String(error), 'error');
    return null;
  }
}

async function savePocketPartnersFromForm() {
  try {
    const payload = {
      enabled: true,
      executionMode: 'official',
      uid: $('officialApiUid')?.value || '',
      allowRealTrading: $('officialApiAllowReal')?.checked === true
    };
    const tokenValue = String($('officialApiToken')?.value || '').trim();
    if (tokenValue) payload.accessToken = tokenValue;
    const result = await runtimeMessage({ type: 'PT_POCKET_PARTNERS_SAVE', payload });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить настройки API');
    pocketPartnersStatus = { settings: result.settings || {}, state: result.state || {} };
    $('officialApiToken').value = '';
    requestRender(true);
    toast('Настройки Pocket Partners API сохранены.', 'ok');
  } catch (error) {
    toast(error.message || String(error), 'error');
  }
}

async function connectPocketPartnersFromForm() {
  try {
    await savePocketPartnersFromForm();
    const result = await runtimeMessage({ type: 'PT_POCKET_PARTNERS_CONNECT' }, { timeoutMs: 22000 });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось подключить Pocket Partners API');
    await refreshPocketPartnersStatus(true);
    toast('Официальный WebSocket Pocket Option подключён.', 'ok');
  } catch (error) {
    await refreshPocketPartnersStatus(true);
    toast(error.message || String(error), 'error');
  }
}

async function disconnectPocketPartnersFromForm() {
  try {
    const result = await runtimeMessage({ type: 'PT_POCKET_PARTNERS_DISCONNECT' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось отключить API');
    await refreshPocketPartnersStatus(true);
    toast('Официальный WebSocket Pocket Option отключён до следующего подключения.', 'ok');
  } catch (error) {
    toast(error.message || String(error), 'error');
  }
}

const syncServerNow = async () => {
  if (serverSyncBusy) return;
  serverSyncBusy = true;
  for (const id of ['syncServer', 'settingsSyncServer', 'quickPremiumStatus']) {
    if ($(id)) $(id).disabled = true;
  }
  try {
    const result = await runtimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: true });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось проверить сервер');
    serverState = result.serverState || serverState;
    toast('Серверный статус обновлён.', 'ok');
    await refreshState();
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    serverSyncBusy = false;
    for (const id of ['syncServer', 'settingsSyncServer', 'quickPremiumStatus']) {
      if ($(id)) $(id).disabled = false;
    }
  }
};
$('syncServer')?.addEventListener('click', syncServerNow);
$('settingsSyncServer').addEventListener('click', syncServerNow);



function setPremiumRegistrationState(label = 'ГОТОВО', status = '') {
  const el = $('premiumRegistrationStatus');
  if (!el) return;
  el.textContent = String(label || 'ГОТОВО');
  el.classList.remove('ok', 'warn', 'bad', 'on', 'off', 'reconnecting');
  const normalized = String(status || '').toLowerCase();
  if (normalized) el.classList.add(normalized);
  if (['on', 'ok', 'opened', 'ready'].includes(normalized)) el.classList.add('ok');
  if (['error', 'bad', 'fail', 'failed'].includes(normalized)) el.classList.add('bad');
  if (['reconnecting', 'loading', 'pending'].includes(normalized)) el.classList.add('warn');
}

// ===================== Pocket TRADE ROBOT Remote Control v2.0.37 =====================
let remoteControlState = null;
let remoteControlBusy = false;

function remoteControlAllowed(remote = remoteControlState || {}) {
  const entitlement = remote?.entitlement || access?.entitlement || {};
  return Boolean(entitlement.premium || entitlement.remoteControl || entitlement.features?.remoteControl);
}

function humanRemoteControlError(value = '') {
  const code = String(value || '').trim();
  const messages = {
    MAIN_SESSION_INSTALLATION_MISMATCH: 'Серверная сессия была создана для другой установки Chrome. Выполнена повторная привязка; повторите включение.',
    MAIN_SESSION_TOKEN_INVALID: 'Серверная сессия недействительна. Переподключите Pocket Option и повторите включение.',
    MAIN_SESSION_TOKEN_MISSING: 'Серверная сессия не получена. Проверьте подключение Pocket Option.',
    REMOTE_CONTROL_REQUIRES_PREMIUM_OR_MODULE: 'Для Remote Control нужен TRIAL, Premium или отдельный модуль.',
    REMOTE_TIMEOUT_15000MS: 'Remote-сервер не ответил за 15 секунд.',
    REMOTE_ENABLE_FAILED: 'Remote-сервер не подтвердил включение.',
    INVALID_UID_OR_PASSWORD: 'UID или Remote password не найден.',
    REMOTE_UID_MISMATCH: 'Remote Control привязан к другому UID. Выключите и включите его заново для текущего аккаунта.',
    remote_auth_missing: 'Не найдены сохранённые данные Remote Control. Включите Remote Control заново.'
  };
  return messages[code] || code;
}

function remoteAllowedNotice(remote) {
  if (remoteControlAllowed(remote)) return 'Remote Control активен: управление DEMO и REAL доступно при открытом терминале Pocket Option.';
  return 'Remote Control закрыт. Нужен TRIAL, Premium или отдельная подписка Remote Control.';
}

async function loadRemoteControlState({ silent = false } = {}) {
  const response = await runtimeMessage({ type: 'PT_REMOTE_GET_STATE' }, { timeoutMs: 7000 }).catch((error) => ({ ok:false, error:error?.message || String(error) }));
  if (response?.remote) remoteControlState = response.remote;
  if (!silent && response?.error) toast(response.error, 'error');
  renderRemoteControl();
  return remoteControlState;
}

function renderRemoteControl() {
  const remote = remoteControlState || {};
  const allowed = remoteControlAllowed(remote);
  const enabled = Boolean(remote.enabled);
  const errorText = humanRemoteControlError(remote.lastError || '');
  const lastAckMs = Date.parse(remote.lastStatusAckAt || remote.lastStatusPushAt || '');
  const syncAgeMs = Number.isFinite(lastAckMs) ? Math.max(0, Date.now() - lastAckMs) : Infinity;
  const liveSynced = enabled && syncAgeMs <= 60000 && !errorText;
  if ($('remoteUid')) $('remoteUid').textContent = remote.uid || state?.account?.uid || '—';
  if ($('remotePassword')) $('remotePassword').textContent = enabled && remote.password ? remote.password : 'Включите Remote Control';
  if ($('remoteStatusTag')) {
    const status = remoteControlBusy ? 'CONNECTING' : enabled ? (liveSynced ? 'ONLINE' : 'SYNC') : errorText ? 'ERROR' : 'OFF';
    $('remoteStatusTag').textContent = status;
    $('remoteStatusTag').classList.remove('ok', 'bad', 'warn');
    $('remoteStatusTag').classList.toggle('ok', liveSynced && !remoteControlBusy);
    $('remoteStatusTag').classList.toggle('warn', remoteControlBusy || (enabled && !liveSynced));
    $('remoteStatusTag').classList.toggle('bad', Boolean(errorText) && !enabled && !remoteControlBusy);
  }
  if ($('remoteMode')) $('remoteMode').textContent = state?.account?.mode || '—';
  if ($('remoteBalance')) $('remoteBalance').textContent = formatMoney(state?.account?.balance, currentCurrency());
  if ($('remoteAuto')) $('remoteAuto').textContent = settings.autoTrade?.enabled ? 'Включена' : 'Выключена';
  if ($('remoteAssets')) $('remoteAssets').textContent = String(selectedAssets.size || settings.selectedAssets?.length || 0);
  const strategyIds = Array.isArray(settings.autoTrade?.strategyIds) && settings.autoTrade.strategyIds.length ? settings.autoTrade.strategyIds : [settings.autoTrade?.strategyId].filter(Boolean);
  if ($('remoteStrategies')) $('remoteStrategies').textContent = strategyIds.length ? strategyIds.join(', ') : '—';
  if ($('remoteServer')) $('remoteServer').textContent = isLocalExpansionMode() ? 'disabled' : remote.serverOnline || serverState?.online ? 'online' : 'offline';
  if ($('remoteToggle')) {
    $('remoteToggle').checked = enabled;
    $('remoteToggle').disabled = remoteControlBusy || (!allowed && !enabled);
    $('remoteToggle').setAttribute('aria-busy', remoteControlBusy ? 'true' : 'false');
  }
  if ($('remoteToggleLabel')) $('remoteToggleLabel').textContent = remoteControlBusy ? '...' : enabled ? 'ВКЛ' : 'ВЫКЛ';
  if ($('remoteSwitchHint')) $('remoteSwitchHint').textContent = remoteControlBusy
    ? (enabled ? 'Отключение на сервере…' : 'Регистрация UID и пароля на сервере…')
    : enabled ? (liveSynced
        ? 'Онлайн-синхронизация активна. Баланс и статусы передаются в кабинет автоматически.'
        : errorText ? `Синхронизация ожидает восстановления: ${errorText}` : 'Remote Control включён. Ожидается подтверждение онлайн-синхронизации…')
      : allowed ? 'Включение регистрирует UID и пароль на Remote-сервере.'
        : 'Remote Control недоступен для текущего тарифа.';
  if ($('remoteCopyPassword')) $('remoteCopyPassword').disabled = remoteControlBusy || !enabled || !remote.password;
  if ($('remoteRotatePassword')) $('remoteRotatePassword').disabled = remoteControlBusy || !enabled;
  if ($('remoteOpenCabinet')) $('remoteOpenCabinet').disabled = remoteControlBusy;
  if ($('remoteAccessNotice')) {
    $('remoteAccessNotice').textContent = errorText
      ? `Последняя ошибка: ${errorText}`
      : remoteAllowedNotice(remote);
    $('remoteAccessNotice').classList.toggle('remoteNoticeError', Boolean(errorText));
  }
}

async function enableRemoteControlFromUi() {
  remoteControlBusy = true;
  if (remoteControlState) remoteControlState = { ...remoteControlState, lastError: null };
  renderRemoteControl();
  try {
    const result = await runtimeMessage({ type: 'PT_REMOTE_ENABLE' }, { timeoutMs: 22000 });
    if (!result?.ok) throw new Error(result?.error || 'REMOTE_ENABLE_FAILED');
    if (result?.local) remoteControlState = { ...(remoteControlState || {}), ...result.local };
    await loadRemoteControlState({ silent: true });
    if (!remoteControlState?.enabled) throw new Error(remoteControlState?.lastError || 'REMOTE_ENABLE_NOT_CONFIRMED');
    toast('Remote Control включён. UID и пароль зарегистрированы на сервере.', 'ok');
  } catch (error) {
    await loadRemoteControlState({ silent: true }).catch(() => null);
    toast(humanRemoteControlError(error.message || String(error)), 'error');
    throw error;
  } finally {
    remoteControlBusy = false;
    renderRemoteControl();
  }
}

async function rotateRemotePasswordFromUi() {
  remoteControlBusy = true;
  renderRemoteControl();
  try {
    const result = await runtimeMessage({ type: 'PT_REMOTE_ROTATE_PASSWORD' }, { timeoutMs: 22000 });
    if (!result?.ok) throw new Error(result?.error || 'REMOTE_ROTATE_FAILED');
    if (result?.local) remoteControlState = { ...(remoteControlState || {}), ...result.local };
    await loadRemoteControlState({ silent: true });
    if (!remoteControlState?.enabled || !remoteControlState?.password) throw new Error('REMOTE_ROTATE_NOT_CONFIRMED');
    toast('Новый Remote password создан и подтверждён сервером.', 'ok');
  } catch (error) {
    await loadRemoteControlState({ silent: true }).catch(() => null);
    toast(humanRemoteControlError(error.message || String(error)), 'error');
  } finally {
    remoteControlBusy = false;
    renderRemoteControl();
  }
}

async function copyRemotePassword() {
  const password = remoteControlState?.enabled ? remoteControlState?.password : '';
  if (!password) return toast('Сначала включите Remote Control.', 'error');
  await navigator.clipboard?.writeText(password).catch(() => null);
  toast('Пароль скопирован.', 'ok');
}

async function disableRemoteControlFromUi() {
  remoteControlBusy = true;
  renderRemoteControl();
  try {
    const result = await runtimeMessage({ type: 'PT_REMOTE_DISABLE' }, { timeoutMs: 16000 });
    if (!result?.ok) throw new Error(result?.error || 'REMOTE_DISABLE_FAILED');
    if (result?.local) remoteControlState = { ...(remoteControlState || {}), ...result.local };
    await loadRemoteControlState({ silent: true });
    toast(result?.warning ? `Remote Control отключён локально. Сервер: ${humanRemoteControlError(result.warning)}` : 'Remote Control отключён.', result?.warning ? 'error' : 'ok');
  } catch (error) {
    await loadRemoteControlState({ silent: true }).catch(() => null);
    toast(humanRemoteControlError(error.message || String(error)), 'error');
    throw error;
  } finally {
    remoteControlBusy = false;
    renderRemoteControl();
  }
}

async function toggleRemoteControlFromUi(event) {
  const requested = Boolean(event?.currentTarget?.checked);
  try {
    if (requested) await enableRemoteControlFromUi();
    else await disableRemoteControlFromUi();
  } catch {
    // renderRemoteControl restores the server-confirmed state after a failed request.
  }
}


$('openSupport').addEventListener('click', () => runtimeMessage({ type: 'PT_OPEN_SUPPORT' }).catch(() => null));
$('settingsSupport').addEventListener('click', () => runtimeMessage({ type: 'PT_OPEN_SUPPORT' }).catch(() => null));

function showPremiumRegistration() {
  openPremiumAccessNotification({ force: true, focusRegistration: true });
}

const PREMIUM_REGISTRATION_CONSENTS = ['premiumAdult','premiumPocketOffer','premiumTerms','premiumPrivacy','premiumAffiliate'];

function premiumRegistrationConsentsAccepted() {
  return PREMIUM_REGISTRATION_CONSENTS.every((id) => Boolean($(id)?.checked));
}

function renderPremiumAffiliatePrepared(prepared = premiumAffiliatePrepared) {
  premiumAffiliatePrepared = prepared?.registrationUrl && prepared?.clickId ? prepared : null;
  const generated = Boolean(premiumAffiliatePrepared);
  const accepted = premiumRegistrationConsentsAccepted();
  const panel = $('premiumGeneratedLink');
  if (panel) panel.hidden = !generated;
  if ($('premiumGeneratedClickId')) $('premiumGeneratedClickId').textContent = generated ? premiumAffiliatePrepared.clickId : '—';
  if ($('premiumGeneratedUrl')) $('premiumGeneratedUrl').value = generated ? premiumAffiliatePrepared.registrationUrl : '';
  if ($('premiumManualRegistrationLink')) {
    $('premiumManualRegistrationLink').hidden = true;
    if (generated) $('premiumManualRegistrationLink').href = premiumAffiliatePrepared.registrationUrl;
    else $('premiumManualRegistrationLink').removeAttribute('href');
  }
  if ($('premiumOpenRegistration')) $('premiumOpenRegistration').disabled = !generated || !accepted;
  if ($('checkPremiumActivation')) $('checkPremiumActivation').disabled = !generated || !accepted;
  const statusText = String($('premiumRegistrationStatus')?.textContent || '').trim().toUpperCase();
  if (generated && !['ОТКРЫТО','ПРОВЕРЕНО','ПРОВЕРЯЮ…','ОТКРЫВАЮ…'].includes(statusText)) setPremiumRegistrationState('ССЫЛКА ГОТОВА', 'on');
}

async function loadPremiumAffiliatePrepared() {
  const result = await runtimeMessage({ type: 'PT_GET_AFFILIATE_PREPARED' }).catch(() => null);
  renderPremiumAffiliatePrepared(result?.ok ? result.prepared : null);
}

function updatePremiumConsentState() {
  const accepted = premiumRegistrationConsentsAccepted();
  const selected = PREMIUM_REGISTRATION_CONSENTS.filter((id) => Boolean($(id)?.checked)).length;
  const selectAll = $('premiumSelectAll');
  if (selectAll) {
    selectAll.checked = accepted;
    selectAll.indeterminate = selected > 0 && !accepted;
    selectAll.setAttribute('aria-checked', selectAll.indeterminate ? 'mixed' : (accepted ? 'true' : 'false'));
  }
  $('premiumRegistrationCard')?.classList.toggle('consentsReady', accepted);
  const generateButton = $('premiumGenerateRegistration');
  if (generateButton) generateButton.disabled = !accepted;
  if (accepted && $('premiumConsentNotice')) $('premiumConsentNotice').hidden = true;
  renderPremiumAffiliatePrepared(premiumAffiliatePrepared);
  return accepted;
}

function showPremiumConsentWarning() {
  const warning = $('premiumConsentNotice');
  if (warning) warning.hidden = false;
  const firstUnchecked = PREMIUM_REGISTRATION_CONSENTS.map((id) => $(id)).find((input) => input && !input.checked);
  const target = firstUnchecked?.closest('.legalCheck') || $('premiumRegistrationForm') || $('premiumRegistrationCard');
  target?.classList.add('needsAttention');
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    firstUnchecked?.focus({ preventScroll: true });
    target?.classList.remove('needsAttention');
  }, 450);
  toast('Сначала примите все 5 условий регистрации.');
}

async function generateAffiliateRegistrationFromUi() {
  if (!updatePremiumConsentState()) {
    showPremiumConsentWarning();
    return;
  }
  const button = $('premiumGenerateRegistration');
  if (button) { button.disabled = true; button.classList.add('isBusy'); }
  setPremiumRegistrationState('ГЕНЕРАЦИЯ…', 'reconnecting');
  const result = await runtimeMessage({ type: 'PT_GENERATE_AFFILIATE_PUBLIC', locale: window.PTI18n?.locale || 'ru' }).catch((error) => ({ ok:false, error:error?.message || String(error) }));
  if (button) { button.disabled = false; button.classList.remove('isBusy'); }
  if (!result?.ok || !result.registrationUrl || !result.clickId) {
    setPremiumRegistrationState('ОШИБКА');
    toast(result?.error || 'Не удалось сгенерировать партнёрскую ссылку.', 'error');
    return;
  }
  renderPremiumAffiliatePrepared(result);
  $('premiumGeneratedLink')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Персональная ссылка и уникальный click ID сгенерированы. Теперь откройте регистрацию.', 'ok');
}

async function openGeneratedAffiliateRegistrationFromUi() {
  if (!updatePremiumConsentState()) {
    showPremiumConsentWarning();
    return;
  }
  if (!premiumAffiliatePrepared?.registrationUrl) {
    toast('Сначала сгенерируйте персональную партнёрскую ссылку.', 'error');
    return;
  }
  const button = $('premiumOpenRegistration');
  if (button) { button.disabled = true; button.classList.add('isBusy'); }
  setPremiumRegistrationState('ОТКРЫВАЮ…', 'reconnecting');
  const result = await runtimeMessage({ type: 'PT_OPEN_AFFILIATE_PREPARED' }).catch((error) => ({ ok:false, error:error?.message || String(error) }));
  if (button) { button.disabled = false; button.classList.remove('isBusy'); }
  if (!result?.ok) {
    setPremiumRegistrationState('ОШИБКА');
    toast(result?.error || 'Не удалось открыть партнёрскую ссылку.', 'error');
    return;
  }
  const manualLink = $('premiumManualRegistrationLink');
  if (manualLink) {
    manualLink.href = premiumAffiliatePrepared.registrationUrl;
    manualLink.hidden = false;
  }
  setPremiumRegistrationState('ОТКРЫТО', 'on');
  toast('Официальная страница регистрации Pocket Option открыта в новой вкладке.', 'ok');
}

async function checkPremiumActivationFromUi() {
  if (!updatePremiumConsentState()) {
    showPremiumConsentWarning();
    return;
  }
  if (!premiumAffiliatePrepared?.registrationUrl) {
    toast('Сначала сгенерируйте персональную партнёрскую ссылку.', 'error');
    return;
  }
  const button = $('checkPremiumActivation');
  if (button) { button.disabled = true; button.classList.add('isBusy'); }
  setPremiumRegistrationState('ПРОВЕРЯЮ…', 'reconnecting');
  try {
    await syncServerNow();
    setPremiumRegistrationState('ПРОВЕРЕНО', 'on');
  } catch (error) {
    setPremiumRegistrationState('ОШИБКА');
    toast(error?.message || String(error), 'error');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('isBusy'); }
    updatePremiumConsentState();
  }
}

async function copyPremiumValue(value, successText) {
  const text = String(value || '').trim();
  if (!text) {
    toast('Сначала сгенерируйте персональную ссылку.', 'error');
    return;
  }
  await navigator.clipboard.writeText(text).catch(() => null);
  toast(successText, 'ok');
}

$('premiumGenerateRegistration')?.addEventListener('click', generateAffiliateRegistrationFromUi);
$('premiumOpenRegistration')?.addEventListener('click', openGeneratedAffiliateRegistrationFromUi);
$('checkPremiumActivation')?.addEventListener('click', checkPremiumActivationFromUi);
$('premiumCopyClickId')?.addEventListener('click', () => copyPremiumValue(premiumAffiliatePrepared?.clickId, 'Уникальный click ID скопирован.'));
$('premiumCopyRegistrationUrl')?.addEventListener('click', () => copyPremiumValue(premiumAffiliatePrepared?.registrationUrl, 'Партнёрская ссылка скопирована.'));
$('premiumAccessClose')?.addEventListener('click', closePremiumAccessNotification);
$('premiumOpenReferral')?.addEventListener('click', () => setTab('referral'));
$('trialHeaderIndicator')?.addEventListener('click', () => {
  const entitlement = currentEntitlement();
  const accessState = String(entitlement.accessState || '').toUpperCase();
  if (['TRIAL_EXPIRED','AFFILIATE_REGISTERED','PREMIUM_PAUSED'].includes(accessState)) {
    openPremiumAccessNotification({ force: true, focusRegistration: accessState !== 'PREMIUM_PAUSED' });
    return;
  }
  const view = accessDisplay(entitlement);
  toast(view.code === 'trial' ? `TRIAL Premium активен. Осталось ${formatTrialRemaining(currentTrialRemaining(entitlement))}.` : view.description, 'ok');
});
$('premiumSelectAll')?.addEventListener('change', (event) => {
  const checked = Boolean(event.currentTarget.checked);
  PREMIUM_REGISTRATION_CONSENTS.forEach((id) => { const input = $(id); if (input) input.checked = checked; });
  updatePremiumConsentState();
});
PREMIUM_REGISTRATION_CONSENTS.forEach((id) => $(id)?.addEventListener('change', updatePremiumConsentState));
updatePremiumConsentState();
void loadPremiumAffiliatePrepared();

$('getAffiliatePremium')?.addEventListener('click', showPremiumRegistration);
$('quickAffiliatePremium')?.addEventListener('click', showPremiumRegistration);
$('quickPremiumStatus')?.addEventListener('click', syncServerNow);
$('openPremiumFromAccount')?.addEventListener('click', showPremiumRegistration);
$('planCard')?.addEventListener('click', showPremiumRegistration);
$('builderPremiumButton').addEventListener('click', showPremiumRegistration);
$('contactsSupport')?.addEventListener('click', () => runtimeMessage({ type: 'PT_OPEN_SUPPORT' }).catch(() => null));
$('contactsCopyInfo')?.addEventListener('click', downloadDiagnostics);
$('connectionDownloadDiagnostics')?.addEventListener('click', downloadDiagnostics);
$('connectionSupport')?.addEventListener('click', () => runtimeMessage({ type: 'PT_OPEN_SUPPORT' }).catch(() => null));
async function handleActivateTrial() {
  if (trialActivationBusy) return;
  trialActivationBusy = true;
  for (const id of ['activateTrial', 'quickActivateTrial']) if ($(id)) $(id).disabled = true;
  try {
    const result = await runtimeMessage({ type: 'PT_ACTIVATE_TRIAL' });
    if (!result?.ok) throw new Error(result?.error || 'Trial не активирован');
    serverState = result.serverState || serverState;
    toast('TRIAL Premium активируется автоматически при первом подключении UID.', 'ok');
    await refreshState();
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    trialActivationBusy = false;
    for (const id of ['activateTrial', 'quickActivateTrial']) if ($(id)) $(id).disabled = false;
  }
}
$('activateTrial')?.addEventListener('click', handleActivateTrial);
$('quickActivateTrial')?.addEventListener('click', handleActivateTrial);

$('remoteToggle')?.addEventListener('change', toggleRemoteControlFromUi);
$('remoteCopyPassword')?.addEventListener('click', copyRemotePassword);
$('remoteRotatePassword')?.addEventListener('click', rotateRemotePasswordFromUi);
$('remoteOpenCabinet')?.addEventListener('click', () => runtimeMessage({ type: 'PT_REMOTE_OPEN' }).catch((error) => toast(error.message || String(error), 'error')));
$('remotePushStatus')?.addEventListener('click', async () => { try { await runtimeMessage({ type: 'PT_REMOTE_PUSH_STATUS' }, { timeoutMs: 15000 }); toast('Статус Remote Control обновлён.', 'ok'); } catch (error) { toast(error.message || String(error), 'error'); } });
$('remoteDisable')?.addEventListener('click', disableRemoteControlFromUi);
$('referralRefresh')?.addEventListener('click', () => refreshReferralProgram({ silent: false }));
$('referralCopy')?.addEventListener('click', () => copyReferralLink());
$('referralShare')?.addEventListener('click', shareReferralLink);
window.addEventListener('pt-language-changed', () => {
  if (referralProgramState) renderReferralProgram(referralProgramState);
});
setTimeout(() => loadRemoteControlState({ silent: true }).catch(() => null), 1600);
setInterval(() => loadRemoteControlState({ silent: true }).catch(() => null), 10000);

$('checkUpdate').addEventListener('click', async () => { try { const result = await runtimeMessage({ type: 'PT_CHECK_UPDATE' }); if (result?.release) serverState = { ...(serverState || {}), release: result.release }; renderServerPanels(); toast('Проверка обновлений завершена.', 'ok'); } catch (error) { toast(error.message || String(error), 'error'); } });
$('openUpdate').addEventListener('click', async () => { const result = await runtimeMessage({ type: 'PT_OPEN_UPDATE' }).catch((error) => ({ ok: false, error: error.message })); if (!result?.ok) toast(result?.error || 'Ссылка обновления недоступна', 'error'); });
$('openAdmin')?.addEventListener('click', () => runtimeMessage({ type: 'PT_OPEN_ADMIN' }).catch(() => null));
$('resetProfitStats').addEventListener('click', resetProfit);
$('resetTradeLedger').addEventListener('click', resetTradeLedger);
$('settingsSupportMain').addEventListener('click', () => runtimeMessage({ type: 'PT_OPEN_SUPPORT' }).catch(() => null));
$('copySupportInfo').addEventListener('click', downloadDiagnostics);
if ($('deleteAccountData')) $('deleteAccountData').addEventListener('click', async () => {
  const uid = String(state?.account?.uid || serverState?.pocketUid || '').trim();
  if (!uid) {
    toast('Сначала подключите аккаунт, данные которого нужно удалить.', 'error');
    return;
  }
  const first = window.confirm('Удалить данные аккаунта?\n\nБудут удалены серверные данные, лицензии, устройства, история сигналов/сделок и локальные настройки расширения. Действие нельзя отменить.');
  if (!first) return;
  const typed = window.prompt(`Для подтверждения введите Pocket Option UID: ${uid}`);
  if (String(typed || '').trim() !== uid) {
    toast('Удаление отменено: UID не совпал.', 'error');
    return;
  }
  try {
    const response = await runtimeMessage({ type: 'PT_DELETE_ACCOUNT_DATA' });
    if (!response?.ok || !response?.result?.deleted) throw new Error(response?.error || 'Сервер не подтвердил удаление');
    toast(`Данные удалены. Код подтверждения: ${response.result.deletionReference || '—'}`, 'ok');
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    toast(error?.message || String(error), 'error');
  }
});



$('testerStrategySearch')?.addEventListener('input', (event) => { testerStrategySearchQuery = String(event.target.value || ''); renderTesterStrategyOptions(); });
$('testerStrategyGrid')?.addEventListener('change', (event) => {
  if (event.target.closest('input[data-tester-strategy]')) syncTesterStrategySelectFromCards();
});
$('testerStrategyGrid')?.addEventListener('click', (event) => {
  const card = event.target.closest('.testerStrategyCard');
  if (!card) return;
  setTimeout(syncTesterStrategySelectFromCards, 0);
});
$('testerSelectAllStrategies')?.addEventListener('click', () => {
  document.querySelectorAll('input[data-tester-strategy]').forEach((item) => { item.checked = true; });
  syncTesterStrategySelectFromCards();
});
$('testerClearStrategies')?.addEventListener('click', () => {
  document.querySelectorAll('input[data-tester-strategy]').forEach((item) => { item.checked = false; });
  syncTesterStrategySelectFromCards();
});
$('testerAssetSearch')?.addEventListener('input', (event) => { testerAssetSearchQuery = String(event.target.value || ''); renderTesterAssetCatalog(); });
$('testerUseMarketAssets')?.addEventListener('click', () => {
  const bestMarket = testerSelectableAssets(null, { onlyMarket: true });
  const bestAll = testerSelectableAssets();
  setTesterAssetsBest((bestMarket.length ? bestMarket : bestAll).slice(0, TESTER_MAX_ASSETS));
});
$('testerSelectAllAssets')?.addEventListener('click', () => {
  setTesterAssetsBest(testerSelectableAssets().slice(0, TESTER_MAX_ASSETS));
});
$('testerClearAssets')?.addEventListener('click', () => {
  testerAssetsExplicitlyCleared = true;
  testerSelectedAssets.clear();
  syncTesterAssetsInput();
  renderTesterAssetCatalog();
});
$('testerAssetCatalog')?.addEventListener('click', (event) => {
  const selectCategory = event.target.closest('[data-tester-select-category]');
  const clearCategory = event.target.closest('[data-tester-clear-category]');
  const toggleCategory = event.target.closest('[data-tester-toggle-category]');
  if (selectCategory || clearCategory) {
    const category = (selectCategory || clearCategory).dataset.testerSelectCategory || (selectCategory || clearCategory).dataset.testerClearCategory;
    const members = testerSelectableAssets(category).map((asset) => asset.symbol);
    if (selectCategory) {
      testerAssetsExplicitlyCleared = false;
      for (const symbol of members) {
        if (testerSelectedAssets.size >= TESTER_MAX_ASSETS) break;
        testerSelectedAssets.add(symbol);
      }
      if (testerSelectedAssets.size >= TESTER_MAX_ASSETS) toast(`Выбрано максимум ${TESTER_MAX_ASSETS} валютных пар за один проход Strategy Tester.`, 'ok');
    } else {
      const categoryMembers = testerAssetUniverse().filter((asset) => (asset.category || (/_otc$/i.test(asset.symbol) ? 'OTC / Прочее' : 'Прочее')) === category).map((asset) => asset.symbol);
      for (const symbol of categoryMembers) testerSelectedAssets.delete(symbol);
    }
    syncTesterAssetsInput();
    renderTesterAssetCatalog();
    return;
  }
  if (toggleCategory) {
    const section = toggleCategory.closest('.testerAssetGroup');
    section?.classList.toggle('collapsed');
    return;
  }
  const item = event.target.closest('[data-tester-asset]');
  if (!item || item.disabled || item.classList.contains('disabled')) return;
  const symbol = item.dataset.testerAsset;
  if (testerSelectedAssets.has(symbol)) testerSelectedAssets.delete(symbol);
  else {
    testerAssetsExplicitlyCleared = false;
    if (testerSelectedAssets.size >= TESTER_MAX_ASSETS) {
      toast(`Для стабильного расчёта Strategy Tester можно выбрать максимум ${TESTER_MAX_ASSETS} валютных пар за один запуск.`, 'error');
      return;
    }
    testerSelectedAssets.add(symbol);
  }
  syncTesterAssetsInput();
  renderTesterAssetCatalog();
});
function updateTesterChoice(event, name, rootId) {
  if (!event.target.closest(`input[name="${name}"]`)) return;
  updateTesterPillStates(rootId);
}
$('testerTimeframes')?.addEventListener('change', (event) => updateTesterChoice(event, 'testerTf', 'testerTimeframes'));
$('testerExpirations')?.addEventListener('change', (event) => updateTesterChoice(event, 'testerExp', 'testerExpirations'));
$('testerHistoryLimit')?.addEventListener('change', () => normalizedTesterHistoryLimit(true));

$('testerCollectHistory')?.addEventListener('click', async () => {
  if (!beginTesterBusy(uiText('Подготавливаем загрузку истории…', 'Preparing history download…'))) {
    toast(uiText('Дождитесь завершения текущей операции тестера.', 'Wait for the current tester operation to finish.'), 'info');
    return;
  }
  try {
    await collectTesterHistoryFromUi();
    finishTesterBusy(testerBusyMessage, 'ok');
  } catch (error) {
    const message = error.message || String(error);
    finishTesterBusy(message, 'error');
    toast(message, 'error');
  }
});
$('testerRun')?.addEventListener('click', async () => {
  if (!beginTesterBusy(uiText('Подготавливаем длительный расчёт…', 'Preparing the long calculation…'))) {
    toast(uiText('Дождитесь завершения текущей операции тестера.', 'Wait for the current tester operation to finish.'), 'info');
    return;
  }
  try {
    await runStrategyTesterFromUi();
    finishTesterBusy(testerBusyMessage, 'ok');
  } catch (error) {
    const message = error.message || String(error);
    finishTesterBusy(message, 'error');
    toast(message, 'error');
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  let shouldRender = false;
  if (changes.ptLegalConsent) {
    legalConsentAccepted = isCurrentLegalConsent(changes.ptLegalConsent.newValue);
    setLegalConsentVisible(!legalConsentAccepted);
    if (!legalConsentAccepted) refreshLegalConsentControls();
  }
  if (changes.poBridgeSettings) {
    settings = mergeSettings(DEFAULT_SETTINGS, changes.poBridgeSettings.newValue || {});
    selectedAssets = new Set(cleanAssetSelection(settings.selectedAssets));
    inputsReady = false;
    applyInterfaceDensity();
    shouldRender = true;
  }
  if (changes.poProfitStats) { profitStats = changes.poProfitStats.newValue || null; shouldRender = true; }
  if (changes.poBridgeState) { state = changes.poBridgeState.newValue || state; shouldRender = true; }
  if (changes.poTradeLedger) { ledger = changes.poTradeLedger.newValue || ledger; shouldRender = true; }
  if (changes.poAutoTradeStatus) { autoStatus = changes.poAutoTradeStatus.newValue || null; shouldRender = true; }
  if (changes.ptServerState) {
    serverState = changes.ptServerState.newValue || null;
    access = reconcileAccessWithServerState(access, serverState);
    shouldRender = true;
  }
  if (changes.ptSignalDiagnostics) { signalDiagnostics = changes.ptSignalDiagnostics.newValue || null; shouldRender = true; }
  if (changes.ptStrategyCalibration) { strategyCalibration = changes.ptStrategyCalibration.newValue || strategyCalibration; shouldRender = true; }
  if (changes.ptAccessNotification) {
    accessNotification = changes.ptAccessNotification.newValue || null;
    showAccessNotification(accessNotification);
    shouldRender = true;
  }
  if (changes.ptNotificationHistory) {
    const previousIds = new Set((Array.isArray(changes.ptNotificationHistory.oldValue) ? changes.ptNotificationHistory.oldValue : []).map((item) => String(item?.id || '')));
    notificationHistory = Array.isArray(changes.ptNotificationHistory.newValue) ? changes.ptNotificationHistory.newValue : [];
    const freshServerNotice = notificationHistory.find((item) => String(item?.id || '').startsWith('server-notification-') && !previousIds.has(String(item.id)));
    if (freshServerNotice) toast(`${freshServerNotice.title} — ${freshServerNotice.message}`, 'ok');
    if ((document.querySelector('.tab.active')?.dataset.tab || '') === 'notifications') renderNotifications();
  }
  if (changes.ptRequestedDashboardTab?.newValue && TAB_INFO[changes.ptRequestedDashboardTab.newValue]) {
    setTab(changes.ptRequestedDashboardTab.newValue);
    void chrome.storage.local.remove('ptRequestedDashboardTab');
  }
  if (changes.ptStrategyTransferHistory) {
    transferHistory = Array.isArray(changes.ptStrategyTransferHistory.newValue) ? changes.ptStrategyTransferHistory.newValue : [];
    if ((document.querySelector('.tab.active')?.dataset.tab || '') === 'strategies') renderTransferHistory();
  }
  if (changes.ptPocketPartnersState) {
    pocketPartnersStatus.state = changes.ptPocketPartnersState.newValue || {};
    shouldRender = true;
  }
  if (shouldRender) requestRender();
});

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (renderDeferred && !userIsInteracting()) requestRender(true);
  }, 0);
});
document.addEventListener('change', () => {
  if (renderDeferred) setTimeout(() => requestRender(true), 0);
}, true);

(async () => {
  document.body.dataset.uiHealth = 'booting';
  startDashboardHeartbeat();

  // Статический каркас отображается немедленно, до любых сообщений background/API.
  requestRender(true);
  await initializeLegalConsentGate();

  try {
    await loadStored();
    inputsReady = false;
    applyInterfaceDensity();
    setupCollapsibleCards();
    requestRender(true);
    await refreshPocketPartnersStatus(true);
    await refreshState();
    if (access.entitlement?.features?.strategyBuilder ?? access.premium) {
      setTimeout(() => { void synchronizeCustomStrategyCatalog(); }, 900);
    }
    if (accessNotification && Date.now() - Date.parse(accessNotification.createdAt || 0) < 24 * 60 * 60 * 1000) showAccessNotification(accessNotification);
    if (runtimeCompatibility.mixed) showRuntimeMismatchRecovery();
    else hideDashboardRecovery();
  } catch (error) {
    await recordDashboardError(error, 'dashboard-boot');
    requestRender(true);
    showDashboardRecovery(error, 'Панель запущена в безопасном режиме и показывает последние сохранённые данные.');
  }

  scheduleDashboardPolling();

  // Если каркас реально исчез, вместо белого окна показываем восстановление.
  // В embedded-режиме Chrome иногда временно возвращает 0 rect во время скролла/перестроения DOM,
  // поэтому проверяем не один кадр, а несколько подряд и не пишем ложные ошибки в лог.
  let dashboardShellInvisibleTicks = 0;
  setInterval(() => {
    const shell = document.querySelector('.appShell');
    const recoveryVisible = document.querySelector('.recoveryScreen:not([hidden]), .dashboardRecovery:not([hidden])');
    const shellHasContent = Boolean(shell && shell.querySelector('.content, .sidebar, .view.active, [id^="view-"]'));
    // In embedded/terminal mode Chrome can report 0 rect while the panel is scrolled,
    // minimized, or being repainted. Treat an existing shell with content as healthy.
    if ((shell && shellHasContent) || recoveryVisible || document.visibilityState !== 'visible') {
      dashboardShellInvisibleTicks = 0;
      return;
    }
    dashboardShellInvisibleTicks += 1;
    if (dashboardShellInvisibleTicks >= 8) {
      const error = new Error('DASHBOARD_SHELL_NOT_VISIBLE');
      void recordDashboardError(error, 'ui-watchdog');
      showDashboardRecovery(error, 'Основной интерфейс не отобразился. Выполняется безопасное восстановление окна.');
      dashboardShellInvisibleTicks = 0;
    }
  }, 7000);
})();

window.addEventListener('pt-language-changed', () => { requestRender(true); setTab(safeSessionGet('poActiveTab') || 'account'); });
document.addEventListener('visibilitychange', () => {
  void publishDashboardHeartbeat(document.visibilityState === 'visible' ? 'ready' : 'background');
  void refreshState();
  scheduleDashboardPolling();
  if (document.visibilityState === 'visible') {
    requestRender(true);
  }
});
window.addEventListener('unload', () => {
  clearTimeout(pollTimer);
  clearInterval(dashboardHeartbeatTimer);
  clearInterval(trialCountdownTimer);
  clearTimeout(dashboardRenderTimer);
});
