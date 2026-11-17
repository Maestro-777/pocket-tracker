(() => {
  'use strict';

  const PT_PAGE_BRIDGE_BUILD = '2.0.50-statusbar-recovery-20260916';

  const __ptHost = String(location.hostname || '').toLowerCase();
  if (!(__ptHost === 'pocketoption.com' || __ptHost.endsWith('.pocketoption.com') || __ptHost === 'po.trade' || __ptHost.endsWith('.po.trade'))) return;

  // MAIN-world scripts survive an extension update while the isolated content
  // controller is replaced.  Re-running another WebSocket hook would duplicate
  // outgoing commands, so an older bridge explicitly asks the background to do
  // a guarded page refresh instead of being patched over in place.
  if (window.__PO_SOCKET_BRIDGE_V220__) {
    const previousBuild = String(window.__PO_SOCKET_BRIDGE_BUILD__ || 'legacy');
    if (previousBuild !== PT_PAGE_BRIDGE_BUILD) {
      try {
        window.__PO_SOCKET_BRIDGE_RELOAD_REQUIRED__ = {
          previousBuild,
          requestedBuild: PT_PAGE_BRIDGE_BUILD,
          requestedAt: Date.now()
        };
      } catch {}
    }
    return;
  }
  window.__PO_SOCKET_BRIDGE_V220__ = true;
  window.__PO_SOCKET_BRIDGE_BUILD__ = PT_PAGE_BRIDGE_BUILD;
  try { delete window.__PO_SOCKET_BRIDGE_RELOAD_REQUIRED__; } catch {}

  const VERSION = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '2.0.50');
  const MARKER = '__PO_ACCOUNT_BRIDGE__';
  const SOCKET_OPEN = 1;
  const MAX_EVENTS = 90;
  const MAX_TICKS = 800;
  const MAX_CANDLES = 400;
  const MAX_HISTORY_ITEMS = 5000;
  const MAX_ASSETS = 800;
  const MAX_RESULTS = 100;
  const MAX_RAW_SAMPLES = 16;
  const MAX_TRADE_EVENTS = 80;
  const MAX_TRADE_SAMPLES = 30;
  const OPTIMISTIC_OPEN_GRACE_SECONDS = 20;
  const BROKER_OPEN_GRACE_SECONDS = 120;
  // Pocket can execute an order but omit/delay successopenOrder. Correlate that
  // broker deal only with the exact recently submitted Robot fingerprint.
  const LATE_ROBOT_ORDER_MATCH_WINDOW_SECONDS = 12;
  const SOCKET_STALE_MS = 45000;
  const BACKGROUND_SOCKET_HOLD_MS = 5 * 60 * 60 * 1000;
  const SOCKET_RECOVERY_CHECK_MS = 3000;
  const MULTI_SCAN_INTERVAL_MS = 320;
  const INITIAL_HISTORY_CANDLES = 240;
  const MULTI_SCAN_HISTORY_OFFSET = 3;
  const HISTORY_REQUEST_STALE_MS = 4200;
  const HISTORY_LATE_RESPONSE_GUARD_MS = 700;
  // One deterministic history request globally. A single helper socket is reused
  // across all timeframes so large asset sets cannot overload the account socket.
  const MAX_HISTORY_IN_FLIGHT = 1;
  const MAX_HISTORY_IN_FLIGHT_PER_PERIOD = 1;
  const HISTORY_QUEUE_RETRY_MS = 90;
  const HISTORY_REQUEST_SPACING_MS = 0;
  const MAX_SCAN_BATCH_SIZE = 1;
  const BROKER_CLOCK_MAX_ABS_SECONDS = 3 * 24 * 60 * 60;
  const HISTORY_FRESH_MAX_AGE_SECONDS = 12 * 60;
  const HISTORY_GAP_MULTIPLIER = 4;
  const HISTORY_PRICE_JUMP_RATIO = 1.35;
  const ALLOWED_ANALYSIS_PERIOD_SECONDS = Object.freeze([5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 14400, 86400]);

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket?.prototype?.send;
  const socketMeta = new WeakMap();
  const sockets = new Set();
  const assets = new Map();
  // Missing-from-catalog is weaker evidence than an explicit broker active=false.
  // Require repeated sufficiently-complete catalogues before runtime deactivation.
  const assetCatalogMissCounts = new Map();
  const pendingTrades = new Map();
  const recentExecutionRequests = new Map();
  const validatingExecutionRequests = new Set();
  const candleBuilders = new Map();
  const outgoingOrders = [];
  const subscriptionData = new Map();
  // Additional candle/history stores for strategy-specific timeframes. The live
  // tick subscription remains on one primary period, while higher/lower strategy
  // histories coexist here without overwriting the primary chart.
  const timeframeSubscriptionData = new Map();
  const historyRequests = new Map();
  const historyTaskQueue = [];
  let historyQueueTimer = null;
  let historyQueueDueAt = 0;
  let historyQueueBlockedUntil = 0;
  const marketSnapshotTimers = new Map();
  const marketSnapshotLastSentAt = new Map();
  const diagnosticRecentEventLastStoredAt = new Map();
  const diagnosticRawSampleLastStoredAt = new Map();
  const DIAGNOSTIC_HOT_EVENT_INTERVAL_MS = 1000;
  const DIAGNOSTIC_RAW_SAMPLE_INTERVAL_MS = 5000;
  let assetCatalogRevision = 0;
  let cachedPublicAssetListRevision = -1;
  let cachedPublicAssetList = [];

  let activeTradingSocket = null;
  let activeMarketSocket = null;
  let scannerSocket = null;
  let scannerSocketReady = false;
  let scannerSocketAuthSent = false;
  let scannerSocketNamespaceSent = false;
  let scannerSocketReconnectTimer = null;
  let scannerSocketCreatedAt = 0;
  let scannerSocketLastError = null;
  let lastTargetedStreamResubscribeAt = 0;
  // Exactly one helper WebSocket is reused for every history timeframe. Earlier
  // builds created one socket per TF (14 simultaneous lanes for 76 assets), which
  // made Pocket rotate transports and briefly invalidated the account socket.
  const SHARED_SCANNER_LANE_KEY = 0;
  const scannerSocketLanes = new Map();
  const intentionallyClosedScannerSockets = new WeakSet();

  function scannerPeriodKey(period) {
    return Math.max(1, Number(period) || 60);
  }

  function scannerLane(period, create = true) {
    let lane = scannerSocketLanes.get(SHARED_SCANNER_LANE_KEY) || null;
    if (!lane && create) {
      lane = { period: scannerPeriodKey(period), socket: null, ready: false, authSent: false, namespaceSent: false, reconnectTimer: null, createdAt: 0, lastError: null, suppressReconnect: false };
      scannerSocketLanes.set(SHARED_SCANNER_LANE_KEY, lane);
    } else if (lane && period != null) {
      lane.period = scannerPeriodKey(period);
    }
    return lane;
  }

  function scannerLaneForSocket(socket) {
    const lane = scannerSocketLanes.get(SHARED_SCANNER_LANE_KEY) || null;
    return lane?.socket === socket ? lane : null;
  }

  function updateScannerAggregateState() {
    const lane = scannerSocketLanes.get(SHARED_SCANNER_LANE_KEY) || null;
    const active = Boolean(lane?.socket && lane.socket.readyState < 2);
    const ready = Boolean(active && lane.ready && isSocketHealthy(lane.socket, 90000));
    scannerSocket = active ? lane.socket : null;
    scannerSocketReady = ready;
    scannerSocketCreatedAt = active ? lane.createdAt : 0;
    scannerSocketLastError = lane?.lastError || null;
    state.market.scannerSocketReady = scannerSocketReady;
    state.market.scannerSocketHost = active ? (socketMeta.get(lane.socket)?.host || null) : null;
    state.market.scannerSocketLastError = scannerSocketLastError;
    state.market.scannerSocketLaneCount = active ? 1 : 0;
    state.market.scannerSocketReadyLanes = ready ? [lane.period] : [];
  }

  let manualConnectionRequested = false;
  let connectedAccountIdentity = null;
  let loginUpgradeArmed = false;
  let loginUpgradeUserInitiated = false;
  const LOGIN_UPGRADE_SESSION_KEY = '__PT_WAITING_ACCOUNT_LOGIN_V170__';
  const LOGIN_UPGRADE_TTL_MS = 20 * 60 * 1000;
  let emitTimer = null;
  let revision = 0;
  let historyRequestIndex = Date.now();
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let healthTimer = null;
  let subscriptionQueueToken = 0;
  let desiredSubscriptionPlan = { active: false, assets: [], assetsByPeriod: {}, period: 60, periods: [60], historyOffset: INITIAL_HISTORY_CANDLES, historyOffsets: { 60: INITIAL_HISTORY_CANDLES } };
  let multiAssetScanTimer = null;
  let multiAssetScanCursor = 0;
  let multiAssetScanCycle = 0;
  let lastChaforDiagnosticAt = 0;
  let lastChaforStateEmitAt = 0;
  let brokerClockOffsetSec = 0;
  let brokerClockObservedAt = null;
  let brokerClockRawOffsetSec = null;
  let brokerClockSource = null;
  let brokerClockLastLiveAt = 0;
  const brokerClockSamples = [];
  const BROKER_CLOCK_SAMPLE_LIMIT = 11;
  let multiAssetScanRequests = 0;
  let multiAssetScanResponses = 0;
  let lastMultiAssetScanAsset = null;

  const state = {
    version: VERSION,
    revision: 0,
    bridgeReady: true,
    timestamp: new Date().toISOString(),
    page: {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState
    },
    connection: {
      requested: false,
      connected: false,
      connectedAt: null,
      disconnectedAt: null,
      authCaptured: false,
      reconnecting: false,
      reconnectAttempts: 0,
      waitingForLogin: false,
      loginWaitReason: null,
      lastError: null
    },
    socket: {
      discovered: false,
      authenticated: false,
      readyState: null,
      host: null,
      totalObserved: 0,
      pocketObserved: 0,
      connectedAt: null,
      authenticatedAt: null,
      lastIncomingAt: null,
      lastOutgoingAt: null,
      lastCloseAt: null,
      closeCode: null,
      closeReason: null
    },
    account: {
      uid: null,
      mode: null,
      isDemo: null,
      platform: null,
      balance: null,
      currency: null,
      sessionCaptured: false,
      balanceUpdatedAt: null
    },
    // Passive login evidence is intentionally separate from account connection.
    // It lets the UI distinguish a real logged-in /cabinet session from /try-demo
    // without treating socket observation as consent to connect the Robot account.
    login: {
      authenticated: false,
      uid: null,
      mode: null,
      isDemo: null,
      observedAt: null
    },
    market: {
      asset: null,
      period: 60,
      selectedAssets: [],
      subscriptionCount: 0,
      subscriptions: {},
      timeframeSubscriptions: {},
      timeframeSubscriptionCount: 0,
      subscribed: false,
      streamActive: false,
      subscriptionRequested: false,
      subscriptionSentAt: null,
      subscriptionAcknowledgedAt: null,
      historyRequestedAt: null,
      lastPrice: null,
      lastTickTime: null,
      tickCount: 0,
      currentCandle: null,
      recentTicks: [],
      recentCandles: [],
      historyItems: [],
      historyCount: 0,
      historyTotal: 0,
      historyReceivedAt: null,
      assetsCount: 0,
      assetList: [],
      payout: null,
      streamUpdatedAt: null,
      liveStreamCount: 0,
      historyFreshCount: 0,
      historyPendingCount: 0,
      historyQueuedCount: 0,
      historyMaxInFlight: MAX_HISTORY_IN_FLIGHT,
      scannerActive: false,
      scanCursor: 0,
      scanCycle: 0,
      lastScanAt: null,
      lastScanAsset: null,
      scanRequests: 0,
      scanResponses: 0,
      brokerClockOffsetSec: 0,
      brokerClockObservedAt: null,
      brokerClockRawOffsetSec: null,
      brokerClockSource: null,
      brokerClockSampleCount: 0,
      scannerSocketReady: false,
      scannerSocketHost: null,
      scannerSocketLastError: null
    },
    trades: {
      pendingCount: 0,
      successCount: 0,
      failedCount: 0,
      unconfirmedCount: 0,
      openedCount: null,
      closedCount: null,
      lastRequest: null,
      lastResult: null,
      recentResults: [],
      openedDeals: [],
      closedDeals: [],
      lastOpenSnapshotAt: null,
      lastOpenSnapshotCount: 0,
      optimisticOpenCount: 0,
      statistics: { total: 0, wins: 0, losses: 0, draws: 0, open: 0, netProfit: 0, invested: 0, winRate: 0 }
    },
    diagnostics: {
      eventCounts: {},
      recentEvents: [],
      recentTradeEvents: [],
      tradeSamples: [],
      rawSamples: [],
      errors: []
    }
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function observeBrokerClock(timestamp, source = 'market') {
    const normalized = normalizeTimestamp(timestamp);
    if (!normalized) return;
    const localNow = Math.floor(Date.now() / 1000);
    const rawOffset = normalized - localNow;
    if (!Number.isFinite(rawOffset) || Math.abs(rawOffset) > BROKER_CLOCK_MAX_ABS_SECONDS) return;

    const isLive = source === 'live';
    const nowMs = Date.now();
    // Live ticks are the source of truth. Fresh live observations must not be
    // overwritten by older history timestamps while the scanner changes assets.
    if (!isLive && brokerClockLastLiveAt && nowMs - brokerClockLastLiveAt < 120000) return;
    if (isLive) brokerClockLastLiveAt = nowMs;

    // Round to a minute to suppress network jitter, then stabilize the offset
    // with a short rolling median instead of trusting one isolated packet.
    const rounded = Math.round(rawOffset / 60) * 60;
    brokerClockRawOffsetSec = rawOffset;
    brokerClockSamples.push({ offset: rounded, source, at: nowMs });
    while (brokerClockSamples.length > BROKER_CLOCK_SAMPLE_LIMIT) brokerClockSamples.shift();

    const preferred = brokerClockSamples
      .filter((item) => isLive ? item.source === 'live' : true)
      .map((item) => item.offset)
      .sort((a, b) => a - b);
    const values = preferred.length
      ? preferred
      : brokerClockSamples.map((item) => item.offset).sort((a, b) => a - b);
    if (!values.length) return;

    const median = values[Math.floor(values.length / 2)];
    brokerClockOffsetSec = Math.abs(median) < 30 ? 0 : median;
    brokerClockObservedAt = nowIso();
    brokerClockSource = isLive ? 'live_stream' : source;
  }

  function brokerNowSeconds() {
    return Math.floor(Date.now() / 1000) + Number(brokerClockOffsetSec || 0);
  }

  function clampArray(array, max) {
    if (array.length > max) array.splice(0, array.length - max);
  }

  function safeNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
      if (!normalized) return null;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function normalizeAnalysisPeriodSeconds(value, fallback = 60) {
    const raw = safeNumber(value);
    const fallbackValue = safeNumber(fallback);
    const rounded = Math.round(raw != null && raw > 0 ? raw : fallbackValue || 60);
    if (ALLOWED_ANALYSIS_PERIOD_SECONDS.includes(rounded)) return rounded;
    return ALLOWED_ANALYSIS_PERIOD_SECONDS.find((item) => item >= rounded)
      || ALLOWED_ANALYSIS_PERIOD_SECONDS[ALLOWED_ANALYSIS_PERIOD_SECONDS.length - 1];
  }

  // Preserve only an explicitly user-requested guest -> authenticated handoff
  // across same-mirror reloads. Passive guest market discovery must never arm
  // account connection by itself.
  queueMicrotask(() => {
    const marker = readLoginUpgradeMarker();
    if (marker?.userInitiated === true) {
      manualConnectionRequested = true;
      armLoginUpgrade(marker.reason || 'guest_login_navigation', true);
    }
  });

  function normalizeTimestamp(value) {
    const num = safeNumber(value);
    if (num == null) return null;
    if (num > 1e15) return Math.floor(num / 1e6);
    if (num > 1e12) return Math.floor(num / 1000);
    if (num > 1e10) return Math.floor(num / 1000);
    return Math.floor(num);
  }

  function isTimestampLike(value) {
    const timestamp = normalizeTimestamp(value);
    return timestamp != null && timestamp > 946684800 && timestamp < 4102444800;
  }

  function safeHost(url) {
    try {
      return new URL(String(url), location.href).host;
    } catch {
      return String(url || '').slice(0, 120);
    }
  }

  function isPocketSocketUrl(url) {
    const value = String(url || '').toLowerCase();
    return value.includes('po.market') || value.includes('pocketoption') || value.includes('/socket.io');
  }

  function isTradingSocketHost(url) {
    const host = safeHost(url).toLowerCase();
    return host === 'po.market' || host.endsWith('.po.market');
  }

  function classifyAuthPayload(payload) {
    if (!payload || typeof payload !== 'object') return { account: false, market: false };
    const account = findDeep(payload, ['uid', 'userId', 'user_id', 'isDemo', 'is_demo', 'session', 'platform', 'accountType', 'account_type']) != null;
    const market = findDeep(payload, ['token', 'isFastHistory', 'fastHistory']) != null;
    return { account, market: market || !account };
  }

  function authPayloadUid(payload) {
    const value = findDeep(payload, ['uid', 'userId', 'user_id']);
    if (value == null) return null;
    const text = String(value).trim();
    return text && text !== '0' && text.toLowerCase() !== 'null' && text.toLowerCase() !== 'undefined' ? value : null;
  }

  function isGuestTryDemoContext() {
    return /(?:^|\/)try-demo(?:\/|$)/i.test(String(location.pathname || ''));
  }

  function readLoginUpgradeMarker() {
    try {
      const raw = sessionStorage.getItem(LOGIN_UPGRADE_SESSION_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const at = Number(data?.at || 0);
      if (!at || Date.now() - at > LOGIN_UPGRADE_TTL_MS) {
        sessionStorage.removeItem(LOGIN_UPGRADE_SESSION_KEY);
        return null;
      }
      // Old/passive markers are intentionally not accepted as connection intent.
      if (data?.userInitiated !== true) {
        sessionStorage.removeItem(LOGIN_UPGRADE_SESSION_KEY);
        return null;
      }
      return { at, reason: String(data?.reason || ''), userInitiated: true };
    } catch {
      return null;
    }
  }

  function armLoginUpgrade(reason = 'guest_market_ready', userInitiated = false) {
    loginUpgradeArmed = true;
    loginUpgradeUserInitiated = loginUpgradeUserInitiated || userInitiated === true;
    state.connection.waitingForLogin = loginUpgradeUserInitiated;
    state.connection.loginWaitReason = loginUpgradeUserInitiated ? reason : null;
    state.connection.lastError = null;
    if (userInitiated === true) {
      try {
        sessionStorage.setItem(LOGIN_UPGRADE_SESSION_KEY, JSON.stringify({ at: Date.now(), reason, userInitiated: true }));
      } catch {}
    }
  }

  function clearLoginUpgradeArm() {
    loginUpgradeArmed = false;
    loginUpgradeUserInitiated = false;
    state.connection.waitingForLogin = false;
    state.connection.loginWaitReason = null;
    try { sessionStorage.removeItem(LOGIN_UPGRADE_SESSION_KEY); } catch {}
  }

  function isLoginUpgradeArmed() {
    if (loginUpgradeArmed && loginUpgradeUserInitiated) return true;
    const marker = readLoginUpgradeMarker();
    if (marker?.userInitiated === true) {
      loginUpgradeArmed = true;
      loginUpgradeUserInitiated = true;
      state.connection.waitingForLogin = true;
      state.connection.loginWaitReason = marker.reason || state.connection.loginWaitReason || 'guest_login_navigation';
      state.connection.lastError = null;
      return true;
    }
    return false;
  }

  function hasConcreteAccountIdentity(meta) {
    return Boolean(meta?.accountAuth && authPayloadUid(meta?.authPayload) != null);
  }

  function normalizeBoolean(value) {
    if (value === true || value === 1 || value === '1') return true;
    if (value === false || value === 0 || value === '0') return false;
    const text = String(value ?? '').trim().toLowerCase();
    if (['true', 'yes', 'demo', 'practice'].includes(text)) return true;
    if (['false', 'no', 'real', 'live'].includes(text)) return false;
    return null;
  }

  function inferDemoMode(auth, socketUrl = '') {
    const explicit = findDeep(auth, ['isDemo', 'is_demo', 'demo', 'practice']);
    const parsed = normalizeBoolean(explicit);
    if (parsed != null) return parsed;
    const accountType = String(findDeep(auth, ['accountType', 'account_type', 'mode', 'balanceType']) ?? '').toLowerCase();
    if (/demo|practice/.test(accountType)) return true;
    if (/real|live/.test(accountType)) return false;
    const context = `${location.pathname} ${location.search} ${socketUrl}`.toLowerCase();
    if (/try-demo|demo-quick|\/demo(?:\/|$)|demo-api|try-demo/.test(context)) return true;
    if (/\/real(?:\/|$)|real-api/.test(context)) return false;
    return null;
  }

  function socketAccountIdentity(socket) {
    const meta = socket ? socketMeta.get(socket) : null;
    if (!meta?.authPayload) return null;
    const uidValue = authPayloadUid(meta.authPayload);
    if (uidValue == null) return null;
    const uid = String(uidValue).trim();
    const isDemo = inferDemoMode(meta.authPayload, meta.url);
    return { uid, isDemo, mode: isDemo == null ? null : (isDemo ? 'DEMO' : 'REAL') };
  }

  function accountIdentityCompatible(expected, candidate) {
    if (!expected || !candidate) return true;
    if (String(expected.uid || '') !== String(candidate.uid || '')) return false;
    if (expected.mode && candidate.mode && expected.mode !== candidate.mode) return false;
    return true;
  }

  function requireManualReconnectAfterContextSwitch(candidate, reason = 'account_context_changed') {
    const previous = connectedAccountIdentity;
    stopMultiAssetScanner();
    closeScannerSocket('account_context_changed');
    manualConnectionRequested = false;
    connectedAccountIdentity = null;
    clearLoginUpgradeArm();
    desiredSubscriptionPlan = { active: false, assets: [], assetsByPeriod: {}, period: 60, periods: [60], historyOffset: INITIAL_HISTORY_CANDLES, historyOffsets: { 60: INITIAL_HISTORY_CANDLES } };
    subscriptionQueueToken += 1;
    activeTradingSocket = null;
    activeMarketSocket = null;
    state.connection.requested = false;
    state.connection.connected = false;
    state.connection.reconnecting = false;
    state.connection.lastError = `Контекст счёта изменён${previous?.mode && candidate?.mode ? ` (${previous.mode} → ${candidate.mode})` : ''}. Нажмите «Подключить аккаунт» вручную.`;
    state.connection.disconnectedAt = nowIso();
    clearPublicAccount();
    resetPublicMarket();
    recordEvent('internal', 'account_context_change_requires_manual_connect', { previous, candidate, reason }, null);
    emitState(true);
    return false;
  }

  const TRADING_EVENTS = new Set([
    'auth', 'successauth', 'auth/success', 'successupdateBalance', 'updateAssets',
    'updateStream', 'chafor', 'updateHistory', 'updateHistoryNewFast', 'updateHistoryNew',
    'successChangeSymbol', 'successSubfor', 'openOrder', 'successopenOrder',
    'failopenOrder', 'updateOpenedDeals', 'updateClosedDeals', 'successcloseOrder'
  ]);

  function markTradingSocket(socket, event = null) {
    const meta = socketMeta.get(socket);
    if (!meta) return;
    if (meta.tradingHost || TRADING_EVENTS.has(event)) meta.trading = true;
    if (TRADING_EVENTS.has(event)) {
      meta.score = (meta.score || 0) + (event === 'updateStream' ? 3 : 1);
      meta.lastTradingEventAt = Date.now();
    }
  }

  function selectedSocketMeta() {
    return activeTradingSocket ? socketMeta.get(activeTradingSocket) : null;
  }

  function socketLastActivityMs(socket) {
    const meta = socket ? socketMeta.get(socket) : null;
    return Math.max(
      Number(meta?.lastIncomingAtMs || 0),
      Number(meta?.lastOutgoingAtMs || 0),
      Number(meta?.openedAtMs || 0),
      Number(meta?.createdAtMs || 0)
    );
  }

  function isSocketHealthy(socket, maxIdleMs = SOCKET_STALE_MS) {
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    const meta = socketMeta.get(socket);
    if (!meta?.authPayload) return false;
    const backgroundHold = maxIdleMs === SOCKET_STALE_MS
      && hasFrozenAccountContext()
      && (isPocketTabBackgrounded() || state.connection.backgroundPaused);
    const effectiveMaxIdleMs = backgroundHold ? BACKGROUND_SOCKET_HOLD_MS : maxIdleMs;
    const lastIncoming = Number(meta.lastIncomingAtMs || meta.openedAtMs || meta.createdAtMs || 0);
    return !lastIncoming || Date.now() - lastIncoming <= effectiveMaxIdleMs;
  }

  function socketHasAccountCapability(meta) {
    // successauth alone is not proof of a trading account: Pocket Option guest
    // /try-demo sockets also acknowledge auth and publish a virtual 50000 balance.
    // A trading socket must carry a concrete Pocket Option UID in its own auth payload.
    return hasConcreteAccountIdentity(meta);
  }

  function isExecutionSocketCandidate(socket) {
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    const meta = socketMeta.get(socket);
    // The dedicated internalScanner is intentionally authorized so it can request
    // history and rotate symbols. It must never become the execution/openOrder socket.
    return Boolean(
      meta
      && !meta.internalScanner
      && meta.tradingHost
      && meta.authPayload
      && socketHasAccountCapability(meta)
    );
  }

  function isExecutionSocketHealthy(socket, maxIdleMs = SOCKET_STALE_MS) {
    return isExecutionSocketCandidate(socket) && isSocketHealthy(socket, maxIdleMs);
  }

  function chooseTradingSocket() {
    return [...sockets]
      .filter((socket) => socket.readyState === SOCKET_OPEN)
      .map((socket) => ({ socket, meta: socketMeta.get(socket) }))
      .filter(({ socket }) => isExecutionSocketCandidate(socket))
      .sort((a, b) => {
        const aHealthy = isSocketHealthy(a.socket) ? 1 : 0;
        const bHealthy = isSocketHealthy(b.socket) ? 1 : 0;
        if (aHealthy !== bHealthy) return bHealthy - aHealthy;
        const aConfirmed = a.meta.authConfirmed ? 1 : 0;
        const bConfirmed = b.meta.authConfirmed ? 1 : 0;
        if (aConfirmed !== bConfirmed) return bConfirmed - aConfirmed;
        if ((a.meta.score || 0) !== (b.meta.score || 0)) return (b.meta.score || 0) - (a.meta.score || 0);
        const activityDiff = socketLastActivityMs(b.socket) - socketLastActivityMs(a.socket);
        if (activityDiff) return activityDiff;
        return (b.meta.lastTradingEventAt || 0) - (a.meta.lastTradingEventAt || 0);
      })[0]?.socket || null;
  }

  function chooseMarketSocket() {
    const candidates = [...sockets]
      .filter((socket) => socket.readyState === SOCKET_OPEN)
      .map((socket) => ({ socket, meta: socketMeta.get(socket) }))
      .filter(({ meta }) => meta && !meta.internalScanner && meta.tradingHost && meta.authPayload && (meta.marketAuth || meta.marketEvents > 0))
      .sort((a, b) => {
        const aHealthy = isSocketHealthy(a.socket) ? 1 : 0;
        const bHealthy = isSocketHealthy(b.socket) ? 1 : 0;
        if (aHealthy !== bHealthy) return bHealthy - aHealthy;
        if ((a.meta.marketEvents || 0) !== (b.meta.marketEvents || 0)) return (b.meta.marketEvents || 0) - (a.meta.marketEvents || 0);
        return socketLastActivityMs(b.socket) - socketLastActivityMs(a.socket);
      });
    return candidates[0]?.socket || activeTradingSocket || null;
  }

  function markSubscriptionsReconnecting() {
    for (const sub of subscriptionData.values()) {
      sub.subscribed = false;
      sub.streamActive = false;
    }
  }

  function isPocketTabBackgrounded() {
    return document.visibilityState === 'hidden';
  }

  function hasFrozenAccountContext() {
    return Boolean(manualConnectionRequested && state?.account?.uid != null);
  }

  function freezeConnectionForBackground(reason = 'tab_background') {
    if (!hasFrozenAccountContext()) return false;
    state.page.visibility = document.visibilityState;
    state.connection.connected = true;
    state.connection.reconnecting = false;
    // Фон вкладки — нормальный режим Chrome, не ошибка подключения.
    // Состояние аккаунта удерживаем спокойно; при возврате watchdog выполнит мягкую пересинхронизацию.
    state.connection.lastError = null;
    state.connection.backgroundMessage = 'Вкладка Pocket Option в фоне · состояние удерживается и будет тихо пересинхронизировано при возврате.';
    state.connection.backgroundAt = nowIso();
    state.socket.authenticated = state.socket.authenticated || Boolean(state.connection.authCaptured || state.account?.uid != null);
    state.connection.backgroundPaused = true;
    state.connection.backgroundReason = reason;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    return true;
  }

  function resumeFromBackgroundIfNeeded() {
    if (state.connection.backgroundPaused) {
      state.connection.backgroundPaused = false;
      state.connection.backgroundReason = null;
      state.connection.backgroundMessage = null;
      state.connection.backgroundAt = null;
    }
  }

  function tryAdoptAuthorizedSocket(socket, reason = 'login_upgrade') {
    const meta = socket ? socketMeta.get(socket) : null;
    // Never promote the dedicated market scanner into the execution role.
    if (!meta || meta.internalScanner || !isExecutionSocketCandidate(socket)) return false;
    if (!manualConnectionRequested && !isLoginUpgradeArmed()) return false;
    const changed = socket !== activeTradingSocket;
    if (applySelectedSocketToPublic(socket, { reason }) === false) return false;
    activeMarketSocket = chooseMarketSocket() || socket;
    ensureScannerSocket();
    state.connection.connected = true;
    state.connection.reconnecting = false;
    state.connection.lastError = null;
    try { sendPacket('getBalance'); } catch {}
    if (changed && desiredSubscriptionPlan.active && desiredSubscriptionPlan.assets.length) {
      setTimeout(() => resumeDesiredSubscriptions(reason), 220);
    }
    emitState(true);
    return true;
  }

  function tryAdoptReplacementSocket(reason = 'reconnect') {
    if (!manualConnectionRequested) return false;
    if (isExecutionSocketHealthy(activeTradingSocket)) {
      // A helper/history scanner may have requested a recovery check. Never leave
      // the public account state in RECONNECT when the execution socket is healthy.
      state.connection.connected = true;
      state.connection.reconnecting = false;
      state.connection.lastError = null;
      reconnectAttempt = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      return true;
    }
    const previousSocket = activeTradingSocket;
    const socket = chooseTradingSocket();
    if (!socket || (socket === previousSocket && !isExecutionSocketHealthy(socket))) return false;
    const changed = socket !== activeTradingSocket;
    if (applySelectedSocketToPublic(socket, { reason }) === false) return false;
    activeMarketSocket = chooseMarketSocket() || socket;
    ensureScannerSocket();
    state.connection.reconnecting = false;
    state.connection.reconnectAttempts = reconnectAttempt;
    state.connection.lastError = null;
    reconnectAttempt = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { sendPacket('getBalance'); } catch {}
    if (changed && desiredSubscriptionPlan.active && desiredSubscriptionPlan.assets.length) {
      setTimeout(() => resumeDesiredSubscriptions(reason), 220);
    }
    emitState(true);
    return true;
  }

  function scheduleSocketRecovery(immediate = false) {
    if (!manualConnectionRequested) return;
    if (isExecutionSocketHealthy(activeTradingSocket)) {
      state.connection.connected = true;
      state.connection.reconnecting = false;
      state.connection.lastError = null;
      reconnectAttempt = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      return;
    }
    if (reconnectTimer) return;
    state.connection.reconnecting = true;
    reconnectAttempt += 1;
    state.connection.reconnectAttempts = reconnectAttempt;
    if (navigator.onLine === false) {
      state.connection.lastError = 'Нет доступа к сети. Переподключение продолжится автоматически после восстановления интернета.';
    }
    const baseDelay = immediate ? 120 : Math.min(12000, 420 * Math.pow(1.62, Math.min(reconnectAttempt, 8)));
    const jitter = immediate ? 0 : Math.floor(Math.random() * Math.min(900, baseDelay * 0.18));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!manualConnectionRequested) return;
      if (!tryAdoptReplacementSocket('socket_reconnect')) scheduleSocketRecovery(false);
    }, baseDelay + jitter);
  }

  function connectionHealthCheck(reason = 'watchdog') {
    if (!manualConnectionRequested) return;
    const backgroundCheck = isPocketTabBackgrounded() || reason === 'tab_background' || reason === 'window_blur';
    if (backgroundCheck && hasFrozenAccountContext()) {
      freezeConnectionForBackground(reason);
      emitState();
      return;
    }
    resumeFromBackgroundIfNeeded();
    if (navigator.onLine === false) {
      state.connection.connected = false;
      state.connection.reconnecting = true;
      state.connection.lastError = 'Интернет-соединение потеряно. Ожидаем восстановление сети…';
      emitState();
      return;
    }
    if (isExecutionSocketHealthy(activeTradingSocket)) {
      if (state.connection.reconnecting || !state.connection.connected || state.connection.backgroundPaused) {
        state.connection.connected = true;
        state.connection.reconnecting = false;
        state.connection.lastError = null;
        state.connection.backgroundPaused = false;
        state.connection.backgroundReason = null;
        reconnectAttempt = 0;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        emitState(true);
      }
      return;
    }
    state.connection.connected = false;
    state.connection.reconnecting = true;
    state.connection.lastError = activeTradingSocket?.readyState === SOCKET_OPEN
      ? 'Торговый поток не отвечает. Ищем новый канал без сброса настроек…'
      : 'Торговый поток обновляется. Выполняется автоматическое переподключение…';
    markSubscriptionsReconnecting();
    if (!tryAdoptReplacementSocket(reason)) scheduleSocketRecovery(true);
    emitState();
  }

  function clearPublicAccount() {
    state.account.uid = null;
    state.account.mode = null;
    state.account.isDemo = null;
    state.account.platform = null;
    state.account.balance = null;
    state.account.currency = null;
    state.account.sessionCaptured = false;
    state.account.balanceUpdatedAt = null;
  }

  function resetPublicMarket() {
    subscriptionData.clear();
    timeframeSubscriptionData.clear();
    historyRequests.clear();
    clearHistoryQueue();
    candleBuilders.clear();
    state.market.selectedAssets = [];
    state.market.subscriptionCount = 0;
    state.market.subscriptions = {};
    state.market.timeframeSubscriptions = {};
    state.market.timeframeSubscriptionCount = 0;
    state.market.subscribed = false;
    state.market.streamActive = false;
    state.market.subscriptionRequested = false;
    state.market.subscriptionSentAt = null;
    state.market.subscriptionAcknowledgedAt = null;
    state.market.historyRequestedAt = null;
    state.market.lastPrice = null;
    state.market.lastTickTime = null;
    state.market.tickCount = 0;
    state.market.currentCandle = null;
    state.market.recentTicks = [];
    state.market.recentCandles = [];
    state.market.historyItems = [];
    state.market.historyCount = 0;
    state.market.historyTotal = 0;
    state.market.historyReceivedAt = null;
    state.market.streamUpdatedAt = null;
    state.market.liveStreamCount = 0;
    state.market.historyFreshCount = 0;
    state.market.historyPendingCount = 0;
    state.market.historyQueuedCount = 0;
    state.market.historyMaxInFlight = MAX_HISTORY_IN_FLIGHT;
    state.market.scannerActive = false;
    state.market.scanCursor = 0;
    state.market.scanCycle = 0;
    state.market.lastScanAt = null;
    state.market.scannerSocketReady = false;
    state.market.scannerSocketHost = null;
    state.market.scannerSocketLastError = null;
  }

  function applySelectedSocketToPublic(socket, options = {}) {
    const meta = socketMeta.get(socket);
    if (meta?.internalScanner) {
      throw new Error('Внутренний рыночный сканер не может использоваться для исполнения сделок. Ищем основной WebSocket аккаунта…');
    }
    const candidateIdentity = socketAccountIdentity(socket);
    if (!options.explicitManual && manualConnectionRequested && connectedAccountIdentity && candidateIdentity && !accountIdentityCompatible(connectedAccountIdentity, candidateIdentity)) {
      return requireManualReconnectAfterContextSwitch(candidateIdentity, options.reason || 'socket_adoption');
    }
    if (!isExecutionSocketCandidate(socket)) {
      throw new Error(isGuestTryDemoContext()
        ? 'Зеркало Pocket Option подключено. Ожидается вход пользователя в аккаунт — гостевой поток используется только для рынка.'
        : 'Мост терминала временно не видит авторизованный торговый поток с подтверждённым UID. Нажмите «Подключить аккаунт» в расширении и повторите действие.');
    }
    activeTradingSocket = socket;
    if (options.explicitManual === true) manualConnectionRequested = true;
    if (options.explicitManual === true && candidateIdentity) connectedAccountIdentity = candidateIdentity;
    clearLoginUpgradeArm();
    state.connection.requested = true;
    state.connection.connected = socket.readyState === SOCKET_OPEN;
    state.connection.connectedAt = nowIso();
    state.connection.disconnectedAt = null;
    state.connection.authCaptured = Boolean(meta.authRaw || meta.authPayload?.session);
    state.connection.reconnecting = false;
    state.connection.reconnectAttempts = 0;
    state.connection.lastError = null;
    reconnectAttempt = 0;
    state.socket.discovered = true;
    state.socket.authenticated = Boolean(meta.authPayload);
    state.socket.readyState = socket.readyState;
    state.socket.host = meta.host;
    state.socket.connectedAt = meta.openedAt || state.socket.connectedAt || nowIso();
    state.socket.authenticatedAt = meta.authenticatedAt || state.socket.authenticatedAt || nowIso();
    const auth = meta.authPayload;
    state.account.uid = findDeep(auth, ['uid', 'userId', 'user_id', 'id']) ?? null;
    state.account.isDemo = inferDemoMode(auth, meta.url);
    state.account.mode = state.account.isDemo == null ? '—' : state.account.isDemo ? 'DEMO' : 'REAL';
    state.account.platform = findDeep(auth, ['platform', 'platformId', 'platform_id']) ?? null;
    state.account.sessionCaptured = Boolean(findDeep(auth, ['session', 'token', 'authToken']) || meta.authRaw);
    if (meta.lastBalance != null) {
      state.account.balance = meta.lastBalance;
      state.account.balanceUpdatedAt = meta.lastBalanceAt || nowIso();
    }
    if (meta.lastCurrency) state.account.currency = normalizeCurrencyCode(meta.lastCurrency) || meta.lastCurrency;
    if (!connectedAccountIdentity && candidateIdentity && manualConnectionRequested) connectedAccountIdentity = candidateIdentity;
    return true;
  }

  function logicalDisconnect(reason = 'manual') {
    stopMultiAssetScanner();
    closeScannerSocket('logical_disconnect');
    manualConnectionRequested = false;
    connectedAccountIdentity = null;
    clearLoginUpgradeArm();
    desiredSubscriptionPlan = { active: false, assets: [], assetsByPeriod: {}, period: 60, periods: [60], historyOffset: INITIAL_HISTORY_CANDLES, historyOffsets: { 60: INITIAL_HISTORY_CANDLES } };
    subscriptionQueueToken += 1;
    reconnectAttempt = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    activeTradingSocket = null;
    activeMarketSocket = null;
    state.connection.requested = false;
    state.connection.connected = false;
    state.connection.reconnecting = false;
    state.connection.reconnectAttempts = 0;
    state.connection.disconnectedAt = nowIso();
    state.connection.lastError = reason;
    state.socket.authenticated = false;
    state.socket.readyState = null;
    state.socket.host = null;
    clearPublicAccount();
    resetPublicMarket();
  }

  function normalizeAsset(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.normalize('NFKC').replace(/\u00a0/g, ' ').trim();
    if (!trimmed || trimmed.length > 120) return null;
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
    return trimmed;
  }

  const GENERIC_ASSET_KEYS = new Set([
    'asset', 'assets', 'symbol', 'symbols', 'ticker', 'name', 'label', 'title',
    'type', 'category', 'payout', 'profit', 'percent', 'payment', 'active',
    'enabled', 'tradable', 'otc', 'isotc', 'id', '_id', 'data', 'result',
    'payload', 'items', 'list', 'timeframes', 'allowedcandles'
  ]);

  function assetKeyHint(value) {
    const candidate = normalizeAsset(value);
    if (!candidate) return null;
    const compactLower = candidate.toLowerCase().replace(/[\s_.:/#&+\-]/g, '');
    if (!compactLower || GENERIC_ASSET_KEYS.has(compactLower)) return null;
    if (/_otc$/i.test(candidate) || /\botc\b/i.test(candidate)) return candidate;
    const compact = candidate.replace(/[\s/_.:#&+\-]/g, '');
    if (/^[A-Z]{6}$/.test(compact)) return candidate;
    if (/^[A-Z]{2,}[0-9][A-Z0-9]*$/i.test(compact)) return candidate;
    if (/^(XAU|XAG|BTC|ETH|LTC|DOGE|SOL|XRP|ADA|BNB|BRENT|WTI|GOLD|SILVER)/i.test(compact)) return candidate;
    return null;
  }

  function parseNestedJson(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function findDeep(value, keys, depth = 0) {
    if (depth > 9 || value == null) return null;
    const parsed = parseNestedJson(value);
    if (parsed != null) return findDeep(parsed, keys, depth + 1);
    if (typeof value !== 'object') return null;

    for (const [key, item] of Object.entries(value)) {
      if (keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase()) && item != null) return item;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findDeep(item, keys, depth + 1);
        if (found != null) return found;
      }
      return null;
    }
    for (const item of Object.values(value)) {
      const found = findDeep(item, keys, depth + 1);
      if (found != null) return found;
    }
    return null;
  }


  function isJwtLike(value) {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || '').trim().replace(/^Bearer\s+/i, ''));
  }

  function normalizeAuthToken(value) {
    const text = String(value || '').trim().replace(/^Bearer\s+/i, '').trim();
    if (!text || text.length < 20) return '';
    if (/^\[REDACTED\]$/i.test(text)) return '';
    return text;
  }

  function collectAuthTokenCandidates(value, output = [], depth = 0, keyPath = '') {
    if (depth > 8 || value == null || output.length >= 20) return output;
    const parsed = parseNestedJson(value);
    if (parsed != null) return collectAuthTokenCandidates(parsed, output, depth + 1, keyPath);
    if (typeof value === 'string') {
      const token = normalizeAuthToken(value);
      if (token && (isJwtLike(token) || /token|jwt|session|auth|bearer|access/i.test(keyPath) || token.length > 80)) output.push(token);
      return output;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectAuthTokenCandidates(item, output, depth + 1, keyPath);
      return output;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (/password|cookie|secret|csrf/i.test(key)) continue;
        collectAuthTokenCandidates(item, output, depth + 1, `${keyPath}.${key}`);
      }
    }
    return output;
  }

  function uniqueAuthTokens(items = []) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const token = normalizeAuthToken(item);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
    return out.sort((a, b) => Number(isJwtLike(b)) - Number(isJwtLike(a)) || b.length - a.length).slice(0, 12);
  }

  function readStorageTokenCandidates() {
    const candidates = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        if (!storage) continue;
        for (let i = 0; i < storage.length && candidates.length < 20; i += 1) {
          const key = storage.key(i) || '';
          if (!/token|jwt|session|auth|access/i.test(key)) continue;
          candidates.push(...collectAuthTokenCandidates(storage.getItem(key), [], 0, key));
        }
      } catch {}
    }
    return candidates;
  }

  function emitOfficialAuthCandidate(authPayload, meta = null) {
    try {
      if (!authPayload || typeof authPayload !== 'object') return;
      const uid = findDeep(authPayload, ['uid', 'userId', 'user_id', 'id']);
      const tokens = uniqueAuthTokens([
        findDeep(authPayload, ['access_token', 'accessToken', 'clientJwtAccessToken', 'client_jwt_access_token', 'jwt', 'jwtToken', 'authToken', 'token', 'session']),
        ...collectAuthTokenCandidates(authPayload),
        ...readStorageTokenCandidates()
      ]);
      if (!uid || !tokens.length) return;
      window.postMessage({
        [MARKER]: 'PAGE_OFFICIAL_AUTH',
        auth: {
          uid: String(uid),
          accessToken: tokens[0],
          candidates: tokens,
          source: 'pocket_terminal_session',
          capturedAt: nowIso(),
          socketHost: meta?.host || null
        }
      }, '*');
    } catch (error) {
      addError(error, 'official-auth-capture');
    }
  }

  function collectNumericLeaves(value, output = [], depth = 0) {
    if (depth > 8 || value == null) return output;
    const parsed = parseNestedJson(value);
    if (parsed != null) return collectNumericLeaves(parsed, output, depth + 1);
    const direct = safeNumber(value);
    if (direct != null && typeof value !== 'boolean') {
      output.push(direct);
      return output;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectNumericLeaves(item, output, depth + 1);
    } else if (typeof value === 'object') {
      for (const item of Object.values(value)) collectNumericLeaves(item, output, depth + 1);
    }
    return output;
  }

  function redact(value, depth = 0) {
    if (depth > 6) return '[depth-limit]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.length > 500) return `${value.slice(0, 500)}…`;
      return value;
    }
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => redact(item, depth + 1));
    if (typeof value === 'object') {
      const result = {};
      for (const [key, item] of Object.entries(value).slice(0, 40)) {
        if (/session|ssid|token|cookie|password/i.test(key)) result[key] = '[REDACTED]';
        else result[key] = redact(item, depth + 1);
      }
      return result;
    }
    return String(value);
  }

  function subscriptionMapKey(asset, period) {
    return `${String(asset || '')}|${Math.max(1, Number(period) || 60)}`;
  }

  function findSubscription(asset, period = null) {
    const symbol = normalizeAsset(asset);
    if (!symbol) return null;
    const normalizedPeriod = period == null ? null : Math.max(1, Number(period) || 60);
    const primary = subscriptionData.get(symbol) || null;
    if (primary && (normalizedPeriod == null || Number(primary.period) === normalizedPeriod)) return primary;
    if (normalizedPeriod != null) return timeframeSubscriptionData.get(subscriptionMapKey(symbol, normalizedPeriod)) || null;
    return primary;
  }

  function marketSnapshot(asset, includeHistory = false, period = null) {
    const sub = findSubscription(asset, period);
    if (!sub) return null;
    const snapshot = {
      asset: sub.asset,
      period: sub.period,
      requested: sub.requested,
      subscribed: sub.subscribed,
      streamActive: sub.streamActive,
      requestedAt: sub.requestedAt,
      streamUpdatedAt: sub.streamUpdatedAt,
      lastPrice: sub.lastPrice,
      lastTickTime: sub.lastTickTime,
      tickCount: sub.tickCount,
      historyCount: sub.historyCount,
      historyReceivedAt: sub.historyReceivedAt,
      currentCandle: sub.currentCandle,
      recentTicks: sub.recentTicks.slice(-12),
      recentCandles: sub.recentCandles.slice(-20)
    };
    if (includeHistory) snapshot.historyItems = sub.historyItems.slice(-MAX_HISTORY_ITEMS);
    return snapshot;
  }

  function emitMarketSnapshot(asset, immediate = false, includeHistory = false, period = null) {
    const sub = findSubscription(asset, period);
    if (!asset || !sub) return;
    const key = subscriptionMapKey(asset, sub.period);
    const send = (withHistory = includeHistory) => {
      marketSnapshotTimers.delete(key);
      marketSnapshotLastSentAt.set(key, Date.now());
      const snapshot = marketSnapshot(asset, withHistory, sub.period);
      if (snapshot) window.postMessage({ [MARKER]: 'PAGE_MARKET_DATA', asset, period: sub.period, snapshot }, '*');
    };
    const previous = Number(marketSnapshotLastSentAt.get(key) || 0);
    if (immediate || includeHistory || Date.now() - previous >= 1000) {
      const timer = marketSnapshotTimers.get(key);
      if (timer) clearTimeout(timer);
      send(includeHistory);
      return;
    }
    if (marketSnapshotTimers.has(key)) return;
    marketSnapshotTimers.set(key, setTimeout(() => send(false), Math.max(120, 1000 - (Date.now() - previous))));
  }

  function historyCacheFresh(sub, period) {
    if (!sub || Number(sub.historyCount || 0) < 60) return false;
    const last = sub.historyItems?.[sub.historyItems.length - 1];
    const timestamp = Number(last?.time || 0);
    if (!timestamp) return false;
    const age = brokerNowSeconds() - timestamp;
    return age >= -Math.max(120, period * 2) && age <= Math.max(300, period * 3);
  }

  function seedCachedHistory(cache, requested, period) {
    const seeded = new Set();
    if (!cache || typeof cache !== 'object') return seeded;
    for (const asset of requested) {
      const record = cache[asset];
      if (!record || Number(record.period) !== Number(period) || !Array.isArray(record.historyItems)) continue;
      const sub = getSubscription(asset, period);
      const items = record.historyItems.slice(-MAX_HISTORY_ITEMS).map((item) => ({
        asset,
        period,
        time: normalizeTimestamp(item?.time),
        open: safeNumber(item?.open),
        high: safeNumber(item?.high),
        low: safeNumber(item?.low),
        close: safeNumber(item?.close),
        volume: safeNumber(item?.volume) ?? undefined,
        source: 'extension-cache'
      })).filter((item) => item.time && item.open != null && item.high != null && item.low != null && item.close != null);
      if (items.length < 60) continue;
      mergeHistoryItems(sub, items);
      if (historyCacheFresh(sub, period)) seeded.add(asset);
      emitMarketSnapshot(asset, true, true);
    }
    return seeded;
  }

  function publicState() {
    pruneExpiredOpenDeals();
    state.timestamp = nowIso();
    state.revision = ++revision;
    state.page.url = location.href;
    state.page.title = document.title || '';
    state.page.readyState = document.readyState;
    state.page.visibility = document.visibilityState;
    state.socket.totalObserved = sockets.size;
    state.socket.readyState = activeTradingSocket?.readyState ?? null;

    // Detect an authenticated Pocket account passively, but never promote it into
    // state.account or manualConnectionRequested. Guest /try-demo sockets have no
    // concrete UID and are therefore excluded by chooseTradingSocket().
    const observedLoginSocket = chooseTradingSocket();
    const observedLoginIdentity = socketAccountIdentity(observedLoginSocket);
    state.login = {
      authenticated: Boolean(observedLoginSocket && isSocketHealthy(observedLoginSocket, 120000) && observedLoginIdentity?.uid),
      uid: observedLoginIdentity?.uid || null,
      mode: observedLoginIdentity?.mode || null,
      isDemo: observedLoginIdentity?.isDemo ?? null,
      observedAt: observedLoginIdentity?.uid ? nowIso() : null
    };

    if (manualConnectionRequested) {
      if (isPocketTabBackgrounded() && hasFrozenAccountContext()) {
        freezeConnectionForBackground('public_state_background');
      } else if (activeTradingSocket) {
        const meta = socketMeta.get(activeTradingSocket);
        const connected = isSocketHealthy(activeTradingSocket);
        state.connection.connected = connected;
        state.socket.authenticated = connected;
        state.connection.backgroundPaused = false;
        state.connection.backgroundReason = null;
        if (!connected) {
          state.connection.reconnecting = true;
          state.connection.lastError = 'Переподключение к торговому потоку…';
          scheduleSocketRecovery(true);
        }
      } else {
        state.connection.connected = false;
        state.socket.authenticated = false;
        state.connection.reconnecting = true;
        state.connection.backgroundPaused = false;
        state.connection.backgroundReason = null;
        scheduleSocketRecovery(true);
      }
    }
    state.trades.pendingCount = pendingTrades.size;
    state.diagnostics.socketCandidates = [...sockets].map((socket) => {
      const meta = socketMeta.get(socket) || {};
      return {
        host: meta.host || null,
        readyState: socket.readyState,
        tradingHost: Boolean(meta.tradingHost),
        tradingDetected: Boolean(meta.trading),
        authCaptured: Boolean(meta.authPayload),
        authConfirmed: Boolean(meta.authConfirmed),
        accountAuth: Boolean(meta.accountAuth),
        accountIdentityPresent: authPayloadUid(meta.authPayload) != null,
        accountCapable: socketHasAccountCapability(meta),
        guestTryDemo: Boolean(isGuestTryDemoContext() && !socketHasAccountCapability(meta)),
        marketAuth: Boolean(meta.marketAuth),
        score: meta.score || 0,
        selected: socket === activeTradingSocket,
        internalScanner: Boolean(meta.internalScanner)
      };
    });
    state.market.assetsCount = assets.size;
    if (cachedPublicAssetListRevision !== assetCatalogRevision) {
      cachedPublicAssetList = [...assets.entries()]
        .map(([symbol, info]) => ({
          symbol,
          name: info?.name || symbol,
          payout: info?.payout ?? null,
          payoutSource: info?.payoutSource || null,
          payoutUpdatedAt: info?.payoutUpdatedAt || null,
          active: info?.active ?? null,
          availabilityUpdatedAt: info?.availabilityUpdatedAt || null,
          lastSeenAt: info?.lastSeenAt || null,
          isOtc: Boolean(info?.isOtc),
          type: info?.type || null,
          category: normalizeAssetType(info?.type, symbol, info?.name) || info?.category,
          allowedCandles: Array.isArray(info?.allowedCandles) ? info.allowedCandles : []
        }))
        .sort((a, b) => {
          if (a.active === false && b.active !== false) return 1;
          if (a.active !== false && b.active === false) return -1;
          const categoryCompare = a.category.localeCompare(b.category, 'ru');
          return categoryCompare || a.symbol.localeCompare(b.symbol);
        })
        .slice(0, MAX_ASSETS);
      cachedPublicAssetListRevision = assetCatalogRevision;
    }
    state.market.assetList = cachedPublicAssetList;
    state.market.selectedAssets = [...subscriptionData.keys()];
    state.market.subscriptionCount = state.market.selectedAssets.length;
    const subscriptionValues = [...subscriptionData.values()];
    state.market.liveStreamCount = subscriptionValues.filter((item) => item.streamActive && item.tickCount > 0).length;
    state.market.historyFreshCount = subscriptionValues.filter((item) => {
      const received = Date.parse(item.historyReceivedAt || '');
      return Number.isFinite(received) && Date.now() - received <= 120000;
    }).length;
    state.market.historyPendingCount = historyRequests.size + historyTaskQueue.length;
    state.market.historyQueuedCount = historyTaskQueue.length;
    state.market.historyMaxInFlight = MAX_HISTORY_IN_FLIGHT;
    state.market.scannerActive = Boolean(multiAssetScanTimer && desiredSubscriptionPlan.active && manualConnectionRequested);
    state.market.scanCursor = multiAssetScanCursor;
    state.market.scanCycle = multiAssetScanCycle;
    state.market.scanRequests = multiAssetScanRequests;
    state.market.scanResponses = multiAssetScanResponses;
    state.market.lastScanAsset = lastMultiAssetScanAsset;
    state.market.brokerClockOffsetSec = brokerClockOffsetSec;
    state.market.brokerClockObservedAt = brokerClockObservedAt;
    state.market.brokerClockRawOffsetSec = brokerClockRawOffsetSec;
    state.market.brokerClockSource = brokerClockSource;
    state.market.brokerClockSampleCount = brokerClockSamples.length;
    state.market.subscriptions = Object.fromEntries([...subscriptionData.entries()].map(([symbol, item]) => [symbol, {
      asset: item.asset,
      period: item.period,
      requested: item.requested,
      subscribed: item.subscribed,
      streamActive: item.streamActive,
      requestedAt: item.requestedAt,
      streamUpdatedAt: item.streamUpdatedAt,
      lastPrice: item.lastPrice,
      lastTickTime: item.lastTickTime,
      tickCount: item.tickCount,
      historyCount: item.historyCount,
      historyReceivedAt: item.historyReceivedAt,
      payout: item.payout ?? null,
      payoutSource: item.payoutSource || null,
      payoutUpdatedAt: item.payoutUpdatedAt || null,
      percentProfit: item.percentProfit ?? null,
      profitPercent: item.profitPercent ?? null,
      allowedCandles: Array.isArray(item.allowedCandles) ? item.allowedCandles : [],
      currentCandle: item.currentCandle,
      recentTicks: item.recentTicks.slice(-5),
      recentCandles: item.recentCandles.slice(-3),
      historyItems: []
    }]));
    state.market.timeframeSubscriptions = Object.fromEntries([...timeframeSubscriptionData.entries()].map(([key, item]) => [key, {
      asset: item.asset,
      period: item.period,
      requested: item.requested,
      subscribed: item.subscribed,
      streamActive: item.streamActive,
      requestedAt: item.requestedAt,
      streamUpdatedAt: item.streamUpdatedAt,
      lastPrice: item.lastPrice,
      lastTickTime: item.lastTickTime,
      tickCount: item.tickCount,
      historyCount: item.historyCount,
      historyReceivedAt: item.historyReceivedAt,
      payout: item.payout ?? null,
      currentCandle: item.currentCandle,
      recentTicks: item.recentTicks.slice(-3),
      recentCandles: item.recentCandles.slice(-2),
      historyItems: []
    }]));
    state.market.timeframeSubscriptionCount = timeframeSubscriptionData.size;
    state.market.historyTotal = [...subscriptionData.values(), ...timeframeSubscriptionData.values()].reduce((sum, item) => sum + Number(item.historyCount || 0), 0);
    if (state.market.asset && assets.has(state.market.asset)) state.market.payout = assets.get(state.market.asset)?.payout ?? state.market.payout;
    syncPrimaryMarket();
    const output = JSON.parse(JSON.stringify(state));
    output.market.recentTicks = Array.isArray(output.market.recentTicks) ? output.market.recentTicks.slice(-5) : [];
    output.market.recentCandles = Array.isArray(output.market.recentCandles) ? output.market.recentCandles.slice(-3) : [];
    output.market.historyItems = [];
    return output;
  }

  function emitState(immediate = false) {
    if (immediate) {
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = null;
      window.postMessage({ [MARKER]: 'PAGE_STATE', state: publicState() }, '*');
      return;
    }
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      window.postMessage({ [MARKER]: 'PAGE_STATE', state: publicState() }, '*');
    }, 250);
  }

  function addError(error, context = null) {
    state.diagnostics.errors.push({ time: nowIso(), context, message: String(error?.message || error) });
    clampArray(state.diagnostics.errors, 30);
    emitState();
  }

  function summarizePayload(event, payload) {
    if (payload == null) return null;
    if (typeof payload !== 'object') return String(payload).slice(0, 160);
    if (event === 'auth') {
      return {
        uid: payload.uid ?? null,
        isDemo: payload.isDemo ?? null,
        platform: payload.platform ?? null,
        sessionPresent: Boolean(payload.session)
      };
    }
    const summary = {};
    const keys = [
      'asset', 'symbol', 'amount', 'action', 'command', 'time', 'period', 'requestId', 'request_id',
      'id', 'uid', 'balance', 'currency', 'price', 'open', 'high', 'low', 'close', 'error', 'message'
    ];
    for (const key of keys) {
      const found = findDeep(payload, [key]);
      if (found != null && typeof found !== 'object') summary[key] = found;
    }
    if (Array.isArray(payload)) summary.items = payload.length;
    if (!Object.keys(summary).length) summary.type = Array.isArray(payload) ? 'array' : 'object';
    return summary;
  }

  function rememberRawSample(event, payload) {
    if (!['successupdateBalance', 'updateStream', 'chafor', 'updateHistoryNewFast', 'successopenOrder', 'failopenOrder', 'updateAssets'].includes(event)) return;
    // chafor is very frequent; keep one raw example for diagnostics without flooding the log.
    if (event === 'chafor' && state.diagnostics.rawSamples.some((sample) => sample.event === 'chafor')) return;
    if (event === 'updateStream' || event === 'updateHistoryNewFast') {
      const now = Date.now();
      const lastStoredAt = Number(diagnosticRawSampleLastStoredAt.get(event) || 0);
      if (now - lastStoredAt < DIAGNOSTIC_RAW_SAMPLE_INTERVAL_MS) return;
      diagnosticRawSampleLastStoredAt.set(event, now);
    }
    state.diagnostics.rawSamples.push({ time: nowIso(), event, payload: redact(payload) });
    clampArray(state.diagnostics.rawSamples, MAX_RAW_SAMPLES);
  }

  function recordEvent(direction, event, payload, socket) {
    const eventName = event || 'raw';
    state.diagnostics.eventCounts[eventName] = (state.diagnostics.eventCounts[eventName] || 0) + 1;
    const now = Date.now();
    const hotEvent = /updateStream|updateHistory|history|loadHistoryPeriod/i.test(eventName);
    const lastHotStoredAt = Number(diagnosticRecentEventLastStoredAt.get(eventName) || 0);
    const shouldStoreRecent = eventName === 'chafor'
      ? now - lastChaforDiagnosticAt >= DIAGNOSTIC_HOT_EVENT_INTERVAL_MS
      : !hotEvent || now - lastHotStoredAt >= DIAGNOSTIC_HOT_EVENT_INTERVAL_MS;
    const tradeEvent = /openOrder|openedDeals|closedDeals|closeOrder/i.test(eventName);
    let entry = null;
    if (shouldStoreRecent || tradeEvent) {
      entry = {
        time: nowIso(),
        direction,
        event: eventName,
        socket: socketMeta.get(socket)?.host || null,
        summary: summarizePayload(eventName, payload)
      };
    }
    if (shouldStoreRecent) {
      if (eventName === 'chafor') lastChaforDiagnosticAt = now;
      if (hotEvent) diagnosticRecentEventLastStoredAt.set(eventName, now);
      state.diagnostics.recentEvents.push(entry);
      clampArray(state.diagnostics.recentEvents, MAX_EVENTS);
    }
    if (tradeEvent) {
      state.diagnostics.recentTradeEvents.push(entry);
      clampArray(state.diagnostics.recentTradeEvents, MAX_TRADE_EVENTS);
      state.diagnostics.tradeSamples.push({ ...entry, payload: redact(payload) });
      clampArray(state.diagnostics.tradeSamples, MAX_TRADE_SAMPLES);
    }
    if (direction === 'in') rememberRawSample(eventName, payload);
  }

  function countAttachmentPlaceholders(value, depth = 0) {
    if (depth > 12 || value == null) return 0;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + countAttachmentPlaceholders(item, depth + 1), 0);
    if (typeof value === 'object') {
      if (value._placeholder === true && Number.isInteger(Number(value.num))) return 1;
      return Object.values(value).reduce((sum, item) => sum + countAttachmentPlaceholders(item, depth + 1), 0);
    }
    return 0;
  }

  function replaceAttachmentPlaceholders(value, attachments, depth = 0) {
    if (depth > 12 || value == null) return value;
    if (Array.isArray(value)) return value.map((item) => replaceAttachmentPlaceholders(item, attachments, depth + 1));
    if (typeof value === 'object') {
      if (value._placeholder === true) {
        const index = Number(value.num);
        return Number.isInteger(index) && index >= 0 && index < attachments.length ? attachments[index] : value;
      }
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = replaceAttachmentPlaceholders(item, attachments, depth + 1);
      return output;
    }
    return value;
  }

  function parseSocketIoFrame(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('[');
    if (start < 0) return null;
    try {
      const prefix = text.slice(0, start);
      const parsed = JSON.parse(text.slice(start));
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return null;
      const match = prefix.match(/^45(\d+)-/);
      const attachmentCount = match ? Number(match[1]) : countAttachmentPlaceholders(parsed);
      return { event: parsed[0], payload: parsed[1], packet: parsed, attachmentCount };
    } catch {
      return null;
    }
  }

  function extractBalance(payload) {
    const named = findDeep(payload, [
      'balance', 'currentBalance', 'accountBalance', 'funds', 'amount',
      'money', 'cash', 'value', 'demoBalance', 'realBalance'
    ]);
    const namedNumber = safeNumber(named);
    if (namedNumber != null && namedNumber >= 0) return namedNumber;

    const direct = safeNumber(payload);
    if (direct != null && direct >= 0) return direct;

    const uid = safeNumber(state.account.uid);
    const numbers = collectNumericLeaves(payload)
      .filter((number) => number >= 0 && number < 1e12)
      .filter((number) => uid == null || number !== uid);
    if (!numbers.length) return null;

    // В ответах брокера рядом с балансом могут идти UID, timestamp и служебные флаги.
    // Приоритет: число с дробной частью, затем правдоподобная денежная сумма,
    // затем последнее число (баланс часто находится в конце массива/объекта).
    const decimal = numbers.find((number) => !Number.isInteger(number));
    if (decimal != null) return decimal;
    const plausibleMoney = [...numbers].reverse().find((number) => number <= 100000000 && !isTimestampLike(number));
    if (plausibleMoney != null) return plausibleMoney;
    return numbers[numbers.length - 1];
  }

  const KNOWN_CURRENCY_CODES = new Set([
    'USD','EUR','RUB','GBP','JPY','CHF','CAD','AUD','NZD','CNY','HKD','SGD',
    'NOK','SEK','DKK','PLN','TRY','ZAR','MXN','BRL','INR','KZT','UAH','AED',
    'SAR','QAR','KWD','BHD','OMR','THB','IDR','MYR','PHP','KRW','TWD','CZK',
    'HUF','RON','ILS','ARS','CLP','COP','PEN','VND','BDT','DZD','EGP','PKR',
    'YER','LBP','TND','MAD','JOD','NGN','KES','GEL','AMD','AZN','BYN','UZS',
    'USDT','USDC','DAI'
  ]);

  function normalizeCurrencyCode(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const compact = raw.replace(/\s+/g, '');
    const upper = compact.toUpperCase();
    // Longer/more specific symbols must precede '$' for embedded strings.
    const symbolMap = new Map([
      ['R$', 'BRL'], ['US$', 'USD'], ['USD$', 'USD'],
      ['$', 'USD'], ['€', 'EUR'], ['EUR€', 'EUR'],
      ['₽', 'RUB'], ['РУБ', 'RUB'], ['РУБ.', 'RUB'],
      ['£', 'GBP'], ['¥', 'JPY'], ['￥', 'JPY'],
      ['₸', 'KZT'], ['₹', 'INR'], ['₴', 'UAH']
    ]);
    if (symbolMap.has(upper)) return symbolMap.get(upper);
    if (KNOWN_CURRENCY_CODES.has(upper)) return upper;
    const code = upper.match(/(?:^|[^A-Z])([A-Z]{3,5})(?:$|[^A-Z])/i)?.[1]?.toUpperCase();
    if (code && KNOWN_CURRENCY_CODES.has(code)) return code;
    for (const [symbol, mapped] of symbolMap.entries()) {
      if (symbol && compact.includes(symbol)) return mapped;
    }
    return null;
  }

  function extractCurrency(payload) {
    const value = findDeep(payload, [
      'currency', 'currencyCode', 'currency_code', 'currencyName',
      'currencySymbol', 'currency_symbol', 'accountCurrency', 'account_currency'
    ]);
    const direct = normalizeCurrencyCode(value);
    if (direct) return direct;
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (typeof item !== 'string') continue;
        const candidate = normalizeCurrencyCode(item);
        if (candidate) return candidate;
      }
    }
    return null;
  }

  function eventCanCarryAccountCurrency(event) {
    const name = String(event || '').trim().toLowerCase();
    if (!name) return false;
    return /auth|balance|deal|order|user[_/-]?(?:init|ready)|account|wallet|cash/.test(name);
  }

  function normalizeAssetType(value, symbol = '', name = '') {
    const raw = String(value ?? '').toLowerCase();
    const fiatType = /^(currency|currencies|forex)$/.test(raw.trim());
    const fullText = `${symbol || ''} ${name || ''}`.toUpperCase();
    const code = String(symbol || '').replace(/_otc$/i, '').replace(/[^A-Z0-9]/g, '').toUpperCase();
    const isOtc = /_otc$/i.test(String(symbol || '')) || /\bOTC\b/i.test(String(name || ''));
    const knownCurrencies = new Set(['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD','CNY','HKD','SGD','NOK','SEK','DKK','PLN','TRY','ZAR','MXN','BRL','INR','COP','CLP','ARS','PEN','AED','SAR','QAR','KWD','BHD','OMR','THB','IDR','MYR','PHP','KRW','TWD','CZK','HUF','RON','ILS']);
    const cryptoCodes = new Set(['BTC','ETH','LTC','DOGE','SOL','XRP','ADA','BNB','DOT','AVAX','TRX','TON','BCH','DASH','MATIC','POL','LINK','LNK','ETC','XLM','ATOM','UNI','AAVE','FIL','NEAR','APT','ARB','OP','SHIB','USDT','USDC','DAI']);
    const cryptoQuoteCodes = new Set([...knownCurrencies, 'USDT', 'USDC', 'DAI', 'BTC', 'ETH']);
    const symbolTokens = String(symbol || '').replace(/_otc$/i, '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    const cryptoCodeMatch = cryptoCodes.has(code) || symbolTokens.some((token) => cryptoCodes.has(token)) || [...cryptoCodes].some((crypto) =>
      (code.startsWith(crypto) && cryptoQuoteCodes.has(code.slice(crypto.length))) ||
      (code.endsWith(crypto) && cryptoQuoteCodes.has(code.slice(0, -crypto.length)))
    );
    const forexPair = code.length === 6 && knownCurrencies.has(code.slice(0, 3)) && knownCurrencies.has(code.slice(3, 6));
    const metal = /(XAU|XAG|GOLD|SILVER|PLATIN|PALLAD)/.test(fullText);
    if (metal) return 'Металлы';
    if (forexPair || (fiatType && code.length === 6)) return isOtc ? 'Валютные OTC' : 'Валюты';
    if (/crypt|coin|token|digital/.test(raw) || cryptoCodeMatch) return 'Криптовалюты';
    if (/stock|share|equity/.test(raw)) return 'Акции';
    if (/commod|energy|agric/.test(raw) || /(OIL|BRENT|WTI|GAS|CORN|WHEAT|COFFEE|SUGAR|COTTON)/.test(fullText)) return 'Сырьё';
    if (/index/.test(raw) || /(NASDAQ|SP500|S&P|DOW|DJI|DAX|FTSE|NIKKEI|CAC|IBEX|AEX|SMI|HSI|US100|AUS200)/.test(fullText)) return 'Индексы';
    if (fiatType) return 'Прочие';
    if (isOtc) return 'Прочие OTC';
    return 'Прочие';
  }

  function getSubscription(asset, period = state.market.period) {
    const symbol = normalizeAsset(asset);
    if (!symbol) return null;
    if (assets.get(symbol)?.active === false) return null;
    const normalizedPeriod = Math.max(1, Number(period) || 60);
    const primaryPeriod = desiredSubscriptionPlan.active
      ? Math.max(1, Number(desiredSubscriptionPlan.period) || normalizedPeriod)
      : Math.max(1, Number(state.market.period) || normalizedPeriod);
    // Keep auxiliary HISTORY/tester requests isolated by timeframe even when the
    // regular market subscription is inactive. Reusing one primary asset record
    // for every requested period overwrote tester history and mixed candle sets.
    const usePrimaryStore = normalizedPeriod === primaryPeriod;
    const store = usePrimaryStore ? subscriptionData : timeframeSubscriptionData;
    const key = usePrimaryStore ? symbol : subscriptionMapKey(symbol, normalizedPeriod);
    let item = store.get(key);
    if (!item) {
      item = {
        asset: symbol,
        period: normalizedPeriod,
        requested: false,
        subscribed: false,
        streamActive: false,
        requestedAt: null,
        lastSubscribeSentAt: null,
        lastResubscribeAt: null,
        resubscribeAttempts: 0,
        streamUpdatedAt: null,
        lastPrice: null,
        lastTickTime: null,
        tickCount: 0,
        historyCount: 0,
        historyReceivedAt: null,
        currentCandle: null,
        recentTicks: [],
        recentCandles: [],
        historyItems: []
      };
      store.set(key, item);
    }
    item.period = normalizedPeriod;
    return item;
  }

  function purgeUnavailableRuntimeAssets(rawSymbols, reason = 'broker_unavailable') {
    const blocked = new Set(
      (Array.isArray(rawSymbols) ? rawSymbols : [...(rawSymbols || [])])
        .map(normalizeAsset)
        .filter(Boolean)
    );
    if (!blocked.size) return 0;

    const beforePlan = desiredSubscriptionPlan.assets.length;
    desiredSubscriptionPlan = {
      ...desiredSubscriptionPlan,
      assets: desiredSubscriptionPlan.assets.filter((asset) => !blocked.has(asset)),
      assetsByPeriod: Object.fromEntries(
        Object.entries(desiredSubscriptionPlan.assetsByPeriod || {}).map(([period, scopedAssets]) => [
          period,
          (Array.isArray(scopedAssets) ? scopedAssets : []).filter((asset) => !blocked.has(asset))
        ])
      )
    };
    if (!desiredSubscriptionPlan.assets.length) desiredSubscriptionPlan.active = false;

    for (let index = historyTaskQueue.length - 1; index >= 0; index -= 1) {
      if (blocked.has(historyTaskQueue[index]?.asset)) historyTaskQueue.splice(index, 1);
    }
    let removedInFlight = false;
    for (const [index, request] of historyRequests) {
      if (!blocked.has(request?.asset)) continue;
      historyRequests.delete(index);
      removedInFlight = true;
    }
    if (removedInFlight) {
      // A late unlabelled broker response from a removed pair must not be attached
      // to the next history request in the serial scanner queue.
      historyQueueBlockedUntil = Math.max(historyQueueBlockedUntil, Date.now() + HISTORY_LATE_RESPONSE_GUARD_MS);
    }

    for (const symbol of blocked) {
      subscriptionData.delete(symbol);
      for (const key of [...timeframeSubscriptionData.keys()]) {
        if (String(key).startsWith(`${symbol}|`)) timeframeSubscriptionData.delete(key);
      }
      const timer = marketSnapshotTimers.get(symbol);
      if (timer) clearTimeout(timer);
      marketSnapshotTimers.delete(symbol);
      marketSnapshotLastSentAt.delete(symbol);
      for (const key of [...candleBuilders.keys()]) {
        if (String(key).startsWith(`${symbol}|`)) candleBuilders.delete(key);
      }
    }

    state.market.selectedAssets = [...subscriptionData.keys()].filter((asset) => !blocked.has(asset));
    if (blocked.has(state.market.asset)) {
      state.market.asset = desiredSubscriptionPlan.assets[0] || state.market.selectedAssets[0] || null;
      if (state.market.asset) syncPrimaryMarket(state.market.asset);
      else {
        state.market.subscribed = false;
        state.market.streamActive = false;
        state.market.currentCandle = null;
        state.market.recentTicks = [];
        state.market.recentCandles = [];
        state.market.historyItems = [];
        state.market.historyCount = 0;
      }
    }

    if (desiredSubscriptionPlan.active && desiredSubscriptionPlan.assets.length) {
      scheduleMultiAssetScanner(250);
      scheduleHistoryQueue(Math.max(10, historyQueueBlockedUntil - Date.now()));
    } else {
      stopMultiAssetScanner();
      clearHistoryQueue();
    }
    recordEvent('internal', 'unavailable_assets_purged', {
      reason,
      assets: [...blocked].slice(0, 100),
      removedFromPlan: Math.max(0, beforePlan - desiredSubscriptionPlan.assets.length)
    }, null);
    emitState(true);
    return blocked.size;
  }

  function syncPrimaryMarket(asset = state.market.asset) {
    const item = asset ? subscriptionData.get(asset) : null;
    if (!item) return;
    state.market.asset = item.asset;
    state.market.period = item.period;
    state.market.subscribed = item.subscribed;
    state.market.streamActive = item.streamActive;
    state.market.subscriptionRequested = item.requested;
    state.market.subscriptionSentAt = item.requestedAt;
    state.market.lastPrice = item.lastPrice;
    state.market.lastTickTime = item.lastTickTime;
    state.market.tickCount = item.tickCount;
    state.market.currentCandle = item.currentCandle;
    state.market.recentTicks = item.recentTicks;
    state.market.recentCandles = item.recentCandles;
    state.market.historyItems = item.historyItems;
    state.market.historyCount = item.historyCount;
    state.market.historyReceivedAt = item.historyReceivedAt;
    state.market.streamUpdatedAt = item.streamUpdatedAt;
    state.market.payout = item.payout ?? null;
    state.market.payoutSource = item.payoutSource || null;
    state.market.payoutUpdatedAt = item.payoutUpdatedAt || null;
    state.market.percentProfit = item.percentProfit ?? null;
    state.market.profitPercent = item.profitPercent ?? null;
    state.market.allowedCandles = Array.isArray(item.allowedCandles) ? item.allowedCandles : [];
  }

  function normalizeAllowedCandles(raw) {
    const values = [];
    const push = (value) => {
      const time = Math.round(Number(value?.time ?? value?.period ?? value?.duration ?? value?.value ?? value));
      if (Number.isFinite(time) && time > 0 && time <= 86400) values.push(time);
    };
    if (Array.isArray(raw)) raw.forEach(push);
    else if (raw && typeof raw === 'object') Object.values(raw).forEach(push);
    else if (raw != null) String(raw).split(/[;,|\s]+/).filter(Boolean).forEach(push);
    return [...new Set(values)].sort((a, b) => a - b);
  }

  function isFreshPayoutTime(updatedAt, maxAgeMs = 20 * 1000) {
    const ms = Date.parse(updatedAt || '');
    return Number.isFinite(ms) && Date.now() - ms >= 0 && Date.now() - ms <= maxAgeMs;
  }

  function brokerAllowedExpirationsForAsset(asset) {
    const symbol = validateAsset(asset);
    if (!symbol) return [];
    const info = assets.get(symbol) || null;
    const sub = subscriptionData.get(symbol) || null;
    const fromInfo = normalizeAllowedCandles(info?.allowedCandles || info?.allowed_candles || info?.timeframes);
    if (fromInfo.length) return fromInfo;
    const fromSub = normalizeAllowedCandles(sub?.allowedCandles || sub?.allowed_candles || sub?.timeframes);
    if (fromSub.length) return fromSub;
    return [];
  }

  function finitePositiveSeconds(value) {
    const num = safeNumber(value);
    if (num == null || num <= 0 || num > 86400) return null;
    return Math.round(num);
  }

  function brokerExpirationBoundsForAsset(asset) {
    const symbol = validateAsset(asset);
    if (!symbol) return { min: null, max: null, source: null };
    const info = assets.get(symbol) || null;
    const sub = subscriptionData.get(symbol) || null;
    const pick = (obj, keys) => {
      if (!obj || typeof obj !== 'object') return null;
      for (const key of keys) {
        const value = finitePositiveSeconds(obj[key]);
        if (value != null) return value;
      }
      return null;
    };
    const minKeys = ['min_timeframe', 'minTimeframe', 'min_time', 'minTime', 'minDuration', 'min_duration', 'minExpiration', 'min_expiration'];
    const maxKeys = ['max_timeframe', 'maxTimeframe', 'max_time', 'maxTime', 'maxDuration', 'max_duration', 'maxExpiration', 'max_expiration'];
    const infoMin = pick(info, minKeys);
    const infoMax = pick(info, maxKeys);
    if (infoMin != null || infoMax != null) return { min: infoMin, max: infoMax, source: info?.source || info?.expirationSource || 'asset_list' };
    const subMin = pick(sub, minKeys);
    const subMax = pick(sub, maxKeys);
    if (subMin != null || subMax != null) return { min: subMin, max: subMax, source: sub?.source || sub?.expirationSource || 'subscription' };
    return { min: null, max: null, source: null };
  }

  function executionExpirationSupport(asset, duration) {
    const symbol = validateAsset(asset);
    const seconds = Math.round(Number(duration) || 0);
    if (!symbol || seconds <= 0) return { supported: false, reason: 'invalid_asset_or_duration', allowed: [], bounds: { min: null, max: null } };

    const bounds = brokerExpirationBoundsForAsset(symbol);
    const allowed = brokerAllowedExpirationsForAsset(symbol);
    const info = assets.get(symbol) || null;
    const sub = subscriptionData.get(symbol) || null;
    const isOtc = /_otc$/i.test(symbol) || info?.isOtc === true || sub?.isOtc === true;
    const hasTurboOnlyMax = bounds.max != null && bounds.max < 60;

    if (bounds.min != null && seconds < bounds.min) {
      return { supported: false, reason: `ниже брокерского минимума ${bounds.min} сек`, allowed, bounds };
    }

    if (allowed.includes(seconds)) return { supported: true, reason: 'confirmed_by_allowed_list', allowed, bounds };

    if (bounds.max != null && seconds > bounds.max) {
      if (!hasTurboOnlyMax || (seconds < 60 && !isOtc)) {
        return { supported: false, reason: `выше брокерского максимума ${bounds.max} сек`, allowed, bounds };
      }
    }

    if (bounds.min != null || (bounds.max != null && !hasTurboOnlyMax)) {
      return { supported: true, reason: 'confirmed_by_min_max_timeframe', allowed, bounds };
    }

    // allowedCandles can be a chart-period list. Without a real long max, allow
    // 60s+ for all assets and sub-minute only for OTC; never rewrite 3/5/15s
    // to 60s. Pocket receives the exact requested duration in openOrder.
    if (seconds >= 60) return { supported: true, reason: hasTurboOnlyMax ? 'standard_duration_fallback_turbo_max_ignored' : 'standard_duration_fallback', allowed, bounds };
    return { supported: Boolean(isOtc), reason: isOtc ? 'otc_turbo_fallback_turbo_max_ignored' : 'turbo_requires_broker_min_timeframe', allowed, bounds };
  }

  function executionExpirationSupported(asset, duration) {
    return executionExpirationSupport(asset, duration).supported;
  }

  function normalizeAssetAvailability(value) {
    if (value == null || value === '') return null;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'open', 'active', 'enabled', 'tradable', 'available'].includes(text)) return true;
    if (['0', 'false', 'no', 'off', 'closed', 'inactive', 'disabled', 'untradable', 'unavailable', 'blocked'].includes(text)) return false;
    return null;
  }

  function detectAssetInfo(payload) {
    const seen = new Set();

    function add(symbolValue, payoutValue, activeValue, nameValue = null, typeValue = null, isOtcValue = null, allowedCandles = null, minTimeframeValue = null, maxTimeframeValue = null) {
      const symbol = normalizeAsset(symbolValue);
      if (!symbol || seen.has(symbol)) return;
      let payout = safeNumber(payoutValue);
      if (payout != null && payout > 0 && payout <= 1) payout *= 100;
      if (payout != null && (payout < 0 || payout > 500)) payout = null;
      const existing = assets.get(symbol) || {};
      const normalizedAllowedCandles = normalizeAllowedCandles(allowedCandles);
      // Asset-list payout is documented by Pocket as the current payout. Do not
      // merge it with chafor by max/highest value: chafor packets can contain
      // max/flag/other payout-like numbers and may let low real payouts pass.
      const incomingAssetInfoPayout = payout;
      const isOtc = isOtcValue != null ? Boolean(Number(isOtcValue) === 1 || isOtcValue === true) : /_otc$/i.test(symbol);
      const otcBase = symbol.replace(/_otc$/i, '').toUpperCase();
      const category = normalizeAssetType(typeValue, symbol, nameValue);
      const minTimeframe = finitePositiveSeconds(minTimeframeValue) ?? existing.min_timeframe ?? existing.minTimeframe ?? null;
      const maxTimeframe = finitePositiveSeconds(maxTimeframeValue) ?? existing.max_timeframe ?? existing.maxTimeframe ?? null;
      const normalizedActive = normalizeAssetAvailability(activeValue);
      const inferredReappearance = normalizedActive == null && existing.availabilitySource === 'catalog_missing';
      const effectiveActive = normalizedActive ?? (inferredReappearance ? true : (existing.active ?? null));
      const availabilitySource = normalizedActive != null
        ? 'broker_explicit'
        : inferredReappearance
          ? 'catalog_seen'
          : (existing.availabilitySource || null);
      assets.set(symbol, {
        payout: payout ?? existing.payout ?? null,
        payoutCandidates: [...new Set([...(Array.isArray(existing.payoutCandidates) ? existing.payoutCandidates : []), incomingAssetInfoPayout, payout].filter((value) => safeNumber(value) != null && Number(value) > 0 && Number(value) <= 100).map(Number))],
        payoutSource: payout != null ? 'asset_info' : (existing.payoutSource || null),
        payoutUpdatedAt: payout != null ? nowIso() : (existing.payoutUpdatedAt || null),
        assetInfoPayout: incomingAssetInfoPayout ?? existing.assetInfoPayout ?? null,
        assetInfoPayoutUpdatedAt: incomingAssetInfoPayout != null ? nowIso() : (existing.assetInfoPayoutUpdatedAt || null),
        active: effectiveActive,
        availabilitySource,
        availabilityUpdatedAt: normalizedActive != null || inferredReappearance ? nowIso() : (existing.availabilityUpdatedAt || null),
        lastSeenAt: nowIso(),
        name: String(nameValue || existing.name || symbol).trim(),
        type: String(typeValue || existing.type || '').toLowerCase() || null,
        isOtc,
        category,
        min_timeframe: minTimeframe,
        max_timeframe: maxTimeframe,
        minTimeframe,
        maxTimeframe,
        expirationSource: minTimeframe != null || maxTimeframe != null ? 'assets_list' : existing.expirationSource || null,
        allowedCandles: normalizedAllowedCandles.length ? normalizedAllowedCandles.slice(0, 50) : (existing.allowedCandles || [])
      });
      assetCatalogRevision += 1;
      const sub = subscriptionData.get(symbol);
      if (sub) {
        sub.allowedCandles = normalizedAllowedCandles.length ? normalizedAllowedCandles.slice(0, 50) : (sub.allowedCandles || existing.allowedCandles || []);
        if (minTimeframe != null) { sub.min_timeframe = minTimeframe; sub.minTimeframe = minTimeframe; }
        if (maxTimeframe != null) { sub.max_timeframe = maxTimeframe; sub.maxTimeframe = maxTimeframe; }
        if (minTimeframe != null || maxTimeframe != null) sub.expirationSource = 'assets_list';
        if (payout != null) {
          sub.payout = payout;
          sub.payoutCandidates = [...new Set([...(Array.isArray(sub.payoutCandidates) ? sub.payoutCandidates : []), incomingAssetInfoPayout, payout].filter((value) => safeNumber(value) != null && Number(value) > 0 && Number(value) <= 100).map(Number))];
          sub.payoutSource = 'asset_info';
          sub.payoutUpdatedAt = nowIso();
          sub.assetInfoPayout = incomingAssetInfoPayout ?? sub.assetInfoPayout ?? null;
          sub.assetInfoPayoutUpdatedAt = incomingAssetInfoPayout != null ? nowIso() : (sub.assetInfoPayoutUpdatedAt || null);
        }
      }
      seen.add(symbol);
      if (assets.size > MAX_ASSETS) assets.delete(assets.keys().next().value);
    }

    function walk(value, depth = 0, keyHint = null) {
      if (depth > 9 || value == null) return;
      const parsed = parseNestedJson(value);
      if (parsed != null) return walk(parsed, depth + 1, keyHint);

      if (Array.isArray(value)) {
        // Pocket Option wire tuple: id, symbol, name, assetType, ..., payout, ..., isOtc at 9, ..., active at 14, candles at 15.
        if (value.length >= 15 && typeof value[1] === 'string') {
          add(value[1], value[5], value[14], value[2], value[3], value[9], value[15], value[16], value[17]);
        }
        for (const item of value) walk(item, depth + 1, keyHint);
        return;
      }
      if (typeof value !== 'object') return;

      const explicitSymbol = value.asset ?? value.symbol ?? value.ticker;
      const symbol = explicitSymbol != null ? explicitSymbol : assetKeyHint(keyHint);
      const name = value.name ?? value.label ?? value.title ?? symbol;
      const type = value.assetType ?? value.asset_type ?? value.type ?? value.category;
      // Use current payout fields only. max_payout/maxPayout are intentionally
      // ignored for execution filters because they can be an advertised maximum,
      // not the current tradable payout for live pairs/metals/stocks.
      const payout = value.payout ?? value.percentProfit ?? value.profitPercent ?? value.profitability;
      const active = value.active ?? value.isActive ?? value.is_active ?? value.enabled ?? value.tradable;
      const isOtc = value.isOtc ?? value.is_otc ?? value.otc;
      const allowed = value.allowedCandles ?? value.allowed_candles ?? value.timeframes;
      const minTimeframe = value.min_timeframe ?? value.minTimeframe ?? value.min_time ?? value.minTime ?? value.minDuration ?? value.min_duration ?? value.minExpiration ?? value.min_expiration;
      const maxTimeframe = value.max_timeframe ?? value.maxTimeframe ?? value.max_time ?? value.maxTime ?? value.maxDuration ?? value.max_duration ?? value.maxExpiration ?? value.max_expiration;
      if (symbol && (payout != null || active != null || value.id != null || value._id != null || type != null || minTimeframe != null || maxTimeframe != null)) add(symbol, payout, active, name, type, isOtc, allowed, minTimeframe, maxTimeframe);

      for (const [key, item] of Object.entries(value)) {
        const nextHint = assetKeyHint(key) || keyHint;
        walk(item, depth + 1, nextHint);
      }
    }

    walk(payload);
    return seen;
  }

  function applyChaforPayout(payload) {
    let changed = false;
    function walk(value, depth = 0) {
      if (depth > 8 || value == null) return;
      const parsed = parseNestedJson(value);
      if (parsed != null) return walk(parsed, depth + 1);
      if (Array.isArray(value)) {
        if (value.length >= 2 && typeof value[0] === 'string') {
          const symbol = normalizeAsset(value[0]);
          const rawCandidates = value.slice(1).map((item, index) => {
            const raw = safeNumber(item);
            if (raw == null || raw <= 0) return null;
            // chafor packets often include availability flags 0/1 near the payout.
            // Treat exactly 1 as a flag, not as 100% payout; decimal 0.89 is still
            // a valid 89% payout representation.
            if (raw === 1) return null;
            const payout = raw > 0 && raw < 1 ? raw * 100 : raw;
            return payout > 0 && payout <= 100 ? { payout, index } : null;
          }).filter(Boolean);
          // chafor can contain several payout-like numbers for the same asset
          // and is NOT official proof for minPayout. Prefer fresh asset_info when
          // available; otherwise keep a conservative chafor value for display only.
          const payoutCandidates = [...new Set(rawCandidates.map((item) => Math.round(item.payout * 100) / 100))].filter((value) => value > 0 && value <= 100);
          const payoutPool = payoutCandidates.filter((value) => value >= 10);
          const existing = symbol ? (assets.get(symbol) || {}) : {};
          const existingAssetInfoPayout = safeNumber(existing.assetInfoPayout);
          const hasAssetInfoPayout = existingAssetInfoPayout != null && existingAssetInfoPayout > 0 && existingAssetInfoPayout <= 100;
          // chafor is useful for availability diagnostics, but it is not reliable
          // enough to refresh or replace official common.assets_list.payout. If an
          // official asset-info payout exists, keep it for display with its own
          // original timestamp; do not make it artificially fresh on every chafor packet.
          let payout = hasAssetInfoPayout
            ? Number(existingAssetInfoPayout)
            : (payoutPool.length ? Math.min(...payoutPool) : (payoutCandidates.length ? Math.min(...payoutCandidates) : null));
          if (hasAssetInfoPayout) payoutCandidates.push(existingAssetInfoPayout);
          if (symbol && payout != null && payout >= 0 && payout <= 100) {
            const updatedAt = nowIso();
            const payoutSource = hasAssetInfoPayout ? 'asset_info' : 'chafor';
            const payoutUpdatedAt = hasAssetInfoPayout ? (existing.assetInfoPayoutUpdatedAt || existing.payoutUpdatedAt || null) : updatedAt;
            const changedPayout = existing.payout !== payout || existing.payoutSource !== payoutSource;
            assets.set(symbol, {
              ...existing,
              payout,
              payoutCandidates: [...new Set(payoutCandidates.filter((value) => safeNumber(value) != null && Number(value) > 0 && Number(value) <= 100).map(Number))],
              payoutSource,
              assetInfoPayout: existing.assetInfoPayout ?? null,
              assetInfoPayoutUpdatedAt: existing.assetInfoPayoutUpdatedAt || null,
              payoutUpdatedAt,
              active: existing.active ?? true,
              name: existing.name || symbol,
              isOtc: existing.isOtc ?? /_otc$/i.test(symbol),
              category: normalizeAssetType(existing.type, symbol, existing.name) || existing.category,
              allowedCandles: existing.allowedCandles || []
            });
            assetCatalogRevision += 1;
            const sub = subscriptionData.get(symbol);
            if (sub) {
              sub.payout = payout;
              sub.payoutCandidates = [...new Set(payoutCandidates.filter((value) => safeNumber(value) != null && Number(value) > 0 && Number(value) <= 100).map(Number))];
              sub.payoutSource = payoutSource;
              sub.assetInfoPayout = existing.assetInfoPayout ?? sub.assetInfoPayout ?? null;
              sub.assetInfoPayoutUpdatedAt = existing.assetInfoPayoutUpdatedAt || sub.assetInfoPayoutUpdatedAt || null;
              sub.payoutUpdatedAt = payoutUpdatedAt;
              sub.allowedCandles = sub.allowedCandles || existing.allowedCandles || [];
            }
            if (changedPayout) changed = true;
          }
        }
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        for (const item of Object.values(value)) walk(item, depth + 1);
      }
    }
    walk(payload);
    return changed;
  }

  function extractTicks(payload, fallbackAsset = null) {
    const ticks = [];
    const seen = new Set();

    function push(assetValue, timeValue, priceValue) {
      const asset = normalizeAsset(assetValue) || fallbackAsset || state.market.asset;
      const time = normalizeTimestamp(timeValue);
      const price = safeNumber(priceValue);
      if (!asset || time == null || price == null || price <= 0 || !isTimestampLike(time)) return;
      const key = `${asset}|${time}|${price}`;
      if (seen.has(key)) return;
      seen.add(key);
      ticks.push({ asset, time, price });
    }

    function walk(value, depth = 0, contextAsset = fallbackAsset || state.market.asset) {
      if (depth > 10 || value == null) return;
      const parsed = parseNestedJson(value);
      if (parsed != null) return walk(parsed, depth + 1, contextAsset);

      if (Array.isArray(value)) {
        if (value.length >= 3 && typeof value[0] === 'string') push(value[0], value[1], value[2]);
        else if (value.length === 2 && isTimestampLike(value[0]) && safeNumber(value[1]) != null) push(contextAsset, value[0], value[1]);
        else if (value.length === 3 && isTimestampLike(value[0]) && safeNumber(value[1]) != null && safeNumber(value[2]) != null) {
          push(contextAsset, value[0], value[1]);
        }
        for (const item of value) walk(item, depth + 1, contextAsset);
        return;
      }
      if (typeof value !== 'object') return;

      const localAsset = normalizeAsset(value.asset ?? value.symbol ?? value.ticker) || contextAsset;
      const time = value.time ?? value.timestamp ?? value.ts ?? value.createdAt ?? value.date;
      const isOhlc = value.open != null || value.high != null || value.low != null || value.o != null || value.h != null || value.l != null;
      const price = value.price ?? value.quote ?? value.rate ?? (!isOhlc ? (value.close ?? value.value) : null);
      if (time != null && price != null) push(localAsset, time, price);

      for (const [key, item] of Object.entries(value)) {
        const keyAsset = assetKeyHint(key) || localAsset;
        walk(item, depth + 1, keyAsset);
      }
    }

    walk(payload);
    return ticks;
  }

  function chooseArrayCandle(array, asset, period) {
    if (!Array.isArray(array) || array.length < 5 || !isTimestampLike(array[0])) return null;
    const time = normalizeTimestamp(array[0]);
    const values = array.slice(1, 6).map(safeNumber);
    if (values.slice(0, 4).some((item) => item == null)) return null;

    const candidates = [
      { open: values[0], close: values[1], high: values[2], low: values[3], volume: values[4] },
      { open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4] }
    ];
    const valid = candidates.find((candidate) =>
      candidate.high >= Math.max(candidate.open, candidate.close)
      && candidate.low <= Math.min(candidate.open, candidate.close)
      && candidate.low > 0
    ) || candidates[0];

    return { asset, period, time, ...valid, source: 'server' };
  }

  function extractCandles(payload, fallbackAsset = null, fallbackPeriod = null) {
    const candles = [];
    const seen = new Set();

    function add(candle) {
      if (!candle?.asset || candle.time == null) return;
      if ([candle.open, candle.high, candle.low, candle.close].some((item) => safeNumber(item) == null)) return;
      const normalized = {
        asset: candle.asset,
        period: Math.max(1, Number(candle.period) || Number(fallbackPeriod) || Number(state.market.period) || 60),
        time: normalizeTimestamp(candle.time),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: safeNumber(candle.volume),
        source: candle.source || 'server'
      };
      if (!isTimestampLike(normalized.time) || normalized.low <= 0) return;
      const key = `${normalized.asset}|${normalized.time}|${normalized.open}|${normalized.close}`;
      if (seen.has(key)) return;
      seen.add(key);
      candles.push(normalized);
    }

    function walk(value, depth = 0, contextAsset = fallbackAsset || state.market.asset, contextPeriod = fallbackPeriod || state.market.period) {
      if (depth > 10 || value == null) return;
      const parsed = parseNestedJson(value);
      if (parsed != null) return walk(parsed, depth + 1, contextAsset, contextPeriod);

      if (Array.isArray(value)) {
        const arrayCandle = chooseArrayCandle(value, contextAsset, contextPeriod);
        if (arrayCandle) add(arrayCandle);
        for (const item of value) walk(item, depth + 1, contextAsset, contextPeriod);
        return;
      }
      if (typeof value !== 'object') return;

      const localAsset = normalizeAsset(value.asset ?? value.symbol ?? value.ticker) || contextAsset;
      const localPeriod = safeNumber(value.period ?? value.timeframe ?? value.interval) || contextPeriod;
      const open = safeNumber(value.open ?? value.o);
      const high = safeNumber(value.high ?? value.h);
      const low = safeNumber(value.low ?? value.l);
      const close = safeNumber(value.close ?? value.c);
      const time = normalizeTimestamp(value.time ?? value.timestamp ?? value.ts ?? value.date);
      if ([open, high, low, close, time].every((item) => item != null) && localAsset) {
        add({ asset: localAsset, period: localPeriod, time, open, high, low, close, volume: value.volume ?? value.v, source: 'server' });
      }
      for (const [key, item] of Object.entries(value)) {
        const keyAsset = assetKeyHint(key) || localAsset;
        walk(item, depth + 1, keyAsset, localPeriod);
      }
    }

    walk(payload);
    return candles;
  }

  function updateCandleFromTick(tick, requestedPeriod = state.market.period) {
    const period = scannerPeriodKey(requestedPeriod);
    const sub = getSubscription(tick.asset, period);
    if (!sub) return;
    const bucket = Math.floor(tick.time / period) * period;
    const key = `${tick.asset}|${period}`;
    let candle = candleBuilders.get(key);

    if (!candle || candle.time !== bucket) {
      if (candle) {
        const closed = { ...candle, source: 'ticks' };
        sub.recentCandles.push(closed);
        clampArray(sub.recentCandles, MAX_CANDLES);
        mergeHistoryItems(sub, [closed]);
        emitMarketSnapshot(tick.asset, true, false, period);
      }
      candle = { asset: tick.asset, period, time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price, ticks: 1 };
      candleBuilders.set(key, candle);
    } else {
      candle.high = Math.max(candle.high, tick.price);
      candle.low = Math.min(candle.low, tick.price);
      candle.close = tick.price;
      candle.ticks += 1;
    }
    sub.currentCandle = { ...candle };
    if (period === Number(state.market.period) && (tick.asset === state.market.asset || !state.market.asset)) state.market.currentCandle = { ...candle };
  }

  function applyTicks(ticks) {
    const periods = [...new Set((Array.isArray(desiredSubscriptionPlan.periods) && desiredSubscriptionPlan.periods.length
      ? desiredSubscriptionPlan.periods
      : [state.market.period]).map(scannerPeriodKey))];
    const primaryPeriod = scannerPeriodKey(state.market.period);
    for (const tick of ticks) {
      observeBrokerClock(tick.time, 'live');
      for (const period of periods) {
        const scopedAssets = desiredSubscriptionPlan.assetsByPeriod?.[period];
        if (Array.isArray(scopedAssets) && !scopedAssets.includes(tick.asset)) continue;
        const sub = getSubscription(tick.asset, period);
        if (!sub) continue;
        sub.lastPrice = tick.price;
        sub.lastTickTime = tick.time;
        sub.tickCount += 1;
        sub.streamUpdatedAt = nowIso();
        sub.streamActive = true;
        sub.subscribed = true;
        sub.resubscribeAttempts = 0;
        if (period === primaryPeriod) {
          sub.recentTicks.push(tick);
          clampArray(sub.recentTicks, MAX_TICKS);
        }
        updateCandleFromTick(tick, period);
      }
      if (!state.market.asset) state.market.asset = tick.asset;
    }
    syncPrimaryMarket();
  }

  function applySyntheticTicksFromCandles(candles) {
    for (const candle of candles) {
      const sub = getSubscription(candle.asset, candle.period);
      if (!sub) continue;
      const tick = { asset: candle.asset, time: candle.time, price: candle.close, source: 'stream-candle' };
      sub.tickCount += 1;
      sub.recentTicks.push(tick);
      clampArray(sub.recentTicks, MAX_TICKS);
      sub.streamUpdatedAt = nowIso();
      sub.lastPrice = candle.close;
      sub.lastTickTime = candle.time;
      sub.streamActive = true;
      sub.subscribed = true;
    }
    syncPrimaryMarket();
  }

  function latestContiguousHistory(items, period) {
    const normalizedPeriod = Math.max(1, Number(period) || 60);
    const byTime = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !isTimestampLike(item.time)) continue;
      byTime.set(Number(item.time), item);
    }
    const ordered = [...byTime.values()].sort((a, b) => Number(a.time) - Number(b.time));
    let segment = [];
    for (const item of ordered) {
      const previous = segment[segment.length - 1];
      const gap = previous ? Number(item.time) - Number(previous.time) : 0;
      const previousClose = safeNumber(previous?.close);
      const nextClose = safeNumber(item?.close);
      const priceRatio = previousClose && nextClose ? Math.max(previousClose / nextClose, nextClose / previousClose) : 1;
      if (previous && (gap > normalizedPeriod * HISTORY_GAP_MULTIPLIER || gap <= 0 || priceRatio > HISTORY_PRICE_JUMP_RATIO)) {
        segment = [];
      }
      segment.push(item);
    }
    return segment.slice(-MAX_HISTORY_ITEMS);
  }

  function mergeHistoryItems(sub, items) {
    if (!sub || !Array.isArray(items) || !items.length) return;
    sub.historyItems = latestContiguousHistory([...(sub.historyItems || []), ...items], sub.period);
    sub.historyCount = sub.historyItems.length;
    sub.historyReceivedAt = nowIso();
    const last = sub.historyItems[sub.historyItems.length - 1];
    if (last) {
      sub.lastPrice = last.close ?? last.price ?? sub.lastPrice;
      sub.lastTickTime = last.time ?? sub.lastTickTime;
      const period = Math.max(1, Number(sub.period) || 60);
      const expectedBucket = Math.floor(brokerNowSeconds() / period) * period;
      const lastBucket = Math.floor(Number(last.time || 0) / period) * period;
      if (lastBucket === expectedBucket) {
        sub.currentCandle = { ...last, asset: sub.asset, period, source: 'history-current' };
      } else if (sub.currentCandle?.source === 'history-current' && Number(sub.currentCandle.time || 0) < expectedBucket) {
        sub.currentCandle = null;
      }
    }
  }

  function aggregateTicksToCandles(ticks, fallbackPeriod = null) {
    const buckets = new Map();
    // The broker can return history in either chronological or reverse order.
    // Sorting first guarantees correct candle open/close values in both cases.
    const orderedTicks = (Array.isArray(ticks) ? ticks : [])
      .map((tick) => ({
        asset: normalizeAsset(tick?.asset),
        time: normalizeTimestamp(tick?.time),
        price: safeNumber(tick?.price),
        period: Math.max(1, Number(tick?.period) || Number(fallbackPeriod) || Number(state.market.period) || 60)
      }))
      .filter((tick) => tick.asset && tick.time && tick.price != null && tick.price > 0)
      .sort((a, b) => a.time - b.time);
    for (const tick of orderedTicks) {
      const { asset, time, price, period } = tick;
      observeBrokerClock(time, 'history');
      const bucket = Math.floor(time / period) * period;
      const key = `${asset}|${period}|${bucket}`;
      let candle = buckets.get(key);
      if (!candle) {
        candle = { asset, period, time: bucket, open: price, high: price, low: price, close: price, volume: 0, ticks: 1, source: 'history-ticks' };
        buckets.set(key, candle);
      } else {
        candle.high = Math.max(candle.high, price);
        candle.low = Math.min(candle.low, price);
        candle.close = price;
        candle.ticks += 1;
      }
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
  }

  function mergeHistoryTicks(sub, ticks) {
    if (!sub || !Array.isArray(ticks) || !ticks.length) return;
    const normalized = ticks
      .map((tick) => ({ asset: sub.asset, time: normalizeTimestamp(tick.time), price: safeNumber(tick.price), source: 'history' }))
      .filter((tick) => tick.time && tick.price != null && tick.price > 0)
      .slice(-MAX_TICKS);
    if (!normalized.length) return;
    const byKey = new Map((sub.recentTicks || []).map((tick) => [`${tick.time}|${tick.price}`, tick]));
    for (const tick of normalized) byKey.set(`${tick.time}|${tick.price}`, tick);
    sub.recentTicks = [...byKey.values()].sort((a, b) => a.time - b.time).slice(-MAX_TICKS);
    const last = sub.recentTicks[sub.recentTicks.length - 1];
    if (last) {
      sub.lastPrice = last.price;
      sub.lastTickTime = last.time;
    }
  }

  function applyServerCandles(candles, historyLike = false) {
    for (const candle of candles) {
      const sub = getSubscription(candle.asset, candle.period);
      if (!sub) continue;
      if (historyLike) {
        mergeHistoryItems(sub, [candle]);
      } else {
        sub.recentCandles.push(candle);
        clampArray(sub.recentCandles, MAX_CANDLES);
        sub.streamActive = true;
        sub.subscribed = true;
      }
      sub.lastPrice = candle.close;
      sub.lastTickTime = candle.time;
      sub.streamUpdatedAt = nowIso();
      if (!historyLike) sub.currentCandle = { ...candle };
      if (!state.market.asset) state.market.asset = candle.asset;
    }
    syncPrimaryMarket();
  }

  function directionFromPayload(payload) {
    const action = findDeep(payload, ['action', 'direction', 'type']);
    if (typeof action === 'string') {
      const normalized = action.toLowerCase();
      if (normalized.includes('call') || normalized.includes('buy') || normalized.includes('up')) return 'call';
      if (normalized.includes('put') || normalized.includes('sell') || normalized.includes('down')) return 'put';
    }
    const command = safeNumber(findDeep(payload, ['command']));
    if (command === 0) return 'call';
    if (command === 1) return 'put';
    return null;
  }

  function extractOrderFields(payload) {
    const openTimestamp = normalizeTimestamp(findDeep(payload, ['openTimestamp', 'open_timestamp', 'openTime', 'open_time', 'createdAt'])) || brokerNowSeconds();
    const rawDuration = safeNumber(findDeep(payload, ['time', 'duration', 'expirationDuration', 'optionTime']));
    const rawExpiration = findDeep(payload, ['expirationTimestamp', 'expiration_timestamp', 'expireTimestamp', 'expire_time', 'expiredAt', 'expiration']);
    const expirationTimestamp = isTimestampLike(rawExpiration) ? normalizeTimestamp(rawExpiration) : null;
    const duration = rawDuration != null && rawDuration > 0 && rawDuration <= 86400
      ? rawDuration
      : expirationTimestamp && expirationTimestamp > openTimestamp
        ? expirationTimestamp - openTimestamp
        : null;
    return {
      requestId: meaningfulRequestId(findDeep(payload, ['requestId', 'request_id', 'clientRequestId'])),
      dealId: findDeep(payload, ['dealId', 'ticket', 'id']) ?? null,
      asset: normalizeAsset(findDeep(payload, ['asset', 'symbol', 'ticker'])),
      amount: safeNumber(findDeep(payload, ['amount', 'sum', 'stake'])),
      action: directionFromPayload(payload),
      duration
    };
  }

  function pricesEqual(left, right) {
    if (left == null || right == null) return false;
    const a = Number(left);
    const b = Number(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= Math.max(1e-10, Math.abs(a) * 1e-10);
  }

  function normalizeDeal(raw, closed = false) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id ?? raw.dealId ?? raw.ticket ?? raw.uuid ?? '').trim();
    const asset = normalizeAsset(raw.asset ?? raw.symbol ?? raw.ticker);
    if (!id && !asset) return null;
    const amount = safeNumber(raw.amount ?? raw.sum ?? raw.stake);
    const profit = safeNumber(raw.profit ?? raw.pnl ?? raw.resultAmount ?? raw.result);
    const openPrice = safeNumber(raw.openPrice ?? raw.open_price ?? raw.priceOpen);
    const closePrice = safeNumber(raw.closePrice ?? raw.close_price ?? raw.priceClose);
    const command = safeNumber(raw.command);
    const action = directionFromPayload(raw) || (command === 0 ? 'call' : command === 1 ? 'put' : null);
    const openTimestamp = normalizeTimestamp(raw.openTimestamp ?? raw.open_timestamp ?? raw.openTime ?? raw.open_time ?? raw.createdAt);
    const closeTimestamp = normalizeTimestamp(raw.closeTimestamp ?? raw.close_timestamp ?? raw.closeTime ?? raw.close_time ?? raw.finishedAt);
    const duration = safeNumber(raw.duration ?? raw.time ?? raw.expirationDuration ?? raw.optionTime);
    const expirationTimestamp = normalizeTimestamp(raw.expirationTimestamp ?? raw.expiration_timestamp ?? raw.expireTimestamp ?? raw.expire_time ?? raw.expiredAt);
    let outcome = 'open';
    if (closed || closeTimestamp || closePrice != null) {
      const explicit = String(raw.outcome ?? raw.resultStatus ?? raw.status ?? raw.reason ?? '').toLowerCase();
      // Refund/return on Pocket Option can still arrive with a positive `profit`
      // field equal to the returned stake or with status=success. Price equality
      // is the safest broker fact: open == close means neutral, not win.
      if (pricesEqual(openPrice, closePrice)) outcome = 'draw';
      else if (/draw|refund|return|tie|push|cancel|equal|возврат|ничья|отмена/.test(explicit)) outcome = 'draw';
      else if (/(?:^|[^a-z])(loss|lose|lost|failed)(?:$|[^a-z])/.test(explicit)) outcome = 'loss';
      else if (/(?:^|[^a-z])(win|won|profit)(?:$|[^a-z])/.test(explicit)) outcome = 'win';
      else if (amount != null && amount > 0 && profit != null && Math.abs(profit - amount) <= Math.max(0.000001, amount * 0.000001)) outcome = 'draw';
      else if (/win|won|profit|success/.test(explicit)) outcome = 'win';
      else if (openPrice != null && closePrice != null && action) {
        const movement = closePrice - openPrice;
        outcome = (action === 'call' ? movement > 0 : movement < 0) ? 'win' : 'loss';
      } else if (profit == null) outcome = 'closed';
      else if (amount != null && amount > 0 && Math.abs(profit - amount) <= Math.max(0.000001, amount * 0.000001)) outcome = 'draw';
      else if (profit > 0) outcome = 'win';
      else if (profit < 0) outcome = 'loss';
      else outcome = amount > 0 ? 'loss' : 'draw';
    }
    return {
      id: id || `${asset || 'deal'}-${openTimestamp || Date.now()}-${amount || 0}`,
      requestId: meaningfulRequestId(raw.requestId ?? raw.request_id),
      strategyId: String(raw.strategyId ?? raw.strategy_id ?? '').trim() || null,
      signalConfidence: safeNumber(raw.signalConfidence ?? raw.confidence),
      signalPayout: safeNumber(raw.signalPayout ?? raw.payout),
      signalExpiration: safeNumber(raw.signalExpiration ?? raw.calibratedExpiration),
      calibrationApplied: raw.calibrationApplied && typeof raw.calibrationApplied === 'object' ? raw.calibrationApplied : null,
      recoveryStep: raw.recoveryStep == null || raw.recoveryStep === '' ? null : Math.max(0, Number(raw.recoveryStep) || 0),
      recoverySteps: raw.recoverySteps == null || raw.recoverySteps === '' ? null : Math.max(0, Number(raw.recoverySteps) || 0),
      recoveryMultiplier: safeNumber(raw.recoveryMultiplier),
      recoveryScopeStrategyId: String(raw.recoveryScopeStrategyId || '').trim() || null,
      recoveryScopeAsset: String(raw.recoveryScopeAsset || '').trim() || null,
      recoveryFollowSignal: raw.recoveryFollowSignal === true,
      parentRequestId: meaningfulRequestId(raw.parentRequestId),
      recoveryBranchRootId: String(raw.recoveryBranchRootId || '').trim() || null,
      baseAmount: safeNumber(raw.baseAmount),
      asset,
      action,
      amount,
      profit,
      percentProfit: safeNumber(raw.percentProfit ?? raw.percent_profit ?? raw.payout),
      openPrice,
      closePrice,
      openTimestamp,
      closeTimestamp,
      duration,
      expirationTimestamp,
      currency: String(raw.currency || state.account.currency || '').toUpperCase() || null,
      isDemo: raw.isDemo ?? raw.is_demo ?? state.account.isDemo,
      outcome,
      status: closed ? 'closed' : outcome === 'open' ? 'open' : 'closed',
      source: raw.source || null,
      robotTrade: raw.robotTrade === true || String(raw.source || '').toLowerCase() === 'autotrade'
    };
  }

  function extractDealList(payload, closed = false) {
    const direct = Array.isArray(payload) ? payload : null;
    const nested = direct || findDeep(payload, ['deals', 'openedDeals', 'closedDeals', 'data', 'orders']);
    let list = Array.isArray(nested) ? nested : [];
    if (!list.length && payload && typeof payload === 'object' && (payload.id || payload.dealId || payload.asset)) list = [payload];
    return list.map((item) => normalizeDeal(item, closed)).filter(Boolean);
  }


  function dealExpirationTimestamp(deal) {
    const explicit = safeNumber(deal?.expirationTimestamp);
    if (explicit && explicit > 0) return explicit;
    const opened = safeNumber(deal?.openTimestamp);
    const duration = safeNumber(deal?.duration);
    return opened && duration && duration > 0 ? opened + duration : null;
  }

  function meaningfulRequestId(value) {
    const requestId = String(value ?? '').trim();
    return requestId && requestId !== '0' && requestId.toLowerCase() !== 'null' && requestId.toLowerCase() !== 'undefined'
      ? requestId
      : null;
  }

  function recentTradeResultForDeal(deal) {
    const id = String(deal?.id || deal?.dealId || '').trim();
    const requestId = meaningfulRequestId(deal?.requestId);
    return (state.trades.recentResults || []).slice().reverse().find((item) => {
      const itemDealId = String(item?.dealId || '').trim();
      const itemRequestId = meaningfulRequestId(item?.requestId);
      return (id && itemDealId && id === itemDealId) || (requestId && itemRequestId === requestId);
    }) || null;
  }

  function normalizedTradeDuration(value) {
    const duration = safeNumber(value);
    return duration != null && duration > 0 && duration <= 86400 ? duration : null;
  }

  function submittedRobotOrderMatchDelta(deal, reference) {
    if (!deal || !reference) return null;
    const dealId = String(deal?.id || deal?.dealId || '').trim();
    const claimedDealId = String(reference?.brokerDealId || reference?.dealId || '').trim();
    if (claimedDealId && dealId && claimedDealId !== dealId) return null;
    const requestId = meaningfulRequestId(reference.requestId);
    const dealRequestId = meaningfulRequestId(deal?.requestId);
    const source = String(reference.source || '').trim().toLowerCase();
    if (!requestId || (!requestId.startsWith('pt_') && source !== 'autotrade' && reference.robotTrade !== true)) return null;
    if (dealRequestId && dealRequestId !== requestId) return null;
    if (String(deal.asset || '') !== String(reference.asset || '')) return null;
    if (deal.action && reference.action && String(deal.action) !== String(reference.action)) return null;
    const dealAmount = safeNumber(deal.amount);
    const referenceAmount = safeNumber(reference.amount);
    if (dealAmount == null || referenceAmount == null || Math.abs(dealAmount - referenceAmount) > 1e-8) return null;
    const dealDuration = normalizedTradeDuration(deal.duration);
    const referenceDuration = normalizedTradeDuration(reference.duration ?? reference.signalExpiration);
    if (dealDuration != null && referenceDuration != null && Math.abs(dealDuration - referenceDuration) > 1) return null;

    const brokerOpen = safeNumber(deal.openTimestamp);
    if (brokerOpen == null) return null;
    const localOpenMs = (brokerOpen - Number(state.market?.brokerClockOffsetSec || brokerClockOffsetSec || 0)) * 1000;
    let submittedAtMs = Number(reference.submittedAt ?? reference.sentAt ?? 0);
    if (!Number.isFinite(submittedAtMs) || submittedAtMs <= 0) {
      const parsed = Date.parse(reference.submittedAt || reference.sentAt || reference.time || '');
      if (Number.isFinite(parsed)) submittedAtMs = parsed;
    }
    // Legacy unconfirmed results stored only the 12-second timeout time.
    if ((!reference.submittedAt && !reference.sentAt) && String(reference.status || '') === 'unconfirmed') submittedAtMs -= 12000;
    if (!Number.isFinite(submittedAtMs) || submittedAtMs <= 0) return null;
    const delta = Math.abs(localOpenMs - submittedAtMs);
    return delta <= LATE_ROBOT_ORDER_MATCH_WINDOW_SECONDS * 1000 ? delta : null;
  }

  function submittedRobotOrderMatchesBrokerDeal(deal, reference) {
    return submittedRobotOrderMatchDelta(deal, reference) != null;
  }

  function claimLateRobotOrderReference(deal, match) {
    const dealId = String(deal?.id || deal?.dealId || '').trim();
    const requestId = meaningfulRequestId(match?.requestId);
    if (!dealId || !requestId) return null;
    let reconciledResult = null;
    for (const item of outgoingOrders) {
      if (meaningfulRequestId(item?.requestId) !== requestId) continue;
      item.brokerDealId = dealId;
      item.dealId = dealId;
      item.resolved = true;
      item.reconciled = true;
    }
    for (const item of state.trades.recentResults || []) {
      if (meaningfulRequestId(item?.requestId) !== requestId) continue;
      const wasUnconfirmed = String(item?.status || '') === 'unconfirmed' && item?.reconciled !== true;
      item.brokerDealId = dealId;
      item.dealId = dealId;
      item.source = 'autotrade';
      item.robotTrade = true;
      item.reconciled = true;
      item.reconciledAt = nowIso();
      if (wasUnconfirmed) {
        item.status = 'success';
        state.trades.unconfirmedCount = Math.max(0, Number(state.trades.unconfirmedCount || 0) - 1);
        state.trades.successCount = Number(state.trades.successCount || 0) + 1;
      }
      reconciledResult = item;
    }
    if (reconciledResult && meaningfulRequestId(state.trades.lastResult?.requestId) === requestId) state.trades.lastResult = reconciledResult;
    return reconciledResult || match;
  }

  function lateRobotOrderReferencesForDeals(deals) {
    const list = Array.isArray(deals) ? deals : [];
    const result = new Map();
    if (!list.length) return result;
    const byRequestId = new Map();
    for (const item of state.trades.recentResults || []) {
      if (String(item?.status || '') !== 'unconfirmed') continue;
      const requestId = meaningfulRequestId(item?.requestId);
      if (requestId) byRequestId.set(requestId, item);
    }
    for (const item of outgoingOrders) {
      const requestId = meaningfulRequestId(item?.requestId);
      if (!requestId || byRequestId.has(requestId)) continue;
      if (item?.resolved === true) continue;
      byRequestId.set(requestId, item);
    }
    const exactClaimedDealIds = new Set();
    for (const deal of list) {
      const dealId = String(deal?.id || deal?.dealId || '').trim();
      if (!dealId) continue;
      const recent = recentTradeResultForDeal(deal);
      const recentRequestId = meaningfulRequestId(recent?.requestId);
      const dealRequestId = meaningfulRequestId(deal?.requestId);
      const recentDealId = String(recent?.brokerDealId || recent?.dealId || '').trim();
      const exactIdentity = (dealRequestId && recentRequestId === dealRequestId)
        || (recentDealId && recentDealId === dealId);
      if (String(recent?.status || '') !== 'unconfirmed' || recent?.reconciled === true || !recentRequestId || !exactIdentity) continue;
      const claimed = claimLateRobotOrderReference(deal, recent);
      if (!claimed) continue;
      result.set(dealId, claimed);
      exactClaimedDealIds.add(dealId);
      byRequestId.delete(recentRequestId);
    }
    const edges = [];
    for (const deal of list) {
      const dealId = String(deal?.id || deal?.dealId || '').trim();
      if (!dealId || exactClaimedDealIds.has(dealId) || recentTradeResultForDeal(deal)) continue;
      for (const [requestId, reference] of byRequestId.entries()) {
        const delta = submittedRobotOrderMatchDelta(deal, reference);
        if (delta != null) edges.push({ deal, dealId, requestId, reference, delta });
      }
    }
    edges.sort((left, right) => left.delta - right.delta);
    const usedDeals = new Set();
    const usedRequests = new Set();
    for (const edge of edges) {
      if (usedDeals.has(edge.dealId) || usedRequests.has(edge.requestId)) continue;
      const ambiguous = edges.some((other) => other !== edge
        && ((other.dealId === edge.dealId && other.requestId !== edge.requestId)
          || (other.requestId === edge.requestId && other.dealId !== edge.dealId))
        && Math.abs(Number(other.delta) - Number(edge.delta)) < 1500);
      if (ambiguous) continue;
      const claimed = claimLateRobotOrderReference(edge.deal, edge.reference);
      if (!claimed) continue;
      usedDeals.add(edge.dealId);
      usedRequests.add(edge.requestId);
      result.set(edge.dealId, claimed);
    }
    return result;
  }

  function lateRobotOrderReferenceForDeal(deal) {
    const dealId = String(deal?.id || deal?.dealId || '').trim();
    return dealId ? lateRobotOrderReferencesForDeals([deal]).get(dealId) || null : null;
  }

  function enrichBrokerDeal(deal, existing = null, lateReference = null) {
    const recent = recentTradeResultForDeal(deal) || recentTradeResultForDeal(existing) || lateReference || lateRobotOrderReferenceForDeal(deal);
    return {
      ...(existing || {}),
      ...deal,
      requestId: meaningfulRequestId(deal?.requestId)
        || meaningfulRequestId(existing?.requestId)
        || meaningfulRequestId(recent?.requestId),
      duration: normalizedTradeDuration(deal?.duration) ?? normalizedTradeDuration(existing?.duration) ?? normalizedTradeDuration(recent?.duration),
      source: deal?.source || existing?.source || recent?.source || null,
      strategyId: deal?.strategyId || existing?.strategyId || recent?.strategyId || null,
      signalConfidence: deal?.signalConfidence ?? existing?.signalConfidence ?? recent?.signalConfidence ?? null,
      signalPayout: deal?.signalPayout ?? existing?.signalPayout ?? recent?.signalPayout ?? deal?.percentProfit ?? null,
      signalExpiration: deal?.signalExpiration ?? existing?.signalExpiration ?? recent?.signalExpiration ?? deal?.duration ?? null,
      calibrationApplied: deal?.calibrationApplied || existing?.calibrationApplied || recent?.calibrationApplied || null,
      recoveryStep: deal?.recoveryStep ?? existing?.recoveryStep ?? recent?.recoveryStep ?? null,
      recoverySteps: deal?.recoverySteps ?? existing?.recoverySteps ?? recent?.recoverySteps ?? null,
      recoveryMultiplier: deal?.recoveryMultiplier ?? existing?.recoveryMultiplier ?? recent?.recoveryMultiplier ?? null,
      recoveryScopeStrategyId: deal?.recoveryScopeStrategyId || existing?.recoveryScopeStrategyId || recent?.recoveryScopeStrategyId || null,
      recoveryScopeAsset: deal?.recoveryScopeAsset || existing?.recoveryScopeAsset || recent?.recoveryScopeAsset || null,
      recoveryFollowSignal: deal?.recoveryFollowSignal === true || existing?.recoveryFollowSignal === true || recent?.recoveryFollowSignal === true,
      parentRequestId: deal?.parentRequestId || existing?.parentRequestId || recent?.parentRequestId || null,
      recoveryBranchRootId: deal?.recoveryBranchRootId || existing?.recoveryBranchRootId || recent?.recoveryBranchRootId || null,
      baseAmount: deal?.baseAmount ?? existing?.baseAmount ?? recent?.baseAmount ?? null,
      robotTrade: deal?.robotTrade === true || existing?.robotTrade === true || recent?.robotTrade === true
        || String(deal?.source || existing?.source || recent?.source || '').toLowerCase() === 'autotrade'
    };
  }

  function sameDealIdentity(left, right) {
    if (!left || !right) return false;
    const leftId = String(left.id || left.dealId || '').trim();
    const rightId = String(right.id || right.dealId || '').trim();
    if (leftId && rightId && leftId === rightId) return true;
    const leftRequest = meaningfulRequestId(left.requestId);
    const rightRequest = meaningfulRequestId(right.requestId);
    if (leftRequest && rightRequest && leftRequest === rightRequest) return true;
    // Explicit identities outrank the fuzzy asset/amount/time fallback. Without
    // these guards two legitimate simultaneous orders can collapse into one deal.
    if (leftId && rightId) return false;
    if (leftRequest && rightRequest) return false;
    if (!left.asset || !right.asset || left.asset !== right.asset) return false;
    if (left.action && right.action && left.action !== right.action) return false;
    if (left.amount != null && right.amount != null && Math.abs(Number(left.amount) - Number(right.amount)) > 1e-8) return false;
    const leftOpen = safeNumber(left.openTimestamp);
    const rightOpen = safeNumber(right.openTimestamp);
    return leftOpen == null || rightOpen == null || Math.abs(leftOpen - rightOpen) <= 20;
  }

  function openDealStillRelevant(deal, graceSeconds = null) {
    if (!deal || deal.status === 'closed' || deal.closeTimestamp) return false;
    const expiry = dealExpirationTimestamp(deal);
    if (!expiry) {
      const opened = safeNumber(deal?.openTimestamp);
      return !deal.optimistic || !opened || brokerNowSeconds() - opened <= 6 * 60 * 60;
    }
    const grace = graceSeconds == null
      ? (deal.optimistic ? OPTIMISTIC_OPEN_GRACE_SECONDS : BROKER_OPEN_GRACE_SECONDS)
      : Math.max(0, Number(graceSeconds) || 0);
    return brokerNowSeconds() <= expiry + grace;
  }

  function buildOptimisticOpenDeal(result, payload, outgoing, pending) {
    const asset = result?.asset || pending?.asset || outgoing?.asset || null;
    const action = result?.action || pending?.action || outgoing?.action || null;
    const amount = result?.amount ?? pending?.amount ?? outgoing?.amount ?? null;
    const duration = safeNumber(result?.duration ?? pending?.duration ?? outgoing?.duration);
    const dealId = String(result?.dealId || findDeep(payload, ['dealId', 'ticket', 'id']) || result?.requestId || pending?.requestId || '').trim();
    if (!dealId || !asset || !action || amount == null) return null;
    const rawOpenTimestamp = findDeep(payload, ['openTimestamp', 'open_timestamp', 'openTime', 'open_time', 'createdAt']);
    const openTimestamp = normalizeTimestamp(rawOpenTimestamp) || brokerNowSeconds();
    const rawExpiration = findDeep(payload, ['expirationTimestamp', 'expiration_timestamp', 'expireTimestamp', 'expire_time', 'expiredAt']);
    const explicitExpiration = isTimestampLike(rawExpiration) ? normalizeTimestamp(rawExpiration) : null;
    const expirationTimestamp = explicitExpiration || (duration && duration > 0 ? openTimestamp + duration : null);
    return {
      id: dealId,
      requestId: meaningfulRequestId(result?.requestId) || meaningfulRequestId(pending?.requestId) || meaningfulRequestId(outgoing?.requestId),
      strategyId: String(result?.strategyId || pending?.strategyId || outgoing?.strategyId || '').trim() || null,
      signalConfidence: safeNumber(result?.signalConfidence ?? pending?.signalConfidence ?? outgoing?.signalConfidence),
      signalPayout: safeNumber(result?.signalPayout ?? pending?.signalPayout ?? outgoing?.signalPayout ?? findDeep(payload, ['percentProfit', 'percent_profit', 'payout'])),
      signalExpiration: safeNumber(result?.signalExpiration ?? pending?.signalExpiration ?? outgoing?.signalExpiration ?? duration),
      calibrationApplied: result?.calibrationApplied || pending?.calibrationApplied || outgoing?.calibrationApplied || null,
      recoveryStep: result?.recoveryStep ?? pending?.recoveryStep ?? outgoing?.recoveryStep ?? null,
      recoverySteps: result?.recoverySteps ?? pending?.recoverySteps ?? outgoing?.recoverySteps ?? null,
      recoveryMultiplier: result?.recoveryMultiplier ?? pending?.recoveryMultiplier ?? outgoing?.recoveryMultiplier ?? null,
      recoveryScopeStrategyId: result?.recoveryScopeStrategyId || pending?.recoveryScopeStrategyId || outgoing?.recoveryScopeStrategyId || null,
      recoveryScopeAsset: result?.recoveryScopeAsset || pending?.recoveryScopeAsset || outgoing?.recoveryScopeAsset || null,
      recoveryFollowSignal: result?.recoveryFollowSignal === true || pending?.recoveryFollowSignal === true || outgoing?.recoveryFollowSignal === true,
      parentRequestId: result?.parentRequestId || pending?.parentRequestId || outgoing?.parentRequestId || null,
      recoveryBranchRootId: result?.recoveryBranchRootId || pending?.recoveryBranchRootId || outgoing?.recoveryBranchRootId || null,
      baseAmount: result?.baseAmount ?? pending?.baseAmount ?? outgoing?.baseAmount ?? null,
      source: result?.source || pending?.source || outgoing?.source || null,
      robotTrade: String(result?.source || pending?.source || outgoing?.source || '').toLowerCase() === 'autotrade',
      asset,
      action,
      amount,
      profit: null,
      percentProfit: safeNumber(findDeep(payload, ['percentProfit', 'percent_profit', 'payout'])),
      openPrice: safeNumber(findDeep(payload, ['openPrice', 'open_price', 'priceOpen', 'price'])),
      closePrice: null,
      openTimestamp,
      closeTimestamp: null,
      duration,
      expirationTimestamp,
      currency: String(findDeep(payload, ['currency']) || state.account.currency || '').toUpperCase() || null,
      isDemo: state.account.isDemo,
      outcome: 'open',
      status: 'open',
      optimistic: true,
      brokerConfirmed: false,
      confirmedAt: nowIso()
    };
  }

  function closePriceForDeal(deal) {
    const asset = normalizeAsset(deal?.asset);
    if (!asset) return null;
    const sub = state.market?.subscriptions?.[asset] || {};
    const expiry = dealExpirationTimestamp(deal);
    const candidates = [];
    const pushPrice = (item, source) => {
      const price = safeNumber(item?.price ?? item?.close);
      const time = normalizeTimestamp(item?.time);
      if (price == null) return;
      candidates.push({ price, time: time || brokerNowSeconds(), source });
    };
    for (const tick of Array.isArray(sub.recentTicks) ? sub.recentTicks : []) pushPrice(tick, 'tick');
    for (const candle of Array.isArray(sub.recentCandles) ? sub.recentCandles : []) pushPrice(candle, 'candle');
    for (const candle of Array.isArray(sub.historyItems) ? sub.historyItems.slice(-8) : []) pushPrice(candle, 'history');
    if (sub.currentCandle) pushPrice(sub.currentCandle, 'currentCandle');
    if (safeNumber(sub.lastPrice) != null) candidates.push({ price: safeNumber(sub.lastPrice), time: normalizeTimestamp(sub.lastTickTime) || brokerNowSeconds(), source: 'lastPrice' });
    if (!candidates.length) return null;
    if (!expiry) return candidates[candidates.length - 1].price;
    candidates.sort((a, b) => Math.abs((a.time || 0) - expiry) - Math.abs((b.time || 0) - expiry));
    return candidates[0].price;
  }

  function synthesizeClosedDealFromExpiredOpen(deal) {
    if (!deal || deal.status === 'closed' || deal.closeTimestamp) return null;
    const expiry = dealExpirationTimestamp(deal);
    const now = brokerNowSeconds();
    if (!expiry || now <= expiry + 1) return null;
    const openPrice = safeNumber(deal.openPrice);
    const closePrice = closePriceForDeal(deal);
    const amount = Math.max(0, safeNumber(deal.amount) ?? 0);
    const action = deal.action || null;
    let outcome = 'draw';
    if (openPrice != null && closePrice != null && action) {
      const movement = closePrice - openPrice;
      if (movement > 0) outcome = action === 'call' ? 'win' : 'loss';
      else if (movement < 0) outcome = action === 'put' ? 'win' : 'loss';
    }
    const percent = safeNumber(deal.percentProfit ?? deal.signalPayout) ?? safeNumber(state.market?.subscriptions?.[deal.asset]?.payout) ?? 0;
    const profit = outcome === 'win' ? Number((amount * Math.max(0, percent) / 100).toFixed(8)) : outcome === 'loss' ? -amount : 0;
    return {
      ...deal,
      id: String(deal.id || deal.dealId || deal.requestId || `${deal.asset}-${deal.openTimestamp || now}-${amount}`),
      closeTimestamp: expiry,
      closePrice: closePrice ?? deal.closePrice ?? null,
      profit,
      percentProfit: percent || deal.percentProfit || null,
      outcome,
      status: 'closed',
      optimistic: false,
      brokerConfirmed: deal.brokerConfirmed === true,
      synthetic: true,
      source: deal.source || 'live-expiration'
    };
  }

  function pruneExpiredOpenDeals() {
    const opened = Array.isArray(state.trades.openedDeals) ? state.trades.openedDeals : [];
    const before = opened.length;
    if (!before) return false;
    const stillOpen = [];
    const syntheticClosed = [];
    for (const deal of opened) {
      if (openDealStillRelevant(deal)) {
        stillOpen.push(deal);
      } else {
        const closedDeal = synthesizeClosedDealFromExpiredOpen(deal);
        if (closedDeal) syntheticClosed.push(closedDeal);
      }
    }
    state.trades.openedDeals = stillOpen;
    if (syntheticClosed.length) {
      const closedMap = new Map((state.trades.closedDeals || []).map((item) => [String(item.id), item]));
      for (const closedDeal of syntheticClosed) {
        for (const [key, existing] of closedMap.entries()) {
          if (sameDealIdentity(existing, closedDeal)) closedMap.delete(key);
        }
        closedMap.set(String(closedDeal.id), closedDeal);
      }
      state.trades.closedDeals = [...closedMap.values()].sort((a, b) => (a.closeTimestamp || 0) - (b.closeTimestamp || 0)).slice(-1000);
    }
    const changed = state.trades.openedDeals.length !== before || syntheticClosed.length > 0;
    if (changed) updateTradeStatistics();
    return changed;
  }

  function clearHistoryQueue() {
    historyTaskQueue.length = 0;
    if (historyQueueTimer) clearTimeout(historyQueueTimer);
    historyQueueTimer = null;
    historyQueueDueAt = 0;
    historyQueueBlockedUntil = 0;
  }

  function scheduleHistoryQueue(delay = 0) {
    const normalizedDelay = Math.max(0, Number(delay) || 0);
    const dueAt = Date.now() + normalizedDelay;
    if (historyQueueTimer) {
      if (historyQueueDueAt && historyQueueDueAt <= dueAt) return;
      clearTimeout(historyQueueTimer);
    }
    historyQueueDueAt = dueAt;
    historyQueueTimer = setTimeout(() => {
      historyQueueTimer = null;
      historyQueueDueAt = 0;
      pumpHistoryQueue();
    }, normalizedDelay);
  }

  function queueHasAsset(asset, period) {
    if ([...historyRequests.values()].some((item) => item.asset === asset && Number(item.period) === Number(period))) return true;
    return historyTaskQueue.some((item) => item.asset === asset && Number(item.period) === Number(period));
  }

  function enqueueHistoryTask(task, front = false) {
    if (!task?.asset || !manualConnectionRequested) return false;
    if (assets.get(normalizeAsset(task.asset))?.active === false) return false;
    const period = Math.max(1, Number(task.period) || state.market.period || 60);
    if (queueHasAsset(task.asset, period)) return false;
    const normalized = {
      asset: task.asset,
      period,
      offsetSeconds: Math.max(period, Number(task.offsetSeconds) || period),
      scanner: Boolean(task.scanner),
      resetHistory: Boolean(task.resetHistory),
      token: task.token ?? subscriptionQueueToken,
      attempts: Math.max(0, Number(task.attempts) || 0)
    };
    if (front) historyTaskQueue.unshift(normalized);
    else historyTaskQueue.push(normalized);
    scheduleHistoryQueue(0);
    return true;
  }

  function pumpHistoryQueue() {
    cleanupStaleHistoryRequests();
    if (!manualConnectionRequested) {
      scheduleHistoryQueue(500);
      return;
    }
    if (Date.now() < historyQueueBlockedUntil) {
      scheduleHistoryQueue(Math.max(20, historyQueueBlockedUntil - Date.now()));
      return;
    }
    // A single shared history socket carries exactly one broker request at a time.
    // This removes cross-TF response ambiguity and prevents 14 helper transports from
    // competing with the authenticated account WebSocket.
    if (historyRequests.size >= MAX_HISTORY_IN_FLIGHT) {
      scheduleHistoryQueue(80);
      return;
    }

    let sent = 0;
    while (historyTaskQueue.length && sent < MAX_HISTORY_IN_FLIGHT && historyRequests.size < MAX_HISTORY_IN_FLIGHT) {
      const task = historyTaskQueue.shift();
      if (!task || task.token !== subscriptionQueueToken) continue;
      if (assets.get(normalizeAsset(task.asset))?.active === false) continue;
      const period = scannerPeriodKey(task.period);
      const historySocket = ensureScannerSocket(period);
      const lane = scannerLane(period, true);
      if (!historySocket || !lane.ready || !isSocketHealthy(historySocket, 90000)) {
        historyTaskQueue.unshift(task);
        break;
      }

      const sub = getSubscription(task.asset, period);
      if (!sub) continue;
      if (task.resetHistory) {
        sub.historyItems = [];
        sub.historyCount = 0;
        sub.historyReceivedAt = null;
      }
      const index = ++historyRequestIndex;
      const request = { ...task, period, index, requestedAt: Date.now(), socket: historySocket, scannerPeriod: period };
      historyRequests.set(index, request);
      try {
        lane.period = period;
        sendSocketPacket(historySocket, 'changeSymbol', { asset: task.asset, period });
        sub.requested = true;
        sub.requestedAt = sub.requestedAt || nowIso();
        state.market.historyRequestedAt = nowIso();
        if (task.scanner) {
          multiAssetScanRequests += 1;
          lastMultiAssetScanAsset = task.asset;
        }
        sent += 1;
      } catch (error) {
        historyRequests.delete(index);
        lane.lastError = String(error?.message || error);
        if (task.attempts < 1) historyTaskQueue.unshift({ ...task, attempts: task.attempts + 1 });
        break;
      }
    }

    updateScannerAggregateState();
    if (historyTaskQueue.length || historyRequests.size) scheduleHistoryQueue(sent ? 45 : 180);
    emitState();
  }

  function pendingHistoryFromPayload(payload, payloadAsset = null, socket = null) {
    const matchingIndexes = [];
    const seen = new WeakSet();
    const walk = (value, depth = 0) => {
      if (depth > 8 || value == null) return;
      if (typeof value === 'number' || typeof value === 'string') {
        const numeric = Math.floor(Number(value));
        if (Number.isFinite(numeric) && historyRequests.has(numeric)) matchingIndexes.push(numeric);
        return;
      }
      if (typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        // Pocket Option commonly echoes the history request index as a primitive
        // array element. Only exact indexes that are currently pending are accepted.
        for (const item of value) walk(item, depth + 1);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (/^(index|requestId|request_id)$/i.test(key)) {
          const numeric = Math.floor(Number(item));
          if (Number.isFinite(numeric) && historyRequests.has(numeric)) matchingIndexes.push(numeric);
        }
        walk(item, depth + 1);
      }
    };
    walk(payload);
    if (matchingIndexes.length) {
      const exactIndex = matchingIndexes.find((index) => !socket || historyRequests.get(index)?.socket === socket);
      if (exactIndex != null) return historyRequests.get(exactIndex) || null;
    }

    const pending = [...historyRequests.values()]
      .filter((item) => (!socket || item.socket === socket) && (!payloadAsset || item.asset === payloadAsset))
      .sort((a, b) => Number(a.requestedAt || 0) - Number(b.requestedAt || 0));
    // Never guess between several in-flight pairs. An ambiguous history packet is
    // ignored and retried after timeout instead of contaminating another asset's OHLC.
    if (payloadAsset) return pending[0] || null;
    return pending.length === 1 ? pending[0] : null;
  }

  function historyRequestAlreadyPending(asset) {
    const now = Date.now();
    return queueHasAsset(asset, state.market.period) || [...historyRequests.values()].some((item) => item.asset === asset && now - Number(item.requestedAt || 0) < HISTORY_REQUEST_STALE_MS);
  }

  function dealNetForStatistics(deal) {
    const amount = Math.max(0, safeNumber(deal?.amount) ?? 0);
    const rawProfit = safeNumber(deal?.profit) ?? 0;
    const percent = safeNumber(deal?.percentProfit ?? deal?.signalPayout);
    const outcome = String(deal?.outcome || '').toLowerCase();
    if (outcome === 'draw' || pricesEqual(deal?.openPrice, deal?.closePrice)) return 0;
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

  function isRobotTradeDeal(deal) {
    const source = String(deal?.source || '').trim().toLowerCase();
    const requestId = String(deal?.requestId || '').trim();
    return Boolean(deal?.robotTrade === true || source === 'autotrade' || requestId.startsWith('pt_'));
  }

  function updateTradeStatistics() {
    const closed = (state.trades.closedDeals || []).filter(isRobotTradeDeal);
    const openRobot = (state.trades.openedDeals || []).filter(isRobotTradeDeal);
    const stats = { total: closed.length, wins: 0, losses: 0, draws: 0, open: openRobot.length, netProfit: 0, invested: 0, winRate: 0 };
    for (const deal of closed) {
      const net = dealNetForStatistics(deal);
      const amount = safeNumber(deal.amount) ?? 0;
      stats.netProfit += net;
      stats.invested += amount;
      if (net > 0.0000001) stats.wins += 1;
      else if (net < -0.0000001) stats.losses += 1;
      else stats.draws += 1;
    }
    stats.netProfit = Number(stats.netProfit.toFixed(8));
    stats.invested = Number(stats.invested.toFixed(8));
    stats.winRate = stats.wins + stats.losses > 0 ? Number((stats.wins / (stats.wins + stats.losses) * 100).toFixed(2)) : 0;
    state.trades.statistics = stats;
    state.trades.openedCount = stats.open;
    state.trades.closedCount = stats.total;
    state.trades.optimisticOpenCount = (state.trades.openedDeals || []).filter((deal) => deal?.optimistic).length;
  }

  function mergeDeals(kind, deals, options = {}) {
    const list = Array.isArray(deals) ? deals : [];
    const replace = options.replace === true;
    const lateReferences = lateRobotOrderReferencesForDeals(list);
    if (kind === 'open') {
      const previous = Array.isArray(state.trades.openedDeals) ? state.trades.openedDeals : [];
      const closed = Array.isArray(state.trades.closedDeals) ? state.trades.closedDeals : [];
      const map = replace ? new Map() : new Map(previous.map((item) => [String(item.id), item]));
      for (const deal of list) {
        if (closed.some((item) => sameDealIdentity(item, deal))) continue;
        const existing = previous.find((item) => sameDealIdentity(item, deal));
        if (existing && String(existing.id) !== String(deal.id)) map.delete(String(existing.id));
        const brokerConfirmed = replace || options.brokerConfirmed === true || deal?.brokerConfirmed === true;
        map.set(String(deal.id), {
          ...enrichBrokerDeal(deal, existing, lateReferences.get(String(deal.id)) || null),
          optimistic: brokerConfirmed ? false : deal?.optimistic === true,
          brokerConfirmed
        });
      }
      if (replace) {
        for (const existing of previous) {
          if (!existing?.optimistic || !openDealStillRelevant(existing)) continue;
          if (closed.some((item) => sameDealIdentity(item, existing))) continue;
          if (list.some((item) => sameDealIdentity(item, existing))) continue;
          map.set(String(existing.id), existing);
        }
        state.trades.lastOpenSnapshotAt = nowIso();
        state.trades.lastOpenSnapshotCount = list.length;
      }
      state.trades.openedDeals = [...map.values()].filter((deal) => openDealStillRelevant(deal)).slice(-250);
    } else {
      if (!list.length) return;
      const previousOpen = Array.isArray(state.trades.openedDeals) ? state.trades.openedDeals : [];
      const map = new Map((state.trades.closedDeals || []).map((item) => [String(item.id), item]));
      for (const deal of list) {
        const matchingOpen = previousOpen.find((item) => sameDealIdentity(item, deal));
        for (const [key, existing] of map.entries()) {
          if (sameDealIdentity(existing, deal)) map.delete(key);
        }
        map.set(String(deal.id), {
          ...enrichBrokerDeal(deal, matchingOpen, lateReferences.get(String(deal.id)) || null),
          optimistic: false,
          brokerConfirmed: true,
          synthetic: false,
          status: 'closed'
        });
      }
      state.trades.closedDeals = [...map.values()].sort((a, b) => (a.closeTimestamp || 0) - (b.closeTimestamp || 0)).slice(-1000);
      state.trades.openedDeals = (state.trades.openedDeals || []).filter((openDeal) => !list.some((closedDeal) => sameDealIdentity(openDeal, closedDeal)));
    }
    updateTradeStatistics();
  }

  function reconcilePreviouslyUnconfirmedTradeResult(result) {
    const requestId = meaningfulRequestId(result?.requestId);
    if (!requestId || !['success', 'failed'].includes(String(result?.status || ''))) return null;
    const recent = Array.isArray(state.trades.recentResults) ? state.trades.recentResults : [];
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const item = recent[index];
      if (meaningfulRequestId(item?.requestId) !== requestId || String(item?.status || '') !== 'unconfirmed') continue;
      const reconciled = {
        ...item,
        ...result,
        requestId,
        source: result?.source || item?.source || null,
        robotTrade: result?.robotTrade === true || item?.robotTrade === true || String(result?.source || item?.source || '').toLowerCase() === 'autotrade',
        reconciled: true,
        reconciledAt: nowIso()
      };
      recent[index] = reconciled;
      state.trades.unconfirmedCount = Math.max(0, Number(state.trades.unconfirmedCount || 0) - 1);
      if (reconciled.status === 'success') state.trades.successCount = Number(state.trades.successCount || 0) + 1;
      else state.trades.failedCount = Number(state.trades.failedCount || 0) + 1;
      state.trades.lastResult = reconciled;
      return reconciled;
    }
    return null;
  }

  function rememberTradeResult(result) {
    const reconciled = reconcilePreviouslyUnconfirmedTradeResult(result);
    if (reconciled) return reconciled;
    state.trades.lastResult = result;
    state.trades.recentResults.push(result);
    clampArray(state.trades.recentResults, MAX_RESULTS);
    if (result.status === 'success') state.trades.successCount += 1;
    else if (result.status === 'failed') state.trades.failedCount += 1;
    else if (result.status === 'unconfirmed') state.trades.unconfirmedCount += 1;
    return result;
  }

  function registerOutgoingOrder(payload) {
    const fields = extractOrderFields(payload);
    const requestId = fields.requestId || null;
    const pending = requestId ? pendingTrades.get(requestId) : null;
    outgoingOrders.push({
      ...fields,
      requestId,
      sentAt: Date.now(),
      source: pending?.source || (requestId && pendingTrades.has(requestId) ? 'extension' : 'page'),
      robotTrade: String(pending?.source || '').toLowerCase() === 'autotrade',
      strategyId: pending?.strategyId || null,
      signalConfidence: pending?.signalConfidence ?? null,
      signalPayout: pending?.signalPayout ?? null,
      signalExpiration: pending?.signalExpiration ?? null,
      calibrationApplied: pending?.calibrationApplied || null,
      recoveryStep: pending?.recoveryStep ?? null,
      recoverySteps: pending?.recoverySteps ?? null,
      recoveryMultiplier: pending?.recoveryMultiplier ?? null,
      recoveryScopeStrategyId: pending?.recoveryScopeStrategyId || null,
      recoveryScopeAsset: pending?.recoveryScopeAsset || null,
      recoveryFollowSignal: pending?.recoveryFollowSignal === true,
      parentRequestId: pending?.parentRequestId || null,
      recoveryBranchRootId: pending?.recoveryBranchRootId || null,
      baseAmount: pending?.baseAmount ?? null,
      resolved: false,
      brokerDealId: null
    });
    clampArray(outgoingOrders, 150);
  }

  function matchOutgoingOrder(fields) {
    const unresolved = outgoingOrders.filter((item) => !item.resolved && Date.now() - item.sentAt < 30000);
    let match = null;
    if (fields.requestId) {
      match = unresolved.find((item) => item.requestId === fields.requestId) || null;
      // An explicit broker/client id that does not match must not fall through to
      // asset/amount FIFO and claim another concurrent recovery branch.
      if (!match) return null;
    }
    if (!match && fields.asset && fields.amount != null) {
      const candidates = unresolved.filter((item) =>
        item.asset === fields.asset
        && Number(item.amount) === Number(fields.amount)
        && (!fields.action || item.action === fields.action)
        && (fields.duration == null || item.duration == null || Number(item.duration) === Number(fields.duration))
      );
      if (candidates.length === 1) match = candidates[0];
      else if (candidates.length > 1) return null;
    }
    if (!match) {
      const candidates = unresolved.filter((item) => item.source !== 'page' && item.requestId && pendingTrades.has(item.requestId));
      if (candidates.length === 1) match = candidates[0];
      else if (candidates.length > 1) return null;
    }
    if (!match && unresolved.length === 1) match = unresolved[0];
    if (match) match.resolved = true;
    return match;
  }

  function finishPending(pending, result) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingTrades.delete(pending.requestId);
    const normalized = {
      ...result,
      requestId: meaningfulRequestId(result.requestId) || meaningfulRequestId(pending.requestId),
      asset: result.asset || pending.asset,
      amount: result.amount ?? pending.amount,
      action: result.action || pending.action,
      duration: result.duration ?? pending.duration,
      strategyId: result.strategyId || pending.strategyId || null,
      signalConfidence: result.signalConfidence ?? pending.signalConfidence ?? null,
      signalPayout: result.signalPayout ?? pending.signalPayout ?? null,
      signalExpiration: result.signalExpiration ?? pending.signalExpiration ?? result.duration ?? pending.duration ?? null,
      calibrationApplied: result.calibrationApplied || pending.calibrationApplied || null,
      recoveryStep: result.recoveryStep ?? pending.recoveryStep ?? null,
      recoverySteps: result.recoverySteps ?? pending.recoverySteps ?? null,
      recoveryMultiplier: result.recoveryMultiplier ?? pending.recoveryMultiplier ?? null,
      recoveryScopeStrategyId: result.recoveryScopeStrategyId || pending.recoveryScopeStrategyId || null,
      recoveryScopeAsset: result.recoveryScopeAsset || pending.recoveryScopeAsset || null,
      recoveryFollowSignal: result.recoveryFollowSignal === true || pending.recoveryFollowSignal === true,
      parentRequestId: result.parentRequestId || pending.parentRequestId || null,
      recoveryBranchRootId: result.recoveryBranchRootId || pending.recoveryBranchRootId || null,
      baseAmount: result.baseAmount ?? pending.baseAmount ?? null,
      sentAt: result.sentAt ?? pending.sentAt ?? null,
      source: result.source || pending.source || 'extension',
      robotTrade: String(result.source || pending.source || '').toLowerCase() === 'autotrade'
    };
    rememberTradeResult(normalized);
    if (typeof pending.resolve === 'function') {
      pending.resolve({ ok: normalized.status === 'success', confirmed: normalized.status === 'success', result: normalized, error: normalized.error || null });
      pending.resolve = null;
    }
  }

  function applyExecutionReportedPayout(assetValue, payoutValue, durationValue = null) {
    const symbol = normalizeAsset(assetValue);
    let payout = safeNumber(payoutValue);
    if (!symbol || payout == null || payout <= 0) return false;
    if (payout <= 1) payout *= 100;
    if (payout <= 0 || payout > 100) return false;
    const updatedAt = nowIso();
    const existing = assets.get(symbol) || {};
    const candidates = Array.isArray(existing.payoutCandidates) ? existing.payoutCandidates.slice(0, 20) : [];
    candidates.push(Math.round(payout * 100) / 100);
    const unique = [...new Set(candidates)].filter((value) => value > 0 && value <= 100).slice(-20);
    assets.set(symbol, {
      ...existing,
      payout: unique[unique.length - 1] ?? Math.max(...unique),
      payoutCandidates: unique,
      payoutSource: 'execution_open',
      payoutUpdatedAt: updatedAt,
      lastExecutionDuration: safeNumber(durationValue) ?? existing.lastExecutionDuration ?? null,
    });
    assetCatalogRevision += 1;
    const sub = subscriptionData.get(symbol);
    if (sub) {
      sub.payout = unique[unique.length - 1] ?? Math.max(...unique);
      sub.payoutCandidates = unique;
      sub.payoutSource = 'execution_open';
      sub.payoutUpdatedAt = updatedAt;
      sub.lastExecutionDuration = safeNumber(durationValue) ?? sub.lastExecutionDuration ?? null;
    }
    return true;
  }

  function resolveTradeSuccess(payload) {
    const fields = extractOrderFields(payload);
    const outgoing = matchOutgoingOrder(fields);
    const requestId = fields.requestId || outgoing?.requestId || null;
    const result = {
      status: 'success',
      time: nowIso(),
      requestId,
      dealId: fields.dealId,
      asset: fields.asset || outgoing?.asset || null,
      amount: fields.amount ?? outgoing?.amount ?? null,
      action: fields.action || outgoing?.action || null,
      duration: fields.duration ?? outgoing?.duration ?? null,
      source: outgoing?.source || 'page',
      robotTrade: String(outgoing?.source || '').toLowerCase() === 'autotrade',
      strategyId: outgoing?.strategyId || null,
      signalConfidence: outgoing?.signalConfidence ?? null,
      signalPayout: outgoing?.signalPayout ?? null,
      signalExpiration: outgoing?.signalExpiration ?? null,
      calibrationApplied: outgoing?.calibrationApplied || null,
      recoveryStep: outgoing?.recoveryStep ?? null,
      recoverySteps: outgoing?.recoverySteps ?? null,
      recoveryMultiplier: outgoing?.recoveryMultiplier ?? null,
      recoveryScopeStrategyId: outgoing?.recoveryScopeStrategyId || null,
      recoveryScopeAsset: outgoing?.recoveryScopeAsset || null,
      recoveryFollowSignal: outgoing?.recoveryFollowSignal === true,
      parentRequestId: outgoing?.parentRequestId || null,
      recoveryBranchRootId: outgoing?.recoveryBranchRootId || null,
      baseAmount: outgoing?.baseAmount ?? null,
      sentAt: outgoing?.sentAt ?? null
    };

    const pending = requestId ? pendingTrades.get(requestId) : null;
    const fallbackPending = pending || (outgoing?.requestId ? pendingTrades.get(outgoing.requestId) : null);
    result.strategyId = result.strategyId || fallbackPending?.strategyId || null;
    result.signalConfidence = result.signalConfidence ?? fallbackPending?.signalConfidence ?? null;
    const brokerOpenPayout = safeNumber(findDeep(payload, ['percentProfit', 'percent_profit', 'payout']));
    if (brokerOpenPayout != null) applyExecutionReportedPayout(result.asset, brokerOpenPayout, result.duration ?? fallbackPending?.duration ?? null);
    result.signalPayout = result.signalPayout ?? fallbackPending?.signalPayout ?? brokerOpenPayout ?? null;
    result.currentPayout = brokerOpenPayout ?? null;
    result.currentPayoutSource = brokerOpenPayout != null ? 'execution_open' : null;
    result.currentPayoutVerified = brokerOpenPayout != null;
    result.signalExpiration = result.signalExpiration ?? fallbackPending?.signalExpiration ?? result.duration ?? null;
    result.calibrationApplied = result.calibrationApplied || fallbackPending?.calibrationApplied || null;
    const optimisticDeal = buildOptimisticOpenDeal(result, payload, outgoing, fallbackPending);
    if (optimisticDeal) mergeDeals('open', [optimisticDeal], { replace: false });
    if (pending) finishPending(pending, result);
    else if (outgoing?.requestId && pendingTrades.has(outgoing.requestId)) {
      finishPending(pendingTrades.get(outgoing.requestId), result);
    } else {
      rememberTradeResult(result);
    }
    emitState(true);
  }

  function resolveTradeFailure(payload) {
    const fields = extractOrderFields(payload);
    const outgoing = matchOutgoingOrder(fields);
    const requestId = fields.requestId || outgoing?.requestId || null;
    const error = String(findDeep(payload, ['error', 'message', 'reason', 'description']) ?? 'Сервер отклонил сделку');
    const result = {
      status: 'failed',
      time: nowIso(),
      requestId,
      asset: fields.asset || outgoing?.asset || null,
      amount: fields.amount ?? outgoing?.amount ?? null,
      action: fields.action || outgoing?.action || null,
      duration: fields.duration ?? outgoing?.duration ?? null,
      error,
      source: outgoing?.source || 'page',
      robotTrade: String(outgoing?.source || '').toLowerCase() === 'autotrade',
      strategyId: outgoing?.strategyId || null,
      signalConfidence: outgoing?.signalConfidence ?? null,
      signalPayout: outgoing?.signalPayout ?? null,
      signalExpiration: outgoing?.signalExpiration ?? null,
      calibrationApplied: outgoing?.calibrationApplied || null,
      recoveryStep: outgoing?.recoveryStep ?? null,
      recoverySteps: outgoing?.recoverySteps ?? null,
      recoveryMultiplier: outgoing?.recoveryMultiplier ?? null,
      recoveryScopeStrategyId: outgoing?.recoveryScopeStrategyId || null,
      recoveryScopeAsset: outgoing?.recoveryScopeAsset || null,
      recoveryFollowSignal: outgoing?.recoveryFollowSignal === true,
      parentRequestId: outgoing?.parentRequestId || null,
      recoveryBranchRootId: outgoing?.recoveryBranchRootId || null,
      baseAmount: outgoing?.baseAmount ?? null,
      sentAt: outgoing?.sentAt ?? null
    };

    const pending = requestId ? pendingTrades.get(requestId) : null;
    result.strategyId = result.strategyId || pending?.strategyId || null;
    result.signalConfidence = result.signalConfidence ?? pending?.signalConfidence ?? null;
    result.signalPayout = result.signalPayout ?? pending?.signalPayout ?? null;
    result.signalExpiration = result.signalExpiration ?? pending?.signalExpiration ?? result.duration ?? null;
    result.calibrationApplied = result.calibrationApplied || pending?.calibrationApplied || null;
    if (pending) finishPending(pending, result);
    else if (outgoing?.requestId && pendingTrades.has(outgoing.requestId)) {
      finishPending(pendingTrades.get(outgoing.requestId), result);
    } else {
      rememberTradeResult(result);
    }
  }

  function handleAuth(payload, socket) {
    if (!payload || typeof payload !== 'object') return;
    const meta = socketMeta.get(socket);
    if (!meta) return;
    meta.authPayload = payload;
    meta.authenticated = true;
    meta.authenticatedAt = nowIso();
    const roles = classifyAuthPayload(payload);
    meta.accountAuth = Boolean(roles.account);
    meta.marketAuth = Boolean(roles.market);
    markTradingSocket(socket, 'auth');
    emitOfficialAuthCandidate(payload, meta);
    if (!meta.internalScanner && meta.marketAuth && (!activeMarketSocket || !isSocketHealthy(activeMarketSocket))) activeMarketSocket = socket;
    if (!socketHasAccountCapability(meta) && isGuestTryDemoContext() && meta.tradingHost) {
      armLoginUpgrade('guest_try_demo_ready');
      emitState(true);
    }
    if (socketHasAccountCapability(meta) && (manualConnectionRequested || isLoginUpgradeArmed())) {
      if (!tryAdoptAuthorizedSocket(socket, 'account_auth_captured') && manualConnectionRequested && (!activeTradingSocket || activeTradingSocket.readyState !== SOCKET_OPEN)) {
        tryAdoptReplacementSocket('auth_captured');
      }
    } else if (manualConnectionRequested && socket === activeTradingSocket) {
      applySelectedSocketToPublic(socket);
    }
  }

  function handleSocketEvent(direction, event, payload, socket) {
    const meta = socketMeta.get(socket);
    markTradingSocket(socket, event);
    if (meta && /updateStream|updateHistory|history|loadHistoryPeriod|changeSymbol|subfor/i.test(String(event || ''))) {
      meta.marketEvents = Number(meta.marketEvents || 0) + 1;
      meta.marketAuth = true;
      if (!meta.internalScanner && (!activeMarketSocket || !isSocketHealthy(activeMarketSocket))) activeMarketSocket = socket;
    }
    recordEvent(direction, event, payload, socket);

    // Currency is not guaranteed to arrive with successupdateBalance. Pocket
    // frequently includes it only in opened/closed deal payloads or other account
    // events. Learn it from every broker event, but publish it only for the active
    // manually connected execution socket.
    const observedCurrency = eventCanCarryAccountCurrency(event) ? extractCurrency(payload) : null;
    if (observedCurrency && meta) meta.lastCurrency = observedCurrency;
    if (observedCurrency && manualConnectionRequested && socket === activeTradingSocket) {
      state.account.currency = normalizeCurrencyCode(observedCurrency) || observedCurrency;
    }

    if (direction === 'out' && event === 'auth') handleAuth(payload, socket);

    if (direction === 'in' && (event === 'successauth' || event === 'auth/success')) {
      if (meta) {
        meta.authConfirmed = true;
        meta.authenticated = true;
        meta.authenticatedAt = meta.authenticatedAt || nowIso();
      }
      if (!meta?.internalScanner && meta?.marketAuth && (!activeMarketSocket || !isSocketHealthy(activeMarketSocket))) activeMarketSocket = socket;
      if (meta && !socketHasAccountCapability(meta) && isGuestTryDemoContext() && meta.tradingHost) {
        armLoginUpgrade('guest_try_demo_confirmed');
      }
      if (meta && socketHasAccountCapability(meta) && (manualConnectionRequested || isLoginUpgradeArmed())) {
        if (!tryAdoptAuthorizedSocket(socket, 'account_auth_confirmed') && manualConnectionRequested && (!activeTradingSocket || activeTradingSocket.readyState !== SOCKET_OPEN)) {
          tryAdoptReplacementSocket('auth_confirmed');
        }
      }
      if (manualConnectionRequested && socket === activeTradingSocket) {
        state.socket.authenticated = true;
        state.socket.authenticatedAt = state.socket.authenticatedAt || nowIso();
        state.connection.connected = true;
        state.connection.reconnecting = false;
        state.connection.lastError = null;
      }
    }

    if (event === 'successupdateBalance') {
      const balance = extractBalance(payload);
      const currency = extractCurrency(payload);
      if (meta) {
        if (balance != null) {
          meta.lastBalance = balance;
          meta.lastBalanceAt = nowIso();
        }
        if (currency) meta.lastCurrency = currency;
      }
      if (manualConnectionRequested && socket === activeTradingSocket) {
        if (balance != null) {
          state.account.balance = balance;
          state.account.balanceUpdatedAt = nowIso();
        }
        if (currency) state.account.currency = normalizeCurrencyCode(currency) || currency;
      }
    }

    if (direction === 'in' && (event === 'successChangeSymbol' || event === 'successSubfor')) {
      if (manualConnectionRequested && socket === activeTradingSocket && state.market.subscriptionRequested) {
        state.market.subscriptionAcknowledgedAt = nowIso();
      }
    }

    if (direction === 'out' && event === 'openOrder' && manualConnectionRequested && socket === activeTradingSocket) {
      registerOutgoingOrder(payload);
      const requestId = String(payload?.requestId || '');
      const pending = requestId ? pendingTrades.get(requestId) : null;
      state.trades.lastRequest = {
        time: nowIso(),
        requestId: payload?.requestId ?? null,
        asset: payload?.asset ?? null,
        amount: payload?.amount ?? null,
        action: payload?.action ?? null,
        duration: payload?.time ?? null,
        isDemo: payload?.isDemo ?? null,
        source: pending?.source || (pending ? 'extension' : 'page'),
        strategyId: pending?.strategyId || null,
        signalConfidence: pending?.signalConfidence ?? null,
        signalPayout: pending?.signalPayout ?? null,
        signalExpiration: pending?.signalExpiration ?? payload?.time ?? null,
        calibrationApplied: pending?.calibrationApplied || null,
        recoveryStep: pending?.recoveryStep ?? null,
        recoverySteps: pending?.recoverySteps ?? null,
        recoveryMultiplier: pending?.recoveryMultiplier ?? null,
        recoveryScopeStrategyId: pending?.recoveryScopeStrategyId || null,
        recoveryScopeAsset: pending?.recoveryScopeAsset || null,
        recoveryFollowSignal: pending?.recoveryFollowSignal === true,
        parentRequestId: pending?.parentRequestId || null,
        recoveryBranchRootId: pending?.recoveryBranchRootId || null,
        baseAmount: pending?.baseAmount ?? null
      };
    }

    if (manualConnectionRequested && socket === activeTradingSocket) {
      if (direction === 'in' && event === 'successopenOrder') resolveTradeSuccess(payload);
      if (direction === 'in' && event === 'failopenOrder') resolveTradeFailure(payload);

      if (/openedDeals/i.test(event)) {
        mergeDeals('open', extractDealList(payload, false), { replace: true });
      }
      if (/closedDeals/i.test(event) || /successcloseOrder/i.test(event)) {
        mergeDeals('closed', extractDealList(payload, true));
      }
    }

    if (/asset/i.test(event) && (meta?.tradingHost || meta?.trading)) {
      const beforeSymbols = new Set(assets.keys());
      const seenSymbols = detectAssetInfo(payload) || new Set();
      // Only a sufficiently complete broker catalogue may provide negative evidence
      // for symbols that disappeared. One partial update must never disable dozens of
      // valid pairs, so missing symbols need two consecutive full-ish refreshes.
      const minimumAuthoritativeSize = Math.max(10, Math.ceil(beforeSymbols.size * 0.50));
      const authoritativeRefresh = /updateAssets|assets_list/i.test(event)
        && seenSymbols.size >= minimumAuthoritativeSize;
      const newlyUnavailable = new Set(
        [...seenSymbols].filter((symbol) => assets.get(symbol)?.active === false)
      );

      for (const symbol of seenSymbols) assetCatalogMissCounts.delete(symbol);
      if (authoritativeRefresh) {
        for (const symbol of beforeSymbols) {
          if (seenSymbols.has(symbol)) continue;
          const misses = Number(assetCatalogMissCounts.get(symbol) || 0) + 1;
          assetCatalogMissCounts.set(symbol, misses);
          if (misses < 2) continue;
          const info = assets.get(symbol);
          // Never rewrite an explicit broker state as inferred state.
          if (info && info.active !== false) {
            assets.set(symbol, {
              ...info,
              active: false,
              availabilitySource: 'catalog_missing',
              availabilityUpdatedAt: nowIso()
            });
            assetCatalogRevision += 1;
          }
          if (assets.get(symbol)?.active === false) newlyUnavailable.add(symbol);
        }
      }
      if (newlyUnavailable.size) {
        purgeUnavailableRuntimeAssets(newlyUnavailable, authoritativeRefresh ? 'catalog_refresh_confirmed' : 'explicit_unavailable');
      }
    }

    if (meta?.internalScanner && direction === 'in' && meta.authPayload && event !== 'auth') {
      const lane = scannerLaneForSocket(socket) || scannerLane(meta.scannerPeriod || state.market.period, true);
      lane.socket = socket;
      lane.ready = true;
      lane.lastError = null;
      updateScannerAggregateState();
    }
    const selected = manualConnectionRequested && state.connection.connected
      && (meta?.internalScanner === true || socket === activeMarketSocket || socket === activeTradingSocket);
    // updateStream содержит цены только видимого графика. chafor — это payout/доступность,
    // поэтому дополнительные активы обновляются безопасным циклическим запросом истории.
    if (direction === 'in' && event === 'chafor') {
      const changed = applyChaforPayout(payload);
      const now = Date.now();
      if (changed && now - lastChaforStateEmitAt >= 1000) {
        lastChaforStateEmitAt = now;
        emitState();
      }
      return;
    }
    const streamEvent = /updateStream|updateHistory|history|loadHistoryPeriod/i.test(event);
    if (selected && streamEvent) {
      const historyLike = /history|loadHistoryPeriod/i.test(event) && event !== 'updateStream';
      const payloadAsset = normalizeAsset(findDeep(payload, ['asset', 'symbol']));
      // Correlate the response only with an index that is actually pending. This
      // avoids taking an unrelated nested candle field named `index` and assigning
      // history to the wrong pair when many requests are active at once.
      const pendingHistory = pendingHistoryFromPayload(payload, payloadAsset, socket);
      if (historyLike && !payloadAsset && !pendingHistory) {
        // With several requests in flight, a packet without asset and without the
        // echoed request index cannot be associated safely. Drop it; the stale-request
        // cleanup will request that pair again without poisoning another chart.
        addError(new Error('Неоднозначный ответ истории без пары/index'), 'history-correlation');
        emitState();
        return;
      }
      const fallbackAsset = payloadAsset || pendingHistory?.asset || state.market.asset || state.market.selectedAssets?.[0] || null;
      const fallbackPeriod = pendingHistory?.period || safeNumber(findDeep(payload, ['period', 'timeframe'])) || state.market.period;
      let ticks = extractTicks(payload, fallbackAsset);
      let candles = extractCandles(payload, fallbackAsset, fallbackPeriod);
      const selectedSet = new Set(state.market.selectedAssets || []);
      ticks = ticks.filter((item) => !item.asset || assets.get(item.asset)?.active !== false);
      candles = candles.filter((item) => !item.asset || assets.get(item.asset)?.active !== false);
      if (selectedSet.size) {
        ticks = ticks.filter((item) => !item.asset || selectedSet.has(item.asset));
        candles = candles.filter((item) => !item.asset || selectedSet.has(item.asset));
      }

      if (historyLike) {
        // updateHistoryNewFast is normally tick history: [timestamp, price].
        // Build real OHLC candles before sending data to strategies. Raw tick pairs
        // were the second reason only the visible live asset could be analysed.
        const aggregatedCandles = aggregateTicksToCandles(ticks, fallbackPeriod);
        const byAsset = new Map();
        for (const item of [...candles, ...aggregatedCandles]) {
          const asset = item.asset || fallbackAsset;
          if (!asset) continue;
          if (!byAsset.has(asset)) byAsset.set(asset, new Map());
          byAsset.get(asset).set(Number(item.time), item);
        }
        const ticksByAsset = new Map();
        for (const tick of ticks) {
          const asset = tick.asset || fallbackAsset;
          if (!asset) continue;
          if (!ticksByAsset.has(asset)) ticksByAsset.set(asset, []);
          ticksByAsset.get(asset).push(tick);
        }
        for (const [asset, candleMap] of byAsset) {
          const sub = getSubscription(asset, fallbackPeriod);
          const items = [...candleMap.values()].sort((a, b) => Number(a.time) - Number(b.time));
          if (!sub || !items.length) continue;
          mergeHistoryItems(sub, items.slice(-MAX_HISTORY_ITEMS));
          mergeHistoryTicks(sub, ticksByAsset.get(asset) || []);
          sub.subscribed = true;
          sub.streamUpdatedAt = nowIso();
          emitMarketSnapshot(asset, true, true, fallbackPeriod);
          if (pendingHistory?.scanner && asset === pendingHistory.asset) {
            multiAssetScanResponses += 1;
            lastMultiAssetScanAsset = asset;
          }
        }
        if (pendingHistory) {
          historyRequests.delete(pendingHistory.index);
          maybeReleaseHistoryLane(pendingHistory.period);
          if (Number(pendingHistory.attempts || 0) > 0) {
            // A retry can be satisfied by the delayed first response. Keep the queue
            // empty briefly so the actual retry response cannot attach to the next pair.
            historyQueueBlockedUntil = Math.max(historyQueueBlockedUntil, Date.now() + HISTORY_LATE_RESPONSE_GUARD_MS);
          }
        }
        scheduleHistoryQueue(Number(pendingHistory?.attempts || 0) > 0 ? HISTORY_LATE_RESPONSE_GUARD_MS : 10);
        syncPrimaryMarket();
      } else {
        if (ticks.length) {
          applyTicks(ticks);
          for (const asset of new Set(ticks.map((item) => item.asset).filter(Boolean))) emitMarketSnapshot(asset);
        }
        if (candles.length) {
          if (!ticks.length) applySyntheticTicksFromCandles(candles);
          applyServerCandles(candles, false);
          for (const asset of new Set(candles.map((item) => item.asset).filter(Boolean))) emitMarketSnapshot(asset);
        }
      }
    }
    emitState();
  }

  async function rawToText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) {
      try { return new TextDecoder().decode(data); } catch { return null; }
    }
    if (ArrayBuffer.isView(data)) {
      try { return new TextDecoder().decode(data); } catch { return null; }
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      try { return await data.text(); } catch { return null; }
    }
    return null;
  }

  async function processRaw(data, direction, socket) {
    const activityAt = Date.now();
    if (direction === 'in') state.socket.lastIncomingAt = nowIso();
    else state.socket.lastOutgoingAt = nowIso();

    const meta = socketMeta.get(socket);
    if (meta) {
      if (direction === 'in') meta.lastIncomingAtMs = activityAt;
      else meta.lastOutgoingAtMs = activityAt;
    }
    const isAttachmentData = typeof data !== 'string';
    const text = await rawToText(data);
    if (!text) return;

    if (isAttachmentData && direction === 'in' && meta?.pendingAttachmentFrame) {
      let attachment;
      try {
        attachment = JSON.parse(text);
      } catch {
        attachment = text;
      }
      meta.pendingAttachmentFrame.attachments.push(attachment);
      if (meta.pendingAttachmentFrame.attachments.length >= meta.pendingAttachmentFrame.expected) {
        const pendingFrame = meta.pendingAttachmentFrame;
        meta.pendingAttachmentFrame = null;
        const packet = replaceAttachmentPlaceholders(pendingFrame.frame.packet, pendingFrame.attachments);
        const event = packet?.[0];
        const payload = packet?.[1];
        if (typeof event === 'string') handleSocketEvent(direction, event, payload, socket);
      }
      return;
    }

    const frame = parseSocketIoFrame(text);
    if (frame) {
      if (direction === 'out' && frame.event === 'auth' && meta) meta.authRaw = text;
      const placeholders = countAttachmentPlaceholders(frame.packet);
      if (direction === 'in' && (frame.attachmentCount > 0 || placeholders > 0)) {
        if (meta) {
          meta.pendingAttachmentFrame = {
            frame,
            attachments: [],
            expected: Math.max(1, frame.attachmentCount || placeholders),
            createdAt: Date.now()
          };
        }
        return;
      }
      handleSocketEvent(direction, frame.event, frame.payload, socket);
      return;
    }

    if (text === '40' || text.startsWith('0{')) {
      recordEvent(direction, text === '40' ? 'socketConnected' : 'engineHandshake', null, socket);
      if (meta?.tradingHost) state.socket.discovered = true;
      emitState();
    }
  }

  function registerSocket(socket, url, options = {}) {
    if (!socket || socketMeta.has(socket)) return socket;
    const meta = {
      url: String(url || ''),
      internalScanner: Boolean(options.internalScanner),
      scannerPeriod: options.scannerPeriod != null ? scannerPeriodKey(options.scannerPeriod) : null,
      host: safeHost(url),
      pocket: isPocketSocketUrl(url),
      tradingHost: isTradingSocketHost(url),
      trading: isTradingSocketHost(url),
      authenticated: false,
      authConfirmed: false,
      authPayload: null,
      authRaw: null,
      accountAuth: false,
      marketAuth: false,
      marketEvents: 0,
      score: 0,
      lastTradingEventAt: 0,
      lastBalance: null,
      lastBalanceAt: null,
      lastCurrency: null,
      pendingAttachmentFrame: null,
      createdAt: nowIso(),
      createdAtMs: Date.now(),
      openedAt: null,
      openedAtMs: 0,
      lastIncomingAtMs: 0,
      lastOutgoingAtMs: 0
    };
    socketMeta.set(socket, meta);
    sockets.add(socket);
    if (meta.pocket) state.socket.pocketObserved += 1;
    if (meta.tradingHost) state.socket.discovered = true;

    socket.addEventListener('open', () => {
      meta.openedAt = nowIso();
      meta.openedAtMs = Date.now();
      meta.lastIncomingAtMs = meta.openedAtMs;
      if (meta.tradingHost) state.socket.discovered = true;
      recordEvent('in', 'websocketOpen', { host: meta.host }, socket);
      if (manualConnectionRequested && meta.tradingHost && !meta.internalScanner) scheduleSocketRecovery(true);
      emitState(true);
    });

    socket.addEventListener('message', (event) => {
      void processRaw(event.data, 'in', socket).catch((error) => addError(error, 'incoming-message'));
    });

    socket.addEventListener('close', (event) => {
      recordEvent('in', 'websocketClose', { code: event.code, reason: event.reason || null }, socket);
      if (meta.internalScanner) {
        const lane = scannerLaneForSocket(socket) || scannerLane(meta.scannerPeriod || state.market.period, true);
        lane.socket = null;
        lane.ready = false;
        lane.authSent = false;
        lane.namespaceSent = false;
        const suppressReconnect = intentionallyClosedScannerSockets.has(socket) || lane.suppressReconnect === true;
        intentionallyClosedScannerSockets.delete(socket);
        lane.lastError = suppressReconnect ? null : (event.reason || `Scanner WebSocket TF ${lane.period} закрыт (${event.code})`);
        lane.suppressReconnect = false;
        if (suppressReconnect) scannerSocketLanes.delete(SHARED_SCANNER_LANE_KEY);
        updateScannerAggregateState();
        if (!suppressReconnect && manualConnectionRequested && desiredSubscriptionPlan.active) scheduleScannerSocketReconnect(lane.period, 900);
      }
      if (socket === activeMarketSocket) {
        activeMarketSocket = null;
      }
      if (socket === activeTradingSocket) {
        state.socket.readyState = socket.readyState;
        state.socket.lastCloseAt = nowIso();
        state.socket.closeCode = event.code;
        state.socket.closeReason = event.reason || null;
        activeTradingSocket = null;
        if (manualConnectionRequested && isPocketTabBackgrounded() && hasFrozenAccountContext()) {
          freezeConnectionForBackground('socket_close_background');
        } else {
          state.socket.authenticated = false;
          state.connection.connected = false;
          state.connection.reconnecting = manualConnectionRequested;
          state.connection.disconnectedAt = nowIso();
          state.connection.lastError = manualConnectionRequested
            ? 'Торговый поток обновляется. Выполняется автоматическое переподключение…'
            : (event.reason || `WebSocket закрыт (${event.code})`);
          subscriptionQueueToken += 1;
          closeScannerSocket('Торговый WebSocket сменился');
          markSubscriptionsReconnecting();
          if (manualConnectionRequested && !tryAdoptReplacementSocket('socket_close_handover')) scheduleSocketRecovery(true);
        }
      }
      sockets.delete(socket);
      if (manualConnectionRequested && !activeMarketSocket) activeMarketSocket = chooseMarketSocket() || activeTradingSocket;
      emitState(true);
    });

    socket.addEventListener('error', () => {
      recordEvent('in', 'websocketError', { host: meta.host }, socket);
      emitState();
    });

    emitState();
    return socket;
  }

  function installWebSocketHook() {
    if (typeof NativeWebSocket !== 'function' || typeof nativeSend !== 'function') {
      addError('WebSocket API недоступен', 'install-hook');
      return;
    }

    function WrappedWebSocket(...args) {
      const target = new.target || NativeWebSocket;
      const socket = Reflect.construct(NativeWebSocket, args, target === WrappedWebSocket ? NativeWebSocket : target);
      return registerSocket(socket, args[0]);
    }

    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try { Object.defineProperty(WrappedWebSocket, key, { value: NativeWebSocket[key] }); } catch {}
    }

    NativeWebSocket.prototype.send = function patchedSend(data) {
      if (!socketMeta.has(this)) registerSocket(this, this.url || '');
      void processRaw(data, 'out', this).catch((error) => addError(error, 'outgoing-message'));
      return nativeSend.call(this, data);
    };

    window.WebSocket = WrappedWebSocket;
  }

  function cloneScannerAuthPayload() {
    const source = socketMeta.get(activeTradingSocket)?.authPayload;
    if (!source || typeof source !== 'object') return null;
    let payload;
    try {
      payload = typeof structuredClone === 'function' ? structuredClone(source) : JSON.parse(JSON.stringify(source));
    } catch {
      payload = { ...source };
    }
    payload.isFastHistory = true;
    return payload;
  }

  function scannerAuthPacket() {
    const payload = cloneScannerAuthPayload();
    return payload ? `42["auth",${JSON.stringify(payload)}]` : null;
  }

  function closeScannerSocket(reason = 'manual', period = null) {
    const lane = scannerLane(period, false);
    if (!lane) return;
    if (lane.reconnectTimer) {
      clearTimeout(lane.reconnectTimer);
      lane.reconnectTimer = null;
    }
    const socket = lane.socket;
    lane.socket = null;
    lane.ready = false;
    lane.authSent = false;
    lane.namespaceSent = false;
    lane.createdAt = 0;
    if (!['logical_disconnect','manual','page_unload','history_bootstrap_complete'].includes(reason)) lane.lastError = reason;
    lane.suppressReconnect = reason === 'history_bootstrap_complete';
    if (socket && socket.readyState < 2) {
      intentionallyClosedScannerSockets.add(socket);
      try { socket.close(1000, 'Pocket TRADE ROBOT scanner restart'); } catch {}
    }
    if (period == null || ['logical_disconnect','manual','page_unload'].includes(reason)) scannerSocketLanes.clear();
    updateScannerAggregateState();
  }

  function scheduleScannerSocketReconnect(period = state.market.period, delay = 900) {
    const lane = scannerLane(period, true);
    if (lane.reconnectTimer || !manualConnectionRequested || !desiredSubscriptionPlan.active) return;
    lane.reconnectTimer = setTimeout(() => {
      lane.reconnectTimer = null;
      ensureScannerSocket(lane.period);
      scheduleHistoryQueue(40);
    }, Math.max(500, Number(delay) || 1200));
  }

  function handleScannerTransportMessage(socket, raw) {
    const lane = scannerLaneForSocket(socket);
    if (!lane || typeof raw !== 'string') return;
    if (raw === '2') {
      try { nativeSend.call(socket, '3'); } catch {}
      return;
    }
    if (raw.startsWith('0') && !lane.namespaceSent) {
      lane.namespaceSent = true;
      try { nativeSend.call(socket, '40'); } catch (error) {
        lane.lastError = String(error?.message || error);
        updateScannerAggregateState();
      }
      return;
    }
    if ((raw === '40' || raw.startsWith('40{')) && !lane.authSent) {
      const packet = scannerAuthPacket();
      if (!packet) {
        lane.lastError = 'Не удалось сформировать пакет авторизации сканера';
        updateScannerAggregateState();
        return;
      }
      lane.authSent = true;
      try {
        void processRaw(packet, 'out', socket).catch((error) => addError(error, 'scanner-auth'));
        nativeSend.call(socket, packet);
      } catch (error) {
        lane.lastError = String(error?.message || error);
        updateScannerAggregateState();
      }
    }
  }

  function ensureScannerSocket(period = state.market.period) {
    const normalizedPeriod = scannerPeriodKey(period);
    const lane = scannerLane(normalizedPeriod, true);
    lane.suppressReconnect = false;
    if (!manualConnectionRequested || !activeTradingSocket) return null;
    if (lane.socket && lane.ready && isSocketHealthy(lane.socket, 90000)) return lane.socket;
    if (lane.socket && lane.socket.readyState <= SOCKET_OPEN && Date.now() - lane.createdAt < 15000) return lane.socket;
    if (lane.socket) closeScannerSocket('Перезапуск единого рыночного сканера');

    const tradingMeta = socketMeta.get(activeTradingSocket);
    if (!tradingMeta?.url || !tradingMeta?.authPayload) {
      lane.lastError = 'Нет URL или авторизации для единого рыночного сканера';
      updateScannerAggregateState();
      return null;
    }

    try {
      const socket = registerSocket(new NativeWebSocket(tradingMeta.url), tradingMeta.url, { internalScanner: true, scannerPeriod: normalizedPeriod });
      lane.socket = socket;
      lane.ready = false;
      lane.authSent = false;
      lane.namespaceSent = false;
      lane.createdAt = Date.now();
      lane.lastError = null;
      try { socket['bin' + 'aryType'] = activeTradingSocket['bin' + 'aryType'] || 'arraybuffer'; } catch {}
      socket.addEventListener('message', (event) => handleScannerTransportMessage(socket, event.data));
      socket.addEventListener('error', () => {
        if (lane.socket !== socket) return;
        lane.lastError = 'Ошибка единого рыночного WebSocket истории';
        updateScannerAggregateState();
      });
      updateScannerAggregateState();
      return null;
    } catch (error) {
      lane.lastError = String(error?.message || error);
      updateScannerAggregateState();
      scheduleScannerSocketReconnect(normalizedPeriod, 1500);
      return null;
    }
  }

  function sendSocketPacket(socket, event, payload) {
    if (!socket || socket.readyState !== SOCKET_OPEN) throw new Error('Рыночный сканер не подключён');
    const packet = payload === undefined
      ? `42[${JSON.stringify(event)}]`
      : `42[${JSON.stringify(event)},${JSON.stringify(payload)}]`;
    socket.send(packet);
    return packet;
  }

  function requireAuthenticatedSocket() {
    if (!manualConnectionRequested) {
      throw new Error('Сначала нажмите «Подключить аккаунт» в расширении.');
    }
    const currentMeta = activeTradingSocket ? socketMeta.get(activeTradingSocket) : null;
    if (currentMeta?.internalScanner) {
      // Defensive runtime migration: an already-running old build may have promoted
      // the scanner before this patch loaded. Drop that execution reference and
      // immediately hand over to a real browser account socket.
      activeTradingSocket = null;
      state.connection.connected = false;
      state.connection.reconnecting = true;
      state.connection.lastError = 'Переключаем исполнение на основной WebSocket аккаунта…';
    }
    if (!isExecutionSocketHealthy(activeTradingSocket) || !state.connection.connected) {
      tryAdoptReplacementSocket('command_recovery');
    }
    const hiddenHold = hasFrozenAccountContext() && (isPocketTabBackgrounded() || state.connection.backgroundPaused);
    if (!isExecutionSocketHealthy(activeTradingSocket, hiddenHold ? BACKGROUND_SOCKET_HOLD_MS : SOCKET_STALE_MS)) {
      scheduleSocketRecovery(true);
      throw new Error('Торговый поток переподключается. Повторите действие через несколько секунд.');
    }
    const meta = socketMeta.get(activeTradingSocket);
    if (!meta?.authPayload || meta.internalScanner || !socketHasAccountCapability(meta)) {
      throw new Error('Мост терминала временно не видит авторизацию аккаунта. Нажмите «Подключить аккаунт» в расширении и повторите действие. Если WebSocket, авторизация, тики и свечи идут — вкладку Pocket Option перезагружать не нужно.');
    }
    return activeTradingSocket;
  }

  function validateAsset(asset) {
    const value = normalizeAsset(asset);
    if (!value || value.length < 2) {
      const preview = String(asset ?? '').trim().slice(0, 40);
      throw new Error(`Некорректный код актива${preview ? `: ${preview}` : ''}`);
    }
    return value;
  }

  function validateAssetBatch(rawAssets) {
    const requested = [];
    const skippedAssets = [];
    const seen = new Set();
    for (const raw of rawAssets) {
      try {
        const asset = validateAsset(raw);
        if (seen.has(asset)) continue;
        seen.add(asset);
        const availability = assets.get(asset);
        if (availability?.active === false) {
          skippedAssets.push(asset);
          continue;
        }
        requested.push(asset);
      } catch {
        skippedAssets.push(String(raw ?? '').slice(0, 120));
      }
    }
    return { requested, skippedAssets };
  }

  function sendPacket(event, payload) {
    const socket = requireAuthenticatedSocket();
    const packet = payload === undefined
      ? `42[${JSON.stringify(event)}]`
      : `42[${JSON.stringify(event)},${JSON.stringify(payload)}]`;
    socket.send(packet);
    return packet;
  }

  function requireMarketSocket() {
    requireAuthenticatedSocket();
    if (!isSocketHealthy(activeMarketSocket)) activeMarketSocket = chooseMarketSocket() || activeTradingSocket;
    if (!isSocketHealthy(activeMarketSocket)) throw new Error('Рыночный поток временно недоступен');
    return activeMarketSocket;
  }

  function sendMarketPacket(event, payload) {
    const socket = requireMarketSocket();
    const packet = payload === undefined
      ? `42[${JSON.stringify(event)}]`
      : `42[${JSON.stringify(event)},${JSON.stringify(payload)}]`;
    socket.send(packet);
    return packet;
  }

  function executionTicketErrorText(data, status) {
    const detail = data?.detail ?? data?.error ?? data?.reason;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    if (detail && typeof detail === 'object') {
      try { return JSON.stringify(detail).slice(0, 300); } catch {}
    }
    return `TRADE_TICKET_HTTP_${status}`;
  }

  function isRetryableTicketError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return error?.name === 'AbortError'
      || message.includes('failed to fetch')
      || message.includes('networkerror')
      || message.includes('load failed')
      || message.includes('connection reset');
  }

  async function consumeExecutionTicket(ticket, executionDeadlineMs = null) {
    const value = String(ticket || '').trim();
    if (value.length < 32) throw new Error('Локальное разрешение на сделку отсутствует');
    const requestId = crypto.randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onResponse);
        reject(new Error('LOCAL_TICKET_CONSUME_TIMEOUT'));
      }, 15000);
      const onResponse = (event) => {
        if (event.source !== window) return;
        const message = event.data;
        if (!message || message[MARKER] !== 'CONTENT_LOCAL_TICKET_RESULT' || message.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onResponse);
        if (!message.ok || !message.permit) reject(new Error(message.error || 'LOCAL_TICKET_REJECTED'));
        else resolve(message.permit);
      };
      window.addEventListener('message', onResponse);
      window.postMessage({
        [MARKER]: 'PAGE_CONSUME_LOCAL_TICKET',
        requestId, ticket: value,
        executionDeadlineMs: Number(executionDeadlineMs) || null
      }, '*');
    });
    return result;
  }

  function payoutFreshnessBonus(updatedAt) {
    const ms = Date.parse(updatedAt || '');
    if (!Number.isFinite(ms)) return 0;
    const age = Date.now() - ms;
    if (age < 2 * 60 * 1000) return 12;
    if (age < 5 * 60 * 1000) return 6;
    return 0;
  }

  function currentPayoutForExecution(asset, payload = null) {
    const symbol = validateAsset(asset);
    const candidates = [];
    const requestedDuration = safeNumber(payload?.duration ?? payload?.time ?? payload?.signalExpiration);
    const isTurbo = requestedDuration != null && requestedDuration > 0 && requestedDuration < 60;
    const add = (value, source = 'unknown', trust = 50, updatedAt = null, verified = false) => {
      let payout = safeNumber(value);
      if (payout == null || payout <= 0) return;
      if (payout <= 1) payout *= 100;
      if (payout > 0 && payout <= 100) candidates.push({ payout, source, trust: trust + payoutFreshnessBonus(updatedAt), updatedAt, verified });
    };
    const verifiedSource = (source, updatedAt) => {
      const label = String(source || '').toLowerCase();
      if (label.includes('execution') || label.includes('percentprofit') || label.includes('recent_broker')) {
        return isFreshPayoutTime(updatedAt, 20 * 60 * 1000);
      }
      // Mixed chafor sources must be handled before asset_info, otherwise a string
      // like `chafor+asset_info_min` becomes falsely verified for turbo execution.
      if (label.includes('chafor')) return false;
      if (label.includes('partners_api') || label.includes('asset_info') || label.includes('assets_list') || label.includes('updateassets')) {
        return isFreshPayoutTime(updatedAt, 2 * 60 * 1000);
      }
      return false;
    };
    const toMs = (value) => {
      if (value == null) return null;
      if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
      }
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return null;
      return number > 1e12 ? number : number * 1000;
    };
    const addRecentExecutionDeals = (items, source) => {
      if (!Array.isArray(items)) return;
      for (const deal of items) {
        if (String(deal?.asset || '') !== symbol) continue;
        const payout = safeNumber(deal.percentProfit ?? deal.profitPercent ?? deal.payout);
        if (payout == null || payout <= 0 || payout > 100) continue;
        const openMs = toMs(deal.openTimestamp || deal.openedAt || deal.time || deal.createdAt);
        const closeMs = toMs(deal.closeTimestamp || deal.closedAt || deal.expirationTimestamp);
        const dealDuration = safeNumber(deal.duration ?? deal.signalExpiration) ?? (openMs && closeMs ? Math.round((closeMs - openMs) / 1000) : null);
        if (requestedDuration != null && dealDuration != null && Math.abs(Number(dealDuration) - Number(requestedDuration)) > 1) continue;
        const at = closeMs || openMs;
        if (!at || Date.now() - at > 20 * 60 * 1000) continue;
        add(payout, source, 145, new Date(at).toISOString(), true);
      }
    };
    const info = assets.get(symbol) || null;
    const sub = subscriptionData.get(symbol) || null;
    addRecentExecutionDeals(state.trades?.openedDeals, 'recent_broker_open.percentProfit');
    addRecentExecutionDeals(state.trades?.closedDeals, 'recent_broker_closed.percentProfit');
    if (state.market.asset === symbol) {
      const activeAt = state.market.payoutUpdatedAt || state.market.streamUpdatedAt;
      const activeVerified = !isTurbo && isFreshPayoutTime(activeAt, 20 * 1000);
      add(state.market.payout, 'active_chart.payout', activeVerified ? 120 : 50, activeAt, activeVerified);
      add(state.market.percentProfit, 'active_chart.percentProfit', activeVerified ? 120 : 50, activeAt, activeVerified);
      add(state.market.profitPercent, 'active_chart.profitPercent', activeVerified ? 120 : 50, activeAt, activeVerified);
    }
    const subAt = sub?.payoutUpdatedAt || sub?.streamUpdatedAt;
    const subVerified = verifiedSource(sub?.payoutSource, subAt);
    const addPayoutCandidates = (items, source, trust, updatedAt, verified) => {
      if (!Array.isArray(items)) return;
      for (const value of items) add(value, source, trust, updatedAt, verified);
    };
    add(sub?.payout, sub?.payoutSource ? `subscription.${sub.payoutSource}` : 'subscription.payout', subVerified ? 125 : 50, subAt, subVerified);
    add(sub?.assetInfoPayout, 'subscription.asset_info.payout', 132, sub?.assetInfoPayoutUpdatedAt || subAt, verifiedSource('asset_info', sub?.assetInfoPayoutUpdatedAt || subAt));
    addPayoutCandidates(sub?.payoutCandidates, sub?.payoutSource ? `subscription.${sub.payoutSource}.candidate` : 'subscription.payout.candidate', 45, subAt, false);
    add(sub?.percentProfit, 'subscription.percentProfit', subVerified ? 118 : 50, subAt, subVerified);
    add(sub?.profitPercent, 'subscription.profitPercent', subVerified ? 118 : 50, subAt, subVerified);
    const infoAt = info?.payoutUpdatedAt;
    const infoVerified = verifiedSource(info?.payoutSource, infoAt);
    add(info?.payout, info?.payoutSource ? `asset.${info.payoutSource}` : 'asset.payout', infoVerified ? 122 : 50, infoAt, infoVerified);
    add(info?.assetInfoPayout, 'asset.asset_info.payout', 132, info?.assetInfoPayoutUpdatedAt || infoAt, verifiedSource('asset_info', info?.assetInfoPayoutUpdatedAt || infoAt));
    addPayoutCandidates(info?.payoutCandidates, info?.payoutSource ? `asset.${info.payoutSource}.candidate` : 'asset.payout.candidate', 45, infoAt, false);
    add(info?.percentProfit, 'asset.percentProfit', infoVerified ? 116 : 50, infoAt, infoVerified);
    add(info?.profitPercent, 'asset.profitPercent', infoVerified ? 116 : 50, infoAt, infoVerified);
    // Payload/signal payout is telemetry only. It is not accepted as broker proof.
    if (!candidates.length) return { payout: null, source: 'unknown', verified: false, candidates: [] };
    const verified = candidates.filter((item) => item.verified === true);
    if (!verified.length) return { payout: null, source: isTurbo ? 'turbo_requires_asset_info_or_execution_payout' : 'unverified', verified: false, candidates };
    verified.sort((a, b) => (a.payout - b.payout) || (b.trust - a.trust));
    const safe = verified[0];
    return { payout: safe.payout, source: safe.source, updatedAt: safe.updatedAt || null, verified: true, candidates };
  }


  async function executeTrade(payload) {
    const requestedAsset = validateAsset(payload?.asset || state.market.asset);
    const requestedAction = payload?.action === 'put' ? 'put' : payload?.action === 'call' ? 'call' : null;
    const requestedAmount = safeNumber(payload?.amount);
    const requestedDuration = Math.floor(safeNumber(payload?.duration));
    const requestedId = String(payload?.requestId || '').trim();
    if (!requestedId) throw new Error('Сделка не содержит requestId');
    const now = Date.now();
    for (const [id, createdAt] of recentExecutionRequests.entries()) {
      if (now - Number(createdAt || 0) > 10 * 60 * 1000) recentExecutionRequests.delete(id);
    }
    if (pendingTrades.has(requestedId) || recentExecutionRequests.has(requestedId) || validatingExecutionRequests.has(requestedId)) {
      throw new Error('Эта торговая команда уже обрабатывается или была исполнена');
    }
    // Only a server-issued one-time ticket is accepted here. A ready permit object
    // received through the public page message channel would be forgeable by page
    // scripts and therefore must never authorize an order.
    validatingExecutionRequests.add(requestedId);
    let permit;
    let asset;
    let action;
    let amount;
    let duration;
    let permitRequestId;
    try {
      permit = await consumeExecutionTicket(payload?.executionTicket, payload?.executionDeadlineMs);
      if (permit?.ok !== true) throw new Error('Сервер вернул некорректное разрешение сделки');
      asset = validateAsset(permit.asset);
      action = permit.action === 'put' ? 'put' : permit.action === 'call' ? 'call' : null;
      amount = safeNumber(permit.amount);
      duration = Math.floor(safeNumber(permit.duration));
      permitRequestId = String(permit.requestId || '');
      if (!action || amount == null || amount <= 0 || !Number.isFinite(duration) || duration < 1 || duration > 86400 || !permitRequestId) {
        throw new Error('Сервер вернул некорректное разрешение сделки');
      }
      if (requestedId !== permitRequestId || requestedAsset !== asset || requestedAction !== action || Math.abs(Number(requestedAmount) - Number(amount)) > 1e-8 || requestedDuration !== duration) {
        throw new Error('Параметры сделки не совпадают с серверным разрешением');
      }
    } finally {
      validatingExecutionRequests.delete(requestedId);
    }
    // Failed network/validation attempts are not remembered as completed trades.
    // A successfully consumed and fully matched ticket is still protected against
    // replay before the broker acknowledgement is received.
    recentExecutionRequests.set(requestedId, now);
    const requestId = permitRequestId;
    if (state.account.isDemo == null) throw new Error('Не удалось определить режим счёта DEMO/REAL. Переключите счёт в терминале и подключитесь повторно.');
    const expirationSupport = executionExpirationSupport(asset, duration);
    if (!expirationSupport.supported) {
      const allowed = expirationSupport.allowed || brokerAllowedExpirationsForAsset(asset);
      const bounds = expirationSupport.bounds || {};
      const boundsLabel = bounds.min != null || bounds.max != null ? `диапазон ${bounds.min ?? '?'}–${bounds.max ?? '?'} сек` : null;
      const label = boundsLabel || (allowed.length ? allowed.join(', ') : 'нет данных от брокера');
      throw new Error(`Экспирация ${duration} сек недоступна для ${asset}: ${expirationSupport.reason}. Доступно: ${label}. Сделка не открыта`);
    }
    const order = { asset, amount, action, isDemo: state.account.isDemo ? 1 : 0, requestId, optionType: 100, time: duration };
    const minPayout = safeNumber(payload?.minPayout);
    const localPayoutInfo = currentPayoutForExecution(asset, payload);
    const executionPayout = localPayoutInfo.verified ? localPayoutInfo.payout : null;
    if (minPayout != null && minPayout > 0 && (!localPayoutInfo.verified || executionPayout == null || executionPayout < minPayout)) {
      const source = String(localPayoutInfo.source || payload?.currentPayoutSource || 'unverified');
      throw new Error(!localPayoutInfo.verified || executionPayout == null ? `Payout ${asset} не подтверждён свежим брокером (${source}); минимум ${minPayout}%` : `Payout ${executionPayout}% ниже минимума ${minPayout}%; сделка не открыта`);
    }

    return new Promise((resolve, reject) => {
      const pending = {
        requestId, asset, amount, action, duration,
        source: String(payload?.source || 'extension').trim() || 'extension',
        strategyId: String(payload?.strategyId || '').trim() || null,
        signalConfidence: safeNumber(payload?.signalConfidence),
        signalPayout: safeNumber(payload?.signalPayout),
        minPayout: safeNumber(payload?.minPayout),
        signalExpiration: safeNumber(payload?.signalExpiration ?? duration),
        calibrationApplied: payload?.calibrationApplied && typeof payload.calibrationApplied === 'object' ? payload.calibrationApplied : null,
        recoveryStep: payload?.recoveryStep == null ? null : Math.max(0, Number(payload.recoveryStep) || 0),
        recoverySteps: payload?.recoverySteps == null ? null : Math.max(0, Number(payload.recoverySteps) || 0),
        recoveryMultiplier: safeNumber(payload?.recoveryMultiplier),
        recoveryScopeStrategyId: String(payload?.recoveryScopeStrategyId || '').trim() || null,
        recoveryScopeAsset: String(payload?.recoveryScopeAsset || '').trim() || null,
        recoveryFollowSignal: payload?.recoveryFollowSignal === true,
        parentRequestId: meaningfulRequestId(payload?.parentRequestId),
        recoveryBranchRootId: String(payload?.recoveryBranchRootId || '').trim() || null,
        baseAmount: safeNumber(payload?.baseAmount),
        sentAt: Date.now(), timer: null, resolve
      };
      pending.timer = setTimeout(() => {
        if (!pendingTrades.has(requestId)) return;
        pendingTrades.delete(requestId);
        const result = {
          status: 'unconfirmed', time: nowIso(), requestId, asset, amount, action, duration, strategyId: pending.strategyId,
          signalConfidence: pending.signalConfidence ?? null, signalPayout: pending.signalPayout ?? null,
          signalExpiration: pending.signalExpiration ?? duration, calibrationApplied: pending.calibrationApplied || null, source: pending.source || 'extension',
          robotTrade: String(pending.source || '').toLowerCase() === 'autotrade',
          recoveryStep: pending.recoveryStep ?? null, recoverySteps: pending.recoverySteps ?? null, recoveryMultiplier: pending.recoveryMultiplier ?? null,
          recoveryScopeStrategyId: pending.recoveryScopeStrategyId || null, recoveryScopeAsset: pending.recoveryScopeAsset || null,
          recoveryFollowSignal: pending.recoveryFollowSignal === true, parentRequestId: pending.parentRequestId || null, recoveryBranchRootId: pending.recoveryBranchRootId || null, baseAmount: pending.baseAmount ?? null,
          sentAt: pending.sentAt,
          error: 'Pocket Option не подтвердил открытие сделки за 12 секунд. Ожидаем сверку с журналом брокера.'
        };
        rememberTradeResult(result);
        resolve({ ok: false, confirmed: false, unconfirmed: true, result, error: result.error });
        emitState(true);
      }, 12000);
      pendingTrades.set(requestId, pending);

      state.trades.lastRequest = { time: nowIso(), requestId, asset, amount, action, duration, strategyId: pending.strategyId, signalConfidence: pending.signalConfidence, signalPayout: pending.signalPayout, signalExpiration: pending.signalExpiration, calibrationApplied: pending.calibrationApplied, isDemo: order.isDemo, source: pending.source };
      state.trades.lastResult = { status: 'sent', time: nowIso(), requestId, asset, amount, action, duration, strategyId: pending.strategyId, signalConfidence: pending.signalConfidence, signalPayout: pending.signalPayout, signalExpiration: pending.signalExpiration, calibrationApplied: pending.calibrationApplied, source: pending.source };

      try {
        sendPacket('openOrder', order);
      } catch (error) {
        clearTimeout(pending.timer);
        pendingTrades.delete(requestId);
        reject(error);
        return;
      }
      emitState(true);
    });
  }

  function stopMultiAssetScanner() {
    if (multiAssetScanTimer) clearTimeout(multiAssetScanTimer);
    multiAssetScanTimer = null;
    state.market.scannerActive = false;
  }

  function scanBatchSize(assetCount, period) {
    const cycleMs = Math.max(1000, Math.max(1, Number(period) || 60) * 1000);
    const slots = Math.max(1, Math.floor(cycleMs / MULTI_SCAN_INTERVAL_MS));
    return Math.max(1, Math.min(MAX_SCAN_BATCH_SIZE, Math.ceil(assetCount / slots)));
  }

  function scanInterval(assetCount, period, batchSize) {
    const cycleMs = Math.max(1000, Math.max(1, Number(period) || 60) * 1000);
    const batches = Math.max(1, Math.ceil(assetCount / Math.max(1, batchSize)));
    // Spread one complete pass over the selected timeframe. M1 therefore means
    // one refresh per pair per minute; M5 means one refresh per pair per 5 minutes.
    return Math.max(MULTI_SCAN_INTERVAL_MS, Math.floor(cycleMs / batches));
  }

  function cleanupStaleHistoryRequests() {
    const now = Date.now();
    let retryQueued = false;
    let exhausted = false;
    for (const [index, item] of historyRequests) {
      if (now - Number(item?.requestedAt || 0) <= HISTORY_REQUEST_STALE_MS) continue;
      historyRequests.delete(index);
      if (item?.attempts < 1 && item?.token === subscriptionQueueToken) {
        // Retry the same pair first. If a delayed unlabelled broker response arrives,
        // it is still associated with the same asset rather than the next pair.
        const retry = {
          asset: item.asset,
          period: item.period,
          offsetSeconds: item.offsetSeconds,
          scanner: Boolean(item.scanner),
          resetHistory: Boolean(item.resetHistory),
          token: item.token,
          attempts: Number(item.attempts || 0) + 1
        };
        if (!queueHasAsset(retry.asset, retry.period)) historyTaskQueue.unshift(retry);
        retryQueued = true;
      } else {
        exhausted = true;
      }
    }
    if (exhausted) {
      // Leave a short empty window after a twice-timed-out request. A very late
      // response without asset/index is then discarded instead of poisoning the
      // history of the next queued pair.
      historyQueueBlockedUntil = Math.max(historyQueueBlockedUntil, now + HISTORY_LATE_RESPONSE_GUARD_MS);
    }
    if (retryQueued) scheduleHistoryQueue(10);
    else if (exhausted) scheduleHistoryQueue(HISTORY_LATE_RESPONSE_GUARD_MS);
  }

  function maybeReleaseHistoryLane(period) {
    // The single scanner stays authenticated and is reused. Closing it after every
    // timeframe caused a permanent open/close loop and repeatedly triggered Pocket's
    // transport rotation. It is closed only on account disconnect or real socket loss.
    const lane = scannerLane(period, false);
    if (lane) lane.period = scannerPeriodKey(period);
  }

  function requestHistoryRefresh(asset, period) {
    const sub = getSubscription(asset, period);
    if (!sub || !manualConnectionRequested) return false;
    const now = Date.now();
    const streamAt = Date.parse(sub.streamUpdatedAt || '');
    const historyAt = Date.parse(sub.historyReceivedAt || '');
    const hasUsableHistory = Number(sub.historyCount || 0) >= 60;
    const streamStaleMs = Math.max(90000, Math.min(10 * 60 * 1000, Number(period || 60) * 6000));
    const streamStale = !Number.isFinite(streamAt) || now - streamAt > streamStaleMs;
    const historyRecentlyRefreshed = Number.isFinite(historyAt) && now - historyAt < Math.max(120000, Number(period || 60) * 6000);
    // The scanner is now a recovery watchdog. Normal higher-TF updates come from
    // live tick aggregation and must not trigger recurring broker history requests.
    if (hasUsableHistory && !streamStale) return false;
    if (hasUsableHistory && streamStale && historyRecentlyRefreshed) return false;
    const historyDepth = hasUsableHistory ? MULTI_SCAN_HISTORY_OFFSET : INITIAL_HISTORY_CANDLES;
    return enqueueHistoryTask({
      asset,
      period,
      offsetSeconds: Math.max(period, historyDepth * period),
      scanner: true,
      token: subscriptionQueueToken
    });
  }

  function scheduleMultiAssetScanner(delay = 1200) {
    stopMultiAssetScanner();
    if (!desiredSubscriptionPlan.active || !desiredSubscriptionPlan.assets.length || !manualConnectionRequested) return;
    state.market.scannerActive = true;
    multiAssetScanTimer = setTimeout(() => {
      multiAssetScanTimer = null;
      runMultiAssetScanner();
    }, Math.max(250, delay));
  }

  function retryOneMissingLiveSubscription(scanAssets) {
    const now = Date.now();
    if (now - lastTargetedStreamResubscribeAt < 10000) return false;
    const candidate = (Array.isArray(scanAssets) ? scanAssets : []).find((asset) => {
      if (assets.get(asset)?.active === false) return false;
      const sub = subscriptionData.get(asset);
      if (!sub?.requested) return false;
      const requestedAt = Date.parse(sub.requestedAt || '');
      const streamAt = Date.parse(sub.streamUpdatedAt || '');
      const retryAt = Date.parse(sub.lastResubscribeAt || '');
      const attempts = Math.max(0, Number(sub.resubscribeAttempts || 0));
      // Pocket does not always provide simultaneous updateStream for every symbol.
      // Do not hammer all quiet assets after 12 seconds. A never-started stream gets
      // one delayed retry; a stream that was genuinely alive gets at most two repairs.
      const neverStarted = !Number.isFinite(streamAt) && attempts < 1 && Number.isFinite(requestedAt) && now - requestedAt > 120000;
      const stale = Number.isFinite(streamAt) && attempts < 2 && now - streamAt > 120000;
      const retryReady = !Number.isFinite(retryAt) || now - retryAt > 120000;
      return (neverStarted || stale) && retryReady;
    });
    if (!candidate) return false;
    const sub = subscriptionData.get(candidate);
    try {
      sendMarketPacket('subfor', candidate);
      sub.subscribed = true;
      sub.lastResubscribeAt = nowIso();
      sub.resubscribeAttempts = Math.min(2, Number(sub.resubscribeAttempts || 0) + 1);
      lastTargetedStreamResubscribeAt = now;
      return true;
    } catch {
      return false;
    }
  }

  function runMultiAssetScanner() {
    if (!desiredSubscriptionPlan.active || !manualConnectionRequested) {
      stopMultiAssetScanner();
      return;
    }
    const historySocket = ensureScannerSocket();
    if (!historySocket || !scannerSocketReady || !isSocketHealthy(historySocket, 90000)) {
      scheduleMultiAssetScanner(1000);
      return;
    }

    cleanupStaleHistoryRequests();
    // Scan every selected asset, including the visible chart. The live stream is
    // an enrichment, not a dependency: if Pocket Option pauses that stream, the
    // primary pair still receives the same timeframe history refresh as all others.
    const scanAssets = desiredSubscriptionPlan.assets.filter(Boolean);
    if (!scanAssets.length) {
      stopMultiAssetScanner();
      return;
    }

    // Repair only one missing/stale asset subscription at a time. Never restart the
    // account socket or re-send the full 77-asset set because one symbol is quiet.
    retryOneMissingLiveSubscription(scanAssets);

    const batchSize = Math.min(scanBatchSize(scanAssets.length, desiredSubscriptionPlan.period), scanAssets.length);
    for (let offset = 0; offset < batchSize; offset += 1) {
      const index = (multiAssetScanCursor + offset) % scanAssets.length;
      const asset = scanAssets[index];
      setTimeout(() => {
        if (!desiredSubscriptionPlan.active || !manualConnectionRequested) return;
        requestHistoryRefresh(asset, desiredSubscriptionPlan.period);
      }, offset * HISTORY_REQUEST_SPACING_MS);
    }

    const previousCursor = multiAssetScanCursor;
    multiAssetScanCursor = (multiAssetScanCursor + batchSize) % scanAssets.length;
    if (multiAssetScanCursor <= previousCursor) multiAssetScanCycle += 1;
    state.market.scanCursor = multiAssetScanCursor;
    state.market.scanCycle = multiAssetScanCycle;
    state.market.scanRequests = multiAssetScanRequests;
    state.market.scanResponses = multiAssetScanResponses;
    state.market.lastScanAsset = lastMultiAssetScanAsset;
    state.market.lastScanAt = nowIso();
    state.market.scannerActive = true;
    scheduleMultiAssetScanner(scanInterval(scanAssets.length, desiredSubscriptionPlan.period, batchSize));
    emitState();
  }

  function sendHistoryAndSubscribe(asset, period, offset = INITIAL_HISTORY_CANDLES, delay = 0, options = {}) {
    const reconnect = Boolean(options.reconnect);
    const token = options.token ?? subscriptionQueueToken;
    const sub = getSubscription(asset, period);
    if (!sub) return false;
    sub.requested = true;
    sub.requestedAt = nowIso();
    sub.subscribed = false;
    sub.streamActive = false;
    const preserveHistory = Boolean(options.preserveHistory && sub.historyCount >= 60);
    if (!reconnect && !preserveHistory) {
      sub.historyItems = [];
      sub.historyCount = 0;
      sub.historyReceivedAt = null;
    }
    const needsHistory = options.skipHistory !== true && !historyCacheFresh(sub, period);
    setTimeout(() => {
      if (token !== subscriptionQueueToken || !manualConnectionRequested) return;
      if (assets.get(asset)?.active === false) return;
      if (desiredSubscriptionPlan.active && !desiredSubscriptionPlan.assets.includes(asset)) return;
      if (needsHistory) {
        const depth = Math.max(60, Number(offset) || INITIAL_HISTORY_CANDLES);
        enqueueHistoryTask({
          asset,
          period,
          offsetSeconds: Math.max(period, depth * period),
          token,
          resetHistory: !reconnect && !preserveHistory
        });
      }
      try {
        if (options.primary) sendMarketPacket('changeSymbol', { asset, period });
        sendMarketPacket('subfor', asset);
        sub.subscribed = true;
        sub.lastSubscribeSentAt = nowIso();
        if (asset === state.market.asset) syncPrimaryMarket(asset);
        emitState();
      } catch (error) {
        addError(error, `subscribe:${asset}`);
      }
    }, Math.max(0, delay));
  }

  function resumeDesiredSubscriptions(reason = 'reconnect') {
    ensureScannerSocket(desiredSubscriptionPlan.period);
    if (!desiredSubscriptionPlan.active || !desiredSubscriptionPlan.assets.length || !manualConnectionRequested) return;
    // A reconnect invalidates every pending request from the old socket. Keeping an
    // old in-flight entry would block the serial queue until timeout and could bind
    // the first response of the new socket to the wrong request.
    const token = ++subscriptionQueueToken;
    historyRequests.clear();
    clearHistoryQueue();
    const { assets: requested, period, historyOffset: offset } = desiredSubscriptionPlan;
    const primaryAssets = new Set(
      Array.isArray(desiredSubscriptionPlan.assetsByPeriod?.[period])
        ? desiredSubscriptionPlan.assetsByPeriod[period]
        : requested
    );
    state.market.subscriptionRequested = true;
    state.market.subscriptionSentAt = nowIso();
    requested.forEach((asset, index) => sendHistoryAndSubscribe(
      asset,
      period,
      offset,
      index * (requested.length > 60 ? 80 : 60),
      { reconnect: true, primary: index === 0, token, reason, skipHistory: !primaryAssets.has(asset) }
    ));
    syncPrimaryMarket(requested[0]);
    const queueStep = requested.length > 60 ? 80 : 60;
    scheduleMultiAssetScanner(requested.length * queueStep + 1200);
  }

  function enableCacheBridgeMarketMode(payload) {
    requireAuthenticatedSocket();
    const rawAssets = Array.isArray(payload?.assets) ? payload.assets : [payload?.asset || state.market.asset];
    const { requested, skippedAssets } = validateAssetBatch(rawAssets);
    const period = normalizeAnalysisPeriodSeconds(payload?.period, state.market.period || 60);
    const periods = [...new Set((Array.isArray(payload?.periods) ? payload.periods : [period])
      .map((value) => normalizeAnalysisPeriodSeconds(value, period))
      .filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
    stopMultiAssetScanner();
    desiredSubscriptionPlan = { active: false, assets: [], assetsByPeriod: {}, period, periods, historyOffset: 0, historyOffsets: {} };
    subscriptionQueueToken += 1;
    historyRequests.clear();
    clearHistoryQueue();
    closeScannerSocket('cache_bridge_primary');
    subscriptionData.clear();
    timeframeSubscriptionData.clear();
    candleBuilders.clear();
    state.market.selectedAssets = requested;
    state.market.asset = requested[0] || state.market.asset || null;
    state.market.period = period;
    state.market.subscriptionRequested = false;
    state.market.subscriptionSentAt = null;
    state.market.historyRequestedAt = null;
    state.market.cacheBridgeMode = true;
    state.market.cacheBridgeReason = String(payload?.reason || 'cache_bridge_primary');
    emitState(true);
    return { ok: true, mode: 'cache-bridge-primary', assets: requested, skippedAssets, period, periods };
  }

  function subscribe(payload) {
    requireAuthenticatedSocket();
    const rawAssets = Array.isArray(payload?.assets) ? payload.assets : [payload?.asset || state.market.asset];
    const { requested, skippedAssets } = validateAssetBatch(rawAssets);
    if (!requested.length) throw new Error('В выбранном списке не найдено корректных торговых активов');
    const period = normalizeAnalysisPeriodSeconds(payload?.period, 60);
    const periods = [...new Set((Array.isArray(payload?.periods) ? payload.periods : [period])
      .map((value) => normalizeAnalysisPeriodSeconds(value, period))
      .filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
    if (!periods.includes(period)) periods.unshift(period);
    const assetsByPeriod = Object.fromEntries(periods.map((item) => [item, []]));
    const rawScopes = Array.isArray(payload?.scopes) ? payload.scopes : [];
    for (const rawScope of rawScopes) {
      const scopedAsset = normalizeAsset(rawScope?.asset);
      const scopedPeriod = normalizeAnalysisPeriodSeconds(rawScope?.period, period);
      if (!scopedAsset || !requested.includes(scopedAsset) || !periods.includes(scopedPeriod)) continue;
      if (!assetsByPeriod[scopedPeriod].includes(scopedAsset)) assetsByPeriod[scopedPeriod].push(scopedAsset);
    }
    if (!rawScopes.length) {
      for (const item of periods) assetsByPeriod[item] = [...requested];
    }
    const offset = Math.min(5000, Math.max(60, Math.floor(safeNumber(payload?.historyOffset) || INITIAL_HISTORY_CANDLES)));
    const historyOffsets = payload?.historyOffsets && typeof payload.historyOffsets === 'object' ? { ...payload.historyOffsets } : { [period]: offset };
    stopMultiAssetScanner();
    desiredSubscriptionPlan = { active: true, assets: [...requested], assetsByPeriod, period, periods, historyOffset: offset, historyOffsets };
    ensureScannerSocket(period);
    subscriptionQueueToken += 1;
    const token = subscriptionQueueToken;
    subscriptionData.clear();
    timeframeSubscriptionData.clear();
    candleBuilders.clear();
    historyRequests.clear();
    clearHistoryQueue();
    const cacheHits = seedCachedHistory(payload?.cachedHistory, requested, period);
    state.market.selectedAssets = requested;
    state.market.cacheBridgeMode = false;
    state.market.cacheBridgeReason = null;
    state.market.asset = requested[0];
    state.market.period = period;
    state.market.subscriptionRequested = true;
    state.market.subscriptionSentAt = nowIso();
    state.market.historyRequestedAt = nowIso();
    const primaryAssets = new Set(assetsByPeriod[period] || []);
    requested.forEach((asset, index) => sendHistoryAndSubscribe(
      asset,
      period,
      offset,
      index * (requested.length > 60 ? 80 : 60),
      {
        reconnect: false,
        primary: index === 0,
        token,
        preserveHistory: cacheHits.has(asset),
        skipHistory: !primaryAssets.has(asset)
      }
    ));
    multiAssetScanCursor = 0;
    multiAssetScanCycle = 0;
    multiAssetScanRequests = 0;
    multiAssetScanResponses = 0;
    lastMultiAssetScanAsset = null;
    const queueStep = requested.length > 60 ? 80 : 60;
    scheduleMultiAssetScanner(requested.length * queueStep + 1200);
    syncPrimaryMarket(requested[0]);
    emitState(true);
    return {
      ok: true,
      assets: requested,
      assetsByPeriod,
      scopes: Object.entries(assetsByPeriod).flatMap(([scopePeriod, scopeAssets]) =>
        scopeAssets.map((asset) => ({ asset, period: Number(scopePeriod) }))
      ),
      skippedAssets,
      period,
      periods,
      historyOffset: offset,
      cacheHits: cacheHits.size,
      status: cacheHits.size ? 'cache-then-live-stream' : 'sequential-history-and-live-stream',
      timeframeCount: periods.length
    };
  }

  function requestHistory(payload) {
    requireAuthenticatedSocket();
    const rawAssets = Array.isArray(payload?.assets) ? payload.assets : [payload?.asset || state.market.asset];
    const { requested, skippedAssets } = validateAssetBatch(rawAssets);
    if (!requested.length) throw new Error('В выбранном списке не найдено корректных торговых активов');
    const period = normalizeAnalysisPeriodSeconds(payload?.period, state.market.period || 60);
    const depth = Math.min(5000, Math.max(3, Math.floor(safeNumber(payload?.offset ?? payload?.historyOffset) || INITIAL_HISTORY_CANDLES)));
    const resetHistory = payload?.reset === true;
    for (const asset of requested) {
      const sub = getSubscription(asset, period);
      if (sub) {
        sub.requested = true;
        sub.requestedAt = nowIso();
      }
      enqueueHistoryTask({
        asset,
        period,
        offsetSeconds: Math.max(period, depth * period),
        resetHistory,
        token: subscriptionQueueToken
      });
    }
    state.market.historyRequestedAt = nowIso();
    emitState(true);
    return { ok: true, assets: requested, skippedAssets, period, historyDepth: depth, resetHistory, queued: requested.length, maxInFlight: MAX_HISTORY_IN_FLIGHT };
  }

  function connectAccount() {
    const socket = chooseTradingSocket();
    if (!socket) {
      const guestMarketOnly = [...sockets].some((candidate) => {
        const meta = socketMeta.get(candidate);
        return candidate.readyState === SOCKET_OPEN && meta?.tradingHost && meta?.authPayload && !socketHasAccountCapability(meta);
      });
      clearPublicAccount();
      state.connection.connected = false;
      state.connection.authCaptured = false;
      state.socket.authenticated = false;
      if (isGuestTryDemoContext() && guestMarketOnly) {
        manualConnectionRequested = true;
        connectedAccountIdentity = null;
        armLoginUpgrade('connect_waiting_for_login', true);
        state.connection.lastError = null;
        emitState(true);
        return {
          ok: true,
          waitingAuth: true,
          status: 'waiting_auth',
          message: 'Зеркало подключено · ожидание входа в Pocket Option',
          state: publicState()
        };
      }
      state.connection.waitingForLogin = false;
      state.connection.loginWaitReason = null;
      state.connection.lastError = 'Разрыв слежения за терминалом';
      emitState(true);
      throw new Error('Мост терминала временно не видит авторизованный торговый поток с подтверждённым UID. Нажмите «Подключить аккаунт» в расширении и повторите действие.');
    }
    const sameActiveSocket = socket === activeTradingSocket && state.connection.connected;
    if (!sameActiveSocket && !state.connection.reconnecting) resetPublicMarket();
    manualConnectionRequested = true;
    connectedAccountIdentity = null;
    applySelectedSocketToPublic(socket, { explicitManual: true, reason: 'manual_connect' });
    activeMarketSocket = chooseMarketSocket() || socket;
    ensureScannerSocket();
    try { sendPacket('getBalance'); } catch {}
    emitState(true);
    return { ok: true, state: publicState() };
  }

  function disconnectAccount() {
    logicalDisconnect('manual');
    emitState(true);
    return { ok: true, state: publicState() };
  }

  async function handleCommand(command, payload) {
    switch (command) {
      case 'GET_STATE':
      case 'PING':
        return { ok: true, state: publicState() };
      case 'CONNECT':
        return connectAccount();
      case 'DISCONNECT':
        return disconnectAccount();
      case 'TRADE':
        return executeTrade(payload);
      case 'SUBSCRIBE':
        return subscribe(payload);
      case 'CACHE_MODE':
        return enableCacheBridgeMarketMode(payload);
      case 'HISTORY':
        return requestHistory(payload);
      case 'CLEAR_LOG':
        state.diagnostics.recentEvents = [];
        state.diagnostics.recentTradeEvents = [];
        state.diagnostics.tradeSamples = [];
        state.diagnostics.eventCounts = {};
        state.diagnostics.rawSamples = [];
        state.diagnostics.errors = [];
        emitState(true);
        return { ok: true };
      default:
        throw new Error(`Неизвестная команда: ${command}`);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[MARKER] !== 'EXTENSION_COMMAND') return;
    const id = data.id;
    Promise.resolve()
      .then(() => handleCommand(data.command, data.payload))
      .then((result) => window.postMessage({ [MARKER]: 'PAGE_RESPONSE', id, ok: true, result }, '*'))
      .catch((error) => {
        addError(error, `command:${data.command}`);
        window.postMessage({ [MARKER]: 'PAGE_RESPONSE', id, ok: false, error: String(error?.message || error) }, '*');
      });
  });

  installWebSocketHook();
  emitState(true);
  healthTimer = setInterval(() => connectionHealthCheck('watchdog'), SOCKET_RECOVERY_CHECK_MS);
  setInterval(() => emitState(true), 5000);
  window.addEventListener('online', () => connectionHealthCheck('network_online'));
  window.addEventListener('beforeunload', () => closeScannerSocket('page_unload'));
  window.addEventListener('offline', () => connectionHealthCheck('network_offline'));
  window.addEventListener('focus', () => connectionHealthCheck('window_focus'));
  window.addEventListener('blur', () => connectionHealthCheck('window_blur'));
  window.addEventListener('pageshow', () => connectionHealthCheck('page_show'));
  window.addEventListener('pagehide', () => {
    if (hasFrozenAccountContext()) {
      freezeConnectionForBackground('page_hide');
      emitState(true);
    }
  });
  document.addEventListener('freeze', () => {
    if (hasFrozenAccountContext()) {
      freezeConnectionForBackground('page_freeze');
      emitState(true);
    }
  });
  document.addEventListener('resume', () => connectionHealthCheck('page_resume'));
  document.addEventListener('visibilitychange', () => {
    connectionHealthCheck(document.visibilityState === 'visible' ? 'tab_visible' : 'tab_background');
  });
})();
