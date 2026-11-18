import {
  initializeServerClient,
  syncServer,
  bindServerAccountContext,
  getServerState,
  getReferralProgram,
  getServerAccess,
  requestTradePermit,
  consumeTradeExecutionTicket,
  reportTrade,
  activateTrial,
  checkRelease,
  openSupport,
  openAffiliate,
  openAffiliatePublic,
  generateAffiliatePublic,
  getPreparedAffiliatePublic,
  openPreparedAffiliatePublic,
  openAdmin,
  openUpdate,
  saveCustomStrategy,
  deleteCustomStrategy,
  getSignalSocketTicket,
  getRuntimeInfo,
  getLegalConsent,
  acceptLegalConsent,
  deleteAccountData,
  ingestServerNotifications,
  humanReason,
  getRemoteControlLocalState,
  enableRemoteControl,
  disableRemoteControl,
  rotateRemoteControlPassword,
  pushRemoteControlStatus,
  getRemoteControlPendingCommands,
  ackRemoteControlCommand,
  openRemoteControl,
  getStrategyTesterConfig,
  runStrategyTester
} from './server-client.js';

import {
  getPocketPartnersStatus,
  savePocketPartnersSettings,
  connectPocketPartners,
  disconnectPocketPartners,
  openPocketPartnersTrade,
  capturePocketPartnersAuth
} from './pocket-partners-client.js';

const POCKET_OPTION_SMART_URL = 'https://u3.shortink.io/register?utm_campaign=863136&utm_source=affiliate&utm_medium=sr&a=2ZMIhcmXbAnA1h&al=1791102&ac=softwaretraffic&cid=976392';
const ACTIVE_AFFILIATE_CAMPAIGN_ID = '863136';
const ACTIVE_AFFILIATE_CODE = '2ZMIhcmXbAnA1h';
const PRODUCT_PAGE_URL = 'https://pockettraderobot.ru/';
const DASHBOARD_URL = chrome.runtime.getURL('dashboard.html');
const STATIC_POCKET_HOSTS = new Set(['pocketoption.com', 'po.trade']);
const OFFICIAL_DYNAMIC_POCKET_HOSTS = new Set();
const SUPPORTED_POCKET_HOSTS = new Set([...STATIC_POCKET_HOSTS]);
const CANONICAL_POCKET_ORIGIN = 'https://pocketoption.com';
const VPN_REQUIRED_POPUP_PAGE = 'vpn-required.html';
const PT_EXTENSION_BUILD_ID = '2.0.50-statusbar-recovery-20260916';

function affiliateTrackingState(value) {
  try {
    const url = new URL(String(value || ''));
    const campaign = String(url.searchParams.get('utm_campaign') || '').trim();
    const affiliateCode = String(url.searchParams.get('a') || '').trim();
    const hasTracking = Boolean(campaign || affiliateCode || url.searchParams.has('utm_source') || url.searchParams.has('al'));
    if (!hasTracking) return 'none';
    return campaign === ACTIVE_AFFILIATE_CAMPAIGN_ID && affiliateCode === ACTIVE_AFFILIATE_CODE ? 'current' : 'stale';
  } catch {
    return 'none';
  }
}

async function clearStaleAffiliateTrackingWithoutReload(tabId) {
  if (!tabId) return false;
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: 'MAIN',
    func: (campaignId, affiliateCode) => {
      try {
        const url = new URL(location.href);
        const campaign = String(url.searchParams.get('utm_campaign') || '').trim();
        const code = String(url.searchParams.get('a') || '').trim();
        const stale = (campaign && campaign !== campaignId) || (code && code !== affiliateCode);
        if (!stale) return false;
        for (const key of ['utm_campaign', 'utm_source', 'utm_medium', 'a', 'al', 'ac', 'cid']) url.searchParams.delete(key);
        history.replaceState(history.state, '', url.href);
        return true;
      } catch {
        return false;
      }
    },
    args: [ACTIVE_AFFILIATE_CAMPAIGN_ID, ACTIVE_AFFILIATE_CODE]
  }).catch(() => []);
  return Boolean(results?.[0]?.result);
}

async function migrateLegacyAffiliateStorage() {
  const stored = await chrome.storage.local.get(['ptAffiliatePrepared', 'ptServerState']).catch(() => ({}));
  const preparedUrl = String(stored?.ptAffiliatePrepared?.registrationUrl || '');
  if (preparedUrl && affiliateTrackingState(preparedUrl) === 'stale') {
    await chrome.storage.local.remove('ptAffiliatePrepared').catch(() => null);
  }
  const serverState = stored?.ptServerState;
  const storedRegistrationUrl = String(serverState?.entitlement?.affiliate?.registrationUrl || '');
  if (storedRegistrationUrl && affiliateTrackingState(storedRegistrationUrl) === 'stale') {
    await chrome.storage.local.set({
      ptServerState: {
        ...serverState,
        entitlement: {
          ...serverState.entitlement,
          affiliate: {
            ...serverState.entitlement.affiliate,
            registrationUrl: ''
          }
        }
      }
    }).catch(() => null);
  }
}

// Dedicated read-only candle bridge. The current Caddy configuration uses
// cache.pockettraderobot.online; the historical "cashe" hostname remains a fallback.
const PT_CACHE_BRIDGE_BASE_URLS = Object.freeze([
  'https://cache.pockettraderobot.online',
  'https://cashe.pockettraderobot.online'
]);
const PT_CACHE_BRIDGE_API_KEY = '0148fd3d1c769b7b85043c3d1484f87fe0bb82f915b055470f7e08333d8a4e7c';
const PT_CACHE_BRIDGE_TIMEOUT_MS = 20000;
let ptCacheBridgeRuntime = {
  online: false,
  activeBaseUrl: PT_CACHE_BRIDGE_BASE_URLS[0],
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  lastError: null,
  lastLatencyMs: null,
  lastResultCount: 0,
  lastServerTime: null
};

async function ptCacheBridgeFetch(baseUrl, path, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort('PT_CACHE_BRIDGE_TIMEOUT'); } catch { controller.abort(); }
  }, Math.max(2500, Number(timeoutMs) || PT_CACHE_BRIDGE_TIMEOUT_MS));
  const started = Date.now();
  try {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (path !== '/health') headers.set('X-PT-Cache-Key', PT_CACHE_BRIDGE_API_KEY);
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.error || `CACHE_BRIDGE_HTTP_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { data, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function ptCacheBridgeRequest(path, options = {}, timeoutMs = PT_CACHE_BRIDGE_TIMEOUT_MS) {
  const started = Date.now();
  ptCacheBridgeRuntime.lastAttemptAt = started;
  const preferred = String(ptCacheBridgeRuntime.activeBaseUrl || '');
  const baseUrls = [...PT_CACHE_BRIDGE_BASE_URLS].sort((left, right) => Number(right === preferred) - Number(left === preferred));
  const failures = [];
  const perHostTimeout = Math.max(2500, Math.floor((Number(timeoutMs) || PT_CACHE_BRIDGE_TIMEOUT_MS) / baseUrls.length));
  for (const baseUrl of baseUrls) {
    try {
      const { data, latencyMs } = await ptCacheBridgeFetch(baseUrl, path, options, perHostTimeout);
      ptCacheBridgeRuntime = {
        ...ptCacheBridgeRuntime,
        online: true,
        activeBaseUrl: baseUrl,
        lastSuccessAt: Date.now(),
        lastError: null,
        lastLatencyMs: latencyMs,
        lastResultCount: Array.isArray(data?.results) ? data.results.length : ptCacheBridgeRuntime.lastResultCount,
        lastServerTime: data?.serverTime ?? ptCacheBridgeRuntime.lastServerTime
      };
      return { ...data, bridgeLatencyMs: latencyMs, bridgeBaseUrl: baseUrl };
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'cache_bridge_timeout' : String(error?.message || error);
      failures.push(`${baseUrl}: ${message}`);
    }
  }
  const message = failures.join(' | ') || 'cache_bridge_unavailable';
  ptCacheBridgeRuntime = {
    ...ptCacheBridgeRuntime,
    online: false,
    lastError: message,
    lastLatencyMs: Date.now() - started
  };
  throw new Error(message);
}

async function ptCacheBridgeCandles(payload = {}) {
  const requests = Array.isArray(payload?.requests) ? payload.requests : [];
  if (!requests.length) return { ok: true, results: [], runtime: { ...ptCacheBridgeRuntime } };
  const normalized = requests.map((item) => ({
    asset: String(item?.asset || '').trim(),
    period: Math.max(1, Math.min(86400, Math.round(Number(item?.period ?? item?.timeframe) || 60))),
    limit: Math.max(1, Math.min(5000, Math.round(Number(item?.limit) || 400))),
    sinceTime: Math.max(0, Math.round(Number(item?.sinceTime ?? item?.since) || 0))
  })).filter((item) => item.asset);
  const chunks = [];
  for (let index = 0; index < normalized.length; index += 800) chunks.push(normalized.slice(index, index + 800));
  const settled = await Promise.allSettled(chunks.map((chunk) => ptCacheBridgeRequest('/candles', {
    method: 'POST',
    body: JSON.stringify({ requests: chunk })
  }, Math.max(5000, Number(payload?.timeoutMs) || PT_CACHE_BRIDGE_TIMEOUT_MS))));
  const successful = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  if (!successful.length) {
    const failed = settled.find((item) => item.status === 'rejected');
    throw failed?.reason || new Error('cache_bridge_unavailable');
  }
  return {
    ok: true,
    partial: successful.length !== chunks.length,
    chunkCount: chunks.length,
    completedChunks: successful.length,
    results: successful.flatMap((item) => Array.isArray(item?.results) ? item.results : []),
    serverTime: successful
      .map((item) => item?.serverTime)
      .filter((value) => value != null && value !== '')
      .sort((left, right) => {
        const leftNumeric = Number(left);
        const rightNumeric = Number(right);
        const leftTime = Number.isFinite(leftNumeric) ? leftNumeric : Date.parse(String(left));
        const rightTime = Number.isFinite(rightNumeric) ? rightNumeric : Date.parse(String(right));
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      })[0] ?? null,
    bridgeLatencyMs: successful.reduce((sum, item) => sum + (Number(item?.bridgeLatencyMs) || 0), 0),
    bridgeBaseUrl: successful.find((item) => item?.bridgeBaseUrl)?.bridgeBaseUrl || ptCacheBridgeRuntime.activeBaseUrl,
    runtime: { ...ptCacheBridgeRuntime }
  };
}

let customStrategyRepairInFlight = null;

async function repairCustomStrategiesFromLocal(strategyIds = []) {
  const requestedIds = [...new Set((Array.isArray(strategyIds) ? strategyIds : [])
    .map((value) => String(value || '').trim())
    .filter((value) => value.startsWith('custom-')))].slice(0, 50);
  if (!requestedIds.length) return { ok: true, repaired: [], present: [], unresolved: [], deleted: [] };
  if (customStrategyRepairInFlight) return customStrategyRepairInFlight;

  customStrategyRepairInFlight = (async () => {
    const stored = await chrome.storage.local.get(['poBridgeSettings', 'ptServerState']);
    const settings = stored.poBridgeSettings && typeof stored.poBridgeSettings === 'object' ? stored.poBridgeSettings : {};
    const localStrategies = Array.isArray(settings.builderStrategies) ? settings.builderStrategies : [];
    let currentServerState = stored.ptServerState && typeof stored.ptServerState === 'object'
      ? stored.ptServerState
      : await getServerState({ sync: false });
    const available = new Set((Array.isArray(currentServerState?.strategies) ? currentServerState.strategies : [])
      .map((item) => String(item?.id || item?.strategy_id || ''))
      .filter(Boolean));
    const deleted = new Set((Array.isArray(currentServerState?.deletedCustomStrategyIds) ? currentServerState.deletedCustomStrategyIds : [])
      .map(String)
      .filter(Boolean));
    const repaired = [];
    const present = [];
    const unresolved = [];
    const explicitlyDeleted = [];

    for (const strategyId of requestedIds) {
      if (available.has(strategyId)) {
        present.push(strategyId);
        continue;
      }
      if (deleted.has(strategyId)) {
        explicitlyDeleted.push(strategyId);
        continue;
      }
      const source = localStrategies.find((item) => String(item?.id || item?.strategy_id || '') === strategyId);
      if (!source) {
        unresolved.push(strategyId);
        continue;
      }
      const config = source?.config && typeof source.config === 'object' ? source.config : source;
      const name = String(source?.name || source?.title || config?.name || 'Моя стратегия').trim();
      try {
        const result = await saveCustomStrategy({
          id: strategyId,
          name,
          description: String(source?.description || config?.description || ''),
          config
        });
        currentServerState = result?.serverState || currentServerState;
        available.add(strategyId);
        repaired.push(strategyId);
      } catch (error) {
        unresolved.push(strategyId);
      }
    }

    if (repaired.length) {
      const repairedSet = new Set(repaired);
      const nextLocal = localStrategies.map((item) => repairedSet.has(String(item?.id || item?.strategy_id || ''))
        ? { ...item, serverSaved: true, serverRepairedAt: new Date().toISOString() }
        : item);
      await chrome.storage.local.set({
        poBridgeSettings: { ...settings, builderStrategies: nextLocal }
      });
    }

    return {
      ok: unresolved.length === 0 && explicitlyDeleted.length === 0,
      repaired,
      present,
      unresolved,
      deleted: explicitlyDeleted,
      serverState: currentServerState
    };
  })();

  try {
    return await customStrategyRepairInFlight;
  } finally {
    customStrategyRepairInFlight = null;
  }
}

const FREE_MAX_ASSETS = 30;
const UNSUPPORTED_POCKET_MIRROR_HOSTS = new Set(['po-rfx.com', 'po-sig.com', 'trade.study', 'trade.studio']);
const ACTION_LAUNCH_BADGE_STORAGE_KEY = 'ptActionLaunchBadgePending';
const ACTION_LAUNCH_BADGE_TEXT = 'ПУСК';
const ACTION_LAUNCH_BADGE_TITLE = 'Запустить Robot';
const BACKGROUND_UI_LANGUAGES = ['ru', 'en', 'es', 'hi', 'ar'];
const BACKGROUND_UI = Object.freeze({
  ru: {
    launchBadge: 'ПУСК', launchTitle: 'Запустить Robot', noConnection: 'нет подключения', balance: 'баланс', profit: 'прибыль робота', loss: 'убыток робота', premiumActivePlan: 'PREMIUM активирован', premiumPausedPlan: 'PREMIUM приостановлен', blockedPlan: 'доступ заблокирован', freePlan: 'FREE активен',
    premiumActivated: 'Premium-доступ активирован', premiumRestored: 'Premium-доступ восстановлен', restoredMessage: 'Условия снова выполнены. Все Premium-функции и AI-модули доступны.', confirmedSuffix: ' подтверждён. Все Premium-функции и AI-модули доступны.', pausedTitle: 'Premium временно приостановлен', pausedMessage: 'Premium-доступ временно приостановлен. Для уточнения причины обратитесь в поддержку Pocket TRADE ROBOT.', blockedTitle: 'Доступ заблокирован', supportMessage: 'Для уточнения причины обратитесь в поддержку Pocket TRADE ROBOT.', freeTitle: 'Активирован тариф FREE', freeMessage: 'Premium завершён или отозван. Доступны базовые стратегии и лимиты тарифа FREE.', freeLimitTitle: 'Дневной лимит FREE исчерпан'
  },
  en: {
    launchBadge: 'GO', launchTitle: 'Launch Robot', noConnection: 'not connected', balance: 'balance', profit: 'robot profit', loss: 'robot loss', premiumActivePlan: 'PREMIUM active', premiumPausedPlan: 'PREMIUM paused', blockedPlan: 'access blocked', freePlan: 'FREE active',
    premiumActivated: 'Premium access activated', premiumRestored: 'Premium access restored', restoredMessage: 'The conditions are met again. All Premium features and AI modules are available.', confirmedSuffix: ' confirmed. All Premium features and AI modules are available.', pausedTitle: 'Premium temporarily paused', pausedMessage: 'Premium access is temporarily paused. Contact Pocket TRADE ROBOT support for the reason.', blockedTitle: 'Access blocked', supportMessage: 'Contact Pocket TRADE ROBOT support for the reason.', freeTitle: 'FREE plan activated', freeMessage: 'Premium has ended or was revoked. Standard strategies and FREE plan limits are available.', freeLimitTitle: 'Daily FREE limit reached'
  },
  es: {
    launchBadge: 'IR', launchTitle: 'Iniciar Robot', noConnection: 'sin conexión', balance: 'saldo', profit: 'beneficio del robot', loss: 'pérdida del robot', premiumActivePlan: 'PREMIUM activo', premiumPausedPlan: 'PREMIUM en pausa', blockedPlan: 'acceso bloqueado', freePlan: 'FREE activo',
    premiumActivated: 'Acceso Premium activado', premiumRestored: 'Acceso Premium restablecido', restoredMessage: 'Las condiciones vuelven a cumplirse. Todas las funciones Premium y los módulos de IA están disponibles.', confirmedSuffix: ' confirmado. Todas las funciones Premium y los módulos de IA están disponibles.', pausedTitle: 'Premium pausado temporalmente', pausedMessage: 'El acceso Premium está pausado temporalmente. Contacta con el soporte de Pocket TRADE ROBOT para conocer el motivo.', blockedTitle: 'Acceso bloqueado', supportMessage: 'Contacta con el soporte de Pocket TRADE ROBOT para conocer el motivo.', freeTitle: 'Plan FREE activado', freeMessage: 'Premium ha finalizado o se ha revocado. Están disponibles las estrategias básicas y los límites del plan FREE.', freeLimitTitle: 'Límite diario FREE alcanzado'
  },
  hi: {
    launchBadge: 'चल', launchTitle: 'Robot शुरू करें', noConnection: 'कनेक्ट नहीं है', balance: 'बैलेंस', profit: 'Robot का लाभ', loss: 'Robot की हानि', premiumActivePlan: 'PREMIUM सक्रिय', premiumPausedPlan: 'PREMIUM रुका हुआ', blockedPlan: 'एक्सेस ब्लॉक', freePlan: 'FREE सक्रिय',
    premiumActivated: 'Premium एक्सेस सक्रिय', premiumRestored: 'Premium एक्सेस बहाल', restoredMessage: 'शर्तें फिर पूरी हैं। सभी Premium सुविधाएँ और AI मॉड्यूल उपलब्ध हैं।', confirmedSuffix: ' की पुष्टि हुई। सभी Premium सुविधाएँ और AI मॉड्यूल उपलब्ध हैं।', pausedTitle: 'Premium अस्थायी रूप से रुका', pausedMessage: 'Premium एक्सेस अस्थायी रूप से रुका है। कारण के लिए Pocket TRADE ROBOT सपोर्ट से संपर्क करें।', blockedTitle: 'एक्सेस ब्लॉक है', supportMessage: 'कारण के लिए Pocket TRADE ROBOT सपोर्ट से संपर्क करें।', freeTitle: 'FREE प्लान सक्रिय', freeMessage: 'Premium समाप्त या रद्द हो गया। बुनियादी रणनीतियाँ और FREE प्लान की सीमाएँ उपलब्ध हैं।', freeLimitTitle: 'दैनिक FREE सीमा पूरी हुई'
  },
  ar: {
    launchBadge: 'فتح', launchTitle: 'تشغيل Robot', noConnection: 'غير متصل', balance: 'الرصيد', profit: 'ربح Robot', loss: 'خسارة Robot', premiumActivePlan: 'PREMIUM نشط', premiumPausedPlan: 'PREMIUM موقوف', blockedPlan: 'الوصول محظور', freePlan: 'FREE نشط',
    premiumActivated: 'تم تفعيل وصول Premium', premiumRestored: 'تمت استعادة وصول Premium', restoredMessage: 'تم استيفاء الشروط مرة أخرى. جميع ميزات Premium ووحدات AI متاحة.', confirmedSuffix: ' مؤكد. جميع ميزات Premium ووحدات AI متاحة.', pausedTitle: 'تم إيقاف Premium مؤقتاً', pausedMessage: 'تم إيقاف وصول Premium مؤقتاً. تواصل مع دعم Pocket TRADE ROBOT لمعرفة السبب.', blockedTitle: 'الوصول محظور', supportMessage: 'تواصل مع دعم Pocket TRADE ROBOT لمعرفة السبب.', freeTitle: 'تم تفعيل خطة FREE', freeMessage: 'انتهى Premium أو تم إلغاؤه. الاستراتيجيات الأساسية وحدود خطة FREE متاحة.', freeLimitTitle: 'تم بلوغ حد FREE اليومي'
  }
});

function normalizeBackgroundLanguage(value) {
  const candidate = String(value || '').toLowerCase().split('-')[0];
  return BACKGROUND_UI_LANGUAGES.includes(candidate) ? candidate : 'ru';
}

async function getBackgroundLanguage() {
  const stored = await chrome.storage.local.get('ptUiLanguage').catch(() => ({}));
  return normalizeBackgroundLanguage(stored?.ptUiLanguage);
}

function backgroundFreeLimitMessage(language, used, limit, concise = false) {
  const values = {
    ru: concise
      ? `Дневной лимит FREE исчерпан: ${used}/${limit} сделок. Внесите депозит от $10 для полного Premium или продолжите на следующие сутки.`
      : `Сегодня использовано ${used} из ${limit} сделок на DEMO. Дневной FREE-лимит восстановится на следующие сутки; подтверждённый депозит от $10 активирует полный Premium.`,
    en: concise
      ? `Daily FREE limit reached: ${used}/${limit} trades. Deposit at least $10 for full Premium or continue the next day.`
      : `You have used ${used} of ${limit} DEMO trades today. The FREE limit resets the next day; a confirmed deposit of at least $10 activates full Premium.`,
    es: concise
      ? `Límite diario FREE alcanzado: ${used}/${limit} operaciones. Deposita al menos $10 para Premium completo o continúa al día siguiente.`
      : `Hoy has usado ${used} de ${limit} operaciones entre DEMO y REAL. El límite FREE se restablece al día siguiente; un depósito confirmado de al menos $10 activa Premium completo.`,
    hi: concise
      ? `दैनिक FREE सीमा पूरी: ${used}/${limit} ट्रेड। पूर्ण Premium के लिए कम से कम $10 जमा करें या अगले दिन जारी रखें।`
      : `आज आपने DEMO और REAL में कुल ${limit} में से ${used} ट्रेड उपयोग किए। FREE सीमा अगले दिन रीसेट होगी; कम से कम $10 की पुष्टि की गई जमा राशि पूर्ण Premium सक्रिय करती है।`,
    ar: concise
      ? `تم بلوغ حد FREE اليومي: ${used}/${limit} صفقة. أودع ما لا يقل عن $10 للحصول على Premium الكامل أو تابع في اليوم التالي.`
      : `استخدمت ${used} من ${limit} صفقة اليوم عبر DEMO وREAL. يُعاد ضبط حد FREE في اليوم التالي؛ ويؤدي إيداع مؤكد لا يقل عن $10 إلى تفعيل Premium الكامل.`
  };
  return values[normalizeBackgroundLanguage(language)] || values.ru;
}


async function ensureActionIcon() {
  try {
    await chrome.action.setIcon({
      path: {
        16: 'icon16.png',
        32: 'icon32.png',
        48: 'icon48.png',
        128: 'icon128.png',
        256: 'icon256.png'
      }
    });
  } catch {}
}

const DYNAMIC_POCKET_SCRIPT_PREFIX = 'pt-pocket-mirror';

function isStablePocketHost(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return [...STATIC_POCKET_HOSTS].some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return false;
  }
}

function dynamicPocketScriptIds(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 70);
    return [`${DYNAMIC_POCKET_SCRIPT_PREFIX}-main-${host}`, `${DYNAMIC_POCKET_SCRIPT_PREFIX}-isolated-${host}`];
  } catch {
    return [];
  }
}

async function ensureDynamicPocketRegistration(url) {
  // v1.0.80: rotating po-*** mirrors are intentionally unsupported.
  // pocketoption.com and the hidden po.trade compatibility host are declared
  // statically in manifest.json, so no per-domain registration or permission is needed.
  if (!isStablePocketHost(url)) {
    throw new Error('Pocket TRADE ROBOT работает только на pocketoption.com');
  }
  return { registered: false, ids: [] };
}

async function cleanupLegacyMirrorSupport({ reloadOpenMirrors = false } = {}) {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
    const ids = registered.map((item) => String(item?.id || '')).filter((id) => id.startsWith(DYNAMIC_POCKET_SCRIPT_PREFIX));
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids }).catch(() => null);
  } catch {}

  await chrome.storage.local.remove([
    'ptDynamicPocketScriptIds',
    'ptApprovedPocketMirrorOrigins',
    'ptApprovedPocketMirrorOriginsV172',
    'ptPocketMirrorApprovals',
    'ptPendingMirrorPermission'
  ]).catch(() => null);

  // Remove every legacy "allow this mirror/domain" surface left by older builds.
  try {
    const legacyPopupPrefix = chrome.runtime.getURL('mirror-permission.html');
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const windows = new Set();
    for (const tab of tabs) {
      if (!String(tab?.url || '').startsWith(legacyPopupPrefix)) continue;
      if (tab.windowId != null) windows.add(Number(tab.windowId));
      else if (tab.id) await chrome.tabs.remove(tab.id).catch(() => null);
    }
    for (const windowId of windows) await chrome.windows.remove(windowId).catch(() => null);
  } catch {}
  try {
    const stored = await chrome.storage.local.get(['ptNotificationHistory', 'ptServerNotificationActions']).catch(() => ({}));
    const history = Array.isArray(stored.ptNotificationHistory) ? stored.ptNotificationHistory : [];
    const retiredServerIds = new Set(
      history
        .filter((item) => isRetiredMirrorNotificationText(item?.title, item?.message))
        .map((item) => String(item?.id || ''))
        .filter(Boolean)
    );
    const notifications = await chrome.notifications?.getAll?.().catch(() => ({}));
    for (const id of Object.keys(notifications || {})) {
      if (id.startsWith('pt-mirror-permission-') || id.startsWith('pt-vpn-required-') || retiredServerIds.has(id)) {
        await chrome.notifications.clear(id).catch(() => null);
      }
    }
    if (retiredServerIds.size) {
      const nextHistory = history.filter((item) => !retiredServerIds.has(String(item?.id || '')));
      const actions = stored.ptServerNotificationActions && typeof stored.ptServerNotificationActions === 'object'
        ? { ...stored.ptServerNotificationActions }
        : {};
      for (const id of retiredServerIds) delete actions[id];
      await chrome.storage.local.set({ ptNotificationHistory: nextHistory, ptServerNotificationActions: actions }).catch(() => null);
    }
  } catch {}

  if (!reloadOpenMirrors) return;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (!tab?.id || !isUnsupportedPocketMirrorUrl(tab.url)) continue;
    // Never reload an unsupported mirror: an older already-running content script
    // could briefly recreate the retired permission prompt. Replace the tab with
    // the VPN handoff page immediately instead.
    await handleUnsupportedMirror(tab.id, tab.url, { force: true }).catch(() => null);
  }
}

const POCKET_TAB_MESSAGE_TIMEOUT_MS = 2500;

function sendPocketTabMessageWithTimeout(tabId, message, timeoutMs = POCKET_TAB_MESSAGE_TIMEOUT_MS) {
  let timer = null;
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`tab_message_timeout:${String(message?.type || 'unknown')}`)), Math.max(500, Number(timeoutMs) || POCKET_TAB_MESSAGE_TIMEOUT_MS));
    })
  ]).finally(() => clearTimeout(timer));
}

async function pocketContentAlive(tabId) {
  try {
    const response = await sendPocketTabMessageWithTimeout(tabId, { type: 'PO_GET_STATE' });
    return Boolean(response && response.ok !== false);
  } catch {
    return false;
  }
}

async function pocketContentCapabilities(tabId) {
  try {
    const response = await sendPocketTabMessageWithTimeout(tabId, { type: 'PT_CONTENT_CAPABILITIES' });
    return response && response.ok !== false ? response : null;
  } catch {
    return null;
  }
}

async function injectPocketScriptsNow(tabId) {
  if (!tabId) return { ok: false, error: 'tab_id_missing' };
  let mainInjected = false;
  let isolatedInjected = false;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['page-bridge.js'], world: 'MAIN' });
    mainInjected = true;
  } catch (error) {
    // A reload fallback below will handle pages where MAIN world injection is temporarily blocked.
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: false }, files: ['content.css'] }).catch(() => null);
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content.js'], world: 'ISOLATED' });
    isolatedInjected = true;
  } catch (error) {
    // A reload fallback below will handle pages where ISOLATED world injection is temporarily blocked.
  }
  let alive = false;
  for (let attempt = 0; attempt < 12 && !alive; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    alive = await pocketContentAlive(tabId);
  }
  return { ok: alive, mainInjected, isolatedInjected };
}

// The page bridge runs in the page's MAIN world.  A Chrome extension update
// invalidates the isolated controller, but does not replace a MAIN-world bridge
// already attached to an open Pocket tab.  Read its tiny public upgrade marker
// instead of guessing from the URL.  This lets us refresh only the one legacy
// bridge which cannot be safely hot-replaced.
async function readPocketBridgeUpgradeStatus(tabId) {
  if (!tabId) return null;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: () => {
        const requested = window.__PO_SOCKET_BRIDGE_RELOAD_REQUIRED__;
        return {
          installed: window.__PO_SOCKET_BRIDGE_V220__ === true,
          build: String(window.__PO_SOCKET_BRIDGE_BUILD__ || ''),
          reloadRequired: Boolean(requested && typeof requested === 'object'),
          requestedBuild: String(requested?.requestedBuild || ''),
          previousBuild: String(requested?.previousBuild || '')
        };
      }
    });
    return result?.[0]?.result || null;
  } catch {
    return null;
  }
}

function pocketStateHasOpenTrades(state) {
  const trades = state?.trades || {};
  const opened = Array.isArray(trades.openedDeals) ? trades.openedDeals : [];
  const brokerOpen = Number(trades?.statistics?.open ?? trades?.open ?? trades?.openedCount ?? 0);
  return opened.length > 0 || (Number.isFinite(brokerOpen) && brokerOpen > 0);
}

async function reloadPocketTabAndWait(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Терминал Pocket Option загружается слишком долго'));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading') sawLoading = true;
      if (changeInfo.status !== 'complete' || !sawLoading) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId, { bypassCache: false }).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    });
  });
}

function isPocketTerminalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    // v1.0.78: public stable runtime uses pocketoption.com. po.trade is retained
    // as a private compatibility host and follows the exact same runtime path.
    // Other mirrors are detected separately only to show the VPN handoff notice.
    return host === 'pocketoption.com' || host.endsWith('.pocketoption.com')
      || host === 'po.trade' || host.endsWith('.po.trade');
  } catch {
    return false;
  }
}

function isRotatingPocketMirrorHost(value) {
  const host = String(value || '').toLowerCase().replace(/\.$/, '');
  const labels = host.split('.').filter(Boolean);
  const baseHost = labels.length >= 2 ? labels.slice(-2).join('.') : host;
  return /^po-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.com$/i.test(baseHost);
}

function isUnsupportedPocketMirrorUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || isPocketTerminalUrl(url.href)) return false;
    const host = url.hostname.toLowerCase();
    const explicitlyKnownMirror = [...UNSUPPORTED_POCKET_MIRROR_HOSTS]
      .some((item) => host === item || host.endsWith(`.${item}`));
    if (explicitlyKnownMirror) return true;

    // Pocket rotates short HTTPS mirrors in the po-<id>.com family. The
    // background worker only reads the tab URL and redirects to the extension-
    // owned VPN guidance page; no Robot/content code is injected into the mirror.
    // Match the registrable host exactly so lookalikes such as
    // po-example.com.evil.test are never classified as Pocket mirrors.
    return isRotatingPocketMirrorHost(host);
  } catch {
    return false;
  }
}

function isUnsupportedMirrorGuestUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return isUnsupportedPocketMirrorUrl(url.href) && /(?:^|\/)try-demo(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isRetiredMirrorNotificationText(title = '', message = '') {
  const text = `${String(title || '')} ${String(message || '')}`.toLowerCase();
  // Mirrors are no longer a supported product flow. Suppress every old or server-
  // supplied system message that refers to a mirror or a rotating po-*** domain,
  // regardless of whether it says "permission", "VPN" or "unsupported".
  return /(?:зеркал|mirror|po-[a-z0-9-]+\.(?:com|net|org|io|co|trade|click|top|site|online|pro|app|xyz|info|live|link|space|icu))/.test(text);
}

function canonicalPocketTargetForMirror(value) {
  try {
    const url = new URL(String(value || ''));
    const match = String(url.pathname || '').match(/^\/(ru|en)(?:\/|$)/i);
    const lang = String(match?.[1] || '').toLowerCase();
    return `${CANONICAL_POCKET_ORIGIN}${lang ? `/${lang}/` : '/'}`;
  } catch {
    return `${CANONICAL_POCKET_ORIGIN}/`;
  }
}


function isPocketGuestUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return isPocketTerminalUrl(url.href) && /(?:^|\/)try-demo(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isPocketTradingAccountUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!isPocketTerminalUrl(url.href)) return false;
    return /(?:^|\/)(?:demo-quick(?:-high-low)?|real-quick(?:-high-low)?)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isPocketCabinetUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return isPocketTerminalUrl(url.href) && /(?:^|\/)cabinet(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isPocketPotentialAccountUrl(value) {
  return Boolean(isPocketCabinetUrl(value) && !isPocketGuestUrl(value));
}

function hasObservedPocketLoginState(state) {
  const passive = Boolean(state?.login?.authenticated === true && state?.login?.uid != null);
  const connectedIdentity = Boolean(state?.account?.uid != null && state?.account?.sessionCaptured === true);
  return passive || connectedIdentity;
}

function isPocketRobotEligibleContext(url, state) {
  if (isPocketGuestUrl(url)) return false;
  if (!isPocketPotentialAccountUrl(url) && !isPocketTradingAccountUrl(url)) return false;
  return hasObservedPocketLoginState(state);
}

async function readLivePocketTabState(tabId, { attempts = 4, delayMs = 180 } = {}) {
  if (!tabId) return null;
  for (let index = 0; index < Math.max(1, attempts); index += 1) {
    try {
      const live = await sendPocketTabMessageWithTimeout(tabId, { type: 'PO_GET_STATE' });
      const state = live?.ok !== false ? (live?.state || null) : null;
      if (state && (hasObservedPocketLoginState(state) || index === attempts - 1)) return state;
    } catch {}
    if (index < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

const PENDING_LOGIN_WAIT_STORAGE_KEY = 'ptPendingLoginWaitStatusV171';
const PENDING_LOGIN_WAIT_TTL_MS = 20 * 60 * 1000;

function pendingLoginWaitMarker(source = 'toolbar_open') {
  return { at: Date.now(), source: String(source || 'toolbar_open') };
}

function pocketOriginPattern(value) {
  try {
    const url = new URL(String(value || ''));
    return isPocketTerminalUrl(url.href) ? `${url.origin}/*` : null;
  } catch {
    return null;
  }
}

async function hasPocketOriginPermission(url) {
  // Both supported host families are bundled in manifest host_permissions.
  // No user-facing per-domain permission prompt is part of the v1.0.80 flow.
  return isPocketTerminalUrl(url);
}

function requiresExplicitMirrorApproval() {
  return false;
}

async function isPocketMirrorExplicitlyApproved(url) {
  return isPocketTerminalUrl(url);
}

async function markPocketMirrorExplicitlyApproved(url) {
  return isPocketTerminalUrl(url);
}

async function hasPocketMirrorAccessApproval(url) {
  return isPocketTerminalUrl(url);
}

async function requestPocketOriginPermission(url) {
  const origin = pocketOriginPattern(url);
  if (!origin) {
    return {
      ok: false,
      granted: false,
      vpnRequired: isUnsupportedPocketMirrorUrl(url),
      error: 'Pocket TRADE ROBOT работает только на pocketoption.com'
    };
  }
  return { ok: true, granted: true, origin, alreadyGranted: true, staticHostPermission: true };
}

async function ensurePocketScripts(tabId, url) {
  if (!tabId || !isPocketTerminalUrl(url)) throw new Error('Откройте торговый терминал Pocket Option');
  const origin = pocketOriginPattern(url);
  const registration = await ensureDynamicPocketRegistration(url);
  let alive = await pocketContentAlive(tabId);
  let reloaded = false;
  let injected = false;

  // If Chrome has reloaded/updated the extension, old content scripts lose their
  // runtime context. First try to re-inject the bridge into the already-open
  // Pocket tab. Reload only as a last resort, because users can have active trades.
  if (!alive) {
    const injection = await injectPocketScriptsNow(tabId).catch(() => ({ ok: false }));
    injected = Boolean(injection?.mainInjected || injection?.isolatedInjected);
    alive = Boolean(injection?.ok) || await pocketContentAlive(tabId);
  }

  // Persisted WebSocket/account snapshots are not proof that the page-side
  // controller is alive. Treating that cache as a successful injection left
  // users with neither the status bar nor an actionable error after a SPA
  // rebuild, an extension update, or restricted site access.
  if (!alive) throw new Error('Не удалось запустить интерфейс в терминале Pocket Option. Разрешите расширению доступ к сайту и повторите нажатие.');
  await chrome.storage.local.set({ ptLastPocketOrigin: new URL(url).origin }).catch(() => null);
  return { ok: true, tabId, origin, registered: registration.registered, reloaded, injected };
}

async function cleanupLegacyContextBannerInTab(tabId) {
  if (!tabId) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => {
        try {
          const legacyIds = ['pt-extension-context-notice', 'pt-context-recovery-notice'];
          for (const id of legacyIds) {
            const item = document.getElementById(id);
            if (item) item.remove();
          }
          const nodes = Array.from(document.querySelectorAll('body > div, html > div'));
          for (const node of nodes) {
            const text = String(node?.innerText || node?.textContent || '');
            if (/(?:Perfect Trade|Pocket TRADE)(?: Robot)? обновл[её]н/i.test(text) && /Контекст старой версии остановлен/i.test(text)) {
              node.remove();
            }
          }
          sessionStorage.removeItem('ptExtensionContextAutoReloadAt');
        } catch {}
      }
    });
    return true;
  } catch {
    return false;
  }
}

async function reloadOpenPocketTabsAfterExtensionRefresh(reason = 'manual') {
  // Never refresh a healthy terminal merely because the extension updated.  The
  // exception is a stale MAIN-world bridge: it cannot be replaced in place and
  // otherwise the fresh controller can have no state/command endpoint at all.
  // A tab with any open broker trade is deliberately left alone; its upgrade is
  // completed on the user's next normal page refresh.
  try {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (!tab?.id || !isPocketTerminalUrl(tab.url)) continue;
      await cleanupLegacyContextBannerInTab(tab.id).catch(() => null);
      if (reason !== 'update') continue;

      const liveBeforeUpgrade = await readLivePocketTabState(tab.id, { attempts: 2, delayMs: 120 }).catch(() => null);
      // A fresh content controller makes the status bar available immediately
      // while the bridge decision below protects any open broker position.
      await injectPocketScriptsNow(tab.id).catch(() => null);
      const bridge = await readPocketBridgeUpgradeStatus(tab.id);
      if (!bridge?.reloadRequired || bridge.requestedBuild !== PT_EXTENSION_BUILD_ID) continue;

      if (pocketStateHasOpenTrades(liveBeforeUpgrade)) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'PT_SHOW_STATUS_BAR',
          payload: { source: 'bridge_upgrade_waiting_for_trade_close', pulse: false, forceVisible: true }
        }).catch(() => null);
        continue;
      }

      // If the old content state cannot be read, do not risk refreshing a tab
      // whose open order is unknown.  The toolbar can still show the recovered
      // panel and the next regular Pocket navigation completes the upgrade.
      if (!liveBeforeUpgrade) continue;
      await chrome.tabs.reload(tab.id, { bypassCache: false }).catch(() => null);
    }
  } catch {}
}


const MARKET_CACHE_DB = 'perfect-trade-market-cache';
const MARKET_CACHE_STORE = 'history';
const MARKET_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
let marketCacheDbPromise = null;
let marketCacheWrites = 0;

function openMarketCacheDb() {
  if (marketCacheDbPromise) return marketCacheDbPromise;
  marketCacheDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MARKET_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MARKET_CACHE_STORE)) {
        const store = db.createObjectStore(MARKET_CACHE_STORE, { keyPath: 'key' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch {}
        marketCacheDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      marketCacheDbPromise = null;
      reject(request.error || new Error('Не удалось открыть локальный кэш рынка'));
    };
    request.onblocked = () => {
      marketCacheDbPromise = null;
      reject(new Error('Локальный кэш рынка заблокирован другой версией расширения'));
    };
  });
  return marketCacheDbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Ошибка локального кэша'));
  });
}

function normalizeCachedCandle(item, asset, period) {
  if (!item || typeof item !== 'object') return null;
  const time = Number(item.time);
  const open = Number(item.open);
  const high = Number(item.high);
  const low = Number(item.low);
  const close = Number(item.close);
  if (![time, open, high, low, close].every(Number.isFinite) || time <= 0) return null;
  return { asset, period, time, open, high, low, close, volume: Number.isFinite(Number(item.volume)) ? Number(item.volume) : undefined };
}

async function getMarketCache(assets, period) {
  const normalizedPeriod = Math.max(1, Math.floor(Number(period) || 60));
  const unique = [...new Set((Array.isArray(assets) ? assets : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 250);
  if (!unique.length) return {};
  const db = await openMarketCacheDb();
  const tx = db.transaction(MARKET_CACHE_STORE, 'readonly');
  const store = tx.objectStore(MARKET_CACHE_STORE);
  const entries = await Promise.all(unique.map(async (asset) => {
    const record = await idbRequest(store.get(`${asset}|${normalizedPeriod}`)).catch(() => null);
    if (!record || Date.now() - Number(record.savedAt || 0) > MARKET_CACHE_MAX_AGE_MS) return null;
    return [asset, record];
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

async function pruneMarketCache(db) {
  const tx = db.transaction(MARKET_CACHE_STORE, 'readwrite');
  const store = tx.objectStore(MARKET_CACHE_STORE);
  const cutoff = Date.now() - MARKET_CACHE_MAX_AGE_MS;
  const request = store.openCursor();
  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      if (Number(cursor.value?.savedAt || 0) < cutoff) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('Ошибка очистки локального кэша'));
  });
}

async function putMarketCache(payload) {
  const asset = String(payload?.asset || '').trim();
  const period = Math.max(1, Math.floor(Number(payload?.period) || 60));
  if (!asset || !Array.isArray(payload?.historyItems)) return { saved: false };
  const historyItems = payload.historyItems
    .slice(-240)
    .map((item) => normalizeCachedCandle(item, asset, period))
    .filter(Boolean);
  if (historyItems.length < 20) return { saved: false };
  const db = await openMarketCacheDb();
  const record = {
    key: `${asset}|${period}`,
    asset,
    period,
    savedAt: Date.now(),
    lastCandleTime: Number(historyItems[historyItems.length - 1]?.time || 0),
    historyItems
  };
  const tx = db.transaction(MARKET_CACHE_STORE, 'readwrite');
  await idbRequest(tx.objectStore(MARKET_CACHE_STORE).put(record));
  marketCacheWrites += 1;
  if (marketCacheWrites % 50 === 0) void pruneMarketCache(db).catch(() => null);
  return { saved: true, candles: historyItems.length };
}

async function clearMarketCache() {
  const db = await openMarketCacheDb();
  const tx = db.transaction(MARKET_CACHE_STORE, 'readwrite');
  await idbRequest(tx.objectStore(MARKET_CACHE_STORE).clear());
  return { cleared: true };
}


// Серверный WebSocket работает в service worker, а не в content script.
// Это изолирует канал сигналов от CSP страницы Pocket Option и позволяет
// использовать host_permissions расширения. Chrome 116+ поддерживает
// продление жизни service worker активностью WebSocket.
const signalSubscriptions = new Map();
let signalControllerTabId = null;
let signalSocket = null;
let signalSocketUrl = null;
let signalSocketPingTimer = null;
let signalSocketWatchdogTimer = null;
let signalSocketReconnectTimer = null;
let signalSocketSoftReconnectTimer = null;
let signalSocketReconnectAttempt = 0;
let signalLastRecoveryAttemptAt = 0;
let signalSocketConnectPromise = null;
let signalSocketLastMessageAt = 0;
let signalSubscriptionWireKey = '';
let signalSocketBoundUid = null;
let signalSocketBoundMode = null;
let signalSocketBoundAccountKey = null;
let signalSocketAnalysisReady = false;
let signalSocketTransportOpenedAt = null;
let signalSocketSubscriptionAckAt = null;
let signalSocketBindingRevision = 0;
let signalSocketGeneration = 0;
let signalSubscriptionRevision = 0;
let signalDiagnosticsWriteTimer = null;
const pendingSnapshotAcks = new Map();
const signalSnapshotContexts = new Map();
const SIGNAL_SNAPSHOT_CONTEXT_TTL_MS = 5 * 60 * 1000;
const SIGNAL_SUBSCRIPTION_STORAGE_KEY = 'ptSignalSubscriptionState';
let persistedSignalSubscription = null;
let signalSubscriptionStateLoaded = false;
let signalSubscriptionRestorePromise = null;
const signalWorkerStartedAt = new Date().toISOString();
const signalDiagnostics = {
  version: 11,
  status: 'idle',
  subscribedAssets: 0,
  strategyIds: [],
  strategyMode: 'best',
  candleMode: 'closed',
  candleOffset: -1,
  connectedAt: null,
  disconnectedAt: null,
  lastMessageAt: null,
  lastSignalAt: null,
  lastEngineAt: null,
  lastSnapshotAt: null,
  lastSubscribedAt: null,
  lastError: null,
  reconnectAttempts: 0,
  messages: 0,
  signals: 0,
  snapshotsSent: 0,
  snapshotErrors: 0,
  snapshotTimeouts: 0,
  engineEvaluations: 0,
  strategyEvaluations: 0,
  engineSignals: 0,
  staleSignals: 0,
  lastStaleSignalAt: null,
  lastEngineStatus: null,
  workerStartedAt: signalWorkerStartedAt,
  subscriptionRestoredAt: null,
  lastRecoveryAt: null,
  lastRecoveryReason: null,
  recoveryCount: 0,
  lastSocketCloseCode: null,
  lastSocketCloseReason: null,
  lastSoftReconnectAt: null,
  lastRecoveryThrottledAt: null,
  boundUid: null,
  boundMode: null,
  boundAccountKey: null,
  transportOpen: false,
  analysisReady: false,
  transportOpenedAt: null,
  subscriptionAckAt: null,
  subscriptionRevision: 0,
  socketGeneration: 0,
  lastSnapshotId: null,
  lastSnapshotBytes: 0,
  lastMarketAckAt: null,
  lastMarketAckLatencyMs: null,
  lastMarketAckCode: null,
  pendingSnapshotAcks: 0,
  webSocketBufferedAmount: 0,
  lastEngineStatusAt: null,
  serverSnapshotMaxParallel: 0,
  serverSnapshotRecommendedWorkers: 4,
  serverSnapshotSchedulerWorkers: 0
};

// Restore counters after Manifest V3 service-worker suspension so an exported
// diagnostic log contains the whole test session instead of only the last wake-up.
const signalDiagnosticsReady = chrome.storage.local.get('ptSignalDiagnostics').then((stored) => {
  if (stored?.ptSignalDiagnostics && typeof stored.ptSignalDiagnostics === 'object') {
    Object.assign(signalDiagnostics, stored.ptSignalDiagnostics);
    // v1 could count every retry while the WebSocket was still connecting. That made
    // snapshotErrors grow into the millions even though no snapshot had been sent.
    const previousDiagnosticsVersion = Math.max(1, Number(signalDiagnostics.version) || 1);
    const sent = Math.max(0, Number(signalDiagnostics.snapshotsSent) || 0);
    const errors = Math.max(0, Number(signalDiagnostics.snapshotErrors) || 0);
    if (previousDiagnosticsVersion < 2 || errors > Math.max(1000, sent * 10 + 100)) {
      signalDiagnostics.snapshotErrors = 0;
      signalDiagnostics.lastError = null;
      signalDiagnostics.counterResetReason = 'v2_transient_retry_counter_migration';
    }
    // Schema v11 starts a clean verification window for adaptive serialized delivery.
    // Old cumulative counters must not be confused with new test-session behavior.
    if (previousDiagnosticsVersion < 11) {
      signalDiagnostics.snapshotsSent = 0;
      signalDiagnostics.snapshotErrors = 0;
      signalDiagnostics.snapshotTimeouts = 0;
      signalDiagnostics.staleSignals = 0;
      signalDiagnostics.staleEngineStatuses = 0;
      signalDiagnostics.lastError = null;
      signalDiagnostics.lastStaleSignalAt = null;
      signalDiagnostics.lastStaleEngineAt = null;
      signalDiagnostics.lastMarketAckAt = null;
      signalDiagnostics.lastMarketAckLatencyMs = null;
      signalDiagnostics.lastMarketAckCode = null;
      signalDiagnostics.counterResetReason = 'v11_adaptive_serial_snapshot_direct_signal_migration';
    }
  }
  signalDiagnostics.version = 11;
  signalDiagnostics.workerStartedAt = signalWorkerStartedAt;
  // The service worker can be suspended while the page remains open. Its in-memory
  // socket does not survive a full worker restart, so never expose a stale online flag.
  signalDiagnostics.status = 'idle';
  signalDiagnostics.reconnectAttempts = 0;
  void chrome.storage.local.set({ ptSignalDiagnostics: { ...signalDiagnostics, updatedAt: new Date().toISOString() } }).catch(() => null);
}).catch(() => null);

const SIGNAL_RECOVERY_COOLDOWN_MS = 60 * 1000;
const SIGNAL_SOFT_RECONNECT_MS = 50 * 60 * 1000;

function normalizeSignalNumberMap(raw, strategyIds, fallback, { min = 0, max = 86400, integer = true } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(strategyIds.map((strategyId) => {
    let value = Number(source[strategyId]);
    if (!Number.isFinite(value)) value = Number(fallback);
    if (!Number.isFinite(value)) value = min;
    value = Math.min(max, Math.max(min, value));
    return [strategyId, integer ? Math.round(value) : value];
  }));
}

function normalizeSignalOffsetMap(raw, strategyIds, fallback = -1) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(strategyIds.map((strategyId) => {
    const value = Number(source[strategyId]);
    const normalized = [0, -1, -2].includes(value) ? value : ([0, -1, -2].includes(Number(fallback)) ? Number(fallback) : -1);
    return [strategyId, normalized];
  }));
}

function persistSignalDiagnostics(patch = {}) {
  Object.assign(signalDiagnostics, patch, { updatedAt: new Date().toISOString() });
  if (signalDiagnosticsWriteTimer) return;
  signalDiagnosticsWriteTimer = setTimeout(() => {
    signalDiagnosticsWriteTimer = null;
    void chrome.storage.local.set({ ptSignalDiagnostics: { ...signalDiagnostics } }).catch(() => null);
  }, 120);
}

function normalizeSignalSubscription(raw, fallbackTabId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const assets = [...new Set((Array.isArray(raw.assets) ? raw.assets : []).filter(Boolean).map(String))];
  const values = [raw.strategyId, ...(Array.isArray(raw.strategyIds) ? raw.strategyIds : [])];
  const strategyIds = [...new Set(values.filter(Boolean).map(String))];
  const candleOffset = [0, -1, -2].includes(Number(raw.candleOffset))
    ? Number(raw.candleOffset)
    : (raw.candleMode === 'current' ? 0 : -1);
  const tabId = Number(raw.controllerTabId ?? raw.tabId ?? fallbackTabId);
  const period = Math.max(1, Math.min(86400, Math.round(Number(raw.period) || 60)));
  const duration = Math.max(1, Math.min(86400, Math.round(Number(raw.duration) || 60)));
  return {
    enabled: raw.enabled !== false,
    assets,
    strategyId: strategyIds[0] || '',
    strategyIds,
    strategyMode: strategyIds.length > 1 ? 'independent' : (['best', 'independent'].includes(raw.strategyMode) ? raw.strategyMode : 'best'),
    candleMode: candleOffset === 0 ? 'current' : 'closed',
    candleOffset,
    period,
    duration,
    strategyPeriods: normalizeSignalNumberMap(raw.strategyPeriods, strategyIds, period, { min: 1 }),
    strategyDurations: normalizeSignalNumberMap(raw.strategyDurations, strategyIds, duration, { min: 1 }),
    strategyCandleOffsets: normalizeSignalOffsetMap(raw.strategyCandleOffsets, strategyIds, candleOffset),
    strategyCooldowns: normalizeSignalNumberMap(raw.strategyCooldowns, strategyIds, raw.cooldown || 0, { min: 0, max: 86400, integer: false }),
    localConfigRevision: Math.max(0, Math.round(Number(raw.localConfigRevision) || 0)),
    controllerTabId: Number.isInteger(tabId) && tabId > 0 ? tabId : null,
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

async function persistSignalSubscriptionState(snapshot = null) {
  const normalized = normalizeSignalSubscription(snapshot || signalSubscriptionSnapshot());
  if (!normalized?.enabled || !normalized.assets.length || !normalized.strategyIds.length) {
    persistedSignalSubscription = null;
    await chrome.storage.local.remove(SIGNAL_SUBSCRIPTION_STORAGE_KEY).catch(() => null);
    return null;
  }
  const next = { ...normalized, controllerTabId: normalized.controllerTabId || signalControllerTabId || null, updatedAt: Date.now() };
  persistedSignalSubscription = next;
  signalSubscriptionStateLoaded = true;
  await chrome.storage.local.set({ [SIGNAL_SUBSCRIPTION_STORAGE_KEY]: next }).catch(() => null);
  return next;
}

async function restoreSignalSubscriptionState({ force = false } = {}) {
  if (!force && signalSubscriptionStateLoaded) return persistedSignalSubscription;
  if (signalSubscriptionRestorePromise) return signalSubscriptionRestorePromise;
  signalSubscriptionRestorePromise = (async () => {
    const stored = await chrome.storage.local.get([SIGNAL_SUBSCRIPTION_STORAGE_KEY, 'poBridgeSettings']).catch(() => ({}));
    const autoSettings = stored.poBridgeSettings?.autoTrade || {};
    const autoEnabled = autoSettings.enabled === true;
    const fallbackSubscription = autoEnabled ? {
      enabled: true,
      assets: Array.isArray(stored.poBridgeSettings?.selectedAssets) ? stored.poBridgeSettings.selectedAssets : [],
      strategyId: autoSettings.strategyId || stored.poBridgeSettings?.activeStrategyId || '',
      strategyIds: Array.isArray(autoSettings.strategyIds) ? autoSettings.strategyIds : [],
      strategyMode: autoSettings.strategyMode === 'independent' ? 'independent' : 'best',
      candleMode: autoSettings.candleMode || 'closed',
      candleOffset: autoSettings.candleOffset,
      period: autoSettings.period || stored.poBridgeSettings?.period || 60,
      duration: autoSettings.duration || stored.poBridgeSettings?.duration || 60,
      strategyPeriods: stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY]?.strategyPeriods || {},
      strategyDurations: stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY]?.strategyDurations || {},
      strategyCandleOffsets: stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY]?.strategyCandleOffsets || {},
      strategyCooldowns: stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY]?.strategyCooldowns || {},
      localConfigRevision: stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY]?.localConfigRevision || 0,
      controllerTabId: stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY]?.controllerTabId || null,
      updatedAt: Date.now()
    } : null;
    const normalized = normalizeSignalSubscription(stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY] || fallbackSubscription);
    signalSubscriptionStateLoaded = true;
    if (!autoEnabled || !normalized?.enabled || !normalized.assets.length || !normalized.strategyIds.length) {
      persistedSignalSubscription = null;
      return null;
    }

    const existingControllerId = selectSignalController();
    const existingItem = existingControllerId ? signalSubscriptions.get(existingControllerId) : null;
    if (existingItem?.enabled !== false) {
      const existingTab = await chrome.tabs.get(existingControllerId).catch(() => null);
      if (existingTab?.id && isPocketPotentialAccountUrl(existingTab.url)) {
        const existing = normalizeSignalSubscription({ ...existingItem, controllerTabId: existingControllerId });
        if (existing?.assets.length && existing?.strategyIds.length) {
          persistedSignalSubscription = existing;
          return existing;
        }
      } else {
        signalSubscriptions.delete(existingControllerId);
        if (signalControllerTabId === existingControllerId) signalControllerTabId = null;
      }
    }

    let tabId = normalized.controllerTabId;
    if (tabId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab?.id || !isPocketPotentialAccountUrl(tab.url)) tabId = null;
    }
    if (!tabId) {
      const tabs = await findPocketTabs().catch(() => []);
      // Prefer canonical quick routes when available, but accept authenticated
      // generic /cabinet/ terminals used by newer Pocket deployments.
      tabId = tabs.find((tab) => tab?.id && isPocketTradingAccountUrl(tab.url))?.id
        || tabs.find((tab) => tab?.id && isPocketPotentialAccountUrl(tab.url))?.id
        || null;
    }
    if (!tabId) {
      persistedSignalSubscription = { ...normalized, controllerTabId: null };
      return persistedSignalSubscription;
    }

    const restored = { ...normalized, controllerTabId: tabId, updatedAt: Date.now() };
    signalSubscriptions.set(tabId, { ...restored, updatedAt: restored.updatedAt });
    signalControllerTabId = tabId;
    persistedSignalSubscription = restored;
    await chrome.storage.local.set({ [SIGNAL_SUBSCRIPTION_STORAGE_KEY]: restored }).catch(() => null);
    persistSignalDiagnostics({
      subscriptionRestoredAt: new Date().toISOString(),
      lastRecoveryAt: new Date().toISOString(),
      lastRecoveryReason: 'service_worker_restore',
      recoveryCount: Math.max(0, Number(signalDiagnostics.recoveryCount) || 0) + 1,
      subscribedAssets: restored.assets.length,
      strategyIds: restored.strategyIds,
      strategyMode: restored.strategyMode,
      candleMode: restored.candleMode,
      candleOffset: restored.candleOffset
    });
    return restored;
  })();
  try {
    return await signalSubscriptionRestorePromise;
  } finally {
    signalSubscriptionRestorePromise = null;
  }
}


function signalAccountIdentityFromBridgeState(state) {
  const uid = state?.account?.uid != null ? String(state.account.uid).trim() : '';
  if (!uid || state?.account?.sessionCaptured !== true) return null;
  const mode = String(state?.account?.mode || '').trim().toUpperCase() || null;
  return { uid, mode, key: `${uid}:${mode || 'UNKNOWN'}` };
}

function signalAccountContextFromBridgeState(state) {
  if (!isConnected(state || null)) return null;
  return signalAccountIdentityFromBridgeState(state);
}

async function currentSignalBindingContext() {
  const stored = await chrome.storage.local.get(['poBridgeState', 'ptServerState']).catch(() => ({}));
  const bridge = signalAccountContextFromBridgeState(stored.poBridgeState || null);
  const serverUid = stored.ptServerState?.pocketUid != null ? String(stored.ptServerState.pocketUid).trim() : '';
  return {
    bridge,
    serverUid: serverUid || null,
    serverState: stored.ptServerState || null,
    bridgeState: stored.poBridgeState || null
  };
}

function signalSocketBindingMatchesContext(context) {
  const bridge = context?.bridge;
  if (!bridge) return false;
  if (!signalSocketBoundAccountKey || signalSocketBoundAccountKey !== bridge.key) return false;
  if (!signalSocketBoundUid || signalSocketBoundUid !== bridge.uid) return false;
  if (context?.serverUid && context.serverUid !== bridge.uid) return false;
  return true;
}

function markSignalBindingChanged(reason = 'account_context_changed') {
  signalSocketBindingRevision += 1;
  signalLastRecoveryAttemptAt = 0;
  signalSocketAnalysisReady = false;
  persistSignalDiagnostics({
    analysisReady: false,
    transportOpen: false,
    boundUid: signalSocketBoundUid,
    boundMode: signalSocketBoundMode,
    boundAccountKey: signalSocketBoundAccountKey,
    lastRecoveryReason: reason,
    lastRecoveryThrottledAt: null,
    lastEngineAt: null,
    lastEngineStatus: null,
    lastSnapshotAt: null,
    lastSnapshotAsset: null
  });
}

async function closeSignalSocketIfBindingStale(reason = 'account_context_changed') {
  const context = await currentSignalBindingContext();
  if (!signalSocket) return { context, closed: false };
  if (signalSocketBindingMatchesContext(context)) return { context, closed: false };
  markSignalBindingChanged(reason);
  closeServerSignalSocket(reason, false);
  return { context, closed: true };
}

async function recoverPersistentSignalChannel(reason = 'watchdog', options = {}) {
  await restoreSignalSubscriptionState({ force: true });
  const snapshot = signalSubscriptionSnapshot();
  if (!snapshot.enabled || !snapshot.controllerTabId) return { ok: false, status: 'idle', error: 'no_active_subscription' };
  const controllerTab = await chrome.tabs.get(snapshot.controllerTabId).catch(() => null);
  if (!controllerTab?.id || !isPocketTerminalUrl(controllerTab.url) || !isPocketPotentialAccountUrl(controllerTab.url)) {
    return { ok: false, status: 'offline', error: 'signal_controller_not_on_trading_account' };
  }
  const stored = await chrome.storage.local.get(['poBridgeState', 'poBridgeSettings']).catch(() => ({}));
  if (stored.poBridgeSettings?.autoTrade?.enabled !== true) return { ok: false, status: 'idle', error: 'autotrade_off' };

  // Never recover a persistent signal channel from storage alone. A service-worker
  // restart can leave poBridgeState looking connected even though the live Pocket
  // page/socket has already disappeared or changed account. Ask the controller tab
  // for its current compact state and bind recovery to that live answer.
  let liveBridgeState = null;
  try {
    const live = await chrome.tabs.sendMessage(controllerTab.id, { type: 'PO_GET_STATE' });
    liveBridgeState = live?.ok !== false ? (live?.state || null) : null;
  } catch {}
  if (!isConnected(liveBridgeState)) return { ok: false, status: 'offline', error: 'signal_controller_not_live' };

  const storedKey = signalAccountIdentityFromBridgeState(stored.poBridgeState || null)?.key || null;
  const liveKey = signalAccountIdentityFromBridgeState(liveBridgeState)?.key || null;
  if (!liveKey) return { ok: false, status: 'offline', error: 'signal_controller_identity_missing' };

  // Use the controller's live state as the source of truth for the recovery that
  // follows. This also repairs a stale/offline stored state with the same UID.
  await chrome.storage.local.set({ poBridgeState: liveBridgeState }).catch(() => null);
  if (storedKey !== liveKey) {
    markSignalBindingChanged(`${reason}_live_identity_refresh`);
    if (signalSocket) closeServerSignalSocket('signal_controller_identity_changed', false);
  }

  const now = Date.now();
  const bindingCheck = await closeSignalSocketIfBindingStale(`${reason}_binding_check`).catch(() => ({ closed: false }));
  if (bindingCheck?.closed) signalLastRecoveryAttemptAt = 0;
  const force = options?.force === true
    || bindingCheck?.closed === true
    || reason === 'manual_force'
    || reason === 'scheduled_soft_reconnect'
    || reason === 'pocket_tab_ready';
  if (!force && signalLastRecoveryAttemptAt && now - signalLastRecoveryAttemptAt < SIGNAL_RECOVERY_COOLDOWN_MS) {
    persistSignalDiagnostics({
      lastRecoveryThrottledAt: new Date().toISOString(),
      lastRecoveryReason: reason
    });
    if (signalSocket?.readyState === WebSocket.OPEN) {
      try { signalSocket.send(JSON.stringify({ type: 'ping', ts: now, source: reason })); } catch {}
      sendSignalSubscription();
      return { ok: true, status: signalSocketAnalysisReady ? 'online' : 'analyzing', analysisReady: signalSocketAnalysisReady, throttled: true };
    }
    return { ok: true, status: signalSocket ? 'connecting' : 'reconnecting', throttled: true };
  }
  signalLastRecoveryAttemptAt = now;

  if (signalSocket?.readyState === WebSocket.OPEN) {
    sendSignalSubscription({ force });
    try { signalSocket.send(JSON.stringify({ type: 'ping', ts: Date.now(), source: reason })); } catch {}
    return { ok: true, status: signalSocketAnalysisReady ? 'online' : 'analyzing', analysisReady: signalSocketAnalysisReady };
  }
  persistSignalDiagnostics({
    lastRecoveryAt: new Date().toISOString(),
    lastRecoveryReason: reason,
    recoveryCount: Math.max(0, Number(signalDiagnostics.recoveryCount) || 0) + 1
  });
  return ensureServerSignalSocket();
}

function serverStateRecentlyUsable(serverState, expectedUid = null) {
  const lastSync = Date.parse(serverState?.lastSyncAt || '');
  const uid = expectedUid == null ? '' : String(expectedUid).trim();
  const tokenUid = String(serverState?.sessionUid || '').trim();
  const stateUid = String(serverState?.pocketUid || '').trim();
  if (uid && (tokenUid !== uid || stateUid !== uid)) return false;
  return Boolean(
    serverState?.sessionToken
    && (
      serverState?.online
      || (Number.isFinite(lastSync) && Date.now() - lastSync <= 15 * 60 * 1000)
    )
  );
}

function selectSignalController() {
  const active = [...signalSubscriptions.entries()].filter(([, item]) => item.enabled !== false);
  if (!active.length) { signalControllerTabId = null; return null; }
  if (signalControllerTabId && active.some(([tabId]) => tabId === signalControllerTabId)) return signalControllerTabId;
  active.sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0));
  signalControllerTabId = active[0][0];
  return signalControllerTabId;
}

function signalSubscriptionSnapshot() {
  const controllerId = selectSignalController();
  const item = controllerId ? signalSubscriptions.get(controllerId) : null;
  if (!item || item.enabled === false) return { enabled: false, assets: [], strategyId: '', strategyIds: [], strategyMode: 'best', candleMode: 'closed', candleOffset: -1, period: 60, duration: 60, strategyPeriods: {}, strategyDurations: {}, strategyCandleOffsets: {}, strategyCooldowns: {}, localConfigRevision: 0, controllerTabId: null };
  const assets = [...new Set((item.assets || []).filter(Boolean).map(String))];
  const values = Array.isArray(item.strategyIds) ? item.strategyIds : [item.strategyId];
  const strategyIds = [...new Set(values.filter(Boolean).map(String))];
  const candleOffset = [0, -1, -2].includes(Number(item.candleOffset)) ? Number(item.candleOffset) : (item.candleMode === 'current' ? 0 : -1);
  const period = Math.max(1, Math.min(86400, Math.round(Number(item.period) || 60)));
  const duration = Math.max(1, Math.min(86400, Math.round(Number(item.duration) || 60)));
  return {
    enabled: true,
    assets,
    strategyId: strategyIds[0] || '',
    strategyIds,
    strategyMode: String(item.strategyMode) === 'independent' ? 'independent' : 'best',
    candleMode: candleOffset === 0 ? 'current' : 'closed',
    candleOffset,
    period,
    duration,
    strategyPeriods: normalizeSignalNumberMap(item.strategyPeriods, strategyIds, period, { min: 1 }),
    strategyDurations: normalizeSignalNumberMap(item.strategyDurations, strategyIds, duration, { min: 1 }),
    strategyCandleOffsets: normalizeSignalOffsetMap(item.strategyCandleOffsets, strategyIds, candleOffset),
    strategyCooldowns: normalizeSignalNumberMap(item.strategyCooldowns, strategyIds, 0, { min: 0, max: 86400, integer: false }),
    localConfigRevision: Math.max(0, Math.round(Number(item.localConfigRevision) || 0)),
    controllerTabId: controllerId
  };
}

async function notifySignalSubscribers(message, { controllerOnly = false } = {}) {
  const controllerId = selectSignalController();
  const tabIds = controllerOnly ? (controllerId ? [controllerId] : []) : [...signalSubscriptions.keys()];
  await Promise.all(tabIds.map((tabId) => chrome.tabs.sendMessage(tabId, message).catch(() => null)));
}

async function notifyPocketTabs(message) {
  const tabs = await findPocketTabs().catch(() => []);
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => null)));
}


async function storeServerAnnouncement(item) {
  if (!item || typeof item !== 'object') return;
  const current = (await chrome.storage.local.get('ptServerState')).ptServerState || {};
  const id = String(item.id ?? '');
  const existing = Array.isArray(current.broadcasts) ? current.broadcasts : [];
  const broadcasts = [item, ...existing.filter((entry) => String(entry?.id ?? '') !== id)].slice(0, 20);
  await chrome.storage.local.set({ ptServerState: { ...current, broadcasts } });
}

function entitlementCode(entitlement) {
  const accessState = String(entitlement?.accessState || '').toUpperCase();
  if (accessState) return accessState.toLowerCase();
  const status = String(entitlement?.status || 'active').toLowerCase();
  const source = String(entitlement?.source || 'free').toLowerCase();
  if (status === 'blocked') return 'blocked';
  if (entitlement?.premium && source === 'trial' && status === 'active') return 'trial_active';
  if (entitlement?.premium && status === 'active') return 'premium_active';
  if (source !== 'free' && status === 'paused') return 'premium_paused';
  return 'free_active';
}

function premiumSourceLabel(source, language = 'ru') {
  const dictionaries = {
    ru: { owner: 'доступ владельца', affiliate: 'доступ за регистрацию и депозит', paid: 'платный доступ', manual: 'доступ, выданный администратором', trial: 'пробный доступ', fallback: 'Premium-доступ' },
    en: { owner: 'owner access', affiliate: 'registration and deposit access', paid: 'paid access', manual: 'administrator-issued access', trial: 'trial access', fallback: 'Premium access' },
    es: { owner: 'acceso del propietario', affiliate: 'acceso por registro y depósito', paid: 'acceso de pago', manual: 'acceso concedido por el administrador', trial: 'acceso de prueba', fallback: 'acceso Premium' },
    hi: { owner: 'मालिक एक्सेस', affiliate: 'रजिस्ट्रेशन और डिपॉजिट एक्सेस', paid: 'भुगतान किया हुआ एक्सेस', manual: 'एडमिन द्वारा दिया गया एक्सेस', trial: 'ट्रायल एक्सेस', fallback: 'Premium एक्सेस' },
    ar: { owner: 'وصول المالك', affiliate: 'وصول التسجيل والإيداع', paid: 'وصول مدفوع', manual: 'وصول ممنوح من المشرف', trial: 'وصول تجريبي', fallback: 'وصول Premium' }
  };
  const dictionary = dictionaries[normalizeBackgroundLanguage(language)] || dictionaries.ru;
  return dictionary[String(source || '').toLowerCase()] || dictionary.fallback;
}

async function handleEntitlementTransition(previousState, nextState) {
  const previous = previousState?.entitlement || null;
  const next = nextState?.entitlement || null;
  if (!next) return;
  const previousCode = entitlementCode(previous);
  const nextCode = entitlementCode(next);
  const stateChanged = previousCode !== nextCode || String(previous?.source || '') !== String(next?.source || '') || String(previous?.expiresAt || '') !== String(next?.expiresAt || '');
  if (!stateChanged) return;

  const nextFeatures = next.features || {};
  if (next.registrationRequired || nextFeatures.autoTrading === false) {
    const stored = await chrome.storage.local.get(['poBridgeSettings', 'poAutoTradeStatus']).catch(() => ({}));
    const currentSettings = stored.poBridgeSettings || {};
    const currentAuto = currentSettings.autoTrade || {};
    await chrome.storage.local.set({
      poBridgeSettings: { ...currentSettings, autoTrade: { ...currentAuto, enabled: false } },
      poAutoTradeStatus: { ...(stored.poAutoTradeStatus || {}), running: false, enabled: false, reason: next.registrationRequired ? 'REGISTRATION_REQUIRED' : 'AUTOTRADING_UNAVAILABLE', updatedAt: new Date().toISOString() }
    }).catch(() => null);
  }
  if (!(next.premium || next.remoteControl || nextFeatures.remoteControl)) {
    await disableRemoteControl().catch(() => null);
  }

  const language = await getBackgroundLanguage();
  const copy = BACKGROUND_UI[language];

  let notice = null;
  if (nextCode === 'trial_active') {
    notice = { kind: 'trial', title: 'TRIAL Premium активирован', message: 'Полный Premium автоматически доступен на 24 часа. Таймер отображается рядом со строкой статуса.' };
  } else if (nextCode === 'premium_active') {
    const restored = previousCode === 'premium_paused';
    notice = {
      kind: 'premium',
      title: restored ? copy.premiumRestored : copy.premiumActivated,
      message: restored ? copy.restoredMessage : `${premiumSourceLabel(next.source, language)}${copy.confirmedSuffix}`,
    };
  } else if (nextCode === 'premium_paused') {
    notice = {
      kind: 'paused',
      title: copy.pausedTitle,
      message: copy.pausedMessage
    };
  } else if (nextCode === 'trial_expired') {
    notice = { kind: 'registration_required', title: 'TRIAL Premium завершён', message: 'Зарегистрируйте новый аккаунт Pocket Option по партнёрской ссылке Pocket TRADE ROBOT, чтобы продолжить торговлю.' };
  } else if (nextCode === 'affiliate_registered') {
    notice = { kind: 'affiliate_registered', title: 'Регистрация подтверждена', message: 'До депозита от $10 доступен только DEMO: до 30 активов и 50 сделок в сутки. После подтверждения депозита ограничения снимаются.' };
  } else if (nextCode === 'blocked') {
    notice = { kind: 'blocked', title: copy.blockedTitle, message: copy.supportMessage };
  } else if (previousCode === 'premium_active' || previousCode === 'premium_paused' || previousCode === 'trial_active') {
    notice = { kind: 'free', title: copy.freeTitle, message: copy.freeMessage };
  }
  if (!notice) return;
  const key = `${nextState?.pocketUid || ''}:${nextCode}:${next.source || ''}:${next.expiresAt || ''}:${notice.title}`;
  const stored = await chrome.storage.local.get('ptLastAccessNotificationKey');
  if (stored.ptLastAccessNotificationKey === key) return;
  const payload = { id: crypto.randomUUID(), key, ...notice, plan: next.plan || 'FREE', status: next.status || 'active', source: next.source || 'free', createdAt: new Date().toISOString() };
  await chrome.storage.local.set({ ptAccessNotification: payload, ptLastAccessNotificationKey: key });
  await notifyPocketTabs({ type: 'PT_ACCESS_NOTIFICATION', notification: payload });
}

function clearSignalSocketTimers() {
  if (signalSocketPingTimer) clearInterval(signalSocketPingTimer);
  if (signalSocketWatchdogTimer) clearInterval(signalSocketWatchdogTimer);
  if (signalSocketReconnectTimer) clearTimeout(signalSocketReconnectTimer);
  if (signalSocketSoftReconnectTimer) clearTimeout(signalSocketSoftReconnectTimer);
  signalSocketPingTimer = null;
  signalSocketWatchdogTimer = null;
  signalSocketReconnectTimer = null;
  signalSocketSoftReconnectTimer = null;
}

function rememberSignalSnapshotContext(snapshotId) {
  const id = String(snapshotId || '');
  if (!id) return;
  const now = Date.now();
  for (const [key, item] of signalSnapshotContexts.entries()) {
    if (!item?.createdAt || now - item.createdAt > SIGNAL_SNAPSHOT_CONTEXT_TTL_MS) signalSnapshotContexts.delete(key);
  }
  if (signalSnapshotContexts.size >= 5000) {
    const oldest = [...signalSnapshotContexts.entries()]
      .sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0))
      .slice(0, Math.max(1, signalSnapshotContexts.size - 4500));
    oldest.forEach(([key]) => signalSnapshotContexts.delete(key));
  }
  signalSnapshotContexts.set(id, {
    subscriptionKey: signalSubscriptionWireKey,
    accountKey: signalSocketBoundAccountKey,
    subscriptionRevision: signalSubscriptionRevision,
    socketGeneration: signalSocketGeneration,
    createdAt: now
  });
}

function consumeSignalSnapshotContext(snapshotId) {
  const id = String(snapshotId || '');
  if (!id) return null;
  const item = signalSnapshotContexts.get(id) || null;
  signalSnapshotContexts.delete(id);
  return item;
}

function signalSnapshotContextIsCurrent(item) {
  if (!item) return false;
  return item.subscriptionKey === signalSubscriptionWireKey
    && item.accountKey === signalSocketBoundAccountKey
    && Number(item.subscriptionRevision || 0) === Number(signalSubscriptionRevision || 0)
    && Number(item.socketGeneration || 0) === Number(signalSocketGeneration || 0);
}

function resolveSnapshotAck(snapshotId, result) {
  const id = String(snapshotId || '');
  if (!id) return false;
  const pendingAck = pendingSnapshotAcks.get(id);
  if (!pendingAck) return false;
  pendingSnapshotAcks.delete(id);
  clearTimeout(pendingAck.timer);
  const latencyMs = pendingAck.sentAt ? Math.max(0, Date.now() - Number(pendingAck.sentAt)) : null;
  persistSignalDiagnostics({
    lastMarketAckAt: new Date().toISOString(),
    lastMarketAckLatencyMs: latencyMs,
    lastMarketAckCode: result?.error || result?.code || (result?.ok === false ? 'rejected' : 'ok'),
    pendingSnapshotAcks: pendingSnapshotAcks.size,
    webSocketBufferedAmount: Number(signalSocket?.bufferedAmount || 0)
  });
  pendingAck.resolve({ ...(result || {}), ackLatencyMs: latencyMs });
  return true;
}

function failPendingSnapshotAcks(reason = 'signal_socket_closed') {
  for (const [snapshotId, pendingAck] of pendingSnapshotAcks.entries()) {
    clearTimeout(pendingAck.timer);
    pendingAck.resolve({ ok: false, error: reason, snapshotId });
  }
  pendingSnapshotAcks.clear();
  persistSignalDiagnostics({ pendingSnapshotAcks: 0, webSocketBufferedAmount: Number(signalSocket?.bufferedAmount || 0) });
}

function closeServerSignalSocket(reason = 'closed', notify = true) {
  clearSignalSocketTimers();
  const socket = signalSocket;
  signalSocket = null;
  signalSocketUrl = null;
  signalSocketLastMessageAt = 0;
  // Keep the last logical subscription key across a transport reconnect. A forced
  // resend of the same configuration must not create a new revision and invalidate
  // signals that were already calculated for that exact configuration.
  signalSocketBoundUid = null;
  signalSocketBoundMode = null;
  signalSocketBoundAccountKey = null;
  signalSocketAnalysisReady = false;
  signalSocketTransportOpenedAt = null;
  signalSocketSubscriptionAckAt = null;
  failPendingSnapshotAcks(reason);
  signalSnapshotContexts.clear();
  if (socket) {
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close(1000, reason);
    } catch {}
  }
  persistSignalDiagnostics({
    status: 'offline',
    disconnectedAt: new Date().toISOString(),
    lastError: reason === 'closed' || reason === 'no_subscriptions' ? null : reason,
    boundUid: null,
    boundMode: null,
    boundAccountKey: null,
    transportOpen: false,
    analysisReady: false,
    transportOpenedAt: null,
    subscriptionAckAt: null
  });
  if (notify) void notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: 'offline', reason });
}

function signalSubscriptionKey(snapshot) {
  return JSON.stringify([
    snapshot.assets,
    snapshot.strategyIds,
    snapshot.strategyMode === 'independent' ? 'independent' : 'best',
    snapshot.candleMode || 'closed',
    snapshot.candleOffset ?? -1,
    snapshot.period || 60,
    snapshot.duration || 60,
    snapshot.strategyPeriods || {},
    snapshot.strategyDurations || {},
    snapshot.strategyCandleOffsets || {},
    snapshot.strategyCooldowns || {},
    snapshot.localConfigRevision || 0
  ]);
}

function sendSignalSubscription({ force = false } = {}) {
  if (!signalSocket || signalSocket.readyState !== WebSocket.OPEN) return false;
  const snapshot = signalSubscriptionSnapshot();
  const nextKey = signalSubscriptionKey(snapshot);
  const subscriptionChanged = nextKey !== signalSubscriptionWireKey;
  if (!force && !subscriptionChanged) return false;
  signalSubscriptionWireKey = nextKey;
  if (subscriptionChanged || signalSubscriptionRevision <= 0) signalSubscriptionRevision += 1;
  if (subscriptionChanged || force) {
    signalSocketAnalysisReady = false;
    signalSocketSubscriptionAckAt = null;
  }
  signalSocket.send(JSON.stringify({
    type: 'subscribe',
    assets: snapshot.assets,
    strategyId: snapshot.strategyId || '',
    strategyIds: snapshot.strategyIds || [],
    strategyMode: snapshot.strategyMode === 'independent' ? 'independent' : 'best',
    candleMode: snapshot.candleMode || 'closed',
    candleOffset: snapshot.candleOffset ?? -1,
    period: snapshot.period || 60,
    duration: snapshot.duration || 60,
    strategyPeriods: snapshot.strategyPeriods || {},
    strategyDurations: snapshot.strategyDurations || {},
    strategyCandleOffsets: snapshot.strategyCandleOffsets || {},
    strategyCooldowns: snapshot.strategyCooldowns || {},
    localConfigRevision: snapshot.localConfigRevision || 0,
    subscriptionRevision: signalSubscriptionRevision
  }));
  persistSignalDiagnostics({
    status: subscriptionChanged ? 'subscribing' : (signalSocketAnalysisReady ? 'online' : (signalSocketSubscriptionAckAt ? 'analyzing' : 'subscribing')),
    subscribedAssets: snapshot.assets.length,
    strategyIds: snapshot.strategyIds,
    strategyMode: snapshot.strategyMode === 'independent' ? 'independent' : 'best',
    candleMode: snapshot.candleMode || 'closed',
    candleOffset: snapshot.candleOffset ?? -1,
    strategyPeriods: snapshot.strategyPeriods || {},
    strategyDurations: snapshot.strategyDurations || {},
    lastSubscribedAt: new Date().toISOString(),
    lastError: null,
    analysisReady: signalSocketAnalysisReady,
    subscriptionAckAt: signalSocketSubscriptionAckAt,
    subscriptionRevision: signalSubscriptionRevision,
    socketGeneration: signalSocketGeneration
  });
  const visibleStatus = subscriptionChanged ? 'subscribing' : (signalSocketAnalysisReady ? 'online' : (signalSocketSubscriptionAckAt ? 'analyzing' : 'subscribing'));
  void notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: visibleStatus, analysisReady: signalSocketAnalysisReady }, { controllerOnly: true });
  return true;
}

function scheduleSignalSocketReconnect(reason = 'temporary_connection_error') {
  if (signalSocketReconnectTimer || !signalSubscriptionSnapshot().enabled) return false;
  signalSocketReconnectAttempt += 1;
  persistSignalDiagnostics({
    status: 'reconnecting',
    reconnectAttempts: signalSocketReconnectAttempt,
    lastError: reason || signalDiagnostics.lastError || null
  });
  void notifySignalSubscribers({
    type: 'PT_SIGNAL_SOCKET_STATUS',
    status: 'reconnecting',
    reason: 'Временная ошибка связи. Переподключаем канал…'
  });
  const baseDelay = Math.min(30000, 900 * Math.pow(1.7, Math.min(signalSocketReconnectAttempt, 7)));
  const jitter = Math.floor(Math.random() * Math.min(1400, baseDelay * 0.2));
  signalSocketReconnectTimer = setTimeout(() => {
    signalSocketReconnectTimer = null;
    void ensureServerSignalSocket().catch((error) => {
      const nextReason = String(error?.message || error || 'signal_socket_connect_failed');
      persistSignalDiagnostics({ status: 'reconnecting', lastError: nextReason });
      scheduleSignalSocketReconnect(nextReason);
    });
  }, Math.round(baseDelay + jitter));
  return true;
}

async function connectServerSignalSocket() {
  const connectBindingRevision = signalSocketBindingRevision;
  await signalDiagnosticsReady;
  await restoreSignalSubscriptionState();
  const snapshot = signalSubscriptionSnapshot();
  if (!snapshot.enabled) {
    signalSocketReconnectAttempt = 0;
    closeServerSignalSocket('no_subscriptions', false);
    return { ok: true, status: 'idle' };
  }
  const stored = await chrome.storage.local.get(['ptServerState', 'poBridgeState']);
  let serverState = stored.ptServerState || null;
  const bridgeState = stored.poBridgeState || null;
  const connected = isConnected(bridgeState);
  const bridgeContext = signalAccountContextFromBridgeState(bridgeState);
  let token = serverState?.sessionToken;
  const serverUidBeforeRefresh = serverState?.pocketUid != null ? String(serverState.pocketUid).trim() : '';
  const uidMismatchBeforeRefresh = Boolean(connected && bridgeContext?.uid && serverUidBeforeRefresh !== bridgeContext.uid);

  if (connected && (!token || !serverStateRecentlyUsable(serverState, bridgeContext?.uid) || uidMismatchBeforeRefresh)) {
    persistSignalDiagnostics({ status: 'reconnecting', lastError: !token ? 'session_missing_refreshing' : 'server_session_refreshing' });
    serverState = await syncServer({ forceBootstrap: true }).catch(() => serverState);
    token = serverState?.sessionToken;
  }

  const refreshedServerUid = serverState?.pocketUid != null ? String(serverState.pocketUid).trim() : '';
  const bindingContext = signalAccountContextFromBridgeState(bridgeState);
  const uidMismatch = Boolean(bindingContext?.uid && refreshedServerUid !== bindingContext.uid);

  if (!connected || !bindingContext || !token || !serverStateRecentlyUsable(serverState, bindingContext?.uid) || uidMismatch) {
    const reason = !connected || !bindingContext
      ? 'account_offline'
      : uidMismatch
        ? 'server_uid_mismatch'
        : !token
          ? 'session_missing'
          : 'server_offline';
    if (connected && reason !== 'account_offline') {
      void syncServer({ forceBootstrap: true }).then(() => scheduleSignalSocketReconnect('server_session_refresh')).catch(() => null);
    }
    closeServerSignalSocket(reason);
    return { ok: false, status: 'offline', error: reason };
  }

  const desiredBinding = {
    uid: bindingContext.uid,
    mode: bindingContext.mode,
    key: bindingContext.key
  };
  if (signalSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(signalSocket.readyState)) {
    const bindingMatches = signalSocketBoundAccountKey === desiredBinding.key
      && signalSocketBoundUid === desiredBinding.uid;
    if (!bindingMatches) {
      markSignalBindingChanged('account_context_changed');
      closeServerSignalSocket('account_context_changed', false);
    } else {
      if (signalSocket.readyState === WebSocket.OPEN) sendSignalSubscription();
      const status = signalSocket.readyState === WebSocket.OPEN
        ? (signalSocketAnalysisReady ? 'online' : 'analyzing')
        : 'connecting';
      return { ok: true, status, analysisReady: signalSocketAnalysisReady };
    }
  }

  let wsTicket;
  try {
    wsTicket = await getSignalSocketTicket();
  } catch (error) {
    const reason = String(error?.message || error);
    closeServerSignalSocket(reason, false);
    scheduleSignalSocketReconnect(reason);
    return { ok: false, status: 'reconnecting', transient: true, error: reason };
  }
  if (!signalSubscriptionSnapshot().enabled) {
    signalSocketReconnectAttempt = 0;
    closeServerSignalSocket('autotrade_off', false);
    return { ok: true, status: 'idle' };
  }
  // Ticket acquisition is asynchronous. If UID/MODE changed while the request was
  // in flight, never instantiate a socket with the stale account ticket.
  if (connectBindingRevision !== signalSocketBindingRevision) {
    return { ok: false, status: 'reconnecting', transient: true, error: 'signal_binding_changed_during_connect' };
  }
  const latestBindingContext = await currentSignalBindingContext().catch(() => null);
  if (!latestBindingContext?.bridge
      || latestBindingContext.bridge.key !== desiredBinding.key
      || (latestBindingContext.serverUid && latestBindingContext.serverUid !== desiredBinding.uid)) {
    markSignalBindingChanged('signal_binding_changed_after_ticket');
    return { ok: false, status: 'reconnecting', transient: true, error: 'signal_binding_changed_after_ticket' };
  }
  const baseUrl = wsTicket.wsUrl || serverState?.wsUrl || 'wss://ws.pockettraderobot.online/ws/v1/signals';
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(wsTicket.ticket)}`;
  closeServerSignalSocket('reconnect', false);
  const socket = new WebSocket(url);
  signalSocketGeneration += 1;
  signalSocket = socket;
  signalSocketUrl = url;
  signalSocketBoundUid = desiredBinding.uid;
  signalSocketBoundMode = desiredBinding.mode;
  signalSocketBoundAccountKey = desiredBinding.key;
  signalSocketAnalysisReady = false;
  signalSocketTransportOpenedAt = null;
  signalSocketSubscriptionAckAt = null;
  persistSignalDiagnostics({
    status: 'connecting',
    lastError: null,
    boundUid: signalSocketBoundUid,
    boundMode: signalSocketBoundMode,
    boundAccountKey: signalSocketBoundAccountKey,
    transportOpen: false,
    analysisReady: false,
    transportOpenedAt: null,
    subscriptionAckAt: null,
    socketGeneration: signalSocketGeneration,
    subscriptionRevision: signalSubscriptionRevision,
    lastEngineAt: null,
    lastEngineStatus: null,
    lastEngineStatusAt: null
  });
  await notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: 'connecting' });

  socket.onopen = () => {
    if (signalSocket !== socket) return;
    signalSocketReconnectAttempt = 0;
    signalSocketLastMessageAt = Date.now();
    signalSocketAnalysisReady = false;
    signalSocketTransportOpenedAt = new Date().toISOString();
    signalSocketSubscriptionAckAt = null;
    persistSignalDiagnostics({
      status: 'subscribing',
      connectedAt: new Date().toISOString(),
      disconnectedAt: null,
      lastMessageAt: new Date().toISOString(),
      reconnectAttempts: 0,
      lastError: null,
      lastRecoveryAt: new Date().toISOString(),
      lastRecoveryReason: signalDiagnostics.lastRecoveryReason || 'socket_open',
      boundUid: signalSocketBoundUid,
      boundMode: signalSocketBoundMode,
      boundAccountKey: signalSocketBoundAccountKey,
      transportOpen: true,
      analysisReady: false,
      transportOpenedAt: signalSocketTransportOpenedAt,
      subscriptionAckAt: null
    });
    sendSignalSubscription({ force: true });
    signalSocketPingTimer = setInterval(() => {
      try {
        if (signalSocket === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }
      } catch {}
    }, 20000);
    signalSocketWatchdogTimer = setInterval(() => {
      if (signalSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (signalSocketLastMessageAt && Date.now() - signalSocketLastMessageAt > 70000) {
        try { socket.close(4000, 'heartbeat_timeout'); } catch {}
      }
    }, 10000);
    signalSocketSoftReconnectTimer = setTimeout(() => {
      if (signalSocket !== socket || socket.readyState !== WebSocket.OPEN || !signalSubscriptionSnapshot().enabled) return;
      persistSignalDiagnostics({ lastSoftReconnectAt: new Date().toISOString(), lastRecoveryReason: 'scheduled_soft_reconnect' });
      void notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: 'reconnecting', reason: 'Плановое обновление канала сигналов…', soft: true }, { controllerOnly: true });
      try { socket.close(4001, 'scheduled_soft_reconnect'); } catch {}
    }, SIGNAL_SOFT_RECONNECT_MS);
  };

  function snapshotCapacityFromServerMessage(message) {
    const raw = message?.snapshotCapacity && typeof message.snapshotCapacity === 'object'
      ? message.snapshotCapacity
      : {};
    const maxParallel = Math.max(0, Math.min(16, Number(raw.maxParallelEvaluations) || 0));
    const schedulerWorkers = Math.max(0, Math.min(16, Number(raw.schedulerWorkers) || 0));
    const recommendedWorkers = Math.max(2, Math.min(8, Number(raw.recommendedClientWorkers) || maxParallel || schedulerWorkers || 4));
    return { maxParallel, schedulerWorkers, recommendedWorkers };
  }

  socket.onmessage = (event) => {
    if (signalSocket !== socket) return;
    signalSocketLastMessageAt = Date.now();
    try {
      const message = JSON.parse(String(event.data || '{}'));
      persistSignalDiagnostics({
        status: signalSocketAnalysisReady ? 'online' : (signalSocketSubscriptionAckAt ? 'analyzing' : 'subscribing'),
        lastMessageAt: new Date().toISOString(),
        messages: signalDiagnostics.messages + 1,
        lastError: null,
        transportOpen: true,
        analysisReady: signalSocketAnalysisReady
      });
      if (message.type === 'hello' && message.snapshotCapacity) {
        const capacity = snapshotCapacityFromServerMessage(message);
        persistSignalDiagnostics({
          serverSnapshotMaxParallel: capacity.maxParallel,
          serverSnapshotRecommendedWorkers: capacity.recommendedWorkers,
          serverSnapshotSchedulerWorkers: capacity.schedulerWorkers
        });
        void notifySignalSubscribers({
          type: 'PT_SIGNAL_SOCKET_STATUS',
          status: signalSocketAnalysisReady ? 'online' : (signalSocketSubscriptionAckAt ? 'analyzing' : 'subscribing'),
          snapshotWorkersRecommended: capacity.recommendedWorkers,
          snapshotWorkersServerMax: capacity.maxParallel,
          snapshotSchedulerWorkers: capacity.schedulerWorkers
        }, { controllerOnly: true });
      }
      if (message.type === 'hello' && message.pocketUid != null) {
        const serverHelloUid = String(message.pocketUid).trim();
        if (signalSocketBoundUid && serverHelloUid && serverHelloUid !== signalSocketBoundUid) {
          persistSignalDiagnostics({
            status: 'error',
            lastError: 'signal_uid_mismatch',
            boundUid: signalSocketBoundUid,
            analysisReady: false
          });
          try { socket.close(4003, 'signal_uid_mismatch'); } catch {}
          return;
        }
      }
      if (message.type === 'signal' && message.signal) {
        const signalRevision = Number(message.subscriptionRevision ?? message.signal?.subscriptionRevision ?? 0);
        if (signalRevision > 0 && signalRevision !== Number(signalSubscriptionRevision || 0)) {
          persistSignalDiagnostics({
            staleSignals: Math.max(0, Number(signalDiagnostics.staleSignals) || 0) + 1,
            lastStaleSignalAt: new Date().toISOString()
          });
          return;
        }
        persistSignalDiagnostics({
          signals: signalDiagnostics.signals + 1,
          lastSignalAt: new Date().toISOString()
        });
        void notifySignalSubscribers({
          type: 'PT_SERVER_SIGNAL',
          signal: { ...message.signal, subscriptionRevision: signalRevision || signalSubscriptionRevision }
        }, { controllerOnly: true });
      } else if (message.type === 'hello' && message.entitlement) {
        void (async () => {
          const current = (await chrome.storage.local.get('ptServerState')).ptServerState || {};
          await chrome.storage.local.set({
            ptServerState: {
              ...current,
              online: true,
              syncDegraded: false,
              lastSyncAt: new Date().toISOString(),
              lastError: null,
              entitlement: message.entitlement,
              strategies: Array.isArray(message.strategies) ? message.strategies : (current.strategies || [])
            }
          });
        })();
      } else if (message.type === 'entitlement' && message.entitlement) {
        void (async () => {
          const current = (await chrome.storage.local.get('ptServerState')).ptServerState || {};
          await chrome.storage.local.set({
            ptServerState: {
              ...current,
              online: true,
              syncDegraded: false,
              lastSyncAt: new Date().toISOString(),
              lastError: null,
              entitlement: message.entitlement,
              strategies: Array.isArray(message.strategies) ? message.strategies : (current.strategies || [])
            }
          });
        })();
      } else if (message.type === 'subscription_error') {
        const reason = String(message.error || 'subscription_error');
        signalSocketAnalysisReady = false;
        signalSocketSubscriptionAckAt = null;
        persistSignalDiagnostics({ status: 'error', lastError: reason, analysisReady: false, subscriptionAckAt: null });
        void notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: 'error', reason }, { controllerOnly: true });
      } else if (message.type === 'subscribed') {
        const subscribedUid = message.pocketUid != null ? String(message.pocketUid).trim() : '';
        if (subscribedUid && signalSocketBoundUid && subscribedUid !== signalSocketBoundUid) {
          persistSignalDiagnostics({ status: 'error', lastError: 'signal_subscription_uid_mismatch', analysisReady: false });
          try { socket.close(4003, 'signal_subscription_uid_mismatch'); } catch {}
          return;
        }
        signalSocketSubscriptionAckAt = new Date().toISOString();
        signalSocketAnalysisReady = false;
        const capacity = snapshotCapacityFromServerMessage(message);
        // New asset/strategy subscription must not expose readiness from a previous
        // cycle. Clear stale engine data before the first bootstrap snapshot.
        persistSignalDiagnostics({
          status: 'analyzing',
          subscribedAssets: Array.isArray(message.assets) ? message.assets.length : signalDiagnostics.subscribedAssets,
          strategyIds: Array.isArray(message.strategyIds) ? message.strategyIds : signalDiagnostics.strategyIds,
          strategyMode: message.strategyMode === 'independent' ? 'independent' : 'best',
          candleMode: message.candleMode || signalDiagnostics.candleMode || 'closed',
          candleOffset: [0, -1, -2].includes(Number(message.candleOffset)) ? Number(message.candleOffset) : (message.candleMode === 'current' ? 0 : -1),
          transportOpen: true,
          analysisReady: false,
          subscriptionAckAt: signalSocketSubscriptionAckAt,
          subscriptionRevision: signalSubscriptionRevision,
          socketGeneration: signalSocketGeneration,
          lastEngineAt: null,
          lastEngineStatus: null,
          lastEngineStatusAt: null,
          serverSnapshotMaxParallel: capacity.maxParallel,
          serverSnapshotRecommendedWorkers: capacity.recommendedWorkers,
          serverSnapshotSchedulerWorkers: capacity.schedulerWorkers
        });
        void notifySignalSubscribers({
          type: 'PT_SIGNAL_SOCKET_STATUS',
          status: 'analyzing',
          analysisReady: false,
          snapshotWorkersRecommended: capacity.recommendedWorkers,
          snapshotWorkersServerMax: capacity.maxParallel,
          snapshotSchedulerWorkers: capacity.schedulerWorkers
        }, { controllerOnly: true });
      } else if (message.type === 'market_ack') {
        const ackReason = String(message.code || message.error || '').trim().toLowerCase();
        const rateLimited = ackReason === 'snapshot_rate_limited'
          || ackReason === 'rate_limited'
          || ackReason.includes('rate_limit');
        const rejected = message.ok === false || rateLimited;
        const ack = {
          ok: !rejected,
          accepted: !rejected,
          duplicate: Boolean(message.duplicate),
          queued: Boolean(message.queued),
          coalesced: Boolean(message.coalesced),
          transient: Boolean(message.transient || rateLimited),
          retryable: Boolean(message.retryable || rateLimited),
          backpressure: Boolean(message.backpressure || message.busy || rateLimited || message.code === 'SERVER_BUSY' || message.code === 'BACKPRESSURE'),
          code: message.code || null,
          error: message.error || null,
          missingStrategyIds: Array.isArray(message.missingStrategyIds) ? message.missingStrategyIds.map(String).filter(Boolean) : [],
          retryAfterMs: Number(message.retryAfterMs) || 0,
          pending: Number(message.pending) || 0,
          pendingGlobal: Number(message.pendingGlobal) || 0,
          limit: Number(message.limit) || 0,
          limitGlobal: Number(message.limitGlobal) || 0,
          snapshotId: message.snapshotId || null,
          asset: message.asset || null,
          snapshotKey: message.snapshotKey || null
        };
        const resolvedAck = resolveSnapshotAck(message.snapshotId, ack);
        if (!resolvedAck) {
          persistSignalDiagnostics({
            lastMarketAckAt: new Date().toISOString(),
            lastMarketAckLatencyMs: null,
            lastMarketAckCode: ack.error || ack.code || (ack.ok === false ? 'rejected' : 'ok'),
            pendingSnapshotAcks: pendingSnapshotAcks.size,
            webSocketBufferedAmount: Number(signalSocket?.bufferedAmount || 0)
          });
        }
        if (!rejected) persistSignalDiagnostics({ lastError: null });
        if (rejected) {
          consumeSignalSnapshotContext(message.snapshotId);
          persistSignalDiagnostics({
            snapshotErrors: signalDiagnostics.snapshotErrors + 1,
            lastError: message.error || 'market_snapshot_rejected'
          });
        }
      } else if (message.type === 'engine_status') {
        const snapshotContext = consumeSignalSnapshotContext(message.snapshotId);
        if (message.snapshotId && !signalSnapshotContextIsCurrent(snapshotContext)) {
          persistSignalDiagnostics({
            staleEngineStatuses: Math.max(0, Number(signalDiagnostics.staleEngineStatuses) || 0) + 1,
            lastStaleEngineAt: new Date().toISOString()
          });
          return;
        }
        resolveSnapshotAck(message.snapshotId, { ok: true, accepted: true, snapshotId: message.snapshotId || null, asset: message.asset || null, snapshotKey: message.snapshotKey || null });
        const becameReady = signalSocketAnalysisReady !== true;
        signalSocketAnalysisReady = true;
        persistSignalDiagnostics({
          status: 'online',
          lastEngineAt: new Date().toISOString(),
          lastEngineStatusAt: new Date().toISOString(),
          engineEvaluations: signalDiagnostics.engineEvaluations + 1,
          strategyEvaluations: Number(signalDiagnostics.strategyEvaluations || 0) + (Array.isArray(message.evaluations) ? message.evaluations.length : 0),
          engineSignals: signalDiagnostics.engineSignals + Number(message.signals || 0),
          lastEngineStatus: message,
          transportOpen: true,
          analysisReady: true,
          boundUid: signalSocketBoundUid,
          boundMode: signalSocketBoundMode,
          boundAccountKey: signalSocketBoundAccountKey
        });
        if (becameReady) {
          void notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: 'online', analysisReady: true }, { controllerOnly: true });
        }
        void notifySignalSubscribers({ type: 'PT_ENGINE_STATUS', status: message }, { controllerOnly: true });
      } else if (message.type === 'notification' || message.type === 'broadcast') {
        void ingestServerNotifications([message.notification || message.broadcast || message], { showSystemPopup: true }).catch(() => null);
      } else if (message.type === 'announcement') {
        void storeServerAnnouncement(message.announcement || message.broadcast || message).catch(() => null);
      }
    } catch (error) {
      persistSignalDiagnostics({ lastError: `invalid_server_message: ${String(error?.message || error)}` });
    }
  };

  socket.onerror = () => {
    if (signalSocket !== socket) return;
    persistSignalDiagnostics({ status: 'error', lastError: 'signal_socket_error' });
    void notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: 'error' });
  };

  socket.onclose = (event) => {
    if (signalSocket !== socket) return;
    clearSignalSocketTimers();
    signalSocket = null;
    signalSocketUrl = null;
    const reason = event?.reason || (event?.code ? `WS_${event.code}` : 'signal_socket_closed');
    failPendingSnapshotAcks(reason);
    if (signalSubscriptionSnapshot().enabled) {
      persistSignalDiagnostics({
        status: 'reconnecting',
        disconnectedAt: new Date().toISOString(),
        lastError: reason,
        lastSocketCloseCode: event?.code || null,
        lastSocketCloseReason: event?.reason || null
      });
      scheduleSignalSocketReconnect(reason);
    } else {
      persistSignalDiagnostics({
        status: 'offline',
        disconnectedAt: new Date().toISOString(),
        lastError: null,
        lastSocketCloseCode: event?.code || null,
        lastSocketCloseReason: event?.reason || null
      });
      void notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: 'offline', reason: 'autotrade_off' });
    }
  };
  return { ok: true, status: 'connecting' };
}


async function ensureServerSignalSocket() {
  const requestedRevision = signalSocketBindingRevision;
  if (signalSocketConnectPromise) {
    const joined = await signalSocketConnectPromise.catch((error) => ({ ok: false, status: 'error', error: String(error?.message || error) }));
    if (requestedRevision !== signalSocketBindingRevision) return ensureServerSignalSocket();
    return joined;
  }
  const runRevision = signalSocketBindingRevision;
  signalSocketConnectPromise = connectServerSignalSocket();
  let result;
  try {
    result = await signalSocketConnectPromise;
  } finally {
    signalSocketConnectPromise = null;
  }
  if (runRevision !== signalSocketBindingRevision) return ensureServerSignalSocket();
  return result;
}

const ALLOWED_ANALYSIS_PERIOD_SECONDS = Object.freeze([5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 14400, 86400]);

function normalizeAnalysisPeriodSeconds(value, fallback = 60) {
  const raw = Number(value);
  const fallbackValue = Number(fallback);
  const rounded = Math.round(Number.isFinite(raw) && raw > 0 ? raw : (Number.isFinite(fallbackValue) && fallbackValue > 0 ? fallbackValue : 60));
  if (ALLOWED_ANALYSIS_PERIOD_SECONDS.includes(rounded)) return rounded;
  return ALLOWED_ANALYSIS_PERIOD_SECONDS.find((item) => item >= rounded)
    || ALLOWED_ANALYSIS_PERIOD_SECONDS[ALLOWED_ANALYSIS_PERIOD_SECONDS.length - 1];
}

const DEFAULT_SETTINGS = {
  createdAt: new Date().toISOString(),
  asset: 'EURUSD_otc',
  amount: 1,
  duration: 60,
  period: 60,
  confirmTrades: true,
  statusBarVisibilityVersion: 1,
  statusBarVisible: true,
  statusBarCompact: false,
  interfaceDensity: 'compact',
  statusBarPosition: null,
  profitResetMode: 'daily',
  currencyOverride: 'AUTO',
  accessTier: 'FREE',
  serverRequired: true,
  selectedAssets: ['EURUSD_otc'],
  autoTrade: { enabled: false, strategyId: '', strategyIds: [], strategyMode: 'best', candleMode: 'closed', candleOffset: -1, amountMode: 'fixed', amount: 1, balancePercent: 1, maxAmount: 10, expirationMode: 'fixed', expirationMultiplier: 0, duration: 60, period: 60, decisionMode: 'direction_only', cooldown: 5, maxConcurrent: 1, minPayout: 75, direction: 'both', takeProfit: 0, stopLoss: 0, maxTrades: 0, maxLossStreak: 0, maxWinStreak: 0, recoveryMode: 'off', recoveryValue: 2, recoverySteps: 0, recoveryPlan: [{ multiplier: 2, duration: 0, minPayout: 75 }, { multiplier: 4, duration: 0, minPayout: 75 }, { multiplier: 8, duration: 0, minPayout: 75 }, { multiplier: 16, duration: 0, minPayout: 75 }, { multiplier: 32, duration: 0, minPayout: 75 }], recoveryAfterMax: 'stop', recoveryFollowSignal: false, recoveryStartedAt: null, onePerAsset: true, sessionStartedAt: null, riskDefaultsVersion: 7 },
  builderStrategies: []
};

function normalizeStoredSettingsV1080(rawSettings) {
  const incoming = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const incomingAuto = incoming.autoTrade && typeof incoming.autoTrade === 'object' ? incoming.autoTrade : {};
  const auto = { ...DEFAULT_SETTINGS.autoTrade, ...incomingAuto };
  auto.decisionMode = 'direction_only';
  delete auto.minConfidence;
  const riskDefaultsVersion = Number(auto.riskDefaultsVersion || 0);

  if (riskDefaultsVersion < 7) {
    const legacyMode = String(auto.recoveryMode || 'off');
    const legacySteps = Math.min(5, Math.max(0, Number(auto.recoverySteps) || 0));
    if (legacySteps > 0 && ['steps','multiplier','custom','martingale'].includes(legacyMode)) {
      auto.recoveryMode = 'steps';
      // Preserve the user's configured number of steps. Older builds reset this
      // to one during migration, which made later multipliers appear non-working.
      auto.recoverySteps = legacySteps;
    } else {
      auto.recoveryMode = 'off';
      auto.recoverySteps = 0;
    }
    auto.recoveryFollowSignal = false;
  } else {
    auto.recoverySteps = Math.min(5, Math.max(0, Number(auto.recoverySteps) || 0));
    auto.recoveryMode = auto.recoverySteps > 0 && String(auto.recoveryMode || '') === 'steps' ? 'steps' : 'off';
    auto.recoveryFollowSignal = auto.recoveryFollowSignal === true;
  }
  auto.riskDefaultsVersion = 7;
  auto.period = normalizeAnalysisPeriodSeconds(auto.period, 60);

  return {
    ...DEFAULT_SETTINGS,
    ...incoming,
    statusBarVisibilityVersion: 1,
    // One-time 2.0.50 migration: old profiles could keep the bar permanently
    // hidden after an obsolete UI toggle. Re-enable it once; subsequent user
    // choices carry version 1 and are preserved.
    statusBarVisible: Number(incoming.statusBarVisibilityVersion || 0) < 1
      ? true
      : incoming.statusBarVisible !== false,
    period: normalizeAnalysisPeriodSeconds(incoming.period ?? auto.period, 60),
    autoTrade: auto
  };
}

function autoTradeDisarmedSettings(rawSettings) {
  const settings = normalizeStoredSettingsV1080(rawSettings);
  return {
    ...settings,
    autoTrade: {
      ...settings.autoTrade,
      enabled: false,
      sessionStartedAt: null,
      recoveryStartedAt: null
    }
  };
}

async function disarmAutoTradeSession(reason = 'pocket_session_ended') {
  const stored = await chrome.storage.local.get(['poBridgeSettings', SIGNAL_SUBSCRIPTION_STORAGE_KEY]).catch(() => ({}));
  const previous = normalizeStoredSettingsV1080(stored.poBridgeSettings);
  const wasEnabled = previous.autoTrade?.enabled === true;
  const next = autoTradeDisarmedSettings(previous);

  signalSubscriptions.clear();
  signalControllerTabId = null;
  persistedSignalSubscription = null;
  signalSubscriptionStateLoaded = true;
  signalSubscriptionRevision += 1;
  signalSubscriptionWireKey = '';
  await chrome.storage.local.remove(SIGNAL_SUBSCRIPTION_STORAGE_KEY).catch(() => null);
  closeServerSignalSocket(reason, false);

  persistSignalDiagnostics({
    status: 'idle',
    subscribedAssets: 0,
    strategyIds: [],
    lastRecoveryReason: reason,
    lastError: null
  });

  if (wasEnabled || stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY]) {
    await chrome.storage.local.set({
      poBridgeSettings: next,
      poAutoTradeStatus: {
        version: 1,
        enabled: false,
        state: 'off',
        reason,
        message: 'Автоторговля выключена после закрытия вкладки Pocket Option. Включите её вручную для новой сессии.',
        updatedAt: new Date().toISOString()
      }
    }).catch(() => null);
  }

  return { ok: true, wasEnabled };
}

const STATISTICS_TIME_ZONE = 'Europe/Moscow';

function localDayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STATISTICS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function normalizeTier(value) {
  return String(value || '').toUpperCase() === 'PREMIUM' ? 'PREMIUM' : 'FREE';
}

function accessLimits(tier, entitlement = null, bridgeState = null) {
  const premium = normalizeTier(tier) === 'PREMIUM';
  const entitlementMaxAssets = Number(entitlement?.limits?.maxAssets);
  const maxAssets = premium
    ? (entitlement?.limits?.maxAssets ?? null)
    : (Number.isFinite(entitlementMaxAssets) && entitlementMaxAssets > 0 ? Math.min(FREE_MAX_ASSETS, Math.floor(entitlementMaxAssets)) : FREE_MAX_ASSETS);
  return {
    maxAssets,
    maxDailyTrades: premium ? null : (entitlement?.limits?.maxDailyTrades ?? 50),
    demoModeNoDailyLimit: false,
    maxDevices: entitlement?.limits?.maxDevices ?? 2,
    aiEnabled: Boolean(entitlement?.features?.ai ?? premium),
    strategyBuilder: Boolean(entitlement?.features?.strategyBuilder ?? premium),
    autoTrading: entitlement?.features?.autoTrading !== false,
    realTrading: Boolean(entitlement?.features?.realTrading ?? entitlement?.realTradingAllowed ?? premium),
    basicStrategies: entitlement?.features?.basicStrategies !== false
  };
}

function isDemoBridgeState(state) {
  const account = state?.account || {};
  return account.isDemo === true || String(account.mode || '').toUpperCase() === 'DEMO';
}

function isDemoPayload(payload = {}, bridgeState = null) {
  if (payload?.isDemo === true || payload?.demo === true) return true;
  if (String(payload?.accountMode || payload?.mode || '').toUpperCase() === 'DEMO') return true;
  return isDemoBridgeState(bridgeState);
}

async function currentBridgeState() {
  const stored = await chrome.storage.local.get('poBridgeState').catch(() => ({}));
  return stored.poBridgeState || null;
}

async function getAccessState({ allowServerHeal = true } = {}) {
  const stored = await chrome.storage.local.get(['poUsageStats', 'poBridgeState']);
  const today = localDayKey();
  let usage = stored.poUsageStats || { dayKey: today, tradeCount: 0, sources: {}, updatedAt: new Date().toISOString() };
  if (usage.dayKey !== today) usage = { dayKey: today, tradeCount: 0, sources: {}, updatedAt: new Date().toISOString() };
  let { serverState, entitlement } = await getServerAccess();

  // FINAL6: if the account is already authenticated but serverState still
  // contains a stale ACCOUNT_NOT_CONNECTED/session/offline marker, heal it
  // immediately instead of waiting for the 2-minute alarm.
  const bridgeState = stored.poBridgeState || null;
  const connected = isConnected(bridgeState);
  const accountUid = bridgeState?.account?.uid != null ? String(bridgeState.account.uid) : '';
  const staleServerError = /ACCOUNT_NOT_CONNECTED|session_missing|SERVER_OFFLINE/i.test(String(serverState?.lastError || ''));
  const uidMismatch = Boolean(accountUid && serverState?.pocketUid && String(serverState.pocketUid) !== accountUid);
  const needsServerHeal = connected && (
    serverState?.online !== true
    || !serverState?.sessionToken
    || staleServerError
    || uidMismatch
  );
  if (allowServerHeal && needsServerHeal) {
    const healed = await syncServer({ forceBootstrap: true }).catch(() => null);
    if (healed) {
      serverState = healed;
      entitlement = healed.entitlement || entitlement;
    }
  }

  const tier = entitlement?.premium ? 'PREMIUM' : 'FREE';
  return {
    tier,
    premium: Boolean(entitlement?.premium),
    status: entitlement?.status || 'active',
    source: entitlement?.source || 'free',
    pauseReason: entitlement?.pauseReason || null,
    expiresAt: entitlement?.expiresAt || null,
    accessState: entitlement?.accessState || null,
    registrationRequired: Boolean(entitlement?.registrationRequired),
    realTradingAllowed: Boolean(entitlement?.features?.realTrading ?? entitlement?.realTradingAllowed ?? entitlement?.premium),
    entitlement,
    serverOnline: Boolean(serverState?.online),
    serverState,
    limits: accessLimits(tier, entitlement, bridgeState),
    usage,
    accountMode: isDemoBridgeState(bridgeState) ? 'DEMO' : 'REAL',
    demoModeNoDailyLimit: false
  };
}


function freeAutoTradeUsed(usage = {}) {
  const sources = usage && typeof usage.sources === 'object' ? usage.sources : {};
  const auto = Number(sources.autotrade ?? sources.autoTrade ?? sources.auto ?? NaN);
  if (Number.isFinite(auto) && auto > 0) return Math.max(0, Math.floor(auto));
  const total = Number(usage.tradeCount ?? usage.total ?? NaN);
  return Number.isFinite(total) && total > 0 ? Math.max(0, Math.floor(total)) : 0;
}

function freeLimitMeta(access = {}, permit = {}) {
  const limit = Number(access?.limits?.maxDailyTrades ?? permit?.limitToday ?? permit?.maxDailyTrades ?? 50) || 50;
  const permitUsed = Number(permit?.usedToday ?? permit?.tradeCountToday ?? NaN);
  const used = Number.isFinite(permitUsed) && permitUsed > 0 ? Math.floor(permitUsed) : freeAutoTradeUsed(access?.usage || {});
  return { limit, used, remaining: Math.max(0, limit - used) };
}

function isFreeAutotradeAccess(access = {}, source = '') {
  if (String(source || '').toLowerCase() !== 'autotrade') return false;
  if (access?.premium || String(access?.tier || '').toUpperCase() === 'PREMIUM') return false;
  const status = String(access?.status || 'active').toLowerCase();
  if (status === 'blocked') return false;
  return true;
}

async function publishFreeLimitNotification({ permit = {}, access = {}, requestId = '' } = {}) {
  const serverUid = access?.serverState?.pocketUid || access?.entitlement?.pocketUid || access?.uid || '';
  const dayKey = localDayKey();
  // v2 avoids stale keys from older test builds where the modal could be suppressed.
  const key = `free-daily-limit-v2:${serverUid || 'unknown'}:${dayKey}`;
  const stored = await chrome.storage.local.get('ptLastFreeDailyLimitNoticeKey');
  if (stored.ptLastFreeDailyLimitNoticeKey === key) return null;
  const meta = freeLimitMeta(access, permit);
  const used = Math.max(meta.limit, Number(permit?.usedToday ?? permit?.tradeCountToday ?? meta.used) || meta.used || meta.limit);
  const language = await getBackgroundLanguage();
  const payload = {
    id: `free-limit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    key,
    kind: 'free_limit',
    reason: 'DAILY_TRADE_LIMIT',
    title: BACKGROUND_UI[language].freeLimitTitle,
    message: backgroundFreeLimitMessage(language, used, meta.limit),
    plan: 'FREE',
    status: 'limit_reached',
    requestId,
    usedToday: used,
    limitToday: meta.limit,
    createdAt: new Date().toISOString()
  };
  await chrome.storage.local.set({
    ptAccessNotification: payload,
    ptLastFreeDailyLimitNoticeKey: key
  });
  await notifyPocketTabs({ type: 'PT_ACCESS_NOTIFICATION', notification: payload });
  return payload;
}

async function checkTradeAccess(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());
  const source = payload.source || 'manual';
  const executionDeadlineMs = Number(payload.executionDeadlineMs);
  const hasExecutionDeadline = Number.isFinite(executionDeadlineMs) && executionDeadlineMs > 0;
  if (hasExecutionDeadline && executionDeadlineMs - Date.now() <= 2500) {
    return { ok: false, allowed: false, requestId, reason: 'SIGNAL_EXPIRED', error: 'Сигнал устарел до проверки торгового доступа' };
  }
  const bridgeState = await currentBridgeState();
  const demoTrade = isDemoPayload(payload, bridgeState);
  // A live signal must not wait for a 20-second session-healing request. The
  // normal heartbeat keeps the session ready; if it is stale, fail quickly and
  // let the background synchronizer restore it for the next signal.
  const access = await getAccessState({ allowServerHeal: !hasExecutionDeadline });
  if (access?.limits?.autoTrading === false) {
    return { ok: false, allowed: false, requestId, reason: access.registrationRequired ? 'REGISTRATION_REQUIRED' : 'AUTOTRADING_UNAVAILABLE', error: humanReason(access.registrationRequired ? 'REGISTRATION_REQUIRED' : 'AUTOTRADING_UNAVAILABLE'), ...access };
  }
  if (!demoTrade && access.realTradingAllowed !== true) {
    return { ok: false, allowed: false, requestId, reason: 'REAL_TRADING_REQUIRES_DEPOSIT', error: humanReason('REAL_TRADING_REQUIRES_DEPOSIT'), ...access };
  }
  if (isFreeAutotradeAccess(access, source) && access?.limits?.maxDailyTrades != null) {
    const meta = freeLimitMeta(access);
    if (meta.limit > 0 && meta.used >= meta.limit) {
      await publishFreeLimitNotification({ permit: { usedToday: meta.used, limitToday: meta.limit }, access, requestId }).catch(() => null);
      const language = await getBackgroundLanguage();
      return {
        ok: false,
        allowed: false,
        requestId,
        reason: 'DAILY_TRADE_LIMIT',
        error: backgroundFreeLimitMessage(language, meta.used, meta.limit, true),
        remaining: 0,
        remainingToday: 0,
        duplicate: false,
        executionTicket: null,
        expiresInSeconds: 0,
        ...access
      };
    }
  }
  const permit = await requestTradePermit({
    requestId,
    source,
    asset: payload.asset || null,
    strategyId: payload.strategyId || null,
    action: payload.action || null,
    amount: payload.amount,
    duration: payload.duration,
    period: payload.period ?? payload.analysisPeriod ?? null,
    analysisPeriod: payload.analysisPeriod ?? payload.period ?? null,
    accountMode: demoTrade ? 'DEMO' : 'REAL',
    isDemo: demoTrade,
    executionDeadlineMs: hasExecutionDeadline ? executionDeadlineMs : null
  });
  if (permit?.allowed === false && String(permit?.reason || '') === 'DAILY_TRADE_LIMIT') {
    await publishFreeLimitNotification({ permit, access, requestId }).catch(() => null);
  }
  return {
    ok: Boolean(permit.ok),
    allowed: Boolean(permit.allowed),
    requestId,
    reason: permit.reason || null,
    error: permit.error || (permit.allowed ? null : humanReason(permit.reason)),
    remaining: permit.remainingToday ?? null,
    remainingToday: permit.remainingToday ?? null,
    duplicate: Boolean(permit.duplicate),
    executionTicket: permit.executionTicket || null,
    expiresInSeconds: permit.expiresInSeconds || 0,
    ...access
  };
}

const TRADE_USAGE_MUTATION_TAIL_KEY = '__ptTradeUsageMutationTailV1__';

function serializeTradeUsageMutation(task) {
  const previous = globalThis[TRADE_USAGE_MUTATION_TAIL_KEY] instanceof Promise
    ? globalThis[TRADE_USAGE_MUTATION_TAIL_KEY]
    : Promise.resolve();
  const run = previous.then(task, task);
  globalThis[TRADE_USAGE_MUTATION_TAIL_KEY] = run.catch(() => null);
  return run;
}

async function recordTradeUsageUnlocked(source = 'manual', payload = {}) {
  const bridgeState = await currentBridgeState();
  const demoTrade = isDemoPayload(payload, bridgeState);
  const access = await getAccessState();
  const usage = { ...access.usage, sources: { ...(access.usage.sources || {}) } };
  const sourceKey = String(source || 'manual').toLowerCase() === 'autotrade' ? 'autotrade' : String(source || 'manual');
  usage.tradeCount = Number(usage.tradeCount || 0) + 1;
  usage.sources[sourceKey] = Number(usage.sources[sourceKey] || 0) + 1;
  usage.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ poUsageStats: usage });
  const nextAccess = { ...access, usage };
  if (isFreeAutotradeAccess(nextAccess, sourceKey)) {
    const meta = freeLimitMeta(nextAccess);
    if (meta.limit > 0 && meta.used >= meta.limit) await publishFreeLimitNotification({ permit: { usedToday: meta.used, limitToday: meta.limit }, access: nextAccess }).catch(() => null);
  }
  return { ...access, usage, remaining: access.limits.maxDailyTrades == null ? null : Math.max(0, access.limits.maxDailyTrades - freeAutoTradeUsed(usage)) };
}

function recordTradeUsage(source = 'manual', payload = {}) {
  return serializeTradeUsageMutation(() => recordTradeUsageUnlocked(source, payload));
}

const ROBOT_TRADE_REGISTRY_KEY = 'poRobotTradeRegistry';
const ROBOT_TRADE_REGISTRY_MAX = 5000;
const ROBOT_TRADE_REGISTRY_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
const LATE_SUBMITTED_ORDER_MATCH_WINDOW_MS = 12 * 1000;

function isRobotTradeSource(source) {
  return String(source || '').trim().toLowerCase() === 'autotrade';
}

function isRobotTradeDeal(deal) {
  const requestId = String(deal?.requestId || '').trim();
  return Boolean(deal?.robotTrade === true || isRobotTradeSource(deal?.source) || requestId.startsWith('pt_'));
}

function isBrokerConfirmedClosedDeal(deal) {
  if (!deal || typeof deal !== 'object' || deal.synthetic === true) return false;
  const closeTimestamp = normalizedTradeTimestampSeconds(deal.closeTimestamp ?? deal.closedAt);
  if (!closeTimestamp) return false;
  if (deal.brokerUiLive === true) return true;
  if (deal.brokerConfirmed !== true) return false;
  const executionSource = String(deal.executionSource || '').trim().toLowerCase();
  const closeConfirmationSource = String(deal.closeConfirmationSource || '').trim().toLowerCase();
  return Boolean(
    deal.synthetic === false
    || deal.officialApi === true
    || executionSource === 'official_api'
    || ['broker_event', 'broker_socket', 'broker_ui'].includes(closeConfirmationSource)
  );
}

function normalizeRobotTradeRegistry(raw) {
  const list = Array.isArray(raw?.trades) ? raw.trades : Array.isArray(raw) ? raw : [];
  const cutoff = Date.now() - ROBOT_TRADE_REGISTRY_RETENTION_MS;
  const trades = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const requestId = String(item.requestId || '').trim() || null;
    const dealId = String(item.dealId || item.id || '').trim() || null;
    if (!requestId && !dealId) continue;
    const updatedMs = Date.parse(item.updatedAt || item.openedAt || '') || 0;
    if (updatedMs && updatedMs < cutoff) continue;
    const status = String(item.confirmationState || item.status || '').trim().toLowerCase();
    const confirmationState = status === 'unconfirmed' ? 'unconfirmed'
      : status === 'failed' ? 'failed'
        : status === 'submitted' ? 'submitted'
          : (dealId || item.brokerConfirmed === true || ['success', 'open', 'closed', 'confirmed'].includes(status)) ? 'confirmed' : null;
    trades.push({
      requestId,
      dealId,
      uid: item.uid ?? item.userId ?? item.user_id ?? null,
      mode: item.mode || null,
      accountKey: item.accountKey || null,
      strategyId: String(item.strategyId || '').trim() || null,
      asset: item.asset || null,
      action: item.action || null,
      amount: optionalFiniteNumber(item.amount),
      duration: optionalFiniteNumber(item.duration),
      signalPeriod: optionalFiniteNumber(item.signalPeriod ?? item.analysisPeriod ?? item.period),
      signalExpiration: optionalFiniteNumber(item.signalExpiration ?? item.duration),
      signalConfidence: optionalFiniteNumber(item.signalConfidence ?? item.confidence),
      signalPayout: optionalFiniteNumber(item.signalPayout ?? item.payout),
      calibrationApplied: item.calibrationApplied && typeof item.calibrationApplied === 'object' ? item.calibrationApplied : null,
      recoveryStep: Math.max(0, Number(item.recoveryStep) || 0),
      recoverySteps: Math.max(0, Number(item.recoverySteps) || 0),
      recoveryMultiplier: optionalFiniteNumber(item.recoveryMultiplier),
      recoveryScopeStrategyId: String(item.recoveryScopeStrategyId || '').trim() || null,
      recoveryScopeAsset: String(item.recoveryScopeAsset || '').trim() || null,
      recoveryFollowSignal: item.recoveryFollowSignal === true,
      parentRequestId: item.parentRequestId || null,
      recoveryBranchRootId: String(item.recoveryBranchRootId || '').trim() || null,
      baseAmount: optionalFiniteNumber(item.baseAmount),
      submittedAt: robotSubmittedAtMs(item) || null,
      confirmationState,
      openTimestamp: normalizedTradeTimestampSeconds(item.openTimestamp),
      openedAt: item.openedAt || null,
      isDemo: item.isDemo ?? null,
      source: 'autotrade',
      robotTrade: true,
      updatedAt: item.updatedAt || new Date().toISOString()
    });
  }
  return {
    version: Math.max(3, Number(raw?.version) || 1),
    accountKey: raw?.accountKey || null,
    uid: raw?.uid ?? null,
    mode: raw?.mode || null,
    trades: trades.slice(-ROBOT_TRADE_REGISTRY_MAX),
    updatedAt: raw?.updatedAt || null
  };
}

function robotSubmittedAtMs(item = {}) {
  const direct = item?.submittedAt ?? item?.sentAt;
  let value = stateTimeMs(direct);
  if (!value) {
    value = stateTimeMs(item?.time);
    const status = String(item?.confirmationState || item?.status || '').trim().toLowerCase();
    if (value && status === 'unconfirmed') value -= 12000;
  }
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function nestedRobotSubmittedAt(payload = {}) {
  const candidates = [
    payload.submittedAt,
    payload.sentAt,
    payload.rawResult?.submittedAt,
    payload.rawResult?.sentAt,
    payload.rawResult?.result?.submittedAt,
    payload.rawResult?.result?.sentAt,
    payload.rawResult?.result?.result?.submittedAt,
    payload.rawResult?.result?.result?.sentAt
  ];
  for (const value of candidates) {
    const timestamp = stateTimeMs(value);
    if (timestamp > 0) return timestamp;
  }
  return 0;
}

function nestedRobotReportConfirmationState(payload = {}) {
  if (payload?.opened === true) return 'confirmed';
  const candidates = [
    payload.confirmationState,
    payload.status,
    payload.rawResult?.status,
    payload.rawResult?.result?.status,
    payload.rawResult?.result?.result?.status
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  if (payload?.rawResult?.unconfirmed === true || candidates.includes('unconfirmed')) return 'unconfirmed';
  if (candidates.some((value) => ['failed', 'error', 'rejected'].includes(value))) return 'failed';
  return payload?.opened === false ? 'failed' : 'submitted';
}

function nestedRobotDealId(payload = {}) {
  const candidates = [
    payload.dealId,
    payload.id,
    payload.rawResult?.dealId,
    payload.rawResult?.id,
    payload.rawResult?.result?.dealId,
    payload.rawResult?.result?.id,
    payload.rawResult?.result?.result?.dealId,
    payload.rawResult?.result?.result?.id
  ];
  for (const value of candidates) {
    const id = String(value ?? '').trim();
    if (id && id !== '0' && id.toLowerCase() !== 'null' && id.toLowerCase() !== 'undefined') return id;
  }
  return null;
}

function robotRegistryEntryFromDeal(deal = {}) {
  const requestId = String(deal.requestId || '').trim() || null;
  const dealId = String(deal.dealId || deal.id || '').trim() || null;
  if (!requestId && !dealId) return null;
  const openTimestamp = normalizedTradeTimestampSeconds(deal.openTimestamp)
    ?? (deal.openedAt && Number.isFinite(Date.parse(deal.openedAt)) ? Math.floor(Date.parse(deal.openedAt) / 1000) : null);
  const rawState = String(deal.confirmationState || deal.status || '').trim().toLowerCase();
  const confirmationState = rawState === 'unconfirmed' ? 'unconfirmed'
    : rawState === 'failed' ? 'failed'
      : rawState === 'submitted' ? 'submitted'
        : (dealId || deal.brokerConfirmed === true || ['success', 'open', 'closed', 'confirmed'].includes(rawState)) ? 'confirmed' : null;
  return {
    requestId,
    dealId,
    uid: deal.uid ?? deal.userId ?? deal.user_id ?? null,
    mode: deal.mode || null,
    accountKey: deal.accountKey || null,
    strategyId: String(deal.strategyId || '').trim() || null,
    asset: deal.asset || null,
    action: deal.action || null,
    amount: optionalFiniteNumber(deal.amount),
    duration: optionalFiniteNumber(deal.duration),
    signalPeriod: optionalFiniteNumber(deal.signalPeriod ?? deal.analysisPeriod ?? deal.period),
    signalExpiration: optionalFiniteNumber(deal.signalExpiration ?? deal.duration),
    signalConfidence: optionalFiniteNumber(deal.signalConfidence ?? deal.confidence),
    signalPayout: optionalFiniteNumber(deal.signalPayout ?? deal.payout),
    calibrationApplied: deal.calibrationApplied && typeof deal.calibrationApplied === 'object' ? deal.calibrationApplied : null,
    recoveryStep: Math.max(0, Number(deal.recoveryStep) || 0),
    recoverySteps: Math.max(0, Number(deal.recoverySteps) || 0),
    recoveryMultiplier: optionalFiniteNumber(deal.recoveryMultiplier),
    recoveryScopeStrategyId: String(deal.recoveryScopeStrategyId || '').trim() || null,
    recoveryScopeAsset: String(deal.recoveryScopeAsset || '').trim() || null,
    recoveryFollowSignal: deal.recoveryFollowSignal === true,
    parentRequestId: deal.parentRequestId || null,
    recoveryBranchRootId: String(deal.recoveryBranchRootId || '').trim() || null,
    baseAmount: optionalFiniteNumber(deal.baseAmount),
    submittedAt: robotSubmittedAtMs(deal) || null,
    confirmationState,
    openTimestamp,
    openedAt: deal.openedAt || (openTimestamp ? new Date(openTimestamp * 1000).toISOString() : null),
    isDemo: deal.isDemo ?? null,
    source: 'autotrade',
    robotTrade: true,
    updatedAt: new Date().toISOString()
  };
}

function sameRobotRegistryIdentity(left, right) {
  if (!left || !right) return false;
  const leftRequest = String(left.requestId || '').trim();
  const rightRequest = String(right.requestId || '').trim();
  if (leftRequest && rightRequest && leftRequest === rightRequest) return true;
  const leftDeal = String(left.dealId || left.id || '').trim();
  const rightDeal = String(right.dealId || right.id || '').trim();
  if (leftDeal && rightDeal && leftDeal === rightDeal) return true;
  return false;
}

function matchRobotTradeReference(deal, references = []) {
  if (!deal) return null;
  // Exact requestId/dealId remains the primary and strongest identity.
  for (const ref of references) {
    if (ref && sameRobotRegistryIdentity(deal, ref)) return ref;
  }
  return null;
}

function submittedUnconfirmedRobotTradeMatchDelta(deal, item, state) {
  if (!deal || !item || !state?.trades) return null;
  const requestId = String(item?.requestId || '').trim();
  const rawDealRequestId = String(deal?.requestId || '').trim();
  const dealRequestId = rawDealRequestId && !['0', 'null', 'undefined'].includes(rawDealRequestId.toLowerCase())
    ? rawDealRequestId
    : null;
  const source = String(item?.source || '').trim().toLowerCase();
  const status = String(item?.confirmationState || item?.status || '').trim().toLowerCase();
  if (!requestId || status !== 'unconfirmed') return null;
  if (dealRequestId && dealRequestId !== requestId) return null;
  if (!requestId.startsWith('pt_') && source !== 'autotrade' && item?.robotTrade !== true) return null;
  if (String(item?.asset || '') !== String(deal.asset || '')) return null;
  if (item?.action && deal?.action && String(item.action) !== String(deal.action)) return null;
  const submittedAmount = optionalFiniteNumber(item?.amount);
  const brokerAmount = optionalFiniteNumber(deal?.amount);
  if (submittedAmount == null || brokerAmount == null || Math.abs(submittedAmount - brokerAmount) > 1e-8) return null;
  const submittedDuration = optionalFiniteNumber(item?.duration ?? item?.signalExpiration);
  const brokerDuration = optionalFiniteNumber(deal?.duration);
  if (submittedDuration != null && brokerDuration != null && Math.abs(submittedDuration - brokerDuration) > 1) return null;
  const brokerOpen = normalizedTradeTimestampSeconds(deal.openTimestamp);
  if (brokerOpen == null) return null;
  const brokerOffsetSec = finiteNumber(state?.market?.brokerClockOffsetSec) ?? 0;
  const localOpenMs = (brokerOpen - brokerOffsetSec) * 1000;
  const submittedAtMs = robotSubmittedAtMs(item);
  if (submittedAtMs <= 0) return null;
  const delta = Math.abs(localOpenMs - submittedAtMs);
  return delta <= LATE_SUBMITTED_ORDER_MATCH_WINDOW_MS ? delta : null;
}

function unconfirmedRobotTradeCandidates(state, references = []) {
  const sourceCandidates = [
    ...(Array.isArray(state?.trades?.recentResults) ? state.trades.recentResults : []),
    ...(Array.isArray(references) ? references : [])
  ];
  const byRequestId = new Map();
  for (const item of sourceCandidates) {
    const requestId = String(item?.requestId || '').trim();
    if (!requestId) continue;
    const status = String(item?.confirmationState || item?.status || '').trim().toLowerCase();
    if (status !== 'unconfirmed') continue;
    const previous = byRequestId.get(requestId);
    if (!previous || robotSubmittedAtMs(item) > robotSubmittedAtMs(previous)) byRequestId.set(requestId, item);
  }
  return [...byRequestId.values()];
}

function matchSubmittedUnconfirmedRobotTrade(deal, state, claimedRequestIds = new Set(), references = []) {
  const candidates = unconfirmedRobotTradeCandidates(state, references)
    .filter((item) => !claimedRequestIds.has(String(item?.requestId || '').trim()))
    .map((item) => ({ item, delta: submittedUnconfirmedRobotTradeMatchDelta(deal, item, state) }))
    .filter((entry) => entry.delta != null)
    .sort((left, right) => left.delta - right.delta);
  if (candidates[1] && Math.abs(Number(candidates[1].delta) - Number(candidates[0].delta)) < 1500) return null;
  const match = candidates[0]?.item || null;
  if (!match) return null;
  const requestId = String(match.requestId || '').trim();
  if (requestId) claimedRequestIds.add(requestId);
  return robotRegistryEntryFromDeal({
    ...match,
    dealId: deal.id || deal.dealId || null,
    openTimestamp: deal.openTimestamp,
    confirmationState: 'confirmed',
    source: 'autotrade',
    robotTrade: true
  });
}

function submittedUnconfirmedRobotTradeReferencesForDeals(rawDeals, state, references = []) {
  const result = new Map();
  const deals = (Array.isArray(rawDeals) ? rawDeals : []).map(normalizeStoredDeal).filter(Boolean);
  const candidates = unconfirmedRobotTradeCandidates(state, references);
  const usedDeals = new Set();
  const usedRequests = new Set();

  // Reconcile exact broker request/deal identities before the generic robot and
  // recent-reference skips, otherwise a late broker ACK can leave the submitted
  // trade permanently marked as unconfirmed.
  for (const deal of deals) {
    const dealId = String(deal.id || '').trim();
    if (!dealId) continue;
    const exact = candidates.find((item) => sameRobotRegistryIdentity(deal, item)) || null;
    if (!exact) continue;
    const requestId = String(exact.requestId || '').trim();
    const reference = robotRegistryEntryFromDeal({
      ...exact,
      dealId,
      openTimestamp: deal.openTimestamp,
      confirmationState: 'confirmed',
      source: 'autotrade',
      robotTrade: true
    });
    if (!reference) continue;
    result.set(dealId, reference);
    usedDeals.add(dealId);
    if (requestId) usedRequests.add(requestId);
  }

  const edges = [];
  for (const deal of deals) {
    const dealId = String(deal.id || '').trim();
    if (!dealId || usedDeals.has(dealId) || isRobotTradeDeal(deal) || matchRobotTradeReference(deal, references)) continue;
    for (const item of candidates) {
      const requestId = String(item?.requestId || '').trim();
      if (!requestId || usedRequests.has(requestId)) continue;
      const delta = submittedUnconfirmedRobotTradeMatchDelta(deal, item, state);
      if (delta != null) edges.push({ deal, dealId, item, requestId, delta });
    }
  }
  edges.sort((left, right) => left.delta - right.delta);
  for (const edge of edges) {
    if (usedDeals.has(edge.dealId) || usedRequests.has(edge.requestId)) continue;
    const ambiguous = edges.some((other) => other !== edge
      && ((other.dealId === edge.dealId && other.requestId !== edge.requestId)
        || (other.requestId === edge.requestId && other.dealId !== edge.dealId))
      && Math.abs(Number(other.delta) - Number(edge.delta)) < 1500);
    if (ambiguous) continue;
    const reference = robotRegistryEntryFromDeal({
      ...edge.item,
      dealId: edge.dealId,
      openTimestamp: edge.deal.openTimestamp,
      confirmationState: 'confirmed',
      source: 'autotrade',
      robotTrade: true
    });
    if (!reference) continue;
    result.set(edge.dealId, reference);
    usedDeals.add(edge.dealId);
    usedRequests.add(edge.requestId);
  }
  return result;
}

function markRobotTradeDeal(deal, reference = null) {
  if (!deal) return null;
  return {
    ...deal,
    requestId: deal.requestId || reference?.requestId || null,
    // The registry entry was written from the submitted/confirmed Robot order and
    // is the authoritative source for strategy and Martingale metadata. Broker
    // snapshots often omit these fields or normalize them to zero/false.
    strategyId: reference?.strategyId || deal.strategyId || null,
    signalConfidence: reference?.signalConfidence ?? deal.signalConfidence ?? null,
    signalPayout: reference?.signalPayout ?? deal.signalPayout ?? deal.percentProfit ?? null,
    signalExpiration: reference?.signalExpiration ?? deal.signalExpiration ?? deal.duration ?? null,
    signalPeriod: reference?.signalPeriod ?? deal.signalPeriod ?? null,
    calibrationApplied: reference?.calibrationApplied || deal.calibrationApplied || null,
    duration: deal.duration ?? reference?.duration ?? null,
    recoveryStep: reference?.recoveryStep ?? deal.recoveryStep ?? 0,
    recoverySteps: reference?.recoverySteps ?? deal.recoverySteps ?? 0,
    recoveryMultiplier: reference?.recoveryMultiplier ?? deal.recoveryMultiplier ?? null,
    recoveryScopeStrategyId: reference?.recoveryScopeStrategyId || deal.recoveryScopeStrategyId || null,
    recoveryScopeAsset: reference?.recoveryScopeAsset || deal.recoveryScopeAsset || null,
    recoveryFollowSignal: reference?.recoveryFollowSignal ?? deal.recoveryFollowSignal ?? false,
    parentRequestId: reference?.parentRequestId || deal.parentRequestId || null,
    recoveryBranchRootId: reference?.recoveryBranchRootId || deal.recoveryBranchRootId || null,
    baseAmount: reference?.baseAmount ?? deal.baseAmount ?? null,
    source: 'autotrade',
    robotTrade: true
  };
}

function nestedRobotTradeOpenTimestamp(payload = {}) {
  const candidates = [
    payload.openTimestamp,
    payload.rawResult?.openTimestamp,
    payload.rawResult?.result?.openTimestamp,
    payload.rawResult?.result?.trade?.openTimestamp,
    payload.rawResult?.result?.result?.openTimestamp,
    payload.rawResult?.result?.result?.trade?.openTimestamp
  ];
  for (const value of candidates) {
    const timestamp = normalizedTradeTimestampSeconds(value);
    if (timestamp != null) return timestamp;
  }
  return null;
}

// Chrome storage has no atomic read-modify-write primitive. Trade acknowledgements,
// broker snapshots and Remote/status reads can arrive concurrently, so every ledger
// and registry mutation must share one in-process queue or one parallel trade can
// overwrite another trade's freshly written entry.
const TRADE_LEDGER_MUTATION_TAIL_KEY = '__ptTradeLedgerMutationTailV1__';

function serializeTradeLedgerMutation(task) {
  const previous = globalThis[TRADE_LEDGER_MUTATION_TAIL_KEY] instanceof Promise
    ? globalThis[TRADE_LEDGER_MUTATION_TAIL_KEY]
    : Promise.resolve();
  const run = previous.then(task, task);
  globalThis[TRADE_LEDGER_MUTATION_TAIL_KEY] = run.catch(() => null);
  return run;
}

async function upsertConfirmedRobotOpenFromReport(payload = {}) {
  if (!isRobotTradeSource(payload?.source) || payload?.opened !== true) return null;
  const stored = await chrome.storage.local.get(['poTradeLedger', 'poBridgeState']);
  const bridgeState = stored.poBridgeState || null;
  const brokerOffsetSec = finiteNumber(bridgeState?.market?.brokerClockOffsetSec) ?? 0;
  const now = new Date();
  const todayKey = localDayKey(now);
  const scoped = scopeTradeLedgerToState(stored.poTradeLedger || null, bridgeState);
  const ledger = scoped.ledger;
  const requestId = String(payload.requestId || '').trim() || null;
  const dealId = nestedRobotDealId(payload) || requestId;
  if (!dealId) return ledger;
  const explicitOpen = nestedRobotTradeOpenTimestamp(payload);
  const openedAtLocal = normalizedTradeTimestampSeconds(payload.openedAt) ?? Math.floor(now.getTime() / 1000);
  const openTimestamp = explicitOpen ?? (openedAtLocal + brokerOffsetSec);
  const duration = optionalFiniteNumber(payload.duration);
  const deal = normalizeStoredDeal({
    id: dealId,
    dealId,
    requestId,
    uid: bridgeState?.account?.uid ?? null,
    mode: bridgeState?.account?.mode || null,
    accountKey: scoped.identity?.key || null,
    strategyId: payload.strategyId || null,
    signalConfidence: payload.signalConfidence ?? payload.confidence ?? null,
    signalPayout: payload.signalPayout ?? payload.currentPayout ?? payload.payout ?? null,
    signalExpiration: payload.signalExpiration ?? duration ?? null,
    signalPeriod: payload.signalPeriod ?? payload.analysisPeriod ?? payload.period ?? duration ?? null,
    recoveryStep: Math.max(0, Number(payload.recoveryStep) || 0),
    recoverySteps: Math.max(0, Number(payload.recoverySteps) || 0),
    recoveryMultiplier: optionalFiniteNumber(payload.recoveryMultiplier),
    recoveryFollowSignal: payload.recoveryFollowSignal === true,
    parentRequestId: payload.parentRequestId || null,
    recoveryBranchRootId: payload.recoveryBranchRootId || null,
    baseAmount: optionalFiniteNumber(payload.baseAmount),
    calibrationApplied: payload.calibrationApplied || payload.calibration || null,
    asset: payload.asset || null,
    action: payload.action || null,
    amount: payload.amount ?? null,
    profit: null,
    percentProfit: payload.signalPayout ?? payload.currentPayout ?? payload.payout ?? null,
    openTimestamp,
    closeTimestamp: null,
    duration,
    expirationTimestamp: duration && duration > 0 ? openTimestamp + duration : null,
    currency: bridgeState?.account?.currency || null,
    isDemo: payload.isDemo ?? bridgeState?.account?.isDemo ?? null,
    outcome: 'open',
    status: 'open',
    optimistic: false,
    brokerConfirmed: true,
    confirmedAt: payload.openedAt || now.toISOString(),
    source: 'autotrade',
    robotTrade: true
  });
  if (!deal || !dealAfterLedgerReset(deal, ledger, brokerOffsetSec)) return ledger;

  const closedDeals = (Array.isArray(ledger.closedDeals) ? ledger.closedDeals : []).map(normalizeStoredDeal).filter(Boolean).filter((item) => dealBelongsToTradeAccount(item, scoped.identity));
  if (closedDeals.some((item) => sameStoredDealIdentity(item, deal))) return ledger;
  const openDeals = (Array.isArray(ledger.openDeals) ? ledger.openDeals : []).map(normalizeStoredDeal).filter(Boolean).filter((item) => dealBelongsToTradeAccount(item, scoped.identity));
  const existing = openDeals.find((item) => sameStoredDealIdentity(item, deal)) || null;
  const merged = markRobotTradeDeal({
    ...deal,
    ...(existing || {}),
    requestId: deal.requestId || existing?.requestId || null,
    strategyId: deal.strategyId || existing?.strategyId || null,
    // A confirmed OPEN must stay open even if an older official-api record
    // incorrectly stored its scheduled expiry in closeTimestamp.
    closeTimestamp: null,
    expirationTimestamp: deal.expirationTimestamp || existing?.expirationTimestamp || null,
    status: 'open',
    outcome: 'open',
    source: 'autotrade',
    robotTrade: true
  });
  const nextOpen = openDeals.filter((item) => !sameStoredDealIdentity(item, merged));
  nextOpen.push(merged);
  const next = {
    ...ledger,
    version: 5,
    robotOnly: true,
    closedDeals,
    openDeals: nextOpen.slice(-300),
    summary: summarizeDeals(closedDeals),
    today: summarizeDeals(closedDeals, todayKey, brokerOffsetSec),
    todayKey,
    updatedAt: now.toISOString()
  };
  await chrome.storage.local.set({ poTradeLedger: next });
  return next;
}

async function rememberRobotTradeReportUnlocked(payload = {}) {
  if (!isRobotTradeSource(payload?.source)) return null;
  const requestId = String(payload?.requestId || '').trim();
  if (!requestId) return null;
  const confirmationState = nestedRobotReportConfirmationState(payload);
  const stored = await chrome.storage.local.get([ROBOT_TRADE_REGISTRY_KEY, 'poBridgeState', 'poTradeLedger']);
  const bridgeState = stored.poBridgeState || null;
  const identity = tradeLedgerAccountIdentity(bridgeState);
  const ledgerScope = scopeTradeLedgerToState(stored.poTradeLedger || null, bridgeState);
  let registry = normalizeRobotTradeRegistry(stored[ROBOT_TRADE_REGISTRY_KEY]);
  const registryKey = String(registry.accountKey || '').trim();
  if (identity && (ledgerScope.reset || (registryKey && registryKey !== identity.key))) {
    registry = { version: 3, accountKey: identity.key, uid: identity.uid, mode: identity.mode, trades: [], updatedAt: new Date().toISOString() };
  } else if (identity) {
    registry = { ...registry, version: Math.max(3, Number(registry.version) || 0), accountKey: identity.key, uid: identity.uid, mode: identity.mode };
  }

  // A hard rejection must never remain eligible for fuzzy broker reconciliation.
  if (confirmationState === 'failed') {
    const filtered = registry.trades.filter((item) => String(item?.requestId || '') !== requestId);
    if (filtered.length !== registry.trades.length) {
      registry = { ...registry, version: 3, trades: filtered, updatedAt: new Date().toISOString() };
      await chrome.storage.local.set({ [ROBOT_TRADE_REGISTRY_KEY]: registry });
    }
    return registry;
  }

  const entry = robotRegistryEntryFromDeal({
    ...payload,
    uid: bridgeState?.account?.uid ?? null,
    mode: bridgeState?.account?.mode || null,
    accountKey: identity?.key || null,
    dealId: nestedRobotDealId(payload),
    openTimestamp: payload.openTimestamp,
    openedAt: payload.openedAt,
    submittedAt: nestedRobotSubmittedAt(payload) || payload.submittedAt || null,
    confirmationState
  });
  if (!entry) return registry;
  const next = registry.trades.filter((item) => !sameRobotRegistryIdentity(item, entry));
  next.push(entry);
  const value = {
    version: 3,
    accountKey: identity?.key || registry.accountKey || null,
    uid: identity?.uid || registry.uid || null,
    mode: identity?.mode || registry.mode || null,
    trades: next.slice(-ROBOT_TRADE_REGISTRY_MAX),
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [ROBOT_TRADE_REGISTRY_KEY]: value });
  if (payload?.opened === true) await upsertConfirmedRobotOpenFromReport(payload).catch(() => null);
  return value;
}

function rememberRobotTradeReport(payload = {}) {
  return serializeTradeLedgerMutation(() => rememberRobotTradeReportUnlocked(payload));
}

function normalizeStoredDeal(deal) {
  if (!deal || typeof deal !== 'object') return null;
  const id = String(deal.id || deal.dealId || deal.ticket || '').trim();
  if (!id) return null;
  const statusText = String(deal.status || '').trim().toLowerCase();
  const outcomeText = String(deal.outcome || '').trim().toLowerCase();
  const normalizedOpenTimestamp = normalizedTradeTimestampSeconds(deal.openTimestamp ?? deal.openedAt);
  let normalizedCloseTimestamp = normalizedTradeTimestampSeconds(deal.closeTimestamp ?? deal.closedAt);
  let normalizedExpirationTimestamp = normalizedTradeTimestampSeconds(deal.expirationTimestamp);
  // Pocket Partners open_trade.success includes a future closeTimestamp that is
  // the scheduled expiry. Older extension builds stored it as an actual close.
  if ((statusText === 'open' || outcomeText === 'open') && normalizedCloseTimestamp != null) {
    if (normalizedExpirationTimestamp == null) normalizedExpirationTimestamp = normalizedCloseTimestamp;
    normalizedCloseTimestamp = null;
  }
  const executionSource = String(deal.executionSource || '').trim().toLowerCase() || null;
  const officialApi = deal.officialApi === true || executionSource === 'official_api';
  const synthetic = deal.synthetic === true
    ? true
    : (deal.synthetic === false || (officialApi && normalizedCloseTimestamp != null) ? false : null);
  return {
    id,
    uid: deal.uid ?? deal.userId ?? deal.user_id ?? null,
    mode: deal.mode || null,
    accountKey: deal.accountKey || null,
    requestId: deal.requestId || null,
    strategyId: deal.strategyId || null,
    signalConfidence: optionalFiniteNumber(deal.signalConfidence ?? deal.confidence),
    signalPayout: optionalFiniteNumber(deal.signalPayout ?? deal.payout),
    signalExpiration: optionalFiniteNumber(deal.signalExpiration ?? deal.calibratedExpiration),
    signalPeriod: optionalFiniteNumber(deal.signalPeriod ?? deal.analysisPeriod ?? deal.period),
    recoveryStep: deal.recoveryStep == null || deal.recoveryStep === '' ? null : Math.max(0, Number(deal.recoveryStep) || 0),
    recoverySteps: deal.recoverySteps == null || deal.recoverySteps === '' ? null : Math.max(0, Number(deal.recoverySteps) || 0),
    recoveryMultiplier: optionalFiniteNumber(deal.recoveryMultiplier),
    recoveryScopeStrategyId: String(deal.recoveryScopeStrategyId || '').trim() || null,
    recoveryScopeAsset: String(deal.recoveryScopeAsset || '').trim() || null,
    recoveryFollowSignal: deal.recoveryFollowSignal == null ? null : deal.recoveryFollowSignal === true,
    parentRequestId: deal.parentRequestId || null,
    recoveryBranchRootId: String(deal.recoveryBranchRootId || '').trim() || null,
    baseAmount: optionalFiniteNumber(deal.baseAmount),
    submittedAt: robotSubmittedAtMs(deal) || null,
    confirmationState: String(deal.confirmationState || '').trim().toLowerCase() || null,
    calibrationApplied: deal.calibrationApplied && typeof deal.calibrationApplied === 'object' ? deal.calibrationApplied : null,
    asset: deal.asset || null,
    action: deal.action || null,
    amount: optionalFiniteNumber(deal.amount),
    profit: optionalFiniteNumber(deal.profit),
    percentProfit: optionalFiniteNumber(deal.percentProfit),
    openPrice: optionalFiniteNumber(deal.openPrice),
    closePrice: optionalFiniteNumber(deal.closePrice),
    openTimestamp: normalizedOpenTimestamp,
    closeTimestamp: normalizedCloseTimestamp,
    duration: optionalFiniteNumber(deal.duration),
    expirationTimestamp: normalizedExpirationTimestamp,
    currency: deal.currency || null,
    isDemo: deal.isDemo ?? null,
    outcome: deal.outcome || null,
    status: deal.status || null,
    optimistic: deal.optimistic === true,
    brokerConfirmed: deal.brokerConfirmed === true,
    brokerUiLive: deal.brokerUiLive === true,
    synthetic,
    executionSource,
    officialApi,
    closeConfirmationSource: String(deal.closeConfirmationSource || '').trim().toLowerCase() || null,
    confirmedAt: deal.confirmedAt || null,
    source: deal.source || null,
    robotTrade: deal.robotTrade === true || isRobotTradeSource(deal.source)
  };
}

function mergeNormalizedStoredClosedDeal(existingRaw, incomingRaw) {
  const existing = normalizeStoredDeal(existingRaw);
  const incoming = normalizeStoredDeal(incomingRaw);
  if (!existing) return incoming;
  if (!incoming) return existing;

  const brokerUiLive = existing.brokerUiLive === true || incoming.brokerUiLive === true;
  const brokerConfirmed = existing.brokerConfirmed === true || incoming.brokerConfirmed === true;
  const officialApi = existing.officialApi === true || incoming.officialApi === true;
  const executionSource = incoming.executionSource || existing.executionSource || null;
  const closeConfirmationSource = incoming.closeConfirmationSource || existing.closeConfirmationSource || null;
  const trustedCloseSource = ['broker_event', 'broker_socket', 'broker_ui'].includes(closeConfirmationSource);
  const explicitRealClose = (existing.synthetic === false || incoming.synthetic === false) && brokerConfirmed;
  const trustedRealClose = brokerUiLive || officialApi || executionSource === 'official_api' || trustedCloseSource || explicitRealClose;
  const synthetic = trustedRealClose
    ? false
    : (existing.synthetic === true || incoming.synthetic === true
        ? true
        : (existing.synthetic === false || incoming.synthetic === false ? false : null));

  return normalizeStoredDeal({
    ...existing,
    ...incoming,
    id: incoming.id || existing.id,
    requestId: incoming.requestId || existing.requestId || null,
    strategyId: incoming.strategyId || existing.strategyId || null,
    source: incoming.source || existing.source || null,
    robotTrade: existing.robotTrade === true || incoming.robotTrade === true,
    closeTimestamp: incoming.closeTimestamp ?? existing.closeTimestamp,
    brokerConfirmed,
    brokerUiLive,
    synthetic,
    executionSource,
    officialApi,
    closeConfirmationSource
  });
}

function dealPricesEqual(deal) {
  const open = optionalFiniteNumber(deal?.openPrice);
  const close = optionalFiniteNumber(deal?.closePrice);
  if (open == null || close == null) return false;
  return Math.abs(open - close) <= Math.max(1e-10, Math.abs(open) * 1e-10);
}

function dealNetResult(deal) {
  const amount = Math.max(0, finiteNumber(deal?.amount) ?? 0);
  const rawProfit = finiteNumber(deal?.profit) ?? 0;
  const percent = optionalFiniteNumber(deal?.percentProfit ?? deal?.signalPayout);
  const outcome = String(deal?.outcome || deal?.result || deal?.status || '').toLowerCase();
  if (outcome === 'draw' || /return|refund|draw|tie|push|cancel|equal|возврат|ничья|отмена/.test(outcome) || dealPricesEqual(deal)) return 0;
  if (outcome === 'loss') return rawProfit < 0 ? rawProfit : -amount;
  if (outcome === 'win') {
    if (amount > 0 && percent != null && percent > 0) {
      const expectedNet = amount * percent / 100;
      const expectedReturn = amount + expectedNet;
      return Math.abs(rawProfit - expectedReturn) < Math.abs(rawProfit - expectedNet) ? rawProfit - amount : rawProfit;
    }
    return amount > 0 && rawProfit > amount * 1.01 ? rawProfit - amount : rawProfit;
  }
  if (amount > 0 && rawProfit > 0 && Math.abs(rawProfit - amount) <= Math.max(0.000001, amount * 0.000001)) return 0;
  if (rawProfit > 0) {
    if (amount > 0 && percent != null && percent > 0) {
      const expectedNet = amount * percent / 100;
      const expectedReturn = amount + expectedNet;
      return Math.abs(rawProfit - expectedReturn) < Math.abs(rawProfit - expectedNet) ? rawProfit - amount : rawProfit;
    }
    return amount > 0 && rawProfit > amount * 1.01 ? rawProfit - amount : rawProfit;
  }
  if (rawProfit < 0) return rawProfit;
  if (deal?.closePrice != null && deal?.openPrice != null && deal?.action) {
    const movement = Number(deal.closePrice) - Number(deal.openPrice);
    const won = deal.action === 'call' ? movement > 0 : movement < 0;
    return won ? rawProfit : -amount;
  }
  return rawProfit;
}

function summarizeDeals(deals, dayKey = null, brokerOffsetSec = 0) {
  const summary = { total: 0, wins: 0, losses: 0, draws: 0, netProfit: 0, invested: 0, winRate: 0 };
  const offset = finiteNumber(brokerOffsetSec) ?? 0;
  for (const deal of deals) {
    if (dayKey) {
      const ts = statisticsDealTimestampSeconds(deal, deal.closeTimestamp ?? deal.openTimestamp, offset);
      // Pocket can send trade timestamps in broker/server time while Chrome day
      // boundaries are Moscow time. Classify the row's clock domain first because
      // official/server ledger rows may already be ordinary Unix epoch seconds.
      if (!ts || localDayKey(new Date(ts * 1000)) !== dayKey) continue;
    }
    const net = dealNetResult(deal);
    const amount = finiteNumber(deal.amount) ?? 0;
    summary.total += 1;
    summary.netProfit += net;
    summary.invested += amount;
    if (net > 0) summary.wins += 1;
    else if (net < 0) summary.losses += 1;
    else summary.draws += 1;
  }
  summary.netProfit = Number(summary.netProfit.toFixed(8));
  summary.invested = Number(summary.invested.toFixed(8));
  summary.winRate = summary.wins + summary.losses > 0 ? Number((summary.wins / (summary.wins + summary.losses) * 100).toFixed(2)) : 0;
  return summary;
}

function statisticsDealTimestampSeconds(deal, value, brokerOffsetSec = 0) {
  const timestamp = normalizedTradeTimestampSeconds(value);
  if (timestamp == null) return null;
  const rawOffset = finiteNumber(brokerOffsetSec) ?? 0;
  const offset = Math.abs(rawOffset) <= 3 * 24 * 60 * 60 ? rawOffset : 0;
  if (!offset) return timestamp;
  const adjusted = timestamp - offset;
  const references = [];
  const confirmedAt = normalizedTradeTimestampSeconds(deal?.confirmedAt);
  const submittedAtMs = finiteNumber(deal?.submittedAt);
  const submittedAt = submittedAtMs == null ? null : normalizedTradeTimestampSeconds(submittedAtMs);
  const duration = finiteNumber(deal?.duration ?? deal?.signalExpiration) ?? 0;
  if (confirmedAt != null) {
    references.push(confirmedAt);
    if (duration > 0) references.push(confirmedAt + duration);
  }
  if (submittedAt != null) references.push(duration > 0 ? submittedAt + duration : submittedAt);
  if (references.length) {
    const rawDistance = Math.min(...references.map((reference) => Math.abs(timestamp - reference)));
    const adjustedDistance = Math.min(...references.map((reference) => Math.abs(adjusted - reference)));
    if (adjustedDistance + 30 < rawDistance) return adjusted;
    if (rawDistance + 30 < adjustedDistance) return timestamp;
  }
  const source = String(deal?.source || '').trim().toLowerCase();
  const executionSource = String(deal?.executionSource || '').trim().toLowerCase();
  const closeSource = String(deal?.closeConfirmationSource || '').trim().toLowerCase();
  if (deal?.officialApi === true || executionSource === 'official_api' || ['official_api', 'server', 'server-ledger'].includes(source)) return timestamp;
  if (deal?.brokerUiLive === true || ['broker_event', 'broker_socket', 'broker_ui'].includes(closeSource) || source === 'broker-ui-live' || source === 'autotrade') return adjusted;
  const now = Math.floor(Date.now() / 1000);
  const rawDistance = Math.abs(timestamp - now);
  const adjustedDistance = Math.abs(adjusted - now);
  return Math.min(rawDistance, adjustedDistance) <= 12 * 60 * 60 && adjustedDistance + 30 < rawDistance ? adjusted : timestamp;
}

function storedDealExpiration(deal) {
  const explicit = optionalFiniteNumber(deal?.expirationTimestamp);
  if (explicit && explicit > 0) return explicit;
  const opened = optionalFiniteNumber(deal?.openTimestamp);
  const duration = optionalFiniteNumber(deal?.duration);
  return opened && duration && duration > 0 ? opened + duration : null;
}

function storedOpenDealStillRelevant(deal, brokerOffsetSec = 0) {
  if (!deal || deal.status === 'closed' || deal.closeTimestamp) return false;
  const expiration = storedDealExpiration(deal);
  const brokerNow = Math.floor(Date.now() / 1000) + Number(brokerOffsetSec || 0);
  if (!expiration) {
    const opened = optionalFiniteNumber(deal?.openTimestamp);
    return !deal.optimistic || !opened || brokerNow - opened <= 6 * 60 * 60;
  }
  const grace = deal.optimistic ? 20 : 120;
  return brokerNow <= expiration + grace;
}


function sameStoredDealIdentity(left, right) {
  if (!left || !right) return false;
  const leftId = String(left.id || left.dealId || '').trim();
  const rightId = String(right.id || right.dealId || '').trim();
  if (leftId && rightId && leftId === rightId) return true;
  const leftRequest = String(left.requestId || '').trim();
  const rightRequest = String(right.requestId || '').trim();
  if (leftRequest && rightRequest && leftRequest === rightRequest) return true;
  // Two explicit broker ids, or two explicit request ids, are conclusive. Falling
  // through to asset/amount/time matching in that case merges distinct simultaneous
  // orders and can attach one Martingale branch's metadata to another trade.
  if (leftId && rightId) return false;
  if (leftRequest && rightRequest) return false;
  if ((left.asset || '') !== (right.asset || '')) return false;
  if (left.action && right.action && left.action !== right.action) return false;
  if (left.amount != null && right.amount != null && Math.abs(Number(left.amount) - Number(right.amount)) > 1e-8) return false;
  const leftOpen = optionalFiniteNumber(left.openTimestamp);
  const rightOpen = optionalFiniteNumber(right.openTimestamp);
  return leftOpen == null || rightOpen == null || Math.abs(leftOpen - rightOpen) <= 20;
}

function normalizedTradeTimestampSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && !/^[-+]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  const raw = finiteNumber(value);
  if (raw == null) return null;
  if (raw > 1e15) return Math.floor(raw / 1e6);
  if (raw > 1e12) return Math.floor(raw / 1000);
  if (raw > 1e10) return Math.floor(raw / 1000);
  return Math.floor(raw);
}

function tradeResetIdentityKey(deal) {
  if (!deal || typeof deal !== 'object') return null;
  const id = String(deal.id || deal.dealId || deal.ticket || '').trim();
  if (id) return `id:${id}`;
  const requestId = String(deal.requestId || deal.request_id || '').trim();
  if (requestId && !['0', 'null', 'undefined'].includes(requestId.toLowerCase())) return `request:${requestId}`;
  const asset = String(deal.asset || '').trim();
  const action = String(deal.action || '').trim();
  const amount = optionalFiniteNumber(deal.amount);
  const opened = normalizedTradeTimestampSeconds(deal.openTimestamp || deal.openedAt);
  if (!asset && !action && amount == null && opened == null) return null;
  return `finger:${asset}:${action}:${amount ?? ''}:${opened ?? ''}`;
}

function dealAfterLedgerReset(deal, ledger, brokerOffsetSec = 0) {
  const resetTimestamp = normalizedTradeTimestampSeconds(ledger?.resetTimestamp)
    ?? (ledger?.resetAt ? Math.floor(Date.parse(ledger.resetAt) / 1000) : null);
  if (!resetTimestamp) return true;

  const resetKeys = new Set(Array.isArray(ledger?.resetDealKeys) ? ledger.resetDealKeys.map(String) : []);
  const identity = tradeResetIdentityKey(deal);
  if (identity && resetKeys.has(identity)) return false;

  const timestamp = normalizedTradeTimestampSeconds(deal?.closeTimestamp)
    ?? normalizedTradeTimestampSeconds(deal?.openTimestamp)
    ?? normalizedTradeTimestampSeconds(deal?.closedAt)
    ?? normalizedTradeTimestampSeconds(deal?.openedAt);
  if (timestamp == null) return false;

  const offset = finiteNumber(brokerOffsetSec) ?? 0;
  const realTimestamp = statisticsDealTimestampSeconds(deal, timestamp, offset);
  return realTimestamp != null && realTimestamp >= resetTimestamp;
}


function tradeLedgerAccountIdentity(state) {
  const uid = state?.account?.uid != null ? String(state.account.uid).trim() : '';
  if (!uid) return null;
  const explicitMode = String(state?.account?.mode || '').trim().toUpperCase();
  const mode = explicitMode || (state?.account?.isDemo === true ? 'DEMO' : state?.account?.isDemo === false ? 'REAL' : 'UNKNOWN');
  return { uid, mode, key: `${uid}:${mode}` };
}

function dealBelongsToTradeAccount(deal, identity) {
  if (!deal || !identity) return true;
  const dealKey = String(deal.accountKey || '').trim();
  if (dealKey && dealKey !== identity.key) return false;
  const dealUid = deal.uid ?? deal.userId ?? deal.user_id ?? null;
  if (dealUid != null && String(dealUid).trim() && String(dealUid).trim() !== identity.uid) return false;
  if (deal.isDemo != null && identity.mode !== 'UNKNOWN') {
    const dealMode = Boolean(Number(deal.isDemo) || deal.isDemo === true) ? 'DEMO' : 'REAL';
    if (dealMode !== identity.mode) return false;
  }
  return true;
}

function tradeLedgerOverlapsLiveBrokerState(ledger, state) {
  const existing = [
    ...(Array.isArray(ledger?.closedDeals) ? ledger.closedDeals : []),
    ...(Array.isArray(ledger?.openDeals) ? ledger.openDeals : [])
  ].map(normalizeStoredDeal).filter(Boolean);
  if (!existing.length) return false;
  const live = [
    ...(Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals : []),
    ...(Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals : [])
  ].map(normalizeStoredDeal).filter(Boolean);
  if (!live.length) return false;
  return existing.some((oldDeal) => live.some((newDeal) => sameStoredDealIdentity(oldDeal, newDeal)));
}

function freshTradeLedgerForState(state, reason = 'account-scope-reset') {
  const identity = tradeLedgerAccountIdentity(state);
  const now = new Date();
  return {
    version: 5,
    robotOnly: true,
    accountKey: identity?.key || null,
    uid: identity?.uid || null,
    mode: identity?.mode || null,
    closedDeals: [],
    openDeals: [],
    summary: {},
    today: {},
    todayKey: localDayKey(now),
    resetAt: null,
    resetTimestamp: null,
    resetBrokerTimestamp: null,
    resetDealKeys: [],
    accountScopeReason: reason,
    updatedAt: now.toISOString()
  };
}

function scopeTradeLedgerToState(rawLedger, state) {
  const identity = tradeLedgerAccountIdentity(state);
  const ledger = rawLedger && typeof rawLedger === 'object' ? { ...rawLedger } : freshTradeLedgerForState(state, 'initial');
  if (!identity) return { ledger, identity: null, reset: false, migrated: false };
  const storedKey = String(ledger.accountKey || '').trim();
  const hasDeals = Boolean((ledger.closedDeals || []).length || (ledger.openDeals || []).length);

  if (storedKey && storedKey !== identity.key) {
    return { ledger: freshTradeLedgerForState(state, 'account-change'), identity, reset: true, migrated: false };
  }

  if (!storedKey && hasDeals) {
    // V4 and earlier were global. Preserve a legacy journal only when it can be
    // tied to the currently live broker state (or carries explicit matching UID).
    const explicitDeals = [...(ledger.closedDeals || []), ...(ledger.openDeals || [])]
      .filter((deal) => deal?.uid != null || deal?.accountKey);
    const explicitCompatible = explicitDeals.length > 0 && explicitDeals.every((deal) => dealBelongsToTradeAccount(deal, identity));
    const overlapsLive = tradeLedgerOverlapsLiveBrokerState(ledger, state);
    if (!explicitCompatible && !overlapsLive) {
      return { ledger: freshTradeLedgerForState(state, 'legacy-unscoped-reset'), identity, reset: true, migrated: false };
    }
  }

  return {
    ledger: {
      ...ledger,
      version: Math.max(5, Number(ledger.version) || 0),
      robotOnly: true,
      accountKey: identity.key,
      uid: identity.uid,
      mode: identity.mode,
      accountScopeReason: ledger.accountScopeReason || (storedKey ? 'scoped' : 'legacy-migrated')
    },
    identity,
    reset: false,
    migrated: !storedKey
  };
}

async function updateTradeLedgerUnlocked(state) {
  const stored = await chrome.storage.local.get(['poTradeLedger', ROBOT_TRADE_REGISTRY_KEY]);
  const scoped = scopeTradeLedgerToState(stored.poTradeLedger || null, state);
  const ledger = scoped.ledger;
  let registry = normalizeRobotTradeRegistry(stored[ROBOT_TRADE_REGISTRY_KEY]);
  if (scoped.identity) {
    const registryKey = String(registry.accountKey || '').trim();
    if (scoped.reset || (registryKey && registryKey !== scoped.identity.key)) {
      registry = { version: 3, accountKey: scoped.identity.key, uid: scoped.identity.uid, mode: scoped.identity.mode, trades: [], updatedAt: new Date().toISOString() };
    } else {
      registry = { ...registry, version: Math.max(3, Number(registry.version) || 0), accountKey: scoped.identity.key, uid: scoped.identity.uid, mode: scoped.identity.mode };
    }
  }
  const brokerOffsetSec = finiteNumber(state?.market?.brokerClockOffsetSec) ?? 0;
  const isAfterReset = (deal) => dealAfterLedgerReset(deal, ledger, brokerOffsetSec);

  const belongsToCurrentAccount = (deal) => dealBelongsToTradeAccount(deal, scoped.identity);
  const existingRobotClosed = (ledger.closedDeals || []).map(normalizeStoredDeal).filter(Boolean).filter(belongsToCurrentAccount).filter(isRobotTradeDeal).filter(isAfterReset);
  const existingRobotOpen = (ledger.openDeals || []).map(normalizeStoredDeal).filter(Boolean).filter(belongsToCurrentAccount).filter(isRobotTradeDeal).filter(isAfterReset);
  const references = [
    ...registry.trades,
    ...existingRobotOpen.map((deal) => robotRegistryEntryFromDeal(deal)).filter(Boolean),
    ...existingRobotClosed.map((deal) => robotRegistryEntryFromDeal(deal)).filter(Boolean)
  ];
  const rawIncomingClosed = Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals : [];
  const rawIncomingOpen = Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals : [];
  const submittedReferences = submittedUnconfirmedRobotTradeReferencesForDeals(
    [...rawIncomingClosed, ...rawIncomingOpen],
    state,
    registry.trades
  );
  const asRobot = (raw) => {
    const deal = normalizeStoredDeal(raw);
    if (!deal) return null;
    if (isRobotTradeDeal(deal)) return markRobotTradeDeal(deal);
    const exactReference = matchRobotTradeReference(deal, references);
    if (exactReference) return markRobotTradeDeal(deal, exactReference);
    const submittedReference = submittedReferences.get(String(deal.id)) || null;
    return submittedReference ? markRobotTradeDeal(deal, submittedReference) : null;
  };

  const incomingClosed = rawIncomingClosed.map(asRobot).filter(Boolean).filter(belongsToCurrentAccount).filter(isAfterReset);
  const incomingOpen = rawIncomingOpen.map(asRobot).filter(Boolean).filter(belongsToCurrentAccount).filter(isAfterReset);

  const closedMap = new Map(existingRobotClosed
    .filter(isAfterReset)
    .map((deal) => [String(deal.id), markRobotTradeDeal(deal)]));
  for (const deal of incomingClosed) {
    let mergedDeal = deal;
    for (const [key, existing] of closedMap.entries()) {
      if (!sameStoredDealIdentity(existing, deal)) continue;
      mergedDeal = mergeNormalizedStoredClosedDeal(existing, mergedDeal) || mergedDeal;
      closedMap.delete(key);
    }
    closedMap.set(String(mergedDeal.id), markRobotTradeDeal(mergedDeal));
  }
  const closedDeals = [...closedMap.values()]
    .filter(isRobotTradeDeal)
    .sort((a, b) => Number(a.closeTimestamp || 0) - Number(b.closeTimestamp || 0))
    .slice(-1500);
  const closedIds = new Set(closedDeals.map((deal) => String(deal.id)));
  const openMap = new Map(existingRobotOpen
    .filter((deal) => storedOpenDealStillRelevant(deal, brokerOffsetSec))
    .map((deal) => [String(deal.id), markRobotTradeDeal(deal)]));
  for (const deal of incomingOpen) {
    if (!closedIds.has(String(deal.id)) && storedOpenDealStillRelevant(deal, brokerOffsetSec)) {
      openMap.set(String(deal.id), markRobotTradeDeal(deal));
    }
  }
  for (const id of closedIds) openMap.delete(id);
  for (const closedDeal of closedDeals) {
    for (const [key, openDeal] of openMap.entries()) {
      if (sameStoredDealIdentity(openDeal, closedDeal)) openMap.delete(key);
    }
  }
  const openDeals = [...openMap.values()]
    .filter(isRobotTradeDeal)
    .filter((deal) => storedOpenDealStillRelevant(deal, brokerOffsetSec))
    .slice(-300);

  const registryEntries = registry.trades.filter(isAfterReset);
  for (const deal of [...openDeals, ...closedDeals]) {
    const entry = robotRegistryEntryFromDeal(deal);
    if (!entry) continue;
    const index = registryEntries.findIndex((item) => sameRobotRegistryIdentity(item, entry));
    if (index >= 0) registryEntries[index] = { ...registryEntries[index], ...entry, dealId: entry.dealId || registryEntries[index].dealId };
    else registryEntries.push(entry);
  }
  const nextRegistry = {
    version: 3,
    accountKey: scoped.identity?.key || registry.accountKey || null,
    uid: scoped.identity?.uid || registry.uid || null,
    mode: scoped.identity?.mode || registry.mode || null,
    trades: registryEntries.slice(-ROBOT_TRADE_REGISTRY_MAX),
    updatedAt: new Date().toISOString()
  };

  const todayKey = localDayKey();
  const next = {
    version: 5,
    robotOnly: true,
    accountKey: scoped.identity?.key || ledger.accountKey || null,
    uid: scoped.identity?.uid || ledger.uid || null,
    mode: scoped.identity?.mode || ledger.mode || null,
    accountScopeReason: ledger.accountScopeReason || (scoped.migrated ? 'legacy-migrated' : 'scoped'),
    closedDeals,
    openDeals,
    summary: summarizeDeals(closedDeals),
    today: summarizeDeals(closedDeals, todayKey, brokerOffsetSec),
    todayKey,
    resetAt: ledger.resetAt || null,
    resetTimestamp: normalizedTradeTimestampSeconds(ledger.resetTimestamp) ?? (ledger.resetAt ? Math.floor(Date.parse(ledger.resetAt) / 1000) : null),
    resetBrokerTimestamp: normalizedTradeTimestampSeconds(ledger.resetBrokerTimestamp) ?? null,
    resetDealKeys: Array.isArray(ledger.resetDealKeys) ? ledger.resetDealKeys.slice(-10000) : [],
    updatedAt: new Date().toISOString()
  };
  const prevComparable = JSON.stringify({ accountKey: ledger.accountKey || null, uid: ledger.uid || null, mode: ledger.mode || null, closedDeals: ledger.closedDeals || [], openDeals: ledger.openDeals || [], resetAt: ledger.resetAt || null, resetTimestamp: ledger.resetTimestamp || null, resetBrokerTimestamp: ledger.resetBrokerTimestamp || null, resetDealKeys: ledger.resetDealKeys || [], robotOnly: ledger.robotOnly === true });
  const nextComparable = JSON.stringify({ accountKey: next.accountKey || null, uid: next.uid || null, mode: next.mode || null, closedDeals, openDeals, resetAt: next.resetAt || null, resetTimestamp: next.resetTimestamp || null, resetBrokerTimestamp: next.resetBrokerTimestamp || null, resetDealKeys: next.resetDealKeys || [], robotOnly: true });
  const registryChanged = JSON.stringify({ accountKey: registry.accountKey || null, trades: registry.trades }) !== JSON.stringify({ accountKey: nextRegistry.accountKey || null, trades: nextRegistry.trades });
  if (prevComparable !== nextComparable || ledger.todayKey !== todayKey || registryChanged) {
    await chrome.storage.local.set({ poTradeLedger: next, [ROBOT_TRADE_REGISTRY_KEY]: nextRegistry });
  }
  return next;
}

function updateTradeLedger(state) {
  return serializeTradeLedgerMutation(() => updateTradeLedgerUnlocked(state));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalFiniteNumber(value) {
  if (value == null || value === '') return null;
  return finiteNumber(value);
}

function stateTimeMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value > 1_000_000_000_000 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recentMarketAlive(state, maxAgeMs = 120000) {
  const values = [stateTimeMs(state?.market?.streamUpdatedAt), stateTimeMs(state?.socket?.lastIncomingAt)];
  const subscriptions = state?.market?.subscriptions || {};
  for (const item of Object.values(subscriptions)) {
    values.push(stateTimeMs(item?.streamUpdatedAt));
    values.push(stateTimeMs(item?.lastTickTime));
  }
  const latest = Math.max(0, ...values.filter(Number.isFinite));
  return latest > 0 && Date.now() - latest <= maxAgeMs;
}

function isConnected(state) {
  const accountIdentity = Boolean(state?.account?.uid != null && state?.account?.sessionCaptured === true);
  const hardConnected = Boolean(accountIdentity && state?.connection?.connected && state?.socket?.authenticated && state?.socket?.readyState === 1);
  const backgroundHold = Boolean(accountIdentity && state?.connection?.requested
    && (state?.connection?.backgroundPaused || state?.page?.visibility === 'hidden' || state?.environment?.visibility === 'hidden'));
  const backgroundGrace = Boolean(accountIdentity && state?.connection?.requested && state?.socket?.authenticated && recentMarketAlive(state));
  return hardConnected || backgroundHold || backgroundGrace;
}

function accountKey(state) {
  const uid = state?.account?.uid;
  const mode = state?.account?.mode;
  return uid != null ? `${uid}:${mode || ''}` : null;
}

function canUseBalanceAsBaseline(state, balance) {
  return isConnected(state) && state?.account?.uid != null && balance != null;
}

function shouldRepairZeroBaseline(stats, balance) {
  const baseline = finiteNumber(stats?.baselineBalance);
  const current = finiteNumber(stats?.currentBalance);
  const reason = String(stats?.resetReason || '');
  return baseline === 0
    && balance != null
    && balance > 0
    && (current == null || current === 0 || !stats?.uid || ['initial', 'account-change', 'mode-change', 'daily', 'disconnect', 'reconnect'].includes(reason));
}

function ledgerMatchesTradeAccount(ledger, state) {
  const identity = tradeLedgerAccountIdentity(state);
  if (!identity || !ledger || typeof ledger !== 'object') return false;
  return String(ledger.accountKey || '').trim() === identity.key;
}

function inferCurrencyFromStateAndLedger(state, ledger = null, fallback = null) {
  const direct = String(state?.account?.currency || '').trim().toUpperCase();
  if (direct) return direct;
  const accountUid = state?.account?.uid != null ? String(state.account.uid) : '';
  const accountDemo = state?.account?.isDemo;
  const pools = [
    ...(Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals.slice().reverse() : []),
    ...(Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals.slice().reverse() : [])
  ];
  if (ledgerMatchesTradeAccount(ledger, state)) {
    pools.push(
      ...(Array.isArray(ledger?.closedDeals) ? ledger.closedDeals.slice().reverse() : []),
      ...(Array.isArray(ledger?.openDeals) ? ledger.openDeals.slice().reverse() : [])
    );
  }
  for (const deal of pools) {
    if (accountUid && deal?.uid != null && String(deal.uid) !== accountUid) continue;
    if (accountDemo != null && deal?.isDemo != null && Boolean(Number(deal.isDemo) || deal.isDemo === true) !== Boolean(accountDemo)) continue;
    const code = String(deal?.currency || '').trim().toUpperCase();
    if (code) return code;
  }
  const prior = String(fallback || '').trim().toUpperCase();
  return prior || null;
}

function makeProfitStats(state, balance, reason = 'initial') {
  const now = new Date();
  const safeBalance = finiteNumber(balance);
  const baseline = canUseBalanceAsBaseline(state, safeBalance) ? safeBalance : null;
  return {
    version: 2,
    accountKey: accountKey(state),
    uid: state?.account?.uid ?? null,
    mode: state?.account?.mode ?? null,
    currency: inferCurrencyFromStateAndLedger(state, null, null),
    baselineBalance: baseline,
    currentBalance: safeBalance,
    delta: 0,
    resetMode: null,
    resetReason: reason,
    resetAt: now.toISOString(),
    dayKey: localDayKey(now),
    lastConnected: isConnected(state),
    updatedAt: now.toISOString()
  };
}

async function updateProfitStats(state, options = {}) {
  const now = new Date();
  const today = localDayKey(now);
  const connected = isConnected(state);
  const balance = finiteNumber(state?.account?.balance);
  const key = accountKey(state);
  const stored = await chrome.storage.local.get(['poBridgeSettings', 'poProfitStats', 'poTradeLedger']);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.poBridgeSettings || {}) };
  const resetMode = settings.profitResetMode === 'disconnect' ? 'disconnect' : 'daily';
  let stats = stored.poProfitStats ? { ...stored.poProfitStats } : null;
  const storedStatsKey = String(stats?.accountKey || '').trim();
  const currentUid = state?.account?.uid != null ? String(state.account.uid) : '';
  const storedUid = stats?.uid != null ? String(stats.uid) : '';
  const legacyUnscoped = Boolean(stats && key && !storedStatsKey && !storedUid);
  const accountChanged = Boolean(stats && key && (
    (storedStatsKey && storedStatsKey !== key)
    || (!storedStatsKey && storedUid && currentUid && storedUid !== currentUid)
  ));
  const modeChanged = Boolean(stats && stats.resetMode && stats.resetMode !== resetMode);
  const forceReset = Boolean(options.forceReset || accountChanged || legacyUnscoped || modeChanged);
  let statsReinitialized = false;

  if (!stats || forceReset) {
    stats = makeProfitStats(state, balance, options.reason || (accountChanged ? 'account-change' : legacyUnscoped ? 'legacy-account-scope' : modeChanged ? 'mode-change' : 'initial'));
    statsReinitialized = true;
  }

  stats.resetMode = resetMode;
  stats.accountKey = key ?? stats.accountKey ?? null;
  stats.uid = state?.account?.uid ?? stats.uid ?? null;
  stats.mode = state?.account?.mode ?? stats.mode ?? null;
  const trustedCurrencyFallback = statsReinitialized || !key || storedStatsKey === key ? stats.currency : null;
  stats.currency = inferCurrencyFromStateAndLedger(state, stored.poTradeLedger || null, trustedCurrencyFallback);

  if (resetMode === 'daily' && stats.dayKey !== today) {
    stats.baselineBalance = canUseBalanceAsBaseline(state, balance) ? balance : null;
    stats.currentBalance = balance;
    stats.delta = 0;
    stats.dayKey = today;
    stats.resetReason = 'daily';
    stats.resetAt = now.toISOString();
  }

  if (resetMode === 'disconnect' && stats.lastConnected && !connected) {
    stats.baselineBalance = null;
    stats.currentBalance = balance;
    stats.delta = 0;
    stats.resetReason = 'disconnect';
    stats.resetAt = now.toISOString();
    stats.dayKey = today;
  }

  if (connected && balance != null) {
    if (stats.baselineBalance == null || shouldRepairZeroBaseline(stats, balance)) {
      stats.baselineBalance = balance;
      stats.resetReason = stats.baselineBalance === 0 ? (stats.resetReason || 'initial') : (resetMode === 'disconnect' ? 'reconnect' : (stats.resetReason || 'initial'));
      stats.resetAt = now.toISOString();
      stats.dayKey = today;
    }
    stats.currentBalance = balance;
    stats.delta = Number((balance - Number(stats.baselineBalance)).toFixed(8));
  } else if (balance != null) {
    stats.currentBalance = balance;
    if (stats.baselineBalance == null) stats.delta = 0;
  }

  stats.lastConnected = connected;

  const previous = stored.poProfitStats || null;
  const withoutTimestamp = (value) => {
    if (!value) return value;
    const copy = { ...value };
    delete copy.updatedAt;
    return copy;
  };
  const changed = JSON.stringify(withoutTimestamp(previous)) !== JSON.stringify(withoutTimestamp(stats));
  if (changed) {
    stats.updatedAt = now.toISOString();
    await chrome.storage.local.set({ poProfitStats: stats });
    return stats;
  }
  return previous || stats;
}

async function resetProfitStats(reason = 'manual') {
  const stored = await chrome.storage.local.get(['poBridgeState', 'poBridgeSettings']);
  const state = stored.poBridgeState || null;
  const balance = finiteNumber(state?.account?.balance);
  const stats = makeProfitStats(state, balance, reason);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.poBridgeSettings || {}) };
  stats.resetMode = settings.profitResetMode === 'disconnect' ? 'disconnect' : 'daily';
  await chrome.storage.local.set({ poProfitStats: stats });
  await updateActionBadge(state, stats);
  return stats;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureActionIcon();
  await migrateLegacyAffiliateStorage();
  await cleanupLegacyMirrorSupport({ reloadOpenMirrors: true }).catch(() => null);
  await initializeServerClient();
  // Establish public API reachability immediately; account bootstrap remains
  // strictly separate and still requires an explicitly connected Pocket UID.
  void syncServer({ forceBootstrap: false }).catch(() => null);
  chrome.alarms.create('pt-remote-control', { periodInMinutes: 0.5 });
  const legal = await getLegalConsent().catch(() => ({ accepted: false }));
  const shouldOpenConsent = details?.reason === 'install' || !legal.accepted;
  const stored = await chrome.storage.local.get(['poBridgeSettings', 'poBridgeState', 'poProfitStats', 'poUsageStats', 'poTradeLedger', ACTION_LAUNCH_BADGE_STORAGE_KEY]);
  const normalizedSettings = autoTradeDisarmedSettings(stored.poBridgeSettings);
  // The mandatory ten-step coach was retired. New and existing users receive
  // the same safe defaults, while autotrading remains explicitly disarmed.
  const settings = normalizedSettings;
  await chrome.storage.local.remove('ptFirstRunOnboarding').catch(() => null);
  const today = localDayKey();
  const usage = stored.poUsageStats?.dayKey === today ? stored.poUsageStats : { dayKey: today, tradeCount: 0, sources: {}, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({
    poBridgeSettings: settings,
    poAutoTradeStatus: {
      version: 1,
      enabled: false,
      state: 'off',
      reason: details?.reason === 'update' ? 'extension_update' : 'extension_install',
      message: 'Автоторговля выключена. Включите её вручную для новой сессии.',
      updatedAt: new Date().toISOString()
    },
    poUsageStats: usage,
    poTradeLedger: stored.poTradeLedger || { version: 5, robotOnly: true, accountKey: null, uid: null, mode: null, closedDeals: [], openDeals: [], summary: {}, today: {}, todayKey: today, updatedAt: new Date().toISOString() },
    [ACTION_LAUNCH_BADGE_STORAGE_KEY]: stored[ACTION_LAUNCH_BADGE_STORAGE_KEY] !== false
  });
  // Reconcile the persisted pre-update bridge snapshot before reloading Pocket tabs.
  // This is what recovers an already-missed unconfirmed order such as BHD/CNY.
  await updateTradeLedger(stored.poBridgeState || null).catch(() => stored.poTradeLedger || null);
  const stats = stored.poProfitStats || await updateProfitStats(stored.poBridgeState || null);
  await updateActionBadge(stored.poBridgeState || null, stats);
  await chrome.storage.local.remove(SIGNAL_SUBSCRIPTION_STORAGE_KEY).catch(() => null);
  persistedSignalSubscription = null;
  signalSubscriptionStateLoaded = true;
  closeServerSignalSocket('extension_installed_autotrade_reset', false);
  void reloadOpenPocketTabsAfterExtensionRefresh(details?.reason || 'update').catch(() => null);
  // Do not auto-open the full Robot on install/update. First launch is driven
  // by the toolbar icon; if consent is missing, that flow shows the six-item
  // disclosure and then leaves only the status bar visible.
  if (shouldOpenConsent) await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureActionIcon();
  await migrateLegacyAffiliateStorage();
  await cleanupLegacyMirrorSupport({ reloadOpenMirrors: true }).catch(() => null);
  await initializeServerClient();
  // Establish public API reachability immediately; account bootstrap remains
  // strictly separate and still requires an explicitly connected Pocket UID.
  void syncServer({ forceBootstrap: false }).catch(() => null);
  chrome.alarms.create('pt-remote-control', { periodInMinutes: 0.5 });
  const stored = await chrome.storage.local.get(['poBridgeState', 'poProfitStats', 'poBridgeSettings']);
  const settings = autoTradeDisarmedSettings(stored.poBridgeSettings);
  await chrome.storage.local.set({
    poBridgeSettings: settings,
    poAutoTradeStatus: {
      version: 1,
      enabled: false,
      state: 'off',
      reason: 'browser_startup',
      message: 'Автоторговля выключена после нового запуска браузера. Включите её вручную для новой сессии.',
      updatedAt: new Date().toISOString()
    }
  }).catch(() => null);
  await chrome.storage.local.remove(SIGNAL_SUBSCRIPTION_STORAGE_KEY).catch(() => null);
  persistedSignalSubscription = null;
  signalSubscriptionStateLoaded = true;
  closeServerSignalSocket('browser_startup_autotrade_reset', false);
  // Startup fallback for a browser that was closed during the extension update.
  await updateTradeLedger(stored.poBridgeState || null).catch(() => null);
  await updateActionBadge(stored.poBridgeState || null, stored.poProfitStats || null);
});



// ===================== Pocket TRADE ROBOT Remote Control v1.0.62 =====================
const REMOTE_POLL_STORAGE_KEY = 'ptRemoteLastPollAt';
const REMOTE_LIVE_PUSH_MIN_INTERVAL_MS = 2500;
let remotePollTimer = null;
let remoteLivePushTimer = null;
let remotePollBusy = false;
let remotePollPending = false;
let remotePollPendingCommands = false;
let lastRemoteLivePushAt = 0;

function normalizeRemoteNumber(value, fallback = 0, min = -Infinity, max = Infinity) {
  const raw = Number(value);
  const base = Number.isFinite(raw) ? raw : fallback;
  return Math.min(max, Math.max(min, base));
}

async function remoteCollectStatus() {
  const stored = await chrome.storage.local.get(['poBridgeState', 'poBridgeSettings', 'poAutoTradeStatus', 'poTradeLedger', 'poProfitStats', 'ptSignalDiagnostics', 'ptServerState']);
  const bridge = stored.poBridgeState || null;
  const settings = stored.poBridgeSettings || {};
  const auto = settings.autoTrade || {};
  const ledger = stored.poTradeLedger || {};
  const profit = stored.poProfitStats || {};
  const signal = stored.ptSignalDiagnostics || {};
  const serverState = stored.ptServerState || {};
  const combinedClosed = [];
  const rawClosed = [
    ...(Array.isArray(ledger.closedDeals) ? ledger.closedDeals : []),
    ...(Array.isArray(bridge?.trades?.closedDeals) ? bridge.trades.closedDeals : [])
  ];
  for (const rawDeal of rawClosed) {
    const deal = normalizeStoredDeal(rawDeal);
    if (!deal || !isRobotTradeDeal(deal)) continue;
    const existingIndex = combinedClosed.findIndex((item) => sameStoredDealIdentity(item, deal));
    if (existingIndex >= 0) combinedClosed[existingIndex] = mergeNormalizedStoredClosedDeal(combinedClosed[existingIndex], deal) || deal;
    else combinedClosed.push(deal);
  }
  const closed = combinedClosed.filter(isBrokerConfirmedClosedDeal);
  const open = (Array.isArray(ledger.openDeals) ? ledger.openDeals : (Array.isArray(bridge?.trades?.openedDeals) ? bridge.trades.openedDeals : [])).filter(isRobotTradeDeal);
  const brokerOffsetSec = finiteNumber(bridge?.market?.brokerClockOffsetSec) ?? 0;
  const statisticsDayKey = localDayKey();
  const todaySummary = summarizeDeals(closed, statisticsDayKey, brokerOffsetSec);
  const strategyCatalog = [
    ...(Array.isArray(settings.builderStrategies) ? settings.builderStrategies : []),
    ...(Array.isArray(serverState.strategies) ? serverState.strategies : [])
  ];
  const availableStrategies = [...new Map(strategyCatalog
    .map((item) => ({
      id: String(item?.id || item?.strategy_id || '').trim(),
      title: item?.title || item?.name || item?.id || item?.strategy_id,
      custom: Boolean(item?.custom || item?.isCustom || item?.userStrategy || String(item?.id || item?.strategy_id || '').startsWith('custom-') || String(item?.id || item?.strategy_id || '').startsWith('draft-'))
    }))
    .filter((item) => item.id)
    .map((item) => [item.id, item])).values()];
  const selectedRemoteStrategyIds = Array.isArray(auto.strategyIds) && auto.strategyIds.length
    ? [...new Set(auto.strategyIds.map(String).filter(Boolean))]
    : [auto.strategyId || settings.activeStrategyId].filter(Boolean).map(String);
  const accountBalance = finiteNumber(bridge?.account?.balance) ?? finiteNumber(profit.currentBalance) ?? 0;
  const todayResult = todaySummary.netProfit;
  const accountCurrency = bridge?.account?.currency || ledger.currency || profit.currency || null;
  const generatedAt = new Date().toISOString();
  return {
    statusVersion: 3,
    generatedAt,
    extensionVersion: chrome.runtime.getManifest().version,
    account: {
      uid: bridge?.account?.uid || serverState.pocketUid || null,
      mode: bridge?.account?.mode || null,
      isDemo: bridge?.account?.isDemo === true || bridge?.account?.mode === 'DEMO',
      balance: accountBalance,
      currency: accountCurrency,
      connected: isConnected(bridge),
      updatedAt: bridge?.account?.balanceUpdatedAt || bridge?.timestamp || null
    },
    connection: {
      connected: isConnected(bridge),
      requested: bridge?.connection?.requested === true,
      socketReadyState: bridge?.socket?.readyState ?? null,
      socketAuthenticated: bridge?.socket?.authenticated === true,
      lastIncomingAt: bridge?.socket?.lastIncomingAt || null,
      bridgeUpdatedAt: bridge?.timestamp || null
    },
    autoTrade: {
      enabled: Boolean(auto.enabled),
      state: stored.poAutoTradeStatus?.state || '',
      message: stored.poAutoTradeStatus?.message || '',
      amountMode: auto.amountMode === 'balancePercent' ? 'balancePercent' : 'fixed',
      amount: Number(auto.amount || settings.amount || 1),
      balancePercent: Number(auto.balancePercent || 1),
      maxAmount: Number(auto.maxAmount || 10),
      duration: Number(auto.duration || settings.duration || 60),
      period: normalizeAnalysisPeriodSeconds(auto.period || settings.period || 60, 60),
      candleOffset: Number([0, -1, -2].includes(Number(auto.candleOffset)) ? auto.candleOffset : -1),
      candleMode: Number(auto.candleOffset) === 0 ? 'current' : 'closed',
      strategyMode: selectedRemoteStrategyIds.length > 1 || auto.strategyMode === 'independent' ? 'independent' : 'best',
      decisionMode: 'direction_only',
      minPayout: Math.max(75, Number(auto.minPayout || 75)),
      direction: ['both','call','put'].includes(String(auto.direction || 'both')) ? String(auto.direction || 'both') : 'both',
      cooldown: Number(auto.cooldown || 0),
      maxConcurrent: Number(auto.maxConcurrent || 1),
      takeProfit: Number(auto.takeProfit || 0),
      stopLoss: Number(auto.stopLoss || 0),
      maxTrades: Number(auto.maxTrades || 0),
      maxLossStreak: Number(auto.maxLossStreak || 0),
      maxWinStreak: Number(auto.maxWinStreak || 0),
      onePerAsset: auto.onePerAsset !== false,
      recoveryMode: auto.recoveryMode === 'steps' ? 'steps' : 'off',
      recoveryValue: Number(auto.recoveryValue || 2),
      recoverySteps: Number(auto.recoverySteps || 0),
      recoveryAfterMax: auto.recoveryAfterMax === 'reset' ? 'reset' : 'stop',
      recoveryFollowSignal: auto.recoveryFollowSignal === true,
      recoveryPlan: (Array.isArray(auto.recoveryPlan) ? auto.recoveryPlan : []).slice(0, 5).map((step) => ({
        multiplier: Number(step?.multiplier || 1),
        minPayout: Math.max(75, Number(step?.minPayout || 75))
      })),
      strategyIds: selectedRemoteStrategyIds
    },
    signal: {
      status: signal.status || 'idle',
      lastMessageAt: signal.lastMessageAt || null,
      recoveryCount: Number(signal.recoveryCount || signal.reconnectAttempts || 0)
    },
    statistics: {
      todayResult,
      closedTrades: todaySummary.total,
      openTrades: open.length,
      winRate: todaySummary.winRate,
      statisticsWindow: 'local_calendar_day',
      statisticsDayKey,
      closedTradesLabel: 'Закрыто сегодня'
    },
    settings: {
      selectedAssets: Array.isArray(settings.selectedAssets) ? settings.selectedAssets : [],
      selectedAssetsCount: Array.isArray(settings.selectedAssets) ? settings.selectedAssets.length : 0,
      availableStrategies
    }
  };
}

async function remoteGetPocketTabOrNull() {
  const tab = await choosePocketTab().catch(() => null);
  return tab?.id ? tab : null;
}

async function remoteSendPocket(message, timeoutMs = 12000) {
  const tab = await remoteGetPocketTabOrNull();
  if (!tab?.id) throw new Error('Вкладка Pocket Option не найдена');
  await ensurePocketScripts(tab.id, tab.url).catch(() => null);
  return chrome.tabs.sendMessage(tab.id, message);
}

async function remoteUpdateSettings(patch = {}) {
  const stored = await chrome.storage.local.get('poBridgeSettings');
  const settings = stored.poBridgeSettings || {};
  const currentAuto = settings.autoTrade || {};
  const next = { ...settings };
  if (Array.isArray(patch.assets)) next.selectedAssets = [...new Set(patch.assets.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 200);
  if (patch.autoTrade && typeof patch.autoTrade === 'object') {
    const incomingAuto = { ...patch.autoTrade };
    if (incomingAuto.period != null) incomingAuto.period = normalizeAnalysisPeriodSeconds(incomingAuto.period, currentAuto.period || settings.period || 60);
    next.autoTrade = { ...currentAuto, ...incomingAuto };
  }
  if (patch.period != null) next.period = normalizeAnalysisPeriodSeconds(patch.period, next.period || 60);
  if (next.autoTrade?.period != null) {
    next.autoTrade = { ...next.autoTrade, period: normalizeAnalysisPeriodSeconds(next.autoTrade.period, next.period || 60) };
    next.period = next.autoTrade.period;
  }
  await chrome.storage.local.set({ poBridgeSettings: next });
  return next;
}

async function remoteAutoSubscriptionPlan(settings = {}) {
  const auto = settings.autoTrade || {};
  const ids = Array.isArray(auto.strategyIds) && auto.strategyIds.length
    ? [...new Set(auto.strategyIds.map(String).filter(Boolean))]
    : [auto.strategyId || settings.activeStrategyId].filter(Boolean).map(String);
  const stored = await chrome.storage.local.get('ptServerState').catch(() => ({}));
  const localCatalog = Array.isArray(settings.builderStrategies) ? settings.builderStrategies : [];
  const serverCatalog = Array.isArray(stored.ptServerState?.strategies) ? stored.ptServerState.strategies : [];
  // Local builder membership is authoritative and must win over a server UUID that
  // omits `custom:true`.
  const catalog = [...localCatalog, ...serverCatalog];
  const itemFor = (id) => catalog.find((item) => String(item?.id || item?.strategy_id || '') === String(id)) || null;
  const isConstructor = (id, item = itemFor(id)) => {
    const key = String(id || '').trim();
    const source = String(item?.source || item?.strategySource || item?.origin || item?.kind || item?.type || '').toLowerCase();
    return key.startsWith('custom-') || key.startsWith('draft-')
      || localCatalog.some((entry) => String(entry?.id || entry?.strategy_id || '') === key)
      || item?.custom === true || item?.isCustom === true || item?.userStrategy === true
      || ['custom','constructor','builder','imported','personal','user'].includes(source);
  };
  const periodFor = (id) => {
    const item = itemFor(id);
    const config = item?.config && typeof item.config === 'object' ? item.config : item && typeof item === 'object' ? item : null;
    if (isConstructor(id, item)) {
      if (Number(config?.timeframe) > 0) return normalizeAnalysisPeriodSeconds(config.timeframe, 60);
      return 60;
    }

    // Keep hard base profiles authoritative even when the server catalog carries
    // stale/default timeframe fields.
    if (id === 'builtin-pattern') return 5;
    if (id === 'builtin-smartflow' || id === 'builtin-liquidity') return 60;
    if (['builtin-trend','builtin-otc','builtin-smart','builtin-ai'].includes(id)) {
      return normalizeAnalysisPeriodSeconds(auto.strategyProfiles?.[id]?.period ?? auto.period ?? settings.period, 60);
    }
    if (Number(config?.timeframe ?? config?.analysisPeriod ?? config?.period) > 0) {
      return normalizeAnalysisPeriodSeconds(config.timeframe ?? config.analysisPeriod ?? config.period, 60);
    }
    return normalizeAnalysisPeriodSeconds(auto.period || settings.period, 60);
  };
  const offsetFor = (id) => {
    const item = itemFor(id);
    const config = item?.config && typeof item.config === 'object' ? item.config : item && typeof item === 'object' ? item : null;
    const constructor = isConstructor(id, item);
    const raw = constructor ? config?.candleOffset : (auto.strategyProfiles?.[id]?.candleOffset ?? auto.candleOffset);
    const value = Number(raw);
    if ([0, -1, -2].includes(value)) return value;
    const mode = constructor ? config?.candleMode : (auto.strategyProfiles?.[id]?.candleMode ?? auto.candleMode);
    return String(mode || 'closed') === 'current' ? 0 : -1;
  };
  const periods = Object.fromEntries(ids.map((id) => [id, periodFor(id)]));
  const rulePeriodFor = (value, basePeriod) => {
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
  };
  const requiredTargetsFor = (id) => {
    const base = Number(periods[id]) || 60;
    const item = itemFor(id);
    const config = item?.config && typeof item.config === 'object' ? item.config : item?.custom ? item : null;
    const result = [base];
    for (const rule of Array.isArray(config?.rules) ? config.rules : []) {
      if (rule && typeof rule === 'object') result.push(rulePeriodFor(rule.timeframe, base));
    }
    return [...new Set(result)];
  };
  const requiredPeriodSet = new Set();
  for (const id of ids) requiredTargetsFor(id).forEach((period) => requiredPeriodSet.add(period));
  if (!requiredPeriodSet.size) requiredPeriodSet.add(normalizeAnalysisPeriodSeconds(auto.period || settings.period, 60));
  const requiredPeriods = [...requiredPeriodSet]
    .map((period) => normalizeAnalysisPeriodSeconds(period, 60))
    .filter((period) => ALLOWED_ANALYSIS_PERIOD_SECONDS.includes(period))
    .sort((a, b) => a - b);
  const primaryPeriod = requiredPeriods[0] || 60;
  const historyOffsets = Object.fromEntries(requiredPeriods.map((period) => [period, 180]));
  for (const id of ids) {
    const sourcePeriod = Number(periods[id]) || primaryPeriod;
    const candles = offsetFor(id) === -2 ? 61 : 60;
    let requiredHistory = 180;
    for (const target of requiredTargetsFor(id)) {
      if (target < sourcePeriod || target % sourcePeriod !== 0) continue;
      const ratio = Math.max(1, target / sourcePeriod);
      requiredHistory = Math.max(requiredHistory, Math.ceil((candles + 1) * ratio) + 4);
    }
    historyOffsets[sourcePeriod] = Math.min(5000, Math.max(Number(historyOffsets[sourcePeriod]) || 0, requiredHistory));
  }
  return { primaryPeriod, requiredPeriods, historyOffsets };
}

async function remoteSubscribeForSettings(settings, assets, timeoutMs = 18000) {
  const cleanAssets = Array.isArray(assets) ? assets : [];
  if (!cleanAssets.length) return { ok: false, skipped: true, error: 'no_assets' };
  const plan = await remoteAutoSubscriptionPlan(settings);
  return remoteSendPocket({
    type: 'PO_SUBSCRIBE',
    payload: {
      assets: cleanAssets,
      period: plan.primaryPeriod,
      primaryPeriod: plan.primaryPeriod,
      periods: plan.requiredPeriods,
      historyOffsets: plan.historyOffsets,
      historyOffset: plan.historyOffsets?.[plan.primaryPeriod] || 180,
      autoManagePeriods: true
    }
  }, timeoutMs);
}

function remotePresetPayload(name) {
  if (name === 'safe') {
    return {
      assets: ['EURUSD_otc','GBPUSD_otc','EURJPY_otc','GBPJPY_otc','AUDUSD_otc','USDJPY_otc','AUDCAD_otc','NZDUSD_otc','CADJPY_otc','CHFJPY_otc'],
      autoTrade: {
        enabled: true,
        strategyIds: ['builtin-pattern','builtin-otc'],
        strategyId: 'builtin-pattern',
        amount: 1,
        duration: 5,
        period: 5,
        decisionMode: 'direction_only',
        minPayout: 75,
        maxConcurrent: 1,
        onePerAsset: true,
        cooldown: 5,
        takeProfit: 0,
        stopLoss: 0,
        maxTrades: 0
      },
      period: 5
    };
  }
  return {};
}


function normalizeRemoteBoolean(value, fallback = false) {
  if (value === true || value === 'true' || value === 1 || value === '1' || value === 'on') return true;
  if (value === false || value === 'false' || value === 0 || value === '0' || value === 'off') return false;
  return fallback;
}

function normalizeRemoteRecoveryPlan(value, current = []) {
  const fallback = [{ multiplier: 2, minPayout: 75 }, { multiplier: 4, minPayout: 75 }, { multiplier: 8, minPayout: 75 }, { multiplier: 16, minPayout: 75 }, { multiplier: 32, minPayout: 75 }];
  const source = Array.isArray(value) ? value : [];
  return fallback.map((base, index) => {
    const incoming = source[index] && typeof source[index] === 'object' ? source[index] : {};
    const existing = Array.isArray(current) && current[index] && typeof current[index] === 'object' ? current[index] : {};
    return {
      multiplier: normalizeRemoteNumber(incoming.multiplier, normalizeRemoteNumber(existing.multiplier, base.multiplier, 1, 100), 1, 100),
      duration: normalizeRemoteNumber(existing.duration, 0, 0, 86400),
      minPayout: normalizeRemoteNumber(incoming.minPayout, normalizeRemoteNumber(existing.minPayout, base.minPayout, 75, 100), 75, 100)
    };
  });
}

async function remoteExecuteCommand(command) {
  const type = String(command.command_type || command.type || '');
  const payload = command.payload || {};
  if (type === 'pause_autotrade' || type === 'stop_for_today') {
    const stored = await chrome.storage.local.get('poBridgeSettings');
    const auto = { ...(stored.poBridgeSettings?.autoTrade || {}), enabled: false };
    await chrome.storage.local.set({ poBridgeSettings: { ...(stored.poBridgeSettings || {}), autoTrade: auto } });
    closeServerSignalSocket(type);
    return { ok: true, action: type };
  }
  if (type === 'resume_autotrade') {
    const stored = await chrome.storage.local.get('poBridgeSettings');
    const settings = stored.poBridgeSettings || {};
    const auto = { ...(settings.autoTrade || {}), enabled: true, sessionStartedAt: new Date().toISOString() };
    await chrome.storage.local.set({ poBridgeSettings: { ...settings, autoTrade: auto } });
    if (Array.isArray(settings.selectedAssets) && settings.selectedAssets.length) {
      await remoteSubscribeForSettings({ ...settings, autoTrade: auto }, settings.selectedAssets, 18000).catch(() => null);
    }
    await recoverPersistentSignalChannel('remote_resume', { force: true }).catch(() => null);
    return { ok: true, action: type };
  }
  if (type === 'apply_trade_settings') {
    const autoTrade = {};
    if (payload.amount != null) autoTrade.amount = normalizeRemoteNumber(payload.amount, 1, 0.01, 100000);
    if (payload.duration != null) autoTrade.duration = normalizeRemoteNumber(payload.duration, 60, 1, 86400);
    if (payload.period != null) autoTrade.period = normalizeAnalysisPeriodSeconds(payload.period, 60);
    autoTrade.decisionMode = 'direction_only';
    delete autoTrade.minConfidence;
    if (payload.minPayout != null) autoTrade.minPayout = normalizeRemoteNumber(payload.minPayout, 75, 75, 100);
    if (payload.amountMode != null) autoTrade.amountMode = String(payload.amountMode) === 'balancePercent' ? 'balancePercent' : 'fixed';
    if (payload.balancePercent != null) autoTrade.balancePercent = normalizeRemoteNumber(payload.balancePercent, 1, 0.01, 100);
    if (payload.maxAmount != null) autoTrade.maxAmount = normalizeRemoteNumber(payload.maxAmount, 10, 0.01, 100000);
    if (payload.candleOffset != null || payload.candleMode != null) {
      const rawOffset = payload.candleOffset != null ? Number(payload.candleOffset) : (String(payload.candleMode || '') === 'current' ? 0 : -1);
      autoTrade.candleOffset = [0, -1, -2].includes(rawOffset) ? rawOffset : -1;
      autoTrade.candleMode = autoTrade.candleOffset === 0 ? 'current' : 'closed';
    }
    if (payload.strategyMode != null) autoTrade.strategyMode = String(payload.strategyMode) === 'independent' ? 'independent' : 'best';
    if (payload.direction != null) autoTrade.direction = ['both','call','put'].includes(String(payload.direction)) ? String(payload.direction) : 'both';
    if (payload.cooldown != null) autoTrade.cooldown = normalizeRemoteNumber(payload.cooldown, 5, 0, 86400);
    if (payload.maxConcurrent != null) autoTrade.maxConcurrent = normalizeRemoteNumber(payload.maxConcurrent, 1, 1, 20);
    if (payload.takeProfit != null) autoTrade.takeProfit = normalizeRemoteNumber(payload.takeProfit, 0, 0, 1000000);
    if (payload.stopLoss != null) autoTrade.stopLoss = normalizeRemoteNumber(payload.stopLoss, 0, 0, 1000000);
    if (payload.maxTrades != null) autoTrade.maxTrades = normalizeRemoteNumber(payload.maxTrades, 0, 0, 100000);
    if (payload.maxLossStreak != null) autoTrade.maxLossStreak = normalizeRemoteNumber(payload.maxLossStreak, 0, 0, 1000);
    if (payload.maxWinStreak != null) autoTrade.maxWinStreak = normalizeRemoteNumber(payload.maxWinStreak, 0, 0, 1000);
    if (payload.onePerAsset != null) autoTrade.onePerAsset = normalizeRemoteBoolean(payload.onePerAsset, true);
    if (payload.recoveryMode != null) autoTrade.recoveryMode = String(payload.recoveryMode) === 'steps' ? 'steps' : 'off';
    if (payload.recoveryValue != null) autoTrade.recoveryValue = normalizeRemoteNumber(payload.recoveryValue, 2, 1, 100);
    if (payload.recoverySteps != null) autoTrade.recoverySteps = normalizeRemoteNumber(payload.recoverySteps, 0, 0, 5);
    if (payload.recoveryAfterMax != null) autoTrade.recoveryAfterMax = String(payload.recoveryAfterMax) === 'reset' ? 'reset' : 'stop';
    if (payload.recoveryFollowSignal != null) autoTrade.recoveryFollowSignal = normalizeRemoteBoolean(payload.recoveryFollowSignal, false);
    if (Array.isArray(payload.recoveryPlan)) {
      const stored = await chrome.storage.local.get('poBridgeSettings');
      autoTrade.recoveryPlan = normalizeRemoteRecoveryPlan(payload.recoveryPlan, stored.poBridgeSettings?.autoTrade?.recoveryPlan || []);
    }
    if (Array.isArray(payload.strategyIds)) {
      autoTrade.strategyIds = [...new Set(payload.strategyIds.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 20);
      autoTrade.strategyId = autoTrade.strategyIds[0] || '';
      if (autoTrade.strategyIds.length > 1) autoTrade.strategyMode = 'independent';
    }
    const next = await remoteUpdateSettings({ autoTrade, period: autoTrade.period });
    if (next.autoTrade?.enabled && Array.isArray(next.selectedAssets) && next.selectedAssets.length) {
      await remoteSubscribeForSettings(next, next.selectedAssets, 18000).catch(() => null);
      await recoverPersistentSignalChannel('remote_apply_settings', { force: true }).catch(() => null);
    }
    return { ok: true, action: type, applied: autoTrade };
  }
  if (type === 'apply_assets') {
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const next = await remoteUpdateSettings({ assets });
    if (next.autoTrade?.enabled && next.selectedAssets?.length) {
      await remoteSubscribeForSettings(next, next.selectedAssets, 18000);
      await recoverPersistentSignalChannel('remote_apply_assets', { force: true }).catch(() => null);
    }
    return { ok: true, action: type, assets: next.selectedAssets || [] };
  }
  if (type === 'apply_strategy_preset') {
    const preset = remotePresetPayload(String(payload.preset || 'safe'));
    const next = await remoteUpdateSettings(preset);
    if (next.selectedAssets?.length) await remoteSubscribeForSettings(next, next.selectedAssets, 18000).catch(() => null);
    await recoverPersistentSignalChannel('remote_preset', { force: true }).catch(() => null);
    return { ok: true, action: type, preset: payload.preset || 'safe' };
  }
  if (type === 'reconnect_account') {
    const res = await remoteSendPocket({ type: 'PO_CONNECT' }, 15000);
    await syncServer({ forceBootstrap: true }).catch(() => null);
    return { ok: true, action: type, result: res };
  }
  if (type === 'resubscribe_market') {
    const stored = await chrome.storage.local.get('poBridgeSettings');
    const settings = stored.poBridgeSettings || {};
    const assets = Array.isArray(settings.selectedAssets) ? settings.selectedAssets : [];
    if (!assets.length) throw new Error('Активы не выбраны');
    const res = await remoteSubscribeForSettings(settings, assets, 18000);
    await recoverPersistentSignalChannel('remote_resubscribe', { force: true }).catch(() => null);
    return { ok: true, action: type, result: res };
  }
  if (type === 'force_server_sync') {
    const serverState = await syncServer({ forceBootstrap: true });
    await recoverPersistentSignalChannel('remote_server_sync', { force: true }).catch(() => null);
    return { ok: true, action: type, serverOnline: Boolean(serverState?.online) };
  }
  if (type === 'repair_all') {
    let connectResult = null;
    await remoteSendPocket({ type: 'PO_CONNECT' }, 15000).then((r) => { connectResult = r; }).catch((e) => { connectResult = { ok:false, error:String(e?.message||e) }; });
    await syncServer({ forceBootstrap: true }).catch(() => null);
    const stored = await chrome.storage.local.get('poBridgeSettings');
    const settings = stored.poBridgeSettings || {};
    if (Array.isArray(settings.selectedAssets) && settings.selectedAssets.length) {
      await remoteSubscribeForSettings(settings, settings.selectedAssets, 18000).catch(() => null);
    }
    await recoverPersistentSignalChannel('remote_repair_all', { force: true }).catch(() => null);
    return { ok: true, action: type, connectResult };
  }
  throw new Error(`Unknown remote command: ${type}`);
}

async function remotePollOnce(options = {}) {
  const includeCommands = options.includeCommands !== false;
  if (remotePollBusy) {
    remotePollPending = true;
    remotePollPendingCommands = remotePollPendingCommands || includeCommands;
    return { ok: true, queued: true };
  }
  remotePollBusy = true;
  let result = { ok: true };
  try {
    const remoteStored = await chrome.storage.local.get('ptRemoteControl').catch(() => ({}));
    if (remoteStored.ptRemoteControl?.enabled !== true) return { ok: true, skipped: true };
    const status = await remoteCollectStatus();
    const pushed = await pushRemoteControlStatus(status);
    if (pushed?.ok === false) throw new Error(pushed.error || 'REMOTE_STATUS_PUSH_FAILED');
    lastRemoteLivePushAt = Date.now();
    let commands = [];
    if (includeCommands) {
      const pending = await getRemoteControlPendingCommands();
      if (pending?.ok === false && pending?.error) throw new Error(pending.error);
      commands = Array.isArray(pending?.commands) ? pending.commands : [];
      for (const command of commands) {
        const id = String(command.command_id || command.commandId || '');
        try {
          const commandResult = await remoteExecuteCommand(command);
          if (id) await ackRemoteControlCommand(id, { ok: true, result: commandResult });
        } catch (error) {
          if (id) await ackRemoteControlCommand(id, { ok: false, error: String(error?.message || error) }).catch(() => null);
        }
      }
      if (commands.length) {
        const refreshed = await remoteCollectStatus();
        await pushRemoteControlStatus(refreshed).catch(() => null);
        lastRemoteLivePushAt = Date.now();
      }
    }
    await chrome.storage.local.set({ [REMOTE_POLL_STORAGE_KEY]: Date.now() }).catch(() => null);
    result = { ok: true, commands: commands.length, pushedAt: Date.now() };
  } catch (error) {
    const message = String(error?.message || error);
    const stored = await chrome.storage.local.get('ptRemoteControl').catch(() => ({}));
    if (stored.ptRemoteControl?.enabled === true) {
      await chrome.storage.local.set({
        ptRemoteControl: {
          ...(stored.ptRemoteControl || {}),
          lastError: message,
          lastStatusErrorAt: new Date().toISOString()
        }
      }).catch(() => null);
    }
    result = { ok: false, error: message };
  } finally {
    remotePollBusy = false;
    if (remotePollPending) {
      const pendingCommands = remotePollPendingCommands;
      remotePollPending = false;
      remotePollPendingCommands = false;
      setTimeout(() => { void remotePollOnce({ includeCommands: pendingCommands, reason: 'queued' }); }, 200);
    }
  }
  return result;
}

function scheduleRemoteLivePush(reason = 'state_change') {
  if (remoteLivePushTimer) return;
  const wait = Math.max(250, (lastRemoteLivePushAt + REMOTE_LIVE_PUSH_MIN_INTERVAL_MS) - Date.now());
  remoteLivePushTimer = setTimeout(() => {
    remoteLivePushTimer = null;
    void remotePollOnce({ includeCommands: false, reason }).catch(() => null);
  }, wait);
}

function scheduleRemotePoll(delayMs = 10000) {
  clearTimeout(remotePollTimer);
  remotePollTimer = setTimeout(async () => {
    await remotePollOnce({ includeCommands: true, reason: 'timer' }).catch(() => null);
    const stored = await chrome.storage.local.get('ptRemoteControl').catch(() => ({}));
    scheduleRemotePoll(stored.ptRemoteControl?.enabled === true ? 10000 : 60000);
  }, Math.max(2000, delayMs));
}

void scheduleRemotePoll(3000);


let serverSyncTimer = null;
let pendingForceBootstrap = false;
let lastBridgeSyncFingerprint = '';
let lastTradeLedgerInputFingerprint = '';

function bridgeTradeLedgerInputFingerprint(state) {
  const account = state?.account || {};
  const trades = state?.trades || {};
  const brokerOffsetSec = finiteNumber(state?.market?.brokerClockOffsetSec) ?? 0;
  const openedDeals = Array.isArray(trades.openedDeals) ? trades.openedDeals : [];
  const closedDeals = Array.isArray(trades.closedDeals) ? trades.closedDeals : [];
  return JSON.stringify({
    account: [account.uid ?? null, account.mode ?? null, account.isDemo ?? null],
    brokerOffsetSec,
    dayKey: localDayKey(),
    openedDeals: openedDeals.map((deal) => [deal, storedOpenDealStillRelevant(deal, brokerOffsetSec)]),
    closedDeals
  });
}

function bridgeSyncFingerprint(state) {
  if (!isConnected(state)) return 'offline';
  const account = state?.account || {};
  const latestDealTs = [
    ...(Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals : []),
    ...(Array.isArray(state?.trades?.openedDeals) ? state.trades.openedDeals : [])
  ].reduce((max, deal) => Math.max(max, Number(deal?.closeTimestamp || deal?.openTimestamp || 0) || 0), 0);
  return [
    'online',
    String(account.uid ?? ''),
    String(account.mode || ''),
    Number(account.balance || 0).toFixed(2),
    String(latestDealTs || 0)
  ].join('|');
}

function scheduleServerSync(forceBootstrap = false) {
  pendingForceBootstrap = pendingForceBootstrap || forceBootstrap;
  // Do not continuously cancel and recreate the timer when market ticks update
  // poBridgeState several times per second. The first scheduled sync must run.
  if (serverSyncTimer) return;
  serverSyncTimer = setTimeout(() => {
    const force = pendingForceBootstrap;
    pendingForceBootstrap = false;
    serverSyncTimer = null;
    void syncServer({ forceBootstrap: force }).catch(() => null);
  }, forceBootstrap ? 250 : 1200);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pt-server-recovery') void (async () => {
    // One-shot recovery is created only after a transient bootstrap/heartbeat
    // transport failure. It re-reads the live UID inside syncServer, so an alarm
    // queued for the previous account can never restore that account's token.
    await syncServer({ forceBootstrap: true });
    await recoverPersistentSignalChannel('server_transport_recovery');
  })().catch(() => null);
  if (alarm.name === 'pt-server-sync') void (async () => {
    const stored = await chrome.storage.local.get(['ptServerState', 'poBridgeState']).catch(() => ({}));
    const connected = isConnected(stored.poBridgeState || null);
    const state = stored.ptServerState || null;
    const lastError = String(state?.lastError || '');
    const accountUid = stored.poBridgeState?.account?.uid != null ? String(stored.poBridgeState.account.uid) : '';
    const tokenMissing = connected && !state?.sessionToken;
    const sessionProblem = connected && (/ACCOUNT_NOT_CONNECTED|session_missing|SERVER_OFFLINE|SERVER_SESSION_REFRESHING/i.test(lastError) || tokenMissing || !serverStateRecentlyUsable(state, accountUid));
    await syncServer({ forceBootstrap: sessionProblem });
    await recoverPersistentSignalChannel(sessionProblem ? 'server_session_keepalive' : 'server_sync_alarm');
  })().catch(() => null);
  if (alarm.name === 'pt-release-check') void checkRelease().catch(() => null);
  if (alarm.name === 'pt-remote-control') void remotePollOnce({ includeCommands: true, reason: 'alarm' }).catch(() => null);
  if (alarm.name === 'pt-signal-watchdog') void recoverPersistentSignalChannel('signal_watchdog_alarm').catch(() => null);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.ptLegalConsent?.newValue?.accepted === true) {
    // Covers the dashboard's verified local-storage fallback when the MV3 worker
    // was still waking while the user accepted the legal disclosure.
    scheduleServerSync(true);
  }
  if (changes.poBridgeState) {
    void (async () => {
      const previousBridgeIdentity = signalAccountIdentityFromBridgeState(changes.poBridgeState.oldValue || null);
      const nextBridgeIdentity = signalAccountIdentityFromBridgeState(changes.poBridgeState.newValue || null);
      const identityChanged = previousBridgeIdentity?.key !== nextBridgeIdentity?.key
        && Boolean(previousBridgeIdentity?.key || nextBridgeIdentity?.key);
      const bindingMismatch = Boolean(nextBridgeIdentity?.key && signalSocketBoundAccountKey && nextBridgeIdentity.key !== signalSocketBoundAccountKey);
      if (identityChanged || bindingMismatch) {
        markSignalBindingChanged('bridge_account_context_changed');
        if (signalSocket) closeServerSignalSocket('bridge_account_context_changed', false);
      }
      const state = changes.poBridgeState.newValue || null;
      // Reset account-scoped server credentials before any socket can reuse them.
      // This prevents a previous UID's token/Premium/ws state from leaking into
      // the first seconds after Pocket switches accounts in the same tab.
      if (identityChanged || bindingMismatch) {
        await bindServerAccountContext(state);
      }
      // Scope/migrate the robot ledger before deriving P/L or currency. Otherwise
      // a just-switched UID:MODE can briefly inherit the previous account journal.
      const ledgerInputFingerprint = bridgeTradeLedgerInputFingerprint(state);
      if (ledgerInputFingerprint !== lastTradeLedgerInputFingerprint) {
        await updateTradeLedger(state);
        lastTradeLedgerInputFingerprint = ledgerInputFingerprint;
      }
      const stats = await updateProfitStats(state);
      await updateActionBadge(state, stats);
      const fingerprint = bridgeSyncFingerprint(state);
      if (fingerprint !== lastBridgeSyncFingerprint) {
        lastBridgeSyncFingerprint = fingerprint;
        if (isConnected(state)) {
          const storedServer = await chrome.storage.local.get('ptServerState').catch(() => ({}));
          const serverState = storedServer.ptServerState || null;
          const lastError = String(serverState?.lastError || '');
          const accountUid = state?.account?.uid != null ? String(state.account.uid) : '';
          const needsForceBootstrap = (
            serverState?.online !== true
            || !serverState?.sessionToken
            || String(serverState?.sessionUid || '') !== accountUid
            || /ACCOUNT_NOT_CONNECTED|session_missing|SERVER_OFFLINE|SERVER_SESSION_REFRESHING/i.test(lastError)
            || Boolean(accountUid && serverState?.pocketUid && String(serverState.pocketUid) !== accountUid)
          );
          scheduleServerSync(needsForceBootstrap);
        }
      }
      void ensureServerSignalSocket();
    })();
  }
  if (changes.poBridgeSettings) {
    const oldMode = changes.poBridgeSettings.oldValue?.profitResetMode;
    const newMode = changes.poBridgeSettings.newValue?.profitResetMode;
    if (oldMode && newMode && oldMode !== newMode) {
      void resetProfitStats('mode-change');
    }
    void ensureServerSignalSocket();
  }
  if (changes.ptServerState) {
    const oldUid = changes.ptServerState.oldValue?.pocketUid != null ? String(changes.ptServerState.oldValue.pocketUid).trim() : '';
    const newUid = changes.ptServerState.newValue?.pocketUid != null ? String(changes.ptServerState.newValue.pocketUid).trim() : '';
    const serverUidChanged = Boolean(oldUid && newUid && oldUid !== newUid);
    const serverBindingMismatch = Boolean(newUid && signalSocketBoundUid && newUid !== signalSocketBoundUid);
    if (serverUidChanged || serverBindingMismatch) {
      markSignalBindingChanged('server_session_uid_changed');
      if (signalSocket) closeServerSignalSocket('server_session_uid_changed', false);
    }
    void handleEntitlementTransition(changes.ptServerState.oldValue || null, changes.ptServerState.newValue || null);
    void ensureServerSignalSocket();
  }
  if (changes.poTradeLedger && !changes.poBridgeState) {
    void (async () => {
      const { poBridgeState } = await chrome.storage.local.get('poBridgeState');
      await updateActionBadge(poBridgeState || null, null);
    })();
  }
  if (changes.poProfitStats && !changes.poBridgeState) {
    void (async () => {
      const { poBridgeState } = await chrome.storage.local.get('poBridgeState');
      await updateActionBadge(poBridgeState || null, changes.poProfitStats.newValue || null);
    })();
  }
  if (changes.ptUiLanguage && !changes.poBridgeState) {
    void (async () => {
      const { poBridgeState } = await chrome.storage.local.get('poBridgeState');
      await updateActionBadge(poBridgeState || null, null);
    })();
  }
  if (changes.poBridgeState || changes.poBridgeSettings || changes.poAutoTradeStatus || changes.poTradeLedger || changes.poProfitStats || changes.ptSignalDiagnostics || changes.ptServerState) {
    scheduleRemoteLivePush('storage_change');
  }
});

let lastActionBadgeFingerprint = '';

async function updateActionBadge(state, stats = null) {
  const connected = isConnected(state);
  const stored = await chrome.storage.local.get(['ptServerState', 'poTradeLedger', 'ptUiLanguage', ACTION_LAUNCH_BADGE_STORAGE_KEY]);
  const ptServerState = stored.ptServerState;
  const poTradeLedger = stored.poTradeLedger;
  const language = normalizeBackgroundLanguage(stored.ptUiLanguage);
  const copy = BACKGROUND_UI[language];

  // First-launch call to action: keep the toolbar invitation visible until the
  // user explicitly clicks the Pocket TRADE ROBOT icon once. Afterwards the
  // normal FREE / PRO / account-state badge is restored and the invitation
  // never reappears on browser restart or later extension updates.
  let badge = '';
  let color = '#287cd9';
  let title = '';
  if (stored[ACTION_LAUNCH_BADGE_STORAGE_KEY] !== false) {
    badge = copy.launchBadge || ACTION_LAUNCH_BADGE_TEXT;
    color = '#6d4aff';
    title = copy.launchTitle || ACTION_LAUNCH_BADGE_TITLE;
  } else {
    const code = entitlementCode(ptServerState?.entitlement);
    badge = !connected ? '' : code === 'premium_active' ? 'PRO' : code === 'premium_paused' ? '!' : code === 'blocked' ? 'X' : 'FREE';
    color = code === 'premium_active' ? '#d99b21' : code === 'premium_paused' ? '#d86f24' : code === 'blocked' ? '#d83b5c' : '#287cd9';
    if (connected) {
      const displayCurrency = inferCurrencyFromStateAndLedger(state, poTradeLedger || null, null);
      const pnl = formatRobotProfit(poTradeLedger, displayCurrency, language);
      const plan = code === 'premium_active' ? copy.premiumActivePlan : code === 'premium_paused' ? copy.premiumPausedPlan : code === 'blocked' ? copy.blockedPlan : copy.freePlan;
      title = `Pocket TRADE ROBOT · ${plan} · ${state?.account?.mode || ''} · UID ${state?.account?.uid ?? '—'} · ${formatBalance({ ...(state?.account || {}), currency: displayCurrency }, language)} · ${pnl}`;
    } else {
      title = `Pocket TRADE ROBOT · ${copy.noConnection}`;
    }
  }
  const fingerprint = JSON.stringify([badge, color, title]);
  if (fingerprint === lastActionBadgeFingerprint) return;
  await Promise.all([
    chrome.action.setBadgeText({ text: badge }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setTitle({ title })
  ]);
  lastActionBadgeFingerprint = fingerprint;
}

function currencySuffix(currency) {
  const code = String(currency || '').toUpperCase();
  if (code === 'USD') return '$';
  if (code === 'EUR') return '€';
  if (code === 'GBP') return '£';
  if (code === 'RUB') return '₽';
  return code ? ` ${code}` : '';
}

function formatBalance(account, language = 'ru') {
  const normalized = normalizeBackgroundLanguage(language);
  const copy = BACKGROUND_UI[normalized];
  if (account?.balance == null) return `${copy.balance} —`;
  const number = Number(account.balance);
  const value = Number.isFinite(number)
    ? number.toLocaleString(({ ru: 'ru-RU', en: 'en-GB', es: 'es-ES', hi: 'hi-IN', ar: 'ar-SA' })[normalized], { maximumFractionDigits: 2 })
    : String(account.balance);
  return `${copy.balance} ${value}${currencySuffix(account.currency)}`;
}

function formatRobotProfit(ledger, currency, language = 'ru') {
  const normalized = normalizeBackgroundLanguage(language);
  const copy = BACKGROUND_UI[normalized];
  const delta = finiteNumber(ledger?.today?.netProfit) ?? 0;
  const sign = delta > 0 ? '+' : '';
  const label = delta < 0 ? copy.loss : copy.profit;
  const formatted = delta.toLocaleString(({ ru: 'ru-RU', en: 'en-GB', es: 'es-ES', hi: 'hi-IN', ar: 'ar-SA' })[normalized], { maximumFractionDigits: 2 });
  return `${label} (${sign}${formatted}${currencySuffix(currency)})`;
}

async function pinPocketTab(tab) {
  if (!tab?.id) return;
  try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}
}

async function findPocketTabs() {
  const tabs = await chrome.tabs.query({});
  const pocketTabs = tabs.filter((tab) => isPocketTerminalUrl(tab.url));
  for (const tab of pocketTabs) void pinPocketTab(tab);
  return pocketTabs;
}

async function choosePocketTab() {
  const tabs = await findPocketTabs();
  const focusedWindow = await chrome.windows.getLastFocused().catch(() => null);
  const tab = tabs.find((item) => item.active && item.windowId === focusedWindow?.id)
    || tabs.find((item) => item.active)
    || tabs.sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0]
    || null;
  void pinPocketTab(tab);
  return tab;
}

async function focusTab(tab) {
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

async function openDashboard(screenInfo = {}) {
  const pocketTab = await choosePocketTab().catch(() => null);
  if (pocketTab?.id) {
    await focusTab(pocketTab).catch(() => null);

    // Supported domains are static: pocketoption.com and hidden po.trade compatibility.
    // Unsupported po-*** mirrors never reach choosePocketTab(); they are handled by
    // the same-tab VPN notice flow before any Robot bootstrap.
    await ensurePocketScripts(pocketTab.id, pocketTab.url).catch(() => null);
    const liveState = await readLivePocketTabState(pocketTab.id).catch(() => null);
    const eligible = isPocketRobotEligibleContext(pocketTab.url, liveState);
    if (!eligible) {
      await chrome.storage.local.set({ [PENDING_LOGIN_WAIT_STORAGE_KEY]: pendingLoginWaitMarker('open_dashboard_guest') }).catch(() => null);
      if (isPocketGuestUrl(pocketTab.url)) await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
      await chrome.tabs.sendMessage(pocketTab.id, {
        type: 'PT_SHOW_STATUS_BAR',
        payload: { source: 'open_dashboard_guest', pulse: true, waitingForLogin: true, forceVisible: true }
      }).catch(() => null);
      return { ok: true, embedded: false, statusBarOnly: true, waitingForLogin: true, tabId: pocketTab.id };
    }
    await chrome.storage.local.remove(PENDING_LOGIN_WAIT_STORAGE_KEY).catch(() => null);
    const embedded = await chrome.tabs.sendMessage(pocketTab.id, {
      type: 'PT_OPEN_IN_PAGE_DASHBOARD',
      payload: { source: 'background_open_dashboard', requestedAt: new Date().toISOString() }
    }).catch(() => ({ ok: false }));
    if (embedded?.ok) return { ok: true, embedded: embedded?.embedded === true, statusBarOnly: embedded?.statusBarOnly === true, tabId: pocketTab.id, windowId: pocketTab.windowId, result: embedded };
    const ensured = await ensurePocketScripts(pocketTab.id, pocketTab.url).catch(() => ({ ok: false }));
    if (ensured?.ok) {
      const retry = await chrome.tabs.sendMessage(pocketTab.id, {
        type: 'PT_OPEN_IN_PAGE_DASHBOARD',
        payload: { source: 'background_open_dashboard_retry', requestedAt: new Date().toISOString() }
      }).catch(() => ({ ok: false }));
      if (retry?.ok) return { ok: true, embedded: retry?.embedded === true, statusBarOnly: retry?.statusBarOnly === true, tabId: pocketTab.id, windowId: pocketTab.windowId, result: retry, recovered: true };
    }
  }

  await chrome.storage.local.set({
    ptPendingStatusBarPulse: true,
    [PENDING_LOGIN_WAIT_STORAGE_KEY]: pendingLoginWaitMarker('open_dashboard_new_tab')
  }).catch(() => null);
  await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
  const created = await chrome.tabs.create({ url: POCKET_OPTION_SMART_URL, active: true });
  return { ok: true, embedded: false, pendingLogin: true, statusBarOnly: true, tabId: created?.id || null, url: POCKET_OPTION_SMART_URL };
}


const vpnRequiredPopupWindows = new Map();
const vpnRequiredPopupLastShownAt = new Map();
const VPN_REQUIRED_NOTIFICATION_COOLDOWN_MS = 30000;
const VPN_REQUIRED_NOTIFICATION_PREFIX = 'pt-vpn-required-';

function vpnRequiredNotificationId(tabId) {
  return `${VPN_REQUIRED_NOTIFICATION_PREFIX}${Number(tabId) || 0}`;
}

async function closeVpnRequiredPopupsForTab(tabId) {
  const numericTabId = Number(tabId);
  for (const [windowId, ownerTabId] of Array.from(vpnRequiredPopupWindows.entries())) {
    if (Number(ownerTabId) !== numericTabId) continue;
    vpnRequiredPopupWindows.delete(windowId);
    await chrome.windows.remove(windowId).catch(() => null);
  }
}

async function showVpnRequiredPopup(tabId, url, { force = false } = {}) {
  // v1.0.81: retired. Never open a separate Chrome popup for mirror/VPN guidance.
  return { ok: false, disabled: true, extensionPageRequired: true, force: Boolean(force) };
}

async function showVpnRequiredNotification(tabId, url, { force = false } = {}) {
  const mirror = isUnsupportedPocketMirrorUrl(url);
  const official = isPocketTerminalUrl(url);
  if (!tabId || (!official && !mirror) || !chrome.notifications) return { ok: false, unsupported: true };
  const numericTabId = Number(tabId);
  const now = Date.now();
  const lastShownAt = Number(vpnRequiredPopupLastShownAt.get(numericTabId) || 0);
  if (!force && now - lastShownAt < VPN_REQUIRED_NOTIFICATION_COOLDOWN_MS) {
    return { ok: true, cooldown: true };
  }
  vpnRequiredPopupLastShownAt.set(numericTabId, now);
  const id = vpnRequiredNotificationId(numericTabId);
  try {
    let mirrorHost = '';
    try { mirrorHost = new URL(String(url || '')).hostname; } catch {}
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Pocket TRADE ROBOT: нужен VPN',
      message: mirror
        ? `Открыто зеркало ${mirrorHost || 'po-***.com'}. Включите VPN и перейдите на официальный Pocket Option.`
        : 'Официальный Pocket Option не отвечает. Включите VPN и повторите подключение.',
      buttons: [{ title: 'VPN включён — повторить' }],
      priority: 2
    });
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function officialPocketAppearsUnreachable(url) {
  if (!isPocketTerminalUrl(url)) return false;
  let target;
  try {
    const source = new URL(String(url));
    target = `${source.origin}/`;
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    // Any HTTP response, including 401/403/405, proves that the official host
    // is reachable.  Only a network error or timeout should suggest VPN.
    await fetch(target, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    });
    return false;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function vpnRequiredPageUrl(tabId, url, mode = 'tab', preferredLanguage = '') {
  const source = new URL(String(url || ''));
  const langMatch = String(source.pathname || '').match(/^\/(ru|en)(?:\/|$)/i);
  const candidate = String(preferredLanguage || langMatch?.[1] || 'ru').toLowerCase().split('-')[0];
  const lang = ['ru', 'en', 'es', 'hi', 'ar'].includes(candidate) ? candidate : 'ru';
  const page = new URL(chrome.runtime.getURL(VPN_REQUIRED_POPUP_PAGE));
  page.searchParams.set('tabId', String(Number(tabId) || 0));
  page.searchParams.set('lang', lang);
  page.searchParams.set('host', source.hostname);
  page.searchParams.set('sourceUrl', source.href);
  page.searchParams.set('target', canonicalPocketTargetForMirror(source.href));
  page.searchParams.set('mode', mode);
  return page.href;
}

async function showVpnRequiredInSameTab(tabId, url) {
  const numericTabId = Number(tabId);
  if (!numericTabId || !isUnsupportedPocketMirrorUrl(url)) return { ok: false, error: 'mirror_not_recognized' };
  const stored = await chrome.storage.local.get('ptUiLanguage').catch(() => ({}));
  const target = vpnRequiredPageUrl(numericTabId, url, 'tab', stored?.ptUiLanguage);
  const updated = await chrome.tabs.update(numericTabId, { url: target, active: true }).catch(() => null);
  if (!updated?.id) return { ok: false, error: 'notice_navigation_failed' };
  if (updated.windowId != null) await chrome.windows.update(updated.windowId, { focused: true }).catch(() => null);
  return { ok: true, tabId: updated.id, target, sameTab: true };
}

async function handleUnsupportedMirror(tabId, url, { force = false } = {}) {
  if (!tabId || !isUnsupportedPocketMirrorUrl(url)) return { ok: false };

  // Do not inject scripts into rotating po-***.com mirrors. Detect the URL with
  // the tabs permission, show a native VPN notification, and replace only that
  // tab with the extension-owned guidance page. This preserves automatic mirror
  // detection while avoiding broad access to every HTTPS site.
  await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
  await chrome.notifications?.clear?.(`pt-mirror-permission-${Number(tabId) || 0}`).catch(() => null);
  await chrome.notifications?.clear?.(vpnRequiredNotificationId(tabId)).catch(() => null);
  await closeMirrorPermissionPopupsForTab(tabId).catch(() => null);
  await closeVpnRequiredPopupsForTab(tabId).catch(() => null);
  // A native notification is the permission-free fallback if the browser
  // delays or blocks the same-tab extension page for any reason.
  await showVpnRequiredNotification(tabId, url, { force }).catch(() => null);

  const sameTab = await showVpnRequiredInSameTab(tabId, url).catch(() => ({ ok: false }));
  return sameTab?.ok
    ? { ok: true, notice: sameTab, sameTab: true, fallback: true }
    : { ok: false, error: 'vpn_notice_unavailable', force: Boolean(force) };
}

const MIRROR_PERMISSION_POPUP_PAGE = 'mirror-permission.html';
const MIRROR_PERMISSION_NOTIFICATION_PREFIX = 'pt-mirror-permission-';

function mirrorPermissionNotificationId(tabId) {
  return `${MIRROR_PERMISSION_NOTIFICATION_PREFIX}${Number(tabId) || 0}`;
}

async function closeMirrorPermissionPopupsForTab(tabId) {
  const numericTabId = Number(tabId);
  const prefix = chrome.runtime.getURL(MIRROR_PERMISSION_POPUP_PAGE);
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const windowIds = new Set();
  for (const item of tabs) {
    try {
      if (!String(item?.url || '').startsWith(prefix)) continue;
      const popupUrl = new URL(item.url);
      const owner = Number(popupUrl.searchParams.get('tabId'));
      if (numericTabId && owner !== numericTabId) continue;
      if (item.windowId != null) windowIds.add(Number(item.windowId));
      else if (item.id) await chrome.tabs.remove(item.id).catch(() => null);
    } catch {}
  }
  for (const windowId of windowIds) await chrome.windows.remove(windowId).catch(() => null);
}

async function showMirrorPermissionPopup() {
  // Kept as a compatibility no-op for any stale call path from an older page context.
  return { ok: false, disabled: true, vpnRequired: false };
}

async function showMirrorPermissionNotification(tabId) {
  await chrome.notifications?.clear?.(mirrorPermissionNotificationId(tabId)).catch(() => null);
  return { ok: false, disabled: true };
}

async function promptOpenPocketMirrorsMissingPermission(source = 'mirror_scan') {
  return { ok: true, source, disabled: true };
}

async function finishPocketTabBootstrap(tabId, url, source = 'pocket_tab_ready') {
  if (!tabId || !isPocketTerminalUrl(url)) return { ok: false, error: 'Pocket Option tab unavailable' };
  const bridge = await ensurePocketScripts(tabId, url).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  if (!bridge?.ok) {
    const vpnRequired = await officialPocketAppearsUnreachable(url).catch(() => false);
    if (vpnRequired) await showVpnRequiredNotification(tabId, url).catch(() => null);
    return { ...(bridge || { ok: false }), vpnRequired };
  }
  await chrome.notifications?.clear?.(vpnRequiredNotificationId(tabId)).catch(() => null);
  vpnRequiredPopupLastShownAt.delete(Number(tabId));
  await pinPocketTab({ id: tabId }).catch(() => null);
  await chrome.storage.local.set({ ptLastPocketOrigin: new URL(url).origin }).catch(() => null);
  const liveState = await readLivePocketTabState(tabId).catch(() => null);
  const robotEligible = isPocketRobotEligibleContext(url, liveState);
  await chrome.tabs.sendMessage(tabId, {
    type: 'PT_SHOW_STATUS_BAR',
    payload: { source, pulse: true, waitingForLogin: !robotEligible, forceVisible: true }
  }).catch(() => null);
  const flags = await chrome.storage.local.get(['ptPendingEmbeddedDashboardOpen', 'ptPendingStatusBarPulse', PENDING_LOGIN_WAIT_STORAGE_KEY]).catch(() => ({}));
  const waitingMarker = flags?.[PENDING_LOGIN_WAIT_STORAGE_KEY];
  const waitingMarkerAt = Number(waitingMarker?.at || 0);
  const waitingMarkerFresh = Boolean(waitingMarkerAt && Date.now() - waitingMarkerAt <= PENDING_LOGIN_WAIT_TTL_MS);
  const pendingDashboard = flags?.ptPendingEmbeddedDashboardOpen;
  const pendingDashboardAt = Number(pendingDashboard?.at || 0);
  const pendingDashboardFresh = Boolean(pendingDashboardAt && Date.now() - pendingDashboardAt <= PENDING_LOGIN_WAIT_TTL_MS);
  const tradingAccountPage = robotEligible;
  const waitingForLoginPage = !robotEligible;
  if (waitingForLoginPage && pendingDashboard && isPocketGuestUrl(url)) {
    await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
  }
  if (tradingAccountPage && pendingDashboardFresh) {
    await chrome.tabs.sendMessage(tabId, {
      type: 'PT_OPEN_IN_PAGE_DASHBOARD',
      payload: { source: `${source}_pending_dashboard`, requestedAt: new Date().toISOString() }
    }).catch(() => null);
    await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
  } else if (tradingAccountPage && pendingDashboard && !pendingDashboardFresh) {
    await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
  }
  if (flags?.ptPendingStatusBarPulse) await chrome.storage.local.remove('ptPendingStatusBarPulse').catch(() => null);
  if (tradingAccountPage && waitingMarkerFresh) {
    await chrome.storage.local.remove(PENDING_LOGIN_WAIT_STORAGE_KEY).catch(() => null);
  }
  if (tradingAccountPage) {
    void restoreSignalSubscriptionState({ force: true })
      .then(() => recoverPersistentSignalChannel('pocket_tab_ready'))
      .catch(() => null);
  }
  return { ok: true, bridge };
}

async function retireLegacyMirrorPermissionNotification(notificationId) {
  const id = String(notificationId || '');
  if (!id.startsWith(MIRROR_PERMISSION_NOTIFICATION_PREFIX)) return false;
  const tabId = Number(id.slice(MIRROR_PERMISSION_NOTIFICATION_PREFIX.length));
  await chrome.notifications?.clear?.(id).catch(() => null);
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab?.id && isUnsupportedPocketMirrorUrl(tab.url)) {
    await handleUnsupportedMirror(tab.id, tab.url, { force: true }).catch(() => null);
  }
  return true;
}

chrome.windows.onRemoved.addListener((windowId) => {
  vpnRequiredPopupWindows.delete(windowId);
});

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (String(notificationId || '').startsWith(VPN_REQUIRED_NOTIFICATION_PREFIX)) {
      const tabId = Number(String(notificationId).slice(VPN_REQUIRED_NOTIFICATION_PREFIX.length));
      void (async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.id && isUnsupportedPocketMirrorUrl(tab.url)) await handleUnsupportedMirror(tab.id, tab.url, { force: true });
        else if (tab?.id && isPocketTerminalUrl(tab.url)) await chrome.tabs.reload(tab.id, { bypassCache: false }).catch(() => null);
        else if (tab?.id) await chrome.tabs.update(tab.id, { url: `${CANONICAL_POCKET_ORIGIN}/`, active: true }).catch(() => null);
        else await chrome.tabs.create({ url: `${CANONICAL_POCKET_ORIGIN}/`, active: true }).catch(() => null);
        await chrome.notifications.clear(notificationId).catch(() => null);
      })();
      return;
    }
    if (String(notificationId || '').startsWith(MIRROR_PERMISSION_NOTIFICATION_PREFIX)) {
      void retireLegacyMirrorPermissionNotification(notificationId);
      return;
    }
    if (!String(notificationId || '').startsWith('server-notification-')) return;
    void (async () => {
      await chrome.storage.local.set({ ptRequestedDashboardTab: 'notifications' });
      await openDashboard();
      await chrome.notifications.clear(notificationId).catch(() => null);
    })();
  });
  chrome.notifications.onButtonClicked.addListener((notificationId) => {
    if (String(notificationId || '').startsWith(VPN_REQUIRED_NOTIFICATION_PREFIX)) {
      const tabId = Number(String(notificationId).slice(VPN_REQUIRED_NOTIFICATION_PREFIX.length));
      void (async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.id && isPocketTerminalUrl(tab.url)) {
          await chrome.tabs.reload(tab.id, { bypassCache: false }).catch(() => null);
        } else {
          // Mirrors are unsupported. After VPN is enabled, go directly to the
          // canonical pocketoption.com domain so the user cannot loop back to po-***.
          const target = tab?.url && isUnsupportedPocketMirrorUrl(tab.url)
            ? canonicalPocketTargetForMirror(tab.url)
            : `${CANONICAL_POCKET_ORIGIN}/`;
          if (tab?.id) await chrome.tabs.update(tab.id, { url: target, active: true }).catch(() => null);
          else await chrome.tabs.create({ url: target, active: true }).catch(() => null);
        }
        await chrome.notifications.clear(notificationId).catch(() => null);
      })();
      return;
    }
    if (String(notificationId || '').startsWith(MIRROR_PERMISSION_NOTIFICATION_PREFIX)) {
      void retireLegacyMirrorPermissionNotification(notificationId);
      return;
    }
    if (!String(notificationId || '').startsWith('server-notification-')) return;
    void (async () => {
      const stored = await chrome.storage.local.get('ptServerNotificationActions');
      const url = stored.ptServerNotificationActions?.[notificationId];
      if (url) await chrome.tabs.create({ url }).catch(() => null);
      else {
        await chrome.storage.local.set({ ptRequestedDashboardTab: 'notifications' });
        await openDashboard();
      }
      await chrome.notifications.clear(notificationId).catch(() => null);
    })();
  });
}


chrome.action.onClicked.addListener(async () => {
  try {
    // The call-to-action badge is one-time only. As soon as the user follows
    // the invitation and clicks the icon, permanently dismiss it and restore
    // the normal connection/access badge.
    await chrome.storage.local.set({ [ACTION_LAUNCH_BADGE_STORAGE_KEY]: false }).catch(() => null);
    const actionState = await chrome.storage.local.get(['poBridgeState', 'poProfitStats']).catch(() => ({}));
    await updateActionBadge(actionState.poBridgeState || null, actionState.poProfitStats || null).catch(() => null);

    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    if (activeTab?.id && isUnsupportedPocketMirrorUrl(activeTab.url)) {
      await focusTab(activeTab).catch(() => null);
      await handleUnsupportedMirror(activeTab.id, activeTab.url, { force: true });
      return;
    }

    const pocketTab = await choosePocketTab().catch(() => null);
    if (pocketTab?.id) {
      await focusTab(pocketTab).catch(() => null);

      // No per-domain prompt exists in v1.0.80. Only static supported hosts
      // can be selected as a Pocket tab.
      const controller = await ensurePocketScripts(pocketTab.id, pocketTab.url).catch((error) => ({
        ok: false,
        error: String(error?.message || error || 'CONTROLLER_UNAVAILABLE')
      }));
      if (!controller?.ok) {
        await Promise.all([
          chrome.action.setBadgeText({ text: '!' }).catch(() => null),
          chrome.action.setBadgeBackgroundColor({ color: '#dc3545' }).catch(() => null)
        ]);
        if (chrome.notifications) {
          await chrome.notifications.create(`pt-controller-unavailable-${pocketTab.id}`, {
            type: 'basic',
            iconUrl: 'icon128.png',
            title: 'Pocket TRADE ROBOT не запущен',
            message: 'Разрешите расширению доступ к pocketoption.com или po.trade, затем ещё раз нажмите значок робота.',
            priority: 2
          }).catch(() => null);
        }
        return;
      }
      const liveState = await readLivePocketTabState(pocketTab.id).catch(() => null);
      const tradingAccountPage = isPocketRobotEligibleContext(pocketTab.url, liveState);
      const staleAffiliateTracking = affiliateTrackingState(pocketTab.url) === 'stale';
      if (staleAffiliateTracking) {
        if (tradingAccountPage || isPocketPotentialAccountUrl(pocketTab.url)) {
          // The old query string is cosmetic once the user is in /cabinet/. Remove
          // it through History API without a reload so a logged-in DEMO/REAL session,
          // chart state and open dashboard are not disturbed.
          await clearStaleAffiliateTrackingWithoutReload(pocketTab.id).catch(() => false);
        } else {
          // A guest tab opened by an older build must not be reused with the old
          // affiliate campaign. Continue the same toolbar click through the current
          // registration link instead of creating a duplicate tab.
          await chrome.storage.local.set({
            ptPendingStatusBarPulse: true,
            [PENDING_LOGIN_WAIT_STORAGE_KEY]: pendingLoginWaitMarker('action_click_affiliate_migration')
          }).catch(() => null);
          await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
          await chrome.tabs.update(pocketTab.id, { url: POCKET_OPTION_SMART_URL, active: true });
          return;
        }
      }
      const waitingForLogin = !tradingAccountPage;
      if (waitingForLogin) {
        await chrome.storage.local.set({
          [PENDING_LOGIN_WAIT_STORAGE_KEY]: pendingLoginWaitMarker('action_click_guest'),
          ptPendingStatusBarPulse: true
        }).catch(() => null);
      } else {
        await chrome.storage.local.remove(PENDING_LOGIN_WAIT_STORAGE_KEY).catch(() => null);
      }
      // /try-demo must never carry a pending Robot open. A non-guest /cabinet/
      // click may survive a navigation; bootstrap rechecks live UID.
      if (isPocketGuestUrl(pocketTab.url)) {
        await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
      } else if (tradingAccountPage || isPocketPotentialAccountUrl(pocketTab.url)) {
        await chrome.storage.local.set({
          ptPendingEmbeddedDashboardOpen: {
            at: Date.now(),
            source: 'action_click_open_robot',
            url: String(pocketTab.url || '')
          }
        }).catch(() => null);
      }
      await chrome.tabs.sendMessage(pocketTab.id, {
        type: 'PT_SHOW_STATUS_BAR',
        payload: {
          source: 'action_click',
          pulse: true,
          waitingForLogin,
          forceVisible: true
        }
      }).catch(() => null);

      // /try-demo is guest-only: show "Waiting for login" and never the legal modal.
      // On demo-quick/real-quick the explicit toolbar click opens Robot; content.js
      // decides whether to show the six-point disclosure or respect "don't show again".
      if (tradingAccountPage) {
        const opened = await chrome.tabs.sendMessage(pocketTab.id, {
          type: 'PT_OPEN_IN_PAGE_DASHBOARD',
          payload: { source: 'action_click_open_robot', requestedAt: new Date().toISOString() }
        }).catch(() => null);
        if (opened?.ok) await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
      }
      return;
    }

    await chrome.storage.local.set({
      ptPendingStatusBarPulse: true,
      [PENDING_LOGIN_WAIT_STORAGE_KEY]: pendingLoginWaitMarker('action_click_new_tab')
    }).catch(() => null);
    await chrome.storage.local.remove('ptPendingEmbeddedDashboardOpen').catch(() => null);
    await chrome.tabs.create({ url: POCKET_OPTION_SMART_URL, active: true });
  } catch (error) {
    console.error('Не удалось открыть строку запуска Pocket TRADE ROBOT:', error);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  if (isUnsupportedPocketMirrorUrl(url)) {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    // v1.0.82: every newly discovered po-*** mirror is intercepted from the tab
    // URL itself. No per-domain host permission is requested. A navigation URL
    // is handled immediately; completed documents are a fallback for restored tabs.
    if (changeInfo.url || isUnsupportedMirrorGuestUrl(url) || changeInfo.status === 'complete') {
      void handleUnsupportedMirror(tabId, url).catch(() => null);
    }
    return;
  }
  if (!isPocketTerminalUrl(url)) return;
  // Ignore title/favicon/audible/etc. updates. Only navigation or a completed
  // document may start bootstrap; this prevents duplicate work.
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  void (async () => {
    if (changeInfo.status === 'complete' || changeInfo.url) {
      await finishPocketTabBootstrap(tabId, url, changeInfo.url ? 'supported_domain_resolved' : 'pocket_tab_complete').catch(() => null);
    }
  })();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void (async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) return;
    if (isUnsupportedPocketMirrorUrl(tab.url)) {
      await handleUnsupportedMirror(tab.id, tab.url).catch(() => null);
      return;
    }
    if (!isPocketTerminalUrl(tab.url)) return;
    await finishPocketTabBootstrap(tab.id, tab.url, 'pocket_tab_activated').catch(() => null);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.notifications?.clear?.(vpnRequiredNotificationId(tabId)).catch(() => null);
  vpnRequiredPopupLastShownAt.delete(Number(tabId));
  void closeVpnRequiredPopupsForTab(tabId).catch(() => null);
  void chrome.notifications?.clear?.(mirrorPermissionNotificationId(tabId)).catch(() => null);
  void closeMirrorPermissionPopupsForTab(tabId).catch(() => null);

  const hadLiveSubscription = signalSubscriptions.has(tabId);
  const wasController = signalControllerTabId === tabId;
  signalSubscriptions.delete(tabId);
  if (wasController) signalControllerTabId = null;

  void (async () => {
    const stored = await chrome.storage.local.get([SIGNAL_SUBSCRIPTION_STORAGE_KEY, 'poBridgeSettings']).catch(() => ({}));
    const storedControllerId = Number(stored[SIGNAL_SUBSCRIPTION_STORAGE_KEY]?.controllerTabId || 0);
    const closedTradingController = hadLiveSubscription || wasController || storedControllerId === Number(tabId);

    if (closedTradingController) {
      // Closing the controlling Pocket tab ends the armed trading session.
      // Connection/candle settings stay saved, but trading can resume only after
      // the user explicitly enables it in the newly opened tab.
      await disarmAutoTradeSession('pocket_controller_tab_closed');
      sendSignalSubscription();
      return;
    }

    selectSignalController();
    const snapshot = signalSubscriptionSnapshot();
    if (snapshot.enabled) await persistSignalSubscriptionState(snapshot);
    else await persistSignalSubscriptionState(null);
    sendSignalSubscription();
  })().catch(() => null);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'PT_VPN_REQUIRED_CONTEXT': {
          const tabId = Number(message?.tabId);
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          const sourceUrl = String(message?.sourceUrl || '');
          const sourceCandidate = isUnsupportedPocketMirrorUrl(sourceUrl)
            ? sourceUrl
            : (tab?.url && isUnsupportedPocketMirrorUrl(tab.url) ? tab.url : '');
          if (!sourceCandidate) {
            sendResponse({ ok: false, error: 'mirror_context_unavailable' });
            return;
          }
          const source = new URL(sourceCandidate);
          sendResponse({
            ok: true,
            tabId: tab?.id || tabId,
            host: source.hostname,
            url: source.href,
            target: canonicalPocketTargetForMirror(source.href),
            guest: isUnsupportedMirrorGuestUrl(source.href)
          });
          return;
        }
        case 'PT_VPN_OPEN_MAIN_SITE': {
          const tabId = Number(message?.tabId) || Number(sender.tab?.id) || 0;
          const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
          let target = String(message?.target || '');
          try {
            const parsed = new URL(target);
            const host = parsed.hostname.toLowerCase();
            if (parsed.protocol !== 'https:' || !(host === 'pocketoption.com' || host.endsWith('.pocketoption.com'))) target = '';
          } catch {
            target = '';
          }
          if (!target) target = `${CANONICAL_POCKET_ORIGIN}/`;
          // Reply before navigating the sender tab; otherwise the page can unload
          // before the runtime response reaches vpn-required.js.
          sendResponse({ ok: true, target });
          void (async () => {
            if (tab?.id) {
              await chrome.tabs.update(tab.id, { url: target, active: true }).catch(() => null);
              if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
            } else {
              await chrome.tabs.create({ url: target, active: true }).catch(() => null);
            }
            await closeVpnRequiredPopupsForTab(tabId).catch(() => null);
            await chrome.notifications?.clear?.(vpnRequiredNotificationId(tabId)).catch(() => null);
          })();
          return;
        }
        case 'PT_VPN_CLOSE_NOTICE': {
          const tabId = Number(message?.tabId);
          const mode = String(message?.mode || '');
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          const noticePrefix = chrome.runtime.getURL(VPN_REQUIRED_POPUP_PAGE);
          sendResponse({ ok: true });
          if (mode === 'tab' && tab?.id && String(tab.url || '').startsWith(noticePrefix)) {
            void chrome.tabs.remove(tab.id).catch(() => null);
          } else {
            void closeVpnRequiredPopupsForTab(tabId).catch(() => null);
          }
          return;
        }
        case 'PO_OPEN_TERMINAL': {
          const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
          if (activeTab?.id && isUnsupportedPocketMirrorUrl(activeTab.url)) {
            await handleUnsupportedMirror(activeTab.id, activeTab.url, { force: true });
            sendResponse({ ok: true, unsupportedMirror: true, vpnRequired: true, tabId: activeTab.id });
            return;
          }
          const existing = await choosePocketTab();
          if (existing?.id) {
            await focusTab(existing);
            const bridge = await ensurePocketScripts(existing.id, existing.url).catch(() => null);
            const liveState = await readLivePocketTabState(existing.id).catch(() => null);
            const tradingAccountPage = isPocketRobotEligibleContext(existing.url, liveState);
            const waitingForLogin = !tradingAccountPage;
            if (waitingForLogin) {
              await chrome.storage.local.set({ [PENDING_LOGIN_WAIT_STORAGE_KEY]: pendingLoginWaitMarker('open_terminal_guest') }).catch(() => null);
            } else {
              await chrome.storage.local.remove(PENDING_LOGIN_WAIT_STORAGE_KEY).catch(() => null);
            }
            await chrome.tabs.sendMessage(existing.id, {
              type: 'PT_SHOW_STATUS_BAR',
              payload: { source: 'open_terminal', pulse: true, waitingForLogin, forceVisible: true }
            }).catch(() => null);
            sendResponse({ ok: true, tabId: existing.id, reused: true, bridge, waitingForLogin });
            return;
          }
          await chrome.storage.local.set({
            ptPendingStatusBarPulse: true,
            [PENDING_LOGIN_WAIT_STORAGE_KEY]: pendingLoginWaitMarker('open_terminal_new_tab')
          }).catch(() => null);
          const tab = await chrome.tabs.create({ url: POCKET_OPTION_SMART_URL, active: true });
          sendResponse({ ok: true, tabId: tab.id, reused: false, url: POCKET_OPTION_SMART_URL, waitingForLogin: true });
          return;
        }
        case 'PT_OPEN_PRODUCT_PAGE': {
          const tab = await chrome.tabs.create({ url: PRODUCT_PAGE_URL, active: true });
          sendResponse({ ok: true, tabId: tab.id, url: PRODUCT_PAGE_URL });
          return;
        }
        case 'PO_FIND_TAB': {
          const tab = await choosePocketTab();
          sendResponse({ ok: true, tab: tab ? { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, status: tab.status } : null });
          return;
        }
        case 'PO_GET_MIRROR_PERMISSION_CONTEXT': {
          const tabId = Number(message.tabId);
          if (!tabId) { sendResponse({ ok: false, error: 'tab_id_missing' }); return; }
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (!tab?.id || !isPocketTerminalUrl(tab.url)) {
            sendResponse({ ok: false, error: 'unsupported_domain', vpnRequired: Boolean(tab?.url && isUnsupportedPocketMirrorUrl(tab.url)) });
            return;
          }
          sendResponse({
            ok: true,
            tabId: tab.id,
            url: tab.url,
            origin: pocketOriginPattern(tab.url),
            host: new URL(tab.url).hostname,
            alreadyGranted: true,
            approvalRequired: false,
            explicitlyApproved: true,
            staticHostPermission: true
          });
          return;
        }
        case 'PO_COMPLETE_MIRROR_BOOTSTRAP': {
          const tabId = Number(message.tabId);
          if (!tabId) { sendResponse({ ok: false, error: 'tab_id_missing' }); return; }
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (!tab?.id || !isPocketTerminalUrl(tab.url)) {
            sendResponse({ ok: false, error: 'unsupported_domain', vpnRequired: Boolean(tab?.url && isUnsupportedPocketMirrorUrl(tab.url)) });
            return;
          }
          sendResponse(await finishPocketTabBootstrap(tab.id, tab.url, 'static_domain_bootstrap'));
          return;
        }
        case 'PO_REQUEST_MIRROR_PERMISSION': {
          // Backward-compatible message name only. No permission request is made.
          const tabId = Number(message.tabId) || (await choosePocketTab())?.id;
          if (!tabId) throw new Error('Вкладка Pocket Option не найдена');
          const tab = await chrome.tabs.get(tabId);
          if (!isPocketTerminalUrl(tab.url)) {
            if (isUnsupportedPocketMirrorUrl(tab.url)) await handleUnsupportedMirror(tab.id, tab.url, { force: true });
            sendResponse({ ok: false, vpnRequired: isUnsupportedPocketMirrorUrl(tab.url), error: 'Pocket TRADE ROBOT работает только на pocketoption.com' });
            return;
          }
          const bridge = await ensurePocketScripts(tabId, tab.url).catch((error) => ({ ok: false, error: String(error?.message || error) }));
          sendResponse({ ok: Boolean(bridge?.ok), granted: true, alreadyGranted: true, staticHostPermission: true, bridge });
          return;
        }
        case 'PO_ENSURE_TAB_BRIDGE': {
          const tabId = Number(message.tabId) || (await choosePocketTab())?.id;
          if (!tabId) throw new Error('Вкладка Pocket Option не найдена');
          const tab = await chrome.tabs.get(tabId);
          sendResponse(await ensurePocketScripts(tabId, tab.url));
          return;
        }
        case 'PO_RELOAD_TAB': {
          const tabId = Number(message.tabId) || (await choosePocketTab())?.id;
          if (!tabId) throw new Error('Вкладка Pocket Option не найдена');
          await chrome.tabs.reload(tabId, { bypassCache: false });
          sendResponse({ ok: true, tabId });
          return;
        }
        case 'PO_FOCUS_TAB': {
          const tab = await choosePocketTab();
          if (!tab?.id) throw new Error('Вкладка Pocket Option не найдена');
          await focusTab(tab);
          sendResponse({ ok: true, tabId: tab.id });
          return;
        }
        case 'PO_OPEN_DASHBOARD':
          sendResponse(await openDashboard(message.screen || {}));
          return;
        case 'PO_GET_LAST_STATE': {
          const stored = await chrome.storage.local.get(['poBridgeState', 'poProfitStats']);
          sendResponse({ ok: true, state: stored.poBridgeState || null, profitStats: stored.poProfitStats || null });
          return;
        }
        case 'PO_GET_PROFIT_STATS': {
          const stored = await chrome.storage.local.get(['poProfitStats', 'poBridgeState']);
          const freshStats = await updateProfitStats(stored.poBridgeState || null).catch(() => stored.poProfitStats || null);
          sendResponse({ ok: true, profitStats: freshStats || stored.poProfitStats || null });
          return;
        }
        case 'PO_RESET_PROFIT_STATS': {
          const stats = await resetProfitStats('manual');
          sendResponse({ ok: true, profitStats: stats });
          return;
        }
        case 'PO_GET_ACCESS_STATE':
          sendResponse({ ok: true, ...(await getAccessState()) });
          return;
        case 'PO_CHECK_TRADE_ACCESS':
          sendResponse(await checkTradeAccess(message.payload || {}));
          return;
        case 'PO_RECORD_TRADE_USAGE':
          sendResponse({ ok: true, ...(await recordTradeUsage(message.payload?.source || 'manual', message.payload || {})) });
          return;
        case 'PT_CONSUME_TRADE_TICKET':
          sendResponse(await consumeTradeExecutionTicket(message.payload?.ticket, {
            executionDeadlineMs: message.payload?.executionDeadlineMs
          }));
          return;
        case 'PO_SET_ACCESS_TIER':
          sendResponse({ ok: false, error: 'Тариф назначается только сервером Pocket TRADE ROBOT' });
          return;
        case 'PT_SIGNAL_SUBSCRIBE': {
          await signalDiagnosticsReady;
          const tabId = sender.tab?.id;
          if (!tabId) throw new Error('Сигнальная подписка доступна только из вкладки Pocket Option');
          signalSubscriptions.set(tabId, {
            enabled: message.payload?.enabled !== false,
            assets: Array.isArray(message.payload?.assets) ? [...new Set(message.payload.assets.filter(Boolean).map(String))] : [],
            strategyId: String(message.payload?.strategyId || ''),
            strategyIds: Array.isArray(message.payload?.strategyIds) ? [...new Set(message.payload.strategyIds.filter(Boolean).map(String))] : [],
            strategyMode: ['best', 'independent'].includes(message.payload?.strategyMode) ? message.payload.strategyMode : 'best',
            candleMode: [0, -1, -2].includes(Number(message.payload?.candleOffset)) ? (Number(message.payload.candleOffset) === 0 ? 'current' : 'closed') : (['closed', 'current'].includes(message.payload?.candleMode) ? message.payload.candleMode : 'closed'),
            candleOffset: [0, -1, -2].includes(Number(message.payload?.candleOffset)) ? Number(message.payload.candleOffset) : (message.payload?.candleMode === 'current' ? 0 : -1),
            period: Math.max(1, Math.min(86400, Math.round(Number(message.payload?.period) || 60))),
            duration: Math.max(1, Math.min(86400, Math.round(Number(message.payload?.duration) || 60))),
            strategyPeriods: message.payload?.strategyPeriods && typeof message.payload.strategyPeriods === 'object' ? { ...message.payload.strategyPeriods } : {},
            strategyDurations: message.payload?.strategyDurations && typeof message.payload.strategyDurations === 'object' ? { ...message.payload.strategyDurations } : {},
            strategyCandleOffsets: message.payload?.strategyCandleOffsets && typeof message.payload.strategyCandleOffsets === 'object' ? { ...message.payload.strategyCandleOffsets } : {},
            strategyCooldowns: message.payload?.strategyCooldowns && typeof message.payload.strategyCooldowns === 'object' ? { ...message.payload.strategyCooldowns } : {},
            localConfigRevision: Math.max(0, Math.round(Number(message.payload?.localConfigRevision) || 0)),
            updatedAt: Date.now()
          });
          if (message.payload?.enabled !== false) signalControllerTabId = tabId;
          const subscription = signalSubscriptionSnapshot();
          persistSignalDiagnostics({
            subscribedAssets: subscription.assets.length,
            strategyIds: subscription.strategyIds,
            strategyMode: subscription.strategyMode,
            candleMode: subscription.candleMode,
            candleOffset: subscription.candleOffset,
            period: subscription.period,
            duration: subscription.duration,
            strategyPeriods: subscription.strategyPeriods,
            strategyDurations: subscription.strategyDurations,
            localConfigRevision: subscription.localConfigRevision
          });
          await persistSignalSubscriptionState({ ...subscription, controllerTabId: tabId, enabled: true, updatedAt: Date.now() });
          // Acknowledge immediately. Acquiring a one-time WS ticket can take longer
          // than a content-script message timeout on a slow network. Connection outcome is
          // delivered asynchronously through PT_SIGNAL_SOCKET_STATUS.
          await closeSignalSocketIfBindingStale('subscribe_binding_check').catch(() => null);
          if (signalSocket?.readyState === WebSocket.OPEN) {
            sendSignalSubscription();
            const status = signalSocketAnalysisReady ? 'online' : (signalSocketSubscriptionAckAt ? 'analyzing' : 'subscribing');
            sendResponse({ ok: true, status, analysisReady: signalSocketAnalysisReady });
          } else if (signalSocket?.readyState === WebSocket.CONNECTING) {
            sendResponse({ ok: true, status: 'connecting' });
          } else {
            sendResponse({ ok: true, status: 'connecting' });
            void ensureServerSignalSocket().catch((error) => {
              const reason = String(error?.message || error || 'signal_socket_connect_failed');
              persistSignalDiagnostics({ status: 'error', lastError: reason });
              void notifySignalSubscribers({ type: 'PT_SIGNAL_SOCKET_STATUS', status: 'error', reason }, { controllerOnly: true });
            });
          }
          return;
        }
        case 'PT_SIGNAL_UNSUBSCRIBE': {
          const tabId = sender.tab?.id;
          if (tabId) signalSubscriptions.delete(tabId);
          if (tabId && signalControllerTabId === tabId) signalControllerTabId = null;
          const remainingSubscription = signalSubscriptionSnapshot();
          if (!remainingSubscription.enabled) {
            await persistSignalSubscriptionState(null);
            closeServerSignalSocket('autotrade_off');
          } else {
            await persistSignalSubscriptionState(remainingSubscription);
            sendSignalSubscription();
          }
          sendResponse({ ok: true });
          return;
        }
        case 'PT_CACHE_BRIDGE_HEALTH': {
          try {
            const result = await ptCacheBridgeRequest('/health', { method: 'GET' }, 7000);
            sendResponse({ ...result, runtime: { ...ptCacheBridgeRuntime } });
          } catch (error) {
            sendResponse({ ok: false, error: String(error?.message || error), runtime: { ...ptCacheBridgeRuntime } });
          }
          return;
        }
        case 'PT_CACHE_BRIDGE_STATUS': {
          try {
            const result = await ptCacheBridgeRequest('/status', { method: 'GET' }, 9000);
            sendResponse({ ...result, runtime: { ...ptCacheBridgeRuntime } });
          } catch (error) {
            sendResponse({ ok: false, error: String(error?.message || error), runtime: { ...ptCacheBridgeRuntime } });
          }
          return;
        }
        case 'PT_CACHE_BRIDGE_CANDLES': {
          try {
            sendResponse(await ptCacheBridgeCandles(message.payload || {}));
          } catch (error) {
            sendResponse({ ok: false, error: String(error?.message || error), results: [], runtime: { ...ptCacheBridgeRuntime } });
          }
          return;
        }
        case 'PT_MARKET_CACHE_GET': {
          const records = await getMarketCache(message.payload?.assets, message.payload?.period);
          sendResponse({ ok: true, records });
          return;
        }
        case 'PT_MARKET_CACHE_PUT': {
          sendResponse({ ok: true, ...(await putMarketCache(message.payload || {})) });
          return;
        }
        case 'PT_MARKET_CACHE_CLEAR': {
          sendResponse({ ok: true, ...(await clearMarketCache()) });
          return;
        }
        case 'PT_MARKET_SNAPSHOT': {
          const senderTabId = sender.tab?.id;
          const controllerTabId = selectSignalController();
          if (!senderTabId || !controllerTabId || senderTabId !== controllerTabId) {
            sendResponse({ ok: false, error: 'not_signal_controller' });
            return;
          }
          if (!signalSocket || signalSocket.readyState !== WebSocket.OPEN) {
            // This is a transient transport state, not a failed snapshot. Do not pollute
            // diagnostics with one error for every asset while the socket is connecting.
            const connecting = signalSocket?.readyState === WebSocket.CONNECTING;
            sendResponse({ ok: false, transient: true, error: connecting ? 'signal_socket_connecting' : 'signal_socket_offline' });
            return;
          }
          const source = message.payload && typeof message.payload === 'object' ? message.payload : {};
          const snapshotId = String(source.snapshotId || crypto.randomUUID());
          const subscription = signalSubscriptionSnapshot();
          const snapshot = {
            ...source,
            snapshotId,
            subscriptionRevision: signalSubscriptionRevision,
            configuredPeriod: source.configuredPeriod ?? subscription.period,
            configuredDuration: source.configuredDuration ?? subscription.duration,
            strategyPeriods: source.strategyPeriods ?? subscription.strategyPeriods,
            strategyDurations: source.strategyDurations ?? subscription.strategyDurations,
            strategyCandleOffsets: source.strategyCandleOffsets ?? subscription.strategyCandleOffsets,
            strategyCooldowns: source.strategyCooldowns ?? subscription.strategyCooldowns,
            localConfigRevision: source.localConfigRevision ?? subscription.localConfigRevision
          };
          try {
            const ackPromise = new Promise((resolve) => {
              const timer = setTimeout(() => {
                pendingSnapshotAcks.delete(snapshotId);
                persistSignalDiagnostics({
                  snapshotTimeouts: Math.max(0, Number(signalDiagnostics.snapshotTimeouts) || 0) + 1,
                  pendingSnapshotAcks: pendingSnapshotAcks.size,
                  lastMarketAckCode: 'market_snapshot_ack_timeout',
                  webSocketBufferedAmount: Number(signalSocket?.bufferedAmount || 0)
                });
                // A delayed ACK can be caused by a slow PC, network or server queue.
                // Mark it retryable; the content script pauses the whole batch before retrying.
                resolve({ ok: false, transient: true, retryable: true, timeout: true, retryAfterMs: 5000, error: 'market_snapshot_ack_timeout', snapshotId });
              }, 60000);
              pendingSnapshotAcks.set(snapshotId, { resolve, timer, asset: snapshot.asset, snapshotKey: snapshot.snapshotKey, sentAt: Date.now(), bytes: 0 });
            });
            rememberSignalSnapshotContext(snapshotId);
            const wirePayload = JSON.stringify({ type: 'market_snapshot', snapshot });
            const wireBytes = new TextEncoder().encode(wirePayload).byteLength;
            const pendingAck = pendingSnapshotAcks.get(snapshotId);
            if (pendingAck) pendingAck.bytes = wireBytes;
            signalSocket.send(wirePayload);
            persistSignalDiagnostics({
              snapshotsSent: signalDiagnostics.snapshotsSent + 1,
              lastSnapshotAt: new Date().toISOString(),
              lastSnapshotAsset: String(snapshot.asset || ''),
              lastSnapshotId: snapshotId,
              lastSnapshotBytes: wireBytes,
              pendingSnapshotAcks: pendingSnapshotAcks.size,
              webSocketBufferedAmount: Number(signalSocket?.bufferedAmount || 0),
              subscriptionRevision: signalSubscriptionRevision,
              socketGeneration: signalSocketGeneration
            });
            sendResponse(await ackPromise);
          } catch (error) {
            consumeSignalSnapshotContext(snapshotId);
            resolveSnapshotAck(snapshotId, { ok: false, error: String(error?.message || error), snapshotId });
            persistSignalDiagnostics({
              snapshotErrors: signalDiagnostics.snapshotErrors + 1,
              lastError: String(error?.message || error)
            });
            sendResponse({ ok: false, error: String(error?.message || error), snapshotId });
          }
          return;
        }
        case 'PT_GET_SIGNAL_DIAGNOSTICS':
          await signalDiagnosticsReady;
          sendResponse({ ok: true, diagnostics: { ...signalDiagnostics } });
          return;
        case 'PT_SIGNAL_SOCKET_STATE': {
          const now = Date.now();
          await closeSignalSocketIfBindingStale('content_status_probe_binding').catch(() => null);
          if (!signalSocket || ![WebSocket.OPEN, WebSocket.CONNECTING].includes(signalSocket.readyState)) {
            if (!signalLastRecoveryAttemptAt || now - signalLastRecoveryAttemptAt > SIGNAL_RECOVERY_COOLDOWN_MS) {
              await recoverPersistentSignalChannel('content_status_probe').catch(() => null);
            }
          }
          const status = signalSocket?.readyState === WebSocket.OPEN
            ? (signalSocketAnalysisReady ? 'online' : (signalSocketSubscriptionAckAt ? 'analyzing' : 'subscribing'))
            : signalSocket
              ? 'connecting'
              : (signalSubscriptionSnapshot().enabled ? 'reconnecting' : 'offline');
          sendResponse({
            ok: true,
            status,
            analysisReady: signalSocketAnalysisReady,
            boundUid: signalSocketBoundUid,
            boundMode: signalSocketBoundMode,
            lastMessageAt: signalDiagnostics.lastMessageAt || null,
            diagnosticsStatus: signalDiagnostics.status || 'idle'
          });
          return;
        }
        case 'PT_SIGNAL_FORCE_RECOVER': {
          const reason = String(message.reason || message.payload?.reason || 'manual_force');
          if (message.hard === true && signalSocket) {
            closeServerSignalSocket(reason, false);
            signalLastRecoveryAttemptAt = 0;
          }
          const result = await recoverPersistentSignalChannel(reason, { force: true }).catch((error) => ({ ok: false, status: 'error', error: String(error?.message || error) }));
          sendResponse(result);
          return;
        }
        case 'PT_GET_LEGAL_CONSENT':
          sendResponse({ ok: true, ...(await getLegalConsent()) });
          return;
        case 'PT_ACCEPT_LEGAL_CONSENT': {
          const consent = await acceptLegalConsent(message.payload || {});
          sendResponse({ ok: true, consent });
          // The response must stay immediate (the consent UI has a short timeout),
          // while first-install account bootstrap starts as soon as consent exists.
          scheduleServerSync(true);
          return;
        }
        case 'PT_DELETE_ACCOUNT_DATA': {
          const result = await deleteAccountData();
          await clearMarketCache().catch(() => null);
          signalSubscriptions.clear();
          signalControllerTabId = null;
          signalSocketReconnectAttempt = 0;
          signalSocketConnectPromise = null;
          closeServerSignalSocket('account_data_deleted', false);
          await chrome.storage.local.remove(SIGNAL_SUBSCRIPTION_STORAGE_KEY).catch(() => null);
          persistedSignalSubscription = null;
          signalSubscriptionStateLoaded = true;
          Object.assign(signalDiagnostics, {
            version: 3, status: 'idle', subscribedAssets: 0, strategyIds: [], strategyMode: 'best',
            connectedAt: null, disconnectedAt: new Date().toISOString(), lastMessageAt: null,
            lastSignalAt: null, lastEngineAt: null, lastSnapshotAt: null, lastError: null,
            reconnectAttempts: 0, messages: 0, signals: 0, snapshotsSent: 0,
            snapshotErrors: 0, engineEvaluations: 0, strategyEvaluations: 0,
            engineSignals: 0, lastEngineStatus: null
          });
          sendResponse({ ok: true, result });
          return;
        }
        case 'PT_POCKET_PARTNERS_STATUS':
          sendResponse(await getPocketPartnersStatus());
          return;
        case 'PT_POCKET_PARTNERS_SAVE':
          sendResponse(await savePocketPartnersSettings(message.payload || {}));
          return;
        case 'PT_POCKET_PARTNERS_CONNECT':
          sendResponse(await connectPocketPartners());
          return;
        case 'PT_POCKET_PARTNERS_DISCONNECT':
          sendResponse(await disconnectPocketPartners('manual'));
          return;
        case 'PT_POCKET_PARTNERS_CAPTURE_AUTH':
          sendResponse(await capturePocketPartnersAuth(message.payload || {}));
          return;
        case 'PT_OFFICIAL_TRADE':
          sendResponse(await openPocketPartnersTrade(message.payload || {}));
          return;
        case 'PT_REMOTE_GET_STATE':
          sendResponse({ ok: true, remote: await getRemoteControlLocalState() });
          return;
        case 'PT_REMOTE_ENABLE':
          sendResponse(await enableRemoteControl({ rotate: Boolean(message.rotate) }));
          void remotePollOnce().catch(() => null);
          return;
        case 'PT_REMOTE_DISABLE':
          sendResponse(await disableRemoteControl());
          return;
        case 'PT_REMOTE_ROTATE_PASSWORD':
          sendResponse(await rotateRemoteControlPassword());
          void remotePollOnce().catch(() => null);
          return;
        case 'PT_REMOTE_OPEN':
          sendResponse(await openRemoteControl());
          return;
        case 'PT_REMOTE_PUSH_STATUS': {
          const remoteResult = await remotePollOnce({ includeCommands: true, reason: 'manual' });
          sendResponse(remoteResult || { ok: true });
          return;
        }
        case 'PT_STRATEGY_TESTER_CONFIG':
          sendResponse({ ok: true, ...(await getStrategyTesterConfig()) });
          return;
        case 'PT_STRATEGY_TESTER_RUN':
          sendResponse({ ok: true, ...(await runStrategyTester(message.payload || {})) });
          return;
        case 'PT_TESTER_COLLECT_HISTORY': {
          const testerAccess = await getAccessState();
          if (!(testerAccess?.premium || testerAccess?.entitlement?.features?.strategyTester)) {
            throw new Error('Strategy Tester PRO доступен только в TRIAL, Premium или по отдельной подписке.');
          }
          const tab = await choosePocketTab();
          if (!tab?.id) throw new Error('Откройте и подключите вкладку Pocket Option для загрузки истории свечей');
          await ensurePocketScripts(tab.id, tab.url);

          let capabilities = await pocketContentCapabilities(tab.id);
          if (!capabilities?.strategyTesterHistory) {
            await injectPocketScriptsNow(tab.id).catch(() => null);
            capabilities = await pocketContentCapabilities(tab.id);
          }

          let result = await chrome.tabs.sendMessage(tab.id, { type: 'PT_TESTER_COLLECT_HISTORY', payload: message.payload || {} }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
          if (!result?.ok && /UNKNOWN_MESSAGE/i.test(String(result?.error || ''))) {
            await injectPocketScriptsNow(tab.id).catch(() => null);
            result = await chrome.tabs.sendMessage(tab.id, { type: 'PT_TESTER_COLLECT_HISTORY', payload: message.payload || {}, retryAfterInject: true }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
          }
          if (!result?.ok && /UNKNOWN_MESSAGE/i.test(String(result?.error || ''))) {
            result = { ok: false, error: 'Команда Strategy Tester не принята мостом терминала. Откройте окно расширения заново и нажмите «Подключить аккаунт» — вкладку Pocket Option перезагружать не нужно.' };
          }
          sendResponse(result || { ok: false, error: 'История не получена' });
          return;
        }

        case 'PT_SERVER_SYNC':
          sendResponse({ ok: true, serverState: await syncServer({ forceBootstrap: Boolean(message.forceBootstrap) }) });
          return;
        case 'PT_GET_SERVER_STATE':
          sendResponse({ ok: true, serverState: await getServerState({ sync: Boolean(message.sync) }) });
          return;
        case 'PT_GET_RUNTIME_INFO':
          sendResponse({ ok: true, runtime: await getRuntimeInfo() });
          return;
        case 'PT_GET_REFERRAL_PROGRAM':
          sendResponse({ ok: true, ...(await getReferralProgram()) });
          return;
        case 'PT_ACTIVATE_TRIAL':
          sendResponse({ ok: true, serverState: await activateTrial() });
          return;
        case 'PT_SAVE_CUSTOM_STRATEGY':
          sendResponse({ ok: true, ...(await saveCustomStrategy(message.payload || {})) });
          return;
        case 'PT_REPAIR_CUSTOM_STRATEGIES':
          sendResponse(await repairCustomStrategiesFromLocal(message.strategyIds || message.payload?.strategyIds || []));
          return;
        case 'PT_DELETE_CUSTOM_STRATEGY':
          sendResponse({ ok: true, ...(await deleteCustomStrategy(String(message.strategyId || ''))) });
          return;
        case 'PT_REPORT_TRADE': {
          const payload = message.payload || {};
          await rememberRobotTradeReport(payload).catch(() => null);
          sendResponse(await reportTrade(payload));
          return;
        }
        case 'PT_CHECK_UPDATE':
          sendResponse({ ok: true, release: await checkRelease() });
          return;
        case 'PT_OPEN_SUPPORT':
          sendResponse(await openSupport());
          return;
        case 'PT_OPEN_AFFILIATE':
          sendResponse(await openAffiliate());
          return;
        case 'PT_GENERATE_AFFILIATE_PUBLIC':
          sendResponse(await generateAffiliatePublic(message.locale || 'ru'));
          return;
        case 'PT_GET_AFFILIATE_PREPARED':
          sendResponse({ ok: true, prepared: await getPreparedAffiliatePublic() });
          return;
        case 'PT_OPEN_AFFILIATE_PREPARED':
          sendResponse(await openPreparedAffiliatePublic());
          return;
        case 'PT_OPEN_AFFILIATE_PUBLIC':
          sendResponse(await openAffiliatePublic(message.locale || 'ru'));
          return;
        case 'PT_OPEN_ADMIN':
          sendResponse(await openAdmin());
          return;
        case 'PT_OPEN_UPDATE':
          sendResponse(await openUpdate());
          return;
        case 'PO_GET_TRADE_LEDGER': {
          const stored = await chrome.storage.local.get(['poTradeLedger', 'poBridgeState']);
          const freshLedger = await updateTradeLedger(stored.poBridgeState || null).catch(() => stored.poTradeLedger || null);
          sendResponse({ ok: true, ledger: freshLedger || stored.poTradeLedger || null });
          return;
        }
        case 'PO_RESET_TRADE_LEDGER': {
          const now = new Date();
          const today = localDayKey(now);
          const resetTimestamp = Math.floor(now.getTime() / 1000);
          const stats = await resetProfitStats('ledger-reset');
          await serializeTradeLedgerMutation(async () => {
          const stored = await chrome.storage.local.get(['poBridgeState', 'poTradeLedger', ROBOT_TRADE_REGISTRY_KEY]);
          const bridgeState = stored.poBridgeState || null;
          const previousLedger = stored.poTradeLedger || {};
          const previousRegistry = normalizeRobotTradeRegistry(stored[ROBOT_TRADE_REGISTRY_KEY]);
          const brokerOffsetSec = finiteNumber(bridgeState?.market?.brokerClockOffsetSec) ?? 0;
          const resetKeys = new Set();
          const rememberResetDeal = (deal, trusted = false) => {
            if (!deal || (!trusted && !isRobotTradeDeal(deal))) return;
            const key = tradeResetIdentityKey(deal);
            if (key) resetKeys.add(key);
          };
          (Array.isArray(previousLedger.closedDeals) ? previousLedger.closedDeals : []).forEach((deal) => rememberResetDeal(deal));
          (Array.isArray(previousLedger.openDeals) ? previousLedger.openDeals : []).forEach((deal) => rememberResetDeal(deal));
          (Array.isArray(bridgeState?.trades?.closedDeals) ? bridgeState.trades.closedDeals : []).forEach((deal) => rememberResetDeal(deal));
          (Array.isArray(bridgeState?.trades?.openedDeals) ? bridgeState.trades.openedDeals : []).forEach((deal) => rememberResetDeal(deal));
          previousRegistry.trades.forEach((deal) => rememberResetDeal(deal, true));

          const clearedState = bridgeState ? {
            ...bridgeState,
            trades: {
              ...(bridgeState.trades || {}),
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
          } : null;
          const resetIdentity = tradeLedgerAccountIdentity(bridgeState);
          const ledger = {
            version: 5,
            robotOnly: true,
            accountKey: resetIdentity?.key || null,
            uid: resetIdentity?.uid || null,
            mode: resetIdentity?.mode || null,
            accountScopeReason: 'manual-reset',
            closedDeals: [],
            openDeals: [],
            summary: summarizeDeals([]),
            today: summarizeDeals([], today, brokerOffsetSec),
            todayKey: today,
            resetAt: now.toISOString(),
            resetTimestamp,
            resetBrokerTimestamp: resetTimestamp + brokerOffsetSec,
            resetDealKeys: [...resetKeys].slice(-10000),
            updatedAt: now.toISOString()
          };
          const clearedRegistry = { version: 3, accountKey: resetIdentity?.key || null, uid: resetIdentity?.uid || null, mode: resetIdentity?.mode || null, trades: [], updatedAt: now.toISOString() };
          const payload = { poTradeLedger: ledger, [ROBOT_TRADE_REGISTRY_KEY]: clearedRegistry };
          if (clearedState) payload.poBridgeState = clearedState;
          await chrome.storage.local.set(payload);
          sendResponse({ ok: true, ledger, profitStats: stats });
          });
          return;
        }
        default:
          sendResponse({ ok: false, error: 'UNKNOWN_MESSAGE' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true;
});

async function recoverOpenPocketTabsAtWorkerBoot() {
  // Manual extension reload does not reliably replay onInstalled/onStartup for
  // an already-open browser tab. Inspect current tabs whenever the MV3 worker
  // starts so po-sig.com and future po-<id>.com mirrors cannot remain silent.
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (!tab?.id) continue;
    const url = String(tab.url || tab.pendingUrl || '');
    if (isUnsupportedPocketMirrorUrl(url)) {
      await handleUnsupportedMirror(tab.id, url, { force: true }).catch(() => null);
      continue;
    }
    if (isPocketTerminalUrl(url)) {
      await finishPocketTabBootstrap(tab.id, url, 'worker_boot_recovery').catch(() => null);
    }
  }
}

void ensureActionIcon();
// MV3 may create a fresh worker without firing onInstalled/onStartup. Run the
// idempotent alarm/state migration on every worker generation so a legacy v1
// session can never survive just because the browser restored an old tab.
void (async () => {
  // Affiliate cleanup also writes ptServerState on a legacy profile. Serialize
  // it before the v2 migration so it cannot race and restore autorobot URLs.
  await migrateLegacyAffiliateStorage();
  await initializeServerClient();
  const stored = await chrome.storage.local.get(['ptServerState', 'poBridgeState']).catch(() => ({}));
  const bridgeState = stored.poBridgeState || null;
  if (!isConnected(bridgeState)) return;
  const uid = bridgeState?.account?.uid != null ? String(bridgeState.account.uid).trim() : '';
  const serverState = stored.ptServerState || null;
  const sessionReady = Boolean(
    uid
    && serverState?.online === true
    && serverState?.authenticated === true
    && serverState?.sessionToken
    && String(serverState?.pocketUid || '').trim() === uid
    && String(serverState?.sessionUid || '').trim() === uid
  );
  if (!sessionReady) scheduleServerSync(true);
})().catch(() => null);
void chrome.storage.local.remove('ptFirstRunOnboarding').catch(() => null);
void recoverOpenPocketTabsAtWorkerBoot();
