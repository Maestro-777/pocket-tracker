const SUPPORT_URL = 'https://github.com/Maestro-777/pocket-tracker/issues';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const BUILD = 'expansion-local-1.0.1-schema2';
const LEGAL_KEY = 'expLocalLegalConsent';
const TICKETS_KEY = 'expLocalTradeTickets';
const STRATEGIES_KEY = 'expLocalStrategies';
const TRADES_KEY = 'expLocalTradeReports';

const entitlement = () => ({
  plan: 'LOCAL',
  premium: true,
  source: 'local',
  status: 'active',
  accessState: 'LOCAL_ACTIVE',
  registrationRequired: false,
  realTradingAllowed: true,
  pauseReason: null,
  expiresAt: null,
  limits: { maxAssets: null, maxDailyTrades: null, maxDevices: null },
  features: {
    ai: true, strategyBuilder: true, autoTrading: true, realTrading: true,
    basicStrategies: true, premiumStrategies: true, strategyTester: true,
    remoteControl: false
  },
  devices: { used: 1, allowed: null },
  affiliate: { registered: false, eligible: false, registrationUrl: '' },
  trial: { available: false, automatic: false, used: true, active: false, expired: false },
  supportUrl: SUPPORT_URL
});

const uidFromBridge = bridge => bridge?.account?.uid == null ? null : String(bridge.account.uid);
const nowIso = () => new Date().toISOString();
const read = async key => (await chrome.storage.local.get(key))[key];

function makeState(patch = {}) {
  return {
    version: 2, clientBuild: BUILD, online: true, serverReachable: true,
    accountConnected: false, authenticated: false, lastHealthAt: nowIso(),
    lastSyncAt: nowIso(), lastError: null, sessionToken: null,
    sessionUid: null, pocketUid: null, accountMode: null, accountKey: null,
    apiBase: 'local://extension', wsUrl: null, adminUrl: null, supportUrl: SUPPORT_URL,
    entitlement: entitlement(), strategies: [], deletedCustomStrategyIds: [],
    release: null, broadcasts: [], localOnly: true, ...patch
  };
}

export async function getLegalConsent() {
  const consent = await read(LEGAL_KEY);
  return { accepted: consent?.accepted === true, version: 'local-v1', consent: consent || null, dontShowAgain: true, urls: { privacy: '', terms: '', risk: '', affiliate: '' } };
}

export async function acceptLegalConsent(payload = {}) {
  if (!payload.riskAccepted || !payload.termsAccepted || !payload.privacyAccepted) throw new Error('Подтвердите риски и условия использования.');
  const consent = { accepted: true, version: 'local-v1', acceptedAt: nowIso(), riskAccepted: true, termsAccepted: true, privacyAccepted: true };
  await chrome.storage.local.set({ [LEGAL_KEY]: consent });
  return consent;
}

export async function getRuntimeInfo() {
  return { buildId: BUILD, extensionVersion: EXTENSION_VERSION, serverStateSchema: 2, serverStateVersion: 2, legalConsentVersion: 'local-v1', legalAccepted: (await getLegalConsent()).accepted, apiBase: 'local://extension', wsUrl: null, localOnly: true };
}

export async function bindServerAccountContext(bridgeState) {
  const uid = uidFromBridge(bridgeState);
  const strategies = (await read(STRATEGIES_KEY)) || [];
  const state = makeState({
    accountConnected: Boolean(uid), pocketUid: uid, sessionUid: uid,
    accountMode: bridgeState?.account?.mode || null, accountKey: uid,
    authenticated: true, sessionToken: 'local-owner',
    entitlement: entitlement(), strategies
  });
  await chrome.storage.local.set({ ptServerState: state });
  return state;
}

export async function syncServer() {
  const bridge = await read('poBridgeState');
  return bindServerAccountContext(bridge || null);
}

export async function getServerState({ sync = false } = {}) {
  if (sync) return syncServer();
  const saved = await read('ptServerState');
  const bridge = await read('poBridgeState');
  const uid = uidFromBridge(bridge) || saved?.pocketUid || null;
  return makeState({
    ...(saved || {}), version: 2, clientBuild: BUILD, localOnly: true,
    accountConnected: Boolean(uid), pocketUid: uid, sessionUid: uid,
    authenticated: true, sessionToken: 'local-owner',
    entitlement: entitlement()
  });
}

export async function getServerAccess() {
  const serverState = await getServerState();
  const access = entitlement();
  serverState.entitlement = access;
  return { serverState, entitlement: access, localUser: { id: 'local-owner', login: 'owner', role: 'owner' } };
}

export async function getReferralProgram() {
  return { enabled: false, localOnly: true, referrals: [], rewards: [], message: 'Реферальная программа отключена в автономной версии.' };
}

export async function requestTradePermit(payload = {}) {
  const consent = await getLegalConsent();
  if (!consent.accepted) return { ok: false, allowed: false, reason: 'LEGAL_CONSENT_REQUIRED', error: 'Сначала подтвердите локальные условия и риски.' };
  const ticket = crypto.randomUUID() + crypto.randomUUID();
  const tickets = (await read(TICKETS_KEY)) || {};
  tickets[ticket] = { createdAt: Date.now(), expiresAt: Date.now() + 60000, payload };
  await chrome.storage.local.set({ [TICKETS_KEY]: tickets });
  return { ok: true, allowed: true, reason: 'LOCAL_ALLOWED', executionTicket: ticket, expiresInSeconds: 60, entitlement: entitlement() };
}

export async function consumeTradeExecutionTicket(ticket) {
  const tickets = (await read(TICKETS_KEY)) || {};
  const record = tickets[String(ticket || '')];
  if (!record || record.expiresAt < Date.now()) return { ok: false, error: 'Локальный билет сделки недействителен или истёк.' };
  delete tickets[String(ticket)];
  await chrome.storage.local.set({ [TICKETS_KEY]: tickets });
  const p = record.payload || {};
  const rawAction = String(p.action || '').toLowerCase();
  const action = ['put', 'sell'].includes(rawAction) ? 'put' : ['call', 'buy'].includes(rawAction) ? 'call' : rawAction;
  return { ok: true, permit: {
    ok: true, asset: String(p.asset || ''), action,
    amount: Number(p.amount), duration: Number(p.duration),
    requestId: String(p.requestId || ''), strategyId: p.strategyId || null,
    source: p.source || null, consumedAt: nowIso(), localOnly: true
  } };
}

export async function reportTrade(payload = {}) {
  const trades = (await read(TRADES_KEY)) || [];
  trades.push({ ...payload, reportedAt: nowIso(), localOnly: true });
  await chrome.storage.local.set({ [TRADES_KEY]: trades.slice(-5000) });
  return { ok: true, localOnly: true };
}

export async function getSignalSocketTicket() {
  throw new Error('Серверный канал сигналов отключён: автономная версия использует локальные стратегии и данные терминала.');
}

export async function deleteAccountData() {
  const keys = [ 'ptServerState', 'ptRemoteControl', 'ptAffiliatePrepared', TICKETS_KEY, STRATEGIES_KEY, TRADES_KEY ];
  await chrome.storage.local.remove(keys);
  return { ok: true, localOnly: true };
}

export async function saveCustomStrategy(payload = {}) {
  const list = (await read(STRATEGIES_KEY)) || [];
  const id = String(payload.id || crypto.randomUUID());
  const item = { ...payload, id, updatedAt: nowIso(), localOnly: true };
  const index = list.findIndex(entry => String(entry.id) === id);
  if (index >= 0) list[index] = item; else list.push(item);
  await chrome.storage.local.set({ [STRATEGIES_KEY]: list });
  const serverState = await getServerState();
  serverState.strategies = list;
  await chrome.storage.local.set({ ptServerState: serverState });
  return { ok: true, strategy: item, strategies: list, serverState };
}

export async function deleteCustomStrategy(strategyId) {
  const id = String(strategyId || '');
  const list = ((await read(STRATEGIES_KEY)) || []).filter(item => String(item.id) !== id);
  await chrome.storage.local.set({ [STRATEGIES_KEY]: list });
  const serverState = await getServerState();
  serverState.strategies = list;
  await chrome.storage.local.set({ ptServerState: serverState });
  return { ok: true, deleted: true, strategyId: id, strategies: list, serverState };
}

export async function activateTrial() { return { ok: true, localOnly: true, entitlement: entitlement(), message: 'Локальный режим активен; пробный период не требуется.' }; }
export async function checkRelease() { return null; }
export async function openSupport() { await chrome.tabs.create({ url: SUPPORT_URL }); return { ok: true }; }
export async function openAffiliate() { throw new Error('Партнёрские функции отсутствуют в автономной версии.'); }
export async function getPreparedAffiliatePublic() { return null; }
export async function generateAffiliatePublic() { throw new Error('Партнёрские функции отсутствуют в автономной версии.'); }
export async function openPreparedAffiliatePublic() { throw new Error('Партнёрские функции отсутствуют в автономной версии.'); }
export async function openAffiliatePublic() { throw new Error('Партнёрские функции отсутствуют в автономной версии.'); }
export async function openAdmin() { throw new Error('Админ-панель пока не реализована в автономной версии.'); }
export async function openUpdate() { return { ok: true, localOnly: true }; }
export function humanReason(reason) { return String(reason || 'Операция недоступна в локальном режиме.'); }
export function compareVersions(a, b) { const x=String(a||'0').split('.').map(Number), y=String(b||'0').split('.').map(Number); for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return d>0?1:-1;} return 0; }
export async function initializeServerClient() {
  await chrome.storage.local.remove(['expLocalUsersV1', 'expLocalSessionV1']);
  const state = await syncServer();
  await chrome.storage.local.set({ ptServerState: { ...state, strategies: (await read(STRATEGIES_KEY)) || [] } });
  return state;
}
export async function ingestServerNotifications() { return { ok: true, notifications: [], localOnly: true }; }
export async function getStrategyTesterConfig() {
  const state = await getServerState();
  return {
    strategies: Array.isArray(state?.strategies) ? state.strategies : [],
    entitlement: entitlement(),
    localOnly: true,
    engine: 'dashboard-local-candle-engine'
  };
}
export async function runStrategyTester() {
  throw new Error('Запускайте локальный Strategy Tester из панели расширения: расчёт выполняется в интерфейсе на загруженных свечах.');
}
export async function getRemoteControlLocalState() { return { enabled: false, localOnly: true, available: false, message: 'Remote Control требует отдельного сервиса и отключён.' }; }
export async function enableRemoteControl() { throw new Error('Remote Control отключён: внешний сервер недоступен в автономной версии.'); }
export async function disableRemoteControl() { await chrome.storage.local.remove('ptRemoteControl'); return { ok: true, localOnly: true }; }
export async function rotateRemoteControlPassword() { throw new Error('Remote Control отключён.'); }
export async function pushRemoteControlStatus() { return { ok: true, skipped: true, localOnly: true }; }
export async function getRemoteControlPendingCommands() { return { ok: true, commands: [], localOnly: true }; }
export async function ackRemoteControlCommand() { return { ok: true, skipped: true, localOnly: true }; }
export async function openRemoteControl() { throw new Error('Remote Control отключён.'); }
