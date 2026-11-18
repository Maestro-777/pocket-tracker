(() => {
  'use strict';

  if (window !== window.top || window.__PT_DESKTOP_BG_PROBE__) return;

  const sessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const telemetry = {
    sessionId,
    scanCount: 0,
    lastScanAt: 0,
    lastScan: null,
    perAssetLastScan: {},
    signalSequence: 0,
    signals: [],
    tradeSequence: 0,
    trades: []
  };

  const state = {
    startedAt: Date.now(),
    ticks: 0,
    lastTickAt: Date.now(),
    visibilityState: document.visibilityState,
    online: navigator.onLine !== false,
    networkChangedAt: Date.now(),
    networkEvent: 'initial',
    webSocketOpen: false,
    webSocketOpenCount: 0,
    webSocketCount: 0,
    core: null,
    telemetry
  };

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  }

  function pushBounded(list, item, max) {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
  }

  function recordSignal(type, signal) {
    telemetry.signalSequence += 1;
    const copy = clone(signal || {}) || {};
    pushBounded(telemetry.signals, {
      id: sessionId + ':signal:' + telemetry.signalSequence,
      sequence: telemetry.signalSequence,
      type,
      recordedAt: Date.now(),
      signal: copy,
      diagnostics: copy.diagnostics || null
    }, 200);
  }

  function recordTrade(type, trade) {
    telemetry.tradeSequence += 1;
    pushBounded(telemetry.trades, {
      id: sessionId + ':trade:' + telemetry.tradeSequence,
      sequence: telemetry.tradeSequence,
      type,
      recordedAt: Date.now(),
      trade: clone(trade || {}) || {}
    }, 200);
  }

  function recordScan(scan) {
    const copy = clone(scan || {}) || {};
    telemetry.scanCount += 1;
    telemetry.lastScanAt = Date.now();
    telemetry.lastScan = copy;
    const asset = String(copy.asset || 'UNKNOWN');
    telemetry.perAssetLastScan[asset] = {
      recordedAt: telemetry.lastScanAt,
      scan: copy
    };
    const assets = Object.keys(telemetry.perAssetLastScan);
    if (assets.length > 40) {
      assets.sort((a, b) =>
        telemetry.perAssetLastScan[a].recordedAt - telemetry.perAssetLastScan[b].recordedAt
      );
      delete telemetry.perAssetLastScan[assets[0]];
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'POROBOT_SCAN' || data.type === 'POROBOT_DIAG_SCAN') {
      recordScan(data.scan);
    } else if (data.type === 'POROBOT_SIGNAL' || data.type === 'POROBOT_MULTI_SIGNAL') {
      recordSignal(data.type, data.signal);
    } else if (data.type === 'POROBOT_TRADE_RESULT') {
      recordTrade(data.type, data);
    } else if (data.type === 'POROBOT_MULTI_TRADE_OPEN' || data.type === 'POROBOT_MULTI_TRADE_RESULT') {
      recordTrade(data.type, data.trade || data);
    }
  });

  function refreshRuntimeSnapshot() {
    const now = Date.now();
    const sockets = Array.isArray(window.__po_wsConnections)
      ? window.__po_wsConnections
      : [];
    const activeSocketCount = sockets.filter(item =>
      item && item.ws && item.ws.readyState === 1
    ).length;
    const activeLegacySocket = !!(window.__po_ws && window.__po_ws.readyState === 1);

    state.webSocketOpenCount = activeSocketCount + (activeLegacySocket ? 1 : 0);
    state.webSocketCount = sockets.length + (window.__po_ws ? 1 : 0);
    state.webSocketOpen = state.webSocketOpenCount > 0;
    state.online = navigator.onLine !== false;
    state.visibilityState = document.visibilityState;

    const core = window.__poCore || null;
    if (!core) {
      state.core = { loaded: false, running: false };
      return;
    }

    const tickTimes = core._priceTickTs || {};
    const tickEntries = Object.keys(tickTimes).map(asset => {
      let timestamp = Number(tickTimes[asset]) || 0;
      // Some market feeds use Unix seconds while the core may also store milliseconds.
      if (timestamp > 0 && timestamp < 1000000000000) timestamp *= 1000;
      return { asset, timestamp };
    }).filter(item => item.timestamp > 0);
    tickEntries.sort((a, b) => b.timestamp - a.timestamp);
    const lastQuote = tickEntries[0] || null;
    const activeAssets = tickEntries
      .filter(item => now - item.timestamp < 30000)
      .map(item => item.asset);

    const asset = core._wsAsset || core._domAsset || core._lastAsset || null;
    let analysis = null;
    if (asset && typeof core._getAnalysisContext === 'function') {
      try {
        const ctx = core._getAnalysisContext(asset);
        analysis = {
          ready: !!ctx.ready,
          candleCount: ctx.candleCount || 0,
          tickCount: ctx.tickCount || 0,
          minimumCandles: ctx.minRequired || 0,
          candleSeconds: ctx.candleSec || null,
          profile: ctx.profile ? clone({
            exp: ctx.profile.exp,
            candleSec: ctx.profile.candleSec,
            minCandles: ctx.profile.minCandles,
            rsiPeriod: ctx.profile.rsiPeriod,
            smaFast: ctx.profile.smaFast,
            smaSlow: ctx.profile.smaSlow,
            emaFast: ctx.profile.emaFast,
            emaSlow: ctx.profile.emaSlow,
            bbPeriod: ctx.profile.bbPeriod,
            macdFast: ctx.profile.macdFast,
            macdSlow: ctx.profile.macdSlow,
            macdSig: ctx.profile.macdSig,
            stochK: ctx.profile.stochK,
            stochD: ctx.profile.stochD,
            cciPeriod: ctx.profile.cciPeriod,
            trendPeriod: ctx.profile.trendPeriod
          }) : null,
          htf: ctx.htf ? {
            ready: !!ctx.htf.ready,
            direction: ctx.htf.direction || 'NEUTRAL',
            seconds: ctx.htf.sec || null
          } : null
        };
      } catch (error) {
        analysis = { error: String(error) };
      }
    }

    const config = core.config || {};
    state.core = {
      loaded: true,
      running: !!core.isRunning,
      asset,
      latestQuoteAsset: lastQuote ? lastQuote.asset : null,
      lastQuoteAt: lastQuote ? lastQuote.timestamp : 0,
      quoteAgeMs: lastQuote ? Math.max(0, now - lastQuote.timestamp) : null,
      assetsWithFreshQuotes: activeAssets,
      trackedAssetCount: tickEntries.length,
      scanCounter: Number(core._scanCount) || 0,
      tradeBusy: !!core._tradeBusy,
      autoTrade: !!config.autoTrade,
      multiPairTrading: !!config.multiPairTrading,
      accountType: window._poAccountType || null,
      analysis,
      config: clone({
        indicators: config.indicators || (config.indicator ? [config.indicator] : []),
        filterMode: config.filterMode || 'ALL',
        expiration: config.expiration || null,
        analysisTimeframeSeconds: config.analysisTimeframeSeconds || null,
        htfFilter: !!config.htfFilter,
        multiPairTrading: !!config.multiPairTrading,
        autoTrade: !!config.autoTrade,
        baseBet: config.baseBet || null,
        moneyManagement: config.moneyManagement || 'fixed',
        indConfig: config.indConfig || {}
      })
    };
  }

  window.addEventListener('online', () => {
    state.online = true;
    state.networkChangedAt = Date.now();
    state.networkEvent = 'online';
  });
  window.addEventListener('offline', () => {
    state.online = false;
    state.networkChangedAt = Date.now();
    state.networkEvent = 'offline';
  });

  window.__PT_DESKTOP_EXTENSION_INJECTED__ = true;
  window.__PT_DESKTOP_BG_PROBE__ = state;

  window.setInterval(() => {
    state.ticks += 1;
    state.lastTickAt = Date.now();
    refreshRuntimeSnapshot();
  }, 1000);

  refreshRuntimeSnapshot();
})();
