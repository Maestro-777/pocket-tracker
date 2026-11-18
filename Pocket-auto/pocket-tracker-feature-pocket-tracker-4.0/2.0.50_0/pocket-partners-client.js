const SETTINGS_KEY = 'ptPocketPartnersSettings';
const STATE_KEY = 'ptPocketPartnersState';
const AUTO_AUTH_KEY = 'ptPocketPartnersAutoAuth';
const LEDGER_KEY = 'poTradeLedger';
const BRIDGE_STATE_KEY = 'poBridgeState';
const SOCKET_URL = 'wss://ws.partners-po.com/socket.io/?EIO=4&transport=websocket';
const DEFAULT_SETTINGS = {
  enabled: true,
  executionMode: 'official',
  uid: '',
  accessToken: '',
  allowRealTrading: true,
  updatedAt: null
};

let socket = null;
let connectPromise = null;
let connected = false;
let socketIoReady = false;
let authenticated = false;
let manualClose = false;
let userData = null;
let assetsList = [];
let lastError = null;
let pendingAttachmentPacket = null;
let officialTradeLock = null;
let authReject = null;
let transportFailureCount = 0;
let transportBackoffUntil = 0;
const TRANSPORT_BACKOFF_BASE_MS = 15000;
const TRANSPORT_BACKOFF_MAX_MS = 5 * 60 * 1000;
const AMBIGUOUS_OFFICIAL_TRADE_QUARANTINE_MS = 120000;
const pendingTrades = [];
const processedRequestIds = new Set();
const processedDealIds = new Set();

function nowIso() { return new Date().toISOString(); }
function finiteNumber(value) { if (value == null || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function meaningfulTradeRequestId(value) {
  const requestId = String(value ?? '').trim();
  return requestId && !['0', 'null', 'undefined'].includes(requestId.toLowerCase()) ? requestId : null;
}
function normalizedLedgerTimestampSeconds(value) {
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
function sameLedgerDealIdentity(left, right) {
  if (!left || !right) return false;
  const leftId = String(left.id || left.dealId || left.ticket || '').trim();
  const rightId = String(right.id || right.dealId || right.ticket || '').trim();
  if (leftId && rightId && leftId === rightId) return true;
  const leftRequest = meaningfulTradeRequestId(left.requestId || left.request_id);
  const rightRequest = meaningfulTradeRequestId(right.requestId || right.request_id);
  if (leftRequest && rightRequest && leftRequest === rightRequest) return true;
  if (leftId && rightId) return false;
  if (leftRequest && rightRequest) return false;
  if (!left.asset || !right.asset || String(left.asset) !== String(right.asset)) return false;
  if (left.action && right.action && String(left.action) !== String(right.action)) return false;
  if (left.isDemo != null && right.isDemo != null && Boolean(left.isDemo) !== Boolean(right.isDemo)) return false;
  const leftAmount = finiteNumber(left.amount);
  const rightAmount = finiteNumber(right.amount);
  if (leftAmount != null && rightAmount != null && Math.abs(leftAmount - rightAmount) > 1e-8) return false;
  const leftOpen = normalizedLedgerTimestampSeconds(left.openTimestamp);
  const rightOpen = normalizedLedgerTimestampSeconds(right.openTimestamp);
  if (leftOpen != null && rightOpen != null && Math.abs(leftOpen - rightOpen) > 5) return false;
  const leftExpiry = normalizedLedgerTimestampSeconds(left.expirationTimestamp)
    ?? (leftOpen != null && finiteNumber(left.duration) > 0 ? leftOpen + Number(left.duration) : null);
  const rightClose = normalizedLedgerTimestampSeconds(right.closeTimestamp)
    ?? normalizedLedgerTimestampSeconds(right.expirationTimestamp);
  if (leftExpiry != null && rightClose != null && Math.abs(leftExpiry - rightClose) > 15) return false;
  return true;
}
function isRobotLedgerDeal(deal) {
  const source = String(deal?.source || '').trim().toLowerCase();
  const requestId = meaningfulTradeRequestId(deal?.requestId);
  return Boolean(deal?.robotTrade === true || source === 'autotrade' || requestId?.startsWith('pt_'));
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function transportBackoffRemainingMs() {
  return Math.max(0, Number(transportBackoffUntil || 0) - Date.now());
}

function noteTransportFailure(reason = 'WebSocket transport failure') {
  transportFailureCount = Math.min(8, Number(transportFailureCount || 0) + 1);
  const delayMs = Math.min(
    TRANSPORT_BACKOFF_MAX_MS,
    TRANSPORT_BACKOFF_BASE_MS * (2 ** Math.max(0, transportFailureCount - 1))
  );
  transportBackoffUntil = Date.now() + delayMs;
  lastError = String(reason || 'WebSocket transport failure');
  void updateState({
    status: 'transport_backoff',
    transportFailureCount,
    transportBackoffUntil: new Date(transportBackoffUntil).toISOString(),
    transportBackoffMs: delayMs
  });
  return delayMs;
}

function resetTransportBackoff() {
  transportFailureCount = 0;
  transportBackoffUntil = 0;
}

function normalizeTokenCandidate(value) {
  const text = String(value || '').trim();
  if (!text || text.length < 20) return '';
  if (/^Bearer\s+/i.test(text)) return text.replace(/^Bearer\s+/i, '').trim();
  return text;
}

function uniqueTokenList(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const token = normalizeTokenCandidate(item);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.slice(0, 12);
}

function looksLikeJwt(value) {
  const text = normalizeTokenCandidate(value);
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text);
}

async function readAutoAuth() {
  const stored = await chrome.storage.local.get([AUTO_AUTH_KEY, BRIDGE_STATE_KEY]).catch(() => ({}));
  const auto = stored[AUTO_AUTH_KEY] || {};
  const bridge = stored[BRIDGE_STATE_KEY] || {};
  const candidates = uniqueTokenList([auto.accessToken, ...(Array.isArray(auto.candidates) ? auto.candidates : [])]);
  candidates.sort((a, b) => Number(looksLikeJwt(b)) - Number(looksLikeJwt(a)) || b.length - a.length);
  return {
    uid: String(auto.uid || bridge?.account?.uid || '').trim(),
    accessToken: candidates[0] || '',
    candidates,
    source: auto.source || null,
    capturedAt: auto.capturedAt || null
  };
}

async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY).catch(() => ({}));
  const raw = stored[SETTINGS_KEY] || {};
  const auto = await readAutoAuth();
  const tokenCandidates = uniqueTokenList(auto.candidates);
  return {
    ...DEFAULT_SETTINGS,
    // v1.0.56 official/fallback auto-auth: legacy manual UID/token are intentionally ignored.
    // Users must not enter Pocket Option credentials or tokens in extension settings.
    enabled: true,
    executionMode: 'official',
    uid: String(auto.uid || '').trim(),
    accessToken: auto.accessToken || '',
    tokenCandidates,
    authSource: auto.source || 'terminal_session',
    autoAuthCapturedAt: auto.capturedAt || null,
    allowRealTrading: true,
    updatedAt: raw.updatedAt || null
  };
}

function safeStatePatch(patch = {}) {
  const clean = { ...patch };
  delete clean.accessToken;
  delete clean.refreshToken;
  return clean;
}

async function updateState(patch = {}) {
  const current = await chrome.storage.local.get(STATE_KEY).catch(() => ({}));
  const previous = current[STATE_KEY] || {};
  const next = {
    ...previous,
    ...safeStatePatch(patch),
    connected,
    socketReady: socket?.readyState === WebSocket.OPEN,
    socketIoReady,
    authenticated,
    userData: userData ? sanitizeUserData(userData) : previous.userData || null,
    assetsCount: assetsList.length || previous.assetsCount || 0,
    lastError,
    updatedAt: nowIso()
  };
  await chrome.storage.local.set({ [STATE_KEY]: next }).catch(() => null);
  return next;
}

function sanitizeUserData(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    userId: data.userId ?? data.uid ?? null,
    real: data.real ? {
      login: data.real.login ?? null,
      uid: data.real.uid ?? null,
      currency: data.real.currency ?? null,
      balance: finiteNumber(data.real.balance),
      minTradeAmount: finiteNumber(data.real.minTradeAmount),
      maxTradeAmount: finiteNumber(data.real.maxTradeAmount),
      payoutMax: finiteNumber(data.real.payoutMax)
    } : null,
    demo: data.demo ? {
      uid: data.demo.uid ?? null,
      currency: data.demo.currency ?? null,
      balance: finiteNumber(data.demo.balance),
      minTradeAmount: finiteNumber(data.demo.minTradeAmount),
      maxTradeAmount: finiteNumber(data.demo.maxTradeAmount)
    } : null
  };
}

export async function capturePocketPartnersAuth(payload = {}) {
  const uid = String(payload.uid || payload.userId || payload.user_id || '').trim();
  const candidates = uniqueTokenList([payload.accessToken, payload.token, ...(Array.isArray(payload.candidates) ? payload.candidates : [])]);
  if (!uid && !candidates.length) return { ok: false, skipped: true, error: 'UID/token не найдены в открытой сессии Pocket Option' };
  const stored = await chrome.storage.local.get(AUTO_AUTH_KEY).catch(() => ({}));
  const previous = stored[AUTO_AUTH_KEY] || {};
  const previousCandidates = Array.isArray(previous.candidates) ? previous.candidates : [];
  const merged = uniqueTokenList([...candidates, previous.accessToken, ...previousCandidates]);
  merged.sort((a, b) => Number(looksLikeJwt(b)) - Number(looksLikeJwt(a)) || b.length - a.length);
  const next = {
    uid: uid || String(previous.uid || '').trim(),
    accessToken: merged[0] || String(previous.accessToken || '').trim(),
    candidates: merged,
    source: payload.source || previous.source || 'terminal_session',
    capturedAt: nowIso()
  };
  await chrome.storage.local.set({ [AUTO_AUTH_KEY]: next });
  await updateState({
    status: 'auto_auth_captured',
    autoAuth: true,
    autoUid: next.uid || null,
    autoTokenCaptured: Boolean(next.accessToken),
    autoAuthCapturedAt: next.capturedAt,
    officialOnly: true
  });
  return { ok: true, uid: next.uid || null, hasToken: Boolean(next.accessToken), candidates: merged.length };
}

export async function getPocketPartnersStatus() {
  const settings = await readSettings();
  const stored = await chrome.storage.local.get(STATE_KEY).catch(() => ({}));
  return {
    ok: true,
    settings: { ...settings, accessToken: settings.accessToken ? '[AUTO]' : '', tokenCandidates: settings.tokenCandidates?.length || 0 },
    state: stored[STATE_KEY] || await updateState({ status: 'idle' })
  };
}

export async function savePocketPartnersSettings() {
  // Keep only execution flags and drop any legacy manual UID/token saved by older test builds.
  const next = {
    enabled: true,
    executionMode: 'official',
    allowRealTrading: true,
    updatedAt: nowIso()
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await updateState({ status: 'configured_auto_auth_only', officialOnly: true, lastSettingsUpdateAt: nowIso() });
  const current = await readSettings();
  return { ok: true, settings: { ...current, accessToken: current.accessToken ? '[AUTO]' : '' }, state: await updateState({}) };
}

function encodeEvent(name, payload) {
  return `42${JSON.stringify([name, payload])}`;
}

function sendRaw(value) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Официальный WebSocket Pocket Option не подключён');
  socket.send(value);
}

function emitEvent(name, payload) {
  sendRaw(encodeEvent(name, payload));
}

function decodeMaybeJsonText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

async function decodeBufferPayload(value) {
  try {
    if (value == null) return null;
    if (value instanceof ArrayBuffer) return decodeMaybeJsonText(new TextDecoder('utf-8').decode(value));
    if (ArrayBuffer.isView(value)) return decodeMaybeJsonText(new TextDecoder('utf-8').decode(value));
    if (typeof Blob !== 'undefined' && value instanceof Blob) return decodeBufferPayload(await value.arrayBuffer());
    if (typeof value === 'string') return decodeMaybeJsonText(value);
    if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
      return decodeMaybeJsonText(new TextDecoder('utf-8').decode(new Uint8Array(value.data)));
    }
    return value;
  } catch (error) {
    return { decodeError: String(error?.message || error) };
  }
}

function replacePlaceholder(value, num, attachment) {
  if (!value || typeof value !== 'object') return value;
  if (value._placeholder === true && Number(value.num) === Number(num)) return attachment;
  if (Array.isArray(value)) return value.map((item) => replacePlaceholder(item, num, attachment));
  const next = {};
  for (const [key, item] of Object.entries(value)) next[key] = replacePlaceholder(item, num, attachment);
  return next;
}

async function parseSocketIoMessage(raw) {
  if (typeof raw !== 'string') {
    if (pendingAttachmentPacket) {
      const attachment = await decodeBufferPayload(raw);
      pendingAttachmentPacket.attachments.push(attachment);
      const index = pendingAttachmentPacket.attachments.length - 1;
      pendingAttachmentPacket.packet = replacePlaceholder(pendingAttachmentPacket.packet, index, attachment);
      if (pendingAttachmentPacket.attachments.length >= pendingAttachmentPacket.expected) {
        const packet = pendingAttachmentPacket.packet;
        pendingAttachmentPacket = null;
        return packet;
      }
    }
    return null;
  }
  if (raw === '2') { sendRaw('3'); return null; }
  if (raw.startsWith('0')) { connected = true; await updateState({ status: 'engine_connected', engineOpen: decodeMaybeJsonText(raw.slice(1)) }); sendRaw('40'); return null; }
  if (raw.startsWith('40')) { socketIoReady = true; await updateState({ status: 'socket_ready' }); return null; }
  if (raw.startsWith('42')) return decodeMaybeJsonText(raw.slice(2));
  if (raw.startsWith('45')) {
    const match = raw.match(/^45(\d+)-(.+)$/);
    if (match) {
      pendingAttachmentPacket = { expected: Number(match[1]) || 0, packet: decodeMaybeJsonText(match[2]), attachments: [] };
    }
    return null;
  }
  return null;
}

async function handleEventPacket(packet) {
  if (!Array.isArray(packet) || !packet.length) return;
  const [eventName, payload] = packet;
  switch (eventName) {
    case 'user.auth.success':
      authenticated = true;
      resetTransportBackoff();
      if (authReject) authReject = null;
      lastError = null;
      await updateState({
        status: 'authenticated',
        authenticatedAt: nowIso(),
        transportFailureCount: 0,
        transportBackoffUntil: null,
        transportBackoffMs: 0
      });
      break;
    case 'user.auth.error':
      authenticated = false;
      lastError = String(payload?.message || payload || 'Pocket Partners auth error');
      await updateState({ status: 'auth_error' });
      rejectPendingTrades(lastError);
      if (authReject) { const reject = authReject; authReject = null; reject(new Error(lastError)); }
      break;
    case 'user.initial_data':
      userData = await decodeBufferPayload(payload);
      await updateState({ status: 'initial_data', userData: sanitizeUserData(userData), userDataAt: nowIso() });
      break;
    case 'common.assets_list': {
      const decodedAssets = await decodeBufferPayload(payload);
      assetsList = Array.isArray(decodedAssets) ? decodedAssets : [];
      await mergeAssetsIntoBridgeState(assetsList);
      await updateState({ status: 'assets_list', assetsCount: assetsList.length, assetsListAt: nowIso() });
      break;
    }
    case 'user.demo.open_trade.success':
    case 'user.real.open_trade.success':
      await handleOpenTradeSuccess(eventName, await decodeBufferPayload(payload));
      break;
    case 'user.demo.open_trade.fail':
    case 'user.real.open_trade.fail':
      await handleOpenTradeFail(eventName, await decodeBufferPayload(payload));
      break;
    case 'user.demo.close_trade.success':
    case 'user.real.close_trade.success':
      await handleCloseTradeSuccess(eventName, await decodeBufferPayload(payload));
      break;
    case 'user.demo.update_balance':
    case 'user.real.update_balance':
      await handleBalanceUpdate(eventName, await decodeBufferPayload(payload));
      break;
    case 'user.disconnect_token_expired':
      authenticated = false;
      lastError = 'CLIENT_JWT_ACCESS_TOKEN истёк';
      await updateState({ status: 'token_expired' });
      rejectPendingTrades(lastError);
      if (authReject) { const reject = authReject; authReject = null; reject(new Error(lastError)); }
      break;
    default:
      await updateState({ lastEvent: String(eventName || ''), lastEventAt: nowIso() });
  }
}

function normalizeAssets(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === 'object' && item.symbol)
    .map((item) => ({
      id: item.id ?? null,
      symbol: String(item.symbol),
      label: String(item.label || item.symbol),
      type: String(item.type || ''),
      digits: finiteNumber(item.digits),
      payout: finiteNumber(item.payout),
      max_payout: finiteNumber(item.max_payout),
      min_timeframe: finiteNumber(item.min_timeframe),
      max_timeframe: finiteNumber(item.max_timeframe),
      minTimeframe: finiteNumber(item.min_timeframe),
      maxTimeframe: finiteNumber(item.max_timeframe),
      scheduled_until: finiteNumber(item.scheduled_until) || 0,
      expirationSource: 'partners_api',
      source: 'partners_api'
    }));
}

async function mergeAssetsIntoBridgeState(list) {
  const normalized = normalizeAssets(list);
  if (!normalized.length) return;
  const stored = await chrome.storage.local.get(BRIDGE_STATE_KEY).catch(() => ({}));
  const state = stored[BRIDGE_STATE_KEY] || {};
  const currentAssets = Array.isArray(state?.market?.assetList) ? state.market.assetList : [];
  const bySymbol = new Map(currentAssets.map((item) => [String(item?.symbol || ''), item]));
  const updatedAt = nowIso();
  for (const item of normalized) {
    const existing = bySymbol.get(item.symbol) || {};
    const candidateValues = [existing.payout, existing.assetInfoPayout, ...(Array.isArray(existing.payoutCandidates) ? existing.payoutCandidates : []), item.payout].filter((value) => finiteNumber(value) != null && Number(value) > 0 && Number(value) <= 100).map(Number);
    const safePayout = candidateValues.length ? Math.min(...candidateValues) : null;
    bySymbol.set(item.symbol, {
      ...existing,
      ...item,
      payout: safePayout,
      payoutCandidates: candidateValues.length ? [...new Set(candidateValues)] : (existing.payoutCandidates || []),
      payoutSource: item.payout != null ? 'partners_api' : (existing.payoutSource || null),
      payoutUpdatedAt: item.payout != null ? updatedAt : (existing.payoutUpdatedAt || null),
      assetInfoPayout: item.payout ?? existing.assetInfoPayout ?? null,
      assetInfoPayoutUpdatedAt: item.payout != null ? updatedAt : (existing.assetInfoPayoutUpdatedAt || null),
      max_payout: item.max_payout ?? existing.max_payout ?? null,
      min_timeframe: item.min_timeframe ?? existing.min_timeframe ?? existing.minTimeframe ?? null,
      max_timeframe: item.max_timeframe ?? existing.max_timeframe ?? existing.maxTimeframe ?? null,
      minTimeframe: item.minTimeframe ?? item.min_timeframe ?? existing.minTimeframe ?? existing.min_timeframe ?? null,
      maxTimeframe: item.maxTimeframe ?? item.max_timeframe ?? existing.maxTimeframe ?? existing.max_timeframe ?? null,
      expirationSource: item.expirationSource || existing.expirationSource || 'partners_api'
    });
  }
  const next = {
    ...state,
    market: {
      ...(state.market || {}),
      assetList: [...bySymbol.values()],
      officialAssetsAt: nowIso(),
      officialAssetsSource: 'partners_api'
    }
  };
  await chrome.storage.local.set({ [BRIDGE_STATE_KEY]: next }).catch(() => null);
}

function requestAccountType(payload = {}) {
  const raw = String(payload.accountMode || payload.mode || '').toUpperCase();
  if (raw === 'REAL' || raw === 'DEMO') return raw;
  return 'DEMO';
}

function bridgePayoutFreshnessBonus(updatedAt) {
  const ms = Date.parse(updatedAt || '');
  if (!Number.isFinite(ms)) return 0;
  const age = Date.now() - ms;
  if (age < 2 * 60 * 1000) return 12;
  if (age < 5 * 60 * 1000) return 6;
  return 0;
}

async function currentBridgePayout(asset) {
  const symbol = String(asset || '').trim();
  if (!symbol) return null;
  const stored = await chrome.storage.local.get(BRIDGE_STATE_KEY).catch(() => ({}));
  const market = stored[BRIDGE_STATE_KEY]?.market || {};
  const candidates = [];
  const add = (value, trust = 50, updatedAt = null) => {
    let payout = finiteNumber(value);
    if (payout == null || payout <= 0) return;
    if (payout <= 1) payout *= 100;
    if (payout > 0 && payout <= 100) candidates.push({ payout, trust: trust + bridgePayoutFreshnessBonus(updatedAt) });
  };
  const assetInfo = Array.isArray(market.assetList) ? market.assetList.find((item) => String(item?.symbol || '') === symbol) : null;
  if (String(market.asset || '') === symbol) {
    add(market.payout, 100);
    add(market.percentProfit, 98);
    add(market.profitPercent, 98);
    add(market.profitability, 96);
  }
  const sub = market.subscriptions?.[symbol] || {};
  // Candidate arrays from chafor are telemetry only; they must not raise a payout
  // guard above the actual/current payout field.
  add(sub.payout, String(sub.payoutSource || '').includes('chafor') ? 70 : 94, sub.payoutUpdatedAt || sub.streamUpdatedAt);
  add(sub.percentProfit, 92, sub.payoutUpdatedAt || sub.streamUpdatedAt);
  add(sub.profitPercent, 92, sub.payoutUpdatedAt || sub.streamUpdatedAt);
  const source = String(assetInfo?.payoutSource || '').toLowerCase();
  const assetTrust = source.includes('chafor') ? 70 : source.includes('partners_api') ? 96 : source.includes('asset_info') ? 96 : 84;
  add(assetInfo?.payout, assetTrust, assetInfo?.payoutUpdatedAt);
  add(assetInfo?.assetInfoPayout, 98, assetInfo?.assetInfoPayoutUpdatedAt || assetInfo?.payoutUpdatedAt);
  add(assetInfo?.percentProfit, 82, assetInfo?.payoutUpdatedAt);
  add(assetInfo?.profitPercent, 82, assetInfo?.payoutUpdatedAt);
  add(assetInfo?.profitability, 80, assetInfo?.payoutUpdatedAt);
  // max_payout/maxPayout are not current payout guards.
  if (!candidates.length) return null;
  const strong = candidates.filter((item) => item.trust >= 80);
  const pool = strong.length ? strong : candidates;
  pool.sort((a, b) => (a.payout - b.payout) || (b.trust - a.trust));
  return pool[0].payout;
}

function normalizeTradeInput(payload = {}, settings = {}) {
  const asset = String(payload.asset || '').trim();
  const amount = finiteNumber(payload.amount);
  const duration = Math.max(1, Math.floor(finiteNumber(payload.duration ?? payload.time) || 0));
  const action = payload.action === 'call' || payload.action === 'put' ? payload.action : null;
  const requestId = String(payload.requestId || crypto.randomUUID());
  const accountMode = requestAccountType(payload);
  if (!asset) throw new Error('Не выбран актив');
  if (!action) throw new Error('Не выбрано направление сделки');
  if (!amount || amount <= 0) throw new Error('Некорректная сумма сделки');
  if (!duration || duration <= 0) throw new Error('Некорректная экспирация сделки');
  const body = { asset, amount, action, time: duration };
  if (accountMode === 'REAL') {
    const login = userData?.real?.login;
    if (!login) throw new Error('Официальный API не вернул login реального счёта');
    body.login = String(login);
  }
  return { requestId, asset, amount, duration, action, accountMode, body };
}

function eventNameForOpen(accountMode) {
  return accountMode === 'REAL' ? 'user.real.open_trade' : 'user.demo.open_trade';
}

function rejectPendingTrades(reason) {
  while (pendingTrades.length) {
    const item = pendingTrades.shift();
    clearTimeout(item.timer);
    clearTimeout(item.quarantineTimer);
    const error = new Error(reason || 'Официальное исполнение сделки не подтверждено');
    error.code = 'OFFICIAL_TRADE_UNCONFIRMED';
    error.unconfirmed = true;
    error.requestId = item?.requestId || null;
    if (!item.callerSettled) item.reject(error);
  }
}

function takeMatchingPending(result, isDemo) {
  const accountMode = isDemo ? 'DEMO' : 'REAL';
  const accountIndexes = [];
  for (let index = 0; index < pendingTrades.length; index += 1) {
    if (pendingTrades[index]?.accountMode === accountMode) accountIndexes.push(index);
  }
  const resultRequestId = meaningfulTradeRequestId(result?.requestId || result?.request_id || result?.clientRequestId);
  let index = -1;
  if (resultRequestId) {
    index = accountIndexes.find((candidate) => meaningfulTradeRequestId(pendingTrades[candidate]?.requestId) === resultRequestId) ?? -1;
    // An explicit, different requestId must never fall through to fuzzy/FIFO.
    if (index < 0) return null;
  } else if (accountIndexes.length === 1) {
    index = accountIndexes[0];
  } else {
    // The official ACK has no client correlation. With two same-account
    // candidates it is unsafe to guess which recovery branch it belongs to.
    return null;
  }
  const item = pendingTrades.splice(index, 1)[0] || null;
  if (item) {
    clearTimeout(item.timer);
    clearTimeout(item.quarantineTimer);
  }
  return item;
}

function resolveMatchingPending(result, isDemo) {
  const item = takeMatchingPending(result, isDemo);
  if (!item) return null;
  if (!item.callerSettled) item.resolve(result);
  return item;
}

function ambiguousPendingTradeForAccount(accountMode) {
  return pendingTrades.find((item) => item?.accountMode === accountMode && item?.ambiguous === true) || null;
}

function quarantineTimedOutPendingTrade(item) {
  if (!item) return;
  item.callerSettled = true;
  item.ambiguous = true;
  item.ambiguousUntil = Date.now() + AMBIGUOUS_OFFICIAL_TRADE_QUARANTINE_MS;
  item.quarantineTimer = setTimeout(() => {
    const index = pendingTrades.indexOf(item);
    if (index >= 0) pendingTrades.splice(index, 1);
    // No correlated ACK arrived within the bounded quarantine. Retire the old
    // socket before another official order is allowed, so an even later packet
    // from that transport cannot be attributed to a newer request.
    const staleSocket = socket;
    if (staleSocket) {
      if (socket === staleSocket) {
        socket = null;
        connectPromise = null;
        connected = false;
        socketIoReady = false;
        authenticated = false;
        pendingAttachmentPacket = null;
      }
      try { staleSocket.close(); } catch {}
      void updateState({ status: 'ambiguous_trade_transport_retired', requestId: item.requestId || null });
    }
  }, AMBIGUOUS_OFFICIAL_TRADE_QUARANTINE_MS);
}

function attachPendingMetadata(deal, pending) {
  const opened = normalizedLedgerTimestampSeconds(deal?.openTimestamp) || Math.floor(Date.now() / 1000);
  const rawClose = normalizedLedgerTimestampSeconds(deal?.closeTimestamp);
  const duration = finiteNumber(pending?.duration) || (rawClose && rawClose > opened ? Math.max(1, rawClose - opened) : null);
  return {
    ...(deal || {}),
    id: String(deal?.id || deal?.dealId || pending?.requestId || crypto.randomUUID()),
    dealId: String(deal?.id || deal?.dealId || ''),
    requestId: pending?.requestId || null,
    asset: deal?.asset || pending?.asset || null,
    action: deal?.action || (deal?.command === 1 ? 'put' : deal?.command === 0 ? 'call' : pending?.action || null),
    amount: finiteNumber(deal?.amount) ?? pending?.amount ?? null,
    duration,
    // Pocket Partners open_trade.success already contains the scheduled future
    // closeTimestamp. It is the expiry time, not proof that the deal is closed.
    expirationTimestamp: rawClose || (opened && duration ? opened + duration : null),
    openTimestamp: opened,
    closeTimestamp: null,
    status: 'open',
    outcome: 'open',
    isDemo: pending?.accountMode === 'DEMO',
    source: pending?.source || 'official_api',
    robotTrade: String(pending?.source || '').trim().toLowerCase() === 'autotrade',
    executionSource: 'official_api',
    strategyId: pending?.strategyId || null,
    signalConfidence: pending?.signalConfidence ?? null,
    signalPayout: pending?.signalPayout ?? finiteNumber(deal?.payout),
    signalExpiration: pending?.signalExpiration ?? duration,
    calibrationApplied: pending?.calibrationApplied || null,
    brokerConfirmed: true,
    officialApi: true,
    confirmedAt: nowIso()
  };
}

function closeDealFromApi(deal, isDemo) {
  const action = deal?.action || (deal?.command === 1 ? 'put' : deal?.command === 0 ? 'call' : null);
  const open = normalizedLedgerTimestampSeconds(deal?.openTimestamp);
  const close = normalizedLedgerTimestampSeconds(deal?.closeTimestamp);
  const amount = finiteNumber(deal?.amount);
  const payout = finiteNumber(deal?.payout);
  const openPrice = finiteNumber(deal?.openPrice);
  const closePrice = finiteNumber(deal?.closePrice);
  const rawProfit = finiteNumber(deal?.profit ?? deal?.pnl ?? deal?.resultAmount ?? deal?.result);
  const explicit = String(deal?.outcome ?? deal?.resultStatus ?? deal?.status ?? deal?.reason ?? '').toLowerCase();
  const equalPrices = openPrice != null && closePrice != null && Math.abs(openPrice - closePrice) <= Math.max(1e-10, Math.abs(openPrice) * 1e-10);
  const movement = openPrice != null && closePrice != null ? closePrice - openPrice : null;

  let outcome = 'draw';
  if (equalPrices || /draw|refund|return|tie|push|cancel|equal|возврат|ничья|отмена/.test(explicit)) outcome = 'draw';
  else if (/(?:^|[^a-z])(loss|lose|lost|failed)(?:$|[^a-z])/.test(explicit)) outcome = 'loss';
  else if (/win|won|profit/.test(explicit)) outcome = 'win';
  else if ((amount || 0) > 0 && rawProfit != null && rawProfit > 0 && Math.abs(rawProfit - amount) <= Math.max(0.000001, amount * 0.000001)) outcome = 'draw';
  else if (movement != null && movement !== 0 && action) outcome = action === 'call' ? (movement > 0 ? 'win' : 'loss') : (movement < 0 ? 'win' : 'loss');
  else if (rawProfit != null && rawProfit < 0) outcome = 'loss';
  else if (rawProfit != null && rawProfit > 0) outcome = 'win';
  else if ((amount || 0) > 0) outcome = 'loss';

  let profit = rawProfit;
  if (outcome === 'loss' && (profit == null || profit >= 0)) profit = -(amount || 0);
  if (outcome === 'draw') profit = 0;

  return {
    ...(deal || {}),
    id: String(deal?.id || deal?.dealId || crypto.randomUUID()),
    dealId: String(deal?.id || deal?.dealId || ''),
    requestId: meaningfulTradeRequestId(deal?.requestId || deal?.request_id),
    asset: deal?.asset || null,
    action,
    amount,
    payout,
    percentProfit: payout,
    profit,
    openTimestamp: open,
    closeTimestamp: close || Math.floor(Date.now() / 1000),
    duration: open && close ? Math.max(1, close - open) : null,
    expirationTimestamp: close || null,
    status: 'closed',
    outcome,
    isDemo,
    officialApi: true,
    executionSource: 'official_api',
    brokerConfirmed: true,
    confirmedAt: nowIso(),
    source: deal?.source || 'official_api',
    robotTrade: deal?.robotTrade === true
  };
}

async function readLedger() {
  const stored = await chrome.storage.local.get(LEDGER_KEY).catch(() => ({}));
  return stored[LEDGER_KEY] || { version: 2, closedDeals: [], openDeals: [], summary: {}, today: {}, todayKey: localDayKey(), updatedAt: null, resetAt: null, resetTimestamp: null };
}

function ledgerResetIdentityKey(deal) {
  if (!deal || typeof deal !== 'object') return null;
  const id = String(deal.id || deal.dealId || deal.ticket || '').trim();
  if (id) return `id:${id}`;
  const requestId = meaningfulTradeRequestId(deal.requestId || deal.request_id);
  if (requestId) return `request:${requestId}`;
  const asset = String(deal.asset || '').trim();
  const action = String(deal.action || '').trim();
  const amount = finiteNumber(deal.amount);
  const opened = normalizedLedgerTimestampSeconds(deal.openTimestamp || deal.openedAt);
  if (!asset && !action && amount == null && opened == null) return null;
  return `finger:${asset}:${action}:${amount ?? ''}:${opened ?? ''}`;
}

function dealAfterLedgerReset(deal, ledger, brokerOffsetSec = null) {
  const resetTimestamp = normalizedLedgerTimestampSeconds(ledger?.resetTimestamp)
    ?? (ledger?.resetAt ? Math.floor(Date.parse(ledger.resetAt) / 1000) : null);
  if (!resetTimestamp) return true;
  const resetKeys = new Set(Array.isArray(ledger?.resetDealKeys) ? ledger.resetDealKeys.map(String) : []);
  const identity = ledgerResetIdentityKey(deal);
  if (identity && resetKeys.has(identity)) return false;
  const timestamp = normalizedLedgerTimestampSeconds(deal?.closeTimestamp)
    ?? normalizedLedgerTimestampSeconds(deal?.openTimestamp)
    ?? normalizedLedgerTimestampSeconds(deal?.closedAt)
    ?? normalizedLedgerTimestampSeconds(deal?.openedAt);
  if (timestamp == null) return false;
  const resetBrokerTimestamp = normalizedLedgerTimestampSeconds(ledger?.resetBrokerTimestamp);
  const explicitOffset = finiteNumber(brokerOffsetSec);
  const inferredOffset = explicitOffset ?? (resetBrokerTimestamp != null ? resetBrokerTimestamp - resetTimestamp : 0);
  const realTimestamp = statisticsDealTimestampSeconds(deal, timestamp, inferredOffset);
  return realTimestamp != null && realTimestamp >= resetTimestamp;
}

function localDayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dealNetResult(deal) {
  const amount = Math.max(0, finiteNumber(deal?.amount) ?? 0);
  const rawProfit = finiteNumber(deal?.profit) ?? 0;
  const percent = finiteNumber(deal?.percentProfit ?? deal?.payout ?? deal?.signalPayout);
  const outcome = String(deal?.outcome || deal?.result || deal?.status || '').toLowerCase();
  const openPrice = finiteNumber(deal?.openPrice);
  const closePrice = finiteNumber(deal?.closePrice);
  const equalPrices = openPrice != null && closePrice != null && Math.abs(openPrice - closePrice) <= Math.max(1e-10, Math.abs(openPrice) * 1e-10);
  if (outcome === 'draw' || equalPrices || /return|refund|draw|tie|push|cancel|equal|возврат|ничья|отмена/.test(outcome)) return 0;
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
  return rawProfit;
}

function summarizeDeals(deals, dayKey = null, brokerOffsetSec = 0) {
  const summary = { total: 0, wins: 0, losses: 0, draws: 0, netProfit: 0, invested: 0, winRate: 0 };
  const offset = finiteNumber(brokerOffsetSec) ?? 0;
  for (const deal of deals) {
    if (dayKey) {
      const ts = statisticsDealTimestampSeconds(deal, deal.closeTimestamp ?? deal.openTimestamp, offset);
      if (!ts || localDayKey(new Date(ts * 1000)) !== dayKey) continue;
    }
    const net = dealNetResult(deal);
    summary.total += 1;
    summary.netProfit += net;
    summary.invested += finiteNumber(deal.amount) ?? 0;
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
  const timestamp = normalizedLedgerTimestampSeconds(value);
  if (timestamp == null) return null;
  const rawOffset = finiteNumber(brokerOffsetSec) ?? 0;
  const offset = Math.abs(rawOffset) <= 3 * 24 * 60 * 60 ? rawOffset : 0;
  if (!offset) return timestamp;
  const adjusted = timestamp - offset;
  const references = [];
  const confirmedAt = normalizedLedgerTimestampSeconds(deal?.confirmedAt);
  const submittedAt = normalizedLedgerTimestampSeconds(deal?.submittedAt);
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

const TRADE_LEDGER_MUTATION_TAIL_KEY = '__ptTradeLedgerMutationTailV1__';

function serializeTradeLedgerMutation(task) {
  const previous = globalThis[TRADE_LEDGER_MUTATION_TAIL_KEY] instanceof Promise
    ? globalThis[TRADE_LEDGER_MUTATION_TAIL_KEY]
    : Promise.resolve();
  const run = previous.then(task, task);
  globalThis[TRADE_LEDGER_MUTATION_TAIL_KEY] = run.catch(() => null);
  return run;
}

async function upsertLedgerOpenUnlocked(deal) {
  if (!deal?.id) return;
  const ledger = await readLedger();
  const bridge = (await chrome.storage.local.get(BRIDGE_STATE_KEY).catch(() => ({})))[BRIDGE_STATE_KEY] || null;
  const brokerOffsetSec = finiteNumber(bridge?.market?.brokerClockOffsetSec) ?? 0;
  if (!dealAfterLedgerReset(deal, ledger, brokerOffsetSec)) return;
  const closedDeals = Array.isArray(ledger.closedDeals) ? ledger.closedDeals : [];
  if (closedDeals.some((item) => sameLedgerDealIdentity(item, deal))) return;
  const openDeals = Array.isArray(ledger.openDeals) ? ledger.openDeals : [];
  const existing = openDeals.find((item) => sameLedgerDealIdentity(item, deal)) || null;
  const merged = {
    ...(existing || {}),
    ...deal,
    requestId: meaningfulTradeRequestId(deal.requestId) || meaningfulTradeRequestId(existing?.requestId),
    source: deal.source || existing?.source || null,
    robotTrade: deal.robotTrade === true || existing?.robotTrade === true || String(deal.source || existing?.source || '').toLowerCase() === 'autotrade'
  };
  if (!isRobotLedgerDeal(merged)) return;
  const nextOpen = openDeals.filter((item) => !sameLedgerDealIdentity(item, merged));
  nextOpen.push(merged);
  const todayKey = localDayKey();
  const next = { ...ledger, openDeals: nextOpen.slice(-300), todayKey, summary: summarizeDeals(closedDeals), today: summarizeDeals(closedDeals, todayKey, brokerOffsetSec), updatedAt: nowIso() };
  await chrome.storage.local.set({ [LEDGER_KEY]: next }).catch(() => null);
}

async function upsertLedgerClosedUnlocked(deal) {
  if (!deal?.id) return;
  const ledger = await readLedger();
  const bridge = (await chrome.storage.local.get(BRIDGE_STATE_KEY).catch(() => ({})))[BRIDGE_STATE_KEY] || null;
  const brokerOffsetSec = finiteNumber(bridge?.market?.brokerClockOffsetSec) ?? 0;
  if (!dealAfterLedgerReset(deal, ledger, brokerOffsetSec)) return;
  const openDeals = Array.isArray(ledger.openDeals) ? ledger.openDeals : [];
  const closedExisting = Array.isArray(ledger.closedDeals) ? ledger.closedDeals : [];
  const matchingOpen = openDeals.find((item) => sameLedgerDealIdentity(item, deal)) || null;
  const matchingClosed = closedExisting.find((item) => sameLedgerDealIdentity(item, deal)) || null;
  const inheritedSource = matchingOpen?.source || matchingClosed?.source || deal?.source || 'official_api';
  const inheritedRequestId = meaningfulTradeRequestId(deal?.requestId)
    || meaningfulTradeRequestId(matchingOpen?.requestId)
    || meaningfulTradeRequestId(matchingClosed?.requestId);
  const inheritedRobot = isRobotLedgerDeal(deal) || isRobotLedgerDeal(matchingOpen) || isRobotLedgerDeal(matchingClosed);
  const mergedDeal = {
    ...(matchingClosed || {}),
    ...(matchingOpen || {}),
    ...deal,
    id: String(deal.id || matchingOpen?.id || matchingClosed?.id || ''),
    requestId: inheritedRequestId,
    strategyId: deal.strategyId || matchingOpen?.strategyId || matchingClosed?.strategyId || null,
    signalConfidence: deal.signalConfidence ?? matchingOpen?.signalConfidence ?? matchingClosed?.signalConfidence ?? null,
    signalPayout: deal.signalPayout ?? matchingOpen?.signalPayout ?? matchingClosed?.signalPayout ?? deal.percentProfit ?? null,
    signalExpiration: deal.signalExpiration ?? matchingOpen?.signalExpiration ?? matchingClosed?.signalExpiration ?? deal.duration ?? null,
    calibrationApplied: deal.calibrationApplied || matchingOpen?.calibrationApplied || matchingClosed?.calibrationApplied || null,
    source: inheritedRobot ? 'autotrade' : inheritedSource,
    robotTrade: inheritedRobot,
    executionSource: 'official_api',
    optimistic: false,
    brokerConfirmed: true,
    status: 'closed'
  };

  if (!isRobotLedgerDeal(mergedDeal)) return;
  const closedMap = new Map();
  for (const item of closedExisting) {
    if (sameLedgerDealIdentity(item, mergedDeal)) continue;
    closedMap.set(String(item.id), item);
  }
  closedMap.set(String(mergedDeal.id), mergedDeal);
  const closedDeals = [...closedMap.values()].sort((a, b) => Number(a.closeTimestamp || 0) - Number(b.closeTimestamp || 0)).slice(-1500);
  const nextOpen = openDeals.filter((item) => !sameLedgerDealIdentity(item, mergedDeal));
  const todayKey = localDayKey();
  const next = { ...ledger, closedDeals, openDeals: nextOpen, summary: summarizeDeals(closedDeals), today: summarizeDeals(closedDeals, todayKey, brokerOffsetSec), todayKey, updatedAt: nowIso() };
  await chrome.storage.local.set({ [LEDGER_KEY]: next }).catch(() => null);
}

function upsertLedgerOpen(deal) {
  return serializeTradeLedgerMutation(() => upsertLedgerOpenUnlocked(deal));
}

function upsertLedgerClosed(deal) {
  return serializeTradeLedgerMutation(() => upsertLedgerClosedUnlocked(deal));
}

async function handleOpenTradeSuccess(eventName, rawDeal) {
  const isDemo = eventName.includes('.demo.');
  const pending = resolveMatchingPending(rawDeal, isDemo);
  const deal = attachPendingMetadata(rawDeal, pending || { accountMode: isDemo ? 'DEMO' : 'REAL' });
  if (deal.id) processedDealIds.add(String(deal.id));
  await upsertLedgerOpen(deal);
  await updateState({ status: 'trade_opened', lastOpenedDeal: { ...deal, raw: undefined }, lastTradeAt: nowIso() });
  if (pending?.requestId) processedRequestIds.add(String(pending.requestId));
}

async function handleOpenTradeFail(eventName, rawError) {
  const isDemo = eventName.includes('.demo.');
  const pending = takeMatchingPending(rawError, isDemo);
  const message = String(rawError?.message || rawError?.error || JSON.stringify(rawError || {}) || 'Pocket Option отклонил открытие сделки');
  if (pending) {
    if (!pending.callerSettled) pending.reject(new Error(message));
  }
  lastError = message;
  await updateState({ status: 'trade_open_failed', lastOpenError: rawError || message });
}

async function handleCloseTradeSuccess(eventName, raw) {
  const isDemo = eventName.includes('.demo.');
  const trades = Array.isArray(raw?.trades) ? raw.trades : (Array.isArray(raw) ? raw : [raw].filter(Boolean));
  for (const item of trades) {
    const deal = closeDealFromApi(item, isDemo);
    if (!deal.id) continue;
    processedDealIds.add(`closed:${deal.id}`);
    await upsertLedgerClosed(deal);
  }
  await updateState({ status: 'trade_closed', lastClosedTrades: trades.length, lastClosedAt: nowIso() });
}

async function handleBalanceUpdate(eventName, raw) {
  const stored = await chrome.storage.local.get(BRIDGE_STATE_KEY).catch(() => ({}));
  const state = stored[BRIDGE_STATE_KEY] || {};
  const balance = finiteNumber(raw?.balance);
  const isDemo = eventName.includes('.demo.') || Number(raw?.isDemo) === 1;
  if (balance != null) {
    const next = {
      ...state,
      account: {
        ...(state.account || {}),
        mode: isDemo ? 'DEMO' : 'REAL',
        balance,
        uid: raw?.uid ?? state?.account?.uid ?? null,
        login: raw?.login ?? state?.account?.login ?? null
      }
    };
    await chrome.storage.local.set({ [BRIDGE_STATE_KEY]: next }).catch(() => null);
  }
  await updateState({ status: 'balance_update', lastBalance: raw || null, lastBalanceAt: nowIso() });
}

async function ensureConnected(settings = null, timeoutMs = 15000) {
  settings = settings || await readSettings();
  if (!settings.uid || !settings.accessToken) throw new Error('Откройте и подключите терминал Pocket Option: UID и CLIENT_JWT_ACCESS_TOKEN должны быть получены автоматически из активной сессии');
  if (socket?.readyState === WebSocket.OPEN && authenticated) return true;
  if (connectPromise) return connectPromise;

  const backoffMs = transportBackoffRemainingMs();
  if (backoffMs > 0) {
    throw new Error(`Официальный WebSocket Pocket Option временно недоступен после ошибки транспорта; повтор через ${Math.max(1, Math.ceil(backoffMs / 1000))} сек.`);
  }

  manualClose = false;
  connected = false;
  socketIoReady = false;
  authenticated = false;
  pendingAttachmentPacket = null;

  connectPromise = new Promise((resolve, reject) => {
    let attemptSocket = null;
    let settled = false;
    let authSent = false;
    let transportFailureNoted = false;

    const noteFailureOnce = (reason) => {
      if (transportFailureNoted) return;
      transportFailureNoted = true;
      noteTransportFailure(reason);
    };

    const clearAttemptGlobals = (rejecter) => {
      if (authReject === rejecter) authReject = null;
      connectPromise = null;
    };

    let timeout = null;
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      clearAttemptGlobals(rejectAttempt);
      resolve(true);
    };
    const settleReject = (error, { transportFailure = false } = {}) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const normalized = error instanceof Error ? error : new Error(String(error || 'Pocket Option WebSocket error'));
      if (transportFailure) noteFailureOnce(normalized.message);
      clearAttemptGlobals(rejectAttempt);
      reject(normalized);
    };
    const rejectAttempt = (error) => settleReject(error);
    authReject = rejectAttempt;

    timeout = setTimeout(() => {
      const error = new Error('Официальный WebSocket Pocket Option не ответил вовремя: WebSocket handshake/transport timeout');
      if (attemptSocket && (attemptSocket.readyState === WebSocket.CONNECTING || attemptSocket.readyState === WebSocket.OPEN)) {
        try { attemptSocket.close(); } catch {}
      }
      if (socket === attemptSocket) {
        socket = null;
        connected = false;
        socketIoReady = false;
        authenticated = false;
        pendingAttachmentPacket = null;
      }
      settleReject(error, { transportFailure: true });
    }, timeoutMs);

    try {
      // Close stale OPEN and CONNECTING sockets. The previous implementation only
      // closed OPEN sockets, so handshake timeouts could leave orphan CONNECTING
      // attempts and create a reconnect storm in chrome://extensions.
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        try { socket.close(); } catch {}
      }

      attemptSocket = new WebSocket(SOCKET_URL);
      socket = attemptSocket;
      attemptSocket['bin' + 'aryType'] = 'arraybuffer';

      attemptSocket.addEventListener('open', () => {
        if (socket !== attemptSocket) return;
        connected = true;
        lastError = null;
        void updateState({ status: 'ws_open' });
      });

      attemptSocket.addEventListener('message', async (event) => {
        if (socket !== attemptSocket || settled && !authenticated) return;
        try {
          const packet = await parseSocketIoMessage(event.data);
          // Authenticate once per socket.io connection. Sending user.auth after
          // every incoming packet can flood the official endpoint while auth is
          // pending and amplify failures on slow links.
          if (socketIoReady && !authenticated && !authSent) {
            authSent = true;
            emitEvent('user.auth', { uid: Number(settings.uid) || settings.uid, token: settings.accessToken });
          }
          if (packet) await handleEventPacket(packet);
          if (authenticated) settleResolve();
        } catch (error) {
          lastError = String(error?.message || error);
          await updateState({ status: 'message_error' });
          if (!authenticated && !settled) settleReject(error);
        }
      });

      attemptSocket.addEventListener('close', () => {
        if (socket !== attemptSocket) return;
        const wasAuthenticated = authenticated;
        socket = null;
        connected = false;
        socketIoReady = false;
        authenticated = false;
        pendingAttachmentPacket = null;
        void updateState({ status: manualClose ? 'disconnected' : 'socket_closed' });
        rejectPendingTrades('Официальный WebSocket Pocket Option отключён');

        if (!manualClose && wasAuthenticated) {
          noteFailureOnce('Официальный WebSocket Pocket Option неожиданно отключён: WebSocket transport closed');
        }
        if (!settled) {
          settleReject(
            new Error(manualClose
              ? 'Официальный WebSocket Pocket Option отключён'
              : 'Официальный WebSocket Pocket Option закрылся до авторизации: WebSocket transport closed'),
            { transportFailure: !manualClose }
          );
        }
      });

      attemptSocket.addEventListener('error', () => {
        if (socket !== attemptSocket) return;
        const error = new Error('Ошибка официального WebSocket Pocket Option: WebSocket handshake/transport error');
        lastError = error.message;
        void updateState({ status: 'socket_error' });
        if (attemptSocket && (attemptSocket.readyState === WebSocket.CONNECTING || attemptSocket.readyState === WebSocket.OPEN)) {
          try { attemptSocket.close(); } catch {}
        }
        settleReject(error, { transportFailure: true });
      });
    } catch (error) {
      settleReject(error, { transportFailure: true });
    }
  });
  return connectPromise;
}

export async function connectPocketPartners() {
  const settings = await readSettings();
  await ensureConnected(settings, 20000);
  return { ok: true, state: await updateState({ status: 'connected' }) };
}

export async function disconnectPocketPartners(reason = 'manual') {
  manualClose = true;
  rejectPendingTrades('Официальный WebSocket Pocket Option отключён');
  // Settle an in-flight handshake/auth promise before detaching the socket. If we
  // simply null the globals first, its close handler becomes stale and the caller
  // waits until the original timeout fires.
  const rejectActiveConnection = authReject;
  if (rejectActiveConnection) {
    try { rejectActiveConnection(new Error('Официальный WebSocket Pocket Option отключён')); } catch {}
  }
  if (socket) {
    try { socket.close(); } catch {}
  }
  socket = null;
  connectPromise = null;
  authReject = null;
  connected = false;
  socketIoReady = false;
  authenticated = false;
  pendingAttachmentPacket = null;
  await updateState({ status: 'disconnected', reason });
  return { ok: true };
}

async function withOfficialTradeLock(fn) {
  while (officialTradeLock) await officialTradeLock.catch(() => null);
  let release;
  officialTradeLock = new Promise((resolve) => { release = resolve; });
  try { return await fn(); }
  finally { release(); officialTradeLock = null; }
}

export async function openPocketPartnersTrade(payload = {}) {
  const settings = await readSettings();
  if (!settings.uid || !settings.accessToken) return { ok: false, skipped: true, fallback: false, officialAttempted: true, error: 'Официальный API: UID или CLIENT_JWT_ACCESS_TOKEN не получены автоматически из активной сессии Pocket Option' };
  return withOfficialTradeLock(async () => {
    const executionDeadlineMs = Number(payload?.executionDeadlineMs);
    const hasExecutionDeadline = Number.isFinite(executionDeadlineMs) && executionDeadlineMs > 0;
    const remainingMs = () => hasExecutionDeadline ? executionDeadlineMs - Date.now() : Infinity;
    if (hasExecutionDeadline && remainingMs() <= 1500) throw new Error('Сигнал устарел в очереди официального исполнения');
    const connectTimeoutMs = hasExecutionDeadline
      ? Math.max(1000, Math.min(20000, remainingMs() - 750))
      : 20000;
    await ensureConnected(settings, connectTimeoutMs);
    if (hasExecutionDeadline && remainingMs() <= 750) throw new Error('Сигнал устарел при подключении официального исполнения');
    const trade = normalizeTradeInput(payload, settings);
    const ambiguousPrevious = ambiguousPendingTradeForAccount(trade.accountMode);
    if (ambiguousPrevious) {
      const error = new Error(`Official transport ждёт позднее подтверждение предыдущей сделки ${ambiguousPrevious.requestId || ''}`.trim());
      error.code = 'OFFICIAL_ACCOUNT_AMBIGUOUS';
      error.requestId = trade.requestId;
      throw error;
    }
    const minPayout = finiteNumber(payload.minPayout);
    if (minPayout != null && minPayout > 0) {
      const verifiedPayout = payload.currentPayoutVerified === true ? finiteNumber(payload.currentPayout) : null;
      if (verifiedPayout == null || verifiedPayout < minPayout) {
        const source = String(payload.currentPayoutSource || 'unverified');
        throw new Error(verifiedPayout == null ? `Payout ${trade.asset} не подтверждён перед official-open (${source}); минимум ${minPayout}%` : `Payout ${verifiedPayout}% ниже минимума ${minPayout}%; official-open отменён`);
      }
    }
    if (processedRequestIds.has(trade.requestId)) return { ok: false, duplicate: true, fallback: false, error: 'Эта команда уже отправлялась через официальный API' };
    if (hasExecutionDeadline && remainingMs() <= 1000) throw new Error('Сигнал устарел перед отправкой официальной торговой команды');
    const eventName = eventNameForOpen(trade.accountMode);
    const result = await new Promise((resolve, reject) => {
      const confirmationTimeoutMs = hasExecutionDeadline
        ? Math.max(250, Math.min(45000, remainingMs() - 500))
        : 45000;
      const timer = setTimeout(() => {
        const index = pendingTrades.findIndex((item) => item.requestId === trade.requestId);
        if (index >= 0) quarantineTimedOutPendingTrade(pendingTrades[index]);
        const error = new Error(hasExecutionDeadline ? 'Сигнал истёк до подтверждения Pocket Partners API' : 'Pocket Partners API не подтвердил открытие сделки за 45 сек');
        error.code = 'OFFICIAL_TRADE_UNCONFIRMED';
        error.unconfirmed = true;
        error.requestId = trade.requestId;
        reject(error);
      }, confirmationTimeoutMs);
      pendingTrades.push({ ...trade, source: payload.source || 'manual', strategyId: payload.strategyId || null, signalConfidence: payload.signalConfidence ?? null, signalPayout: payload.signalPayout ?? null, signalExpiration: payload.signalExpiration ?? trade.duration, calibrationApplied: payload.calibrationApplied || null, resolve, reject, timer });
      try {
        emitEvent(eventName, trade.body);
        processedRequestIds.add(trade.requestId);
      } catch (error) {
        clearTimeout(timer);
        const index = pendingTrades.findIndex((item) => item.requestId === trade.requestId);
        if (index >= 0) pendingTrades.splice(index, 1);
        reject(error);
      }
    });
    const deal = attachPendingMetadata(result, { ...trade, source: payload.source || 'manual', strategyId: payload.strategyId || null, signalConfidence: payload.signalConfidence ?? null, signalPayout: payload.signalPayout ?? null, signalExpiration: payload.signalExpiration ?? trade.duration, calibrationApplied: payload.calibrationApplied || null });
    return { ok: true, confirmed: true, executor: 'pocket_partners', requestId: trade.requestId, result: { status: 'success', dealId: deal.id, officialApi: true, trade: deal } };
  }).catch(async (error) => {
    lastError = String(error?.message || error);
    await updateState({ status: 'trade_error', lastError });
      const unconfirmed = error?.unconfirmed === true || String(error?.code || '') === 'OFFICIAL_TRADE_UNCONFIRMED';
    return {
      ok: false,
      confirmed: false,
      unconfirmed,
      submitted: unconfirmed,
      skipped: String(error?.code || '') === 'OFFICIAL_ACCOUNT_AMBIGUOUS',
      fallback: false,
      officialAttempted: true,
      code: error?.code || null,
      requestId: error?.requestId || payload?.requestId || null,
      result: unconfirmed ? { status: 'unconfirmed', requestId: error?.requestId || payload?.requestId || null, error: lastError } : null,
      error: lastError
    };
  });
}
