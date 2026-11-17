(() => {
  'use strict';

  const __ptHost = String(location.hostname || '').toLowerCase();
  if (!(__ptHost === 'pocketoption.com' || __ptHost.endsWith('.pocketoption.com') || __ptHost === 'po.trade' || __ptHost.endsWith('.po.trade'))) return;

  // Build-aware takeover marker: deduplicate the same injected build, but allow a
  // newer extension build to replace an invalidated isolated-world controller in an
  // already-open Pocket tab without waiting for a manual page reload.
  const PT_CONTENT_BUILD_ID = 'expansion-local-1.0.3-audit1';
  if (window.__PO_BRIDGE_CONTENT_BUILD_ID__ === PT_CONTENT_BUILD_ID) return;
  window.__PO_BRIDGE_CONTENT_BUILD_ID__ = PT_CONTENT_BUILD_ID;

  // A modal injected by a previous content-script instance remains in the page
  // DOM after Chrome replaces/reloads the extension, but its click handlers can
  // no longer reach chrome.storage. Remove that stale, unsaveable copy before the
  // fresh controller mounts its own UI.
  try { document.getElementById('pt-robot-disclosure-modal-host')?.remove(); } catch {}

  const VERSION = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '2.0.50');
  const PT_STATUS_BAR_HOST_ID = 'pocket-trade-robot-status-host';
  const PT_STATUS_BAR_OWNER = 'pocket-trade-robot';

  // A controller from a previous extension build may leave its DOM host behind
  // after Chrome invalidates that script context. Remove only our owned stale
  // host before mounting the new build so duplicate IDs cannot hide the bar.
  try {
    document.querySelectorAll(`#${PT_STATUS_BAR_HOST_ID}[data-pt-status-bar-owner="${PT_STATUS_BAR_OWNER}"]`)
      .forEach((node) => node.remove());
  } catch {}

  // Autotrading is armed only for the lifetime of the current Pocket tab.
  // sessionStorage survives a normal reload in the same tab, but disappears when
  // the tab is closed. This prevents a previously enabled trading session from
  // silently resuming in a newly opened Pocket Option tab.
  const AUTOTRADE_TAB_SESSION_KEY = 'ptAutoTradeArmedTabSessionV1';

  function isAutoTradeArmedForThisTabSession() {
    try { return sessionStorage.getItem(AUTOTRADE_TAB_SESSION_KEY) === '1'; }
    catch { return false; }
  }

  function setAutoTradeArmedForThisTabSession(armed) {
    try {
      if (armed) sessionStorage.setItem(AUTOTRADE_TAB_SESSION_KEY, '1');
      else sessionStorage.removeItem(AUTOTRADE_TAB_SESSION_KEY);
    } catch {}
  }


  // v1.0.66 HEALTH RELOAD: remove any old visible update/context banners that may
  // have been injected by previous builds. New builds do not show this banner anymore.
  function cleanupLegacyExtensionContextBanner() {
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
    } catch {}
  }
  cleanupLegacyExtensionContextBanner();
  setTimeout(cleanupLegacyExtensionContextBanner, 250);
  setTimeout(cleanupLegacyExtensionContextBanner, 1500);

  const MARKER = '__PO_ACCOUNT_BRIDGE__';

  // Trading below 75% payout is never allowed. Strategy calibration and each
  // Martingale step may require a stricter threshold, but no execution path may
  // lower the floor below 75%.
  const MIN_TRADE_PAYOUT = 75;

  // Martingale expiration is inherited from the actual base/previous losing trade.
  // Each step also owns an independent minPayout threshold clamped to 75–100%.
  const DEFAULT_RECOVERY_PLAN = [
    { multiplier: 2, duration: 0, minPayout: MIN_TRADE_PAYOUT },
    { multiplier: 4, duration: 0, minPayout: MIN_TRADE_PAYOUT },
    { multiplier: 8, duration: 0, minPayout: MIN_TRADE_PAYOUT },
    { multiplier: 16, duration: 0, minPayout: MIN_TRADE_PAYOUT },
    { multiplier: 32, duration: 0, minPayout: MIN_TRADE_PAYOUT }
  ];

  const MAX_RECOVERY_MULTIPLIER = 100;

  const ALLOWED_OTC_EXPIRATION_SECONDS = Object.freeze([3, 5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 2700, 3600, 7200, 10800, 14400, 86400]);
  const ALLOWED_STANDARD_EXPIRATION_SECONDS = Object.freeze([60, 120, 180, 300, 600, 900, 1800, 2700, 3600, 7200, 10800, 14400, 86400]);
  const ALLOWED_EXPIRATION_SECONDS = ALLOWED_OTC_EXPIRATION_SECONDS;
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


  function isAllowedProductAsset(symbol) {
    // MARKET v1.0.66: do not restrict the Pocket Option catalog by product type.
    // Every tradable symbol delivered by Pocket Option (FX, OTC, exotics, stocks,
    // crypto, metals, commodities, indices, synthetics) must remain selectable.
    // Keep only basic symbol hygiene so malformed/control strings cannot enter
    // storage or execution payloads.
    const raw = String(symbol || '').normalize('NFKC').replace(/\u00a0/g, ' ').trim();
    if (!raw || raw.length > 120) return false;
    if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
    return /^[#]?[A-Za-z0-9][A-Za-z0-9._-]*(?:_otc)?$/i.test(raw);
  }

  function isOtcAsset(asset) {
    const symbol = String(asset || '').trim();
    if (!symbol) return false;
    if (/_otc$/i.test(symbol)) return true;
    const item = (latestState?.market?.assetList || []).find((entry) => String(entry?.symbol || '') === symbol);
    return Boolean(item?.isOtc);
  }

  function expirationListForAsset(asset) {
    return asset ? (isOtcAsset(asset) ? ALLOWED_OTC_EXPIRATION_SECONDS : ALLOWED_STANDARD_EXPIRATION_SECONDS) : ALLOWED_EXPIRATION_SECONDS;
  }

  function normalizeAllowedExpirationList(raw) {
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

  function brokerExpirationListForAsset(asset) {
    const symbol = String(asset || '').trim();
    if (!symbol) return [];
    const market = latestState?.market || {};
    const info = Array.isArray(market.assetList) ? market.assetList.find((entry) => String(entry?.symbol || '') === symbol) : null;
    const sub = market.subscriptions?.[symbol] || null;
    const fromInfo = normalizeAllowedExpirationList(info?.allowedCandles || info?.allowed_candles || info?.timeframes);
    if (fromInfo.length) return fromInfo;
    const fromSub = normalizeAllowedExpirationList(sub?.allowedCandles || sub?.allowed_candles || sub?.timeframes);
    if (fromSub.length) return fromSub;
    return [];
  }

  function finitePositiveSeconds(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0 || num > 86400) return null;
    return Math.round(num);
  }

  function assetExpirationBounds(asset) {
    const symbol = String(asset || '').trim();
    if (!symbol) return { min: null, max: null, source: null };
    const market = latestState?.market || {};
    const info = Array.isArray(market.assetList) ? market.assetList.find((entry) => String(entry?.symbol || '') === symbol) : null;
    const sub = market.subscriptions?.[symbol] || null;
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

  function expirationSupportForAsset(asset, duration) {
    const seconds = Math.max(1, Math.round(Number(duration) || 0));
    const bounds = assetExpirationBounds(asset);
    const allowed = brokerExpirationListForAsset(asset);

    if (bounds.min != null && seconds < bounds.min) {
      return { supported: false, reason: `экспирация ${seconds} сек ниже брокерского минимума ${bounds.min} сек для ${asset}`, allowed, bounds };
    }

    // Pocket/Partners can report max_timeframe=3 for the broker turbo profile,
    // while the same OTC asset still accepts 5/10/15/30s and regular 60s+ orders.
    // Therefore max<60 is not a hard maximum for OTC assets; it only blocks
    // sub-minute requests on non-OTC symbols unless an explicit allowed list confirms them.
    const hasTurboOnlyMax = bounds.max != null && bounds.max < 60;
    const isOtc = isOtcAsset(asset);

    if (allowed.includes(seconds)) return { supported: true, reason: 'confirmed_by_allowed_list', allowed, bounds };

    if (bounds.max != null && seconds > bounds.max) {
      if (!hasTurboOnlyMax || (seconds < 60 && !isOtc)) {
        return { supported: false, reason: `экспирация ${seconds} сек выше брокерского максимума ${bounds.max} сек для ${asset}`, allowed, bounds };
      }
    }

    if (bounds.min != null || (bounds.max != null && !hasTurboOnlyMax)) {
      return { supported: true, reason: 'confirmed_by_min_max_timeframe', allowed, bounds };
    }

    // Pocket Option `allowedCandles` is often a chart timeframe list, not a
    // option expiration list. When official min_timeframe/max_timeframe is
    // absent or max_timeframe only describes turbo mode, fall back safely:
    // 60s+ for all assets, sub-minute only for OTC symbols. We still send the
    // exact requested duration and never convert 3s/5s to 60s.
    if (seconds >= 60) return { supported: true, reason: hasTurboOnlyMax ? 'standard_duration_fallback_turbo_max_ignored' : 'standard_duration_fallback', allowed, bounds };
    if (isOtcAsset(asset)) return { supported: true, reason: 'otc_turbo_fallback', allowed, bounds };
    return { supported: false, reason: `экспирация ${seconds} сек доступна только если брокер подтвердил turbo/min_timeframe для ${asset}`, allowed, bounds };
  }

  function normalizeExpirationSeconds(value, fallback = 60, asset = null) {
    // This normalizes only to a supported general duration bucket. It must not
    // silently convert a user/Martingale 3s request into 60s for live assets.
    // Asset-specific availability is checked later against Pocket Option's
    // allowedCandles before any openOrder packet is sent.
    const allowed = ALLOWED_EXPIRATION_SECONDS;
    const raw = Number(value);
    const base = Number.isFinite(raw) && raw > 0 ? raw : Number(fallback) || 60;
    const rounded = Math.round(base);
    if (allowed.includes(rounded)) return rounded;
    const higher = allowed.find((item) => item >= rounded);
    return higher || allowed[allowed.length - 1];
  }


  function inferCustomStrategyExpiration(config = {}, name = '') {
    const explicit = finiteNumber(config?.expiration ?? config?.duration ?? config?.execution?.duration ?? config?.execution?.expiration);
    if (explicit != null && explicit > 0) return normalizeExpirationSeconds(explicit, explicit);
    const label = String(name || config?.name || config?.title || '').toUpperCase();
    if (/EXP\s*30\s*SEC/.test(label)) return 30;
    const minuteMatch = label.match(/EXP\s*M(1|2|3|5|10|15|30)(?:\D|$)/);
    if (minuteMatch) return Number(minuteMatch[1]) * 60;
    const timeframe = finiteNumber(config?.timeframe);
    if (timeframe != null && timeframe > 0) return normalizeExpirationSeconds(timeframe, timeframe);
    return 60;
  }

  function isThreeCandleStrategyConfig(config = {}, name = '') {
    const mode = String(config?.engineMode || config?.strategyEngine || '').toLowerCase();
    const label = String(name || config?.name || config?.title || '').toUpperCase();
    return ['three_candle_ema_position_v1', 'three_candle_ema9_medium_v2', 'three_candle_ema14_medium_v3'].includes(mode)
      || /^3CANDLE(?:\s|_|-)TRAND(?:\s|_|-)(?:M(?:1|2|3|5|10|15|30)|(?:5|10|15|30)S)(?:\s|_|-)(?:BUY|SELL)$/.test(label);
  }

  function sanitizeCustomStrategyGlobalFields(config = {}) {
    const next = { ...(config && typeof config === 'object' ? config : {}) };
    const legacyExecution = next.execution && typeof next.execution === 'object' ? next.execution : {};
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
      'martingale','recovery','recoveryConfig','recoveryDurationMode',
      'recoveryMode','recoveryValue','recoverySteps','recoveryPlan',
      'recoveryAfterMax','recoveryStartedAt','recoveryFollowSignal',
      'recoveryAllowConcurrent','recoveryScopeStrategyId','recoveryScopeAsset',
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

  function formatDuration(seconds) {
    const value = Math.max(1, Math.round(Number(seconds) || 1));
    if (value < 60) return `${value} сек`;
    if (value % 3600 === 0) return `${value / 3600} ч`;
    if (value % 60 === 0) return `${value / 60} мин`;
    return `${value} сек`;
  }

  const DEFAULT_SETTINGS = {
    asset: 'EURUSD_otc',
    amount: 1,
    duration: 60,
    period: 60,
    confirmTrades: true,
    statusBarVisibilityVersion: 1,
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
    autoTrade: { enabled: false, strategyId: '', strategyIds: [], strategyMode: 'best', candleMode: 'closed', candleOffset: -1, amountMode: 'fixed', amount: 1, balancePercent: 1, maxAmount: 10, expirationMode: 'fixed', expirationMultiplier: 0, duration: 60, period: 60, strategyProfiles: {}, profileSettingsVersion: 1, decisionMode: 'direction_only', cooldown: 5, maxConcurrent: 1, minPayout: MIN_TRADE_PAYOUT, direction: 'both', takeProfit: 0, stopLoss: 0, maxTrades: 0, maxLossStreak: 0, maxWinStreak: 0, recoveryMode: 'off', recoveryValue: 2, recoverySteps: 0, recoveryPlan: DEFAULT_RECOVERY_PLAN.map((step) => ({ ...step })), recoveryAfterMax: 'stop', recoveryFollowSignal: false, recoveryStartedAt: null, onePerAsset: true, sessionStartedAt: null, riskDefaultsVersion: 7 },
    builderStrategies: []
  };

  const CALIBRATION_VERSION = 2;
  const CALIBRATION_STORAGE_KEY = 'ptStrategyCalibration';
  const CALIBRATED_STRATEGY_IDS = new Set(['builtin-trend', 'builtin-smartflow', 'builtin-liquidity', 'builtin-otc', 'builtin-smart', 'builtin-pattern', 'builtin-ai']);
  const UNIVERSAL_GLOBAL_STRATEGY_IDS = new Set(['builtin-trend', 'builtin-otc', 'builtin-smart']);
  const STRICT_SAME_TF_STRATEGY_IDS = new Set(['builtin-ai']);
  const PATTERN_PULSE_STRATEGY_ID = 'builtin-pattern';
  const PROFILE_DURATION_BUCKETS = [5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 14400, 86400];

  function normalizeProfileTfSeconds(value, fallback = 60) {
    const raw = Math.max(5, Math.round(finiteNumber(value) ?? finiteNumber(fallback) ?? 60));
    return PROFILE_DURATION_BUCKETS.reduce((best, item) => Math.abs(item - raw) < Math.abs(best - raw) ? item : best, PROFILE_DURATION_BUCKETS[0]);
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

  function storedStrategyProfile(strategyId, auto = settings.autoTrade || {}) {
    const id = String(strategyId || '').trim();
    return normalizeStoredStrategyProfiles(auto?.strategyProfiles, auto)[id] || null;
  }

  function primaryStrategyIdFromAuto(auto, signal = null) {
    const fromSignal = String(signal?.strategyId || signal?.strategy_id || '').trim();
    if (fromSignal) return fromSignal;
    const ids = Array.isArray(auto?.strategyIds) ? auto.strategyIds.map((item) => String(item || '').trim()).filter(Boolean) : [];
    return ids[0] || String(auto?.strategyId || settings.activeStrategyId || '').trim();
  }

  function effectiveProfilePeriodForStrategy(strategyId, requestedPeriod = 60, auto = settings.autoTrade || {}) {
    const id = String(strategyId || '').trim();
    if (isConstructorStrategy(id)) {
      const config = customStrategyConfig(id);
      const customTimeframe = finiteNumber(config?.timeframe);
      // Constructor/imported profiles never read Trading globals at execution time.
      if (customTimeframe != null && customTimeframe > 0) return normalizeAnalysisPeriodSeconds(customTimeframe, 60);
      return 60;
    }
    const stored = storedStrategyProfile(id, auto);
    if (id === PATTERN_PULSE_STRATEGY_ID) return 5;
    if (id === 'builtin-smartflow' || id === 'builtin-liquidity') return 60;
    if (UNIVERSAL_GLOBAL_STRATEGY_IDS.has(id) || STRICT_SAME_TF_STRATEGY_IDS.has(id)) {
      return normalizeProfileTfSeconds(stored?.period ?? requestedPeriod, 60);
    }
    const profile = baseStrategyProfileConfig(id);
    const explicitPeriod = finiteNumber(stored?.period ?? profile?.timeframe ?? profile?.analysisPeriod ?? profile?.period);
    if (explicitPeriod != null && explicitPeriod > 0) return normalizeAnalysisPeriodSeconds(explicitPeriod, requestedPeriod || 60);
    return normalizeAnalysisPeriodSeconds(requestedPeriod, 60);
  }

  function effectiveProfilePeriodForAuto(auto, signal = null) {
    return effectiveProfilePeriodForStrategy(primaryStrategyIdFromAuto(auto, signal), signal?.period ?? auto?.period ?? settings.period ?? 60, auto);
  }

  function effectiveProfileExpirationForAuto(auto, signal = null, asset = null) {
    const strategyId = primaryStrategyIdFromAuto(auto, signal);
    if (isConstructorStrategy(strategyId)) {
      const config = customStrategyConfig(strategyId) || {};
      const explicit = finiteNumber(config.expiration ?? config.duration ?? config.execution?.duration ?? config.execution?.expiration);
      return normalizeExpirationSeconds(explicit ?? 60, 60, asset);
    }
    if (strategyId === PATTERN_PULSE_STRATEGY_ID) return 5;
    const stored = storedStrategyProfile(strategyId, auto);
    if (strategyId === 'builtin-smartflow') {
      const duration = normalizeExpirationSeconds(stored?.duration ?? auto?.duration ?? 180, 180, asset);
      return [120, 180].includes(duration) ? duration : 180;
    }
    if (strategyId === 'builtin-liquidity') return 120;
    if (UNIVERSAL_GLOBAL_STRATEGY_IDS.has(strategyId) || STRICT_SAME_TF_STRATEGY_IDS.has(strategyId)) {
      return normalizeExpirationSeconds(stored?.duration ?? auto?.duration ?? settings.duration ?? 60, 60, asset);
    }
    const explicit = explicitBaseStrategyDuration(strategyId, signal, asset);
    if (explicit != null) return explicit;
    return normalizeExpirationSeconds(stored?.duration ?? auto?.duration, 60, asset);
  }

  function strategyCandleOffsetForAuto(strategyId, auto = settings.autoTrade || {}) {
    const id = String(strategyId || '').trim();
    if (isConstructorStrategy(id)) {
      const config = customStrategyConfig(id) || {};
      return normalizeCandleOffset(config.candleOffset, config.candleMode);
    }
    const stored = storedStrategyProfile(id, auto);
    return normalizeCandleOffset(stored?.candleOffset ?? auto?.candleOffset, stored?.candleMode ?? auto?.candleMode);
  }

  function strategyCooldownForAuto(strategyId, auto = settings.autoTrade || {}) {
    const id = String(strategyId || '').trim();
    if (isConstructorStrategy(id)) {
      const value = Number(customStrategyConfig(id)?.cooldown);
      return Math.max(0, Number.isFinite(value) ? value : 0);
    }
    const value = Number(storedStrategyProfile(id, auto)?.cooldown);
    return Math.max(0, Number.isFinite(value) ? value : Number(auto?.cooldown) || 0);
  }

  function strategyExecutionDurationCompatible(strategyId, periodValue, durationValue) {
    const id = String(strategyId || '').trim();
    if (!id) return false;
    if (isConstructorStrategy(id)) return true;
    const period = normalizeAnalysisPeriodSeconds(periodValue, 60);
    const duration = normalizeExpirationSeconds(durationValue, 60);
    if (UNIVERSAL_GLOBAL_STRATEGY_IDS.has(id)) return period === duration || (period === 5 && duration === 3);
    if (STRICT_SAME_TF_STRATEGY_IDS.has(id)) return period === duration || (period === 5 && duration === 3);
    if (id === PATTERN_PULSE_STRATEGY_ID) return period === 5 && duration === 5;
    if (id === 'builtin-smartflow') return period === 60 && [120, 180].includes(duration);
    if (id === 'builtin-liquidity') return period === 60 && duration === 120;
    return true;
  }

  function activeExecutionDurationsForAuto(auto = settings.autoTrade || {}) {
    const ids = selectedStrategyIds(auto);
    const durations = ids.map((id) => effectiveProfileExpirationForAuto(auto, { strategyId: id, period: effectiveProfilePeriodForStrategy(id, auto?.period ?? settings.period ?? 60, auto) })).filter((value) => Number.isFinite(value) && value > 0);
    return [...new Set(durations.length ? durations : [normalizeExpirationSeconds(auto?.duration ?? settings.duration ?? 60, 60)])];
  }

  function strategyCompatibleWithGlobalExecution(strategyId, auto = settings.autoTrade || {}) {
    const period = effectiveProfilePeriodForStrategy(strategyId, auto?.period ?? settings.period ?? 60, auto);
    const duration = effectiveProfileExpirationForAuto(auto, { strategyId, period });
    return strategyExecutionDurationCompatible(strategyId, period, duration);
  }

  function selectedStrategyIds(auto) {
    const ids = Array.isArray(auto?.strategyIds) && auto.strategyIds.length
      ? [...new Set(auto.strategyIds.map((item) => String(item || '').trim()).filter(Boolean))]
      : [String(auto?.strategyId || settings.activeStrategyId || '').trim()].filter(Boolean);
    return ids;
  }

  function effectiveAutoStrategyMode(auto = settings.autoTrade || {}, strategyIds = null) {
    const ids = Array.isArray(strategyIds) ? strategyIds : selectedStrategyIds(auto);
    return ids.length > 1 ? 'independent' : (auto?.strategyMode === 'independent' ? 'independent' : 'best');
  }

  function strategyAnalysisPeriod(strategyId, auto = settings.autoTrade || {}) {
    return effectiveProfilePeriodForStrategy(strategyId, auto?.period ?? settings.period ?? 60, auto);
  }

  function selectedStrategyPeriodMap(auto) {
    return Object.fromEntries(selectedStrategyIds(auto).map((id) => [id, strategyAnalysisPeriod(id, auto)]));
  }

  function selectedEffectiveAnalysisPeriod(auto) {
    const periods = Object.values(selectedStrategyPeriodMap(auto)).map(Number).filter((value) => Number.isFinite(value) && value > 0);
    return periods.length ? Math.min(...periods) : normalizeAnalysisPeriodSeconds(auto?.period ?? settings.period ?? 60, 60);
  }


  function marketSubscriptionPlanForAuto(auto = settings.autoTrade || {}, strategyIds = selectedStrategyIds(auto)) {
    const requiredPeriodSet = new Set();
    for (const strategyId of strategyIds) {
      const period = strategyAnalysisPeriod(strategyId, auto);
      requiredPeriodSet.add(period);
      const config = customStrategyConfig(strategyId);
      if (config) customStrategyRequiredTargetPeriods(config, period).forEach((target) => requiredPeriodSet.add(target));
    }
    if (!requiredPeriodSet.size) requiredPeriodSet.add(normalizeAnalysisPeriodSeconds(auto?.period ?? settings.period, 60));
    const periods = [...requiredPeriodSet]
      .map((period) => normalizeAnalysisPeriodSeconds(period, 60))
      .filter((period) => FULL_MARKET_HISTORY_PERIODS.includes(period))
      .sort((a, b) => a - b);
    const primaryPeriod = periods[0] || 60;
    const historyOffsets = Object.fromEntries(periods.map((period) => [period, 180]));
    for (const strategyId of strategyIds) {
      const period = strategyAnalysisPeriod(strategyId, auto);
      const offset = strategyCandleOffsetForAuto(strategyId, auto);
      const requirement = selectedStrategyCandleRequirements([strategyId], auto?.candleMode, offset, period, auto);
      historyOffsets[period] = Math.min(5000, Math.max(Number(historyOffsets[period]) || 180, Number(requirement.requiredHistoryCandles) || 180));
    }
    return { primaryPeriod, periods, historyOffsets, historyOffset: historyOffsets[primaryPeriod] || 180 };
  }

  function profileKeyParts(strategyId, asset, period, duration) {
    const p = normalizeProfileTfSeconds(period ?? duration ?? 60, 60);
    const d = normalizeProfileTfSeconds(duration ?? p, p);
    return [String(strategyId || '').trim(), String(asset || '').trim(), String(p), String(d)];
  }

  const CALIBRATION_BASELINES = Object.freeze({
    'builtin-trend': { minPayout: 75, defaultExpiration: 60, title: 'Trend Fusion' },
    'builtin-smartflow': { minPayout: 80, defaultExpiration: 180, title: 'M1 SmartFlow 2–3M' },
    'builtin-liquidity': { minPayout: 85, defaultExpiration: 120, title: 'M1 Liquidity Sniper 2M' },
    'builtin-otc': { minPayout: 75, defaultExpiration: 60, title: 'Impulse Breakout' },
    'builtin-smart': { minPayout: 75, defaultExpiration: 60, title: 'Heiken Ashi Reversal' },
    'builtin-pattern': { minPayout: 75, defaultExpiration: 5, title: 'Pattern Pulse Scalper 5s' },
    'builtin-ai': { minPayout: 75, defaultExpiration: 60, title: 'Pocket TRADE ROBOT AI Analysis' }
  });
  const CALIBRATION_MIN_SAMPLE_SOFT = 20;
  const CALIBRATION_MIN_SAMPLE_STRONG = 50;

  function createEmptyStrategyCalibration() {
    return { version: CALIBRATION_VERSION, updatedAt: null, processedDealIds: [], profiles: {} };
  }

  let latestState = null;
  const LOGIN_HANDOFF_STORAGE_KEY = 'ptGuestLoginHandoffV170';
  const LOGIN_HANDOFF_TTL_MS = 20 * 60 * 1000;
  const PENDING_LOGIN_WAIT_STORAGE_KEY = 'ptPendingLoginWaitStatusV171';
  const PENDING_LOGIN_WAIT_TTL_MS = 20 * 60 * 1000;
  let loginHandoffAttemptAt = 0;
  let guestLaunchWaiting = isGuestTryDemoPage();

  function isGuestTryDemoPage() {
    return /(?:^|\/)try-demo(?:\/|$)/i.test(String(location.pathname || ''));
  }
  function isTradingAccountPage() {
    return /(?:^|\/)(?:demo-quick(?:-high-low)?|real-quick(?:-high-low)?)(?:\/|$)/i.test(String(location.pathname || ''));
  }
  function isPocketCabinetPage() {
    return /(?:^|\/)cabinet(?:\/|$)/i.test(String(location.pathname || ''));
  }
  function hasObservedPocketLogin(state = latestState) {
    const passive = Boolean(state?.login?.authenticated === true && state?.login?.uid != null);
    const connectedIdentity = Boolean(state?.account?.uid != null && state?.account?.sessionCaptured === true);
    return passive || connectedIdentity;
  }
  function isRobotEligiblePage(state = latestState) {
    // /try-demo is always guest-only, even though Pocket renders a virtual demo
    // balance and market UI there. Never show legal/Robot on that route.
    if (isGuestTryDemoPage()) return false;
    if (!isPocketCabinetPage() && !isTradingAccountPage()) return false;
    return hasObservedPocketLogin(state);
  }
  function isWaitingForPocketLogin(state = latestState) {
    if (isGuestTryDemoPage()) return true;
    return !isRobotEligiblePage(state) && !hasObservedPocketLogin(state);
  }
  async function refreshPocketLoginState() {
    const response = await pageCommand('GET_STATE', null, 1800).catch(() => null);
    if (response?.state) {
      latestState = mergeCompactStateWithSnapshots(response.state);
      scheduleRender(true);
    }
    return latestState;
  }
  let profitStats = null;
  let robotLedger = { version: 3, robotOnly: true, closedDeals: [], openDeals: [], summary: {}, today: {} };
  let strategyCalibration = createEmptyStrategyCalibration();
  let strategyCalibrationSaveTimer = null;
  let settings = mergeSettings({});
  let serverState = null;
  let trialStatusClockAnchor = null;
  let trialExpirySyncAt = 0;
  let saveTimer = null;
  let lastSavedTradeFingerprint = '';
  let lastSavedCriticalStateFingerprint = '';
  const STATE_PERSIST_INTERVAL_MS = 3000;
  let renderTimer = null;
  let host = null;
  let shadow = null;
  let noticeHost = null;
  let embeddedDashboardHost = null;
  let renderEmbeddedDashboardLanguage = null;
  let statusBarPlacement = null;
  let statusHostObserver = null;
  let statusHostDock = null;
  let statusHostRightBlock = null;
  let statusHostRemountTimer = null;
  let lastNoticeId = null;
  let uiLanguage = 'ru';
  const tradeResultNoticeQueue = [];
  const tradeResultNoticeSeenIds = new Set();
  let tradeResultNoticeActive = false;
  let tradeResultNoticeBaselineReady = false;

  function tradeNoticeIdentity(deal) {
    return String(deal?.id || deal?.dealId || deal?.requestId || `${deal?.asset || ''}:${deal?.closeTimestamp || ''}:${deal?.amount || ''}`);
  }

  function tradeNoticeStrategy(deal) {
    const explicit = String(deal?.strategyName || deal?.strategyTitle || '').trim();
    if (explicit) return explicit;
    const id = String(deal?.strategyId || '').trim();
    if (!id) return 'Автоторговля';
    const custom = [...(settings?.builderStrategies || []), ...(settings?.importedStrategies || [])]
      .find((item) => String(item?.id || '') === id);
    return String(custom?.name || custom?.title || id).trim();
  }

  function initializeTradeResultNoticeBaseline(deals = []) {
    for (const deal of Array.isArray(deals) ? deals : []) {
      const id = tradeNoticeIdentity(deal);
      if (id) tradeResultNoticeSeenIds.add(id);
    }
    // The journal is bounded, but keep a hard safety cap for a very long session.
    if (tradeResultNoticeSeenIds.size > 2500) {
      const recent = [...tradeResultNoticeSeenIds].slice(-1800);
      tradeResultNoticeSeenIds.clear();
      recent.forEach((id) => tradeResultNoticeSeenIds.add(id));
    }
    tradeResultNoticeBaselineReady = true;
  }

  function enqueueTradeResultNotice(deal) {
    if (settings.tradeResultNotifications === false) return;
    const noticeId = tradeNoticeIdentity(deal);
    if (!noticeId || tradeResultNoticeSeenIds.has(noticeId)) return;
    tradeResultNoticeSeenIds.add(noticeId);
    const net = dealNetValue(deal);
    const kind = net > 0 ? 'win' : net < 0 ? 'loss' : 'draw';
    tradeResultNoticeQueue.push({
      kind,
      asset: String(deal?.asset || 'Сделка').replace(/_otc$/i, ' OTC'),
      strategy: tradeNoticeStrategy(deal),
      amount: Math.abs(net),
      currency: deal?.currency || ledgerCurrency() || 'USD'
    });
    void showNextTradeResultNotice();
  }

  async function showNextTradeResultNotice() {
    if (settings.tradeResultNotifications === false) {
      tradeResultNoticeQueue.length = 0;
      document.getElementById('pt-trade-result-notice')?.remove();
      tradeResultNoticeActive = false;
      return;
    }
    if (tradeResultNoticeActive || !tradeResultNoticeQueue.length) return;
    tradeResultNoticeActive = true;
    const item = tradeResultNoticeQueue.shift();
    document.getElementById('pt-trade-result-notice')?.remove();
    const host = document.createElement('div');
    host.id = 'pt-trade-result-notice';
    host.className = `pt-trade-result-notice ${item.kind}`;
    const title = item.kind === 'win' ? 'СДЕЛКА WIN!' : item.kind === 'loss' ? 'СДЕЛКА LOSS' : 'ВОЗВРАТ СДЕЛКИ';
    const icon = item.kind === 'win' ? '🏆' : item.kind === 'loss' ? '↘' : '↔';
    const amount = item.kind === 'draw' ? 'Результат: 0' : `${item.kind === 'win' ? '+' : '−'}${money(item.amount, item.currency)}`;
    const glow = document.createElement('div');
    glow.className = 'pt-trade-result-glow';
    const iconNode = document.createElement('div');
    iconNode.className = 'pt-trade-result-icon';
    iconNode.textContent = icon;
    const copy = document.createElement('div');
    copy.className = 'pt-trade-result-copy';
    const titleNode = document.createElement('strong');
    titleNode.textContent = title;
    const detailNode = document.createElement('span');
    detailNode.textContent = `${item.asset} · ${item.strategy}`;
    const amountNode = document.createElement('b');
    amountNode.textContent = amount;
    copy.append(titleNode, detailNode, amountNode);
    host.append(glow, iconNode, copy);
    document.documentElement.appendChild(host);
    requestAnimationFrame(() => host.classList.add('show'));
    await new Promise((resolve) => setTimeout(resolve, 4300));
    host.classList.remove('show');
    await new Promise((resolve) => setTimeout(resolve, 500));
    host.remove();
    tradeResultNoticeActive = false;
    void showNextTradeResultNotice();
  }

  function notifyNewClosedTrades(previousLedger, nextLedger) {
    if (!tradeResultNoticeBaselineReady) initializeTradeResultNoticeBaseline(previousLedger?.closedDeals || []);
    const previous = new Set((previousLedger?.closedDeals || []).map(tradeNoticeIdentity));
    const added = (nextLedger?.closedDeals || []).filter((deal) => !previous.has(tradeNoticeIdentity(deal)));
    added.slice(-10).forEach(enqueueTradeResultNotice);
  }

  function notifyClosedTradesFromState(state) {
    const closed = (Array.isArray(state?.trades?.closedDeals) ? state.trades.closedDeals : []).filter(isRobotTradeDeal);
    if (!tradeResultNoticeBaselineReady) {
      initializeTradeResultNoticeBaseline(closed);
      return;
    }
    closed.slice(-100).forEach(enqueueTradeResultNotice);
  }
  const PT_UI_LANGUAGES = Object.freeze(['ru', 'en', 'es', 'hi', 'ar']);
  const PT_UI_LANGUAGE_META = Object.freeze({
    ru: { flag: '🇷🇺', name: 'Русский' },
    en: { flag: '🇬🇧', name: 'English' },
    es: { flag: '🇪🇸', name: 'Español' },
    hi: { flag: '🇮🇳', name: 'हिन्दी' },
    ar: { flag: '🇸🇦', name: 'العربية' }
  });
  const PT_EMBEDDED_HEADER_I18N = Object.freeze({
    ru: { knowledge: 'База знаний', minimize: 'Свернуть', close: 'Закрыть' },
    en: { knowledge: 'Knowledge base', minimize: 'Minimize', close: 'Close' },
    es: { knowledge: 'Base de conocimientos', minimize: 'Minimizar', close: 'Cerrar' },
    hi: { knowledge: 'ज्ञान आधार', minimize: 'मिनिमाइज़ करें', close: 'बंद करें' },
    ar: { knowledge: 'قاعدة المعرفة', minimize: 'تصغير', close: 'إغلاق' }
  });
  function normalizeUiLanguage(value) {
    const candidate = String(value || '').trim().toLowerCase().split('-')[0];
    return PT_UI_LANGUAGES.includes(candidate) ? candidate : 'ru';
  }
  function normalizeStatusBarPlacement(value) {
    if (!value || typeof value !== 'object') return null;
    const left = Number(value.left ?? value.x);
    const top = Number(value.top ?? value.y);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left: Math.round(left), top: Math.round(top) };
  }
  const pending = new Map();
  const marketSnapshots = new Map();
  const pocketMarketSnapshots = new Map();
  const cacheBridgeSnapshots = new Map();
  const cacheBridgeControl = {
    enabled: false,
    baseUrl: 'local://cache-disabled',
    online: false,
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    lastLatencyMs: null,
    lastError: null,
    lastResultCount: 0,
    primaryScopes: new Set(),
    fallbackScopes: new Set(),
    fallbackAssets: [],
    subscriptionSignature: '',
    subscriptionAppliedAt: 0,
    subscriptionInFlight: null
  };
  const marketCacheFingerprints = new Map();
  const marketCacheTimers = new Map();
  const graphSubscriptionManager = {
    token: 0,
    enabled: false,
    assets: [],
    assetsByPeriod: {},
    periods: [],
    primaryPeriod: 60,
    historyOffsets: {},
    refreshDueAt: new Map(),
    bootstrapPendingPeriods: new Set(),
    inFlightPeriods: new Set(),
    bootstrapAttempts: new Map(),
    timer: null,
    bootstrapping: false
  };

  function marketSnapshotKey(asset, period) {
    return `${String(asset || '').trim()}|${Math.max(1, Number(period) || 60)}`;
  }

  function getMarketSnapshot(asset, period = null) {
    const symbol = String(asset || '').trim();
    if (!symbol) return null;
    if (period != null) {
      const exact = marketSnapshots.get(marketSnapshotKey(symbol, period));
      if (exact) return exact;
    }
    const fallback = marketSnapshots.get(symbol) || null;
    if (fallback && (period == null || Number(fallback.period) === Number(period))) return fallback;
    const primary = latestState?.market?.subscriptions?.[symbol] || null;
    if (primary && (period == null || Number(primary.period) === Number(period))) return primary;
    const auxiliary = latestState?.market?.timeframeSubscriptions?.[marketSnapshotKey(symbol, period)] || null;
    return auxiliary;
  }

  function getPocketMarketSnapshot(asset, period = null) {
    const symbol = String(asset || '').trim();
    if (!symbol) return null;
    if (period != null) {
      const exact = pocketMarketSnapshots.get(marketSnapshotKey(symbol, period));
      if (exact) return exact;
    }
    const fallback = pocketMarketSnapshots.get(symbol) || null;
    if (fallback && (period == null || Number(fallback.period) === Number(period))) return fallback;
    const primary = latestState?.market?.subscriptions?.[symbol] || null;
    if (primary && primary.source !== 'cache-bridge' && (period == null || Number(primary.period) === Number(period))) return primary;
    const auxiliary = latestState?.market?.timeframeSubscriptions?.[marketSnapshotKey(symbol, period)] || null;
    if (auxiliary && auxiliary.source !== 'cache-bridge') return auxiliary;
    return null;
  }

  function putMarketSnapshot(asset, snapshot) {
    const symbol = String(asset || '').trim();
    const period = Math.max(1, Number(snapshot?.period) || 60);
    if (!symbol || !snapshot) return null;
    const key = marketSnapshotKey(symbol, period);
    const previous = marketSnapshots.get(key) || {};
    const merged = { ...previous, ...snapshot, asset: symbol, period };
    if (!Array.isArray(snapshot.historyItems) && Array.isArray(previous.historyItems)) merged.historyItems = previous.historyItems;
    marketSnapshots.set(key, merged);
    const primaryPeriod = Number(latestState?.market?.period || graphSubscriptionManager.primaryPeriod || 0);
    if (!marketSnapshots.has(symbol) || period === primaryPeriod) marketSnapshots.set(symbol, merged);
    return merged;
  }

  function cacheBridgeLatestTime(snapshot) {
    const values = [];
    if (Array.isArray(snapshot?.historyItems)) values.push(...snapshot.historyItems.map((item) => Number(item?.time) || 0));
    if (Array.isArray(snapshot?.recentCandles)) values.push(...snapshot.recentCandles.map((item) => Number(item?.time) || 0));
    values.push(Number(snapshot?.currentCandle?.time) || 0);
    return Math.max(0, ...values);
  }

  function mergeCacheBridgeResult(result, requestedLimit = 5000, batchServerTime = null) {
    if (!result?.ok || !result.asset) return null;
    const asset = String(result.asset);
    const period = Math.max(1, Number(result.period) || 60);
    const key = marketSnapshotKey(asset, period);
    const previous = cacheBridgeSnapshots.get(key) || {};
    const numericServerTime = Number(batchServerTime);
    const parsedServerTime = Date.parse(String(batchServerTime || ''));
    const serverNow = Math.max(1,
      Number.isFinite(numericServerTime) && numericServerTime > 0
        ? Math.floor(numericServerTime > 10_000_000_000 ? numericServerTime / 1000 : numericServerTime)
        : Number.isFinite(parsedServerTime)
          ? Math.floor(parsedServerTime / 1000)
          : Math.floor(Date.now() / 1000)
    );
    const oldestAllowed = serverNow - Math.max(86_400, period * Math.max(60, Number(requestedLimit) || 5000) * 6);
    const byTime = new Map();
    const add = (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const rawOpen = finiteNumber(raw.open);
      const rawHigh = finiteNumber(raw.high);
      const rawLow = finiteNumber(raw.low);
      const rawClose = finiteNumber(raw.close);
      const rawTime = Math.floor(finiteNumber(raw.time) ?? 0);
      if (
        !rawTime
        || [rawOpen, rawHigh, rawLow, rawClose].some((value) => value == null || value <= 0)
        || rawHigh < Math.max(rawOpen, rawClose)
        || rawLow > Math.min(rawOpen, rawClose)
        || rawHigh < rawLow
        || rawTime % period !== 0
        || rawTime < oldestAllowed
        || rawTime > serverNow + period * 2
      ) return;
      const candle = normalizeSnapshotCandle(raw);
      if (candle) byTime.set(candle.time, candle);
    };
    for (const raw of Array.isArray(previous.historyItems) ? previous.historyItems : []) add(raw);
    for (const raw of Array.isArray(previous.recentCandles) ? previous.recentCandles : []) add(raw);
    add(previous.currentCandle);
    for (const raw of Array.isArray(result.historyItems) ? result.historyItems : []) add(raw);
    for (const raw of Array.isArray(result.candles) ? result.candles : []) add(raw);
    add(result.currentCandle);

    const ordered = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-Math.max(60, Math.min(5000, Number(requestedLimit) || 5000)));
    if (!ordered.length) return null;
    for (let index = 1; index < ordered.length; index += 1) {
      const previousClose = Math.abs(Number(ordered[index - 1]?.close) || 0);
      const nextClose = Math.abs(Number(ordered[index]?.close) || 0);
      if (previousClose > 0 && nextClose > 0 && Math.max(previousClose, nextClose) / Math.min(previousClose, nextClose) > 4) {
        return null;
      }
    }
    const currentBucket = Math.floor(serverNow / period) * period;
    let currentCandle = normalizeSnapshotCandle(result.currentCandle);
    if (!currentCandle || Math.floor(currentCandle.time / period) * period !== currentBucket) {
      const latest = ordered[ordered.length - 1];
      currentCandle = latest && Math.floor(latest.time / period) * period === currentBucket ? latest : null;
    }
    const currentTime = Number(currentCandle?.time || 0);
    const historyItems = ordered.filter((item) => !currentTime || item.time < currentTime);
    const latest = ordered[ordered.length - 1];
    const snapshot = putMarketSnapshot(asset, {
      asset,
      period,
      requested: true,
      subscribed: true,
      streamActive: result.fresh === true,
      requestedAt: previous.requestedAt || new Date().toISOString(),
      streamUpdatedAt: latest?.time ? new Date(latest.time * 1000).toISOString() : new Date().toISOString(),
      lastPrice: latest?.close ?? null,
      lastTickTime: latest?.time || null,
      tickCount: Number(latest?.ticks || 0),
      historyCount: historyItems.length,
      historyReceivedAt: new Date().toISOString(),
      historyItems,
      currentCandle,
      recentCandles: ordered.slice(-20),
      recentTicks: [],
      source: 'cache-bridge',
      marketDataSource: result.source || (/_otc$/i.test(asset) ? 'CasheOTC.json' : 'cashe.json'),
      cacheBridgeFresh: result.fresh === true,
      cacheBridgeAgeMs: Number(result.ageMs) || 0,
      cacheBridgeFreshLimitMs: Number(result.freshLimitMs) || null,
      cacheBridgeGeneration: Number(result.generation) || 0,
      cacheBridgeFetchedAt: Date.now(),
      cacheBridgeResolvedAsset: result.resolvedAsset || asset,
      cacheBridgeResampled: result.resampled === true,
      cacheBridgeSourcePeriod: Number(result.sourcePeriod) || period
    });
    if (snapshot) cacheBridgeSnapshots.set(key, snapshot);
    return snapshot;
  }

  function cacheBridgeSnapshotUsable(asset, period, minimumCandles = 40) {
    const snapshot = cacheBridgeSnapshots.get(marketSnapshotKey(asset, period)) || null;
    if (!snapshot || snapshot.cacheBridgeFresh !== true) return false;
    const fetchedAge = Date.now() - Number(snapshot.cacheBridgeFetchedAt || 0);
    const allowedFetchedAge = Math.max(15000, Number(period) * 4000);
    if (!Number.isFinite(fetchedAge) || fetchedAge > allowedFetchedAge) return false;
    const split = splitCandlesForSubscription(snapshot);
    return split.closed.length >= Math.max(1, Number(minimumCandles) || 40);
  }

  async function refreshCacheBridgeSnapshots(requests, options = {}) {
    const deduped = new Map();
    for (const raw of Array.isArray(requests) ? requests : []) {
      const asset = String(raw?.asset || '').trim();
      const period = Math.max(1, Number(raw?.period) || 60);
      if (!asset) continue;
      const key = marketSnapshotKey(asset, period);
      const limit = Math.max(60, Math.min(5000, Number(raw?.limit) || 400));
      const previous = cacheBridgeSnapshots.get(key);
      const sinceTime = options.forceFull === true ? 0 : Math.max(0, Number(raw?.sinceTime) || cacheBridgeLatestTime(previous));
      const current = deduped.get(key);
      if (!current || limit > current.limit) deduped.set(key, { asset, period, limit, sinceTime });
    }
    const normalized = [...deduped.values()];
    if (!normalized.length) return { ok: true, results: [], usableScopes: new Set(), failedScopes: new Set() };
    cacheBridgeControl.lastAttemptAt = Date.now();
    const response = await safeRuntimeMessage({
      type: 'PT_CACHE_BRIDGE_CANDLES',
      payload: { requests: normalized, timeoutMs: options.timeoutMs || 12000 }
    }, Math.max(15000, Number(options.timeoutMs) || 12000) + 3000).catch((error) => ({ ok: false, error: String(error?.message || error), results: [] }));

    cacheBridgeControl.online = response?.ok === true;
    cacheBridgeControl.baseUrl = String(response?.bridgeBaseUrl || response?.runtime?.activeBaseUrl || cacheBridgeControl.baseUrl);
    cacheBridgeControl.lastLatencyMs = Number(response?.bridgeLatencyMs ?? response?.runtime?.lastLatencyMs) || null;
    cacheBridgeControl.lastError = response?.ok ? null : String(response?.error || 'cache_bridge_unavailable');
    cacheBridgeControl.lastResultCount = Array.isArray(response?.results) ? response.results.length : 0;
    if (response?.ok) cacheBridgeControl.lastSuccessAt = Date.now();
    const usableScopes = new Set();
    const failedScopes = new Set();
    const limitByKey = new Map(normalized.map((item) => [marketSnapshotKey(item.asset, item.period), item.limit]));
    for (const result of Array.isArray(response?.results) ? response.results : []) {
      const key = marketSnapshotKey(result?.asset, result?.period);
      if (!limitByKey.has(key)) continue;
      if (result?.ok) {
        const snapshot = mergeCacheBridgeResult(result, limitByKey.get(key) || 5000, response?.serverTime);
        if (snapshot?.cacheBridgeFresh === true) usableScopes.add(key);
        else failedScopes.add(key);
      } else if (result?.asset) {
        failedScopes.add(key);
      }
    }
    for (const item of normalized) {
      const key = marketSnapshotKey(item.asset, item.period);
      if (!usableScopes.has(key)) failedScopes.add(key);
    }
    cacheBridgeControl.primaryScopes = usableScopes;
    cacheBridgeControl.fallbackScopes = failedScopes;
    return { ...response, usableScopes, failedScopes };
  }

  async function cacheBridgeCoverageForPlan(assets, periods, historyOffsets = {}, options = {}) {
    const normalizedAssets = [...new Set((Array.isArray(assets) ? assets : []).map((item) => String(item || '').trim()).filter(Boolean))];
    const normalizedPeriods = normalizeGraphPeriods(periods, 60);
    const requests = [];
    for (const asset of normalizedAssets) {
      for (const period of normalizedPeriods) {
        requests.push({
          asset,
          period,
          limit: Math.max(60, Math.min(5000, Number(historyOffsets?.[period]) || Number(options.defaultLimit) || 240))
        });
      }
    }
    await refreshCacheBridgeSnapshots(requests, { forceFull: options.forceFull === true, timeoutMs: options.timeoutMs || 15000 });
    const fallbackScopes = [];
    const cacheScopes = [];
    const minimum = Math.max(20, Number(options.minimumCandles) || 40);
    for (const asset of normalizedAssets) {
      for (const period of normalizedPeriods) {
        const scope = marketSnapshotKey(asset, period);
        if (cacheBridgeSnapshotUsable(asset, period, minimum)) cacheScopes.push(scope);
        else fallbackScopes.push(scope);
      }
    }
    const fallbackAssets = [...new Set(fallbackScopes.map((scope) => scope.slice(0, scope.lastIndexOf('|'))).filter(Boolean))];
    const cacheAssets = normalizedAssets.filter((asset) =>
      normalizedPeriods.every((period) => cacheScopes.includes(marketSnapshotKey(asset, period)))
    );
    cacheBridgeControl.primaryScopes = new Set(cacheScopes);
    cacheBridgeControl.fallbackScopes = new Set(fallbackScopes);
    cacheBridgeControl.fallbackAssets = fallbackAssets;
    return { cacheAssets, fallbackAssets, cacheScopes, fallbackScopes, periods: normalizedPeriods };
  }

  async function applyPocketFallbackSubscriptions({ allAssets, fallbackAssets, fallbackScopes, periods, primaryPeriod, historyOffsets = {}, reason = 'cache_bridge', force = false } = {}) {
    const all = [...new Set((Array.isArray(allAssets) ? allAssets : []).map(String).filter(Boolean))];
    const normalizedPeriods = normalizeGraphPeriods(periods, primaryPeriod || 60);
    const primary = normalizeAnalysisPeriodSeconds(primaryPeriod || normalizedPeriods[0] || 60, normalizedPeriods[0] || 60);
    const normalizedScopeMap = new Map();
    for (const rawScope of Array.isArray(fallbackScopes) ? fallbackScopes : []) {
      const separator = String(rawScope || '').lastIndexOf('|');
      const asset = separator > 0 ? String(rawScope).slice(0, separator).trim() : '';
      const period = separator > 0
        ? normalizeAnalysisPeriodSeconds(String(rawScope).slice(separator + 1), primary)
        : 0;
      if (asset && normalizedPeriods.includes(period)) {
        normalizedScopeMap.set(marketSnapshotKey(asset, period), { asset, period });
      }
    }
    const legacyFallback = [...new Set((Array.isArray(fallbackAssets) ? fallbackAssets : []).map(String).filter(Boolean))];
    if (!normalizedScopeMap.size && legacyFallback.length) {
      for (const asset of legacyFallback) {
        for (const period of normalizedPeriods) {
          normalizedScopeMap.set(marketSnapshotKey(asset, period), { asset, period });
        }
      }
    }
    const scopedFallback = [...normalizedScopeMap.values()];
    const fallback = [...new Set(scopedFallback.map((item) => item.asset))];
    const assetsByPeriod = Object.fromEntries(normalizedPeriods.map((period) => [
      period,
      [...new Set(scopedFallback.filter((item) => item.period === period).map((item) => item.asset))]
    ]));
    const signature = JSON.stringify([scopedFallback.map((item) => marketSnapshotKey(item.asset, item.period)).sort(), primary]);
    if (!force && signature === cacheBridgeControl.subscriptionSignature && Date.now() - Number(cacheBridgeControl.subscriptionAppliedAt || 0) < 15000) {
      return { ok: true, skipped: true, fallbackAssets: fallback, fallbackScopes: scopedFallback };
    }
    if (cacheBridgeControl.subscriptionInFlight) return cacheBridgeControl.subscriptionInFlight;
    cacheBridgeControl.subscriptionInFlight = (async () => {
      try {
        let result;
        if (!scopedFallback.length) {
          stopGraphSubscriptionManager();
          result = await pageCommand('CACHE_MODE', { assets: all, period: primary, periods: normalizedPeriods, reason }, 15000)
            .catch((error) => ({ ok: false, error: String(error?.message || error) }));
        } else {
          const primaryOffset = Math.max(60, Math.min(5000, Number(historyOffsets?.[primary]) || 180));
          result = await pageCommand('SUBSCRIBE', {
            assets: fallback,
            period: primary,
            periods: normalizedPeriods,
            scopes: scopedFallback,
            historyOffsets,
            historyOffset: primaryOffset,
            cacheBridgeFallback: true,
            recoveryReason: reason,
            autoManagePeriods: true
          }, Math.max(16000, fallback.length * 140));
          startGraphSubscriptionManager({
            assets: fallback,
            assetsByPeriod,
            periods: normalizedPeriods,
            primaryPeriod: primary,
            historyOffsets
          });
        }
        cacheBridgeControl.subscriptionSignature = signature;
        cacheBridgeControl.subscriptionAppliedAt = Date.now();
        cacheBridgeControl.fallbackAssets = fallback;
        cacheBridgeControl.fallbackScopes = new Set(scopedFallback.map((item) => marketSnapshotKey(item.asset, item.period)));
        return {
          ...result,
          fallbackAssets: fallback,
          fallbackScopes: scopedFallback,
          cacheAssets: all.filter((asset) => !fallback.includes(asset))
        };
      } finally {
        cacheBridgeControl.subscriptionInFlight = null;
      }
    })();
    return cacheBridgeControl.subscriptionInFlight;
  }

  function stopGraphSubscriptionManager() {
    graphSubscriptionManager.token += 1;
    graphSubscriptionManager.enabled = false;
    graphSubscriptionManager.bootstrapping = false;
    graphSubscriptionManager.assets = [];
    graphSubscriptionManager.assetsByPeriod = {};
    graphSubscriptionManager.periods = [];
    graphSubscriptionManager.refreshDueAt.clear();
    graphSubscriptionManager.bootstrapPendingPeriods.clear();
    graphSubscriptionManager.inFlightPeriods.clear();
    graphSubscriptionManager.bootstrapAttempts.clear();
    if (graphSubscriptionManager.timer) clearTimeout(graphSubscriptionManager.timer);
    graphSubscriptionManager.timer = null;
  }
  function detectClientPerformanceProfile() {
    const cores = Math.max(1, Number(navigator?.hardwareConcurrency) || 4);
    const memoryGb = Math.max(0, Number(navigator?.deviceMemory) || 0);
    const connection = navigator?.connection || navigator?.mozConnection || navigator?.webkitConnection || null;
    const effectiveType = String(connection?.effectiveType || '').toLowerCase();
    const rtt = Math.max(0, Number(connection?.rtt) || 0);
    const saveData = connection?.saveData === true;
    const verySlowNetwork = saveData || effectiveType === 'slow-2g' || effectiveType === '2g' || rtt >= 650;
    const slowNetwork = verySlowNetwork || effectiveType === '3g' || rtt >= 300;
    const veryLowEnd = cores <= 2 || (memoryGb > 0 && memoryGb <= 2);
    const lowEnd = veryLowEnd || cores <= 4 || (memoryGb > 0 && memoryGb <= 4);
    const snapshotBasePaceMs = verySlowNetwork || veryLowEnd ? 260 : (slowNetwork || lowEnd ? 150 : 80);
    const signalWorkers = veryLowEnd || verySlowNetwork ? 1 : (lowEnd || slowNetwork ? 2 : 4);
    return {
      cores,
      memoryGb,
      effectiveType,
      rtt,
      saveData,
      lowEnd,
      slowNetwork,
      snapshotBasePaceMs,
      signalWorkers
    };
  }

  const CLIENT_PERFORMANCE_PROFILE = detectClientPerformanceProfile();

  const autoRuntime = {
    timer: null,
    running: false,
    lastTradeAtByAsset: new Map(),
    inFlightAssets: new Set(),
    inFlightSignalIds: new Set(),
    inFlightRecoveryScopes: new Set(),
    recoveryBranchClaims: new Map(),
    inFlightBaseSignals: new Set(),
    provisionalClosedDeals: new Map(),
    settlementPendingTrades: new Map(),
    followRecoveryRetryAfterByScope: new Map(),
    statusWriteAt: 0,
    socket: null,
    socketUrl: null,
    reconnectTimer: null,
    pingTimer: null,
    executedSignals: new Set(),
    subscribedKey: '',
    lastSubscriptionAt: 0,
    lastSnapshotCandleByAsset: new Map(),
    lastSnapshotSourceByAsset: new Map(),
    lastSnapshotAtByAsset: new Map(),
    lastSnapshotErrorAtByAsset: new Map(),
    snapshotRetryAfterByAsset: new Map(),
    snapshotRetryTimer: null,
    serverPressureLevel: 0,
    serverBackpressureEvents: 0,
    snapshotWorkersRecommended: 4,
    snapshotWorkersServerMax: 0,
    snapshotSchedulerWorkers: 0,
    snapshotPublishing: false,
    snapshotPublishingStartedAt: 0,
    snapshotPublishingProgressAt: 0,
    snapshotWakeTimer: null,
    lastSnapshotSweepKey: '',
    lastSnapshotSweepAt: 0,
    snapshotQueuedForce: false,
    snapshotBackoffUntil: 0,
    snapshotNextSendAt: 0,
    snapshotBasePaceMs: CLIENT_PERFORMANCE_PROFILE.snapshotBasePaceMs,
    snapshotSendPaceMs: CLIENT_PERFORMANCE_PROFILE.snapshotBasePaceMs,
    snapshotLastAckLatencyMs: 0,
    snapshotConsecutiveSuccesses: 0,
    snapshotConsecutiveTimeouts: 0,
    lastSnapshotSuccessAt: 0,
    heartbeatTimer: null,
    activeTrades: new Map(),
    fallbackSessionStartedAt: Date.now(),
    lastClosedDealCount: 0,
    reconciledClosedDealKeys: new Set(),
    lastCloseRefreshAt: 0,
    queuedSignalIds: new Set(),
    pendingSignals: new Map(),
    latestSignalIdByKey: new Map(),
    signalQueueDepth: 0,
    signalWorkers: 0,
    signalDispatcherScheduled: false,
    signalConfigRevision: 1,
    signalConfigKey: '',
    signalDecisionStats: {
      received: 0,
      opened: 0,
      droppedExpired: 0,
      droppedOldConfig: 0,
      replacedByNewer: 0,
      duplicate: 0
    },
    analysisCycle: 0,
    analysisBucketKey: '',
    analysisTargetTime: 0,
    analysisCompletedAssets: new Set(),
    analysisQueuedAssets: new Set(),
    analysisFailedAssets: new Set(),
    lastAnalysisStatusSignature: '',
    lastEngineStatusAt: 0,
    lastEngineAsset: '',
    lastPublishCompletedAt: 0,
    lastServerSyncAttemptAt: 0,
    lastCustomStrategyRepairAt: 0,
    customStrategyRepairInFlight: false,
    signalSocketStatus: 'unknown',
    signalSocketStatusAt: 0,
    signalAnalyzingSince: 0,
    analysisBootstrapAwaiting: false,
    analysisBootstrapSentAt: 0,
    analysisBootstrapSnapshotId: '',
    analysisBootstrapAsset: '',
    analysisStallRecoveries: 0,
    lastAnalysisStallRecoveryAt: 0,
    lastStatusState: '',
    lastStatusMessage: '',
    signalStatusClearTimer: null,
    lastMarketTickAt: 0,
    lastMarketRecoveryAt: 0,
    lastMarketRecoveryOkAt: 0,
    marketRecoveryAttempts: 0,
    marketRecoveryInFlight: false,
    lastSoftReconnectAt: 0,
    lastAutoReloadAt: 0,
    lastSignalForceRecoverAt: 0,
    lastLocalNoticeAt: 0,
    previousStoredConnectionRequested: false,
    followRecoveryRunning: false,
    followRecoveryRunningScopes: new Set(),
    followRecoveryDrainTimer: null,
    followRecoveryLastAttemptAt: 0,
    followRecoveryLastAnchorKey: ''
  };


  const LONG_SESSION_SOFT_RECONNECT_MS = 50 * 60 * 1000;
  const MARKET_TICK_STALE_MS = 45 * 1000;
  const MARKET_RECOVERY_COOLDOWN_MS = 45 * 1000;
  const MARKET_RELOAD_COOLDOWN_MS = 8 * 60 * 1000;
  const SIGNAL_FORCE_RECOVER_COOLDOWN_MS = 60 * 1000;

  let extensionContextInvalidated = false;
  let extensionContextNoticeShown = false;
  let extensionContextAutoReloadTimer = null;

  function isExtensionContextError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('extension context invalidated')
      || message.includes('context invalidated');
  }

  function showExtensionContextNotice() {
    // Keep old function for compatibility, but do not draw a visible overlay on Pocket Option.
    // After Chrome updates/restarts an MV3 extension, stale content scripts can lose runtime context.
    // The safest UX is a silent one-time tab reload instead of a persistent warning banner.
    try {
      cleanupLegacyExtensionContextBanner();
      const oldNotice = document?.getElementById?.('pt-extension-context-notice');
      if (oldNotice) oldNotice.remove();
    } catch {}
    extensionContextNoticeShown = true;
  }

  function scheduleExtensionContextAutoReload() {
    // Context invalidation alone is not a trading failure. Do not reload the terminal
    // and do not show a Pocket overlay. The real health watchdog handles actual
    // account/WebSocket/server/tick failures.
    return false;
  }


  function invalidateExtensionContext(error) {
    if (extensionContextInvalidated) return;
    extensionContextInvalidated = true;
    // Do not reload and do not show a visible overlay. In MV3 this can happen after
    // an extension update while the real Pocket account/WebSocket/server state is healthy.
    // Stop only this stale content-script loops to avoid noisy repeated runtime calls.
    autoRuntime.running = false;
    autoRuntime.subscribedKey = '';
    autoRuntime.lastSubscriptionAt = 0;
    autoRuntime.inFlightAssets.clear();
    autoRuntime.inFlightSignalIds.clear();
    for (const timer of marketCacheTimers.values()) clearTimeout(timer);
    marketCacheTimers.clear();
    stopGraphSubscriptionManager();
    for (const timer of [autoRuntime.timer, autoRuntime.reconnectTimer, autoRuntime.pingTimer, autoRuntime.heartbeatTimer, autoRuntime.signalStatusClearTimer, saveTimer, renderTimer, statusHostRemountTimer]) {
      if (timer) clearTimeout(timer);
    }
    autoRuntime.timer = null;
    autoRuntime.reconnectTimer = null;
    autoRuntime.pingTimer = null;
    autoRuntime.heartbeatTimer = null;
    autoRuntime.signalStatusClearTimer = null;
    saveTimer = null;
    renderTimer = null;
    statusHostRemountTimer = null;
    try { statusHostObserver?.disconnect(); } catch {}
    statusHostObserver = null;
    try { cleanupLegacyExtensionContextBanner(); } catch {}
    try { console.debug('[Pocket TRADE ROBOT] Extension context invalidated ignored because health watchdog handles real failures.'); } catch {}
  }


  async function safeRuntimeMessage(message, timeoutMs = 10000) {
    if (extensionContextInvalidated) {
      return { ok: false, code: 'EXTENSION_CONTEXT_INVALIDATED', error: 'Extension context invalidated' };
    }
    let timer = null;
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        throw new Error('Extension context invalidated');
      }
      const messageType = String(message?.type || 'unknown');
      const requestedTimeout = Math.max(1000, Number(timeoutMs) || 10000);
      const executionDeadlineMs = Number(message?.payload?.executionDeadlineMs);
      const hasExecutionDeadline = Number.isFinite(executionDeadlineMs) && executionDeadlineMs > 0;
      const executionBudgetMs = hasExecutionDeadline
        ? Math.max(1000, executionDeadlineMs - Date.now())
        : null;
      // Проверка торгового доступа включает защищённый запрос к серверу лицензий.
      // Для автоторговли не используем возраст сигнала как локальный дедлайн: медленный
      // ПК или интернет не должны превращать валидный серверный сигнал в ложный отказ.
      const effectiveTimeout = messageType === 'PO_CHECK_TRADE_ACCESS'
        ? executionBudgetMs == null
          ? Math.max(120000, requestedTimeout)
          : Math.max(1000, Math.min(Math.max(6000, requestedTimeout), executionBudgetMs))
        : requestedTimeout;
      const runtimePromise = chrome.runtime.sendMessage(message);
      const timeoutPromise = new Promise((resolve) => {
        const timeoutError = messageType === 'PO_CHECK_TRADE_ACCESS'
          ? 'Сервер проверки торгового доступа не ответил вовремя. Сделка не открыта.'
          : `Runtime message timeout: ${messageType}`;
        timer = setTimeout(() => resolve({ ok: false, code: 'RUNTIME_MESSAGE_TIMEOUT', error: timeoutError }), effectiveTimeout);
      });
      return await Promise.race([runtimePromise, timeoutPromise]);
    } catch (error) {
      if (isExtensionContextError(error)) invalidateExtensionContext(error);
      return {
        ok: false,
        code: isExtensionContextError(error) ? 'EXTENSION_CONTEXT_INVALIDATED' : 'RUNTIME_MESSAGE_ERROR',
        error: String(error?.message || error)
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function safeStorageGet(keys, fallback = {}) {
    if (extensionContextInvalidated) return fallback;
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('Extension context invalidated');
      return await chrome.storage.local.get(keys);
    } catch (error) {
      if (isExtensionContextError(error)) invalidateExtensionContext(error);
      return fallback;
    }
  }

  async function safeStorageSet(items) {
    if (extensionContextInvalidated) return false;
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('Extension context invalidated');
      await chrome.storage.local.set(items);
      return true;
    } catch (error) {
      if (isExtensionContextError(error)) invalidateExtensionContext(error);
      return false;
    }
  }

  let registrationGateAutoOpenInFlight = false;
  let registrationGateAutoOpened = false;
  function registrationGateRequiredFromAccess(value) {
    const entitlement = value?.entitlement || value || {};
    const accessState = String(value?.accessState || entitlement.accessState || '').toUpperCase();
    const premium = Boolean(value?.premium || entitlement.premium);
    const registered = Boolean(value?.affiliate?.registered || entitlement.affiliate?.registered);
    const registrationRequired = Boolean(value?.registrationRequired === true || entitlement.registrationRequired === true);
    const trialExpired = Boolean(accessState === 'TRIAL_EXPIRED' || entitlement.trial?.expired === true);
    return !premium && !registered && (trialExpired || registrationRequired);
  }

  async function enforceRegistrationGateFromCurrentAccess(source = 'trial_expired_current_state') {
    if (registrationGateAutoOpenInFlight || registrationGateAutoOpened || embeddedDashboardHost?.isConnected) return false;
    registrationGateAutoOpenInFlight = true;
    try {
      const current = await safeRuntimeMessage({ type: 'PO_GET_ACCESS_STATE' }, 20000);
      if (!current?.ok || !registrationGateRequiredFromAccess(current)) return false;
      await safeStorageSet({ ptRequestedDashboardTab: 'premium' });
      const opened = await openEmbeddedDashboard({ source });
      if (opened?.embedded) registrationGateAutoOpened = true;
      return Boolean(opened?.embedded);
    } finally {
      registrationGateAutoOpenInFlight = false;
    }
  }

  async function showAccessNotification(notice) {
    if (!notice?.id || notice.id === lastNoticeId) return;
    const stored = await safeStorageGet('ptContentLastNoticeId', {});
    if (stored.ptContentLastNoticeId === notice.id) { lastNoticeId = notice.id; return; }
    lastNoticeId = notice.id;
    await safeStorageSet({ ptContentLastNoticeId: notice.id });
    noticeHost?.remove();
    noticeHost = document.createElement('div');
    noticeHost.id = 'pt-access-notification-host';
    const isRegistrationRequired = notice.kind === 'registration_required';
    if (isRegistrationRequired) {
      const key = `ptRegistrationGateAuto:${serverState?.pocketUid || latestState?.account?.uid || 'unknown'}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        await safeStorageSet({ ptRequestedDashboardTab: 'premium' });
        const opened = await openEmbeddedDashboard({ source: 'trial_expired_auto' }).catch(() => null);
        if (opened?.embedded) registrationGateAutoOpened = true;
      }
      noticeHost = null;
      return;
    }
    const isFreeLimit = notice.kind === 'free_limit' || notice.reason === 'DAILY_TRADE_LIMIT';
    // Access changes are already shown by the dashboard toast in the lower-right corner.
    // Keep only the critical FREE-limit modal here and suppress the duplicate top-right card.
    if (!isFreeLimit) {
      noticeHost = null;
      return;
    }
    noticeHost.style.cssText = isFreeLimit
      ? 'all:initial;position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;background:rgba(1,6,18,.48);backdrop-filter:blur(5px);font-family:Inter,Segoe UI,Arial,sans-serif;'
      : 'all:initial;position:fixed;z-index:2147483647;right:18px;top:72px;max-width:min(390px,calc(100vw - 36px));font-family:Inter,Segoe UI,Arial,sans-serif;';
    const root = noticeHost.attachShadow({ mode: 'closed' });
    if (isFreeLimit) {
      root.innerHTML = `<style>*{box-sizing:border-box}.m{width:min(460px,calc(100vw - 30px));padding:22px;border:1px solid rgba(255,205,78,.5);border-radius:24px;background:radial-gradient(circle at 20% 0%,rgba(255,193,45,.18),transparent 38%),linear-gradient(145deg,rgba(8,16,40,.98),rgba(3,8,22,.99));color:#eef4ff;box-shadow:0 30px 90px rgba(0,0,0,.62),0 0 45px rgba(255,190,35,.12);animation:in .24s ease}.top{display:flex;align-items:center;justify-content:space-between;gap:14px}.badge{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;background:rgba(255,195,45,.13);border:1px solid rgba(255,195,45,.35);color:#ffd76d;font-size:11px;font-weight:900;letter-spacing:.08em}.x{border:0;background:rgba(255,255,255,.06);color:#8f9bb5;border-radius:10px;width:32px;height:32px;font-size:20px;cursor:pointer}.x:hover{color:#fff;background:rgba(255,255,255,.1)}h2{margin:16px 0 8px;font-size:22px;line-height:1.15;color:#fff}p{margin:0;color:#b8c5dc;font-size:13px;line-height:1.55}.stats{display:flex;align-items:center;justify-content:space-between;margin:16px 0;padding:12px 14px;border-radius:16px;background:rgba(28,43,78,.72);border:1px solid rgba(100,160,255,.16)}.stats span{color:#98a8c4;font-size:12px}.stats b{color:#fff;font-size:19px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.actions button{border:0;border-radius:14px;padding:12px 10px;font-weight:900;cursor:pointer;font-size:12px}.trial{color:#111827;background:linear-gradient(135deg,#ffe17b,#ffb93e)}.premium{color:#eaf3ff;background:rgba(74,126,255,.18);border:1px solid rgba(92,160,255,.3)!important}.hint{display:block;margin-top:12px;color:#7f8fae;font-size:12px;line-height:1.45}@media(max-width:520px){.actions{grid-template-columns:1fr}}@keyframes in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}</style><div class="m"><div class="top"><div class="badge">⚡ FREE LIMIT</div><button class="x" title="Закрыть">×</button></div><h2></h2><p></p><div class="stats"><span>Использовано сегодня</span><b></b></div><div class="actions"><button class="trial" type="button">Проверить регистрацию</button><button class="premium" type="button">Проверить депозит</button></div><small class="hint">Дневной FREE-лимит восстановится на следующие сутки. Депозит от $10 активирует полный Premium без тарифного лимита.</small></div>`;
      root.querySelector('h2').textContent = String(notice.title || 'Дневной лимит FREE исчерпан');
      root.querySelector('p').textContent = String(notice.message || 'Сегодня использовано 50 из 50 сделок на DEMO. Дневной FREE-лимит восстановится на следующие сутки; депозит от $10 активирует полный Premium.');
      root.querySelector('.stats b').textContent = `${notice.usedToday || 50} / ${notice.limitToday || 50}`;
      root.querySelector('.x').addEventListener('click', () => noticeHost?.remove());
      root.querySelector('.trial').addEventListener('click', async () => {
        await safeStorageSet({ ptRequestedDashboardTab: 'premium' });
        await safeRuntimeMessage({ type: 'PO_OPEN_DASHBOARD', screen: { availWidth: screen.availWidth, availHeight: screen.availHeight } }).catch(() => null);
        noticeHost?.remove();
      });
      root.querySelector('.premium').addEventListener('click', async () => {
        await safeStorageSet({ ptRequestedDashboardTab: 'premium' });
        await safeRuntimeMessage({ type: 'PO_OPEN_DASHBOARD', screen: { availWidth: screen.availWidth, availHeight: screen.availHeight } }).catch(() => null);
        noticeHost?.remove();
      });
      (document.documentElement || document.body).appendChild(noticeHost);
      return;
    }
    const premium = notice.kind === 'premium';
    const paused = notice.kind === 'paused' || notice.kind === 'blocked';
    root.innerHTML = `<style>*{box-sizing:border-box}.n{display:flex;align-items:flex-start;gap:12px;padding:14px 15px;border:1px solid ${premium?'rgba(255,204,80,.55)':paused?'rgba(255,125,70,.52)':'rgba(70,172,255,.5)'};border-radius:14px;background:linear-gradient(145deg,rgba(9,15,35,.98),rgba(4,9,24,.98));color:#eef4ff;box-shadow:0 18px 55px rgba(0,0,0,.5),0 0 30px ${premium?'rgba(255,193,45,.14)':paused?'rgba(255,95,50,.12)':'rgba(48,149,255,.12)'};animation:in .24s ease}.i{display:grid;place-items:center;flex:0 0 34px;height:34px;border-radius:11px;background:${premium?'rgba(255,190,45,.14)':paused?'rgba(255,100,45,.13)':'rgba(45,150,255,.13)'};color:${premium?'#ffd565':paused?'#ff9c69':'#79c7ff'};font-weight:900;font-size:18px}.b{min-width:0;flex:1}.b strong{display:block;font-size:13px;line-height:1.3}.b p{margin:5px 0 0;color:#aab7cf;font-size:11px;line-height:1.5}.x{border:0;background:transparent;color:#7f8ba4;font-size:18px;cursor:pointer;padding:0 2px}.x:hover{color:#fff}@keyframes in{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}</style><div class="n"><div class="i"></div><div class="b"><strong></strong><p></p></div><button class="x" title="Закрыть">×</button></div>`;
    root.querySelector('.i').textContent = premium ? '♛' : paused ? '!' : 'i';
    root.querySelector('strong').textContent = String(notice.title || 'Статус доступа');
    root.querySelector('p').textContent = String(notice.message || '');
    root.querySelector('.x').addEventListener('click', () => noticeHost?.remove());
    (document.documentElement || document.body).appendChild(noticeHost);
    setTimeout(() => noticeHost?.remove(), premium ? 14000 : 11000);
  }

  function showLocalStatusNotice(title, message, kind = 'info', timeoutMs = 9000) {
    try {
      const now = Date.now();
      const key = `${title}:${message}`;
      if (autoRuntime.lastLocalNoticeKey === key && now - Number(autoRuntime.lastLocalNoticeAt || 0) < 25000) return;
      autoRuntime.lastLocalNoticeKey = key;
      autoRuntime.lastLocalNoticeAt = now;
      noticeHost?.remove();
      noticeHost = document.createElement('div');
      noticeHost.id = 'pt-local-status-notice-host';
      noticeHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:18px;top:72px;max-width:min(420px,calc(100vw - 36px));font-family:Inter,Segoe UI,Arial,sans-serif;';
      const root = noticeHost.attachShadow({ mode: 'closed' });
      const success = kind === 'success';
      const warning = kind === 'warning';
      root.innerHTML = `<style>*{box-sizing:border-box}.n{display:flex;align-items:flex-start;gap:12px;padding:14px 15px;border:1px solid ${success?'rgba(60,220,150,.5)':warning?'rgba(255,185,70,.55)':'rgba(90,160,255,.5)'};border-radius:15px;background:linear-gradient(145deg,rgba(8,15,35,.98),rgba(4,9,24,.98));color:#eef4ff;box-shadow:0 18px 55px rgba(0,0,0,.5),0 0 30px ${success?'rgba(60,220,150,.14)':warning?'rgba(255,160,45,.14)':'rgba(70,150,255,.13)'};animation:in .22s ease}.i{display:grid;place-items:center;flex:0 0 34px;height:34px;border-radius:12px;background:${success?'rgba(60,220,150,.13)':warning?'rgba(255,170,45,.14)':'rgba(70,150,255,.13)'};color:${success?'#77f3b2':warning?'#ffd06d':'#85c7ff'};font-weight:900}.b{min-width:0;flex:1}.b strong{display:block;font-size:13px;line-height:1.3}.b p{margin:5px 0 0;color:#aab7cf;font-size:11px;line-height:1.5}.x{border:0;background:transparent;color:#7f8ba4;font-size:18px;cursor:pointer;padding:0 2px}.x:hover{color:#fff}@keyframes in{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}</style><div class="n"><div class="i"></div><div class="b"><strong></strong><p></p></div><button class="x" title="Закрыть">×</button></div>`;
      root.querySelector('.i').textContent = success ? '✓' : warning ? '!' : 'i';
      root.querySelector('strong').textContent = String(title || 'Pocket TRADE ROBOT');
      root.querySelector('p').textContent = String(message || '');
      root.querySelector('.x').addEventListener('click', () => noticeHost?.remove());
      (document.documentElement || document.body).appendChild(noticeHost);
      if (timeoutMs > 0) setTimeout(() => noticeHost?.remove(), timeoutMs);
    } catch {}
  }



  let disclosureModalHost = null;
  let disclosureModalPromise = null;
  let disclosureModalResolver = null;
  // One accepted disclosure covers one user-driven open/connect flow only. This
  // prevents the awkward double prompt (open Robot -> immediately Connect) while
  // still asking again on a later manual reconnect/reopen unless opt-out is set.
  let disclosureAcceptedForCurrentFlow = false;

  const PT_LEGAL_MODAL_VERSION = 'v2_0_45_pocket_trade_robot_pc_privacy_2026_09_03';
  const PT_LEGAL_CONSENT_VERSION = '2026-09-03-v8-pocket-trade-robot-pc-privacy';
  const PT_LEGAL_DISCLOSURE_PREFERENCE_KEY = 'ptLegalDisclosurePreference';
  const PT_LEGAL_DISCLOSURE_PREFERENCE_SCHEMA = 1;
  const PT_LEGAL_DISCLOSURE_STORAGE_KEYS = Object.freeze([
    PT_LEGAL_DISCLOSURE_PREFERENCE_KEY,
    'ptLegalDisclosureDontShowAgain',
    'ptLegalDisclosureDontShowAgainVersion',
    'ptLegalConsent'
  ]);
  const PT_LEGAL_STORAGE_RETRY_DELAYS_MS = Object.freeze([0, 60, 180]);
  let lastKnownLegalDisclosureStorage = null;

  function settleRobotDisclosureModal(value) {
    const resolve = disclosureModalResolver;
    if (!resolve) return;
    disclosureModalHost?.remove();
    disclosureModalHost = null;
    disclosureModalPromise = null;
    disclosureModalResolver = null;
    resolve(value);
  }

  function isCurrentLegalConsentRecord(consent) {
    return Boolean(
      consent?.accepted === true
      && consent?.version === PT_LEGAL_CONSENT_VERSION
      && consent?.adultConfirmed === true
      && consent?.riskAccepted === true
      && consent?.pocketOfferAccepted === true
      && consent?.termsAccepted === true
      && consent?.privacyAccepted === true
      && consent?.affiliateDisclosureAccepted === true
    );
  }

  async function readLegalDisclosureStorage() {
    for (let attempt = 0; attempt < PT_LEGAL_STORAGE_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = PT_LEGAL_STORAGE_RETRY_DELAYS_MS[attempt];
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const stored = await safeStorageGet(PT_LEGAL_DISCLOSURE_STORAGE_KEYS, null);
      if (stored && typeof stored === 'object') {
        lastKnownLegalDisclosureStorage = stored;
        return stored;
      }
      // A stale content script cannot persist the answer, so showing a modal in
      // that invalid context only creates an unsaveable phantom prompt.
      if (extensionContextInvalidated) return lastKnownLegalDisclosureStorage;
    }
    return lastKnownLegalDisclosureStorage;
  }

  async function persistLegalConsentLocallyFromContent(payload = {}) {
    const dontShowAgain = payload?.dontShowAgain === true;
    const acceptedAt = new Date().toISOString();
    const consent = {
      accepted: true,
      version: PT_LEGAL_CONSENT_VERSION,
      acceptedAt,
      adultConfirmed: payload?.adultConfirmed === true,
      riskAccepted: payload?.riskAccepted === true,
      pocketOfferAccepted: payload?.pocketOfferAccepted === true,
      termsAccepted: payload?.termsAccepted === true,
      privacyAccepted: payload?.privacyAccepted === true,
      affiliateDisclosureAccepted: payload?.affiliateDisclosureAccepted === true,
      disclosureDontShowAgain: dontShowAgain,
      language: String(payload?.language || 'ru').slice(0, 8)
    };
    if (!isCurrentLegalConsentRecord(consent)) throw new Error('LEGAL_CONSENT_INCOMPLETE');

    const preference = {
      schemaVersion: PT_LEGAL_DISCLOSURE_PREFERENCE_SCHEMA,
      dontShowAgain,
      consentVersion: PT_LEGAL_CONSENT_VERSION,
      savedAt: acceptedAt
    };
    const written = await safeStorageSet({
      ptLegalConsent: consent,
      [PT_LEGAL_DISCLOSURE_PREFERENCE_KEY]: preference,
      ptLegalConsentModalAccepted: true,
      ptLegalConsentModalVersion: PT_LEGAL_MODAL_VERSION,
      ptLegalConsentModalAcceptedAt: acceptedAt,
      ptLegalDisclosureDontShowAgain: dontShowAgain,
      ptLegalDisclosureDontShowAgainVersion: dontShowAgain ? PT_LEGAL_MODAL_VERSION : null,
      ptLegalLanguage: consent.language
    });
    if (!written) {
      throw new Error(extensionContextInvalidated
        ? 'EXTENSION_CONTEXT_INVALIDATED'
        : 'LEGAL_CONSENT_LOCAL_WRITE_FAILED');
    }

    const verified = await safeStorageGet([
      'ptLegalConsent',
      PT_LEGAL_DISCLOSURE_PREFERENCE_KEY
    ], null);
    if (!isCurrentLegalConsentRecord(verified?.ptLegalConsent)
      || verified?.ptLegalConsent?.disclosureDontShowAgain !== dontShowAgain
      || verified?.[PT_LEGAL_DISCLOSURE_PREFERENCE_KEY]?.schemaVersion !== PT_LEGAL_DISCLOSURE_PREFERENCE_SCHEMA
      || verified?.[PT_LEGAL_DISCLOSURE_PREFERENCE_KEY]?.dontShowAgain !== dontShowAgain) {
      throw new Error(extensionContextInvalidated
        ? 'EXTENSION_CONTEXT_INVALIDATED'
        : 'LEGAL_CONSENT_LOCAL_VERIFY_FAILED');
    }

    lastKnownLegalDisclosureStorage = {
      ...(lastKnownLegalDisclosureStorage || {}),
      ...verified,
      ptLegalConsentModalAccepted: true,
      ptLegalConsentModalVersion: PT_LEGAL_MODAL_VERSION,
      ptLegalConsentModalAcceptedAt: acceptedAt,
      ptLegalDisclosureDontShowAgain: dontShowAgain,
      ptLegalDisclosureDontShowAgainVersion: dontShowAgain ? PT_LEGAL_MODAL_VERSION : null,
      ptLegalLanguage: consent.language
    };
    return { consent: verified.ptLegalConsent, preference: verified[PT_LEGAL_DISCLOSURE_PREFERENCE_KEY] };
  }

  function isExplicitRobotOpenSource(source) {
    const value = String(source || '').toLowerCase();
    return value.includes('action_click_open_robot')
      || value.includes('status_bar_docked')
      || value.includes('background_open_dashboard')
      || value.includes('pending_dashboard')
      || value.includes('manual_open_robot')
      || value.includes('open_robot');
  }

  function beginExplicitRobotOpenCycle(options = {}) {
    if (isExplicitRobotOpenSource(options?.source)) {
      // A new user click is a new disclosure cycle. Keep the accepted flag only
      // long enough to avoid the immediate second prompt on PO_CONNECT inside the
      // already-open Robot. The persistent "don't show again" choice is still
      // respected by shouldShowRobotDisclosure().
      disclosureAcceptedForCurrentFlow = false;
    }
  }

  async function shouldShowRobotDisclosure(options = {}) {
    if (options?.skipDisclosure === true) return false;
    try {
      const stored = await readLegalDisclosureStorage();
      if (!stored) return extensionContextInvalidated ? false : disclosureAcceptedForCurrentFlow !== true;
      // A real policy/data-processing revision must be acknowledged once even
      // when the user previously chose not to see the ordinary reconnect notice.
      // Once this exact consent version is saved, the durable preference keeps
      // working as promised on all later manual opens.
      const consent = stored?.ptLegalConsent;
      if (!isCurrentLegalConsentRecord(consent)) return true;
      const durablePreference = stored?.[PT_LEGAL_DISCLOSURE_PREFERENCE_KEY];
      if (durablePreference?.schemaVersion === PT_LEGAL_DISCLOSURE_PREFERENCE_SCHEMA) {
        return durablePreference?.dontShowAgain === true
          ? false
          : disclosureAcceptedForCurrentFlow !== true;
      }

      // Migrate every older checked state, including builds that stored the flag
      // without a version or changed the modal copy version afterwards. The user
      // explicitly chose "do not show again" for this device, so copy revisions
      // must not silently revoke that preference.
      if (consent?.disclosureDontShowAgain === true || stored?.ptLegalDisclosureDontShowAgain === true) {
        const migratedConsent = consent?.disclosureDontShowAgain === true
          ? consent
          : { ...consent, disclosureDontShowAgain: true };
        const preference = {
          schemaVersion: PT_LEGAL_DISCLOSURE_PREFERENCE_SCHEMA,
          dontShowAgain: true,
          consentVersion: PT_LEGAL_CONSENT_VERSION,
          migratedFromVersion: stored?.ptLegalDisclosureDontShowAgainVersion || 'legacy-unversioned',
          savedAt: new Date().toISOString()
        };
        await safeStorageSet({
          [PT_LEGAL_DISCLOSURE_PREFERENCE_KEY]: {
            ...preference
          },
          ptLegalConsent: migratedConsent,
          ptLegalDisclosureDontShowAgainVersion: PT_LEGAL_MODAL_VERSION
        });
        lastKnownLegalDisclosureStorage = {
          ...stored,
          ptLegalConsent: migratedConsent,
          [PT_LEGAL_DISCLOSURE_PREFERENCE_KEY]: preference
        };
        return false;
      }
      return disclosureAcceptedForCurrentFlow !== true;
    } catch {
      return true;
    }
  }

  function showRobotDisclosureModal(options = {}) {
    if (disclosureModalPromise) return disclosureModalPromise;
    disclosureModalPromise = new Promise((resolve) => {
      disclosureModalResolver = resolve;
      try {
        disclosureModalHost?.remove();
        disclosureModalHost = document.createElement('div');
        disclosureModalHost.id = 'pt-robot-disclosure-modal-host';
        disclosureModalHost.style.cssText = 'all:initial;position:fixed!important;z-index:2147483647!important;inset:0!important;display:grid!important;place-items:center!important;background:rgba(2,6,18,.66)!important;backdrop-filter:blur(8px)!important;pointer-events:auto!important;font-family:Inter,Segoe UI,Arial,sans-serif!important;color:#eef4ff!important;';
        disclosureModalHost.innerHTML = `
          <style>
            #pt-robot-disclosure-modal-host *{box-sizing:border-box}
            #pt-robot-disclosure-modal-host .ptLegalCard{width:min(760px,calc(100vw - 34px));max-height:calc(100vh - 34px);overflow:auto;border:1px solid rgba(91,143,255,.42);border-radius:24px;background:radial-gradient(circle at 16% 0%,rgba(41,121,255,.24),transparent 35%),linear-gradient(145deg,rgba(8,15,36,.98),rgba(3,8,24,.99));box-shadow:0 34px 120px rgba(0,0,0,.70),0 0 70px rgba(35,107,255,.18);color:#eef4ff;}
            #pt-robot-disclosure-modal-host .ptLegalTop{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:22px 24px 16px;border-bottom:1px solid rgba(126,154,225,.16)}
            #pt-robot-disclosure-modal-host .ptLegalBrand{display:flex;align-items:center;gap:14px;min-width:0}
            #pt-robot-disclosure-modal-host .ptLanguagePanel{position:relative;z-index:30;flex:0 0 248px;width:248px}
            #pt-robot-disclosure-modal-host .ptLanguageTrigger{display:flex!important;align-items:center!important;gap:9px!important;width:100%!important;height:42px!important;padding:0 8px 0 12px!important;border:1px solid rgba(69,198,255,.44)!important;border-radius:12px!important;background:linear-gradient(135deg,rgba(35,199,255,.14),rgba(126,72,255,.23))!important;color:#edf8ff!important;font:950 11px/1 Inter,Segoe UI,Arial,sans-serif!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 10px 28px rgba(0,0,0,.18)!important;transition:border-color .16s ease,background .16s ease,box-shadow .16s ease,transform .16s ease!important}
            #pt-robot-disclosure-modal-host .ptLanguageTrigger:hover,#pt-robot-disclosure-modal-host .ptLanguageTrigger[aria-expanded="true"]{transform:translateY(-1px);border-color:rgba(78,218,255,.75)!important;background:linear-gradient(135deg,rgba(35,199,255,.23),rgba(126,72,255,.32))!important;box-shadow:0 0 24px rgba(48,190,255,.15),inset 0 1px 0 rgba(255,255,255,.1)!important}
            #pt-robot-disclosure-modal-host .ptLanguageGlobe{font-size:17px;line-height:1}#pt-robot-disclosure-modal-host .ptLanguageLabel{min-width:0;flex:1;text-align:left;white-space:nowrap}#pt-robot-disclosure-modal-host .ptLanguageChevron{display:grid;place-items:center;flex:0 0 24px;width:24px;height:24px;border:1px solid rgba(104,211,255,.24);border-radius:7px;background:rgba(66,178,255,.14);color:#c7f1ff;font-size:10px;transition:transform .16s ease,background .16s ease}#pt-robot-disclosure-modal-host .ptLanguageTrigger[aria-expanded="true"] .ptLanguageChevron{transform:rotate(180deg);background:rgba(66,193,255,.25)}
            #pt-robot-disclosure-modal-host .ptLanguageMenu{position:absolute;z-index:40;top:48px;right:0;display:grid;gap:4px;width:248px;padding:7px;border:1px solid rgba(75,188,255,.48);border-radius:13px;background:linear-gradient(145deg,rgba(8,20,48,.998),rgba(25,13,60,.998));box-shadow:0 22px 56px rgba(0,0,0,.65),0 0 28px rgba(51,190,255,.14)}
            #pt-robot-disclosure-modal-host .ptLanguageMenu[hidden]{display:none!important}
            #pt-robot-disclosure-modal-host .ptLangBtn{display:grid!important;grid-template-columns:25px 1fr 18px!important;align-items:center!important;gap:8px!important;width:100%!important;height:38px!important;padding:0 10px!important;border:1px solid transparent!important;border-radius:9px!important;background:transparent!important;color:#c8d4eb!important;font:850 11px/1 Inter,Segoe UI,Arial,sans-serif!important;text-align:left!important;box-shadow:none!important}
            #pt-robot-disclosure-modal-host .ptLangBtn:hover{color:#fff!important;border-color:rgba(91,202,255,.36)!important;background:rgba(51,154,255,.14)!important}
            #pt-robot-disclosure-modal-host .ptLangBtn.active{color:#fff!important;border-color:rgba(77,215,255,.48)!important;background:linear-gradient(90deg,rgba(41,188,255,.21),rgba(126,72,255,.18))!important}
            #pt-robot-disclosure-modal-host .ptLangBtn .ptFlag{font-size:16px}#pt-robot-disclosure-modal-host .ptLangBtn i{opacity:0;color:#62e8ae;font-style:normal;font-size:12px}#pt-robot-disclosure-modal-host .ptLangBtn.active i{opacity:1}
            #pt-robot-disclosure-modal-host .ptLangBtn .ptFlag{position:relative;display:block;width:20px;height:13px;border:1px solid rgba(255,255,255,.32);border-radius:2px;overflow:hidden;font-size:0;box-shadow:0 1px 4px rgba(0,0,0,.28)}#pt-robot-disclosure-modal-host .ptLangBtn .flagRu{background:linear-gradient(to bottom,#fff 0 33.33%,#2457a7 33.33% 66.66%,#d52b3e 66.66%)}#pt-robot-disclosure-modal-host .ptLangBtn .flagGb{background:linear-gradient(90deg,transparent 42%,#cf142b 42% 58%,transparent 58%),linear-gradient(0deg,transparent 36%,#cf142b 36% 64%,transparent 64%),linear-gradient(33deg,transparent 43%,#fff 43% 57%,transparent 57%),linear-gradient(-33deg,transparent 43%,#fff 43% 57%,transparent 57%),#21468b}#pt-robot-disclosure-modal-host .ptLangBtn .flagEs{background:linear-gradient(to bottom,#aa151b 0 25%,#f1bf00 25% 75%,#aa151b 75%)}#pt-robot-disclosure-modal-host .ptLangBtn .flagIn{background:linear-gradient(to bottom,#ff8f1c 0 33.33%,#fff 33.33% 66.66%,#138808 66.66%)}#pt-robot-disclosure-modal-host .ptLangBtn .flagIn:after{content:"";position:absolute;left:50%;top:50%;width:3px;height:3px;transform:translate(-50%,-50%);border:1px solid #2457a7;border-radius:50%}#pt-robot-disclosure-modal-host .ptLangBtn .flagSa{background:#168a4a}#pt-robot-disclosure-modal-host .ptLangBtn .flagSa:before{content:"";position:absolute;left:4px;right:4px;top:5px;height:2px;border-top:1px solid #fff;border-bottom:1px solid #fff}#pt-robot-disclosure-modal-host .ptLangBtn .flagSa:after{content:"";position:absolute;left:5px;right:3px;bottom:2px;height:1px;background:#fff}
            #pt-robot-disclosure-modal-host .ptLegalIcon{display:grid;place-items:center;flex:0 0 48px;height:48px;border-radius:16px;background:linear-gradient(135deg,#1e6dff,#37a7ff);box-shadow:0 14px 34px rgba(37,128,255,.34);font-size:24px}
            #pt-robot-disclosure-modal-host .eyebrow{color:#74a8ff;font-size:10px;font-weight:950;letter-spacing:.12em;text-transform:uppercase}
            #pt-robot-disclosure-modal-host h2{margin:4px 0 3px;color:#fff;font-size:23px;line-height:1.1;letter-spacing:-.02em}
            #pt-robot-disclosure-modal-host .ptLegalBrand p{margin:0;color:#93a4c2;font-size:12px}
            #pt-robot-disclosure-modal-host .ptLegalBody{padding:18px 24px 10px}
            #pt-robot-disclosure-modal-host .ptWarning{display:flex;gap:10px;margin-bottom:12px;padding:13px 14px;border:1px solid rgba(255,198,82,.24);border-radius:15px;background:rgba(255,186,45,.075);color:#ffd98a;font-size:12px;line-height:1.45}
            #pt-robot-disclosure-modal-host .ptIndependent{margin:0 0 12px;color:#aebbd2;font-size:12px;line-height:1.5}
            #pt-robot-disclosure-modal-host .ptAffiliateNotice{display:grid;gap:7px;margin-bottom:14px;padding:13px 14px;border:1px solid rgba(75,210,145,.22);border-radius:15px;background:rgba(40,210,140,.055);font-size:12px;line-height:1.45;color:#aebbd2}
            #pt-robot-disclosure-modal-host .ptAffiliateNotice b{color:#dfffee;font-size:13px}
            #pt-robot-disclosure-modal-host .ptDataNotice{display:grid;gap:7px;margin-bottom:14px;padding:13px 14px;border:1px solid rgba(76,192,255,.30);border-radius:15px;background:linear-gradient(135deg,rgba(47,159,255,.10),rgba(126,72,255,.08));font-size:12px;line-height:1.48;color:#c7d8ef}#pt-robot-disclosure-modal-host .ptDataNotice b{color:#bdeeff;font-size:13px}#pt-robot-disclosure-modal-host .ptDataNotice span{color:#c7d8ef}
            #pt-robot-disclosure-modal-host a{color:#75baff!important;text-decoration:none!important;font-weight:850!important;cursor:pointer!important}
            #pt-robot-disclosure-modal-host a:hover{text-decoration:underline!important}
            #pt-robot-disclosure-modal-host .ptLegalHeading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0 10px;color:#fff}
            #pt-robot-disclosure-modal-host .ptLegalHeading h3{margin:2px 0 0;font-size:16px;color:#fff}
            #pt-robot-disclosure-modal-host .ptProgress{display:inline-flex;align-items:center;justify-content:center;min-width:52px;height:28px;border:1px solid rgba(110,150,230,.28);border-radius:999px;background:rgba(73,120,255,.10);color:#cfe0ff;font-size:12px;font-weight:950}
            #pt-robot-disclosure-modal-host .ptSelectAll{display:flex;align-items:center;gap:11px;margin:0 0 9px;padding:12px 13px;border:1px solid rgba(54,222,153,.34);border-radius:15px;background:linear-gradient(135deg,rgba(38,210,142,.12),rgba(45,131,255,.08));cursor:pointer;user-select:none;color:#ecfff7;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
            #pt-robot-disclosure-modal-host .ptSelectAll:hover{border-color:rgba(67,238,169,.58);background:linear-gradient(135deg,rgba(38,210,142,.18),rgba(45,131,255,.13))}
            #pt-robot-disclosure-modal-host .ptSelectAll input{appearance:auto!important;-webkit-appearance:checkbox!important;position:static!important;display:inline-block!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important;flex:0 0 auto!important;width:20px!important;height:20px!important;margin:0!important;cursor:pointer!important;accent-color:#35d996!important}
            #pt-robot-disclosure-modal-host .ptSelectAllCopy{display:grid;gap:2px;min-width:0}.ptSelectAllTitle{color:#eafff5;font-size:12px;font-weight:950;line-height:1.25}.ptSelectAllHint{color:#86b7a2;font-size:10px;font-style:normal;line-height:1.3}
            #pt-robot-disclosure-modal-host .ptChecks{display:grid;gap:9px}
            #pt-robot-disclosure-modal-host .ptCheck{display:flex;align-items:flex-start;gap:11px;padding:11px 12px;border:1px solid rgba(126,154,225,.15);border-radius:15px;background:rgba(255,255,255,.035);cursor:pointer;user-select:none;color:#dce7ff}
            #pt-robot-disclosure-modal-host .ptCheck:hover{border-color:rgba(95,165,255,.34);background:rgba(67,120,255,.075)}
            #pt-robot-disclosure-modal-host .ptCheck input{appearance:auto!important;-webkit-appearance:checkbox!important;position:static!important;display:inline-block!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important;flex:0 0 auto!important;width:19px!important;height:19px!important;margin:1px 0 0!important;cursor:pointer!important;accent-color:#35d996!important;}
            #pt-robot-disclosure-modal-host .ptCheck span{display:block;color:#c7d3e9;font-size:12px;line-height:1.45}
            #pt-robot-disclosure-modal-host .ptDontShow{display:flex;align-items:center;gap:9px;margin-top:12px;color:#93a4c2;font-size:11px;cursor:pointer;user-select:none}#pt-robot-disclosure-modal-host .ptDontShow input{appearance:auto!important;-webkit-appearance:checkbox!important;width:17px!important;height:17px!important;accent-color:#35d996!important}#pt-robot-disclosure-modal-host .ptDetails{margin-top:12px;padding:12px 14px;border:1px solid rgba(126,154,225,.14);border-radius:15px;background:rgba(255,255,255,.032);color:#9eafcb;font-size:12px;line-height:1.5}
            #pt-robot-disclosure-modal-host .ptDetails summary{cursor:pointer;color:#dbe8ff;font-weight:850}
            #pt-robot-disclosure-modal-host .ptLegalFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 24px 22px;border-top:1px solid rgba(126,154,225,.13)}
            #pt-robot-disclosure-modal-host .ptStatus{color:#8e9fbb;font-size:12px;font-weight:800;min-height:16px}
            #pt-robot-disclosure-modal-host .ptActions{display:flex;gap:10px}
            #pt-robot-disclosure-modal-host button{height:40px;border-radius:13px;padding:0 16px;font-weight:950;cursor:pointer;font-family:Inter,Segoe UI,Arial,sans-serif}
            #pt-robot-disclosure-modal-host .ptCancel{border:1px solid rgba(140,165,225,.2);background:rgba(255,255,255,.055);color:#b7c5df}
            #pt-robot-disclosure-modal-host .ptCancel:hover{background:rgba(255,255,255,.095);color:#fff}
            #pt-robot-disclosure-modal-host .ptConfirm{min-width:230px;border:1px solid rgba(73,168,255,.42);background:linear-gradient(135deg,#1e6dff,#36a3ff);color:#fff;box-shadow:0 12px 32px rgba(37,128,255,.28)}
            #pt-robot-disclosure-modal-host .ptConfirm:disabled{cursor:not-allowed;opacity:.48;filter:grayscale(.25);box-shadow:none}
            @media(max-width:680px){#pt-robot-disclosure-modal-host .ptLegalTop,#pt-robot-disclosure-modal-host .ptLegalBody,#pt-robot-disclosure-modal-host .ptLegalFooter{padding-left:16px;padding-right:16px}#pt-robot-disclosure-modal-host .ptLegalTop{display:grid}#pt-robot-disclosure-modal-host .ptLanguagePanel,#pt-robot-disclosure-modal-host .ptLanguageMenu{flex-basis:auto;width:100%}#pt-robot-disclosure-modal-host .ptLanguageMenu{left:0;right:auto}#pt-robot-disclosure-modal-host .ptLegalFooter{display:grid}#pt-robot-disclosure-modal-host .ptActions{display:grid;grid-template-columns:1fr}#pt-robot-disclosure-modal-host .ptConfirm{min-width:0}#pt-robot-disclosure-modal-host h2{font-size:20px}}
          </style>
          <section class="ptLegalCard" role="dialog" aria-modal="true" aria-labelledby="ptLegalTitle" aria-describedby="ptLegalDescription">
            <div class="ptLegalTop">
              <div class="ptLegalBrand"><div class="ptLegalIcon">⚡</div><div><div class="eyebrow ptLegalEyebrow">Оповещение расширения / Extension notice</div><h2 id="ptLegalTitle">Подтвердите условия перед запуском</h2><p class="ptLegalSubtitle">Confirm terms to continue</p></div></div>
              <div class="ptLanguagePanel" aria-label="Выбор языка / Language">
                <button class="ptLanguageTrigger" type="button" aria-haspopup="menu" aria-expanded="false"><span class="ptLanguageGlobe" aria-hidden="true">🌍</span><span class="ptLanguageLabel">Выбор Языка / Language</span><span class="ptLanguageChevron" aria-hidden="true">▼</span></button>
                <div class="ptLanguageMenu" role="menu" hidden>
                  <button class="ptLangBtn active" type="button" role="menuitemradio" data-legal-lang="ru"><span class="ptFlag flagRu" aria-hidden="true"></span><span>Русский</span><i>✓</i></button>
                  <button class="ptLangBtn" type="button" role="menuitemradio" data-legal-lang="en"><span class="ptFlag flagGb" aria-hidden="true"></span><span>English</span><i>✓</i></button>
                  <button class="ptLangBtn" type="button" role="menuitemradio" data-legal-lang="es"><span class="ptFlag flagEs" aria-hidden="true"></span><span>Español</span><i>✓</i></button>
                  <button class="ptLangBtn" type="button" role="menuitemradio" data-legal-lang="hi"><span class="ptFlag flagIn" aria-hidden="true"></span><span>हिन्दी</span><i>✓</i></button>
                  <button class="ptLangBtn" type="button" role="menuitemradio" data-legal-lang="ar"><span class="ptFlag flagSa" aria-hidden="true"></span><span dir="rtl">العربية</span><i>✓</i></button>
                </div>
              </div>
            </div>
            <div class="ptLegalBody">
              <div class="ptWarning"><b class="ptWarningTitle">⚠️ Важно</b><span id="ptLegalDescription">Торговля связана с финансовыми рисками. Сигналы и автоматизация не гарантируют прибыль — сначала проверьте настройки на DEMO.</span></div>
              <p class="ptIndependent">Pocket TRADE ROBOT — независимый аналитический инструмент и не является брокером, официальным приложением или представителем Pocket Option.</p>
              <div class="ptAffiliateNotice" role="note" aria-label="Партнёрское раскрытие"><b class="ptAffiliateTitle">🤝 Партнёрская программа</b><span class="ptAffiliateText">Разработчик Pocket TRADE ROBOT может участвовать в партнёрской программе Pocket Option и получить вознаграждение, если пользователь добровольно перейдёт по явно обозначенной партнёрской ссылке и создаст новый аккаунт. Бесплатные функции доступны без партнёрской регистрации.</span><a class="ptAffiliateLink" href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Открыть партнёрское раскрытие</a></div>
              <div class="ptDataNotice" role="note" aria-label="Раскрытие обработки данных"><b>🛡️ Данные / Data use</b><span>Из открытого терминала обрабатываются только UID, DEMO/REAL, баланс/валюта, активы, payout, тики/свечи, параметры и результаты команд. Настройки, статистика и локальные учётные записи хранятся в Chrome; автономная версия не отправляет их на серверы Pocket TRADE ROBOT. Технический токен Pocket Option остаётся локально и направляется только напрямую в сервис Pocket Option. / See the full PC policy for storage, retention and recipients.</span><a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Полная политика / Full PC Privacy Policy</a></div>
              <div class="ptLegalHeading"><div><div class="eyebrow ptRequiredEyebrow">Обязательное подтверждение</div><h3 class="ptRequiredTitle">Перед началом подтвердите условия</h3></div><span class="ptProgress">0/6</span></div>
              <label class="ptSelectAll"><input id="ptLegalSelectAll" type="checkbox"><span class="ptSelectAllCopy"><b class="ptSelectAllTitle">Выбрать все 6 пунктов</b><em class="ptSelectAllHint">Одним нажатием отметить все обязательные условия</em></span></label>
              <div class="ptChecks">
                <label class="ptCheck"><input id="ptLegalAdult" type="checkbox"><span class="ptCheckText" data-legal-check="1">Мне исполнилось 18 лет, и использование сервиса разрешено в моей юрисдикции.</span></label>
                <label class="ptCheck"><input id="ptLegalRisk" type="checkbox"><span class="ptCheckText" data-legal-check="2">Я понимаю финансовые риски и отсутствие гарантии результата.</span></label>
                <label class="ptCheck"><input id="ptLegalPocketOffer" type="checkbox"><span class="ptCheckText" data-legal-check="3">Я прочитал и принимаю <a href="https://pocketoption.com/ru/public-offer" target="_blank" rel="noopener noreferrer">публичную оферту Pocket Option</a>.</span></label>
                <label class="ptCheck"><input id="ptLegalTerms" type="checkbox"><span class="ptCheckText" data-legal-check="4">Я прочитал и принимаю <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">условия использования Pocket TRADE ROBOT</a>.</span></label>
                <label class="ptCheck"><input id="ptLegalPrivacy" type="checkbox"><span class="ptCheckText" data-legal-check="5">Я прочитал <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">политику конфиденциальности Pocket TRADE ROBOT PC</a>, включая сбор, использование, хранение и получателей данных, и согласен с обработкой, необходимой для работы сервиса.</span></label>
                <label class="ptCheck"><input id="ptLegalAffiliate" type="checkbox"><span class="ptCheckText" data-legal-check="6">Я ознакомился с <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">партнёрским раскрытием</a> и понимаю, что партнёрская регистрация нового аккаунта на Pocket Option добровольная, а разработчик может получить вознаграждение.</span></label>
              </div>
              <label class="ptDontShow"><input id="ptLegalDontShowAgain" type="checkbox"><span class="ptDontShowText">Больше не показывать это уведомление на этом устройстве</span></label>
              <details class="ptDetails"><summary class="ptDataSummary">Детали: хранение и передача данных / Details: storage and sharing</summary><p class="ptDataText">В Chrome хранятся настройки, статистика, ID установки, запись согласия, локальная сессия пользователя и настройки расширения. Сервер Pocket TRADE ROBOT не используется; локальные настройки и данные остаются в профиле Chrome. В Pocket Option напрямую передаются технический токен, UID, запросы рынка и подтверждённые команды. Remote и партнёрская проверка работают только по действию пользователя. Пароль, коды подтверждения, платёжные данные и cookies Pocket Option не передаются на серверы Pocket TRADE ROBOT.</p></details>
            </div>
            <div class="ptLegalFooter"><div class="ptStatus">Отметьте все обязательные пункты.</div><div class="ptActions"><button class="ptCancel" type="button">Отмена</button><button class="ptConfirm" type="button" disabled>Согласен и продолжить</button></div></div>
          </section>`;
        const checks = Array.from(disclosureModalHost.querySelectorAll('[data-legal-check]')).map((node) => node.closest('label')?.querySelector('input[type="checkbox"]')).filter(Boolean);
        const confirm = disclosureModalHost.querySelector('.ptConfirm');
        const cancel = disclosureModalHost.querySelector('.ptCancel');
        const progress = disclosureModalHost.querySelector('.ptProgress');
        const status = disclosureModalHost.querySelector('.ptStatus');
        const selectAll = disclosureModalHost.querySelector('#ptLegalSelectAll');
        const langButtons = Array.from(disclosureModalHost.querySelectorAll('[data-legal-lang]'));
        const languagePanel = disclosureModalHost.querySelector('.ptLanguagePanel');
        const languageTrigger = disclosureModalHost.querySelector('.ptLanguageTrigger');
        const languageMenu = disclosureModalHost.querySelector('.ptLanguageMenu');
        const closeLegalLanguageMenu = () => {
          if (languageMenu) languageMenu.hidden = true;
          languageTrigger?.setAttribute('aria-expanded', 'false');
        };
        const legalI18n = {
          ru: {
            eyebrow: 'Оповещение расширения / Extension notice',
            title: 'Подтвердите условия перед запуском',
            subtitle: 'Confirm terms to continue',
            warningTitle: '⚠️ Важно',
            description: 'Торговля связана с финансовыми рисками. Сигналы и автоматизация не гарантируют прибыль — сначала проверьте настройки на DEMO.',
            independent: 'Pocket TRADE ROBOT — независимый аналитический инструмент и не является брокером, официальным приложением или представителем Pocket Option.',
            affiliateTitle: '🤝 Партнёрская программа',
            affiliateText: 'Разработчик Pocket TRADE ROBOT может участвовать в партнёрской программе Pocket Option и получить вознаграждение, если пользователь добровольно перейдёт по явно обозначенной партнёрской ссылке и создаст новый аккаунт. Бесплатные функции доступны без партнёрской регистрации.',
            affiliateLink: 'Открыть партнёрское раскрытие',
            requiredEyebrow: 'Обязательное подтверждение',
            requiredTitle: 'Перед началом подтвердите условия',
            selectAllTitle: 'Выбрать все 6 пунктов',
            selectAllHint: 'Одним нажатием отметить все обязательные условия',
            checks: [
              'Мне исполнилось 18 лет, и использование сервиса разрешено в моей юрисдикции.',
              'Я понимаю финансовые риски и отсутствие гарантии результата.',
              'Я прочитал и принимаю <a href="https://pocketoption.com/ru/public-offer" target="_blank" rel="noopener noreferrer">публичную оферту Pocket Option</a>.',
              'Я прочитал и принимаю <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">условия использования Pocket TRADE ROBOT</a>.',
              'Я прочитал <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">политику конфиденциальности Pocket TRADE ROBOT PC</a>, включая сбор, использование, хранение и получателей данных, и согласен с обработкой, необходимой для работы сервиса.',
              'Я ознакомился с <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">партнёрским раскрытием</a> и понимаю, что партнёрская регистрация нового аккаунта на Pocket Option добровольная, а разработчик может получить вознаграждение.'
            ],
            dataSummary: 'Какие данные нужны для работы и куда они передаются',
            dataText: 'Автономная версия хранит локальные учётные записи, настройки, статистику и пользовательские стратегии в профиле Chrome. Для подключения терминала обрабатываются доступные на странице Pocket Option рыночные данные и состояние счёта. Лицензионные, Premium, партнёрские и удалённые серверы Pocket TRADE ROBOT не используются; локальные данные не отправляются на серверы разработчика. Пароль Pocket Option, коды подтверждения, email-пароли и платёжные карты расширение не запрашивает.',
            statusDefault: 'Отметьте все обязательные пункты.',
            statusReady: 'Все 6 обязательных пунктов отмечены.',
            saving: 'Сохраняем подтверждение…',
            saveError: 'Не удалось сохранить подтверждение. Повторите ещё раз.',
            cancel: 'Отмена',
            confirm: 'Согласен и продолжить',
            dontShow: 'Больше не показывать это уведомление на этом устройстве'
          },
          en: {
            eyebrow: 'Extension notice / Оповещение расширения',
            title: 'Confirm terms before launch',
            subtitle: 'Подтвердите условия для продолжения',
            warningTitle: '⚠️ Important',
            description: 'Trading involves financial risk. Signals and automation do not guarantee profit — test your settings on DEMO first.',
            independent: 'Pocket TRADE ROBOT is an independent analysis tool and is not a broker, official application, or representative of Pocket Option.',
            affiliateTitle: '🤝 Affiliate program',
            affiliateText: 'The developer of Pocket TRADE ROBOT may participate in the Pocket Option affiliate program and may receive compensation if a user voluntarily follows a clearly marked affiliate link and creates a new account. Free features are available without affiliate registration.',
            affiliateLink: 'Open affiliate disclosure',
            requiredEyebrow: 'Required confirmation',
            requiredTitle: 'Confirm the terms before starting',
            selectAllTitle: 'Select all 6 items',
            selectAllHint: 'Check every required condition with one click',
            checks: [
              'I am at least 18 years old and the use of this service is permitted in my jurisdiction.',
              'I understand the financial risks and that results are not guaranteed.',
              'I have read and accept the <a href="https://pocketoption.com/en/public-offer" target="_blank" rel="noopener noreferrer">Pocket Option Public Offer</a>.',
              'I have read and accept the <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Pocket TRADE ROBOT Terms of Use</a>.',
              'I have read the <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Pocket TRADE ROBOT PC Privacy Policy</a>, including data collection, use, storage and recipients, and agree to the processing required for the service to work.',
              'I have reviewed the <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Affiliate Disclosure</a> and understand that affiliate registration of a new Pocket Option account is voluntary and the developer may receive compensation.'
            ],
            dataSummary: 'What data is required and where it is transferred',
            dataText: 'Pocket TRADE ROBOT may process Pocket Option UID, DEMO/REAL account type, balance and currency, selected assets and strategies, trading command parameters, trade statistics, Premium status, affiliate registration, technical diagnostics, and local Chrome settings. Data is used for account connection, trading functions, Premium verification, statistics, security, support, and service improvement. Data may be transferred to Pocket TRADE ROBOT servers and, when necessary, to Pocket Option/affiliate API for registration and deposit verification. The extension does not request your Pocket Option password, confirmation codes, email passwords, or payment card data.',
            statusDefault: 'Check all required items.',
            statusReady: 'All 6 required items are checked.',
            saving: 'Saving confirmation…',
            saveError: 'Could not save confirmation. Please try again.',
            cancel: 'Cancel',
            confirm: 'Agree and continue',
            dontShow: 'Do not show this notice again on this device'
          },
          es: {
            eyebrow: 'Aviso de la extensión / Extension notice',
            title: 'Confirma las condiciones antes de iniciar',
            subtitle: 'Confirma las condiciones para continuar',
            warningTitle: '⚠️ Importante',
            description: 'El trading implica riesgos financieros. Las señales y la automatización no garantizan beneficios: prueba primero la configuración en DEMO.',
            independent: 'Pocket TRADE ROBOT es una herramienta de análisis independiente y no es un bróker, una aplicación oficial ni un representante de Pocket Option.',
            affiliateTitle: '🤝 Programa de afiliados',
            affiliateText: 'El desarrollador de Pocket TRADE ROBOT puede participar en el programa de afiliados de Pocket Option y recibir una remuneración si el usuario sigue voluntariamente un enlace de afiliado claramente identificado y crea una cuenta nueva. Las funciones gratuitas están disponibles sin registro de afiliado.',
            affiliateLink: 'Abrir la divulgación de afiliación',
            requiredEyebrow: 'Confirmación obligatoria',
            requiredTitle: 'Confirma las condiciones antes de empezar',
            selectAllTitle: 'Seleccionar los 6 puntos',
            selectAllHint: 'Marca todas las condiciones obligatorias con un clic',
            checks: [
              'Tengo al menos 18 años y el uso de este servicio está permitido en mi jurisdicción.',
              'Comprendo los riesgos financieros y que no se garantiza ningún resultado.',
              'He leído y acepto la <a href="https://pocketoption.com/en/public-offer" target="_blank" rel="noopener noreferrer">Oferta Pública de Pocket Option</a>.',
              'He leído y acepto los <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Términos de uso de Pocket TRADE ROBOT</a>.',
              'He leído la <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Política de privacidad de Pocket TRADE ROBOT PC</a> y acepto el tratamiento de los datos necesarios para el funcionamiento del servicio.',
              'He revisado la <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Divulgación de afiliación</a> y entiendo que el registro de una cuenta nueva de Pocket Option mediante afiliación es voluntario y que el desarrollador puede recibir una remuneración.'
            ],
            dataSummary: 'Qué datos se necesitan y adónde se transfieren',
            dataText: 'Pocket TRADE ROBOT puede procesar el UID de Pocket Option, el tipo de cuenta DEMO/REAL, el saldo y la moneda, los activos y estrategias seleccionados, los parámetros de las órdenes de trading, las estadísticas de operaciones, el estado Premium, el registro de afiliado, el diagnóstico técnico y la configuración local de Chrome. Los datos se utilizan para conectar la cuenta, ejecutar funciones de trading, comprobar Premium, generar estadísticas, mantener la seguridad, prestar soporte y mejorar el servicio. Cuando sea necesario, pueden transferirse a los servidores de Pocket TRADE ROBOT y a la API de Pocket Option o de su programa de afiliados para verificar el registro y el depósito. La extensión no solicita la contraseña de Pocket Option, códigos de confirmación, contraseñas de correo ni datos de tarjetas de pago.',
            statusDefault: 'Marca todos los puntos obligatorios.',
            statusReady: 'Los 6 puntos obligatorios están marcados.',
            saving: 'Guardando la confirmación…',
            saveError: 'No se pudo guardar la confirmación. Inténtalo de nuevo.',
            cancel: 'Cancelar',
            confirm: 'Aceptar y continuar',
            dontShow: 'No volver a mostrar este aviso en este dispositivo'
          },
          hi: {
            eyebrow: 'एक्सटेंशन सूचना / Extension notice',
            title: 'शुरू करने से पहले शर्तों की पुष्टि करें',
            subtitle: 'जारी रखने के लिए शर्तों की पुष्टि करें',
            warningTitle: '⚠️ महत्वपूर्ण',
            description: 'ट्रेडिंग में वित्तीय जोखिम शामिल है। सिग्नल और ऑटोमेशन लाभ की गारंटी नहीं देते—पहले DEMO पर सेटिंग जाँचें।',
            independent: 'Pocket TRADE ROBOT एक स्वतंत्र विश्लेषण उपकरण है; यह Pocket Option का ब्रोकर, आधिकारिक ऐप या प्रतिनिधि नहीं है।',
            affiliateTitle: '🤝 एफिलिएट प्रोग्राम',
            affiliateText: 'Pocket TRADE ROBOT का डेवलपर Pocket Option के एफिलिएट प्रोग्राम में भाग ले सकता है और उपयोगकर्ता द्वारा स्वेच्छा से स्पष्ट रूप से चिह्नित एफिलिएट लिंक खोलकर नया खाता बनाने पर पारिश्रमिक पा सकता है। मुफ़्त सुविधाएँ एफिलिएट रजिस्ट्रेशन के बिना भी उपलब्ध हैं।',
            affiliateLink: 'एफिलिएट प्रकटीकरण खोलें',
            requiredEyebrow: 'अनिवार्य पुष्टि',
            requiredTitle: 'शुरू करने से पहले शर्तें स्वीकार करें',
            selectAllTitle: 'सभी 6 बिंदु चुनें',
            selectAllHint: 'एक क्लिक में सभी अनिवार्य शर्तों को चिह्नित करें',
            checks: [
              'मेरी आयु कम से कम 18 वर्ष है और मेरे क्षेत्र में इस सेवा का उपयोग अनुमत है।',
              'मैं वित्तीय जोखिम और यह समझता/समझती हूँ कि परिणाम की गारंटी नहीं है।',
              'मैंने <a href="https://pocketoption.com/en/public-offer" target="_blank" rel="noopener noreferrer">Pocket Option का सार्वजनिक प्रस्ताव</a> पढ़ लिया है और उसे स्वीकार करता/करती हूँ।',
              'मैंने <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Pocket TRADE ROBOT की उपयोग की शर्तें</a> पढ़ ली हैं और उन्हें स्वीकार करता/करती हूँ।',
              'मैंने <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">Pocket TRADE ROBOT PC की गोपनीयता नीति</a> पढ़ ली है और सेवा के संचालन के लिए आवश्यक डेटा प्रोसेसिंग से सहमत हूँ।',
              'मैंने <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">एफिलिएट प्रकटीकरण</a> पढ़ लिया है और समझता/समझती हूँ कि Pocket Option पर नए खाते का एफिलिएट रजिस्ट्रेशन स्वैच्छिक है और डेवलपर को पारिश्रमिक मिल सकता है।'
            ],
            dataSummary: 'काम के लिए कौन-सा डेटा चाहिए और वह कहाँ भेजा जाता है',
            dataText: 'Pocket TRADE ROBOT, Pocket Option UID, DEMO/REAL खाता प्रकार, शेष राशि और मुद्रा, चुनी गई आसेट और रणनीतियाँ, ट्रेडिंग कमांड पैरामीटर, ट्रेड आँकड़े, Premium स्थिति, एफिलिएट रजिस्ट्रेशन, तकनीकी डायग्नोस्टिक्स और स्थानीय Chrome सेटिंग को प्रोसेस कर सकता है। डेटा का उपयोग खाता जोड़ने, ट्रेडिंग सुविधाएँ चलाने, Premium जाँच, आँकड़ों, सुरक्षा, सहायता और सेवा सुधार के लिए होता है। जरूरत पड़ने पर डेटा Pocket TRADE ROBOT सर्वर और रजिस्ट्रेशन/डिपॉजिट जाँच के लिए Pocket Option या एफिलिएट API को भेजा जा सकता है। एक्सटेंशन Pocket Option पासवर्ड, पुष्टि कोड, ईमेल पासवर्ड या पेमेंट कार्ड डेटा नहीं माँगता।',
            statusDefault: 'सभी अनिवार्य बिंदुओं को चिह्नित करें।',
            statusReady: 'सभी 6 अनिवार्य बिंदु चिह्नित हैं।',
            saving: 'पुष्टि सहेजी जा रही है…',
            saveError: 'पुष्टि सहेजी नहीं जा सकी। कृपया फिर कोशिश करें।',
            cancel: 'रद्द करें',
            confirm: 'सहमत हैं और जारी रखें',
            dontShow: 'इस उपकरण पर यह सूचना दोबारा न दिखाएँ'
          },
          ar: {
            eyebrow: 'إشعار الإضافة / Extension notice',
            title: 'أكّد الشروط قبل البدء',
            subtitle: 'أكّد الشروط للمتابعة',
            warningTitle: '⚠️ مهم',
            description: 'ينطوي التداول على مخاطر مالية. لا تضمن الإشارات والأتمتة تحقيق أرباح—اختبر الإعدادات على حساب DEMO أولاً.',
            independent: 'Pocket TRADE ROBOT أداة تحليل مستقلة، وليس وسيطاً أو تطبيقاً رسمياً أو ممثلاً لـ Pocket Option.',
            affiliateTitle: '🤝 برنامج الشراكة',
            affiliateText: 'قد يشارك مطوّر Pocket TRADE ROBOT في برنامج الشراكة لـ Pocket Option ويحصل على مكافأة إذا اختار المستخدم طوعاً رابط شراكة واضحاً وأنشأ حساباً جديداً. تبقى الميزات المجانية متاحة دون تسجيل عبر الشراكة.',
            affiliateLink: 'فتح إفصاح الشراكة',
            requiredEyebrow: 'تأكيد إلزامي',
            requiredTitle: 'أكّد الشروط قبل البدء',
            selectAllTitle: 'تحديد البنود الستة كلها',
            selectAllHint: 'حدّد جميع الشروط الإلزامية بنقرة واحدة',
            checks: [
              'أبلغ 18 عاماً على الأقل، ويُسمح باستخدام هذه الخدمة في النطاق القانوني الذي أقيم فيه.',
              'أفهم المخاطر المالية وأن النتائج غير مضمونة.',
              'قرأت ووافقت على <a href="https://pocketoption.com/en/public-offer" target="_blank" rel="noopener noreferrer">العرض العام لـ Pocket Option</a>.',
              'قرأت ووافقت على <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">شروط استخدام Pocket TRADE ROBOT</a>.',
              'قرأت <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">سياسة خصوصية Pocket TRADE ROBOT PC</a> وأوافق على معالجة البيانات الضرورية لعمل الخدمة.',
              'راجعت <a href="https://github.com/Maestro-777/pocket-tracker/blob/main/expansion/README.md" target="_blank" rel="noopener noreferrer">إفصاح الشراكة</a> وأفهم أن تسجيل حساب Pocket Option جديد عبر الشراكة اختياري، وأن المطوّر قد يحصل على مكافأة.'
            ],
            dataSummary: 'ما البيانات المطلوبة وإلى أين تُرسل؟',
            dataText: 'قد يعالج Pocket TRADE ROBOT معرّف UID لـ Pocket Option، ونوع الحساب DEMO/REAL، والرصيد والعملة، والأصول والاستراتيجيات المحددة، ومعلمات أوامر التداول، وإحصاءات الصفقات، وحالة Premium، وتسجيل الشراكة، والتشخيص التقني، وإعدادات Chrome المحلية. تُستخدم البيانات لربط الحساب، ووظائف التداول، والتحقق من Premium، والإحصاءات، والأمان، والدعم، وتحسين الخدمة. عند الضرورة، قد تُنقل إلى خوادم Pocket TRADE ROBOT وإلى API لـ Pocket Option أو برنامج الشراكة للتحقق من التسجيل والإيداع. لا تطلب الإضافة كلمة مرور Pocket Option، أو رموز التأكيد، أو كلمات مرور البريد، أو بيانات بطاقات الدفع.',
            statusDefault: 'حدّد جميع البنود الإلزامية.',
            statusReady: 'تم تحديد جميع البنود الستة الإلزامية.',
            saving: 'جارٍ حفظ التأكيد…',
            saveError: 'تعذّر حفظ التأكيد. حاول مرة أخرى.',
            cancel: 'إلغاء',
            confirm: 'أوافق وأتابع',
            dontShow: 'عدم إظهار هذا الإشعار مرة أخرى على هذا الجهاز'
          }
        };
        let legalLanguage = normalizeUiLanguage(uiLanguage);
        const setNodeText = (selector, value) => { const node = disclosureModalHost.querySelector(selector); if (node) node.textContent = value; };
        const setNodeHtml = (selector, value) => { const node = disclosureModalHost.querySelector(selector); if (node) node.innerHTML = value; };
        const applyLegalLanguage = (lang) => {
          if (!disclosureModalHost) return;
          legalLanguage = normalizeUiLanguage(lang);
          const t = legalI18n[legalLanguage];
          const card = disclosureModalHost.querySelector('.ptLegalCard');
          if (card) card.dir = legalLanguage === 'ar' ? 'rtl' : 'ltr';
          langButtons.forEach((button) => {
            const active = button.dataset.legalLang === legalLanguage;
            button.classList.toggle('active', active);
            button.setAttribute('aria-checked', active ? 'true' : 'false');
          });
          setNodeText('.ptLegalEyebrow', t.eyebrow);
          setNodeText('#ptLegalTitle', t.title);
          setNodeText('.ptLegalSubtitle', t.subtitle);
          setNodeText('.ptWarningTitle', t.warningTitle);
          setNodeText('#ptLegalDescription', t.description);
          setNodeText('.ptIndependent', t.independent);
          setNodeText('.ptAffiliateTitle', t.affiliateTitle);
          setNodeText('.ptAffiliateText', t.affiliateText);
          setNodeText('.ptAffiliateLink', t.affiliateLink);
          setNodeText('.ptRequiredEyebrow', t.requiredEyebrow);
          setNodeText('.ptRequiredTitle', t.requiredTitle);
          setNodeText('.ptSelectAllTitle', t.selectAllTitle);
          setNodeText('.ptSelectAllHint', t.selectAllHint);
          disclosureModalHost.querySelectorAll('[data-legal-check]').forEach((node) => {
            const index = Math.max(0, Number(node.dataset.legalCheck || 1) - 1);
            node.innerHTML = t.checks[index] || node.innerHTML;
          });
          setNodeText('.ptDataSummary', t.dataSummary);
          setNodeText('.ptDataText', t.dataText);
          setNodeText('.ptCancel', t.cancel);
          setNodeText('.ptConfirm', t.confirm);
          setNodeText('.ptDontShowText', t.dontShow);
          if (status && checks.filter((item) => item.checked).length !== checks.length) status.textContent = t.statusDefault;
          update?.();
        };
        languageTrigger?.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const opening = Boolean(languageMenu?.hidden);
          if (languageMenu) languageMenu.hidden = !opening;
          languageTrigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
          if (opening) langButtons.find((button) => button.dataset.legalLang === legalLanguage)?.focus();
        });
        langButtons.forEach((button) => button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          applyLegalLanguage(button.dataset.legalLang);
          closeLegalLanguageMenu();
          safeStorageSet({ ptLegalLanguage: legalLanguage }).catch(() => null);
        }));
        const update = () => {
          const checked = checks.filter((item) => item.checked).length;
          if (progress) progress.textContent = `${checked}/${checks.length}`;
          if (confirm) confirm.disabled = checked !== checks.length;
          if (selectAll) {
            selectAll.checked = checked === checks.length;
            selectAll.indeterminate = checked > 0 && checked < checks.length;
            selectAll.setAttribute('aria-checked', selectAll.indeterminate ? 'mixed' : (selectAll.checked ? 'true' : 'false'));
          }
          if (status) status.textContent = checked === checks.length
            ? legalI18n[legalLanguage].statusReady
            : legalI18n[legalLanguage].statusDefault;
        };
        const cleanup = (value) => settleRobotDisclosureModal(value);
        checks.forEach((item) => {
          item.addEventListener('change', update);
          item.addEventListener('click', (event) => event.stopPropagation());
        });
        selectAll?.addEventListener('change', () => {
          checks.forEach((item) => { item.checked = selectAll.checked; });
          update();
        });
        selectAll?.addEventListener('click', (event) => event.stopPropagation());
        disclosureModalHost.querySelectorAll('a').forEach((link) => link.addEventListener('click', (event) => event.stopPropagation()));
        safeStorageGet('ptLegalLanguage', {}).then((stored) => applyLegalLanguage(normalizeUiLanguage(stored?.ptLegalLanguage || legalLanguage))).catch(() => applyLegalLanguage(legalLanguage));
        cancel?.addEventListener('click', () => cleanup(false));
        confirm?.addEventListener('click', async () => {
          if (confirm.disabled) return;
          confirm.disabled = true;
          if (status) status.textContent = legalI18n[legalLanguage].saving;
          try {
            const dontShowAgain = Boolean(disclosureModalHost.querySelector('#ptLegalDontShowAgain')?.checked);
            const payload = {
              adultConfirmed: Boolean(disclosureModalHost.querySelector('#ptLegalAdult')?.checked),
              riskAccepted: Boolean(disclosureModalHost.querySelector('#ptLegalRisk')?.checked),
              pocketOfferAccepted: Boolean(disclosureModalHost.querySelector('#ptLegalPocketOffer')?.checked),
              termsAccepted: Boolean(disclosureModalHost.querySelector('#ptLegalTerms')?.checked),
              privacyAccepted: Boolean(disclosureModalHost.querySelector('#ptLegalPrivacy')?.checked),
              affiliateDisclosureAccepted: Boolean(disclosureModalHost.querySelector('#ptLegalAffiliate')?.checked),
              dontShowAgain,
              language: legalLanguage
            };
            let savedConsent = null;
            let directSaveError = null;
            try {
              // Legal consent is extension-local state. Save it directly first so
              // the button never depends on MV3 service-worker startup latency.
              const direct = await persistLegalConsentLocallyFromContent(payload);
              savedConsent = direct.consent;
            } catch (error) {
              directSaveError = error;
            }

            if (!isCurrentLegalConsentRecord(savedConsent)
              || savedConsent?.disclosureDontShowAgain !== dontShowAgain) {
              // Keep the background path as a second independent writer for rare
              // transient storage failures. Its response is still verified below.
              const response = await safeRuntimeMessage({
                type: 'PT_ACCEPT_LEGAL_CONSENT',
                payload
              }, 12000);
              savedConsent = response?.consent || null;
              if (!response?.ok
                || !isCurrentLegalConsentRecord(savedConsent)
                || savedConsent?.disclosureDontShowAgain !== dontShowAgain) {
                // A lost reply may follow a successful atomic write. Accept only
                // the fully validated durable record with the exact current choice.
                const recovered = await readLegalDisclosureStorage();
                const recoveredPreference = recovered?.[PT_LEGAL_DISCLOSURE_PREFERENCE_KEY];
                const recoveredDontShowAgain = recoveredPreference?.schemaVersion === PT_LEGAL_DISCLOSURE_PREFERENCE_SCHEMA
                  ? recoveredPreference?.dontShowAgain === true
                  : recovered?.ptLegalConsent?.disclosureDontShowAgain === true;
                if (!isCurrentLegalConsentRecord(recovered?.ptLegalConsent)
                  || recoveredDontShowAgain !== dontShowAgain) {
                  throw directSaveError || new Error(response?.error || 'LEGAL_CONSENT_SAVE_FAILED');
                }
                savedConsent = recovered.ptLegalConsent;
              }
            }
            const preference = {
              schemaVersion: PT_LEGAL_DISCLOSURE_PREFERENCE_SCHEMA,
              dontShowAgain,
              consentVersion: PT_LEGAL_CONSENT_VERSION,
              savedAt: savedConsent.acceptedAt || new Date().toISOString()
            };
            // The background already committed consent + preference atomically
            // and verified both before replying. These legacy/UI metadata keys
            // are best-effort compatibility only and must not turn a successful
            // durable save into a second, unsaveable prompt.
            await safeStorageSet({
              ptLegalConsentModalAccepted: true,
              ptLegalConsentModalVersion: PT_LEGAL_MODAL_VERSION,
              ptLegalConsentModalAcceptedAt: new Date().toISOString(),
              ptLegalDisclosureDontShowAgain: dontShowAgain,
              ptLegalDisclosureDontShowAgainVersion: dontShowAgain ? PT_LEGAL_MODAL_VERSION : null,
              ptLegalLanguage: legalLanguage
            });
            lastKnownLegalDisclosureStorage = {
              ...(lastKnownLegalDisclosureStorage || {}),
              ptLegalConsent: savedConsent,
              [PT_LEGAL_DISCLOSURE_PREFERENCE_KEY]: preference,
              ptLegalDisclosureDontShowAgain: dontShowAgain,
              ptLegalDisclosureDontShowAgainVersion: dontShowAgain ? PT_LEGAL_MODAL_VERSION : null
            };
            disclosureAcceptedForCurrentFlow = true;
            cleanup(true);
            // Wake the worker and bootstrap access after the durable local record
            // already exists. This is deliberately best-effort and cannot undo a
            // successfully saved confirmation.
            void safeRuntimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: true }, 10000).catch(() => null);
          } catch (error) {
            if (extensionContextInvalidated || isExtensionContextError(error)) {
              if (status) status.textContent = legalLanguage === 'ru'
                ? 'Расширение обновилось. Обновляем эту страницу один раз…'
                : 'The extension was updated. Reloading this page once…';
              confirm.disabled = true;
              setTimeout(() => {
                try { window.location.reload(); } catch {}
              }, 350);
              return;
            }
            if (status) status.textContent = legalI18n[legalLanguage].saveError;
            confirm.disabled = false;
          }
        });
        disclosureModalHost.addEventListener('click', (event) => {
          if (!languagePanel?.contains(event.target)) closeLegalLanguageMenu();
          if (event.target === disclosureModalHost) event.preventDefault();
        });
        disclosureModalHost.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape' || languageMenu?.hidden) return;
          event.preventDefault();
          closeLegalLanguageMenu();
          languageTrigger?.focus();
        });
        (document.documentElement || document.body).appendChild(disclosureModalHost);
        selectAll?.focus?.();
        update();
      } catch {
        disclosureModalHost?.remove();
        disclosureModalHost = null;
        disclosureModalPromise = null;
        disclosureModalResolver = null;
        resolve(false);
      }
    });
    return disclosureModalPromise;
  }

  async function openEmbeddedDashboard(options = {}) {
    try {
      // A generic /cabinet/ URL can be a real authenticated terminal. Refresh the
      // passive login evidence before deciding; this does not connect the Robot.
      if (!isGuestTryDemoPage() && !isRobotEligiblePage()) await refreshPocketLoginState();
      if (!isRobotEligiblePage()) {
        guestLaunchWaiting = true;
        ensureStatusBar();
        pulseStatusBar();
        renderStatusBar();
        await safeStorageSet({
          [PENDING_LOGIN_WAIT_STORAGE_KEY]: { at: Date.now(), source: String(options?.source || 'guest_open_robot') }
        }).catch(() => null);
        return { ok: true, embedded: false, statusBarOnly: true, waitingForLogin: true };
      }
      guestLaunchWaiting = false;
      await chrome.storage.local.remove(PENDING_LOGIN_WAIT_STORAGE_KEY).catch(() => null);
      beginExplicitRobotOpenCycle(options);
      if (await shouldShowRobotDisclosure(options)) {
        const accepted = await showRobotDisclosureModal(options);
        if (!accepted) return { ok: false, cancelled: true, disclosureRequired: true };
      }
      if (embeddedDashboardHost?.isConnected) {
        embeddedDashboardHost.style.display = 'block';
        renderEmbeddedDashboardLanguage?.(uiLanguage);
        const frame = embeddedDashboardHost.shadowRoot?.querySelector?.('iframe');
        frame?.focus?.();
        return { ok: true, embedded: true, reused: true };
      }
      const hostNode = document.createElement('div');
      hostNode.id = 'perfect-trade-embedded-dashboard-host';
      hostNode.style.cssText = 'all:initial;position:fixed!important;z-index:2147483646;inset:10px!important;display:block!important;pointer-events:auto!important;';
      const root = hostNode.attachShadow({ mode: 'open' });
      const src = chrome.runtime.getURL('dashboard.html') + '?embedded=1&terminal=1&v=' + encodeURIComponent(VERSION);
      root.innerHTML = `<style>
        *{box-sizing:border-box}:host{all:initial}
        .wrap{position:absolute;inset:0;display:grid;grid-template-rows:42px 1fr;border:1px solid rgba(105,145,255,.35);border-radius:18px;overflow:hidden;background:#050817;box-shadow:0 30px 120px rgba(0,0,0,.68),0 0 45px rgba(59,130,246,.16);font-family:Inter,Segoe UI,Arial,sans-serif;color:#eef4ff}
        .top{position:relative;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 8px 0 14px;background:linear-gradient(90deg,rgba(10,17,43,.99),rgba(8,13,32,.99));border-bottom:1px solid rgba(120,145,220,.18);user-select:none;overflow:visible}
        .title{display:flex;align-items:center;gap:9px;min-width:0;font-size:12px;font-weight:900;letter-spacing:.03em;color:#dce7ff}.dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:#36df91;box-shadow:0 0 10px rgba(54,223,145,.9)}.hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8fa1c4;font-size:11px;font-weight:700}
        .terminalTools{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex:0 0 auto;height:100%}
        .utilityLink,.languageTrigger{position:relative;display:flex;align-items:center;justify-content:center;gap:7px;height:30px;border:1px solid rgba(114,143,220,.25);border-radius:9px;color:#edf4ff;font:900 10px/1 Inter,Segoe UI,Arial,sans-serif;text-decoration:none;cursor:pointer;transition:background .16s ease,border-color .16s ease,box-shadow .16s ease,transform .16s ease}
        .utilityLink{min-width:142px;padding:0 12px;border-color:rgba(255,205,94,.48);background:linear-gradient(135deg,rgba(255,201,94,.18),rgba(39,213,255,.12) 52%,rgba(142,82,255,.22));box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 0 14px rgba(255,201,94,.08)}
        .utilityLink:hover{transform:translateY(-1px);border-color:rgba(255,224,137,.78);background:linear-gradient(135deg,rgba(255,201,94,.27),rgba(39,213,255,.18) 52%,rgba(142,82,255,.31));box-shadow:0 0 22px rgba(255,201,94,.13),inset 0 1px 0 rgba(255,255,255,.13)}
        .utilityIcon{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:rgba(255,255,255,.09);color:#fff0b5;font-size:15px}
        .languagePicker{position:relative}.languageTrigger{min-width:190px;padding:0 7px 0 11px;background:linear-gradient(135deg,rgba(35,199,255,.10),rgba(126,72,255,.16));border-color:rgba(69,198,255,.38)}.languageTrigger:hover,.languageTrigger[aria-expanded="true"]{border-color:rgba(78,218,255,.67);background:linear-gradient(135deg,rgba(35,199,255,.17),rgba(126,72,255,.25));box-shadow:0 0 20px rgba(48,190,255,.12)}.languageGlobe{font-size:16px;line-height:1}.languageLabel{min-width:0;text-align:left}.languageChevron{display:grid;place-items:center;width:21px;height:21px;margin-left:auto;border:1px solid rgba(104,211,255,.20);border-radius:6px;background:rgba(66,178,255,.12);color:#b9ecff;font-size:10px;font-weight:900;line-height:1;transition:transform .16s ease,background .16s ease,color .16s ease}.languageTrigger:hover .languageChevron{background:rgba(66,193,255,.22);color:#fff}.languageTrigger[aria-expanded="true"] .languageChevron{transform:rotate(180deg)}
        .languageMenu{position:absolute;z-index:20;top:35px;right:0;display:grid;gap:4px;width:224px;max-height:min(260px,calc(100vh - 58px));overflow:auto;padding:6px;border:1px solid rgba(75,188,255,.42);border-radius:11px;background:linear-gradient(145deg,rgba(8,20,48,.995),rgba(25,13,60,.995));box-shadow:0 18px 50px rgba(0,0,0,.58),0 0 26px rgba(51,190,255,.12)}.languageMenu[hidden]{display:none}.languageOption{display:grid;grid-template-columns:23px 1fr 18px;align-items:center;gap:7px;width:100%;height:36px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:#c8d4eb;font:800 11px/1 Inter,Segoe UI,Arial,sans-serif;text-align:left;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease}.languageOption:hover{border-color:rgba(91,202,255,.34);background:rgba(51,154,255,.13);color:#fff}.languageOption.active{border-color:rgba(77,215,255,.45);background:linear-gradient(90deg,rgba(41,188,255,.19),rgba(126,72,255,.16));color:#fff}.languageOption .flag{font-size:15px}.languageOption i{opacity:0;color:#62e8ae;font-style:normal;font-size:12px}.languageOption.active i{opacity:1}
        .languageOption .flag{position:relative;display:block;width:20px;height:13px;border:1px solid rgba(255,255,255,.32);border-radius:2px;overflow:hidden;font-size:0;box-shadow:0 1px 4px rgba(0,0,0,.28)}.languageOption .flagRu{background:linear-gradient(to bottom,#fff 0 33.33%,#2457a7 33.33% 66.66%,#d52b3e 66.66%)}.languageOption .flagGb{background:linear-gradient(90deg,transparent 42%,#cf142b 42% 58%,transparent 58%),linear-gradient(0deg,transparent 36%,#cf142b 36% 64%,transparent 64%),linear-gradient(33deg,transparent 43%,#fff 43% 57%,transparent 57%),linear-gradient(-33deg,transparent 43%,#fff 43% 57%,transparent 57%),#21468b}.languageOption .flagEs{background:linear-gradient(to bottom,#aa151b 0 25%,#f1bf00 25% 75%,#aa151b 75%)}.languageOption .flagIn{background:linear-gradient(to bottom,#ff8f1c 0 33.33%,#fff 33.33% 66.66%,#138808 66.66%)}.languageOption .flagIn:after{content:"";position:absolute;left:50%;top:50%;width:3px;height:3px;transform:translate(-50%,-50%);border:1px solid #2457a7;border-radius:50%}.languageOption .flagSa{background:#168a4a}.languageOption .flagSa:before{content:"";position:absolute;left:4px;right:4px;top:5px;height:2px;border-top:1px solid #fff;border-bottom:1px solid #fff}.languageOption .flagSa:after{content:"";position:absolute;left:5px;right:3px;bottom:2px;height:1px;background:#fff}
        .windowControl{display:grid;place-items:center;width:58px;height:30px;padding:0;border:1px solid rgba(134,153,210,.20);border-radius:8px;background:rgba(255,255,255,.035);color:#b9c8e3;font:500 20px/1 "Segoe UI Symbol",Segoe UI,Arial,sans-serif;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease}.windowControl.min{padding-bottom:7px}.windowControl:hover{border-color:rgba(94,173,255,.42);background:rgba(75,139,230,.17);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}.windowControl.close{color:#ff8fa4;font-size:23px}.windowControl.close:hover{border-color:rgba(255,92,119,.78);background:#d93652;color:#fff;box-shadow:0 0 18px rgba(255,55,87,.22)}.windowControl:focus-visible,.utilityLink:focus-visible,.languageTrigger:focus-visible,.languageOption:focus-visible{outline:2px solid rgba(74,211,255,.84);outline-offset:2px}
        iframe{width:100%;height:100%;border:0;background:#050817;display:block}
        @media(max-width:1040px){.hint{display:none}.utilityLink{min-width:38px;padding:0 8px}.utilityCopy{display:none}.languageTrigger{min-width:170px}}
        @media(max-width:760px){:host{inset:4px!important}.wrap{border-radius:12px}.title>span:not(.dot){display:none}.languageTrigger{min-width:42px;padding:0}.languageLabel{display:none}.languageChevron{display:none}}
      </style><div class="wrap"><div class="top"><div class="title"><span class="dot"></span><span>Pocket TRADE ROBOT</span></div><div class="terminalTools"><a class="utilityLink" href="https://github.com/Maestro-777/pocket-tracker/tree/main/expansion" target="_blank" rel="noopener noreferrer" aria-label="База знаний"><span class="utilityIcon" aria-hidden="true">📚</span><span class="utilityCopy">База знаний</span></a><div class="languagePicker"><button class="languageTrigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Выбор Языка / Language"><span class="languageGlobe" aria-hidden="true">🌍</span><span class="languageLabel">Выбор Языка / Language</span><span class="languageChevron" aria-hidden="true">▼</span></button><div class="languageMenu" role="menu" hidden><button class="languageOption" type="button" role="menuitemradio" data-terminal-language="ru"><span class="flag flagRu" aria-hidden="true"></span><span>Русский</span><i>✓</i></button><button class="languageOption" type="button" role="menuitemradio" data-terminal-language="en"><span class="flag flagGb" aria-hidden="true"></span><span>English</span><i>✓</i></button><button class="languageOption" type="button" role="menuitemradio" data-terminal-language="es"><span class="flag flagEs" aria-hidden="true"></span><span>Español</span><i>✓</i></button><button class="languageOption" type="button" role="menuitemradio" data-terminal-language="hi"><span class="flag flagIn" aria-hidden="true"></span><span>हिन्दी</span><i>✓</i></button><button class="languageOption" type="button" role="menuitemradio" data-terminal-language="ar"><span class="flag flagSa" aria-hidden="true"></span><span dir="rtl">العربية</span><i>✓</i></button></div></div><button class="windowControl min" type="button" title="Свернуть" aria-label="Свернуть"><span aria-hidden="true">−</span></button><button class="windowControl close" type="button" title="Закрыть" aria-label="Закрыть"><span aria-hidden="true">×</span></button></div></div><iframe src="${src}" allow="clipboard-read; clipboard-write"></iframe></div>`;
      const languagePicker = root.querySelector('.languagePicker');
      const languageTrigger = root.querySelector('.languageTrigger');
      const languageMenu = root.querySelector('.languageMenu');
      const closeLanguageMenu = () => {
        if (languageMenu) languageMenu.hidden = true;
        languageTrigger?.setAttribute('aria-expanded', 'false');
      };
      renderEmbeddedDashboardLanguage = (locale) => {
        const current = normalizeUiLanguage(locale);
        const copy = PT_EMBEDDED_HEADER_I18N[current];
        root.querySelector('.utilityCopy').textContent = copy.knowledge;
        root.querySelector('.utilityLink').setAttribute('aria-label', copy.knowledge);
        const minButton = root.querySelector('.min');
        const closeButton = root.querySelector('.close');
        minButton?.setAttribute('title', copy.minimize);
        minButton?.setAttribute('aria-label', copy.minimize);
        closeButton?.setAttribute('title', copy.close);
        closeButton?.setAttribute('aria-label', copy.close);
        root.querySelectorAll('[data-terminal-language]').forEach((button) => {
          const active = button.dataset.terminalLanguage === current;
          button.classList.toggle('active', active);
          button.setAttribute('aria-checked', active ? 'true' : 'false');
        });
      };
      renderEmbeddedDashboardLanguage(uiLanguage);
      languageTrigger?.addEventListener('click', () => {
        const opening = Boolean(languageMenu?.hidden);
        if (languageMenu) languageMenu.hidden = !opening;
        languageTrigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
        if (opening) root.querySelector(`[data-terminal-language="${normalizeUiLanguage(uiLanguage)}"]`)?.focus();
      });
      root.querySelectorAll('[data-terminal-language]').forEach((button) => button.addEventListener('click', async () => {
        uiLanguage = normalizeUiLanguage(button.dataset.terminalLanguage);
        renderEmbeddedDashboardLanguage?.(uiLanguage);
        closeLanguageMenu();
        await safeStorageSet({ ptUiLanguage: uiLanguage }).catch(() => null);
      }));
      root.addEventListener('click', (event) => { if (!languagePicker?.contains(event.target)) closeLanguageMenu(); });
      root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeLanguageMenu(); languageTrigger?.focus(); } });
      root.querySelector('iframe')?.addEventListener('load', closeLanguageMenu);
      root.querySelector('.close')?.addEventListener('click', () => { embeddedDashboardHost?.remove(); embeddedDashboardHost = null; renderEmbeddedDashboardLanguage = null; disclosureAcceptedForCurrentFlow = false; });
      root.querySelector('.min')?.addEventListener('click', () => { closeLanguageMenu(); if (embeddedDashboardHost) embeddedDashboardHost.style.display = 'none'; });
      (document.documentElement || document.body).appendChild(hostNode);
      embeddedDashboardHost = hostNode;
      setTimeout(() => root.querySelector('iframe')?.focus?.(), 250);
      return { ok: true, embedded: true, reused: false };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function randomId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const PT_CONTENT_TRANSLATIONS = Object.freeze({
    es: {
      'Убыток': 'Pérdida', 'Прибыль': 'Beneficio', 'Подключено': 'Conectado', 'Ожидаю входа…': 'Esperando inicio de sesión…',
      'Ожидаю подключения…': 'Esperando conexión…', 'Переподключение…': 'Reconectando…', 'Не подключено': 'Desconectado', 'Открыть Pocket TRADE ROBOT': 'Abrir Pocket TRADE ROBOT'
    },
    hi: {
      'Убыток': 'हानि', 'Прибыль': 'लाभ', 'Подключено': 'कनेक्टेड', 'Ожидаю входа…': 'लॉगिन की प्रतीक्षा…',
      'Ожидаю подключения…': 'कनेक्शन की प्रतीक्षा…', 'Переподключение…': 'फिर से कनेक्ट हो रहा है…', 'Не подключено': 'डिस्कनेक्टेड', 'Открыть Pocket TRADE ROBOT': 'Pocket TRADE ROBOT खोलें'
    },
    ar: {
      'Убыток': 'خسارة', 'Прибыль': 'ربح', 'Подключено': 'متصل', 'Ожидаю входа…': 'في انتظار تسجيل الدخول…',
      'Ожидаю подключения…': 'في انتظار الاتصال…', 'Переподключение…': 'جارٍ إعادة الاتصال…', 'Не подключение': 'غير متصل', 'Не подключено': 'غير متصل', 'Открыть Pocket TRADE ROBOT': 'فتح Pocket TRADE ROBOT'
    }
  });

  function tr(ru, en) {
    if (uiLanguage === 'ru') return ru;
    if (uiLanguage === 'en') return en;
    return PT_CONTENT_TRANSLATIONS[uiLanguage]?.[ru] || en;
  }

  function streamSummary(market, selectedCount) {
    const live = Number(market?.liveStreamCount ?? market?.liveStreamsCount ?? 0);
    const subscriptionCount = Number(
      market?.subscriptionCount
      ?? market?.subscriptionsCount
      ?? (Array.isArray(market?.subscriptions) ? market.subscriptions.length : NaN)
      ?? (Array.isArray(market?.selectedAssets) ? market.selectedAssets.length : NaN)
      ?? selectedCount
    );
    const legacyMap = market?.streams && typeof market.streams === 'object' ? market.streams : null;
    const legacyLive = legacyMap
      ? Object.values(legacyMap).filter((item) => item?.connected || item?.streamActive || item?.subscriptionActive).length
      : 0;
    const safeLive = Number.isFinite(live) && live >= 0 ? live : legacyLive;
    const safeSubscriptions = Number.isFinite(subscriptionCount) && subscriptionCount >= 0 ? subscriptionCount : selectedCount;
    return { live: safeLive || legacyLive, subscribed: safeSubscriptions };
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function optionalFiniteNumber(value) {
    if (value == null || value === '') return null;
    return finiteNumber(value);
  }

  function normalizeCandleOffset(value, legacyMode = 'closed') {
    const number = Number(value);
    if ([0, -1, -2].includes(number)) return number;
    return legacyMode === 'current' ? 0 : -1;
  }

  function candleOffsetLabel(value) {
    const offset = normalizeCandleOffset(value);
    return offset === 0 ? 'текущая свеча (0)' : offset === -2 ? 'предыдущая закрытая (−2)' : 'последняя закрытая (−1)';
  }

  function serverStateUsable(value = serverState) {
    const lastSync = Date.parse(value?.lastSyncAt || '');
    return Boolean(
      value?.sessionToken
      && (
        value?.online
        || (Number.isFinite(lastSync) && Date.now() - lastSync <= 15 * 60 * 1000)
      )
    );
  }


  function serverWaitingMessage(value = serverState) {
    const error = String(value?.lastError || '').toLowerCase();
    if (error.includes('rate_limit_exceeded')) {
      return 'Сервер временно ограничил частые запросы · повторное подключение выполнится автоматически';
    }
    return 'Ожидание сервера Pocket TRADE ROBOT';
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
        // Per-step expiration stays neutralized because a recovery trade must use
        // the same expiration that the base/previous losing trade actually used.
        duration: 0,
        // Per-step payout is preserved, but can never fall below 75%.
        minPayout: Math.min(100, Math.max(MIN_TRADE_PAYOUT, Number.isFinite(rawMinPayout) ? rawMinPayout : fallback.minPayout))
      };
    });
  }

  function mergeSettings(value) {
    const incoming = value && typeof value === 'object' ? value : {};
    return {
      ...DEFAULT_SETTINGS,
      ...incoming,
      strategyCatalogVersion: 3,
      statusBarLayoutVersion: 2,
      statusBarVisibilityVersion: 1,
      statusBarVisible: Number(incoming.statusBarVisibilityVersion || 0) < 1
        ? true
        : incoming.statusBarVisible !== false,
      statusBarCompact: Number(incoming.statusBarLayoutVersion || 0) < 2 ? false : incoming.statusBarCompact === true,
      activeStrategyId: Number(incoming.strategyCatalogVersion || 0) < 2 && incoming.activeStrategyId === 'builtin-ai' ? 'builtin-smart' : (incoming.activeStrategyId || ''),
      activeBuiltInStrategy: Number(incoming.strategyCatalogVersion || 0) < 2 && incoming.activeBuiltInStrategy === 'builtin-ai' ? 'builtin-smart' : (incoming.activeBuiltInStrategy || ''),
      period: normalizeAnalysisPeriodSeconds(incoming.period ?? incoming.autoTrade?.period, 60),
      selectedAssets: Array.isArray(incoming.selectedAssets) ? incoming.selectedAssets.filter((asset) => isAllowedProductAsset(asset)) : [...DEFAULT_SETTINGS.selectedAssets],
      autoTrade: (() => {
        const auto = { ...DEFAULT_SETTINGS.autoTrade, ...(incoming.autoTrade || {}) };
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
        if (riskDefaultsVersion < 3 && legacyRecoveryMode === 'fixedStep') auto.recoveryMode = 'off';
        auto.recoveryAfterMax = auto.recoveryAfterMax === 'reset' ? 'reset' : 'stop';
        auto.recoveryFollowSignal = riskDefaultsVersion < 7 ? false : auto.recoveryFollowSignal === true;
        // v1.0.56: fixed expiration is the default and legacy strategy expiration is no longer used for execution.
        auto.expirationMode = auto.expirationMode === 'multiplier' ? 'multiplier' : 'fixed';
        auto.expirationMultiplier = Math.min(10, Math.max(0, Number(auto.expirationMultiplier) || 0));
        auto.duration = normalizeExpirationSeconds(auto.duration, 60);
        auto.period = normalizeAnalysisPeriodSeconds(auto.period, 60);
        auto.maxConcurrent = Math.min(20, Math.max(1, Number(auto.maxConcurrent) || 1));
        auto.strategyProfiles = normalizeStoredStrategyProfiles(auto.strategyProfiles, auto);
        auto.profileSettingsVersion = 1;
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
        if (auto.enabled && !Number.isFinite(Date.parse(auto.sessionStartedAt || ''))) auto.sessionStartedAt = new Date().toISOString();
        if (!auto.enabled) auto.sessionStartedAt = null;
        auto.strategyMode = auto.strategyMode === 'independent' ? 'independent' : 'best';
        let ids = Array.isArray(auto.strategyIds) ? auto.strategyIds.filter(Boolean).map(String) : [];
        if (!ids.length && auto.strategyId) ids.push(String(auto.strategyId));
        if (Number(incoming.strategyCatalogVersion || 0) < 2 && ids.includes('builtin-ai')) {
          ids = ids.map((id) => id === 'builtin-ai' ? 'builtin-smart' : id);
        }
        auto.strategyIds = [...new Set(ids)];
        auto.strategyId = auto.strategyIds[0] || '';
        auto.strategyMode = auto.strategyIds.length > 1 ? 'independent' : (['best', 'independent'].includes(auto.strategyMode) ? auto.strategyMode : 'best');
        auto.candleOffset = normalizeCandleOffset(auto.candleOffset, auto.candleMode);
        auto.candleMode = auto.candleOffset === 0 ? 'current' : 'closed';
        return auto;
      })(),
      builderStrategies: (Array.isArray(incoming.builderStrategies) ? incoming.builderStrategies : []).map(migrateCustomStrategyExpirationItem)
    };
  }

  function currencySuffix(currency) {
    const code = String(currency || '').toUpperCase();
    const symbol = ({
      USD: '$', EUR: '€', GBP: '£', RUB: '₽', JPY: '¥', BRL: 'R$',
      INR: '₹', KZT: '₸', UAH: '₴', CNY: '¥', KRW: '₩', TRY: '₺',
      PLN: 'zł', CHF: 'CHF', AED: 'د.إ', SAR: 'ر.س'
    })[code];
    return symbol || (code ? ` ${code}` : '');
  }

  function money(value, currency, sign = false) {
    const number = finiteNumber(value);
    if (number == null) return '—';
    const prefix = sign && number > 0 ? '+' : '';
    return `${prefix}${number.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}${currencySuffix(currency)}`;
  }

  function currentAccountScopeKey() {
    const uid = latestState?.account?.uid;
    if (uid == null) return null;
    const mode = String(latestState?.account?.mode || (latestState?.account?.isDemo === false ? 'REAL' : latestState?.account?.isDemo === true ? 'DEMO' : '')).trim().toUpperCase();
    return `${uid}:${mode}`;
  }

  function ledgerMatchesCurrentAccount() {
    const key = currentAccountScopeKey();
    return Boolean(key && String(robotLedger?.accountKey || '').trim() === key);
  }

  function profitStatsMatchesCurrentAccount() {
    const key = currentAccountScopeKey();
    return Boolean(key && String(profitStats?.accountKey || '').trim() === key);
  }

  function ledgerCurrency() {
    const accountUid = latestState?.account?.uid != null ? String(latestState.account.uid) : '';
    const accountDemo = latestState?.account?.isDemo;
    const pools = [
      ...(Array.isArray(latestState?.trades?.closedDeals) ? latestState.trades.closedDeals.slice().reverse() : []),
      ...(Array.isArray(latestState?.trades?.openedDeals) ? latestState.trades.openedDeals.slice().reverse() : [])
    ];
    if (ledgerMatchesCurrentAccount()) {
      pools.push(
        ...(Array.isArray(robotLedger?.closedDeals) ? robotLedger.closedDeals.slice().reverse() : []),
        ...(Array.isArray(robotLedger?.openDeals) ? robotLedger.openDeals.slice().reverse() : [])
      );
    }
    for (const deal of pools) {
      if (accountUid && deal?.uid != null && String(deal.uid) !== accountUid) continue;
      if (accountDemo != null && deal?.isDemo != null && Boolean(Number(deal.isDemo) || deal.isDemo === true) !== Boolean(accountDemo)) continue;
      const code = String(deal?.currency || '').trim().toUpperCase();
      if (code) return code;
    }
    return null;
  }

  function displayCurrency(accountCurrency) {
    if (settings.currencyOverride && settings.currencyOverride !== 'AUTO') return settings.currencyOverride;
    const trustedProfitCurrency = profitStatsMatchesCurrentAccount() ? profitStats?.currency : null;
    return accountCurrency || trustedProfitCurrency || ledgerCurrency() || 'USD';
  }

  function formatBalance(account) {
    return account?.balance == null ? '—' : money(account.balance, displayCurrency(account.currency));
  }

  function safeProfitDelta() {
    // Status-bar P/L and automatic TP/SL are robot-only. Whole-account balance
    // delta also contains manual Pocket Option trades, deposits and withdrawals,
    // so it must never be used as the robot result.
    if (!ledgerMatchesCurrentAccount()) return 0;
    const net = finiteNumber(robotLedger?.today?.netProfit ?? robotLedger?.summary?.netProfit);
    return net ?? 0;
  }

  function profitLabel() {
    const delta = safeProfitDelta();
    return {
      delta,
      title: delta < 0 ? tr('Убыток робота', 'Robot loss') : tr('Прибыль робота', 'Robot P&L'),
      value: `(${money(delta, displayCurrency(latestState?.account?.currency || profitStats?.currency), true)})`,
      className: delta < 0 ? 'loss' : delta > 0 ? 'profit' : 'neutral'
    };
  }

  function isConnected(state = latestState) {
    const accountIdentity = Boolean(state?.account?.uid != null && state?.account?.sessionCaptured === true);
    const hardConnected = Boolean(accountIdentity && state?.connection?.connected && state?.socket?.authenticated && state?.socket?.readyState === 1);
    const backgroundHold = Boolean(accountIdentity && state?.connection?.requested
      && (state?.connection?.backgroundPaused || state?.page?.visibility === 'hidden' || state?.environment?.visibility === 'hidden'));
    return hardConnected || backgroundHold;
  }

  async function writeAutoStatus(patch) {
    const now = Date.now();
    const nextState = patch?.state != null ? String(patch.state) : autoRuntime.lastStatusState;
    const nextMessage = patch?.message != null ? String(patch.message) : autoRuntime.lastStatusMessage;
    autoRuntime.lastStatusState = nextState;
    autoRuntime.lastStatusMessage = nextMessage;
    if (nextState !== 'signal' && autoRuntime.signalStatusClearTimer) {
      clearTimeout(autoRuntime.signalStatusClearTimer);
      autoRuntime.signalStatusClearTimer = null;
    }
    if (now - autoRuntime.statusWriteAt < 350 && !patch?.force) return;
    autoRuntime.statusWriteAt = now;
    try {
      const { force, ...safePatch } = patch || {};
      await safeStorageSet({ poAutoTradeStatus: { version: 1, updatedAt: new Date().toISOString(), ...safePatch } });
    } catch {}
  }

  function timestampMs(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value > 1_000_000_000_000 ? value : value * 1000;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function latestMarketActivityMs(state = latestState) {
    const values = [timestampMs(state?.market?.streamUpdatedAt), timestampMs(state?.socket?.lastIncomingAt), Number(cacheBridgeControl.lastSuccessAt || 0)];
    const subscriptions = state?.market?.subscriptions || {};
    for (const item of Object.values(subscriptions)) {
      values.push(timestampMs(item?.streamUpdatedAt));
      const tickMs = timestampMs(item?.lastTickTime);
      if (tickMs) values.push(tickMs);
    }
    return Math.max(0, ...values.filter(Number.isFinite));
  }

  function selectedAutotradeAssets() {
    const unavailable = new Set(
      (Array.isArray(latestState?.market?.assetList) ? latestState.market.assetList : [])
        .filter((item) => item?.active === false)
        .map((item) => String(item?.symbol || ''))
        .filter(Boolean)
    );
    // Preserve the user's saved selection, but never subscribe/analyse an asset
    // the current Pocket catalogue explicitly marks unavailable. Unknown assets
    // remain eligible until the broker provides authoritative availability.
    return [...new Set(
      (Array.isArray(settings.selectedAssets) ? settings.selectedAssets : [])
        .filter(Boolean)
        .map(String)
        .filter(isAllowedProductAsset)
        .filter((asset) => !unavailable.has(asset))
    )];
  }

  function selectedAutotradeStrategies(auto = settings.autoTrade || {}) {
    const ids = Array.isArray(auto.strategyIds) && auto.strategyIds.length ? auto.strategyIds : (auto.strategyId ? [auto.strategyId] : []);
    return [...new Set(ids.filter(Boolean).map(String))];
  }

  function hasOpenBrokerDeals() {
    return Array.isArray(latestState?.trades?.openedDeals) && latestState.trades.openedDeals.length > 0;
  }

  async function restoreMarketStream(reason = 'watchdog', options = {}) {
    const now = Date.now();
    const force = options.force === true;
    if (autoRuntime.marketRecoveryInFlight) return { ok: false, skipped: true, error: 'recovery_in_flight' };
    if (!force && now - Number(autoRuntime.lastMarketRecoveryAt || 0) < MARKET_RECOVERY_COOLDOWN_MS) return { ok: false, skipped: true, error: 'recovery_cooldown' };
    const assets = selectedAutotradeAssets();
    if (!assets.length) return { ok: false, error: 'no_assets' };
    const auto = { ...DEFAULT_SETTINGS.autoTrade, ...(settings.autoTrade || {}) };
    const strategyIds = selectedAutotradeStrategies(auto);
    const plan = marketSubscriptionPlanForAuto(auto, strategyIds);
    autoRuntime.marketRecoveryInFlight = true;
    autoRuntime.lastMarketRecoveryAt = now;
    try {
      if (!isConnected()) {
        await pageCommand('CONNECT', null, 8000).catch((error) => ({ ok: false, error: String(error?.message || error) }));
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      const coverage = await cacheBridgeCoverageForPlan(assets, plan.periods, plan.historyOffsets, {
        forceFull: force,
        defaultLimit: plan.historyOffset,
        minimumCandles: 40,
        timeoutMs: 15000
      });
      const result = await applyPocketFallbackSubscriptions({
        allAssets: assets,
        fallbackAssets: coverage.fallbackAssets,
        fallbackScopes: coverage.fallbackScopes,
        periods: plan.periods,
        primaryPeriod: plan.primaryPeriod,
        historyOffsets: plan.historyOffsets,
        reason,
        force
      });
      autoRuntime.subscribedKey = '';
      autoRuntime.lastSubscriptionAt = 0;
      autoRuntime.marketRecoveryAttempts = 0;
      autoRuntime.lastMarketRecoveryOkAt = Date.now();
      if (!options.quiet) showLocalStatusNotice('Источник рынка восстановлен', coverage.fallbackAssets.length ? `Локальный кэш активен; ${coverage.fallbackAssets.length} активов временно используют резерв Pocket Option.` : 'Локальный кэш активен для всех выбранных активов.', 'success', 9000);
      scheduleAutoEngine();
      setTimeout(() => void publishCandleSnapshots(true), 700);
      return { ok: true, result };
    } catch (error) {
      autoRuntime.marketRecoveryAttempts = Math.min(10, Number(autoRuntime.marketRecoveryAttempts || 0) + 1);
      const message = String(error?.message || error || 'market_recovery_failed');
      const inactiveLong = Date.now() - latestMarketActivityMs() > 90 * 1000;
      const canReload = settings.autoTrade?.enabled === true
        && !hasOpenBrokerDeals()
        && inactiveLong
        && autoRuntime.marketRecoveryAttempts >= 2
        && Date.now() - Number(autoRuntime.lastAutoReloadAt || 0) > MARKET_RELOAD_COOLDOWN_MS;
      if (canReload) {
        autoRuntime.lastAutoReloadAt = Date.now();
        await safeRuntimeMessage({ type: 'PO_RELOAD_TAB', reason: 'market_health_watchdog' }, 8000).catch(() => null);
      }
      return { ok: false, error: message, attempts: autoRuntime.marketRecoveryAttempts };
    } finally {
      autoRuntime.marketRecoveryInFlight = false;
    }
  }

  async function longSessionWatchdog() {
    if (!settings.autoTrade?.enabled || extensionContextInvalidated) return;
    const now = Date.now();
    const assets = selectedAutotradeAssets();
    if (!assets.length) return;
    const marketAt = latestMarketActivityMs();
    if (marketAt) autoRuntime.lastMarketTickAt = marketAt;
    const marketAge = marketAt ? now - marketAt : Infinity;
    const connected = isConnected();

    if (!autoRuntime.lastSoftReconnectAt) autoRuntime.lastSoftReconnectAt = now;
    if (connected && now - Number(autoRuntime.lastSoftReconnectAt || 0) >= LONG_SESSION_SOFT_RECONNECT_MS) {
      // A healthy 24/7 session must not be destroyed on a timer. Real recovery is
      // triggered below only when the live market heartbeat is actually stale.
      autoRuntime.lastSoftReconnectAt = now;
    }

    if (!connected && latestState?.connection?.requested) {
      await restoreMarketStream('account_connection_watchdog', { force: true, quiet: true });
      return;
    }

    const cacheBridgeHealthy = cacheBridgeControl.online === true
      && now - Number(cacheBridgeControl.lastSuccessAt || 0) <= Math.max(15000, normalizeAnalysisPeriodSeconds(settings.autoTrade?.period || 60, 60) * 4000);
    if (connected && marketAge > MARKET_TICK_STALE_MS && !cacheBridgeHealthy) {
      await restoreMarketStream('market_tick_heartbeat', { force: marketAge > 75 * 1000, quiet: marketAge < 75 * 1000 });
    }

    if (String(autoRuntime.signalSocketStatus || '') === 'analyzing' && autoRuntime.signalAnalyzingSince) {
      const auto = { ...DEFAULT_SETTINGS.autoTrade, ...(settings.autoTrade || {}) };
      const periodMs = normalizeAnalysisPeriodSeconds(auto.period, 60) * 1000;
      const selectedCount = Math.max(1, selectedAutotradeAssets().length);
      const strategyPeriodCount = Math.max(1, new Set(selectedStrategyIds(auto).map((id) => strategyAnalysisPeriod(id, auto))).size);
      const perSnapshotBudgetMs = Math.max(
        200,
        Number(autoRuntime.snapshotSendPaceMs || autoRuntime.snapshotBasePaceMs || 100)
          + Number(autoRuntime.snapshotLastAckLatencyMs || 0)
      );
      const expectedSweepMs = selectedCount * strategyPeriodCount * perSnapshotBudgetMs;
      const environmentFloorMs = CLIENT_PERFORMANCE_PROFILE.slowNetwork || CLIENT_PERFORMANCE_PROFILE.lowEnd ? 90000 : 45000;
      const stallThresholdMs = Math.max(environmentFloorMs, Math.min(300000, Math.max(periodMs * 2, expectedSweepMs * 2 + 15000)));
      const analyzingAge = now - Number(autoRuntime.signalAnalyzingSince || 0);
      const engineAge = autoRuntime.lastEngineStatusAt ? now - Number(autoRuntime.lastEngineStatusAt) : Infinity;
      if (analyzingAge > stallThresholdMs
        && engineAge > stallThresholdMs
        && now - Number(autoRuntime.lastAnalysisStallRecoveryAt || 0) > Math.max(20000, Math.min(60000, stallThresholdMs))) {
        autoRuntime.lastAnalysisStallRecoveryAt = now;
        autoRuntime.analysisStallRecoveries = Math.min(10, Number(autoRuntime.analysisStallRecoveries || 0) + 1);
        // First recoveries are data-plane probes, not transport destruction. A live
        // WebSocket with a subscription ACK must not be torn down just because one
        // engine_status was delayed.
        autoRuntime.analysisBootstrapAwaiting = false;
        autoRuntime.analysisBootstrapSentAt = 0;
        await publishCandleSnapshots(true).catch(() => null);
        if (autoRuntime.analysisStallRecoveries >= 3) {
          autoRuntime.subscribedKey = '';
          autoRuntime.lastSubscriptionAt = 0;
          await safeRuntimeMessage({
            type: 'PT_SIGNAL_FORCE_RECOVER',
            reason: 'analysis_stall_transport_recover',
            hard: false
          }, 12000).catch(() => null);
        }
        return;
      }
    }

    if (['offline', 'error', 'reconnecting'].includes(String(autoRuntime.signalSocketStatus || ''))
      && now - Number(autoRuntime.signalSocketStatusAt || 0) > 45 * 1000
      && now - Number(autoRuntime.lastSignalForceRecoverAt || 0) > SIGNAL_FORCE_RECOVER_COOLDOWN_MS) {
      autoRuntime.lastSignalForceRecoverAt = now;
      const result = await safeRuntimeMessage({ type: 'PT_SIGNAL_FORCE_RECOVER', reason: 'autotrade_watchdog' }, 10000).catch(() => null);
      if (result?.ok && result.status === 'online') {
        showLocalStatusNotice('Канал сигналов восстановлен', 'Канал сигналов был восстановлен автоматически.', 'success', 7000);
      }
    }
  }

  async function autoRestoreAfterPageLoad() {
    try {
      const shouldRestore = autoRuntime.previousStoredConnectionRequested || settings.autoTrade?.enabled === true;
      if (!shouldRestore || isConnected()) return;
      await new Promise((resolve) => setTimeout(resolve, 1400));
      await pageCommand('CONNECT', null, 15000).catch(() => null);
      if (settings.autoTrade?.enabled || selectedAutotradeAssets().length) {
        await restoreMarketStream('page_reload_auto_restore', { force: true, quiet: true }).catch(() => null);
      }
      await safeRuntimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: true }).catch(() => null);
    } catch {}
  }

  function scheduleSignalStatusClear(delayMs = 10000) {
    if (autoRuntime.signalStatusClearTimer) clearTimeout(autoRuntime.signalStatusClearTimer);
    autoRuntime.signalStatusClearTimer = setTimeout(() => {
      autoRuntime.signalStatusClearTimer = null;
      if (!settings.autoTrade?.enabled || autoRuntime.lastStatusState !== 'signal') return;
      void writeAutoStatus({
        force: true,
        enabled: true,
        state: 'scanning',
        message: 'Сигнал обработан · продолжаем поиск следующего входа'
      });
    }, Math.max(3000, Number(delayMs) || 10000));
  }

  async function settleSignalStatusAfterProcessing() {
    if (!settings.autoTrade?.enabled || autoRuntime.lastStatusState !== 'signal') return;
    await writeAutoStatus({
      force: true,
      enabled: true,
      state: 'scanning',
      message: 'Сигнал обработан · продолжаем поиск следующего входа'
    });
  }

  function scheduleAutoEngine() {
    if (extensionContextInvalidated || autoRuntime.timer) return;
    autoRuntime.timer = setTimeout(() => {
      autoRuntime.timer = null;
      void runAutoEngine();
    }, 160);
  }

  function closeSignalSocket(reason = 'closed') {
    const hadSubscription = Boolean(autoRuntime.subscribedKey);
    autoRuntime.subscribedKey = '';
    autoRuntime.lastSubscriptionAt = 0;
    autoRuntime.signalSocketStatus = 'offline';
    autoRuntime.signalSocketStatusAt = Date.now();
    if (hadSubscription) {
      void safeRuntimeMessage({ type: 'PT_SIGNAL_UNSUBSCRIBE', reason }).catch(() => null);
    }
  }

  async function rememberExecutedSignal(signalId) {
    if (!signalId) return;
    autoRuntime.executedSignals.add(String(signalId));
    while (autoRuntime.executedSignals.size > 600) {
      autoRuntime.executedSignals.delete(autoRuntime.executedSignals.values().next().value);
    }
    await safeStorageSet({ ptExecutedSignals: [...autoRuntime.executedSignals] });
  }

  function signalDeadlineMs(signal) {
    const expires = Date.parse(signal?.expiresAt || '');
    if (Number.isFinite(expires)) return expires;
    const created = Date.parse(signal?.createdAt || '');
    if (Number.isFinite(created)) return created + 20000;
    const received = Number(signal?._receivedAt);
    return Number.isFinite(received) && received > 0 ? received + 20000 : Date.now() + 20000;
  }

  function signalRemainingMs(signal) {
    return signalDeadlineMs(signal) - Date.now();
  }

  function signalExpired(signal, marginMs = 0) {
    return signalRemainingMs(signal) <= Math.max(0, Number(marginMs) || 0);
  }

  function signalQueueKey(signal) {
    return `${String(signal?.strategyId || 'unknown').trim()}|${String(signal?.asset || 'unknown').trim()}`;
  }

  function currentSignalConfigurationKey(auto = settings.autoTrade || {}) {
    const period = normalizeAnalysisPeriodSeconds(auto?.period ?? settings.period ?? 60, 60);
    const duration = normalizeExpirationSeconds(auto?.duration ?? settings.duration ?? 60, 60);
    const candleOffset = normalizeCandleOffset(auto?.candleOffset, auto?.candleMode);
    const strategies = selectedStrategyIds(auto).slice().sort();
    const assets = selectedAutotradeAssets().slice().sort();
    const strategyProfiles = Object.fromEntries(strategies.map((strategyId) => {
      const strategyPeriod = strategyAnalysisPeriod(strategyId, auto);
      return [strategyId, {
        period: strategyPeriod,
        duration: effectiveProfileExpirationForAuto(auto, { strategyId, period: strategyPeriod }),
        candleOffset: strategyCandleOffsetForAuto(strategyId, auto),
        cooldown: strategyCooldownForAuto(strategyId, auto)
      }];
    }));
    return JSON.stringify([
      auto?.enabled === true,
      auto?.sessionStartedAt || null,
      period,
      duration,
      candleOffset,
      effectiveAutoStrategyMode(auto, strategies),
      strategies,
      strategyProfiles,
      assets
    ]);
  }

  function refreshSignalQueueDepth() {
    autoRuntime.signalQueueDepth = autoRuntime.pendingSignals.size + autoRuntime.signalWorkers;
    return autoRuntime.signalQueueDepth;
  }

  function resetSignalExecutionPipeline(reason = 'configuration_changed') {
    autoRuntime.signalConfigRevision += 1;
    autoRuntime.signalConfigKey = currentSignalConfigurationKey(settings.autoTrade || {});
    autoRuntime.pendingSignals.clear();
    autoRuntime.latestSignalIdByKey.clear();
    autoRuntime.queuedSignalIds.clear();
    autoRuntime.signalDispatcherScheduled = false;
    autoRuntime.lastSignalPipelineResetReason = reason;
    refreshSignalQueueDepth();
  }

  function signalConfigurationIsCurrent(signal) {
    if (signal?.recoveryFollow === true) return true;
    if (Number(signal?._localConfigRevision || 0) !== Number(autoRuntime.signalConfigRevision || 0)) return false;
    if (signal?._localConfigKey && signal._localConfigKey !== currentSignalConfigurationKey(settings.autoTrade || {})) return false;
    const strategyId = String(signal?.strategyId || '').trim();
    const actualPeriod = normalizeAnalysisPeriodSeconds(signal?.period ?? 60, 60);
    const expectedPeriod = strategyAnalysisPeriod(strategyId, settings.autoTrade || {});
    if (strategyId && actualPeriod !== expectedPeriod) return false;
    return true;
  }

  function signalIsLatestForKey(signal) {
    if (signal?.recoveryFollow === true) return true;
    const key = signal?._queueKey || signalQueueKey(signal);
    return autoRuntime.latestSignalIdByKey.get(key) === String(signal?.signalId || '');
  }

  async function discardServerSignalSilently(signal, reason = 'discarded') {
    const signalId = String(signal?.signalId || '').trim();
    if (reason === 'expired') autoRuntime.signalDecisionStats.droppedExpired += 1;
    else if (reason === 'old_config') autoRuntime.signalDecisionStats.droppedOldConfig += 1;
    if (!signalId) return;
    if (reason === 'replaced') {
      autoRuntime.executedSignals.add(signalId);
      while (autoRuntime.executedSignals.size > 600) autoRuntime.executedSignals.delete(autoRuntime.executedSignals.values().next().value);
      return;
    }
    await rememberExecutedSignal(signalId);
  }

  function desiredSignalWorkerCount() {
    const configured = Math.max(1, Math.min(20, Number(settings.autoTrade?.maxConcurrent) || 1));
    // Signal checks include storage, license and broker calls. On weak PCs or slow
    // networks excessive parallelism causes timeouts rather than faster execution.
    return Math.max(1, Math.min(configured, CLIENT_PERFORMANCE_PROFILE.signalWorkers));
  }

  function scheduleSignalDispatcher() {
    if (autoRuntime.signalDispatcherScheduled) return;
    autoRuntime.signalDispatcherScheduled = true;
    queueMicrotask(() => {
      autoRuntime.signalDispatcherScheduled = false;
      void runSignalDispatcher();
    });
  }

  async function runSignalDispatcher() {
    const maxWorkers = desiredSignalWorkerCount();
    while (autoRuntime.signalWorkers < maxWorkers && autoRuntime.pendingSignals.size) {
      const [key, signal] = autoRuntime.pendingSignals.entries().next().value;
      autoRuntime.pendingSignals.delete(key);
      autoRuntime.queuedSignalIds.delete(String(signal?.signalId || ''));
      autoRuntime.signalWorkers += 1;
      refreshSignalQueueDepth();
      void (async () => {
        try {
          if (!signalConfigurationIsCurrent(signal)) {
            await discardServerSignalSilently(signal, 'old_config');
            return;
          }
          if (signalExpired(signal) || !signalIsLatestForKey(signal)) {
            await discardServerSignalSilently(signal, signalExpired(signal) ? 'expired' : 'replaced');
            return;
          }
          await processServerSignal(signal);
        } catch (error) {
          await writeAutoStatus({
            force: true,
            enabled: Boolean(settings.autoTrade?.enabled),
            state: 'error',
            message: `Ошибка обработки сигнала: ${String(error?.message || error)}`
          }).catch(() => null);
        } finally {
          const id = String(signal?.signalId || '');
          if (autoRuntime.latestSignalIdByKey.get(key) === id) autoRuntime.latestSignalIdByKey.delete(key);
          autoRuntime.signalWorkers = Math.max(0, autoRuntime.signalWorkers - 1);
          refreshSignalQueueDepth();
          await settleSignalStatusAfterProcessing().catch(() => null);
          scheduleSignalDispatcher();
        }
      })();
    }
  }

  function enqueueServerSignal(rawSignal) {
    const incomingStrategyId = String(rawSignal?.strategyId || '').trim();
    const incomingSourceStrategyIds = Array.isArray(rawSignal?.sourceStrategyIds)
      ? rawSignal.sourceStrategyIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const containsLocalThreeCandle = (incomingStrategyId && isLocalThreeCandleStrategy(incomingStrategyId))
      || incomingSourceStrategyIds.some(isLocalThreeCandleStrategy);
    if (containsLocalThreeCandle && rawSignal?._localThreeCandleSignal !== true) {
      // 3CANDLE is evaluated from the exact browser candle stores below. Ignore a
      // stale server-side interpretation (old EMA9/EMA21 rules) so it cannot open
      // a conflicting trade after the local migration.
      return { ok: true, queued: false, localAuthoritative: true };
    }
    const configKey = currentSignalConfigurationKey(settings.autoTrade || {});
    if (autoRuntime.signalConfigKey !== configKey) resetSignalExecutionPipeline('configuration_key_changed');
    const signal = {
      ...(rawSignal || {}),
      _receivedAt: Date.now(),
      _localConfigRevision: autoRuntime.signalConfigRevision,
      _localConfigKey: configKey
    };
    const signalId = String(signal.signalId || '').trim();
    if (!signalId) return { ok: false, queued: false, error: 'invalid_signal_id' };
    autoRuntime.signalDecisionStats.received += 1;
    const key = signalQueueKey(signal);
    if (
      autoRuntime.executedSignals.has(signalId)
      || autoRuntime.queuedSignalIds.has(signalId)
      || autoRuntime.inFlightSignalIds.has(signalId)
      || autoRuntime.latestSignalIdByKey.get(key) === signalId
    ) {
      autoRuntime.signalDecisionStats.duplicate += 1;
      return { ok: true, queued: false, duplicate: true, queueDepth: refreshSignalQueueDepth() };
    }
    if (!signalConfigurationIsCurrent(signal)) {
      void discardServerSignalSilently(signal, 'old_config');
      return { ok: true, queued: false, staleConfiguration: true, queueDepth: refreshSignalQueueDepth() };
    }
    if (signalExpired(signal)) {
      void discardServerSignalSilently(signal, 'expired');
      return { ok: true, queued: false, expired: true, queueDepth: refreshSignalQueueDepth() };
    }
    signal._queueKey = key;
    const previous = autoRuntime.pendingSignals.get(key);
    if (previous) {
      autoRuntime.queuedSignalIds.delete(String(previous.signalId || ''));
      autoRuntime.signalDecisionStats.replacedByNewer += 1;
      autoRuntime.pendingSignals.delete(key);
      void discardServerSignalSilently(previous, 'replaced');
    }
    autoRuntime.pendingSignals.set(key, signal);
    autoRuntime.latestSignalIdByKey.set(key, signalId);
    autoRuntime.queuedSignalIds.add(signalId);
    refreshSignalQueueDepth();
    scheduleSignalDispatcher();
    return { ok: true, queued: true, queueDepth: autoRuntime.signalQueueDepth };
  }

  function strategyAvailable(strategyId) {
    const strategies = Array.isArray(serverState?.strategies) ? serverState.strategies : [];
    const item = strategies.find((strategy) => strategy.id === strategyId);
    return !item || item.available !== false;
  }

  function autoSessionStartMs(auto = settings.autoTrade || {}) {
    const parsed = Date.parse(auto?.sessionStartedAt || '');
    return Number.isFinite(parsed) ? parsed : autoRuntime.fallbackSessionStartedAt;
  }

  function autoDealMatchesSelectedStrategy(deal, auto = settings.autoTrade || {}) {
    const strategyId = String(deal?.strategyId || '').trim();
    if (!strategyId) return false;
    const selected = Array.isArray(auto?.strategyIds) && auto.strategyIds.length
      ? auto.strategyIds.map(String)
      : [auto?.strategyId || settings.activeStrategyId || ''].filter(Boolean).map(String);
    return !selected.length || selected.includes(strategyId);
  }

  function isRobotTradeDeal(deal) {
    const source = String(deal?.source || '').trim().toLowerCase();
    const requestId = String(deal?.requestId || '').trim();
    return Boolean(deal?.robotTrade === true || source === 'autotrade' || requestId.startsWith('pt_'));
  }

  function isAutoDealForSession(deal, auto = settings.autoTrade || {}) {
    const requestId = String(deal?.requestId || '');
    const source = String(deal?.source || '').toLowerCase();
    const hasAutoIdentity = deal?.robotTrade === true
      || requestId.startsWith('pt_')
      || source === 'autotrade'
      || (source === 'extension' && autoDealMatchesSelectedStrategy(deal, auto));
    if (!hasAutoIdentity) return false;
    const brokerOffsetMs = (finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0) * 1000;
    const timestamp = Number(deal?.openTimestamp || deal?.closeTimestamp || 0) * 1000 - brokerOffsetMs;
    return timestamp >= autoSessionStartMs(auto) - 2000;
  }

  function meaningfulAutoRequestId(value) {
    const requestId = String(value ?? '').trim();
    return requestId && requestId !== '0' && requestId.toLowerCase() !== 'null' && requestId.toLowerCase() !== 'undefined'
      ? requestId
      : '';
  }

  function isBrokerConfirmedCalibrationClose(deal) {
    if (!deal || typeof deal !== 'object' || deal.synthetic === true) return false;
    if (!Number(deal.closeTimestamp || 0)) return false;
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

  function mergedRobotClosedDeals() {
    const mergedByIdentity = new Map();
    const identitiesForDeal = (deal) => {
      const ids = [];
      const brokerId = String(deal?.id || deal?.dealId || '').trim();
      const requestId = meaningfulAutoRequestId(deal?.requestId);
      if (brokerId) ids.push(`deal:${brokerId}`);
      if (requestId) ids.push(`request:${requestId}`);
      if (!ids.length) {
        const openTimestamp = Number(deal?.openTimestamp || 0);
        const closeTimestamp = Number(deal?.closeTimestamp || 0);
        const amount = Number(deal?.amount || 0);
        ids.push(`fallback:${String(deal?.asset || '')}:${String(deal?.action || deal?.command || '')}:${openTimestamp}:${closeTimestamp}:${amount}`);
      }
      return ids;
    };
    const remember = (deal, authoritativeRobotRecord = false) => {
      if (!deal || typeof deal !== 'object') return;
      const identities = identitiesForDeal(deal);
      let existing = null;
      for (const identity of identities) {
        if (mergedByIdentity.has(identity)) {
          existing = mergedByIdentity.get(identity);
          break;
        }
      }
      if (!existing && !authoritativeRobotRecord && !isRobotTradeDeal(deal)) return;
      const next = existing
        ? {
            ...existing,
            ...deal,
            requestId: meaningfulAutoRequestId(deal?.requestId) || meaningfulAutoRequestId(existing?.requestId) || null,
            source: String(existing?.source || '').toLowerCase() === 'autotrade' ? existing.source : (deal?.source || existing?.source || null),
            strategyId: deal?.strategyId || existing?.strategyId || null,
            recoveryStep: deal?.recoveryStep ?? existing?.recoveryStep ?? null,
            recoverySteps: deal?.recoverySteps ?? existing?.recoverySteps ?? null,
            recoveryMultiplier: deal?.recoveryMultiplier ?? existing?.recoveryMultiplier ?? null,
            recoveryScopeStrategyId: deal?.recoveryScopeStrategyId || existing?.recoveryScopeStrategyId || null,
            recoveryScopeAsset: deal?.recoveryScopeAsset || existing?.recoveryScopeAsset || null,
            recoveryFollowSignal: deal?.recoveryFollowSignal === true || existing?.recoveryFollowSignal === true,
            parentRequestId: deal?.parentRequestId || existing?.parentRequestId || null,
            recoveryBranchRootId: deal?.recoveryBranchRootId || existing?.recoveryBranchRootId || null,
            baseAmount: deal?.baseAmount ?? existing?.baseAmount ?? null,
            duration: deal?.duration ?? existing?.duration ?? null,
            robotTrade: authoritativeRobotRecord || existing?.robotTrade === true || isRobotTradeDeal(deal)
          }
        : { ...deal, robotTrade: true };
      for (const identity of identitiesForDeal(next)) mergedByIdentity.set(identity, next);
      // Ensure old aliases that pointed at the previous object now resolve to the
      // merged record as well (for example broker id first, request id later).
      if (existing) {
        for (const [identity, value] of mergedByIdentity.entries()) {
          if (value === existing) mergedByIdentity.set(identity, next);
        }
      }
    };

    // Local enriched close records are inserted first. Authoritative ledger and
    // broker records are merged afterwards and therefore replace provisional data
    // as soon as the full close event arrives.
    for (const deal of autoRuntime.provisionalClosedDeals.values()) remember(deal, true);
    if (ledgerMatchesCurrentAccount()) {
      for (const deal of Array.isArray(robotLedger?.closedDeals) ? robotLedger.closedDeals : []) remember(deal, true);
    }
    for (const deal of Array.isArray(latestState?.trades?.closedDeals) ? latestState.trades.closedDeals : []) remember(deal, false);

    return [...new Set(mergedByIdentity.values())];
  }

  function mergedRobotOpenDeals(auto = settings.autoTrade || {}) {
    const mergedByIdentity = new Map();
    const identitiesForDeal = (deal) => {
      const ids = [];
      const brokerId = String(deal?.id || deal?.dealId || '').trim();
      const requestId = meaningfulAutoRequestId(deal?.requestId);
      if (brokerId) ids.push(`deal:${brokerId}`);
      if (requestId) ids.push(`request:${requestId}`);
      if (!ids.length) {
        ids.push([
          'fallback',
          String(deal?.asset || ''),
          String(dealRecoveryAction(deal) || ''),
          Number(deal?.openTimestamp || 0),
          Number(deal?.amount || 0),
          Number(deal?.duration || 0)
        ].join(':'));
      }
      return ids;
    };
    const remember = (deal) => {
      if (!deal || typeof deal !== 'object' || !isRobotTradeDeal(deal)) return;
      const identities = identitiesForDeal(deal);
      let existing = null;
      for (const identity of identities) {
        if (mergedByIdentity.has(identity)) {
          existing = mergedByIdentity.get(identity);
          break;
        }
      }
      const next = existing
        ? {
            ...existing,
            ...deal,
            requestId: meaningfulAutoRequestId(deal?.requestId) || meaningfulAutoRequestId(existing?.requestId) || null,
            source: deal?.source || existing?.source || 'autotrade',
            strategyId: deal?.strategyId || existing?.strategyId || null,
            recoveryStep: deal?.recoveryStep ?? existing?.recoveryStep ?? null,
            recoverySteps: deal?.recoverySteps ?? existing?.recoverySteps ?? null,
            recoveryMultiplier: deal?.recoveryMultiplier ?? existing?.recoveryMultiplier ?? null,
            recoveryScopeStrategyId: deal?.recoveryScopeStrategyId || existing?.recoveryScopeStrategyId || null,
            recoveryScopeAsset: deal?.recoveryScopeAsset || existing?.recoveryScopeAsset || null,
            recoveryFollowSignal: deal?.recoveryFollowSignal === true || existing?.recoveryFollowSignal === true,
            parentRequestId: deal?.parentRequestId || existing?.parentRequestId || null,
            recoveryBranchRootId: deal?.recoveryBranchRootId || existing?.recoveryBranchRootId || null,
            baseAmount: deal?.baseAmount ?? existing?.baseAmount ?? null,
            robotTrade: true
          }
        : { ...deal, robotTrade: true };
      for (const identity of identitiesForDeal(next)) mergedByIdentity.set(identity, next);
      if (existing) {
        for (const [identity, value] of mergedByIdentity.entries()) {
          if (value === existing) mergedByIdentity.set(identity, next);
        }
      }
    };

    // The live Pocket snapshot is useful when it already carries Robot metadata.
    // The persisted, account-scoped ledger is authoritative after a content-script
    // or page reload, when Pocket may omit requestId/source/recovery fields.
    for (const deal of Array.isArray(latestState?.trades?.openedDeals) ? latestState.trades.openedDeals : []) remember(deal);
    if (ledgerMatchesCurrentAccount()) {
      for (const deal of Array.isArray(robotLedger?.openDeals) ? robotLedger.openDeals : []) remember(deal);
    }
    return [...new Set(mergedByIdentity.values())].filter((deal) => isBrokerDealStillOpen(deal, auto));
  }

  function closedDealsForRisk(auto = settings.autoTrade || {}) {
    return mergedRobotClosedDeals()
      .filter((deal) => isAutoDealForSession(deal, auto))
      .slice()
      .sort((a, b) => Number(a.closeTimestamp || a.openTimestamp || 0) - Number(b.closeTimestamp || b.openTimestamp || 0));
  }

  function recoveryStartMs(auto = settings.autoTrade || {}) {
    const sessionStart = autoSessionStartMs(auto);
    const recoveryStart = Date.parse(auto?.recoveryStartedAt || '');
    return Number.isFinite(recoveryStart) ? Math.max(sessionStart, recoveryStart) : sessionStart;
  }

  function recoveryScopeKeyForAuto(auto = settings.autoTrade || {}, branch = null) {
    const branchKey = String(branch?.scopeKey || branch?.rootKey || '').trim();
    if (branchKey) return branchKey.startsWith('martin-branch:') ? branchKey : `martin-branch:${branchKey}`;
    return auto?.recoveryFollowSignal === true ? '__global_follow_signal__' : '__global_next_signal__';
  }

  function closedDealsForRecovery(auto = settings.autoTrade || {}) {
    const start = recoveryStartMs(auto);
    const brokerOffsetMs = (finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0) * 1000;
    // Martingale is global. Strategy and asset are branch metadata only; neither
    // may partition the recovery history or hide a loss from another strategy.
    return closedDealsForRisk(auto).filter((deal) => {
      const timestamp = Number(deal?.openTimestamp || deal?.closeTimestamp || 0) * 1000 - brokerOffsetMs;
      return timestamp >= start - 2000;
    });
  }


  function recoveryDealKey(deal) {
    const requestId = meaningfulAutoRequestId(deal?.requestId);
    if (requestId) return requestId;
    const brokerId = String(deal?.id || deal?.dealId || '').trim();
    if (brokerId) return `deal_${brokerId}`;
    const opened = Math.floor(Number(deal?.openTimestamp || 0));
    const closed = Math.floor(Number(deal?.closeTimestamp || 0));
    const amount = Math.round((Number(deal?.amount) || 0) * 100) / 100;
    return `fallback_${String(deal?.strategyId || '')}_${String(deal?.asset || '')}_${String(deal?.action || deal?.command || '')}_${opened}_${closed}_${amount}`;
  }

  function recoveryBranchBaseAmount(rootDeal, latestDeal = null) {
    const explicit = optionalFiniteNumber(rootDeal?.baseAmount ?? latestDeal?.baseAmount);
    if (explicit != null && explicit > 0) return Math.max(0.01, Math.round(explicit * 100) / 100);
    const rootAmount = optionalFiniteNumber(rootDeal?.amount);
    if (rootAmount != null && rootAmount > 0) return Math.max(0.01, Math.round(rootAmount * 100) / 100);
    const latestAmount = optionalFiniteNumber(latestDeal?.amount);
    const multiplier = Math.max(1, optionalFiniteNumber(latestDeal?.recoveryMultiplier) ?? 1);
    if (latestAmount != null && latestAmount > 0) return Math.max(0.01, Math.round((latestAmount / multiplier) * 100) / 100);
    return baseTradeAmountForAuto(settings.autoTrade || {});
  }

  function recoveryBranchesForAuto(auto = settings.autoTrade || {}) {
    const stepCount = Math.min(5, Math.max(0, Number(auto?.recoverySteps) || 0));
    const enabled = auto?.recoveryMode === 'steps' && stepCount > 0;
    if (!enabled) return [];

    const deals = closedDealsForRecovery(auto).slice().sort((a, b) => {
      const aTime = Number(a?.closeTimestamp || a?.openTimestamp || 0);
      const bTime = Number(b?.closeTimestamp || b?.openTimestamp || 0);
      return aTime - bTime;
    });
    const branches = new Map();
    const branchByDealKey = new Map();
    const dealByKey = new Map();

    for (const deal of deals) {
      const dealKey = recoveryDealKey(deal);
      dealByKey.set(dealKey, deal);
      const explicitRoot = String(deal?.recoveryBranchRootId || '').trim();
      const parentKey = meaningfulAutoRequestId(deal?.parentRequestId);
      const explicitStep = Math.max(0, Math.floor(optionalFiniteNumber(deal?.recoveryStep) ?? 0));
      const isRecoveryDeal = Boolean(parentKey || explicitRoot) || explicitStep > 0;
      const net = dealNetValue(deal);
      const neutral = isNeutralDealResult(deal, net);

      if (!isRecoveryDeal) {
        if (net > 0.0000001) continue;
        const rootKey = dealKey;
        const branch = {
          rootKey,
          scopeKey: `martin-branch:${rootKey}`,
          rootDeal: deal,
          rootRequestId: meaningfulAutoRequestId(deal?.requestId) || dealKey,
          latestDeal: deal,
          latestDealKey: dealKey,
          asset: String(deal?.asset || '').trim(),
          action: dealRecoveryAction(deal),
          strategyId: String(deal?.strategyId || '').trim(),
          baseAmount: recoveryBranchBaseAmount(deal, deal),
          nextStep: neutral ? 0 : 1,
          repeatNeutral: neutral,
          resolved: false,
          exhausted: false,
          resetCycle: false,
          openedAt: Number(deal?.openTimestamp || deal?.closeTimestamp || 0),
          resolvedAt: null,
          createdAt: Number(deal?.closeTimestamp || deal?.openTimestamp || 0),
          updatedAt: Number(deal?.closeTimestamp || deal?.openTimestamp || 0)
        };
        branches.set(rootKey, branch);
        branchByDealKey.set(dealKey, rootKey);
        continue;
      }

      let rootKey = explicitRoot || (parentKey ? branchByDealKey.get(parentKey) : null);
      if (!rootKey && parentKey && branches.has(parentKey)) rootKey = parentKey;
      if (!rootKey && parentKey) {
        const parentDeal = dealByKey.get(parentKey) || null;
        rootKey = parentKey;
        branches.set(rootKey, {
          rootKey,
          scopeKey: `martin-branch:${rootKey}`,
          rootDeal: parentDeal || deal,
          rootRequestId: parentKey,
          latestDeal: parentDeal || deal,
          latestDealKey: parentKey,
          asset: String(parentDeal?.asset || deal?.asset || '').trim(),
          action: dealRecoveryAction(parentDeal || deal),
          strategyId: String(parentDeal?.strategyId || deal?.strategyId || '').trim(),
          baseAmount: recoveryBranchBaseAmount(parentDeal || deal, deal),
          nextStep: Math.max(1, explicitStep || 1),
          repeatNeutral: false,
          resolved: false,
          exhausted: false,
          resetCycle: false,
          openedAt: Number(parentDeal?.openTimestamp || deal?.openTimestamp || parentDeal?.closeTimestamp || 0),
          resolvedAt: null,
          createdAt: Number(parentDeal?.closeTimestamp || parentDeal?.openTimestamp || deal?.openTimestamp || 0),
          updatedAt: Number(parentDeal?.closeTimestamp || parentDeal?.openTimestamp || deal?.openTimestamp || 0)
        });
      }
      if (!rootKey) {
        // Compatibility fallback for a recovery deal created by an older build
        // without parentRequestId. Attach it to the oldest unresolved matching
        // branch instead of collapsing all parallel losses into one global streak.
        const unresolved = [...branches.values()].filter((branch) => !branch.resolved);
        const matching = unresolved.find((branch) => !branch.asset || branch.asset === String(deal?.asset || ''))
          || unresolved[0];
        rootKey = matching?.rootKey || `legacy_${dealKey}`;
        if (!branches.has(rootKey)) {
          branches.set(rootKey, {
            rootKey,
            scopeKey: `martin-branch:${rootKey}`,
            rootDeal: deal,
            rootRequestId: rootKey,
            latestDeal: deal,
            latestDealKey: dealKey,
            asset: String(deal?.asset || '').trim(),
            action: dealRecoveryAction(deal),
            strategyId: String(deal?.strategyId || '').trim(),
            baseAmount: recoveryBranchBaseAmount(deal, deal),
            nextStep: Math.max(1, explicitStep || 1),
            repeatNeutral: false,
            resolved: false,
            exhausted: false,
            resetCycle: false,
            openedAt: Number(deal?.openTimestamp || deal?.closeTimestamp || 0),
            resolvedAt: null,
            createdAt: Number(deal?.openTimestamp || 0),
            updatedAt: Number(deal?.closeTimestamp || deal?.openTimestamp || 0)
          });
        }
      }

      const branch = branches.get(rootKey);
      if (!branch) continue;
      branch.latestDeal = deal;
      branch.latestDealKey = dealKey;
      branch.asset = String(branch.asset || deal?.asset || '').trim();
      branch.action = branch.action || dealRecoveryAction(deal);
      branch.strategyId = String(branch.strategyId || deal?.strategyId || '').trim();
      branch.baseAmount = recoveryBranchBaseAmount(branch.rootDeal, deal);
      branch.updatedAt = Number(deal?.closeTimestamp || deal?.openTimestamp || branch.updatedAt || 0);
      branchByDealKey.set(dealKey, rootKey);

      if (net > 0.0000001) {
        branch.resolved = true;
        branch.resolvedAt = Number(deal?.closeTimestamp || deal?.openTimestamp || branch.updatedAt || 0);
        branch.exhausted = false;
        branch.repeatNeutral = false;
        branch.nextStep = 0;
        continue;
      }
      branch.resolved = false;
      branch.resolvedAt = null;
      branch.repeatNeutral = neutral;
      branch.nextStep = neutral ? explicitStep : Math.max(1, explicitStep + 1);
      if (branch.nextStep > stepCount) {
        if (auto?.recoveryAfterMax === 'reset') {
          branch.nextStep = 0;
          branch.resetCycle = true;
          branch.exhausted = false;
        } else {
          branch.exhausted = true;
        }
      } else {
        branch.exhausted = false;
      }
    }

    // maxConcurrent limits new admissions and simultaneous execution, not history.
    // If the user lowers 2 -> 1 while two real branches exist, both must remain in
    // recovery and continue sequentially; filtering history by the new value would
    // silently discard the later loss forever.
    return [...branches.values()]
      .sort((a, b) => (a.createdAt - b.createdAt) || a.rootKey.localeCompare(b.rootKey));
  }

  function pendingRecoveryBranches(auto = settings.autoTrade || {}) {
    return recoveryBranchesForAuto(auto).filter((branch) => !branch.resolved).slice(0, 20);
  }

  function globalRecoveryView(auto = settings.autoTrade || {}) {
    return { ...auto, recoveryScopeStrategyId: '', recoveryScopeAsset: '' };
  }

  function brokerOpenDealMatchesRecoveryBranch(deal, branch, auto = settings.autoTrade || {}) {
    if (!deal || !branch || !isRobotTradeDeal(deal) || !isBrokerDealStillOpen(deal, auto)) return false;
    const explicitRoot = String(deal?.recoveryBranchRootId || '').trim();
    const branchRoots = new Set([branch.rootKey, branch.rootRequestId, branch.scopeKey?.replace(/^martin-branch:/, '')].map((value) => String(value || '').trim()).filter(Boolean));
    if (explicitRoot && branchRoots.has(explicitRoot.replace(/^martin-branch:/, ''))) return true;
    const parent = meaningfulAutoRequestId(deal?.parentRequestId);
    if (!parent) return false;
    const parentAliases = new Set([
      meaningfulAutoRequestId(branch.latestDeal?.requestId),
      meaningfulAutoRequestId(branch.latestDealKey),
      meaningfulAutoRequestId(branch.rootRequestId),
      meaningfulAutoRequestId(branch.rootDeal?.requestId),
      meaningfulAutoRequestId(branch.rootKey)
    ].filter(Boolean));
    return parentAliases.has(parent);
  }

  function brokerOpenRecoveryDealForBranch(branch, auto = settings.autoTrade || {}) {
    const opened = mergedRobotOpenDeals(auto);
    return opened.find((deal) => brokerOpenDealMatchesRecoveryBranch(deal, branch, auto)) || null;
  }

  const RECOVERY_BRANCH_CLAIM_TTL_MS = 90_000;

  function pruneRecoveryBranchClaims(now = Date.now()) {
    for (const [scopeKey, claim] of autoRuntime.recoveryBranchClaims.entries()) {
      const claimedAt = Number(claim?.claimedAt || 0);
      if (!scopeKey || !claim?.ownerSignalId || !claimedAt || now - claimedAt > RECOVERY_BRANCH_CLAIM_TTL_MS) {
        autoRuntime.recoveryBranchClaims.delete(scopeKey);
      }
    }
  }

  function recoveryBranchClaimOwner(scopeKey) {
    pruneRecoveryBranchClaims();
    return String(autoRuntime.recoveryBranchClaims.get(String(scopeKey || '').trim())?.ownerSignalId || '').trim();
  }

  function releaseRecoveryBranchClaim(scopeKey, ownerSignalId = '') {
    const key = String(scopeKey || '').trim();
    if (!key) return;
    const owner = String(ownerSignalId || '').trim();
    const current = recoveryBranchClaimOwner(key);
    if (!current || !owner || current === owner) autoRuntime.recoveryBranchClaims.delete(key);
  }

  function recoveryBranchIsBusy(branch, ownerSignalId = '') {
    const auto = settings.autoTrade || {};
    const scopeKey = recoveryScopeKeyForAuto(auto, branch);
    const owner = String(ownerSignalId || '').trim();
    const claimedBy = recoveryBranchClaimOwner(scopeKey);
    return (Boolean(claimedBy) && claimedBy !== owner)
      || autoRuntime.inFlightRecoveryScopes.has(scopeKey)
      || [...autoRuntime.activeTrades.values()].some((item) => item?.recoveryScopeKey === scopeKey)
      || [...autoRuntime.settlementPendingTrades.values()].some((item) => item?.recoveryScopeKey === scopeKey)
      || Boolean(brokerOpenRecoveryDealForBranch(branch, auto));
  }

  function selectPendingRecoveryBranch(auto = settings.autoTrade || {}, requestedRootKey = '', ownerSignalId = '') {
    const requested = String(requestedRootKey || '').trim();
    const branches = pendingRecoveryBranches(auto);
    if (requested) {
      const exact = branches.find((branch) => branch.rootKey === requested || branch.rootRequestId === requested || branch.scopeKey === requested);
      return exact && !recoveryBranchIsBusy(exact, ownerSignalId) ? exact : null;
    }
    return branches.find((branch) => !branch.exhausted && !recoveryBranchIsBusy(branch, ownerSignalId))
      || branches.find((branch) => !recoveryBranchIsBusy(branch, ownerSignalId))
      || null;
  }

  function claimRecoveryBranch(auto, branch, ownerSignalId) {
    const owner = String(ownerSignalId || '').trim();
    if (!branch || !owner) return { ok: false, reason: 'invalid_recovery_claim', scopeKey: '' };
    const scopeKey = recoveryScopeKeyForAuto(auto, branch);
    const claimedBy = recoveryBranchClaimOwner(scopeKey);
    if (claimedBy && claimedBy !== owner) return { ok: false, reason: 'recovery_claimed', scopeKey, claimedBy };
    if (recoveryBranchIsBusy(branch, owner)) return { ok: false, reason: 'recovery_scope_busy', scopeKey };
    autoRuntime.recoveryBranchClaims.set(scopeKey, { ownerSignalId: owner, claimedAt: Date.now(), rootKey: branch.rootKey || null });
    return { ok: true, scopeKey, ownerSignalId: owner };
  }

  function closedDealReconcileKey(deal) {
    const requestId = meaningfulAutoRequestId(deal?.requestId);
    if (requestId) return `request:${requestId}`;
    const dealId = String(deal?.id || deal?.dealId || '').trim();
    if (dealId) return `deal:${dealId}`;
    return [
      'fallback',
      String(deal?.asset || ''),
      String(dealRecoveryAction(deal) || ''),
      Number(deal?.openTimestamp || 0),
      Number(deal?.closeTimestamp || 0),
      Number(deal?.amount || 0),
    ].join(':');
  }

  function closedDealReconcileAliases(deal) {
    const aliases = new Set([closedDealReconcileKey(deal)]);
    const requestId = meaningfulAutoRequestId(deal?.requestId);
    const dealId = String(deal?.id || deal?.dealId || '').trim();
    if (requestId) aliases.add(`request:${requestId}`);
    if (dealId) aliases.add(`deal:${dealId}`);
    aliases.add([
      'fallback',
      String(deal?.asset || ''),
      String(dealRecoveryAction(deal) || ''),
      Number(deal?.openTimestamp || 0),
      Number(deal?.closeTimestamp || 0),
      Number(deal?.amount || 0),
    ].join(':'));
    return [...aliases];
  }

  function closedDealWasReconciled(deal) {
    return closedDealReconcileAliases(deal).some((key) => autoRuntime.reconciledClosedDealKeys.has(key));
  }

  function markClosedDealReconciled(deal) {
    for (const key of closedDealReconcileAliases(deal)) autoRuntime.reconciledClosedDealKeys.add(key);
    while (autoRuntime.reconciledClosedDealKeys.size > 5000) {
      autoRuntime.reconciledClosedDealKeys.delete(autoRuntime.reconciledClosedDealKeys.values().next().value);
    }
  }

  function brokerDealTimestampMs(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const timestampMs = raw > 10_000_000_000 ? raw : raw * 1000;
    const brokerOffsetMs = (finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0) * 1000;
    return timestampMs - brokerOffsetMs;
  }

  function activeTradeClosedDealMatchScore(deal, item) {
    const dealAsset = String(deal?.asset || '').trim();
    const itemAsset = String(item?.asset || '').trim();
    if (!dealAsset || !itemAsset || dealAsset !== itemAsset) return null;

    const dealId = String(deal?.id || deal?.dealId || '').trim();
    const itemDealId = String(item?.dealId || '').trim();
    if (dealId && itemDealId) return dealId === itemDealId ? 100 : null;

    let score = 10;
    let corroboratingFields = 0;
    const dealAction = dealRecoveryAction(deal);
    const itemAction = dealRecoveryAction(item);
    if (dealAction && itemAction) {
      if (dealAction !== itemAction) return null;
      score += 6;
      corroboratingFields += 1;
    }

    const dealAmount = optionalFiniteNumber(deal?.amount);
    const itemAmount = optionalFiniteNumber(item?.amount);
    if (dealAmount != null && itemAmount != null) {
      const tolerance = Math.max(0.01, Math.abs(itemAmount) * 0.005);
      if (Math.abs(dealAmount - itemAmount) > tolerance) return null;
      score += 6;
      corroboratingFields += 1;
    }

    const dealDuration = optionalFiniteNumber(deal?.duration ?? deal?.expiration);
    const itemDuration = optionalFiniteNumber(item?.duration);
    if (dealDuration != null && itemDuration != null) {
      if (Math.abs(dealDuration - itemDuration) > 1) return null;
      score += 4;
      corroboratingFields += 1;
    }

    const dealStrategyId = String(deal?.strategyId || '').trim();
    const itemStrategyId = String(item?.strategyId || '').trim();
    if (dealStrategyId && itemStrategyId) {
      if (dealStrategyId !== itemStrategyId) return null;
      score += 5;
      corroboratingFields += 1;
    }

    const dealOpenedAt = brokerDealTimestampMs(deal?.openTimestamp);
    const itemOpenedAt = optionalFiniteNumber(item?.openedAt);
    if (dealOpenedAt != null && itemOpenedAt != null) {
      const timeDifference = Math.abs(dealOpenedAt - itemOpenedAt);
      if (timeDifference > 30_000) return null;
      score += timeDifference <= 5_000 ? 8 : timeDifference <= 15_000 ? 5 : 2;
      corroboratingFields += 1;
    }

    const dealClosedAt = brokerDealTimestampMs(deal?.closeTimestamp);
    if (dealClosedAt != null && itemOpenedAt != null && dealClosedAt < itemOpenedAt - 2_000) return null;
    return corroboratingFields >= 2 ? score : null;
  }

  function provisionalClosedDealFromMatch(requestId, item, deal) {
    if (!item || !deal) return null;
    const normalizedRequestId = meaningfulAutoRequestId(requestId || deal?.requestId);
    if (!normalizedRequestId) return null;
    const brokerOffsetSec = finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0;
    const openedAtSec = Number.isFinite(Number(item?.openedAt))
      ? Math.floor(Number(item.openedAt) / 1000 + brokerOffsetSec)
      : null;
    return {
      ...deal,
      id: deal?.id || deal?.dealId || item?.dealId || null,
      dealId: deal?.dealId || deal?.id || item?.dealId || null,
      requestId: normalizedRequestId,
      source: 'autotrade',
      robotTrade: true,
      asset: String(item?.asset || deal?.asset || '').trim(),
      action: dealRecoveryAction(item) || dealRecoveryAction(deal),
      amount: optionalFiniteNumber(item?.amount) ?? optionalFiniteNumber(deal?.amount),
      duration: optionalFiniteNumber(item?.duration) ?? optionalFiniteNumber(deal?.duration),
      strategyId: String(item?.strategyId || deal?.strategyId || '').trim() || null,
      recoveryStep: Math.max(0, Math.floor(optionalFiniteNumber(item?.recoveryStep ?? deal?.recoveryStep) ?? 0)),
      recoverySteps: Math.max(0, Math.floor(optionalFiniteNumber(item?.recoverySteps ?? deal?.recoverySteps) ?? 0)),
      recoveryMultiplier: optionalFiniteNumber(item?.recoveryMultiplier ?? deal?.recoveryMultiplier),
      recoveryScopeStrategyId: item?.recoveryScopeStrategyId || deal?.recoveryScopeStrategyId || null,
      recoveryScopeAsset: item?.recoveryScopeAsset || deal?.recoveryScopeAsset || null,
      recoveryFollowSignal: item?.recoveryFollowSignal === true || deal?.recoveryFollowSignal === true,
      parentRequestId: meaningfulAutoRequestId(item?.parentRequestId || deal?.parentRequestId) || null,
      recoveryBranchRootId: item?.recoveryBranchRootId || deal?.recoveryBranchRootId || null,
      baseAmount: optionalFiniteNumber(item?.baseAmount ?? deal?.baseAmount),
      openTimestamp: optionalFiniteNumber(deal?.openTimestamp) ?? openedAtSec,
      closeTimestamp: optionalFiniteNumber(deal?.closeTimestamp) ?? optionalFiniteNumber(deal?.expirationTimestamp),
      status: deal?.status || 'closed'
    };
  }

  function rememberProvisionalClosedDeal(requestId, item, deal) {
    const enriched = provisionalClosedDealFromMatch(requestId, item, deal);
    if (!enriched) return null;
    autoRuntime.provisionalClosedDeals.set(enriched.requestId, enriched);
    autoRuntime.settlementPendingTrades.delete(enriched.requestId);
    while (autoRuntime.provisionalClosedDeals.size > 500) {
      autoRuntime.provisionalClosedDeals.delete(autoRuntime.provisionalClosedDeals.keys().next().value);
    }
    return enriched;
  }

  function pruneSettlementPendingTrades() {
    // Delayed settlement is a safety lock, not a timer. Releasing it without a
    // broker result can create an extra base branch. The lock is removed only by
    // a matched close event or by an explicit autotrade session reset.
  }

  function reconcileActiveAutoTrades() {
    const mergedClosed = mergedRobotClosedDeals().filter(closedDealOutcomeKnown);
    const brokerClosed = (Array.isArray(latestState?.trades?.closedDeals) ? latestState.trades.closedDeals : []).filter(closedDealOutcomeKnown);
    // Raw Pocket close events are included deliberately. Some of them arrive
    // before requestId/source/recovery metadata; matching them against a known
    // local slot is what makes the Martingale transition atomic.
    const closedCandidates = [...brokerClosed, ...mergedClosed];
    const closedByRequestId = new Map();
    const closedByDealId = new Map();
    for (const deal of closedCandidates) {
      const requestId = meaningfulAutoRequestId(deal?.requestId);
      const dealId = String(deal?.id || deal?.dealId || '').trim();
      if (requestId) closedByRequestId.set(requestId, deal);
      if (dealId) closedByDealId.set(dealId, deal);
    }
    const unreconciledClosedDeals = closedCandidates.filter((deal) => !closedDealWasReconciled(deal));
    const now = Date.now();
    let released = 0;

    for (const [requestId, item] of autoRuntime.activeTrades.entries()) {
      const matchedClosedDeal = closedByRequestId.get(String(requestId))
        || (item?.dealId ? closedByDealId.get(String(item.dealId)) : null);
      const expiredSafetySlot = now > Number(item?.releaseAt || 0);
      if (matchedClosedDeal) {
        rememberProvisionalClosedDeal(requestId, item, matchedClosedDeal);
        markClosedDealReconciled(matchedClosedDeal);
        autoRuntime.activeTrades.delete(requestId);
        released += 1;
      } else if (expiredSafetySlot) {
        // Never free a potential branch into the base-signal pool before Pocket has
        // delivered the result. Keep the branch reserved until reconciliation.
        autoRuntime.activeTrades.delete(requestId);
        autoRuntime.settlementPendingTrades.set(requestId, {
          ...item,
          requestId,
          pendingSince: now,
          expiresAt: null
        });
        released += 1;
      }
    }

    // Pocket may omit requestId/source on the first close snapshot. Match only a
    // unique local slot using asset/action/amount/duration/open-time evidence.
    for (const deal of unreconciledClosedDeals) {
      if (!autoRuntime.activeTrades.size) break;
      if (closedDealWasReconciled(deal)) continue;
      const requestId = meaningfulAutoRequestId(deal?.requestId);
      const dealId = String(deal?.id || deal?.dealId || '').trim();
      if (requestId && autoRuntime.activeTrades.has(requestId)) continue;
      if (dealId && [...autoRuntime.activeTrades.values()].some((item) => String(item?.dealId || '') === dealId)) continue;
      const candidates = [...autoRuntime.activeTrades.entries()]
        .map(([activeRequestId, item]) => ({ requestId: activeRequestId, item, score: activeTradeClosedDealMatchScore(deal, item) }))
        .filter((candidate) => candidate.score != null)
        .sort((a, b) => b.score - a.score);
      if (!candidates.length) continue;
      const best = candidates[0];
      const second = candidates[1];
      if (second && best.score - second.score < 3) continue;
      if (dealId) best.item.dealId = dealId;
      rememberProvisionalClosedDeal(best.requestId, best.item, deal);
      markClosedDealReconciled(deal);
      autoRuntime.activeTrades.delete(best.requestId);
      released += 1;
    }

    // A timed-out local slot may receive its close snapshot later. The settlement
    // lock keeps both its branch and its asset unavailable until this match lands.
    pruneSettlementPendingTrades();
    for (const deal of unreconciledClosedDeals) {
      if (!autoRuntime.settlementPendingTrades.size) break;
      if (closedDealWasReconciled(deal)) continue;
      const directRequestId = meaningfulAutoRequestId(deal?.requestId);
      const directDealId = String(deal?.id || deal?.dealId || '').trim();
      let directEntry = null;
      if (directRequestId && autoRuntime.settlementPendingTrades.has(directRequestId)) {
        directEntry = [directRequestId, autoRuntime.settlementPendingTrades.get(directRequestId)];
      } else if (directDealId) {
        directEntry = [...autoRuntime.settlementPendingTrades.entries()]
          .find(([, item]) => String(item?.dealId || '') === directDealId) || null;
      }
      if (directEntry) {
        rememberProvisionalClosedDeal(directEntry[0], directEntry[1], deal);
        markClosedDealReconciled(deal);
        continue;
      }
      const candidates = [...autoRuntime.settlementPendingTrades.entries()]
        .map(([pendingRequestId, item]) => ({ requestId: pendingRequestId, item, score: activeTradeClosedDealMatchScore(deal, item) }))
        .filter((candidate) => candidate.score != null)
        .sort((a, b) => b.score - a.score);
      if (!candidates.length) continue;
      const best = candidates[0];
      const second = candidates[1];
      if (second && best.score - second.score < 3) continue;
      rememberProvisionalClosedDeal(best.requestId, best.item, deal);
      markClosedDealReconciled(deal);
    }

    autoRuntime.lastClosedDealCount = mergedRobotClosedDeals().length;
    if (released > 0 && settings.autoTrade?.enabled) {
      setTimeout(() => {
        scheduleAutoEngine();
        void publishCandleSnapshots(true);
      }, 250);
    }
  }

  function branchCommitmentState(auto = settings.autoTrade || {}) {
    pruneSettlementPendingTrades();
    const recoveryEnabled = auto?.recoveryMode === 'steps' && Number(auto?.recoverySteps) > 0;
    if (!recoveryEnabled) return { enabled: false, pendingBranches: 0, openBaseTrades: 0, inFlightBaseTrades: 0, settlementPending: 0, total: 0 };

    const pendingBranches = pendingRecoveryBranches(globalRecoveryView(auto)).length;
    const activeEntries = [...autoRuntime.activeTrades.entries()];
    const settlementEntries = [...autoRuntime.settlementPendingTrades.entries()];
    const localRuntimeEntries = [...activeEntries, ...settlementEntries];
    const knownRuntimeKeys = new Set();
    for (const [requestId, item] of localRuntimeEntries) {
      const requestKey = meaningfulAutoRequestId(requestId);
      const dealKey = String(item?.dealId || '').trim();
      if (requestKey) knownRuntimeKeys.add(`request:${requestKey}`);
      if (dealKey) knownRuntimeKeys.add(`deal:${dealKey}`);
    }

    let openBaseTrades = activeEntries
      .filter(([, item]) => Math.max(0, Number(item?.recoveryStep) || 0) === 0).length;
    const brokerOpenDeals = mergedRobotOpenDeals(auto);
    for (const deal of brokerOpenDeals) {
      if (!isRobotTradeDeal(deal) || !isBrokerDealStillOpen(deal, auto)) continue;
      if (Math.max(0, Number(deal?.recoveryStep) || 0) !== 0) continue;
      const requestId = meaningfulAutoRequestId(deal?.requestId);
      const dealId = String(deal?.id || deal?.dealId || '').trim();
      const exactMatch = (requestId && knownRuntimeKeys.has(`request:${requestId}`))
        || (dealId && knownRuntimeKeys.has(`deal:${dealId}`));
      const fuzzyMatch = !exactMatch && localRuntimeEntries.some(([, item]) => activeTradeClosedDealMatchScore(deal, item) != null);
      if (!exactMatch && !fuzzyMatch) openBaseTrades += 1;
    }

    const inFlightBaseTrades = autoRuntime.inFlightBaseSignals.size;
    const settlementPending = settlementEntries
      .filter(([, item]) => Math.max(0, Number(item?.recoveryStep) || 0) === 0).length;
    return {
      enabled: true,
      pendingBranches,
      openBaseTrades,
      inFlightBaseTrades,
      settlementPending,
      total: pendingBranches + openBaseTrades + inFlightBaseTrades + settlementPending
    };
  }

  function openRobotTradeSlotCount(auto = settings.autoTrade || {}) {
    const brokerOpenDeals = mergedRobotOpenDeals(auto);
    const localEntries = [
      ...autoRuntime.activeTrades.entries(),
      ...autoRuntime.settlementPendingTrades.entries()
    ];
    const localKeys = new Set();
    for (const [requestId, item] of localEntries) {
      const requestKey = meaningfulAutoRequestId(requestId || item?.requestId);
      const dealKey = String(item?.dealId || '').trim();
      if (requestKey) localKeys.add(`request:${requestKey}`);
      if (dealKey) localKeys.add(`deal:${dealKey}`);
    }
    let unmatchedBroker = 0;
    for (const deal of brokerOpenDeals) {
      const requestId = meaningfulAutoRequestId(deal?.requestId);
      const dealId = String(deal?.id || deal?.dealId || '').trim();
      const exact = (requestId && localKeys.has(`request:${requestId}`)) || (dealId && localKeys.has(`deal:${dealId}`));
      const fuzzy = !exact && localEntries.some(([, item]) => activeTradeClosedDealMatchScore(deal, item) != null);
      if (!exact && !fuzzy) unmatchedBroker += 1;
    }
    return localEntries.length + unmatchedBroker;
  }

  function autoTradeSlotState(auto, asset, requestedRecoveryScopeKey = '', ownerSignalId = '') {
    reconcileActiveAutoTrades();
    const openDeals = mergedRobotOpenDeals(auto);
    const maxConcurrent = Math.min(20, Math.max(1, Number(auto.maxConcurrent) || 1));
    const activeAssets = new Set([
      ...openDeals.map((deal) => String(deal?.asset || '')),
      ...[...autoRuntime.activeTrades.values()].map((item) => String(item?.asset || '')),
      ...[...autoRuntime.settlementPendingTrades.values()].map((item) => String(item?.asset || '')),
      ...[...autoRuntime.inFlightAssets.values()].map((item) => String(item || ''))
    ].filter(Boolean));
    const effectiveOpenCount = openRobotTradeSlotCount(auto) + autoRuntime.inFlightSignalIds.size;
    const concurrentBusy = effectiveOpenCount >= maxConcurrent;
    const recoveryScopeKey = String(requestedRecoveryScopeKey || '').trim();
    const recoveryBranch = recoveryScopeKey
      ? pendingRecoveryBranches(globalRecoveryView(auto)).find((branch) => recoveryScopeKeyForAuto(auto, branch) === recoveryScopeKey) || null
      : null;
    const recoveryClaimOwner = recoveryBranchClaimOwner(recoveryScopeKey);
    const recoveryBusy = Boolean(recoveryScopeKey) && (
      (Boolean(recoveryClaimOwner) && recoveryClaimOwner !== String(ownerSignalId || '').trim())
      || autoRuntime.inFlightRecoveryScopes.has(recoveryScopeKey)
      || [...autoRuntime.activeTrades.values()].some((item) => item?.recoveryScopeKey === recoveryScopeKey)
      || [...autoRuntime.settlementPendingTrades.values()].some((item) => item?.recoveryScopeKey === recoveryScopeKey)
      || Boolean(recoveryBranch && brokerOpenRecoveryDealForBranch(recoveryBranch, auto))
    );
    const ordinaryAssetBusy = auto.onePerAsset !== false && activeAssets.has(String(asset || ''));
    const assetBusy = recoveryBusy || ordinaryAssetBusy;
    const branchCommitments = branchCommitmentState(auto);
    const branchCapacityBusy = !recoveryScopeKey && branchCommitments.enabled && branchCommitments.total >= maxConcurrent;
    return {
      available: !concurrentBusy && !assetBusy && !branchCapacityBusy,
      concurrentBusy,
      assetBusy,
      recoveryBusy,
      branchCapacityBusy,
      branchCommitments,
      recoveryScopeKey,
      effectiveOpenCount,
      maxConcurrent
    };
  }

  // Atomically claims the execution slot after all signal checks are complete.
  // v1.0.90 serialized every signal, so two entries could never consume the same
  // Martingale level. The parallel dispatcher introduced later needs an explicit
  // synchronous reservation: JavaScript executes this check-and-set without an
  // await, therefore another worker observes the reservation before it can trade.
  function tryReserveAutoTradeSlot(auto, asset, signalId, requestedRecoveryScopeKey = '') {
    const requestKey = String(signalId || '').trim();
    if (!requestKey) return { ok: false, reason: 'invalid_signal_id' };
    if (autoRuntime.inFlightSignalIds.has(requestKey)) return { ok: false, reason: 'signal_in_flight' };

    const closedSessionDeals = closedDealsForRisk(auto);
    const openedSessionDeals = (Array.isArray(latestState?.trades?.openedDeals) ? latestState.trades.openedDeals : [])
      .filter((deal) => isAutoDealForSession(deal, auto));
    const sessionTradeCount = closedSessionDeals.length
      + openRobotTradeSlotCount(auto)
      + autoRuntime.inFlightSignalIds.size;
    if (Number(auto.maxTrades) > 0 && sessionTradeCount >= Number(auto.maxTrades)) {
      return { ok: false, reason: 'max_trades', trades: sessionTradeCount };
    }

    const slot = autoTradeSlotState(auto, asset, requestedRecoveryScopeKey, requestKey);
    if (!slot.available) return { ok: false, reason: 'slot_busy', ...slot };
    const recoveryScopeKey = String(requestedRecoveryScopeKey || slot.recoveryScopeKey || '').trim();
    if (recoveryScopeKey && autoRuntime.inFlightRecoveryScopes.has(recoveryScopeKey)) {
      return { ok: false, reason: 'recovery_scope_busy', ...slot, recoveryBusy: true, recoveryScopeKey };
    }

    autoRuntime.inFlightSignalIds.add(requestKey);
    if (asset) autoRuntime.inFlightAssets.add(String(asset));
    if (recoveryScopeKey) autoRuntime.inFlightRecoveryScopes.add(recoveryScopeKey);
    else autoRuntime.inFlightBaseSignals.add(requestKey);
    return { ok: true, ...slot, recoveryScopeKey, reservedSignalId: requestKey };
  }

  async function waitForAutoTradeSlot(signal, auto, asset, followRecovery = false, requestedRecoveryScopeKey = '') {
    if (!settings.autoTrade?.enabled) return { ok: false, reason: 'autotrade_disabled' };
    if (!isConnected()) return { ok: false, reason: 'terminal_disconnected' };
    if (!followRecovery && !signalConfigurationIsCurrent(signal)) return { ok: false, reason: 'configuration_changed' };
    if (!followRecovery && signalExpired(signal)) return { ok: false, reason: 'expired' };
    if (!followRecovery && !signalIsLatestForKey(signal)) return { ok: false, reason: 'superseded' };

    const slot = autoTradeSlotState(auto, asset, requestedRecoveryScopeKey, signal?.signalId || signal?.id || '');
    if (slot.available) return { ok: true, ...slot };

    const reason = slot.branchCapacityBusy ? 'branch_capacity' : slot.recoveryBusy ? 'recovery_scope_busy' : 'slot_busy';
    await writeAutoStatus({
      force: true,
      enabled: true,
      state: 'scanning',
      message: slot.branchCapacityBusy
        ? `Сигнал пропущен: все глобальные ветки Мартингейла заняты (${slot.branchCommitments.total}/${slot.maxConcurrent})`
        : `Сигнал ${asset} пропущен: установленный лимит одновременных сделок уже занят (${slot.effectiveOpenCount}/${slot.maxConcurrent})`,
      asset,
      recoveryBranches: slot.branchCommitments?.pendingBranches || 0,
      maxConcurrent: slot.maxConcurrent,
      queueDepth: autoRuntime.signalQueueDepth
    });
    return { ok: false, reason, ...slot };
  }

  function activeTradeReleaseGraceMs(durationSeconds) {
    const durationMs = Math.max(1, Number(durationSeconds) || 60) * 1000;
    return Math.max(3000, Math.min(10000, Math.round(durationMs * 0.1)));
  }

  function dealPricesEqual(deal) {
    const open = optionalFiniteNumber(deal?.openPrice);
    const close = optionalFiniteNumber(deal?.closePrice);
    if (open == null || close == null) return false;
    return Math.abs(open - close) <= Math.max(1e-10, Math.abs(open) * 1e-10);
  }

  function closedDealOutcomeKnown(deal) {
    if (!deal || typeof deal !== 'object') return false;
    if (dealPricesEqual(deal)) return true;
    if (optionalFiniteNumber(deal?.netProfit) != null) return true;
    if (optionalFiniteNumber(deal?.profit ?? deal?.profitAmount ?? deal?.pnl ?? deal?.resultAmount) != null) return true;
    if (typeof deal?.win === 'boolean' || typeof deal?.won === 'boolean') return true;
    const text = String(deal?.outcome || deal?.result || deal?.reason || deal?.state || deal?.status || '').toLowerCase();
    return /win|won|profit|success|loss|lose|lost|failed|return|refund|draw|tie|push|cancel|equal|побед|поражен|убыт|возврат|ничья|отмена/.test(text);
  }

  function dealNetValue(deal) {
    const amount = Math.max(0, finiteNumber(deal?.amount) ?? 0);
    const text = String(deal?.outcome || deal?.result || deal?.status || deal?.reason || deal?.state || '').toLowerCase();
    const explicitNeutral = /return|refund|draw|tie|push|cancel|equal|возврат|ничья|отмена/.test(text);
    // Pocket return/refund often comes as a positive broker `profit` equal to the
    // returned stake. For Martingale it is neutral: repeat the same step, do not reset.
    if (explicitNeutral || dealPricesEqual(deal)) return 0;

    const direct = optionalFiniteNumber(deal?.netProfit);
    if (direct != null) return direct;

    const rawProfit = optionalFiniteNumber(deal?.profit ?? deal?.profitAmount ?? deal?.pnl ?? deal?.resultAmount);
    const payout = optionalFiniteNumber(deal?.payout ?? deal?.profitPercent ?? deal?.percentProfit ?? deal?.signalPayout) ?? 0;
    // Do not use loose substring matching here: the generic broker status
    // "closed" contains "lose" and used to be misclassified as a loss.
    const explicitWin = deal?.win === true || deal?.won === true;
    const explicitLoss = deal?.win === false || deal?.won === false;
    const win = explicitWin || /(?:^|[^a-z])(win|won|profit|success)(?:$|[^a-z])/.test(text);
    const loss = explicitLoss || /(?:^|[^a-z])(loss|lose|lost|failed)(?:$|[^a-z])/.test(text);

    if (loss) return rawProfit != null && rawProfit < 0 ? rawProfit : -amount;
    if (rawProfit != null) {
      // If Pocket sent only the returned stake (profit == amount) without an
      // explicit WIN, treat it as neutral. At 100% payout a real, explicitly
      // confirmed WIN legitimately has netProfit == amount and must reset recovery.
      if (!win && amount > 0 && Math.abs(rawProfit - amount) <= Math.max(0.000001, amount * 0.000001)) return 0;
      if (win || rawProfit > 0) {
        if (amount > 0 && payout > 0) {
          const percent = payout > 1 ? payout / 100 : payout;
          const expectedNet = amount * percent;
          const expectedReturn = amount + expectedNet;
          return Math.abs(rawProfit - expectedReturn) < Math.abs(rawProfit - expectedNet) ? rawProfit - amount : rawProfit;
        }
        return amount > 0 && rawProfit > amount * 1.01 ? rawProfit - amount : rawProfit;
      }
      if (rawProfit < 0) return rawProfit;
    }
    return win ? amount * (payout > 1 ? payout / 100 : payout) : 0;
  }

  function isNeutralDealResult(deal, net = dealNetValue(deal)) {
    if (dealPricesEqual(deal)) return true;
    if (Math.abs(Number(net) || 0) > 0.0000001) return false;
    const text = String(deal?.outcome || deal?.result || deal?.status || deal?.reason || deal?.state || '').toLowerCase();
    const amount = Math.max(0, finiteNumber(deal?.amount) ?? 0);
    const rawProfit = optionalFiniteNumber(deal?.profit ?? deal?.profitAmount ?? deal?.pnl ?? deal?.resultAmount);
    const returnedStakeOnly = amount > 0 && rawProfit != null
      && Math.abs(rawProfit - amount) <= Math.max(0.000001, amount * 0.000001);
    // Pocket Option can close a return/refund/draw with a generic status "closed"
    // while `profit` contains only the returned stake. That is neutral too: keep
    // the same Martingale level and amount instead of advancing or resetting it.
    return returnedStakeOnly || !text || /return|refund|draw|tie|push|cancel|equal|возврат|ничья|отмена/.test(text);
  }

  function currentStreaks(auto = settings.autoTrade || {}) {
    let losses = 0, wins = 0;
    const deals = closedDealsForRisk(auto);
    for (let index = deals.length - 1; index >= 0; index -= 1) {
      const net = dealNetValue(deals[index]);
      if (net < -0.0000001 && wins === 0) losses += 1;
      else if (net > 0.0000001 && losses === 0) wins += 1;
      else if (isNeutralDealResult(deals[index], net)) continue;
      else break;
    }
    return { losses, wins };
  }

  function currentRecoveryStreak(auto = settings.autoTrade || {}) {
    let losses = 0;
    const deals = closedDealsForRecovery(auto);
    const latestDeal = deals[deals.length - 1] || null;
    const latestNet = latestDeal ? dealNetValue(latestDeal) : 0;
    const repeatNeutral = Boolean(latestDeal && isNeutralDealResult(latestDeal, latestNet));
    for (let index = deals.length - 1; index >= 0; index -= 1) {
      const net = dealNetValue(deals[index]);
      if (net < -0.0000001) losses += 1;
      else if (isNeutralDealResult(deals[index], net)) continue;
      else break;
    }
    const explicitStep = latestDeal ? optionalFiniteNumber(latestDeal?.recoveryStep) : null;
    const repeatStep = repeatNeutral
      ? Math.max(0, Math.min(5, explicitStep == null ? losses : Math.floor(explicitStep)))
      : null;
    return { losses, repeatNeutral, repeatStep, latestDeal };
  }

  function baseTradeAmountForAuto(auto) {
    const balance = Math.max(0, finiteNumber(latestState?.account?.balance) ?? 0);
    const amount = auto.amountMode === 'balancePercent'
      ? balance * Math.max(0.01, Number(auto.balancePercent) || 1) / 100
      : Math.max(0.01, Number(auto.amount) || 1);
    return Math.max(0.01, Math.round(amount * 100) / 100);
  }

  function expirationForAuto(auto, signal, asset = null) {
    // applyStrategyExecution has already routed `auto.duration`: base/server strategies
    // carry their own profile expiration; imported/constructor strategies carry the
    // strategy's saved individual expiration.
    return normalizeExpirationSeconds(auto?.duration, 60, asset);
  }

  function assetSupportsExpiration(asset, duration) {
    return expirationSupportForAsset(asset, duration).supported;
  }

  function dealExecutionDurationSeconds(deal, asset = null) {
    const explicit = [
      deal?.duration,
      deal?.signalExpiration,
      deal?.expiration,
      deal?.expirationSeconds,
      deal?.optionDuration,
      deal?.tradeDuration
    ].map(finiteNumber).find((value) => value != null && value > 0);
    let raw = explicit;
    if (raw == null) {
      const opened = finiteNumber(deal?.openTimestamp);
      const closed = finiteNumber(deal?.closeTimestamp);
      if (opened != null && closed != null && closed > opened) raw = closed - opened;
    }
    if (raw == null || raw <= 0) return null;
    return normalizeExpirationSeconds(raw, raw, deal?.asset || asset || null);
  }

  function inheritedRecoveryDuration(auto, fallbackDuration, asset = null, branch = null) {
    // “Follow the original signal” must inherit the expiration of the branch root,
    // not a later next-signal recovery that may have used another strategy profile.
    if (branch?.rootDeal) {
      const rootDuration = dealExecutionDurationSeconds(branch.rootDeal, asset);
      if (rootDuration != null) return rootDuration;
    }
    if (branch?.latestDeal) {
      const branchDuration = dealExecutionDurationSeconds(branch.latestDeal, asset);
      if (branchDuration != null) return branchDuration;
    }
    const deals = closedDealsForRecovery(auto);
    for (let index = deals.length - 1; index >= 0; index -= 1) {
      const deal = deals[index];
      const net = dealNetValue(deal);
      if (isNeutralDealResult(deal, net)) {
        const neutralDuration = dealExecutionDurationSeconds(deal, asset);
        if (neutralDuration != null) return neutralDuration;
        continue;
      }
      if (net >= -0.0000001) break;
      const duration = dealExecutionDurationSeconds(deal, asset);
      if (duration != null) return duration;
      break;
    }
    return fallbackDuration;
  }

  function recoveryContextForAuto(auto, branch = null) {
    const stepCount = Math.min(5, Math.max(0, Number(auto.recoverySteps) || 0));
    const enabled = auto.recoveryMode === 'steps' && stepCount > 0;
    if (!enabled) return { enabled, losses: 0, step: 0, stepCount, active: false, repeatNeutral: false, exhausted: false, config: null, latestDeal: null, pendingCount: 0, branch: null };

    const pending = pendingRecoveryBranches(auto);
    const selected = branch || null;
    if (!selected) {
      const first = pending[0] || null;
      const exhaustedBranch = pending.find((item) => item.exhausted) || null;
      return {
        enabled,
        losses: pending.length,
        step: first?.nextStep || 0,
        stepCount,
        active: pending.length > 0,
        repeatNeutral: first?.repeatNeutral === true,
        exhausted: Boolean(exhaustedBranch),
        config: null,
        latestDeal: first?.latestDeal || null,
        pendingCount: pending.length,
        exhaustedBranch,
        branch: first
      };
    }

    let step = Math.max(0, Math.floor(Number(selected.nextStep) || 0));
    let exhausted = selected.exhausted === true || step > stepCount;
    let resetCycle = selected.resetCycle === true;
    if (exhausted && auto.recoveryAfterMax === 'reset') {
      step = 0;
      exhausted = false;
      resetCycle = true;
    }
    const plan = normalizeRecoveryPlan(auto.recoveryPlan, auto);
    return {
      enabled,
      losses: pending.length,
      step,
      stepCount,
      active: true,
      repeatNeutral: selected.repeatNeutral === true,
      exhausted,
      config: step > 0 && step <= stepCount ? plan[step - 1] : null,
      latestDeal: selected.latestDeal || null,
      pendingCount: pending.length,
      resetCycle,
      branch: selected
    };
  }

  function recoveryExecutionContextForAuto(auto, branch = null) {
    const context = recoveryContextForAuto(auto, branch);
    if (branch) return context;

    // recoveryContextForAuto(null) is an aggregate overview used by status/risk
    // checks. It may expose the next step of the oldest pending branch. A new
    // base trade has no branch ownership yet and must never inherit that step.
    // Otherwise parallel Martingale chains can leak into each other (for example,
    // a fresh base trade is recorded as step 2 and its loss jumps directly to x8).
    return {
      ...context,
      step: 0,
      active: false,
      repeatNeutral: false,
      config: null,
      latestDeal: null,
      resetCycle: false,
      branch: null
    };
  }

  function tradePlanForAuto(auto, signal, asset = null, branch = null) {
    const recovery = recoveryExecutionContextForAuto(auto, branch);
    const branchBaseAmount = optionalFiniteNumber(branch?.baseAmount);
    const baseAmount = branchBaseAmount != null && branchBaseAmount > 0
      ? Math.max(0.01, Math.round(branchBaseAmount * 100) / 100)
      : baseTradeAmountForAuto(auto);
    const multiplier = recovery.step > 0 ? Math.max(1, Number(recovery.config?.multiplier) || 1) : 1;
    const rawAmount = baseAmount * multiplier;
    const configuredMaxAmount = Math.max(0.01, Number(auto.maxAmount) || rawAmount);
    const activePlan = normalizeRecoveryPlan(auto.recoveryPlan, auto).slice(0, Math.min(5, Math.max(0, Number(auto.recoverySteps) || 0)));
    const requiredRecoveryMaxAmount = recovery.enabled && activePlan.length
      ? baseAmount * Math.max(1, ...activePlan.map((step) => Number(step?.multiplier) || 1))
      : baseAmount;
    const maxAmount = Math.max(configuredMaxAmount, baseAmount, recovery.enabled ? requiredRecoveryMaxAmount : 0);
    const amount = Math.max(0.01, Math.round(Math.min(rawAmount, maxAmount) * 100) / 100);
    const baseDuration = expirationForAuto(auto, signal, asset);
    const recoveryDurationMode = String(auto?.recoveryDurationMode || 'strategy_profile');
    const duration = recovery.active
      ? recoveryDurationMode === 'inherit'
        ? inheritedRecoveryDuration(auto, baseDuration, asset, branch)
        : recoveryDurationMode === 'configured' && recovery.step > 0
          ? normalizeExpirationSeconds(recovery.config?.duration, baseDuration, asset)
          : baseDuration
      : baseDuration;
    const globalMinPayout = Math.max(MIN_TRADE_PAYOUT, Math.min(100, Math.max(0, Number(auto.minPayout) || 0)));
    const stepMinPayout = recovery.step > 0
      ? Math.min(100, Math.max(MIN_TRADE_PAYOUT, Number(recovery.config?.minPayout) || MIN_TRADE_PAYOUT))
      : MIN_TRADE_PAYOUT;
    const minPayout = Math.max(globalMinPayout, stepMinPayout);
    return { recovery, baseAmount, multiplier, rawAmount, maxAmount, amount, duration, minPayout, capped: rawAmount > maxAmount + 0.0001 };
  }

  function normalizePayoutValue(value) {
    const raw = finiteNumber(value);
    if (raw == null || raw <= 0) return null;
    const payout = raw <= 1 ? raw * 100 : raw;
    return payout > 0 && payout <= 100 ? payout : null;
  }

  function payoutFreshnessBonus(updatedAt) {
    const ms = Date.parse(updatedAt || '');
    if (!Number.isFinite(ms)) return 0;
    const age = Date.now() - ms;
    if (age < 2 * 60 * 1000) return 12;
    if (age < 5 * 60 * 1000) return 6;
    return 0;
  }

  function isFreshBrokerPayout(updatedAt, maxAgeMs = 20 * 1000) {
    const ms = Date.parse(updatedAt || '');
    return Number.isFinite(ms) && Date.now() - ms >= 0 && Date.now() - ms <= maxAgeMs;
  }

  function isVerifiedCurrentPayoutSource(source, updatedAt, duration = null) {
    const label = String(source || '').toLowerCase();
    const seconds = finiteNumber(duration);
    const isTurbo = seconds != null && seconds > 0 && seconds < 60;

    // Broker/execution proof is the strongest source because it is returned by
    // Pocket after an actual order with the exact asset and expiration.
    if (label.includes('execution') || label.includes('percentprofit') || label.includes('recent_broker')) {
      return isFreshBrokerPayout(updatedAt, 20 * 60 * 1000);
    }

    // IMPORTANT: any mixed source containing `chafor` is NOT official asset-info
    // proof. Previous builds used `chafor+asset_info_min`; because that string
    // contained `asset_info`, the strict guard could accept a high chafor/max
    // candidate and open below the user minPayout. Handle chafor before asset_info
    // and never verify it for turbo trades.
    if (label === 'chafor' || label.endsWith('.chafor') || label.includes('chafor')) {
      return false;
    }

    // Official/current asset-list payout from Pocket (`common.assets_list.payout`),
    // not `max_payout`. This is accepted as a broker payout snapshot.
    if (label.includes('partners_api') || label.includes('asset_info') || label.includes('assets_list') || label.includes('updateassets')) {
      return isFreshBrokerPayout(updatedAt, 2 * 60 * 1000);
    }
    return false;
  }

  function recentBrokerExecutionPayoutCandidates(asset, duration = null) {
    const symbol = String(asset || '').trim();
    if (!symbol) return [];
    const requestedDuration = finiteNumber(duration);
    const now = Date.now();
    const sources = [];
    const addDeal = (deal, source) => {
      if (!deal || String(deal.asset || '') !== symbol) return;
      const payout = normalizePayoutValue(deal.percentProfit ?? deal.profitPercent ?? deal.payout);
      if (payout == null) return;
      const dealDuration = finiteNumber(deal.duration ?? deal.signalExpiration ?? deal.time);
      if (requestedDuration != null && dealDuration != null && Math.abs(Number(dealDuration) - Number(requestedDuration)) > 1) return;
      const at = timestampMs(deal.confirmedAt || deal.closedAt || deal.closeTimestamp || deal.openTimestamp || deal.time || deal.createdAt);
      const age = at ? now - at : 0;
      if (!age || age <= 20 * 60 * 1000) {
        sources.push({ payout, source, trust: 130 - Math.min(30, Math.floor((age || 0) / 60000)), updatedAt: at ? new Date(at).toISOString() : null, verified: true });
      }
    };
    const trades = latestState?.trades || {};
    for (const deal of Array.isArray(trades.openedDeals) ? trades.openedDeals : []) addDeal(deal, 'recent_broker_open.percentProfit');
    for (const deal of Array.isArray(trades.closedDeals) ? trades.closedDeals : []) addDeal(deal, 'recent_broker_closed.percentProfit');
    return sources;
  }

  function currentPayoutForAsset(asset, signal = null, options = {}) {
    const symbol = String(asset || '').trim();
    const market = latestState?.market || {};
    const candidates = [];
    const ignoreSignal = options?.ignoreSignal === true;
    const duration = options?.duration ?? null;
    const add = (value, source, trust = 50, updatedAt = null, verified = false) => {
      const payout = normalizePayoutValue(value);
      if (payout != null) candidates.push({ payout, source, trust: trust + payoutFreshnessBonus(updatedAt), updatedAt, verified });
    };
    const assetInfo = Array.isArray(market.assetList) ? market.assetList.find((item) => String(item?.symbol || '') === symbol) : null;
    const subscription = market.subscriptions?.[symbol] || null;
    const seconds = finiteNumber(duration);
    const isTurbo = seconds != null && seconds > 0 && seconds < 60;

    // Recent real execution facts are used only as a conservative floor. If a
    // 3s asset just opened at 44/53/84%, it must not pass a minPayout=85 on the
    // next Martingale step because chafor/server signal still says 90+.
    for (const item of recentBrokerExecutionPayoutCandidates(symbol, duration)) {
      candidates.push(item);
    }

    if (String(market.asset || '') === symbol) {
      const activeAt = market.payoutUpdatedAt || market.streamUpdatedAt;
      const activeVerified = !isTurbo && isFreshBrokerPayout(activeAt, 20 * 1000);
      add(market.payout, 'active_chart.payout', activeVerified ? 110 : 60, activeAt, activeVerified);
      add(market.percentProfit, 'active_chart.percentProfit', activeVerified ? 112 : 60, activeAt, activeVerified);
      add(market.profitPercent, 'active_chart.profitPercent', activeVerified ? 112 : 60, activeAt, activeVerified);
      add(market.profitability, 'active_chart.profitability', 55, activeAt, false);
    }
    const subscriptionPayoutSource = subscription?.payoutSource ? `subscription.${subscription.payoutSource}` : 'subscription.payout';
    const subscriptionPayoutAt = subscription?.payoutUpdatedAt || subscription?.streamUpdatedAt;
    const subscriptionVerified = isVerifiedCurrentPayoutSource(subscription?.payoutSource, subscriptionPayoutAt, duration);
    const addPayoutCandidates = (items, source, trust, updatedAt, verified) => {
      if (!Array.isArray(items)) return;
      for (const value of items) add(value, source, trust, updatedAt, verified);
    };
    add(subscription?.payout, subscriptionPayoutSource, subscriptionVerified ? 115 : 60, subscriptionPayoutAt, subscriptionVerified);
    add(subscription?.assetInfoPayout, 'subscription.asset_info.payout', 130, subscription?.assetInfoPayoutUpdatedAt || subscriptionPayoutAt, isVerifiedCurrentPayoutSource('asset_info', subscription?.assetInfoPayoutUpdatedAt || subscriptionPayoutAt, duration));
    addPayoutCandidates(subscription?.payoutCandidates, `${subscriptionPayoutSource}.candidate`, 45, subscriptionPayoutAt, false);
    add(subscription?.percentProfit, 'subscription.percentProfit', subscriptionVerified ? 112 : 60, subscriptionPayoutAt, subscriptionVerified);
    add(subscription?.profitPercent, 'subscription.profitPercent', subscriptionVerified ? 112 : 60, subscriptionPayoutAt, subscriptionVerified);
    const assetPayoutSource = assetInfo?.payoutSource ? `asset_list.${assetInfo.payoutSource}` : 'asset_list.payout';
    const assetPayoutAt = assetInfo?.payoutUpdatedAt;
    const assetPayoutVerified = isVerifiedCurrentPayoutSource(assetInfo?.payoutSource, assetPayoutAt, duration);
    const assetPayoutTrust = assetPayoutVerified ? 114 : 55;
    add(assetInfo?.payout, assetPayoutSource, assetPayoutTrust, assetPayoutAt, assetPayoutVerified);
    add(assetInfo?.assetInfoPayout, 'asset_list.asset_info.payout', 130, assetInfo?.assetInfoPayoutUpdatedAt || assetInfo?.payoutUpdatedAt, isVerifiedCurrentPayoutSource('asset_info', assetInfo?.assetInfoPayoutUpdatedAt || assetInfo?.payoutUpdatedAt, duration));
    addPayoutCandidates(assetInfo?.payoutCandidates, `${assetPayoutSource}.candidate`, 45, assetPayoutAt, false);
    add(assetInfo?.percentProfit, 'asset_list.percentProfit', assetPayoutVerified ? 110 : 55, assetInfo?.payoutUpdatedAt, assetPayoutVerified);
    add(assetInfo?.profitPercent, 'asset_list.profitPercent', assetPayoutVerified ? 110 : 55, assetInfo?.payoutUpdatedAt, assetPayoutVerified);
    add(assetInfo?.profitability, 'asset_list.profitability', 50, assetInfo?.payoutUpdatedAt, false);
    if (!ignoreSignal) {
      add(signal?.execution?.payout, 'signal.execution.payout', 60);
      add(signal?.payout, 'signal.payout', 58);
      add(signal?.profitPercent, 'signal.profitPercent', 58);
    }

    if (!candidates.length) return { payout: null, source: 'unknown', updatedAt: null, verified: false, candidates: [] };
    candidates.sort((a, b) => (b.trust - a.trust) || (b.payout - a.payout));
    const trusted = candidates.find((item) => item.trust >= 80) || candidates[0];
    return { payout: trusted.payout, source: trusted.source, updatedAt: trusted.updatedAt || null, verified: trusted.verified === true, candidates };
  }

  function marketAnalysisEligibility(asset, minPayout = MIN_TRADE_PAYOUT) {
    const symbol = String(asset || '').trim();
    const required = Math.max(MIN_TRADE_PAYOUT, Number(minPayout) || 0);
    const assetInfo = Array.isArray(latestState?.market?.assetList)
      ? latestState.market.assetList.find((item) => String(item?.symbol || '') === symbol)
      : null;
    if (!symbol) return { eligible: false, reason: 'asset_missing', payout: null, required };
    if (assetInfo?.active === false) return { eligible: false, reason: 'unavailable_on_pocket', payout: normalizePayoutValue(assetInfo?.payout), required };
    const directPayout = normalizePayoutValue(assetInfo?.assetInfoPayout ?? assetInfo?.payout ?? assetInfo?.percentProfit ?? assetInfo?.profitPercent);
    const payoutInfo = directPayout == null
      ? currentPayoutForAsset(symbol, null, { ignoreSignal: true })
      : {
          payout: directPayout,
          source: assetInfo?.payoutSource ? `asset_list.${assetInfo.payoutSource}` : 'asset_list.payout',
          updatedAt: assetInfo?.payoutUpdatedAt || null,
          verified: true,
          candidates: []
        };
    if (payoutInfo.payout == null) return { eligible: false, reason: 'payout_unknown', payout: null, required, payoutInfo };
    if (Number(payoutInfo.payout) < required) {
      return { eligible: false, reason: 'payout_below_minimum', payout: Number(payoutInfo.payout), required, payoutInfo };
    }
    return { eligible: true, reason: 'ok', payout: Number(payoutInfo.payout), required, payoutInfo };
  }

  function strictExecutionPayoutForAsset(asset, signal = null, duration = null) {
    const info = currentPayoutForAsset(asset, signal, { duration, ignoreSignal: true });
    const verified = info.candidates.filter((item) => item.verified === true);
    if (!verified.length) return { ...info, payout: null, source: 'unverified', verified: false };
    // Strict execution guard is conservative by design: if several verified
    // values are available, use the lowest payout. That prevents a high max/chafor
    // value from letting a 58% real order pass a minPayout=85 filter.
    verified.sort((a, b) => (a.payout - b.payout) || (b.trust - a.trust));
    const safe = verified[0];
    return { payout: safe.payout, source: safe.source, updatedAt: safe.updatedAt || null, verified: true, candidates: info.candidates };
  }

  async function skipSignalByPayout(signalId, asset, payoutInfo, minPayout) {
    await rememberExecutedSignal(signalId);
    const shownPayout = payoutInfo?.payout == null ? 'не определён' : `${Math.round(payoutInfo.payout * 10) / 10}%`;
    const reason = payoutInfo?.payout == null
      ? `Сигнал пропущен: payout ${asset} не подтверждён свежим брокером, минимум задан ${minPayout}%`
      : `Сигнал пропущен: payout ${shownPayout} < ${minPayout}%`;
    await writeAutoStatus({ force: true, enabled: true, state: 'scanning', message: reason, asset, payout: payoutInfo?.payout ?? null, minPayout });
  }


  function customStrategyConfig(strategyId) {
    if (!isConstructorStrategy(strategyId)) return null;
    const item = strategyCatalogRecord(strategyId);
    const rawConfig = item?.config && typeof item.config === 'object' ? item.config : item && typeof item === 'object' ? item : null;
    return rawConfig ? sanitizeCustomStrategyGlobalFields(rawConfig) : null;
  }

  function strategyCatalogRecord(strategyId) {
    const id = String(strategyId || '').trim();
    if (!id) return null;
    const local = Array.isArray(settings?.builderStrategies) ? settings.builderStrategies : [];
    const server = Array.isArray(serverState?.strategies) ? serverState.strategies : [];
    return local.find((entry) => String(entry?.id || entry?.strategy_id || '') === id)
      || server.find((entry) => String(entry?.id || entry?.strategy_id || '') === id)
      || null;
  }

  function isConstructorStrategy(strategyId) {
    const id = String(strategyId || '').trim();
    if (!id) return false;
    if (id.startsWith('custom-') || id.startsWith('draft-')) return true;
    const local = Array.isArray(settings?.builderStrategies) ? settings.builderStrategies : [];
    if (local.some((entry) => String(entry?.id || entry?.strategy_id || '') === id)) return true;
    const item = strategyCatalogRecord(id);
    const source = String(item?.source || item?.strategySource || item?.origin || item?.kind || item?.type || '').toLowerCase();
    return item?.custom === true
      || item?.isCustom === true
      || item?.userStrategy === true
      || ['custom','constructor','builder','imported','personal','user'].includes(source);
  }

  function baseStrategyProfileConfig(strategyId) {
    if (isConstructorStrategy(strategyId)) return null;
    const item = strategyCatalogRecord(strategyId);
    return item?.config && typeof item.config === 'object' ? item.config : item && typeof item === 'object' ? item : null;
  }

  function explicitBaseStrategyDuration(strategyId, signal = null, asset = null) {
    if (isConstructorStrategy(strategyId)) return null;
    const execution = signal?.execution && typeof signal.execution === 'object' ? signal.execution : null;
    const profile = baseStrategyProfileConfig(strategyId);
    const candidates = [
      execution?.duration,
      execution?.expiration,
      signal?.strategyExpiration,
      signal?.expiration,
      signal?.duration,
      profile?.expiration,
      profile?.duration,
      profile?.execution?.duration,
      profile?.execution?.expiration
    ];
    for (const value of candidates) {
      const seconds = finiteNumber(value);
      if (seconds != null && seconds > 0) return normalizeExpirationSeconds(seconds, seconds, asset);
    }
    return null;
  }

  function shouldApplySignalExecutionDuration() {
    // The server may suggest a duration for diagnostics, but execution duration is
    // authoritative in Trading for built-ins and in Constructor for custom profiles.
    return false;
  }

  function applyStrategyExecution(auto, signal) {
    const execution = signal?.execution && typeof signal.execution === 'object' ? signal.execution : null;
    const merged = { ...auto };
    // These three execution controls are global by user design and must survive
    // server suggestions plus custom/imported constructor profile overrides.
    const globalTradeExecution = {
      amountMode: merged.amountMode === 'balancePercent' ? 'balancePercent' : 'fixed',
      amount: merged.amountMode === 'balancePercent' ? 0 : Math.max(0.01, Number(merged.amount) || 1),
      balancePercent: merged.amountMode === 'balancePercent' ? Math.min(10, Math.max(0.01, Number(merged.balancePercent) || 1)) : 0,
      duration: normalizeExpirationSeconds(merged.duration, 60, signal?.asset),
      minPayout: Math.max(MIN_TRADE_PAYOUT, Math.min(100, Math.max(0, Number(merged.minPayout) || 0)))
    };
    const globalRiskExecution = {
      maxAmount: Math.max(0.01, Number(merged.maxAmount) || Number(merged.amount) || 1),
      maxConcurrent: Math.min(20, Math.max(1, Number(merged.maxConcurrent) || 1)),
      takeProfit: Math.max(0, Number(merged.takeProfit) || 0),
      stopLoss: Math.max(0, Number(merged.stopLoss) || 0),
      maxTrades: Math.max(0, Number(merged.maxTrades) || 0),
      maxLossStreak: Math.max(0, Number(merged.maxLossStreak) || 0),
      maxWinStreak: Math.max(0, Number(merged.maxWinStreak) || 0),
      onePerAsset: merged.onePerAsset !== false,
      recoveryMode: String(merged.recoveryMode || 'off'),
      recoveryValue: Math.max(1, Number(merged.recoveryValue) || 2),
      recoverySteps: Math.min(5, Math.max(0, Number(merged.recoverySteps) || 0)),
      recoveryPlan: normalizeRecoveryPlan(merged.recoveryPlan),
      recoveryAfterMax: merged.recoveryAfterMax === 'reset' ? 'reset' : 'stop',
      recoveryFollowSignal: merged.recoveryFollowSignal !== false,
      recoveryStartedAt: merged.recoveryStartedAt || null
    };
    const strategyId = primaryStrategyIdFromAuto(merged, signal);
    const customStrategy = isConstructorStrategy(strategyId);
    const customConfig = customStrategy ? customStrategyConfig(strategyId) : null;
    merged.decisionMode = 'direction_only';
    delete merged.minConfidence;

    if (execution) {
      if (execution.amountMode === 'fixed') {
        merged.amountMode = 'fixed';
        merged.amount = Math.max(0.01, Number(execution.fixedAmount) || merged.amount);
      } else if (execution.amountMode === 'balancePercent') {
        merged.amountMode = 'balancePercent';
        merged.balancePercent = Math.min(10, Math.max(0.01, Number(execution.balancePercent) || merged.balancePercent));
      }
      for (const key of ['cooldown','maxConcurrent','maxTrades','maxLossStreak','maxWinStreak','takeProfit','stopLoss']) {
        if (execution[key] != null && Number.isFinite(Number(execution[key]))) merged[key] = Number(execution[key]);
      }
      if (execution.duration != null && Number.isFinite(Number(execution.duration))) {
        const suggestedDuration = normalizeExpirationSeconds(execution.duration, execution.duration, signal?.asset);
        merged.serverSuggestedDuration = suggestedDuration;
        if (customStrategy) {
          // Imported/constructor profiles ignore server execution duration and use
          // the expiration saved inside their constructor configuration.
          merged.durationSource = 'custom_strategy_profile';
        } else if (shouldApplySignalExecutionDuration(merged, execution, signal)) {
          merged.duration = suggestedDuration;
          merged.expirationMode = 'fixed';
          merged.durationSource = 'server_execution';
        } else {
          merged.duration = normalizeExpirationSeconds(merged.duration, 60, signal?.asset);
          merged.durationSource = String(merged.expirationMode || 'fixed') === 'multiplier' ? 'user_multiplier' : 'user_fixed';
        }
      }
      if (execution.minPayout != null && Number.isFinite(Number(execution.minPayout))) {
        // Server profiles may only make the payout requirement stricter; they can
        // never lower the fixed 75% safety floor.
        merged.minPayout = Math.max(MIN_TRADE_PAYOUT, Number(merged.minPayout) || 0, Number(execution.minPayout) || 0);
      }
      if (execution.onePerAsset != null) merged.onePerAsset = Boolean(execution.onePerAsset);
    }

    // Apply only the constructor analysis/behavior profile. All execution and risk
    // controls are re-applied globally below.
    if (customConfig) {
      merged.period = normalizeAnalysisPeriodSeconds(customConfig.timeframe, 60);
      const direction = String(customConfig.direction || 'both').toLowerCase();
      merged.direction = direction === 'buy' ? 'call' : direction === 'sell' ? 'put' : ['call','put','both'].includes(direction) ? direction : 'both';
      if (customConfig.cooldown != null && Number.isFinite(Number(customConfig.cooldown))) merged.cooldown = Number(customConfig.cooldown);
      merged.candleOffset = normalizeCandleOffset(customConfig.candleOffset, customConfig.candleMode);
      merged.candleMode = merged.candleOffset === 0 ? 'current' : 'closed';
    }

    const profileStrategyId = primaryStrategyIdFromAuto(merged, signal);
    if (!customStrategy) {
      merged.period = effectiveProfilePeriodForAuto(merged, signal);
      merged.cooldown = strategyCooldownForAuto(profileStrategyId, merged);
      merged.candleOffset = strategyCandleOffsetForAuto(profileStrategyId, merged);
      merged.candleMode = merged.candleOffset === 0 ? 'current' : 'closed';
    }

    // Execution source split:
    // - base/server: own explicit TF/EXP profile;
    // - imported/constructor: own saved analysis and individual expiration.
    // Amount, payout floor, limits and Martingale are global for both branches.
    merged.amountMode = globalTradeExecution.amountMode;
    merged.amount = globalTradeExecution.amount;
    merged.balancePercent = globalTradeExecution.balancePercent;
    merged.expirationMode = 'fixed';
    merged.expirationMultiplier = 0;
    if (customStrategy) {
      const customExpiration = finiteNumber(customConfig?.expiration ?? customConfig?.duration ?? customConfig?.execution?.duration ?? customConfig?.execution?.expiration);
      merged.duration = normalizeExpirationSeconds(customExpiration ?? globalTradeExecution.duration, globalTradeExecution.duration, signal?.asset);
      merged.durationSource = customExpiration != null && customExpiration > 0 ? 'custom_strategy_profile' : 'legacy_global_fallback';
    } else {
      merged.duration = effectiveProfileExpirationForAuto(merged, signal, signal?.asset);
      merged.durationSource = explicitBaseStrategyDuration(profileStrategyId, signal, signal?.asset) != null
        ? 'base_strategy_profile'
        : 'base_strategy_fallback';
    }
    merged.minPayout = globalTradeExecution.minPayout;

    merged.maxAmount = globalRiskExecution.maxAmount;
    merged.maxConcurrent = globalRiskExecution.maxConcurrent;
    merged.takeProfit = globalRiskExecution.takeProfit;
    merged.stopLoss = globalRiskExecution.stopLoss;
    merged.maxTrades = globalRiskExecution.maxTrades;
    merged.maxLossStreak = globalRiskExecution.maxLossStreak;
    merged.maxWinStreak = globalRiskExecution.maxWinStreak;
    merged.onePerAsset = globalRiskExecution.onePerAsset;

    merged.recoveryMode = globalRiskExecution.recoveryMode;
    merged.recoveryValue = globalRiskExecution.recoveryValue;
    merged.recoverySteps = globalRiskExecution.recoverySteps;
    merged.recoveryPlan = globalRiskExecution.recoveryPlan;
    merged.recoveryAfterMax = globalRiskExecution.recoveryAfterMax;
    merged.recoveryFollowSignal = globalRiskExecution.recoveryFollowSignal;
    merged.recoveryStartedAt = globalRiskExecution.recoveryStartedAt;
    merged.recoveryAllowConcurrent = true;
    // Martingale state is fully global. Strategy and asset remain attributes of a
    // concrete branch, but they never create separate recovery queues.
    merged.recoveryScopeStrategyId = '';
    merged.recoveryScopeAsset = '';
    merged.recoveryDurationMode = merged.recoveryFollowSignal === true ? 'inherit' : 'strategy_profile';

    // Hard base routing preserves universal same-TF and fixed TF/EXP profiles.
    // Imported/constructor strategies keep their individual expiration. Amount,
    // limits and the shared Martingale branch pool remain global.
    return merged;
  }


  function normalizeStrategyCalibration(value) {
    const empty = createEmptyStrategyCalibration();
    if (!value || typeof value !== 'object') return empty;
    // Version 1 could learn locally from synthetic expiry estimates. Its aggregate
    // profiles cannot be separated back into broker-confirmed and synthetic rows,
    // so reset once and rebuild only from confirmed broker closes.
    if (Number(value.version || 0) < CALIBRATION_VERSION) return empty;
    const processed = Array.isArray(value.processedDealIds)
      ? value.processedDealIds.map((id) => String(id || '')).filter(Boolean).slice(-5000)
      : [];
    const profiles = {};
    for (const [key, profile] of Object.entries(value.profiles || {})) {
      if (!profile || typeof profile !== 'object') continue;
      const strategyId = String(profile.strategyId || '').trim();
      const asset = String(profile.asset || '').trim();
      const period = normalizeProfileTfSeconds(profile.period ?? profile.analysisPeriod ?? profile.signalPeriod ?? profile.duration ?? 60, 60);
      const duration = normalizeProfileTfSeconds(profile.duration ?? profile.expiration ?? period, period);
      const normalizedKey = calibrationKey(strategyId, asset, period, duration);
      if (!CALIBRATED_STRATEGY_IDS.has(strategyId) || !asset) continue;
      profiles[normalizedKey] = {
        ...createCalibrationProfile(strategyId, asset, period, duration),
        ...profile,
        key: normalizedKey,
        strategyId,
        asset,
        period,
        duration,
        total: Math.max(0, Number(profile.total) || 0),
        wins: Math.max(0, Number(profile.wins) || 0),
        losses: Math.max(0, Number(profile.losses) || 0),
        draws: Math.max(0, Number(profile.draws) || 0),
        netProfit: finiteNumber(profile.netProfit) ?? 0,
        payoutBuckets: profile.payoutBuckets || {},
        durationBuckets: profile.durationBuckets || {},
        directionStats: profile.directionStats || {},
        recent: Array.isArray(profile.recent) ? profile.recent.slice(-120) : []
      };
      profiles[normalizedKey].applied = deriveCalibrationProfile(profiles[normalizedKey]);
    }
    return { version: CALIBRATION_VERSION, updatedAt: value.updatedAt || null, processedDealIds: processed, profiles };
  }

  function calibrationKey(strategyId, asset, period = null, duration = null) {
    const [sid, symbol, p, d] = profileKeyParts(strategyId, asset, period, duration);
    return `${sid}::${symbol}::tf${p}::exp${d}`;
  }

  function createCalibrationProfile(strategyId, asset, period = null, duration = null) {
    const [sid, symbol, p, d] = profileKeyParts(strategyId, asset, period, duration);
    const key = calibrationKey(sid, symbol, p, d);
    return {
      key,
      strategyId: sid,
      asset: symbol,
      period: Number(p),
      duration: Number(d),
      total: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      netProfit: 0,
      payoutBuckets: {},
      durationBuckets: {},
      directionStats: {},
      recent: [],
      applied: { active: false, status: 'warming', sample: 0, decisionMode: 'direction_only', minPayout: CALIBRATION_BASELINES[strategyId]?.minPayout || MIN_TRADE_PAYOUT, preferredExpiration: null, disabledUntil: null },
      updatedAt: null
    };
  }

  function updateCalibrationBucket(target, bucket, net) {
    const key = String(bucket || 'unknown');
    const item = target[key] || { total: 0, wins: 0, losses: 0, draws: 0, netProfit: 0 };
    item.total += 1;
    item.netProfit = Number(((finiteNumber(item.netProfit) ?? 0) + (finiteNumber(net) ?? 0)).toFixed(8));
    if (net > 0) item.wins += 1;
    else if (net < 0) item.losses += 1;
    else item.draws += 1;
    target[key] = item;
  }

  function payoutBucket(value) {
    const payout = finiteNumber(value);
    if (payout == null || payout <= 0) return 'unknown';
    if (payout < 65) return '<65';
    if (payout < 75) return '65-74';
    if (payout < 85) return '75-84';
    return '85+';
  }

  function durationBucket(value) {
    const duration = Math.round(finiteNumber(value) ?? 0);
    return duration > 0 ? String(duration) : 'unknown';
  }

  function bucketWinRate(stats) {
    const decisive = Math.max(0, Number(stats?.wins || 0) + Number(stats?.losses || 0));
    return decisive ? Number((Number(stats.wins || 0) / decisive * 100).toFixed(2)) : 0;
  }

  function bestDurationFromBuckets(profile, fallback = null) {
    const entries = Object.entries(profile.durationBuckets || {})
      .map(([duration, stats]) => ({ duration: Number(duration), stats, total: Number(stats?.total || 0), winRate: bucketWinRate(stats), netProfit: finiteNumber(stats?.netProfit) ?? 0 }))
      .filter((item) => Number.isFinite(item.duration) && item.duration > 0 && item.total >= 8);
    if (!entries.length) return fallback;
    entries.sort((a, b) => (b.netProfit - a.netProfit) || (b.winRate - a.winRate) || (b.total - a.total));
    const best = entries[0];
    return best && (best.netProfit > 0 || best.winRate >= 54) ? best.duration : fallback;
  }

  function deriveCalibrationProfile(profile) {
    const baseline = CALIBRATION_BASELINES[profile?.strategyId] || { minPayout: MIN_TRADE_PAYOUT, defaultExpiration: null };
    const total = Math.max(0, Number(profile?.total) || 0);
    const decisive = Math.max(0, Number(profile?.wins || 0) + Number(profile?.losses || 0));
    const winRate = decisive ? Number((Number(profile.wins || 0) / decisive * 100).toFixed(2)) : 0;
    const netProfit = finiteNumber(profile?.netProfit) ?? 0;
    let minPayout = Number(baseline.minPayout) || 70;
    let status = 'warming';
    let strength = 0;
    let disabledUntil = null;

    if (total >= CALIBRATION_MIN_SAMPLE_SOFT) {
      strength = total >= CALIBRATION_MIN_SAMPLE_STRONG ? 2 : 1;
      if (winRate < 42 && netProfit < 0 && total >= 40) {
        status = 'blocked';
        minPayout += 8;
        const previousDisabledUntil = profile?.applied?.disabledUntil;
        disabledUntil = previousDisabledUntil && Date.parse(previousDisabledUntil) > Date.now()
          ? previousDisabledUntil
          : new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      } else if (winRate < 48 || netProfit < 0) {
        status = 'cautious';
        minPayout += strength >= 2 ? 5 : 3;
      } else if (winRate < 54) {
        status = 'selective';
        minPayout += 2;
      } else if (winRate >= 58 && netProfit > 0) {
        status = 'optimized';
        minPayout = Math.max(60, minPayout - (strength >= 2 ? 2 : 0));
      } else {
        status = 'stable';
      }
    }

    const preferredExpiration = total >= CALIBRATION_MIN_SAMPLE_SOFT
      ? bestDurationFromBuckets(profile, null)
      : null;
    return {
      active: total >= CALIBRATION_MIN_SAMPLE_SOFT,
      status,
      strength,
      sample: total,
      winRate,
      netProfit: Number(netProfit.toFixed(8)),
      decisionMode: 'direction_only',
      minPayout: Math.min(95, Math.max(0, Math.round(minPayout))),
      preferredExpiration,
      disabledUntil,
      updatedAt: new Date().toISOString()
    };
  }

  function queueStrategyCalibrationSave() {
    if (strategyCalibrationSaveTimer) return;
    strategyCalibrationSaveTimer = setTimeout(() => {
      strategyCalibrationSaveTimer = null;
      strategyCalibration.updatedAt = new Date().toISOString();
      void safeStorageSet({ [CALIBRATION_STORAGE_KEY]: strategyCalibration });
    }, 900);
  }

  function calibrationNetFromDeal(deal) {
    return dealNetValue(deal);
  }

  function learnStrategyCalibrationFromDeal(deal) {
    if (!deal || typeof deal !== 'object') return false;
    if (!isBrokerConfirmedCalibrationClose(deal)) return false;
    const requestId = meaningfulAutoRequestId(deal.requestId);
    if (!requestId) return false;
    const id = String(deal.id || deal.dealId || requestId).trim();
    const strategyId = String(deal.strategyId || '').trim();
    const asset = String(deal.asset || '').trim();
    if (!id || !CALIBRATED_STRATEGY_IDS.has(strategyId) || !asset) return false;
    if (strategyCalibration.processedDealIds.includes(id)) return false;
    const net = calibrationNetFromDeal(deal);
    const duration = normalizeProfileTfSeconds(deal.signalExpiration ?? deal.duration, deal.duration ?? 60);
    const period = normalizeProfileTfSeconds(deal.signalPeriod ?? deal.analysisPeriod ?? deal.period ?? duration, duration);
    const key = calibrationKey(strategyId, asset, period, duration);
    const profile = strategyCalibration.profiles[key] || createCalibrationProfile(strategyId, asset, period, duration);
    profile.total += 1;
    profile.netProfit = Number(((finiteNumber(profile.netProfit) ?? 0) + (finiteNumber(net) ?? 0)).toFixed(8));
    if (net > 0) profile.wins += 1;
    else if (net < 0) profile.losses += 1;
    else profile.draws += 1;
    const directionScore = finiteNumber(deal.directionScore ?? deal.signalConfidence ?? deal.confidence);
    const payout = finiteNumber(deal.signalPayout ?? deal.percentProfit ?? deal.payout);
    updateCalibrationBucket(profile.payoutBuckets, payoutBucket(payout), net);
    updateCalibrationBucket(profile.durationBuckets, durationBucket(duration), net);
    updateCalibrationBucket(profile.directionStats, String(deal.action || 'unknown'), net);
    profile.recent.push({ id, net, outcome: deal.outcome || null, directionScore, payout, period, duration, action: deal.action || null, closedAt: deal.closeTimestamp || null });
    profile.recent = profile.recent.slice(-120);
    profile.updatedAt = new Date().toISOString();
    profile.applied = deriveCalibrationProfile(profile);
    strategyCalibration.profiles[key] = profile;
    strategyCalibration.processedDealIds.push(id);
    strategyCalibration.processedDealIds = strategyCalibration.processedDealIds.slice(-5000);
    queueStrategyCalibrationSave();
    void safeRuntimeMessage({
      type: 'PT_REPORT_TRADE',
      payload: {
        eventType: 'strategy_calibration_outcome',
        learningVersion: 2,
        dealId: id,
        requestId,
        signalId: deal.signalId || requestId,
        asset,
        action: deal.action || null,
        strategyId,
        source: deal.source || 'autotrade',
        amount: deal.amount ?? null,
        duration: duration ?? null,
        expiration: duration ?? null,
        period: period ?? null,
        analysisPeriod: period ?? null,
        signalPeriod: period ?? null,
        payout: payout ?? null,
        directionScore: directionScore ?? null,
        confidence: directionScore ?? null,
        outcome: deal.outcome || null,
        profit: net,
        openPrice: deal.openPrice ?? null,
        closePrice: deal.closePrice ?? null,
        openTime: deal.openTimestamp ? new Date(Number(deal.openTimestamp) * 1000).toISOString() : null,
        closeTime: deal.closeTimestamp ? new Date(Number(deal.closeTimestamp) * 1000).toISOString() : null,
        accountMode: String(deal.mode || latestState?.account?.mode || (deal.isDemo === true || latestState?.account?.isDemo === true ? 'DEMO' : 'REAL')).toUpperCase(),
        isDemo: deal.isDemo != null ? Boolean(Number(deal.isDemo) || deal.isDemo === true) : (latestState?.account?.isDemo === true || String(latestState?.account?.mode || '').toUpperCase() === 'DEMO'),
        marketRegime: deal.marketRegime || deal.regime || null,
        recoveryStep: Math.max(0, Number(deal.recoveryStep) || 0),
        recoverySteps: Math.max(0, Number(deal.recoverySteps) || 0),
        recoveryMultiplier: finiteNumber(deal.recoveryMultiplier),
        recoveryFollowSignal: deal.recoveryFollowSignal === true,
        parentRequestId: deal.parentRequestId || null,
        profile: profile.applied,
        closedAt: deal.closeTimestamp ? new Date(Number(deal.closeTimestamp) * 1000).toISOString() : null,
        brokerConfirmed: deal.brokerConfirmed === true,
        brokerUiLive: deal.brokerUiLive === true,
        synthetic: false,
        executionSource: deal.executionSource || null,
        officialApi: deal.officialApi === true,
        closeConfirmationSource: deal.closeConfirmationSource || null
      }
    }, 8000).catch(() => null);
    return true;
  }

  async function updateStrategyCalibrationFromState(_state) {
    const closed = mergedRobotClosedDeals().filter(isBrokerConfirmedCalibrationClose);
    if (!closed.length) return;
    let changed = false;
    for (const deal of closed.filter(isRobotTradeDeal).slice(-250)) {
      if (learnStrategyCalibrationFromDeal(deal)) changed = true;
    }
    if (changed) queueStrategyCalibrationSave();
  }

  function calibrationProfileFor(strategyId, asset, period = null, duration = null) {
    if (!CALIBRATED_STRATEGY_IDS.has(String(strategyId || ''))) return null;
    const p = normalizeProfileTfSeconds(period ?? duration ?? 60, 60);
    const d = normalizeProfileTfSeconds(duration ?? p, p);
    const exact = strategyCalibration.profiles[calibrationKey(strategyId, asset, p, d)] || null;
    const legacy = strategyCalibration.profiles[`${String(strategyId || '').trim()}::${String(asset || '').trim()}`] || null;
    const profile = exact || legacy;
    if (!profile?.applied) return profile ? { ...profile, applied: deriveCalibrationProfile(profile) } : null;
    return profile;
  }

  function calibrationPayloadFor(asset, strategyIds, auto = null) {
    const ids = Array.isArray(strategyIds) ? strategyIds : [];
    return ids
      .map((strategyId) => {
        const period = effectiveProfilePeriodForStrategy(strategyId, auto?.period ?? settings.autoTrade?.period ?? settings.period ?? 60, auto || settings.autoTrade || {});
        const duration = effectiveProfileExpirationForAuto({ ...(auto || settings.autoTrade || {}), strategyId, strategyIds: [strategyId], period }, { strategyId, period }, asset);
        return calibrationProfileFor(strategyId, asset, period, duration);
      })
      .filter((profile) => profile?.applied?.active)
      .map((profile) => ({
        strategyId: profile.strategyId,
        asset: profile.asset,
        sample: profile.applied.sample,
        status: profile.applied.status,
        winRate: profile.applied.winRate,
        decisionMode: 'direction_only',
        minPayout: profile.applied.minPayout,
        preferredExpiration: profile.applied.preferredExpiration,
        period: profile.period ?? null,
        duration: profile.duration ?? null,
        disabledUntil: profile.applied.disabledUntil || null
      }));
  }

  function applyStrategyCalibration(auto, signal, asset, strategyId, payout) {
    const period = effectiveProfilePeriodForStrategy(strategyId, signal?.period ?? auto?.period ?? settings.period ?? 60, auto);
    const duration = effectiveProfileExpirationForAuto({ ...auto, strategyId, strategyIds: [strategyId], period }, signal, asset);
    const profile = calibrationProfileFor(strategyId, asset, period, duration);
    const applied = profile?.applied;
    // The server is authoritative for payout/cooldown and mature toxic-segment
    // protection. The extension only displays local outcome telemetry and never
    // adds a second score threshold or blocks a valid BUY/SELL decision.
    const serverApplied = signal?.calibrationApplied && typeof signal.calibrationApplied === 'object'
      ? { ...signal.calibrationApplied, active: true, serverAuthoritative: true, decisionMode: 'direction_only' }
      : applied?.active ? { ...applied, telemetryOnly: true, decisionMode: 'direction_only' } : null;
    return { auto, signal, profile, applied: serverApplied, block: false };
  }

  function isBrokerDealStillOpen(deal, auto) {
    if (!deal || deal.closeTimestamp || deal.status === 'closed' || deal.outcome && deal.outcome !== 'open') return false;
    const brokerOffset = finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0;
    const nowSec = Date.now() / 1000 + brokerOffset;
    const expiry = finiteNumber(deal.expirationTimestamp);
    if (expiry && expiry > 1_000_000_000) return nowSec <= expiry + 45;
    const opened = finiteNumber(deal.openTimestamp);
    const rawDuration = finiteNumber(deal.duration);
    const duration = rawDuration && rawDuration > 0 && rawDuration <= 86400
      ? normalizeExpirationSeconds(rawDuration, rawDuration, deal?.asset)
      : normalizeExpirationSeconds(auto?.duration || auto?.period, 60, deal?.asset);
    if (opened && opened > 1_000_000_000) return nowSec <= opened + duration + 60;
    return true;
  }

  async function stopAutoTradingByRisk(message, extra = {}) {
    settings = mergeSettings({
      ...settings,
      autoTrade: { ...settings.autoTrade, enabled: false, sessionStartedAt: null }
    });
    // A risk stop is a hard execution barrier. Signals already queued by the
    // WebSocket must not survive long enough to open another deal, and a pending
    // follow-recovery timer must not recreate a Martingale step after the stop.
    resetSignalExecutionPipeline('risk_stop');
    if (autoRuntime.followRecoveryDrainTimer) clearTimeout(autoRuntime.followRecoveryDrainTimer);
    autoRuntime.followRecoveryDrainTimer = null;
    autoRuntime.followRecoveryRetryAfterByScope.clear();
    autoRuntime.recoveryBranchClaims.clear();
    closeSignalSocket('risk_stop');
    await safeStorageSet({ poBridgeSettings: settings });
    await writeAutoStatus({ force: true, enabled: false, state: 'stopped', message, ...extra });
  }

  function martingaleStopReasonForAuto(auto = settings.autoTrade || {}) {
    if (auto?.enabled !== true
      || auto?.recoveryMode !== 'steps'
      || Number(auto?.recoverySteps) <= 0
      || auto?.recoveryAfterMax === 'reset') return '';
    const context = recoveryContextForAuto(globalRecoveryView(auto));
    if (!context.exhausted) return '';
    return `Мартингейл завершён: одна из веток прошла ${context.stepCount} шага без результата. Автоторговля остановлена.`;
  }


  function dealRecoveryAction(deal) {
    const action = String(deal?.action || deal?.direction || '').toLowerCase();
    if (action === 'call' || action === 'buy') return 'call';
    if (action === 'put' || action === 'sell') return 'put';
    const command = finiteNumber(deal?.command);
    if (command === 0) return 'call';
    if (command === 1) return 'put';
    return null;
  }

  function followRecoveryCandidates() {
    const baseAuto = { ...DEFAULT_SETTINGS.autoTrade, ...(settings.autoTrade || {}) };
    if (!baseAuto.enabled || !isConnected() || baseAuto.recoveryMode !== 'steps' || Number(baseAuto.recoverySteps) <= 0 || baseAuto.recoveryFollowSignal !== true) return [];

    const branches = pendingRecoveryBranches(globalRecoveryView(baseAuto));
    const candidates = [];
    for (const branch of branches) {
      const latestDeal = branch.latestDeal || branch.rootDeal;
      const rootDeal = branch.rootDeal || latestDeal;
      const strategyId = String(branch.strategyId || rootDeal?.strategyId || latestDeal?.strategyId || '').trim();
      const asset = String(branch.asset || rootDeal?.asset || latestDeal?.asset || '').trim();
      const action = branch.action || dealRecoveryAction(rootDeal) || dealRecoveryAction(latestDeal);
      if (!asset || !action) continue;
      const period = rootDeal?.signalPeriod ?? rootDeal?.period ?? strategyAnalysisPeriod(strategyId, baseAuto);
      const seed = { strategyId, period, asset, action };
      const auto = applyStrategyExecution(baseAuto, seed);
      const recovery = recoveryContextForAuto(globalRecoveryView(auto), branch);
      const timestamp = Number(latestDeal?.closeTimestamp || latestDeal?.openTimestamp || branch.updatedAt || 0);
      candidates.push({ auto, recovery, branch, deal: latestDeal, rootDeal, asset, action, strategyId, period, timestamp, scopeKey: recoveryScopeKeyForAuto(auto, branch) });
    }
    return candidates.sort((a, b) => (a.branch.createdAt - b.branch.createdAt) || (a.timestamp - b.timestamp));
  }

  const FOLLOW_RECOVERY_DISPATCH_THROTTLE_MS = 250;
  const FOLLOW_RECOVERY_RETRY_STORAGE_KEY = 'ptFollowRecoveryRetriesV1';
  const MAX_DEFINITIVE_FOLLOW_RECOVERY_RETRIES = 3;

  function followRecoveryRetryAttempts() {
    try {
      const value = JSON.parse(sessionStorage.getItem(FOLLOW_RECOVERY_RETRY_STORAGE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function followRecoveryRetryAttempt(scopeKey) {
    const key = String(scopeKey || '').trim();
    return key ? Math.max(0, Math.floor(Number(followRecoveryRetryAttempts()[key]) || 0)) : 0;
  }

  function setFollowRecoveryRetryAttempt(scopeKey, attempt) {
    const key = String(scopeKey || '').trim();
    if (!key) return;
    const attempts = followRecoveryRetryAttempts();
    const normalized = Math.max(0, Math.floor(Number(attempt) || 0));
    if (normalized > 0) attempts[key] = normalized;
    else delete attempts[key];
    try { sessionStorage.setItem(FOLLOW_RECOVERY_RETRY_STORAGE_KEY, JSON.stringify(attempts)); } catch {}
  }

  function scheduleDefinitiveFollowRecoveryRetry(scopeKey) {
    const current = followRecoveryRetryAttempt(scopeKey);
    if (current >= MAX_DEFINITIVE_FOLLOW_RECOVERY_RETRIES) return false;
    setFollowRecoveryRetryAttempt(scopeKey, current + 1);
    autoRuntime.followRecoveryRetryAfterByScope.set(scopeKey, Date.now() + 5000);
    setTimeout(() => void maybeRunFollowSignalRecovery('definitive_non_open_retry'), 5100);
    return true;
  }

  function scheduleFollowRecoveryDrain(reason = 'next_recovery_scope', minimumDelayMs = 0) {
    if (!settings.autoTrade?.enabled) return;
    const elapsed = Date.now() - Number(autoRuntime.followRecoveryLastAttemptAt || 0);
    const delay = Math.max(15, Number(minimumDelayMs) || 0, FOLLOW_RECOVERY_DISPATCH_THROTTLE_MS - elapsed + 10);
    if (autoRuntime.followRecoveryDrainTimer) clearTimeout(autoRuntime.followRecoveryDrainTimer);
    autoRuntime.followRecoveryDrainTimer = setTimeout(() => {
      autoRuntime.followRecoveryDrainTimer = null;
      void maybeRunFollowSignalRecovery(reason).catch(() => null);
    }, delay);
  }

  async function maybeRunFollowSignalRecovery(reason = 'state_update') {
    if (!settings.autoTrade?.enabled || !isConnected()) return false;
    const riskStopReason = martingaleStopReasonForAuto(settings.autoTrade || {});
    if (riskStopReason) {
      await stopAutoTradingByRisk(riskStopReason);
      return false;
    }
    const now = Date.now();
    const elapsed = now - Number(autoRuntime.followRecoveryLastAttemptAt || 0);
    if (elapsed < FOLLOW_RECOVERY_DISPATCH_THROTTLE_MS) {
      scheduleFollowRecoveryDrain(reason, FOLLOW_RECOVERY_DISPATCH_THROTTLE_MS - elapsed + 10);
      return false;
    }
    const candidate = followRecoveryCandidates().find((item) => {
      if (Number(autoRuntime.followRecoveryRetryAfterByScope.get(item.scopeKey) || 0) > now) return false;
      if (autoRuntime.followRecoveryRunningScopes.has(item.scopeKey) || recoveryBranchIsBusy(item.branch)) return false;
      const slot = autoTradeSlotState(item.auto, item.asset, item.scopeKey);
      // Follow mode is pinned to the original asset and branch. It may wait for
      // that asset, but it must never migrate the recovery step to another market.
      // Only a full deal slot or the same branch already running blocks dispatch.
      return !slot.concurrentBusy && !slot.recoveryBusy;
    });
    if (!candidate) return false;

    const dealKey = String(candidate.deal?.requestId || candidate.deal?.id || candidate.deal?.dealId || candidate.timestamp || 'deal')
      .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
    const baseSignalId = `pt_follow_${dealKey}_s${Math.max(0, Number(candidate.recovery.step) || 0)}`;
    const retryAttempt = followRecoveryRetryAttempt(candidate.scopeKey);
    const signalId = retryAttempt > 0 ? `${baseSignalId}_retry${retryAttempt}` : baseSignalId;
    if (autoRuntime.executedSignals.has(signalId)) return false;

    autoRuntime.followRecoveryRunning = true;
    autoRuntime.followRecoveryRunningScopes.add(candidate.scopeKey);
    autoRuntime.followRecoveryLastAttemptAt = now;
    autoRuntime.followRecoveryLastAnchorKey = signalId;
    try {
      const syntheticSignal = {
        signalId,
        asset: candidate.asset,
        action: candidate.action,
        strategyId: candidate.strategyId,
        directionScore: 100,
        reason: 'martingale_follow_signal',
        period: candidate.period ?? candidate.rootDeal?.signalPeriod ?? candidate.rootDeal?.period ?? candidate.auto?.period ?? settings.period ?? 60,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        recoveryFollow: true,
        recoveryFollowReason: reason,
        parentRequestId: meaningfulAutoRequestId(candidate.deal?.requestId) || candidate.branch?.latestDealKey || null,
        recoveryBranchRootId: candidate.branch?.rootKey || null
      };
      await processServerSignal(syntheticSignal);
      return true;
    } finally {
      autoRuntime.followRecoveryRunningScopes.delete(candidate.scopeKey);
      autoRuntime.followRecoveryRunning = autoRuntime.followRecoveryRunningScopes.size > 0;
      if (settings.autoTrade?.enabled) scheduleFollowRecoveryDrain('next_recovery_scope');
    }
  }

  function resolveFollowRecoveryAsset(auto, branch, preferredAsset, signal, tradePlan) {
    const scopeKey = recoveryScopeKeyForAuto(auto, branch);
    const required = Math.max(MIN_TRADE_PAYOUT, Number(tradePlan?.minPayout) || 0);
    const preferred = String(preferredAsset || branch?.asset || '').trim();
    const evaluate = (symbol) => {
      const assetInfo = Array.isArray(latestState?.market?.assetList)
        ? latestState.market.assetList.find((item) => String(item?.symbol || '') === String(symbol || ''))
        : null;
      if (assetInfo?.active === false) return { asset: symbol, eligible: false, reason: 'unavailable_on_pocket', payoutInfo: null };
      const support = expirationSupportForAsset(symbol, tradePlan.duration);
      if (!support.supported) return { asset: symbol, eligible: false, reason: support.reason, payoutInfo: null };
      const payoutInfo = strictExecutionPayoutForAsset(symbol, signal, tradePlan.duration);
      return {
        asset: symbol,
        eligible: payoutInfo.payout != null && payoutInfo.payout >= required,
        reason: payoutInfo.payout == null ? 'payout_unknown' : payoutInfo.payout < required ? 'payout_below_minimum' : 'ok',
        payoutInfo
      };
    };

    const preferredResult = preferred ? evaluate(preferred) : null;
    // Follow mode is intentionally strict: it never migrates a Martingale branch
    // to another selected asset. If the original asset/payout is unavailable, the
    // same branch waits and retries instead of silently changing market exposure.
    if (preferredResult) return { ...preferredResult, switched: false, original: preferredResult, scopeKey };
    return { asset: preferred, eligible: false, reason: 'original_asset_missing', switched: false, original: null, scopeKey };
  }

  function recoveryPayoutRejectMessage(asset, result, minPayout) {
    const original = result?.original || {};
    const payout = original?.payoutInfo?.payout;
    let detail;
    if (original.reason === 'unavailable_on_pocket') {
      detail = `исходный актив ${asset || 'не определён'} недоступен на Pocket Option`;
    } else if (original.reason && original.reason !== 'payout_unknown' && original.reason !== 'payout_below_minimum') {
      detail = String(original.reason);
    } else if (payout == null) {
      detail = `payout ${asset || 'исходного актива'} не подтверждён свежими данными брокера`;
    } else {
      detail = `payout ${asset || 'исходного актива'} ${Math.round(payout * 10) / 10}% < ${minPayout}%`;
    }
    return `Шаг Мартингейла ожидает исходный актив: ${detail}`;
  }

  async function processServerSignal(signal) {
    const followRecovery = signal?.recoveryFollow === true;
    const baseAuto = { ...DEFAULT_SETTINGS.autoTrade, ...(settings.autoTrade || {}) };
    const incomingStrategyId = String(signal?.strategyId || '').trim();
    if (!followRecovery && incomingStrategyId && !strategyCompatibleWithGlobalExecution(incomingStrategyId, baseAuto)) {
      await writeAutoStatus({
        force: true,
        enabled: Boolean(baseAuto.enabled),
        state: 'waiting',
        message: 'Стратегия пропущена: её индивидуальные TF анализа и экспирация несовместимы с базовым режимом',
        strategyId: incomingStrategyId,
        period: baseAuto.period,
        duration: baseAuto.duration
      });
      return;
    }
    let auto = applyStrategyExecution(baseAuto, signal);
    const signalId = String(signal?.signalId || '').trim();
    let asset = String(signal?.asset || '').trim();
    const action = signal?.action === 'call' || signal?.action === 'put' ? signal.action : null;
    const strategyId = String(signal?.strategyId || '').trim();
    if (!auto.enabled || !isConnected() || !signalId || !asset || !action) return;
    if (autoRuntime.executedSignals.has(signalId)) return;
    if (!followRecovery && !signalConfigurationIsCurrent(signal)) {
      await discardServerSignalSilently(signal, 'old_config');
      return;
    }
    if (!followRecovery && (signalExpired(signal) || !signalIsLatestForKey(signal))) {
      await discardServerSignalSilently(signal, signalExpired(signal) ? 'expired' : 'replaced');
      return;
    }
    if (!followRecovery && !strategyAvailable(strategyId)) return;
    const selected = selectedAutotradeAssets();
    if ((!followRecovery && !selected.includes(asset)) || (followRecovery && !selected.length)) return;
    const selectedAllowedStrategyIds = selectedStrategyIds(auto);
    const signalStrategyIds = [...new Set([strategyId, ...(Array.isArray(signal?.sourceStrategyIds) ? signal.sourceStrategyIds : [])].filter(Boolean))];
    // Martingale follow-up inherits the strategyId recorded on
    // the original broker deal. Built-in strategy aliases can differ from the
    // currently selected public strategy id (for example builtin-otc may be
    // reported as builtin-trend). Do not reject an already active recovery chain
    // because of that alias mismatch; otherwise normal signals remain blocked by
    // recoveryContext.step > 0 and the robot appears to stop after several losses.
    if (!followRecovery && selectedAllowedStrategyIds.length && !signalStrategyIds.some((id) => selectedAllowedStrategyIds.includes(id))) return;
    if (!followRecovery && auto.direction === 'call' && action !== 'call') return;
    if (!followRecovery && auto.direction === 'put' && action !== 'put') return;
    if (!followRecovery) {
      const cooldownSeconds = strategyCooldownForAuto(strategyId, auto);
      const cooldownKey = `${strategyId}|${asset}`;
      const lastTradeAt = Number(autoRuntime.lastTradeAtByAsset.get(cooldownKey) || 0);
      if (cooldownSeconds > 0 && Date.now() - lastTradeAt < cooldownSeconds * 1000) {
        await rememberExecutedSignal(signalId);
        return;
      }
    }

    const payoutInfo = currentPayoutForAsset(asset, signal);
    const payout = payoutInfo.payout ?? 0;
    const calibration = followRecovery
      ? { auto, signal, profile: null, applied: null, block: false }
      : applyStrategyCalibration(auto, signal, asset, strategyId, payout);
    if (calibration.block) {
      await rememberExecutedSignal(signalId);
      await writeAutoStatus({ force: true, enabled: true, state: 'scanning', message: calibration.reason || 'Сигнал пропущен адаптивной калибровкой', asset, directionScore: signal.directionScore ?? signal.confidence ?? null, calibration: calibration.applied || null, durationSource: auto.durationSource || null, serverSuggestedDuration: auto.serverSuggestedDuration || null });
      return;
    }
    auto = calibration.auto || auto;
    const executionSignal = calibration.signal || signal;

    const delta = safeProfitDelta();
    const streaks = currentStreaks(auto);
    const globalRecoveryAuto = globalRecoveryView(auto);
    const globalRecoveryContext = recoveryContextForAuto(globalRecoveryAuto);
    if (!followRecovery && auto.recoveryFollowSignal === true && globalRecoveryContext.active) {
      // Existing branches are continued by synthetic follow signals. A normal
      // signal may still open a new base branch when maxConcurrent leaves capacity.
      void maybeRunFollowSignalRecovery('incoming_signal_with_active_chain').catch(() => null);
    }
    if (globalRecoveryContext.exhausted && auto.recoveryAfterMax !== 'reset') {
      await stopAutoTradingByRisk(`Мартингейл завершён: одна из веток прошла ${globalRecoveryContext.stepCount} шага без результата. Автоторговля остановлена.`);
      return;
    }
    if (Number(auto.maxLossStreak) > 0 && streaks.losses >= Number(auto.maxLossStreak)) {
      await stopAutoTradingByRisk(`Стоп после ${streaks.losses} убытков подряд`); return;
    }
    if (Number(auto.takeProfit) > 0 && delta >= Number(auto.takeProfit)) {
      await stopAutoTradingByRisk('Take Profit достигнут', { pnl: delta });
      return;
    }
    if (Number(auto.stopLoss) > 0 && delta <= -Math.abs(Number(auto.stopLoss))) {
      await stopAutoTradingByRisk('Stop Loss достигнут', { pnl: delta });
      return;
    }

    const access = await safeRuntimeMessage({ type: 'PO_GET_ACCESS_STATE' }, 20000).catch(() => null);
    // This is only a fast cached pre-check. A slow service-worker/server response is
    // not a trading prohibition; the authoritative permit request below has its own
    // extended timeout and performs the final access decision.
    if (access?.ok === true && access?.limits?.autoTrading === false) {
      await writeAutoStatus({ force: true, enabled: true, state: 'blocked', message: access?.error || 'Автоторговля недоступна для текущего доступа' });
      return;
    }
    reconcileActiveAutoTrades();
    const closedSessionDeals = closedDealsForRisk(auto);
    const openedSessionDeals = (Array.isArray(latestState?.trades?.openedDeals) ? latestState.trades.openedDeals : []).filter((deal) => isAutoDealForSession(deal, auto));
    const sessionTradeCount = closedSessionDeals.length + openRobotTradeSlotCount(auto) + autoRuntime.inFlightSignalIds.size;
    if (Number(auto.maxTrades) > 0 && sessionTradeCount >= Number(auto.maxTrades)) {
      await stopAutoTradingByRisk('Лимит сделок текущей сессии достигнут', { trades: sessionTradeCount });
      return;
    }

    const requestedBranchRootId = String(executionSignal?.recoveryBranchRootId || signal?.recoveryBranchRootId || '').trim();
    let pendingBranchesNow = pendingRecoveryBranches(globalRecoveryAuto);
    let recoveryBranch = null;
    let recoveryClaimScopeKey = '';
    if (followRecovery) {
      recoveryBranch = selectPendingRecoveryBranch(globalRecoveryAuto, requestedBranchRootId, signalId);
      if (!recoveryBranch) return;
    } else if (auto.recoveryFollowSignal !== true && pendingBranchesNow.length) {
      // In next-signal mode, any incoming strategy may continue the oldest free
      // global branch. Strategy ownership never partitions Martingale state.
      recoveryBranch = selectPendingRecoveryBranch(globalRecoveryAuto, '', signalId);
    }
    if (recoveryBranch) {
      const claim = claimRecoveryBranch(globalRecoveryAuto, recoveryBranch, signalId);
      if (!claim.ok) {
        if (followRecovery) return;
        recoveryBranch = selectPendingRecoveryBranch(globalRecoveryAuto, '', signalId);
        if (recoveryBranch) {
          const retryClaim = claimRecoveryBranch(globalRecoveryAuto, recoveryBranch, signalId);
          if (!retryClaim.ok) recoveryBranch = null;
          else recoveryClaimScopeKey = retryClaim.scopeKey;
        }
      } else {
        recoveryClaimScopeKey = claim.scopeKey;
      }
    }

    let recoveryScopeKey = recoveryBranch ? (recoveryClaimScopeKey || recoveryScopeKeyForAuto(auto, recoveryBranch)) : '';
    let tradePlan = tradePlanForAuto(auto, executionSignal, asset, recoveryBranch);
    let recoveryAssetResolution = null;
    if (followRecovery && recoveryBranch) {
      recoveryAssetResolution = resolveFollowRecoveryAsset(auto, recoveryBranch, asset, executionSignal, tradePlan);
      if (!recoveryAssetResolution.eligible) {
        autoRuntime.followRecoveryRetryAfterByScope.set(recoveryScopeKey, Date.now() + 5000);
        await writeAutoStatus({
          force: true,
          enabled: true,
          state: 'scanning',
          message: recoveryPayoutRejectMessage(asset, recoveryAssetResolution, tradePlan.minPayout),
          asset,
          action,
          recoveryStep: tradePlan.recovery.step,
          minPayout: tradePlan.minPayout,
          recoveryBranches: pendingBranchesNow.length
        });
        setTimeout(() => void maybeRunFollowSignalRecovery('payout_recheck'), 5100);
        releaseRecoveryBranchClaim(recoveryClaimScopeKey, signalId);
        recoveryClaimScopeKey = '';
        return;
      }
      autoRuntime.followRecoveryRetryAfterByScope.delete(recoveryScopeKey);
      asset = recoveryAssetResolution.asset;
    }

    // A branch slot is distinct from an open-deal slot. Base signals may enter only
    // while the number of unresolved/open/pending branches is below maxConcurrent;
    // recovery signals reuse their existing branch slot.
    const slot = await waitForAutoTradeSlot(executionSignal, auto, asset, followRecovery, recoveryScopeKey);
    if (!slot.ok) {
      if (!followRecovery) {
        if (slot.reason === 'expired') await discardServerSignalSilently(executionSignal, 'expired');
        else if (slot.reason === 'superseded') await discardServerSignalSilently(executionSignal, 'replaced');
        else {
          // The signal received a definitive current risk/slot decision. Remember its
          // signalId so a server duplicate cannot execute it later under new conditions.
          await rememberExecutedSignal(signalId);
        }
      }
      releaseRecoveryBranchClaim(recoveryClaimScopeKey, signalId);
      recoveryClaimScopeKey = '';
      return;
    }
    if (!followRecovery && (!signalConfigurationIsCurrent(executionSignal) || !signalIsLatestForKey(executionSignal) || signalExpired(executionSignal))) {
      const expired = signalExpired(executionSignal);
      const superseded = !signalIsLatestForKey(executionSignal);
      await discardServerSignalSilently(executionSignal, expired ? 'expired' : superseded ? 'replaced' : 'old_config');
      releaseRecoveryBranchClaim(recoveryClaimScopeKey, signalId);
      recoveryClaimScopeKey = '';
      return;
    }

    const refreshedClosedDeals = closedDealsForRisk(auto);
    const refreshedOpenedDeals = (Array.isArray(latestState?.trades?.openedDeals) ? latestState.trades.openedDeals : []).filter((deal) => isAutoDealForSession(deal, auto));
    const refreshedTradeCount = refreshedClosedDeals.length + openRobotTradeSlotCount(auto) + autoRuntime.inFlightSignalIds.size;
    if (Number(auto.maxTrades) > 0 && refreshedTradeCount >= Number(auto.maxTrades)) {
      await stopAutoTradingByRisk('Лимит сделок текущей сессии достигнут', { trades: refreshedTradeCount });
      releaseRecoveryBranchClaim(recoveryClaimScopeKey, signalId);
      recoveryClaimScopeKey = '';
      return;
    }

    pendingBranchesNow = pendingRecoveryBranches(globalRecoveryAuto);
    if (recoveryBranch) {
      const revalidated = selectPendingRecoveryBranch(globalRecoveryAuto, recoveryBranch.rootKey, signalId);
      if (!revalidated) {
        releaseRecoveryBranchClaim(recoveryClaimScopeKey, signalId);
        recoveryClaimScopeKey = '';
        return;
      }
      recoveryBranch = revalidated;
      recoveryScopeKey = recoveryScopeKeyForAuto(auto, recoveryBranch);
      tradePlan = tradePlanForAuto(auto, executionSignal, asset, recoveryBranch);
    }

    const reservation = tryReserveAutoTradeSlot(auto, asset, signalId, recoveryScopeKey);
    if (!reservation.ok) {
      if (!followRecovery) await rememberExecutedSignal(signalId);
      if (reservation.reason === 'max_trades') {
        await stopAutoTradingByRisk('Лимит сделок текущей сессии достигнут', { trades: reservation.trades });
      }
      releaseRecoveryBranchClaim(recoveryClaimScopeKey, signalId);
      recoveryClaimScopeKey = '';
      return;
    }
    releaseRecoveryBranchClaim(recoveryClaimScopeKey, signalId);
    recoveryClaimScopeKey = '';

    tradePlan.recovery.pendingCount = pendingBranchesNow.length;
    const executionPeriod = normalizeAnalysisPeriodSeconds(
      executionSignal?.period ?? auto?.period ?? settings.period ?? 60,
      auto?.period ?? settings.period ?? 60
    );
    const { amount, duration } = tradePlan;
    const signalConfidence = finiteNumber(executionSignal?.confidence);
    const branchParentRequestId = recoveryBranch
      ? (meaningfulAutoRequestId(recoveryBranch.latestDeal?.requestId) || recoveryBranch.latestDealKey || recoveryBranch.rootRequestId || null)
      : null;
    let permitReserved = false;
    let executionStarted = false;
    let permitCancellationSent = false;
    const cancelReservedTradePermit = async (cancelReason) => {
      if (!permitReserved || executionStarted) return permitCancellationSent;
      // Disarm first so a throwing status/storage operation cannot submit a
      // second cancellation for the same reservation.
      permitReserved = false;
      permitCancellationSent = true;
      await safeRuntimeMessage({
        type: 'PT_REPORT_TRADE',
        payload: {
          requestId: signalId,
          opened: false,
          cancelledBeforeExecution: true,
          cancelReason: String(cancelReason || 'cancelled_before_execution'),
          error: String(cancelReason || 'cancelled_before_execution'),
          asset,
          action,
          amount,
          duration,
          period: executionPeriod,
          signalPeriod: executionPeriod,
          accountMode: latestState?.account?.mode || (latestState?.account?.isDemo ? 'DEMO' : 'REAL'),
          isDemo: latestState?.account?.isDemo === true || String(latestState?.account?.mode || '').toUpperCase() === 'DEMO',
          strategyId,
          source: 'autotrade',
          recoveryStep: tradePlan.recovery.step,
          recoverySteps: tradePlan.recovery.stepCount,
          recoveryMultiplier: tradePlan.multiplier,
          recoveryScopeStrategyId: auto.recoveryScopeStrategyId || null,
          recoveryScopeAsset: auto.recoveryScopeAsset || null,
          recoveryFollowSignal: followRecovery,
          parentRequestId: branchParentRequestId,
          recoveryBranchRootId: recoveryBranch?.rootKey || null,
          recoveryBranchPendingCount: tradePlan.recovery.pendingCount,
          baseAmount: tradePlan.baseAmount,
          signalConfidence,
          signalPayout: payout || null,
          minPayout: tradePlan.minPayout,
          calibrationApplied: calibration.applied || null
        }
      }).catch(() => null);
      return true;
    };
    try {
      if (tradePlan.recovery.exhausted && auto.recoveryAfterMax !== 'reset') {
        await stopAutoTradingByRisk(`Мартингейл завершён: ветка прошла ${tradePlan.recovery.stepCount} шага без результата. Автоторговля остановлена.`);
        return;
      }
      if (!strategyExecutionDurationCompatible(strategyId, executionPeriod, tradePlan.duration)) {
        await rememberExecutedSignal(signalId);
        await writeAutoStatus({
          force: true,
          enabled: true,
          state: 'blocked',
          message: `Сделка заблокирована: шаг исполнения ${formatDuration(tradePlan.duration)} несовместим со стратегией и TF ${formatDuration(executionPeriod)}`,
          asset,
          strategyId,
          period: executionPeriod,
          duration: tradePlan.duration,
          recoveryStep: tradePlan.recovery.step
        });
        return;
      }
      const expirationSupport = expirationSupportForAsset(asset, tradePlan.duration);
      if (!expirationSupport.supported) {
        await rememberExecutedSignal(signalId);
        await writeAutoStatus({ force: true, enabled: true, state: 'scanning', message: `Сигнал пропущен: ${expirationSupport.reason}`, asset });
        return;
      }
      const executionPayoutInfo = strictExecutionPayoutForAsset(asset, executionSignal, tradePlan.duration);
      if (tradePlan.minPayout > 0 && (executionPayoutInfo.payout == null || executionPayoutInfo.payout < tradePlan.minPayout)) {
        if (followRecovery) {
          autoRuntime.followRecoveryRetryAfterByScope.set(recoveryScopeKey, Date.now() + 5000);
          const lateResolution = { original: { payoutInfo: executionPayoutInfo } };
          await writeAutoStatus({ force: true, enabled: true, state: 'scanning', message: recoveryPayoutRejectMessage(asset, lateResolution, tradePlan.minPayout), asset, action, recoveryStep: tradePlan.recovery.step, minPayout: tradePlan.minPayout, recoveryBranches: tradePlan.recovery.pendingCount });
          setTimeout(() => void maybeRunFollowSignalRecovery('late_payout_recheck'), 5100);
        } else {
          await skipSignalByPayout(signalId, asset, executionPayoutInfo, tradePlan.minPayout);
        }
        return;
      }
      const permissionTimeoutMs = 120000;
      const permission = await safeRuntimeMessage({
        type: 'PO_CHECK_TRADE_ACCESS',
        payload: { requestId: signalId, source: 'autotrade', asset, strategyId, action, amount, duration, period: executionPeriod, analysisPeriod: executionPeriod, accountMode: latestState?.account?.mode || (latestState?.account?.isDemo ? 'DEMO' : 'REAL'), isDemo: latestState?.account?.isDemo === true || String(latestState?.account?.mode || '').toUpperCase() === 'DEMO', recoveryStep: tradePlan.recovery.step, recoverySteps: tradePlan.recovery.stepCount, recoveryMultiplier: tradePlan.multiplier, recoveryScopeStrategyId: auto.recoveryScopeStrategyId || null, recoveryScopeAsset: auto.recoveryScopeAsset || null, recoveryFollowSignal: followRecovery, parentRequestId: branchParentRequestId, recoveryBranchRootId: recoveryBranch?.rootKey || null, recoveryBranchPendingCount: tradePlan.recovery.pendingCount, calibration: calibration.applied || null }
      }, permissionTimeoutMs);
      if (!permission?.ok || permission.allowed === false || permission.duplicate) {
        const reason = String(permission?.reason || permission?.error || '');
        const permissionCode = String(permission?.code || '');
        const transientPermissionFailure = permission?.duplicate !== true
          && (permissionCode === 'RUNTIME_MESSAGE_TIMEOUT'
            || permissionCode === 'RUNTIME_MESSAGE_ERROR'
            || /timeout|temporar|network|fetch|соединен|временно|не ответил/i.test(reason));
        if (!transientPermissionFailure) await rememberExecutedSignal(signalId);
        if (transientPermissionFailure) {
          await writeAutoStatus({
            force: true,
            enabled: true,
            state: 'waiting',
            message: 'Торговое разрешение временно не получено · сигнал не помечен исполненным',
            asset,
            strategyId
          });
          return;
        }
        if (reason.includes('DAILY_TRADE_LIMIT') || /дневн.*лимит|лимит FREE|50.*автосдел/i.test(String(permission?.error || ''))) {
          await stopAutoTradingByRisk(permission?.error || 'Дневной лимит FREE исчерпан. Автоторговля остановлена до активации Trial/Premium или сброса лимита.');
          return;
        }
        await writeAutoStatus({ force: true, enabled: true, state: 'blocked', message: permission?.error || (permission?.duplicate ? 'Сигнал уже исполнен на другом устройстве' : 'Сделка запрещена сервером') });
        return;
      }
      permitReserved = true;
      const postPermitRiskStopReason = martingaleStopReasonForAuto(settings.autoTrade || {});
      if (settings.autoTrade?.enabled !== true || postPermitRiskStopReason) {
        await cancelReservedTradePermit(postPermitRiskStopReason
          ? 'martingale_exhausted_after_permit'
          : 'autotrade_disabled_after_permit');
        if (postPermitRiskStopReason) await stopAutoTradingByRisk(postPermitRiskStopReason);
        return;
      }
      if (!followRecovery
        && (!signalConfigurationIsCurrent(executionSignal)
          || !signalIsLatestForKey(executionSignal)
          || signalExpired(executionSignal))) {
        const expired = signalExpired(executionSignal);
        const superseded = !signalIsLatestForKey(executionSignal);
        await cancelReservedTradePermit(
          expired
            ? 'signal_expired_after_permit'
            : superseded
              ? 'signal_superseded_after_permit'
              : 'signal_configuration_changed_after_permit'
        );
        await discardServerSignalSilently(executionSignal, expired ? 'expired' : superseded ? 'replaced' : 'old_config');
        return;
      }

      executionStarted = true;
      permitReserved = false;
      const result = await executeTradeCommand({
        requestId: signalId,
        executionTicket: permission.executionTicket,
        asset,
        action,
        amount,
        duration,
        source: 'autotrade',
        strategyId,
        signalReason: executionSignal.reason || 'server_signal',
        signalConfidence,
        signalPayout: payout || null,
        minPayout: tradePlan.minPayout,
        currentPayout: executionPayoutInfo.payout ?? null,
        currentPayoutSource: executionPayoutInfo.source || null,
        currentPayoutVerified: executionPayoutInfo.verified === true,
        signalExpiration: duration,
        signalPeriod: executionSignal?.period ?? auto.period ?? null,
        calibrationApplied: calibration.applied || null,
        recoveryStep: tradePlan.recovery.step,
        recoverySteps: tradePlan.recovery.stepCount,
        recoveryMultiplier: tradePlan.multiplier,
        recoveryScopeStrategyId: auto.recoveryScopeStrategyId || null,
        recoveryScopeAsset: auto.recoveryScopeAsset || null,
        recoveryFollowSignal: followRecovery,
        parentRequestId: branchParentRequestId,
        recoveryBranchRootId: recoveryBranch?.rootKey || null,
        recoveryBranchPendingCount: tradePlan.recovery.pendingCount,
        baseAmount: tradePlan.baseAmount
      }, 60000);
      const opened = Boolean(result?.ok && result?.confirmed === true && result?.result?.status === 'success');
      const rawSubmittedAt = Number(result?.result?.sentAt ?? result?.sentAt ?? 0);
      const executionSubmittedAt = Number.isFinite(rawSubmittedAt) && rawSubmittedAt > 0 ? rawSubmittedAt : Date.now();
      await safeRuntimeMessage({
        type: 'PT_REPORT_TRADE',
        payload: {
          requestId: signalId, opened, asset, action, amount, duration, period: executionSignal?.period ?? auto.period ?? null, signalPeriod: executionSignal?.period ?? auto.period ?? null, accountMode: latestState?.account?.mode || (latestState?.account?.isDemo ? 'DEMO' : 'REAL'), isDemo: latestState?.account?.isDemo === true || String(latestState?.account?.mode || '').toUpperCase() === 'DEMO',
          strategyId, source: 'autotrade', recoveryStep: tradePlan.recovery.step, recoverySteps: tradePlan.recovery.stepCount, recoveryMultiplier: tradePlan.multiplier, recoveryScopeStrategyId: auto.recoveryScopeStrategyId || null, recoveryScopeAsset: auto.recoveryScopeAsset || null, recoveryFollowSignal: followRecovery, parentRequestId: branchParentRequestId, recoveryBranchRootId: recoveryBranch?.rootKey || null, recoveryBranchPendingCount: tradePlan.recovery.pendingCount, baseAmount: tradePlan.baseAmount, dealId: result?.result?.dealId || null,
          signalConfidence, signalPayout: executionPayoutInfo.payout || payout || null, minPayout: tradePlan.minPayout, currentPayout: executionPayoutInfo.payout ?? null, currentPayoutSource: executionPayoutInfo.source || null, currentPayoutVerified: executionPayoutInfo.verified === true, calibrationApplied: calibration.applied || null,
          submittedAt: executionSubmittedAt, openedAt: new Date().toISOString(), rawResult: result || null
        }
      }).catch(() => null);
      const awaitingBrokerReconciliation = Boolean(result?.unconfirmed === true || result?.result?.status === 'unconfirmed');
      if (opened) {
        autoRuntime.lastTradeAtByAsset.set(`${strategyId}|${asset}`, Date.now());
        autoRuntime.activeTrades.set(signalId, {
          dealId: String(result?.result?.dealId || '').trim() || null,
          asset,
          action,
          amount,
          duration,
          strategyId,
          recoveryScopeKey,
          recoveryStep: tradePlan.recovery.step,
          recoverySteps: tradePlan.recovery.stepCount,
          recoveryMultiplier: tradePlan.multiplier,
          recoveryScopeStrategyId: auto.recoveryScopeStrategyId || null,
          recoveryScopeAsset: auto.recoveryScopeAsset || null,
          recoveryFollowSignal: followRecovery,
          parentRequestId: branchParentRequestId,
          recoveryBranchRootId: recoveryBranch?.rootKey || null,
          baseAmount: tradePlan.baseAmount,
          openedAt: executionSubmittedAt,
          releaseAt: executionSubmittedAt + Math.max(1, Number(duration) || 60) * 1000 + activeTradeReleaseGraceMs(duration)
        });
        autoRuntime.signalDecisionStats.opened += 1;
        await safeRuntimeMessage({ type: 'PO_RECORD_TRADE_USAGE', payload: { source: 'autotrade', accountMode: latestState?.account?.mode || (latestState?.account?.isDemo ? 'DEMO' : 'REAL'), isDemo: latestState?.account?.isDemo === true || String(latestState?.account?.mode || '').toUpperCase() === 'DEMO' } }).catch(() => null);
        const calibrationLabel = calibration.applied?.active ? ` · калибровка ${calibration.applied.status}` : '';
        const recoveryAssetLabel = recoveryAssetResolution?.switched ? ` · замена актива ${recoveryAssetResolution.original?.asset || recoveryBranch?.asset || ''} → ${asset}` : '';
        await writeAutoStatus({ force: true, enabled: true, state: 'trade', message: `${action === 'call' ? 'BUY' : 'SELL'} ${asset}${tradePlan.recovery.step ? ` · Мартингейл ${tradePlan.recovery.step}/${tradePlan.recovery.stepCount} ×${tradePlan.multiplier}` : ''}${recoveryBranch ? ` · веток осталось ${tradePlan.recovery.pendingCount}` : ''}${followRecovery ? ' · вслед за исходным сигналом' : ''}${recoveryAssetLabel}${calibrationLabel}`, asset, action, directionScore: executionSignal.directionScore ?? executionSignal.confidence ?? null, reason: executionSignal.reason, recoveryStep: tradePlan.recovery.step, recoverySteps: tradePlan.recovery.stepCount, recoveryMultiplier: tradePlan.multiplier, duration, durationSource: auto.durationSource || null, recoveryMode: auto.recoveryMode, calibration: calibration.applied || null });
      } else if (awaitingBrokerReconciliation) {
        autoRuntime.activeTrades.set(signalId, {
          dealId: String(result?.result?.dealId || '').trim() || null,
          asset,
          action,
          amount,
          duration,
          strategyId,
          recoveryScopeKey,
          recoveryStep: tradePlan.recovery.step,
          recoverySteps: tradePlan.recovery.stepCount,
          recoveryMultiplier: tradePlan.multiplier,
          recoveryScopeStrategyId: auto.recoveryScopeStrategyId || null,
          recoveryScopeAsset: auto.recoveryScopeAsset || null,
          recoveryFollowSignal: followRecovery,
          parentRequestId: branchParentRequestId,
          recoveryBranchRootId: recoveryBranch?.rootKey || null,
          baseAmount: tradePlan.baseAmount,
          unconfirmed: true,
          openedAt: executionSubmittedAt,
          releaseAt: executionSubmittedAt + Math.max(1, Number(duration) || 60) * 1000 + activeTradeReleaseGraceMs(duration)
        });
        await writeAutoStatus({ force: true, enabled: true, state: 'waiting', message: `Pocket Option задержал подтверждение ${asset} · ждём сверку сделки с журналом брокера`, asset, recoveryStep: tradePlan.recovery.step });
      } else {
        await writeAutoStatus({ force: true, enabled: true, state: 'error', message: result?.error || result?.result?.error || 'Pocket Option не подтвердил открытие сделки', asset });
      }
      // Normal server signals are one-shot. A synthetic follow-recovery signal may
      // retry only a definitive pre-open rejection, with a fresh requestId and a
      // bounded counter. Ambiguous submissions stay locked until broker settlement.
      if (!followRecovery) {
        await rememberExecutedSignal(signalId);
      } else if (opened || awaitingBrokerReconciliation) {
        await rememberExecutedSignal(signalId);
        setFollowRecoveryRetryAttempt(recoveryScopeKey, 0);
      } else {
        await rememberExecutedSignal(signalId);
        const retryScheduled = scheduleDefinitiveFollowRecoveryRetry(recoveryScopeKey);
        await writeAutoStatus({
          force: true,
          enabled: true,
          state: retryScheduled ? 'waiting' : 'blocked',
          message: retryScheduled
            ? `Pocket Option не открыл шаг Мартингейла · безопасный повтор ${followRecoveryRetryAttempt(recoveryScopeKey)}/${MAX_DEFINITIVE_FOLLOW_RECOVERY_RETRIES} через 5 секунд`
            : 'Pocket Option трижды не открыл шаг Мартингейла. Ветка сохранена и новые сделки для неё заблокированы; проверьте подключение или продолжите цепочку следующим сигналом, выключив «Вслед за исходным сигналом».',
          asset,
          recoveryStep: tradePlan.recovery.step
        });
      }
    } catch (error) {
      const cancelledBeforeExecution = await cancelReservedTradePermit(`pre_execution_error:${String(error?.message || error)}`);
      if (!cancelledBeforeExecution) {
        await safeRuntimeMessage({
          type: 'PT_REPORT_TRADE',
          payload: { requestId: signalId, opened: false, asset, action, accountMode: latestState?.account?.mode || (latestState?.account?.isDemo ? 'DEMO' : 'REAL'), isDemo: latestState?.account?.isDemo === true || String(latestState?.account?.mode || '').toUpperCase() === 'DEMO', strategyId, source: 'autotrade', recoveryStep: tradePlan.recovery.step, recoverySteps: tradePlan.recovery.stepCount, recoveryMultiplier: tradePlan.multiplier, recoveryScopeStrategyId: auto.recoveryScopeStrategyId || null, recoveryScopeAsset: auto.recoveryScopeAsset || null, recoveryBranchRootId: recoveryBranch?.rootKey || null, parentRequestId: branchParentRequestId, recoveryFollowSignal: followRecovery, calibrationApplied: calibration.applied || null, error: String(error?.message || error) }
        }).catch(() => null);
      }
      if (followRecovery) {
        await rememberExecutedSignal(signalId);
        const retryScheduled = scheduleDefinitiveFollowRecoveryRetry(recoveryScopeKey);
        await writeAutoStatus({
          force: true,
          enabled: true,
          state: retryScheduled ? 'waiting' : 'blocked',
          message: retryScheduled
            ? `${String(error?.message || error)} · безопасный повтор шага ${followRecoveryRetryAttempt(recoveryScopeKey)}/${MAX_DEFINITIVE_FOLLOW_RECOVERY_RETRIES} через 5 секунд`
            : `${String(error?.message || error)} · лимит безопасных повторов шага исчерпан; ветка сохранена`,
          asset,
          recoveryStep: tradePlan.recovery.step
        });
      } else {
        await writeAutoStatus({ force: true, enabled: true, state: 'error', message: String(error?.message || error), asset });
      }
    } finally {
      autoRuntime.inFlightAssets.delete(asset);
      autoRuntime.inFlightSignalIds.delete(signalId);
      autoRuntime.inFlightBaseSignals.delete(signalId);
      if (recoveryScopeKey) autoRuntime.inFlightRecoveryScopes.delete(recoveryScopeKey);
      releaseRecoveryBranchClaim(recoveryClaimScopeKey || recoveryScopeKey, signalId);
      recoveryClaimScopeKey = '';
      scheduleSignalDispatcher();
    }
  }

  function normalizeSnapshotCandle(candle) {
    if (!candle || typeof candle !== 'object') return null;
    const time = Math.floor(finiteNumber(candle.time) ?? 0);
    const open = finiteNumber(candle.open), high = finiteNumber(candle.high), low = finiteNumber(candle.low), close = finiteNumber(candle.close);
    if (!time || [open, high, low, close].some((value) => value == null)) return null;
    return { time, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume: finiteNumber(candle.volume) ?? 0, ticks: finiteNumber(candle.ticks) ?? 0 };
  }

  function splitCandlesForSubscription(sub) {
    const period = Math.max(1, Math.floor(finiteNumber(sub?.period) ?? finiteNumber(settings.autoTrade?.period) ?? 60));
    const explicitCurrent = normalizeSnapshotCandle(sub?.currentCandle);
    const items = [...(Array.isArray(sub?.historyItems) ? sub.historyItems : []), ...(Array.isArray(sub?.recentCandles) ? sub.recentCandles : [])];
    const byTime = new Map();
    for (const raw of items) {
      const candle = normalizeSnapshotCandle(raw);
      if (candle) byTime.set(candle.time, candle);
    }
    if (explicitCurrent) byTime.set(explicitCurrent.time, explicitCurrent);

    const brokerOffset = finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0;
    const brokerNow = Math.floor(Date.now() / 1000 + brokerOffset);
    const expectedBucket = Math.floor(brokerNow / period) * period;
    const orderedAll = [...byTime.values()].sort((a, b) => a.time - b.time);
    let current = explicitCurrent;
    if (current) {
      const currentBucket = Math.floor(current.time / period) * period;
      if (currentBucket !== expectedBucket) current = null;
    }
    if (!current && orderedAll.length) {
      const latest = orderedAll[orderedAll.length - 1];
      const latestBucket = Math.floor(latest.time / period) * period;
      if (latestBucket === expectedBucket) current = latest;
    }
    const currentTime = current?.time || 0;
    const closedOrdered = orderedAll.filter((candle) => !currentTime || candle.time < currentTime);

    // Use only the newest continuous price segment. After reconnect Pocket Option can
    // return an older history block from a different broker-time window. Mixing the
    // two segments produces artificial jumps and invalid strategy signals.
    if (!closedOrdered.length) return { closed: [], current, period };
    const continuous = [closedOrdered[closedOrdered.length - 1]];
    const maxGap = Math.max(60, period * 8);
    for (let index = closedOrdered.length - 2; index >= 0; index -= 1) {
      const older = closedOrdered[index];
      const newer = continuous[0];
      const gap = newer.time - older.time;
      const reference = Math.max(Math.abs(newer.open), Math.abs(newer.close), 1e-9);
      const priceJump = Math.abs(older.close - newer.open) / reference;
      if (gap <= 0 || gap > maxGap || priceJump > 0.35) break;
      continuous.unshift(older);
      if (continuous.length >= 5000) break;
    }
    return { closed: continuous, current, period };
  }

  function customRuleAnalysisPeriod(value, basePeriod) {
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

  function customStrategyRequiredTargetPeriods(config, basePeriod) {
    const periods = [normalizeAnalysisPeriodSeconds(basePeriod, 60)];
    for (const rule of Array.isArray(config?.rules) ? config.rules : []) {
      if (!rule || typeof rule !== 'object') continue;
      periods.push(customRuleAnalysisPeriod(rule.timeframe, basePeriod));
    }
    return [...new Set(periods.filter((value) => Number.isFinite(value) && value > 0))];
  }

  function selectedStrategyCandleRequirements(strategyIds, defaultMode, defaultOffset, sourcePeriod = 60, auto = settings.autoTrade || {}) {
    const fallbackOffset = normalizeCandleOffset(defaultOffset, defaultMode);
    const periodMap = {};
    const offsetMap = {};
    let minimumClosedCandles = 60;
    for (const strategyId of strategyIds) {
      const config = customStrategyConfig(strategyId);
      const targetPeriod = strategyAnalysisPeriod(strategyId, auto);
      const offset = strategyCandleOffsetForAuto(strategyId, auto);
      periodMap[strategyId] = targetPeriod;
      offsetMap[strategyId] = offset;
      const targetClosed = offset === -2 ? 61 : 60;
      const requiredTargets = config ? customStrategyRequiredTargetPeriods(config, targetPeriod) : [targetPeriod];
      for (const requiredTarget of requiredTargets) {
        if (requiredTarget < sourcePeriod || requiredTarget % sourcePeriod !== 0) continue;
        const ratio = Math.max(1, requiredTarget / sourcePeriod);
        minimumClosedCandles = Math.max(minimumClosedCandles, Math.ceil((targetClosed + 1) * ratio));
      }
    }
    if (!strategyIds.length) minimumClosedCandles = fallbackOffset === -2 ? 61 : 60;
    return {
      needsCurrent: Object.values(offsetMap).includes(0) || (!strategyIds.length && fallbackOffset === 0),
      minimumClosedCandles: Math.min(5000, minimumClosedCandles),
      requiredHistoryCandles: Math.min(5000, Math.max(180, minimumClosedCandles + 4)),
      periodMap,
      offsetMap
    };
  }


  function isLocalThreeCandleStrategy(strategyId) {
    const config = customStrategyConfig(strategyId);
    const item = strategyCatalogRecord(strategyId);
    return Boolean(config && isThreeCandleStrategyConfig(config, item?.name || item?.title || config?.name));
  }

  function emaSeriesForCandles(candles, period) {
    const source = Array.isArray(candles) ? candles : [];
    const length = Math.max(1, Math.round(Number(period) || 1));
    const alpha = 2 / (length + 1);
    const values = [];
    let ema = null;
    for (const candle of source) {
      const close = finiteNumber(candle?.close);
      if (close == null) { values.push(null); continue; }
      ema = ema == null ? close : (close * alpha + ema * (1 - alpha));
      values.push(ema);
    }
    return values;
  }

  function evaluateThreeCandleEmaSignal(strategyId, asset, sourcePeriod, closedCandles) {
    const config = migrateThreeCandleStrategyConfig(customStrategyConfig(strategyId) || {}, strategyCatalogRecord(strategyId)?.name || '');
    if (!isThreeCandleStrategyConfig(config, config?.name)) return { evaluated: false, signal: null };
    const timeframe = normalizeAnalysisPeriodSeconds(config.timeframe, sourcePeriod);
    if (timeframe !== normalizeAnalysisPeriodSeconds(sourcePeriod, sourcePeriod)) return { evaluated: false, signal: null };
    const spec = config.threeCandleEma || {};
    const count = Math.max(3, Math.round(Number(spec.count) || 3));
    const emaPeriod = Math.max(2, Math.round(Number(spec.currentEmaPeriod) || 14));
    const relation = String(spec.relation || (config.direction === 'put' ? 'below' : 'above')) === 'below' ? 'below' : 'above';
    const requiredDirection = relation === 'below' ? 'red' : 'green';
    const mediumMin = Math.max(0.05, Math.min(0.90, Number(spec.mediumBodyMinRatio) || 0.35));
    const mediumMax = Math.max(mediumMin, Math.min(0.98, Number(spec.mediumBodyMaxRatio) || 0.75));
    const closed = (Array.isArray(closedCandles) ? closedCandles : []).map(normalizeSnapshotCandle).filter(Boolean).sort((a, b) => a.time - b.time);
    if (closed.length < Math.max(emaPeriod + count + 2, 20)) return { evaluated: false, waiting: 'current_history', signal: null };
    const currentEma = emaSeriesForCandles(closed, emaPeriod);
    const start = closed.length - count;
    for (let index = start; index < closed.length; index += 1) {
      const candle = closed[index];
      const ema = currentEma[index];
      if (!candle || !Number.isFinite(ema)) return { evaluated: false, waiting: 'ema14', signal: null };

      const isGreen = candle.close > candle.open;
      const isRed = candle.close < candle.open;
      if (requiredDirection === 'green' ? !isGreen : !isRed) {
        return { evaluated: true, signal: null, reason: 'three_candle_color' };
      }

      const range = Math.max(0, Number(candle.high) - Number(candle.low));
      const body = Math.abs(Number(candle.close) - Number(candle.open));
      const bodyRatio = range > 0 ? body / range : 0;
      if (!(bodyRatio >= mediumMin && bodyRatio <= mediumMax)) {
        return { evaluated: true, signal: null, reason: 'three_candle_medium_body' };
      }

      // The real body (open and close), not the wick, must stay on one side of EMA 14.
      const bodyLow = Math.min(candle.open, candle.close);
      const bodyHigh = Math.max(candle.open, candle.close);
      if (relation === 'above' ? !(bodyLow > ema) : !(bodyHigh < ema)) {
        return { evaluated: true, signal: null, reason: 'three_candle_body_vs_ema14' };
      }
    }

    const last = closed[closed.length - 1];
    const action = relation === 'above' ? 'call' : 'put';
    const ttlSeconds = Math.max(5, Math.min(300, Number(config.signalTtl) || 30));
    const compactId = compactConfigHash(`${strategyId}|${asset}|${timeframe}|${last.time}|${action}`);
    const now = Date.now();
    return {
      evaluated: true,
      signal: {
        signalId: `pt_local_3c_${compactId}_${last.time}`,
        asset,
        action,
        strategyId,
        sourceStrategyIds: [strategyId],
        period: timeframe,
        duration: effectiveProfileExpirationForAuto({ ...(settings.autoTrade || {}), strategyId, strategyIds: [strategyId], period: timeframe }, { strategyId, period: timeframe }, asset),
        directionScore: 100,
        confidence: 100,
        reason: `3 ${requiredDirection === 'green' ? 'зелёные' : 'красные'} свечи со средним телом ${relation === 'above' ? 'выше' : 'ниже'} EMA 14`,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
        _localThreeCandleSignal: true
      }
    };
  }

  function evaluateLocalThreeCandleStrategies(asset, strategyIds, sourcePeriod, closedCandles) {
    const ids = (Array.isArray(strategyIds) ? strategyIds : []).filter(isLocalThreeCandleStrategy);
    if (!ids.length) return { strategyIds: [], evaluated: 0, waiting: 0, signals: 0 };
    let evaluated = 0, waiting = 0, signals = 0;
    for (const strategyId of ids) {
      const result = evaluateThreeCandleEmaSignal(strategyId, asset, sourcePeriod, closedCandles);
      if (result.evaluated) evaluated += 1;
      else waiting += 1;
      if (result.signal) {
        const queued = enqueueServerSignal(result.signal);
        if (queued?.queued || queued?.duplicate) signals += 1;
      }
    }
    return { strategyIds: ids, evaluated, waiting, signals };
  }


  function snapshotFingerprint(candleOffset, period, closed, current, configKey = '') {
    const offset = normalizeCandleOffset(candleOffset);
    const target = offset === 0 ? current : (offset === -2 ? closed[closed.length - 2] : closed[closed.length - 1]);
    if (!target?.time) return '';
    // Every strategy/asset is evaluated once per selected timeframe candle.
    // OHLC/tick changes inside the same candle must not start extra analyses.
    return `${configKey}:${Math.max(1, Number(period) || 60)}:${offset}:${target.time}`;
  }

  function snapshotSourceVersion(period, candleOffset, closed, current, configKey = '') {
    const offset = normalizeCandleOffset(candleOffset);
    const target = offset === 0 ? current : (offset === -2 ? closed[closed.length - 2] : closed[closed.length - 1]);
    return `${configKey}:${Math.max(1, Number(period) || 60)}:${offset}:${target?.time || 0}`;
  }

  function compactConfigHash(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function expectedAnalysisTarget(period, candleOffset) {
    const normalizedPeriod = Math.max(1, Number(period) || 60);
    const brokerOffset = finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0;
    const now = Math.floor(Date.now() / 1000 + brokerOffset);
    const currentBucket = Math.floor(now / normalizedPeriod) * normalizedPeriod;
    const offset = normalizeCandleOffset(candleOffset);
    return offset === 0 ? currentBucket : offset === -2 ? currentBucket - normalizedPeriod * 2 : currentBucket - normalizedPeriod;
  }

  function ensureAnalysisBucket(period, candleOffset, configKey = '') {
    const target = expectedAnalysisTarget(period, candleOffset);
    const key = `${configKey}:${Math.max(1, Number(period) || 60)}:${normalizeCandleOffset(candleOffset)}:${target}`;
    if (autoRuntime.analysisBucketKey !== key) {
      autoRuntime.analysisBucketKey = key;
      autoRuntime.analysisTargetTime = target;
      autoRuntime.analysisCompletedAssets = new Set();
      autoRuntime.analysisQueuedAssets = new Set();
      autoRuntime.analysisFailedAssets = new Set();
      autoRuntime.lastAnalysisStatusSignature = '';
      autoRuntime.analysisCycle += 1;
    }
    return target;
  }

  function currentCandleSettled(current, period) {
    if (!current?.time) return false;
    const normalizedPeriod = Math.max(1, Number(period) || 60);
    // Turbo timeframes (5/10/15/30 sec) must be evaluated as soon as the
    // first tick creates the bucket. Waiting for an extra settle window can
    // keep every selected OTC asset in "waiting for candle" state because
    // the current candle changes very quickly. The snapshot fingerprint still
    // allows only one analysis per bucket, so this does not spam the server.
    if (normalizedPeriod <= 30) return Number(current.ticks || 0) > 0 || current.source === 'ticks' || current.source === 'history-ticks';
    const brokerOffset = finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0;
    const now = Math.floor(Date.now() / 1000 + brokerOffset);
    const settleSeconds = Math.max(1, Math.min(8, Math.round(normalizedPeriod * 0.08)));
    return now - Number(current.time) >= settleSeconds;
  }

  function scheduleSnapshotPublish(force = false, delayMs = 40) {
    if (extensionContextInvalidated || !settings.autoTrade?.enabled) return;
    autoRuntime.snapshotQueuedForce = autoRuntime.snapshotQueuedForce || force;
    if (autoRuntime.snapshotWakeTimer) return;
    autoRuntime.snapshotWakeTimer = setTimeout(() => {
      autoRuntime.snapshotWakeTimer = null;
      const queuedForce = autoRuntime.snapshotQueuedForce;
      autoRuntime.snapshotQueuedForce = false;
      void publishCandleSnapshots(queuedForce);
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function waitForSnapshotSendWindow() {
    const now = Date.now();
    const dueAt = Math.max(Number(autoRuntime.snapshotNextSendAt || 0), Number(autoRuntime.snapshotBackoffUntil || 0));
    if (dueAt > now) await new Promise((resolve) => setTimeout(resolve, dueAt - now));
    const basePaceMs = Math.max(60, Math.min(500, Number(autoRuntime.snapshotBasePaceMs) || 100));
    const paceMs = Math.max(basePaceMs, Math.min(1500, Number(autoRuntime.snapshotSendPaceMs) || basePaceMs));
    autoRuntime.snapshotNextSendAt = Date.now() + paceMs;
    // Yield once between large payloads so Pocket's page, the dashboard and
    // Chrome's service worker stay responsive on low-end computers.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function publishCandleSnapshots(force = false) {
    if (autoRuntime.snapshotPublishing) {
      const lastProgressAt = Number(autoRuntime.snapshotPublishingProgressAt || autoRuntime.snapshotPublishingStartedAt || 0);
      const noProgressFor = Date.now() - lastProgressAt;
      // Total batch duration may legitimately be long on a slow connection. Start a
      // replacement publisher only when there has been no progress beyond one full
      // runtime-message timeout, otherwise two batches could send the same candles.
      if (noProgressFor <= 100000) {
        autoRuntime.snapshotQueuedForce = autoRuntime.snapshotQueuedForce || force;
        return;
      }
      autoRuntime.snapshotPublishing = false;
      autoRuntime.snapshotPublishingStartedAt = 0;
      autoRuntime.snapshotPublishingProgressAt = 0;
    }
    autoRuntime.snapshotPublishing = true;
    autoRuntime.snapshotPublishingStartedAt = Date.now();
    autoRuntime.snapshotPublishingProgressAt = autoRuntime.snapshotPublishingStartedAt;
    try {
      const auto = { ...DEFAULT_SETTINGS.autoTrade, ...(settings.autoTrade || {}) };
      if (!auto.enabled || !isConnected() || !serverStateUsable()) return;
      if (Date.now() < Number(autoRuntime.snapshotBackoffUntil || 0)) return;
      const serverChannelReady = ['online', 'analyzing'].includes(autoRuntime.signalSocketStatus);
      const selectedAll = selectedAutotradeAssets();
      const strategyIds = selectedStrategyIds(auto);
      const candleOffset = strategyIds[0]
        ? strategyCandleOffsetForAuto(strategyIds[0], auto)
        : normalizeCandleOffset(auto.candleOffset, auto.candleMode);
      const defaultMode = candleOffset === 0 ? 'current' : 'closed';

      // Evaluate each strategy from its own source timeframe. A mixed set such as
      // 15s + M1 + M2 + M3 + M5 no longer asks one 15-second chart to synthesize
      // thousands of candles for every higher timeframe.
      const groupMap = new Map();
      for (const strategyId of strategyIds) {
        const period = strategyAnalysisPeriod(strategyId, auto);
        if (!groupMap.has(period)) groupMap.set(period, []);
        groupMap.get(period).push(strategyId);
      }
      const strategyGroups = [...groupMap.entries()]
        .map(([period, ids]) => ({ period: normalizeAnalysisPeriodSeconds(period, 60), strategyIds: ids }))
        .sort((a, b) => a.period - b.period);
      const analysisPeriod = strategyGroups[0]?.period || selectedEffectiveAnalysisPeriod(auto);
      const analysisMinPayout = Math.max(MIN_TRADE_PAYOUT, Number(auto.minPayout) || 0);
      const eligibilityByAsset = new Map(selectedAll.map((asset) => [asset, marketAnalysisEligibility(asset, analysisMinPayout)]));
      const selected = selectedAll.filter((asset) => eligibilityByAsset.get(asset)?.eligible === true);
      const filteredByPayout = selectedAll.filter((asset) => eligibilityByAsset.get(asset)?.reason === 'payout_below_minimum');
      const filteredUnavailable = selectedAll.filter((asset) => eligibilityByAsset.get(asset)?.reason === 'unavailable_on_pocket');
      const filteredUnknownPayout = selectedAll.filter((asset) => eligibilityByAsset.get(asset)?.reason === 'payout_unknown');
      if (!selected.length) {
        if (cacheBridgeControl.fallbackAssets.length || graphSubscriptionManager.enabled) {
          void applyPocketFallbackSubscriptions({
            allAssets: selectedAll,
            fallbackAssets: [],
            fallbackScopes: [],
            periods: strategyGroups.map((group) => group.period),
            primaryPeriod: analysisPeriod,
            historyOffsets: {},
            reason: 'no_assets_above_minimum_payout',
            force: true
          }).catch(() => null);
        }
        await writeAutoStatus({
          enabled: true,
          state: 'scanning',
          message: `Ожидание активов с payout ≥ ${analysisMinPayout}% · ниже минимума ${filteredByPayout.length} · временно недоступны ${filteredUnavailable.length} · payout ещё не получен ${filteredUnknownPayout.length}`
        });
        return;
      }
      const allStrategyPeriods = Object.fromEntries(strategyIds.map((id) => [id, strategyAnalysisPeriod(id, auto)]));
      const allStrategyOffsets = Object.fromEntries(strategyIds.map((id) => [id, strategyCandleOffsetForAuto(id, auto)]));
      const allStrategyCooldowns = Object.fromEntries(strategyIds.map((id) => [id, strategyCooldownForAuto(id, auto)]));
      // The signal server subscription is one immutable configuration. Market
      // snapshots may carry candles from several physical graph periods, but their
      // subscription-facing strategy set / configured TF / configured expiration
      // must remain identical to the active subscription. The per-strategy maps below
      // tell the engine which rules belong to the current physical graph.
      const subscriptionConfiguredPeriod = analysisPeriod;
      const subscriptionPrimaryStrategyId = strategyIds[0] || '';
      const subscriptionConfiguredDuration = subscriptionPrimaryStrategyId
        ? effectiveProfileExpirationForAuto(auto, { strategyId: subscriptionPrimaryStrategyId, period: allStrategyPeriods[subscriptionPrimaryStrategyId] || analysisPeriod })
        : normalizeExpirationSeconds(auto.duration ?? settings.duration ?? 60, 60);
      const strategyMode = effectiveAutoStrategyMode(auto, strategyIds);
      const analysisConfigKey = `${strategyIds.slice().sort().join(',')}|${strategyMode}|p:${JSON.stringify(allStrategyPeriods)}|o:${JSON.stringify(allStrategyOffsets)}`;
      const selectedSetKey = `${selected.length}:${compactConfigHash(selected.slice().sort().join(','))}`;
      const totalScopes = Math.max(1, selected.length * Math.max(1, strategyGroups.length));
      ensureAnalysisBucket(analysisPeriod, candleOffset, `${analysisConfigKey}|assets:${selectedSetKey}|groups:${strategyGroups.map((group) => group.period).join(',')}`);
      const bootstrapPending = autoRuntime.signalSocketStatus === 'analyzing'
        && Number(autoRuntime.signalAnalyzingSince || 0) > 0
        && Number(autoRuntime.lastEngineStatusAt || 0) < Number(autoRuntime.signalAnalyzingSince || 0);
      // A forced pass may resend one bootstrap probe after reconnect, but it must not
      // bypass candle fingerprints for every selected asset. That old behavior was
      // the main source of repeated same-candle floods and rate-limit rejections.
      const allowBootstrapResend = force && bootstrapPending;

      // One progress scope is asset + timeframe. Fingerprints still prevent a
      // higher timeframe from being evaluated more than once per closed candle.
      const nowSweep = Date.now();
      const sweepKey = autoRuntime.analysisBucketKey;
      const completedOrQueued = autoRuntime.analysisCompletedAssets.size + autoRuntime.analysisQueuedAssets.size;
      const hasRetryDue = [...autoRuntime.snapshotRetryAfterByAsset.values()]
        .some((retryAt) => Number(retryAt || 0) <= nowSweep);
      const bucketComplete = totalScopes > 0
        && completedOrQueued >= totalScopes
        && autoRuntime.analysisFailedAssets.size === 0;
      if (!force && autoRuntime.lastSnapshotSweepKey === sweepKey) {
        if (bucketComplete && !hasRetryDue) return;
        const minimumRescanMs = analysisPeriod <= 30 ? 450 : 1200;
        if (!hasRetryDue && nowSweep - Number(autoRuntime.lastSnapshotSweepAt || 0) < minimumRescanMs) return;
      }
      autoRuntime.lastSnapshotSweepKey = sweepKey;
      autoRuntime.lastSnapshotSweepAt = nowSweep;
      const jobs = [];
      let waitingForCurrent = 0;
      let waitingForHistory = 0;

      // Pull all required asset/timeframe candles from the dedicated cache service
      // in one batch. Existing scopes request only the current/changed candle by
      // timestamp, while a first request receives the complete required history.
      const cacheRequests = [];
      const cacheMinimumByScope = new Map();
      const cacheHistoryOffsets = {};
      for (const group of strategyGroups) {
        const requirements = selectedStrategyCandleRequirements(group.strategyIds, defaultMode, candleOffset, group.period, auto);
        const limit = Math.min(5000, Math.max(180, Number(requirements.requiredHistoryCandles) || 180));
        cacheHistoryOffsets[group.period] = Math.max(Number(cacheHistoryOffsets[group.period]) || 0, limit);
        for (const asset of selected) {
          const scope = marketSnapshotKey(asset, group.period);
          cacheMinimumByScope.set(scope, Math.max(40, Number(requirements.minimumClosedCandles) || 40));
          cacheRequests.push({ asset, period: group.period, limit });
        }
      }
      await refreshCacheBridgeSnapshots(cacheRequests, { forceFull: force && cacheBridgeControl.lastSuccessAt === 0, timeoutMs: 15000 });
      const bridgeFallbackScopes = [];
      for (const asset of selected) {
        for (const group of strategyGroups) {
          const scope = marketSnapshotKey(asset, group.period);
          if (!cacheBridgeSnapshotUsable(asset, group.period, cacheMinimumByScope.get(scope) || 40)) {
            bridgeFallbackScopes.push(scope);
          }
        }
      }
      const bridgeFallbackAssets = [...new Set(bridgeFallbackScopes.map((scope) => scope.slice(0, scope.lastIndexOf('|'))).filter(Boolean))];
      const currentFallbackScopes = cacheBridgeControl.fallbackScopes;
      if (bridgeFallbackScopes.length !== currentFallbackScopes.size
          || bridgeFallbackScopes.some((scope) => !currentFallbackScopes.has(scope))) {
        void applyPocketFallbackSubscriptions({
          allAssets: selected,
          fallbackAssets: bridgeFallbackAssets,
          fallbackScopes: bridgeFallbackScopes,
          periods: strategyGroups.map((group) => group.period),
          primaryPeriod: analysisPeriod,
          historyOffsets: cacheHistoryOffsets,
          reason: 'cache_bridge_runtime_fallback'
        }).catch(() => null);
      }

      for (const asset of selected) {
        for (const group of strategyGroups) {
          const sourcePeriod = group.period;
          const groupStrategyIds = group.strategyIds;
          const scope = marketSnapshotKey(asset, sourcePeriod);
          const retryAfterAt = Number(autoRuntime.snapshotRetryAfterByAsset.get(scope) || 0);
          if (retryAfterAt > Date.now()) continue;
          if (retryAfterAt) autoRuntime.snapshotRetryAfterByAsset.delete(scope);
          const assetRequirements = selectedStrategyCandleRequirements(groupStrategyIds, defaultMode, candleOffset, sourcePeriod, auto);
          const cacheSub = cacheBridgeSnapshots.get(scope) || null;
          const useCacheBridge = cacheBridgeSnapshotUsable(asset, sourcePeriod, assetRequirements.minimumClosedCandles);
          const sub = useCacheBridge ? cacheSub : getPocketMarketSnapshot(asset, sourcePeriod);
          if (!sub) { waitingForHistory += 1; continue; }
          const { closed, current, period } = splitCandlesForSubscription(sub);
          if (closed.length < assetRequirements.minimumClosedCandles) { waitingForHistory += 1; continue; }
          const localThreeCandle = evaluateLocalThreeCandleStrategies(asset, groupStrategyIds, sourcePeriod, closed);
          const serverStrategyIds = groupStrategyIds.filter((id) => !localThreeCandle.strategyIds.includes(id));
          if (!serverStrategyIds.length) {
            if (localThreeCandle.waiting) waitingForHistory += 1;
            else autoRuntime.analysisCompletedAssets.add(scope);
            continue;
          }
          if (!serverChannelReady) continue;
          let useCurrentCandle = selectedStrategyCandleRequirements(serverStrategyIds, defaultMode, candleOffset, sourcePeriod, auto).needsCurrent;
          let snapshotCurrent = current;
          let snapshotCandleOffset = candleOffset;
          let snapshotCandleMode = candleOffset === 0 ? 'current' : 'closed';
          if (useCurrentCandle) {
            const currentReady = Boolean(current && currentCandleSettled(current, period));
            if (!currentReady) {
              if (sourcePeriod < 60 && closed.length >= assetRequirements.minimumClosedCandles) {
                useCurrentCandle = false;
                snapshotCurrent = null;
                snapshotCandleOffset = -1;
                snapshotCandleMode = 'closed';
              } else {
                waitingForCurrent += 1;
                continue;
              }
            }
          }
          const serverAssetRequirements = selectedStrategyCandleRequirements(serverStrategyIds, defaultMode, candleOffset, sourcePeriod, auto);
          const effectiveStrategyCandleOffsets = Object.fromEntries(
            Object.entries(serverAssetRequirements.offsetMap || {}).map(([strategyId, rawOffset]) => {
              const normalizedOffset = normalizeCandleOffset(rawOffset, defaultMode);
              return [strategyId, (!useCurrentCandle && normalizedOffset === 0) ? snapshotCandleOffset : normalizedOffset];
            })
          );
          const groupStrategyPeriods = serverAssetRequirements.periodMap || Object.fromEntries(serverStrategyIds.map((id) => [id, sourcePeriod]));
          const effectiveAllStrategyOffsets = { ...allStrategyOffsets, ...effectiveStrategyCandleOffsets };
          const effectiveAnalysisConfigKey = `${serverStrategyIds.slice().sort().join(',')}|${strategyMode}|p:${JSON.stringify(groupStrategyPeriods)}|o:${JSON.stringify(effectiveStrategyCandleOffsets)}`;
          const sourceVersion = snapshotSourceVersion(period, snapshotCandleOffset, closed, snapshotCurrent, effectiveAnalysisConfigKey);
          if (!allowBootstrapResend && autoRuntime.lastSnapshotSourceByAsset.get(scope) === sourceVersion) {
            autoRuntime.analysisCompletedAssets.add(scope);
            continue;
          }

          const ticks = (Array.isArray(sub.recentTicks) ? sub.recentTicks : [])
            .slice(-80)
            .map((tick) => ({ time: finiteNumber(tick.time), price: finiteNumber(tick.price) }))
            .filter((tick) => tick.time && tick.price);
          const fingerprintOffset = useCurrentCandle ? 0 : snapshotCandleOffset;
          const fingerprint = snapshotFingerprint(fingerprintOffset, period, closed, snapshotCurrent, effectiveAnalysisConfigKey);
          if (!fingerprint) continue;
          if (!allowBootstrapResend && autoRuntime.lastSnapshotCandleByAsset.get(scope) === fingerprint) {
            autoRuntime.analysisCompletedAssets.add(scope);
            continue;
          }

          const assetInfo = (latestState?.market?.assetList || []).find((item) => item.symbol === asset) || {};
          const primaryStrategyId = serverStrategyIds[0] || '';
          const tradeDuration = effectiveProfileExpirationForAuto({ ...auto, strategyId: primaryStrategyId, strategyIds: serverStrategyIds }, { strategyId: primaryStrategyId, period: sourcePeriod }, asset);
          const payoutInfo = currentPayoutForAsset(asset, null, { duration: tradeDuration, ignoreSignal: true });
          const jobPayout = finiteNumber(payoutInfo.payout) ?? finiteNumber(assetInfo.payout);
          const minPayout = Math.max(MIN_TRADE_PAYOUT, Number(auto.minPayout) || 0);
          if (minPayout > 0 && jobPayout != null && jobPayout < minPayout) {
            autoRuntime.analysisCompletedAssets.add(scope);
            continue;
          }
          const historyDepth = Math.min(5000, Math.max(180, serverAssetRequirements.requiredHistoryCandles));
          const analysisCandles = useCurrentCandle ? [...closed, snapshotCurrent].slice(-historyDepth) : closed.slice(-historyDepth);
          const candleTime = analysisCandles[analysisCandles.length - 1]?.time || 0;
          jobs.push({
            asset,
            scope,
            sourcePeriod,
            fingerprint,
            sourceVersion,
            payout: jobPayout ?? 0,
            payload: {
              snapshotId: crypto.randomUUID(),
              asset,
              period,
              configuredPeriod: subscriptionConfiguredPeriod,
              configuredDuration: subscriptionConfiguredDuration,
              localConfigRevision: autoRuntime.signalConfigRevision,
              strategyPeriods: allStrategyPeriods,
              strategyCandleOffsets: effectiveAllStrategyOffsets,
              evaluationPeriod: sourcePeriod,
              evaluationStrategyIds: serverStrategyIds,
              strategyDurations: Object.fromEntries(strategyIds.map((id) => [id, effectiveProfileExpirationForAuto({ ...auto, strategyId: id, strategyIds: [id] }, { strategyId: id, period: allStrategyPeriods[id] || sourcePeriod }, asset)])),
              strategyCooldowns: allStrategyCooldowns,
              candleTime,
              closedCandleTime: closed[closed.length - 1]?.time || 0,
              currentCandleTime: snapshotCurrent?.time || 0,
              closedCandles: closed.slice(-historyDepth),
              currentCandle: useCurrentCandle ? snapshotCurrent : null,
              ticks: useCurrentCandle ? ticks : [],
              marketDataSource: useCacheBridge ? 'cache-bridge' : 'pocket-option-fallback',
              marketDataFile: useCacheBridge ? (sub.marketDataSource || (/_otc$/i.test(asset) ? 'CasheOTC.json' : 'cashe.json')) : null,
              marketDataAgeMs: useCacheBridge ? (Number(sub.cacheBridgeAgeMs) || 0) : null,
              cacheBridgeLatencyMs: useCacheBridge ? cacheBridgeControl.lastLatencyMs : null,
              payout: jobPayout,
              payoutSource: payoutInfo.source || assetInfo.payoutSource || null,
              payoutVerified: payoutInfo.verified === true,
              strategyId: primaryStrategyId,
              strategyIds: serverStrategyIds,
              allStrategyIds: strategyIds,
              sourceStrategyId: primaryStrategyId,
              sourceStrategyIds: serverStrategyIds,
              strategyMode,
              candleMode: snapshotCandleMode,
              candleOffset: snapshotCandleOffset,
              snapshotKey: fingerprint,
              decisionMode: 'direction_only',
              minimumPayout: Math.max(MIN_TRADE_PAYOUT, Number(auto.minPayout) || 0),
              brokerClockOffsetSec: finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0,
              calibrationProfiles: calibrationPayloadFor(asset, strategyIds, { ...auto, period: sourcePeriod })
            }
          });
        }
      }

      jobs.sort((a, b) => (Number(a.sourcePeriod || 0) - Number(b.sourcePeriod || 0)) || (Number(b.payout || 0) - Number(a.payout || 0)) || String(a.asset).localeCompare(String(b.asset)));

      // Fresh subscription bootstrap: send exactly one deterministic probe and wait
      // for a terminal engine_status before flooding a 30/79/100-asset batch. This
      // prevents latest-wins coalescing from starving readiness on large mirror scans.
      if (bootstrapPending) {
        const bootstrapAge = Date.now() - Number(autoRuntime.analysisBootstrapSentAt || 0);
        const bootstrapWaitMs = CLIENT_PERFORMANCE_PROFILE.slowNetwork || CLIENT_PERFORMANCE_PROFILE.lowEnd ? 90000 : 60000;
        if (autoRuntime.analysisBootstrapAwaiting && bootstrapAge < bootstrapWaitMs) {
          await writeAutoStatus({
            enabled: true,
            state: 'scanning',
            message: `Канал подключён · проверяем запуск анализа${autoRuntime.analysisBootstrapAsset ? ` ${autoRuntime.analysisBootstrapAsset}` : ''}…`
          });
          return;
        }
        autoRuntime.analysisBootstrapAwaiting = false;
        autoRuntime.analysisBootstrapSentAt = 0;
        autoRuntime.analysisBootstrapSnapshotId = '';
        autoRuntime.analysisBootstrapAsset = '';
        if (jobs.length > 1) jobs.splice(1);
        if (jobs[0]?.payload) {
          // The first packet after subscribe is a deliberately tiny, non-trading
          // liveness probe. Production analysis starts only after its terminal
          // engine_status, so a large 79-asset/custom-strategy payload cannot mask
          // a broken data plane or be killed by a premature reconnect watchdog.
          jobs[0].payload = {
            snapshotId: jobs[0].payload.snapshotId,
            asset: jobs[0].payload.asset,
            period: jobs[0].payload.period,
            configuredPeriod: jobs[0].payload.configuredPeriod,
            configuredDuration: jobs[0].payload.configuredDuration,
            localConfigRevision: jobs[0].payload.localConfigRevision,
            strategyId: jobs[0].payload.strategyId,
            strategyIds: jobs[0].payload.strategyIds,
            allStrategyIds: jobs[0].payload.allStrategyIds,
            strategyPeriods: jobs[0].payload.strategyPeriods,
            strategyCandleOffsets: jobs[0].payload.strategyCandleOffsets,
            evaluationPeriod: jobs[0].payload.evaluationPeriod,
            evaluationStrategyIds: jobs[0].payload.evaluationStrategyIds,
            strategyDurations: jobs[0].payload.strategyDurations,
            strategyMode: jobs[0].payload.strategyMode,
            candleMode: jobs[0].payload.candleMode,
            candleOffset: jobs[0].payload.candleOffset,
            snapshotKey: `bootstrap:${jobs[0].payload.snapshotKey || jobs[0].asset || ''}`,
            bootstrapProbe: true,
            brokerClockOffsetSec: jobs[0].payload.brokerClockOffsetSec
          };
        }
      }

      let sent = 0;
      let failed = 0;
      let backpressureCount = 0;
      let timeoutCount = 0;
      let earliestRetryAt = 0;
      let cursor = 0;
      let channelInterrupted = false;
      let batchRateLimited = false;
      // One paced sender per browser/UID. Server-side evaluation may still run in
      // parallel, while the browser never creates an ACK burst or overloads a weak PC.
      const workerCount = jobs.length ? 1 : 0;
      const transientErrors = new Set([
        'signal_socket_offline',
        'signal_socket_connecting',
        'signal_socket_closed',
        'not_signal_controller',
        // A snapshot can race a legitimate subscribe ACK after MV3 wake-up or a
        // strategy change. Treat it as a subscription resync, not as a failed asset.
        'snapshot_subscription_changed'
      ]);
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < jobs.length && !channelInterrupted && !batchRateLimited) {
          if (!['online', 'analyzing'].includes(autoRuntime.signalSocketStatus)) {
            channelInterrupted = true;
            break;
          }
          const job = jobs[cursor++];
          await waitForSnapshotSendWindow();
          const response = await safeRuntimeMessage({ type: 'PT_MARKET_SNAPSHOT', payload: job.payload }, 80000).catch(() => null);
          autoRuntime.snapshotPublishingProgressAt = Date.now();
          const errorCode = String(response?.error || '');
          if (response?.ok) {
            sent += 1;
            const now = Date.now();
            if (bootstrapPending
                && autoRuntime.signalSocketStatus === 'analyzing'
                && Number(autoRuntime.lastEngineStatusAt || 0) < Number(autoRuntime.signalAnalyzingSince || 0)) {
              autoRuntime.analysisBootstrapAwaiting = true;
              autoRuntime.analysisBootstrapSentAt = now;
              autoRuntime.analysisBootstrapSnapshotId = String(job.payload?.snapshotId || '');
              autoRuntime.analysisBootstrapAsset = String(job.asset || '');
            }
            autoRuntime.lastSnapshotSuccessAt = now;
            const ackLatencyMs = Math.max(0, Number(response?.ackLatencyMs) || 0);
            if (ackLatencyMs > 0) {
              autoRuntime.snapshotLastAckLatencyMs = autoRuntime.snapshotLastAckLatencyMs > 0
                ? Math.round(autoRuntime.snapshotLastAckLatencyMs * 0.75 + ackLatencyMs * 0.25)
                : ackLatencyMs;
            }
            autoRuntime.snapshotConsecutiveSuccesses = Math.min(1000, Number(autoRuntime.snapshotConsecutiveSuccesses || 0) + 1);
            autoRuntime.snapshotConsecutiveTimeouts = 0;
            const basePaceMs = Math.max(60, Number(autoRuntime.snapshotBasePaceMs) || 100);
            const latencyPaceMs = autoRuntime.snapshotLastAckLatencyMs > 0
              ? Math.min(900, Math.max(basePaceMs, Math.round(autoRuntime.snapshotLastAckLatencyMs * 0.18)))
              : basePaceMs;
            autoRuntime.snapshotSendPaceMs = Math.max(basePaceMs, Math.round((Number(autoRuntime.snapshotSendPaceMs) || basePaceMs) * 0.82 + latencyPaceMs * 0.18));
            autoRuntime.lastSnapshotCandleByAsset.set(job.scope, job.fingerprint);
            autoRuntime.lastSnapshotSourceByAsset.set(job.scope, job.sourceVersion);
            autoRuntime.lastSnapshotAtByAsset.set(job.scope, now);
            autoRuntime.snapshotRetryAfterByAsset.delete(job.scope);
            if (response?.queued) autoRuntime.analysisQueuedAssets.add(job.scope);
            else autoRuntime.analysisCompletedAssets.add(job.scope);
            autoRuntime.analysisFailedAssets.delete(job.scope);
          } else if (transientErrors.has(errorCode)) {
            // Transport really went offline: stop this batch and recover the channel.
            channelInterrupted = true;
            autoRuntime.signalSocketStatus = 'reconnecting';
            autoRuntime.signalSocketStatusAt = Date.now();
            autoRuntime.subscribedKey = '';
            autoRuntime.lastSubscriptionAt = 0;
          } else if (errorCode === 'strategy_unavailable') {
            failed += 1;
            batchRateLimited = true;
            const missingIds = Array.isArray(response?.missingStrategyIds) ? response.missingStrategyIds.map(String).filter(Boolean) : [];
            let repairResult = null;
            const nowRepair = Date.now();
            if (missingIds.length && !autoRuntime.customStrategyRepairInFlight && nowRepair - Number(autoRuntime.lastCustomStrategyRepairAt || 0) >= 15000) {
              autoRuntime.customStrategyRepairInFlight = true;
              autoRuntime.lastCustomStrategyRepairAt = nowRepair;
              try {
                repairResult = await safeRuntimeMessage({
                  type: 'PT_REPAIR_CUSTOM_STRATEGIES',
                  strategyIds: missingIds
                }, 30000).catch((error) => ({ ok: false, error: String(error?.message || error) }));
              } finally {
                autoRuntime.customStrategyRepairInFlight = false;
              }
            }
            const repairedIds = Array.isArray(repairResult?.repaired) ? repairResult.repaired.map(String).filter(Boolean) : [];
            const deletedIds = Array.isArray(repairResult?.deleted) ? repairResult.deleted.map(String).filter(Boolean) : [];
            const retryAt = Date.now() + (repairedIds.length ? 1500 : 60000);
            autoRuntime.snapshotBackoffUntil = Math.max(Number(autoRuntime.snapshotBackoffUntil || 0), retryAt);
            autoRuntime.snapshotRetryAfterByAsset.set(job.scope, retryAt);
            autoRuntime.lastSnapshotErrorAtByAsset.set(job.scope, Date.now());
            autoRuntime.analysisFailedAssets.add(job.scope);
            const message = repairedIds.length
              ? `Стратегия восстановлена на сервере: ${repairedIds.join(', ')}. Анализ продолжается.`
              : deletedIds.length
                ? `Стратегия была удалена пользователем: ${deletedIds.join(', ')}. Выберите другую стратегию.`
                : `Восстановление стратегии на сервере${missingIds.length ? `: ${missingIds.join(', ')}` : ''}…`;
            await writeAutoStatus({ force: true, enabled: true, state: 'waiting', message });
          } else if (errorCode === 'autotrading_unavailable') {
            failed += 1;
            batchRateLimited = true;
            autoRuntime.snapshotBackoffUntil = Math.max(Number(autoRuntime.snapshotBackoffUntil || 0), Date.now() + 60000);
            await writeAutoStatus({ force: true, enabled: true, state: 'waiting', message: 'Сервер временно не подтвердил доступ к автоторговле. Выполняется повторная синхронизация.' });
          } else if (response?.backpressure === true) {
            failed += 1;
            backpressureCount += 1;
            batchRateLimited = true;
            autoRuntime.serverBackpressureEvents = Math.max(0, Number(autoRuntime.serverBackpressureEvents) || 0) + 1;
            autoRuntime.serverPressureLevel = Math.min(7, Math.max(0, Number(autoRuntime.serverPressureLevel) || 0) + 2);
            const basePaceMs = Math.max(60, Number(autoRuntime.snapshotBasePaceMs) || 100);
            autoRuntime.snapshotSendPaceMs = Math.min(2000, Math.max(basePaceMs * 2, Math.round((Number(autoRuntime.snapshotSendPaceMs) || basePaceMs) * 1.8)));
            autoRuntime.snapshotConsecutiveSuccesses = 0;
            const retryAfterMs = Math.max(1000, Math.min(30000, Number(response?.retryAfterMs) || (1500 + autoRuntime.serverPressureLevel * 500)));
            const retryAt = Date.now() + retryAfterMs;
            // Stop the whole batch after the first rate-limit ACK. Continuing to send
            // the remaining assets only extends the server-side penalty window.
            autoRuntime.snapshotBackoffUntil = Math.max(Number(autoRuntime.snapshotBackoffUntil || 0), retryAt);
            autoRuntime.snapshotRetryAfterByAsset.set(job.scope, retryAt);
            earliestRetryAt = earliestRetryAt ? Math.min(earliestRetryAt, retryAt) : retryAt;
            autoRuntime.lastSnapshotErrorAtByAsset.set(job.scope, Date.now());
            autoRuntime.analysisFailedAssets.add(job.scope);
          } else if (errorCode === 'market_snapshot_ack_timeout' || response?.code === 'RUNTIME_MESSAGE_TIMEOUT' || response?.timeout === true || response?.retryable === true || response?.transient === true) {
            failed += 1;
            timeoutCount += 1;
            // Таймаут ACK означает такую же перегрузку очереди анализа, как явный
            // backpressure. Раньше клиент сразу снова повышал темп и повторял таймаут.
            autoRuntime.serverPressureLevel = Math.min(7, Math.max(0, Number(autoRuntime.serverPressureLevel) || 0) + 1);
            autoRuntime.snapshotConsecutiveTimeouts = Math.min(20, Number(autoRuntime.snapshotConsecutiveTimeouts || 0) + 1);
            autoRuntime.snapshotConsecutiveSuccesses = 0;
            const basePaceMs = Math.max(60, Number(autoRuntime.snapshotBasePaceMs) || 100);
            autoRuntime.snapshotSendPaceMs = Math.min(2000, Math.max(basePaceMs * 2, Math.round((Number(autoRuntime.snapshotSendPaceMs) || basePaceMs) * 1.5)));
            const retryAfterMs = Math.max(3000, Math.min(30000, Number(response?.retryAfterMs) || (4000 + autoRuntime.snapshotConsecutiveTimeouts * 1500)));
            const retryAt = Date.now() + retryAfterMs;
            batchRateLimited = true;
            autoRuntime.snapshotBackoffUntil = Math.max(Number(autoRuntime.snapshotBackoffUntil || 0), retryAt);
            autoRuntime.snapshotRetryAfterByAsset.set(job.scope, retryAt);
            earliestRetryAt = earliestRetryAt ? Math.min(earliestRetryAt, retryAt) : retryAt;
            autoRuntime.lastSnapshotErrorAtByAsset.set(job.scope, Date.now());
            autoRuntime.analysisFailedAssets.add(job.scope);
          } else {
            failed += 1;
            autoRuntime.lastSnapshotErrorAtByAsset.set(job.scope, Date.now());
            autoRuntime.analysisFailedAssets.add(job.scope);
          }
        }
      });
      await Promise.all(workers);
      autoRuntime.lastPublishCompletedAt = Date.now();
      if (earliestRetryAt) {
        if (autoRuntime.snapshotRetryTimer) clearTimeout(autoRuntime.snapshotRetryTimer);
        const retryDelay = Math.max(80, Math.min(30000, earliestRetryAt - Date.now() + 30));
        autoRuntime.snapshotRetryTimer = setTimeout(() => {
          autoRuntime.snapshotRetryTimer = null;
          if (settings.autoTrade?.enabled) void publishCandleSnapshots(false);
        }, retryDelay);
      }
      if (backpressureCount === 0 && timeoutCount === 0) {
        autoRuntime.serverPressureLevel = Math.max(0, (Number(autoRuntime.serverPressureLevel) || 0) - 1);
        const basePaceMs = Math.max(60, Number(autoRuntime.snapshotBasePaceMs) || 100);
        if (autoRuntime.snapshotConsecutiveSuccesses >= 8) {
          autoRuntime.snapshotSendPaceMs = Math.max(basePaceMs, Math.round((Number(autoRuntime.snapshotSendPaceMs) || basePaceMs) * 0.95));
        }
      }
      if (batchRateLimited && earliestRetryAt) {
        autoRuntime.snapshotBackoffUntil = Math.max(Number(autoRuntime.snapshotBackoffUntil || 0), earliestRetryAt);
      }
      if (channelInterrupted) {
        await writeAutoStatus({
          force: true,
          enabled: true,
          state: 'connecting',
          message: 'Восстанавливаем канал сигналов…'
        });
        setTimeout(() => scheduleAutoEngine(), 350);
        return;
      }

      const completed = autoRuntime.analysisCompletedAssets.size;
      const queuedTotal = autoRuntime.analysisQueuedAssets.size;
      const failedTotal = autoRuntime.analysisFailedAssets.size;
      const pendingTotal = Math.max(0, totalScopes - completed - queuedTotal);
      const periodLabel = strategyGroups.map((group) => group.period % 60 === 0 ? `M${Math.max(1, group.period / 60)}` : `${group.period} сек`).join(', ');
      const details = [`Графики ${periodLabel}`, `цикл ${autoRuntime.analysisCycle}`, `${completed}/${totalScopes} проверено`];
      if (queuedTotal) details.push(`${queuedTotal} анализируются`);
      if (waitingForHistory) details.push(`${waitingForHistory} ждут историю`);
      else if (waitingForCurrent) details.push(`${waitingForCurrent} ждут свечу`);
      else if (pendingTotal) details.push(`${pendingTotal} в очереди`);
      if (failedTotal) details.push(`${failedTotal} повторятся`);
      const cacheAssetCount = Math.max(0, selected.length - cacheBridgeControl.fallbackAssets.length);
      if (cacheAssetCount) details.push(`кэш ${cacheAssetCount}`);
      if (cacheBridgeControl.fallbackAssets.length) details.push(`резерв Pocket ${cacheBridgeControl.fallbackAssets.length}`);
      const statusSignature = details.join('|');
      if (statusSignature !== autoRuntime.lastAnalysisStatusSignature) {
        autoRuntime.lastAnalysisStatusSignature = statusSignature;
        await writeAutoStatus({
          enabled: true,
          state: failedTotal ? 'waiting' : completed >= totalScopes ? 'scanning' : 'scanning',
          message: `Онлайн-анализ · ${details.join(' · ')}`
        });
      }
    } finally {
      autoRuntime.snapshotPublishing = false;
      autoRuntime.snapshotPublishingStartedAt = 0;
      autoRuntime.snapshotPublishingProgressAt = 0;
      if (autoRuntime.snapshotQueuedForce) {
        const queuedForce = autoRuntime.snapshotQueuedForce;
        autoRuntime.snapshotQueuedForce = false;
        setTimeout(() => void publishCandleSnapshots(queuedForce), 0);
      }
    }
  }

  async function ensureSignalSubscription() {
    if (extensionContextInvalidated) return { ok: false, code: 'EXTENSION_CONTEXT_INVALIDATED', error: 'Обновите вкладку Pocket Option' };
    const auto = { ...DEFAULT_SETTINGS.autoTrade, ...(settings.autoTrade || {}) };
    const assets = selectedAutotradeAssets();
    const strategyIds = selectedStrategyIds(auto);
    const strategyId = strategyIds[0] || '';
    const strategyPeriods = Object.fromEntries(strategyIds.map((id) => [id, strategyAnalysisPeriod(id, auto)]));
    const strategyDurations = Object.fromEntries(strategyIds.map((id) => [id, effectiveProfileExpirationForAuto(auto, { strategyId: id, period: strategyPeriods[id] })]));
    const strategyCandleOffsets = Object.fromEntries(strategyIds.map((id) => [id, strategyCandleOffsetForAuto(id, auto)]));
    const strategyCooldowns = Object.fromEntries(strategyIds.map((id) => [id, strategyCooldownForAuto(id, auto)]));
    const candleOffset = strategyId
      ? strategyCandleOffsets[strategyId]
      : normalizeCandleOffset(auto.candleOffset, auto.candleMode);
    const candleMode = candleOffset === 0 ? 'current' : 'closed';
    const effectiveSignalPeriod = selectedEffectiveAnalysisPeriod(auto);
    const strategyMode = effectiveAutoStrategyMode(auto, strategyIds);
    const unsupportedLocalStrategies = strategyIds.filter((id) => !isLocalThreeCandleStrategy(id));
    if (unsupportedLocalStrategies.length) {
      await safeRuntimeMessage({ type: 'PT_SIGNAL_UNSUBSCRIBE' }).catch(() => null);
      autoRuntime.subscribedKey = '';
      autoRuntime.lastSubscriptionAt = 0;
      return {
        ok: false,
        status: 'disabled_local_only',
        error: `Автономный режим поддерживает автоторговлю только для локальной стратегии 3-Candle EMA14. Не перенесены: ${unsupportedLocalStrategies.join(', ')}.`
      };
    }
    const key = JSON.stringify([assets, strategyIds, strategyMode, strategyPeriods, strategyDurations, strategyCandleOffsets, strategyCooldowns]);
    const now = Date.now();
    if (autoRuntime.subscribedKey === key && now - autoRuntime.lastSubscriptionAt < 5000) {
      const state = await safeRuntimeMessage({ type: 'PT_SIGNAL_SOCKET_STATE' })
        .catch((error) => ({ ok: false, error: String(error?.message || error) }));
      if (state?.ok && ['online', 'connecting', 'subscribing', 'analyzing', 'reconnecting'].includes(state.status)) {
        const previousStatus = autoRuntime.signalSocketStatus;
        autoRuntime.signalSocketStatus = state.status;
        autoRuntime.signalSocketStatusAt = Date.now();
        if (state.status === 'analyzing' && previousStatus !== 'analyzing') {
          autoRuntime.signalAnalyzingSince = Date.now();
          autoRuntime.lastEngineStatusAt = 0;
          autoRuntime.analysisBootstrapAwaiting = false;
        }
        if (state.status === 'online') { autoRuntime.signalAnalyzingSince = 0; autoRuntime.analysisBootstrapAwaiting = false; autoRuntime.analysisStallRecoveries = 0; }
        return state;
      }
      // The MV3 service worker may have restarted and lost its in-memory subscription.
      // Fall through and register the subscription again instead of treating offline as OK.
      autoRuntime.subscribedKey = '';
      autoRuntime.lastSubscriptionAt = 0;
    }
    const response = await safeRuntimeMessage({
      type: 'PT_SIGNAL_SUBSCRIBE',
      payload: {
        enabled: true,
        assets,
        strategyId,
        strategyIds,
        strategyMode,
        candleMode,
        candleOffset,
        period: effectiveSignalPeriod,
        duration: strategyId ? strategyDurations[strategyId] : normalizeExpirationSeconds(auto.duration ?? settings.duration ?? 60, 60),
        strategyPeriods,
        strategyDurations,
        strategyCandleOffsets,
        strategyCooldowns,
        localConfigRevision: autoRuntime.signalConfigRevision,
        localOnly: true
      }
    }, 30000).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    if (response?.ok) {
      autoRuntime.subscribedKey = key;
      autoRuntime.lastSubscriptionAt = now;
      const previousStatus = autoRuntime.signalSocketStatus;
      autoRuntime.signalSocketStatus = response.status || 'connecting';
      autoRuntime.signalSocketStatusAt = Date.now();
      if (autoRuntime.signalSocketStatus === 'analyzing' && previousStatus !== 'analyzing') {
        autoRuntime.signalAnalyzingSince = Date.now();
        autoRuntime.lastEngineStatusAt = 0;
        autoRuntime.analysisBootstrapAwaiting = false;
      }
      if (autoRuntime.signalSocketStatus === 'online') { autoRuntime.signalAnalyzingSince = 0; autoRuntime.analysisBootstrapAwaiting = false; autoRuntime.analysisStallRecoveries = 0; }
    }
    return response;
  }

  async function runAutoEngine() {
    if (extensionContextInvalidated || autoRuntime.running) return;
    autoRuntime.running = true;
    try {
      const auto = { ...DEFAULT_SETTINGS.autoTrade, ...(settings.autoTrade || {}) };
      if (!auto.enabled) {
        closeSignalSocket('autotrade_off');
        await writeAutoStatus({ enabled: false, state: 'off', message: 'Автоторговля выключена' });
        return;
      }
      if (!isConnected()) {
        closeSignalSocket('account_offline');
        const waitingForLogin = Boolean(latestState?.connection?.waitingForLogin)
          || isWaitingForPocketLogin(latestState);
        await writeAutoStatus({
          force: true,
          enabled: true,
          state: 'waiting',
          message: waitingForLogin
            ? 'Зеркало подключено · ожидание входа в Pocket Option'
            : 'Ожидание подключения аккаунта'
        });
        return;
      }
      const rawStrategyIds = Array.isArray(auto.strategyIds) && auto.strategyIds.length
        ? [...new Set(auto.strategyIds.filter(Boolean).map(String))]
        : [String(auto.strategyId || settings.activeStrategyId || '').trim()].filter(Boolean);
      const strategyIds = selectedStrategyIds(auto);
      if (!strategyIds.length) {
        closeSignalSocket(rawStrategyIds.length ? 'strategy_incompatible' : 'strategy_missing');
        await writeAutoStatus({
          enabled: true,
          state: 'waiting',
          message: rawStrategyIds.length
            ? 'Выбранные стратегии несовместимы с текущими таймфреймом анализа и экспирацией. Проверьте настройки автоторговли.'
            : 'Не выбрана ни одна серверная стратегия'
        });
        return;
      }
      const selected = selectedAutotradeAssets();
      if (!selected.length) {
        closeSignalSocket('assets_missing');
        await writeAutoStatus({ enabled: true, state: 'waiting', message: 'Не выбраны активы' });
        return;
      }
      if (!serverStateUsable() && Date.now() - autoRuntime.lastServerSyncAttemptAt >= 30000) {
        autoRuntime.lastServerSyncAttemptAt = Date.now();
        await safeRuntimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: false }).catch(() => null);
        const stored = await safeStorageGet('ptServerState', {});
        serverState = stored.ptServerState || serverState;
      }
      if (!serverStateUsable()) {
        closeSignalSocket('server_offline');
        await writeAutoStatus({ enabled: true, state: 'waiting', message: serverWaitingMessage() });
        return;
      }
      const unavailable = strategyIds.filter((strategyId) => !strategyAvailable(strategyId));
      if (unavailable.length) {
        closeSignalSocket('strategy_locked');
        await writeAutoStatus({ enabled: true, state: 'blocked', message: 'Одна из выбранных стратегий недоступна на текущем тарифе' });
        return;
      }
      const socket = await ensureSignalSubscription();
      if (!socket?.ok) {
        autoRuntime.signalSocketStatus = 'offline';
        autoRuntime.signalSocketStatusAt = Date.now();
        await writeAutoStatus({ enabled: true, state: 'waiting', message: socket?.error || 'Подключение канала сигналов…' });
        return;
      }
      autoRuntime.signalSocketStatus = socket.status || autoRuntime.signalSocketStatus || 'connecting';
      autoRuntime.signalSocketStatusAt = Date.now();
      if (!['online', 'analyzing'].includes(socket.status)) {
        const label = socket.status === 'reconnecting'
          ? 'Переподключение канала сигналов…'
          : socket.status === 'subscribing'
            ? 'Подписка на канал сигналов…'
            : 'Подключение канала сигналов…';
        await writeAutoStatus({ enabled: true, state: 'connecting', message: label });
        return;
      }
      // "analyzing" means transport + subscription ACK are ready but the first
      // engine_status has not arrived yet. Snapshots must flow in this state.
      await publishCandleSnapshots(false);
      if (socket.status === 'analyzing') {
        await writeAutoStatus({
          enabled: true,
          state: 'scanning',
          message: `Канал подключён · запуск анализа ${selected.length} активов`
        });
        return;
      }
      const recentProgress = Date.now() - Math.max(Number(autoRuntime.lastEngineStatusAt || 0), Number(autoRuntime.lastPublishCompletedAt || 0)) < Math.max(3500, normalizeAnalysisPeriodSeconds(auto.period, 60) * 1000);
      if (!recentProgress) await writeAutoStatus({ enabled: true, state: socket.status === 'online' ? 'scanning' : 'connecting', message: `Онлайн-анализ · ${selected.length} активов · ${strategyIds.length} стратегий · ${candleOffsetLabel(auto.candleOffset ?? (auto.candleMode === 'current' ? 0 : -1))} · подходящего входа пока нет` });
    } finally {
      autoRuntime.running = false;
    }
  }

  function mergeCompactStateWithSnapshots(compactState) {
    if (!compactState || typeof compactState !== 'object') return compactState;
    compactState.market = compactState.market || {};
    const subscriptions = compactState.market.subscriptions || {};
    compactState.market.subscriptions = subscriptions;
    const primaryPeriod = Math.max(1, Number(compactState.market.period || graphSubscriptionManager.primaryPeriod || settings.autoTrade?.period) || 60);
    const selectedSymbols = Array.isArray(settings.selectedAssets) ? settings.selectedAssets.map(String).filter(Boolean) : [];
    const symbols = new Set([...Object.keys(subscriptions), ...selectedSymbols]);
    for (const asset of symbols) {
      const metadata = subscriptions[asset] || {};
      const requestedPeriod = Number(metadata?.period || primaryPeriod);
      const cacheSnapshot = cacheBridgeSnapshots.get(marketSnapshotKey(asset, requestedPeriod)) || null;
      const snapshot = cacheSnapshot || getMarketSnapshot(asset, requestedPeriod);
      if (!snapshot || Number(snapshot.period) !== requestedPeriod) continue;
      subscriptions[asset] = {
        ...metadata,
        ...snapshot,
        requested: true,
        subscribed: snapshot.source === 'cache-bridge' ? true : Boolean(snapshot.subscribed),
        streamActive: snapshot.source === 'cache-bridge' ? snapshot.cacheBridgeFresh === true : Boolean(snapshot.streamActive),
        historyItems: snapshot.historyItems || [],
        recentCandles: snapshot.recentCandles || [],
        recentTicks: snapshot.recentTicks || []
      };
    }
    const cachePrimaryAssets = new Set([...cacheBridgeControl.primaryScopes].map((scope) => String(scope).split('|')[0]).filter(Boolean));
    const payoutMinimum = Math.max(MIN_TRADE_PAYOUT, Number(settings.autoTrade?.minPayout) || 0);
    const payoutEligibleAssetList = selectedSymbols.filter((asset) => marketAnalysisEligibility(asset, payoutMinimum).eligible === true);
    compactState.market.cacheBridge = {
      enabled: cacheBridgeControl.enabled,
      online: cacheBridgeControl.online,
      baseUrl: cacheBridgeControl.baseUrl,
      lastAttemptAt: cacheBridgeControl.lastAttemptAt || null,
      lastSuccessAt: cacheBridgeControl.lastSuccessAt || null,
      lastLatencyMs: cacheBridgeControl.lastLatencyMs,
      lastError: cacheBridgeControl.lastError,
      cacheAssets: [...cachePrimaryAssets].filter((asset) => selectedSymbols.includes(asset)).length,
      fallbackAssets: cacheBridgeControl.fallbackAssets.length,
      fallbackAssetList: [...cacheBridgeControl.fallbackAssets],
      payoutMinimum,
      payoutEligibleAssets: payoutEligibleAssetList.length,
      payoutFilteredAssets: Math.max(0, selectedSymbols.length - payoutEligibleAssetList.length)
    };
    return compactState;
  }



  // FINAL LIVE STATS: Pocket's WebSocket does not always push every closed deal
  // while the terminal panel is in the background. When the broker's "Сделки → Закрытые"
  // panel is visible, read its live text as an additional authoritative source for
  // count / wins / losses / Win Rate. This does not send data anywhere; it only enriches
  // the local state used by the dashboard.
  function parseBrokerMoneyText(value) {
    const raw = String(value || '').replace(/\u00a0/g, ' ').trim();
    if (!raw || !/[0-9]/.test(raw)) return null;
    const sign = /^\s*-/.test(raw) ? -1 : /^\s*\+/.test(raw) ? 1 : 0;
    const cleaned = raw.replace(/[^0-9,.-]/g, '').replace(',', '.');
    const number = Number(cleaned);
    if (!Number.isFinite(number)) return null;
    return { value: sign < 0 ? -Math.abs(number) : number, signed: sign !== 0, raw };
  }

  function normalizeBrokerUiAsset(value) {
    const raw = String(value || '').replace(/\u00a0/g, ' ').trim();
    if (!raw) return '';
    const withoutPercent = raw.replace(/[+-]?\d+(?:[.,]\d+)?\s*%/g, '').trim();
    const otc = /\bOTC\b/i.test(withoutPercent);
    let name = withoutPercent.replace(/[★☆↗↘🟢🔴]/gu, '').replace(/\bOTC\b/ig, '').trim();
    if (/^Gold$/i.test(name)) return 'XAUUSD_otc';
    if (/^Silver$/i.test(name)) return 'XAGUSD_otc';
    name = name.replace(/\s+/g, '').replace('/', '');
    if (!name) return withoutPercent;
    return otc && !/_otc$/i.test(name) ? `${name}_otc` : name;
  }

  function brokerUiDealNet(amount, monies, assetLineText) {
    const signed = monies.filter((item) => item && item.signed);
    if (signed.length) return signed[signed.length - 1].value;
    const values = monies.map((item) => item.value).filter((item) => Number.isFinite(item));
    const stake = Math.max(0, Number(amount) || Math.abs(values[0] || 0) || 0);
    if (!values.length) return 0;
    const last = values[values.length - 1];
    const gross = values.length >= 2 ? values[1] : null;
    if (stake > 0 && gross != null) {
      if (Math.abs(gross - stake) <= Math.max(0.000001, stake * 0.000001) && Math.abs(last) <= 0.000001) return 0;
      if (Math.abs(gross) <= 0.000001 && Math.abs(last) <= 0.000001) return -stake;
      if (gross > stake) return gross - stake;
    }
    if (stake > 0 && Math.abs(last) <= 0.000001 && !/возврат|refund|return|draw|tie|ничья/i.test(String(assetLineText || ''))) return -stake;
    return last;
  }

  function scrapeBrokerClosedDealsFromDom() {
    try {
      const bodyText = String(document.body?.innerText || '').replace(/\u00a0/g, ' ');
      if (!bodyText || !/\b(Сделки|Закрытые|Closed|Trades)\b/i.test(bodyText)) return [];
      const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1600);
      const today = new Date();
      let currentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const found = [];
      const occurrence = new Map();
      const assetLineRe = /(?:[A-Z]{2,5}\/[A-Z]{2,5}|[A-Z]{5,8}|Gold|Silver|UKBrent|USCrude|BTC|ETH|TON|SOL|DOGE)[ A-Z0-9/_-]*(?:OTC)?\s*[+-]\d+(?:[.,]\d+)?\s*%/i;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\d{4}-\d{2}-\d{2}$/.test(line)) {
          currentDate = line;
          continue;
        }
        if (!assetLineRe.test(line)) continue;
        const windowLines = lines.slice(i + 1, Math.min(lines.length, i + 9));
        const timeLine = windowLines.find((item) => /^\d{1,2}:\d{2}$/.test(item));
        const moneyLines = windowLines.map(parseBrokerMoneyText).filter(Boolean);
        if (!timeLine || !moneyLines.length) continue;
        const amount = Math.abs(moneyLines[0].value || 0);
        if (!amount) continue;
        const net = brokerUiDealNet(amount, moneyLines, line);
        const asset = normalizeBrokerUiAsset(line);
        const [hours, minutes] = timeLine.split(':').map((item) => Number(item));
        const [year, month, day] = currentDate.split('-').map((item) => Number(item));
        const date = new Date(year, month - 1, day, hours || 0, minutes || 0, 0, 0);
        const closeTimestamp = Math.floor(date.getTime() / 1000);
        const percent = Number((String(line).match(/([+-]?\d+(?:[.,]\d+)?)\s*%/) || [])[1]?.replace(',', '.'));
        const baseKey = `${currentDate}|${timeLine}|${asset}|${amount.toFixed(8)}|${net.toFixed(8)}`;
        const count = occurrence.get(baseKey) || 0;
        occurrence.set(baseKey, count + 1);
        found.push({
          id: `broker-ui:${baseKey}|${count}`,
          requestId: null,
          asset,
          action: null,
          amount,
          profit: net,
          percentProfit: Number.isFinite(percent) ? Math.abs(percent) : null,
          openPrice: null,
          closePrice: null,
          openTimestamp: closeTimestamp,
          closeTimestamp,
          duration: null,
          currency: latestState?.account?.currency || null,
          isDemo: latestState?.account?.isDemo,
          outcome: net > 0 ? 'win' : net < 0 ? 'loss' : 'draw',
          status: 'closed',
          source: 'broker-ui-live'
        });
      }
      return found.slice(-500);
    } catch (error) {
      return [];
    }
  }

  function sameBrokerUiDeal(left, right) {
    if (!left || !right) return false;
    const leftId = String(left.id || '').trim();
    const rightId = String(right.id || '').trim();
    if (leftId && rightId && leftId === rightId) return true;
    if (String(left.asset || '') !== String(right.asset || '')) return false;
    if (Math.abs((Number(left.amount) || 0) - (Number(right.amount) || 0)) > 1e-8) return false;
    if (Math.abs((Number(left.profit) || 0) - (Number(right.profit) || 0)) > 1e-8) return false;
    const lt = Number(left.closeTimestamp || left.openTimestamp || 0);
    const rt = Number(right.closeTimestamp || right.openTimestamp || 0);
    return lt && rt && Math.abs(lt - rt) <= 60;
  }

  function updateTradeStatisticsFromClosedDeals() {
    if (!latestState?.trades) return;
    const closed = (Array.isArray(latestState.trades.closedDeals) ? latestState.trades.closedDeals : []).filter(isRobotTradeDeal);
    const openRobot = (Array.isArray(latestState.trades.openedDeals) ? latestState.trades.openedDeals : []).filter(isRobotTradeDeal);
    const stats = { total: closed.length, wins: 0, losses: 0, draws: 0, open: openRobot.length, netProfit: 0, invested: 0, winRate: 0 };
    for (const deal of closed) {
      const amount = Math.max(0, finiteNumber(deal?.amount) ?? 0);
      const profit = finiteNumber(deal?.profit ?? deal?.netProfit) ?? 0;
      stats.invested += amount;
      stats.netProfit += profit;
      if (profit > 0) stats.wins += 1;
      else if (profit < 0) stats.losses += 1;
      else stats.draws += 1;
    }
    const decisive = stats.wins + stats.losses;
    stats.winRate = decisive ? stats.wins / decisive * 100 : 0;
    latestState.trades.statistics = stats;
    latestState.trades.closedCount = closed.length;
  }

  function sameExactRobotDealIdentity(left, right) {
    const leftId = String(left?.id || left?.dealId || '').trim();
    const rightId = String(right?.id || right?.dealId || '').trim();
    if (leftId && rightId && leftId === rightId) return true;
    const leftRequest = String(left?.requestId || '').trim();
    const rightRequest = String(right?.requestId || '').trim();
    return Boolean(leftRequest && rightRequest && leftRequest === rightRequest);
  }

  function mergeLiveBrokerClosedDealsIntoState() {
    if (!latestState || typeof latestState !== 'object') return false;
    const liveDeals = scrapeBrokerClosedDealsFromDom();
    if (!liveDeals.length) return false;
    latestState.trades = latestState.trades || {};
    const existing = Array.isArray(latestState.trades.closedDeals) ? [...latestState.trades.closedDeals] : [];
    let changed = false;
    for (const liveDeal of liveDeals) {
      const index = existing.findIndex((item) => isRobotTradeDeal(item) && sameExactRobotDealIdentity(item, liveDeal));
      if (index < 0) continue;
      const merged = {
        ...existing[index],
        ...liveDeal,
        source: 'autotrade',
        robotTrade: true,
        brokerUiLive: true,
        synthetic: false,
        closeConfirmationSource: 'broker_ui'
      };
      if (JSON.stringify(merged) !== JSON.stringify(existing[index])) {
        existing[index] = merged;
        changed = true;
      }
    }
    if (!changed) return false;
    latestState.trades.closedDeals = existing
      .sort((a, b) => Number(a.closeTimestamp || a.openTimestamp || 0) - Number(b.closeTimestamp || b.openTimestamp || 0))
      .slice(-1000);
    updateTradeStatisticsFromClosedDeals();
    return true;
  }

  function slimStateForStorage(value) {
    if (!value || typeof value !== 'object') return value;
    const clone = typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    if (!clone.market) return clone;
    clone.market.historyItems = [];
    clone.market.recentTicks = Array.isArray(clone.market.recentTicks) ? clone.market.recentTicks.slice(-3) : [];
    clone.market.recentCandles = Array.isArray(clone.market.recentCandles) ? clone.market.recentCandles.slice(-2) : [];
    const subscriptions = clone.market.subscriptions || {};
    for (const item of Object.values(subscriptions)) {
      item.historyItems = [];
      item.recentTicks = Array.isArray(item.recentTicks) ? item.recentTicks.slice(-3) : [];
      item.recentCandles = Array.isArray(item.recentCandles) ? item.recentCandles.slice(-2) : [];
    }
    return clone;
  }

  function cacheableHistory(snapshot) {
    const period = Math.max(1, Number(snapshot?.period) || 60);
    const currentTime = Number(snapshot?.currentCandle?.time || 0);
    const byTime = new Map();
    for (const item of [...(snapshot?.historyItems || []), ...(snapshot?.recentCandles || [])]) {
      const time = Number(item?.time || 0);
      if (!time || time === currentTime) continue;
      const open = Number(item?.open), high = Number(item?.high), low = Number(item?.low), close = Number(item?.close);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      byTime.set(time, { time, open, high, low, close, volume: Number.isFinite(Number(item?.volume)) ? Number(item.volume) : undefined });
    }
    return { period, historyItems: [...byTime.values()].sort((a, b) => a.time - b.time).slice(-5000) };
  }

  function queueMarketCacheWrite(asset, snapshot) {
    if (!asset || !snapshot) return;
    const cache = cacheableHistory(snapshot);
    if (cache.historyItems.length < 60) return;
    const key = marketSnapshotKey(asset, cache.period);
    const last = cache.historyItems[cache.historyItems.length - 1];
    const fingerprint = `${cache.period}:${cache.historyItems.length}:${last?.time || 0}:${last?.close || 0}`;
    if (marketCacheFingerprints.get(key) === fingerprint) return;
    if (marketCacheTimers.has(key)) return;
    marketCacheTimers.set(key, setTimeout(async () => {
      marketCacheTimers.delete(key);
      const latest = getMarketSnapshot(asset, cache.period) || snapshot;
      const next = cacheableHistory(latest);
      if (next.historyItems.length < 60) return;
      const nextLast = next.historyItems[next.historyItems.length - 1];
      const nextFingerprint = `${next.period}:${next.historyItems.length}:${nextLast?.time || 0}:${nextLast?.close || 0}`;
      if (marketCacheFingerprints.get(key) === nextFingerprint) return;
      const response = await safeRuntimeMessage({ type: 'PT_MARKET_CACHE_PUT', payload: { asset, period: next.period, historyItems: next.historyItems } });
      if (response?.ok && response?.saved !== false) marketCacheFingerprints.set(key, nextFingerprint);
    }, 1200));
  }

  async function loadStoredData() {
    try {
      const stored = await safeStorageGet(['poBridgeSettings', 'poBridgeState', 'poProfitStats', 'poTradeLedger', 'ptServerState', 'ptExecutedSignals', 'ptAccessNotification', 'ptStatusBarPlacement', 'ptUiLanguage', PENDING_LOGIN_WAIT_STORAGE_KEY, CALIBRATION_STORAGE_KEY], {});
      settings = mergeSettings(stored.poBridgeSettings || {});
      if (settings.autoTrade?.enabled === true && !isAutoTradeArmedForThisTabSession()) {
        // A new tab must never inherit an armed trading state from an old tab.
        // Keep all selected assets, strategies and risk settings, but require the
        // user to turn autotrading on again explicitly.
        settings.autoTrade = {
          ...settings.autoTrade,
          enabled: false,
          sessionStartedAt: null,
          recoveryStartedAt: null
        };
        await safeStorageSet({
          poBridgeSettings: settings,
          poAutoTradeStatus: {
            version: 1,
            enabled: false,
            state: 'off',
            reason: 'new_pocket_tab_session',
            message: 'Автоторговля выключена после открытия новой вкладки Pocket Option. Включите её вручную для новой сессии.',
            updatedAt: new Date().toISOString()
          }
        }).catch(() => null);
      }
      uiLanguage = normalizeUiLanguage(stored.ptUiLanguage);
      statusBarPlacement = normalizeStatusBarPlacement(stored.ptStatusBarPlacement)
        || normalizeStatusBarPlacement(settings.statusBarPosition);
      profitStats = stored.poProfitStats || null;
      robotLedger = stored.poTradeLedger || robotLedger;
      initializeTradeResultNoticeBaseline(robotLedger?.closedDeals || []);
      serverState = stored.ptServerState || null;
      strategyCalibration = normalizeStrategyCalibration(stored[CALIBRATION_STORAGE_KEY]);
      autoRuntime.executedSignals = new Set(Array.isArray(stored.ptExecutedSignals) ? stored.ptExecutedSignals : []);
      autoRuntime.previousStoredConnectionRequested = Boolean(stored.poBridgeState?.connection?.requested || settings.autoTrade?.enabled);
      const waitMarker = stored?.[PENDING_LOGIN_WAIT_STORAGE_KEY];
      const waitMarkerAt = Number(waitMarker?.at || 0);
      guestLaunchWaiting = Boolean(
        isGuestTryDemoPage()
        || (!isRobotEligiblePage(stored.poBridgeState || null) && waitMarkerAt && Date.now() - waitMarkerAt <= PENDING_LOGIN_WAIT_TTL_MS)
      );
      if (stored.ptAccessNotification && Date.now() - Date.parse(stored.ptAccessNotification.createdAt || 0) < 24 * 60 * 60 * 1000) setTimeout(() => void showAccessNotification(stored.ptAccessNotification), 900);
    } catch {
      settings = mergeSettings({});
      statusBarPlacement = null;
      profitStats = null;
      robotLedger = { version: 3, robotOnly: true, closedDeals: [], openDeals: [], summary: {}, today: {} };
      initializeTradeResultNoticeBaseline([]);
      serverState = null;
      strategyCalibration = createEmptyStrategyCalibration();
    }
    scheduleRender(true);
    // Reconcile poAutoTradeStatus immediately after MV3/page reload so a saved
    // enabled=true setting cannot remain displayed as stale state=off.
    scheduleAutoEngine();
    setTimeout(() => void autoRestoreAfterPageLoad(), 1800);
    setTimeout(() => void enforceRegistrationGateFromCurrentAccess('trial_expired_boot'), 450);
  }

  function tradeStateFingerprint(value = latestState) {
    const trades = value?.trades || {};
    const opened = Array.isArray(trades.openedDeals) ? trades.openedDeals : [];
    const closed = Array.isArray(trades.closedDeals) ? trades.closedDeals : [];
    const lastResult = trades.lastResult || {};
    return JSON.stringify({
      opened: opened.map((deal) => [deal?.id, deal?.requestId, deal?.status, deal?.expirationTimestamp]),
      closedCount: closed.length,
      lastClosedId: closed[closed.length - 1]?.id || null,
      lastResult: [lastResult.status, lastResult.dealId, lastResult.requestId, lastResult.time]
    });
  }

  function criticalStateFingerprint(value = latestState) {
    const connection = value?.connection || {};
    const socket = value?.socket || {};
    const account = value?.account || {};
    const login = value?.login || {};
    const market = value?.market || {};
    const selectedAssets = Array.isArray(market.selectedAssets)
      ? market.selectedAssets.map((asset) => String(asset || '')).filter(Boolean).sort()
      : [];
    return JSON.stringify({
      connection: [connection.requested, connection.connected, connection.reconnecting, connection.waitingForLogin, connection.backgroundPaused],
      socket: [socket.authenticated, socket.readyState, socket.host],
      account: [account.uid, account.mode, account.isDemo, account.balance, account.currency, account.sessionCaptured],
      login: [login.authenticated, login.uid],
      market: [market.asset, market.period, Number(market.subscriptionCount || 0), selectedAssets]
    });
  }

  async function persistLatestState() {
    if (!latestState) return;
    try {
      const stateToSave = slimStateForStorage(latestState);
      const tradeFingerprint = tradeStateFingerprint(latestState);
      const criticalFingerprint = criticalStateFingerprint(latestState);
      await safeStorageSet({ poBridgeState: stateToSave });
      lastSavedTradeFingerprint = tradeFingerprint;
      lastSavedCriticalStateFingerprint = criticalFingerprint;
    } catch {
      // При перезагрузке расширения контекст может временно исчезнуть.
    }
  }

  function saveStateSoon(immediate = false) {
    if (immediate) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      void persistLatestState();
      return;
    }
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      await persistLatestState();
    }, STATE_PERSIST_INTERVAL_MS);
  }

  function pageCommand(command, payload = null, timeout = 6000) {
    return new Promise((resolve, reject) => {
      const id = randomId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Команда ${command} не получила ответ от страницы`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ [MARKER]: 'EXTENSION_COMMAND', id, command, payload }, '*');
    });
  }

  function shouldUseTerminalExecutionFallback(official) {
    // A timeout/disconnect after emitEvent is ambiguous: the broker may already
    // have accepted the order. Never send the same logical trade through a second
    // transport; keep it unconfirmed until the broker ledger reconciles it.
    if (official?.unconfirmed === true || official?.submitted === true) return false;
    if (official?.code === 'OFFICIAL_ACCOUNT_AMBIGUOUS') return true;
    const message = String(official?.error || official?.result?.error || '').toLowerCase();
    return Boolean((official?.officialAttempted || official?.skipped) && (
      message.includes('uid')
      || message.includes('не получены автоматически')
      || message.includes('откройте и подключите терминал')
      || message.includes('invalid token')
      || message.includes('client_jwt_access_token')
      || message.includes('jwt')
      || message.includes('auth')
      || message.includes('token')
      || message.includes('websocket')
      || message.includes('socket')
      || message.includes('handshake')
      || message.includes('transport')
      || message.includes('timed out')
      || message.includes('timeout')
      || message.includes('не ответил вовремя')
      || message.includes('network')
    ));
  }

  function terminalExecutionRouteReady() {
    const uid = String(latestState?.account?.uid || '').trim();
    return Boolean(
      uid
      && latestState?.connection?.connected === true
      && latestState?.connection?.authCaptured === true
      && latestState?.socket?.authenticated === true
      && Number(latestState?.socket?.readyState) === 1
    );
  }

  function officialExecutionRouteReady(statusResponse) {
    const state = statusResponse?.state || statusResponse?.result?.state || null;
    return Boolean(
      state?.connected === true
      && state?.authenticated === true
      && state?.socketReady === true
      && state?.socketIoReady === true
    );
  }

  function isRotatingPocketMirrorPage() {
    const host = String(location?.hostname || '').toLowerCase();
    if (!host) return false;
    const stable = ['pocketoption.com', 'po.trade', 'trade.study', 'trade.studio'];
    return !stable.some((base) => host === base || host.endsWith(`.${base}`));
  }

  function canonicalTradePayloadFromPermit(payload, permit) {
    if (!permit || typeof permit !== 'object' || permit.ok !== true) {
      throw new Error('Сервер вернул некорректное разрешение сделки');
    }
    const requestedId = String(payload?.requestId || '').trim();
    const requestedAsset = String(payload?.asset || '').trim();
    const requestedAction = payload?.action === 'put' ? 'put' : payload?.action === 'call' ? 'call' : null;
    const requestedAmount = finiteNumber(payload?.amount);
    const requestedDurationValue = finiteNumber(payload?.duration);
    const requestedDuration = requestedDurationValue == null ? null : Math.floor(requestedDurationValue);
    const requestedStrategyId = String(payload?.strategyId || '').trim();
    const requestedSource = String(payload?.source || '').trim().toLowerCase();

    const requestId = String(permit.requestId || '').trim();
    const asset = String(permit.asset || '').trim();
    const action = permit.action === 'put' ? 'put' : permit.action === 'call' ? 'call' : null;
    const amount = finiteNumber(permit.amount);
    const durationValue = finiteNumber(permit.duration);
    const duration = durationValue == null ? null : Math.floor(durationValue);
    const strategyId = String(permit.strategyId || '').trim();
    const source = String(permit.source || '').trim().toLowerCase();

    if (!requestId || !asset || !action || amount == null || amount <= 0 || duration == null || duration < 1 || duration > 86400) {
      throw new Error('Сервер вернул некорректное разрешение сделки');
    }
    const coreMismatch = (
      requestedId !== requestId
      || requestedAsset !== asset
      || requestedAction !== action
      || requestedAmount == null
      || Math.abs(requestedAmount - amount) > 1e-8
      || requestedDuration !== duration
    );
    const provenanceMismatch = (
      (requestedStrategyId && strategyId && requestedStrategyId !== strategyId)
      || (requestedSource && source && requestedSource !== source)
    );
    if (coreMismatch || provenanceMismatch) {
      throw new Error('Параметры сделки не совпадают с серверным разрешением');
    }
    return {
      ...payload,
      requestId,
      asset,
      action,
      amount,
      duration,
      strategyId: strategyId || requestedStrategyId || null,
      source: source || requestedSource || null,
      executionTicket: null
    };
  }

  async function consumeExecutionPermit(payload) {
    const consumed = await safeRuntimeMessage({
      type: 'PT_CONSUME_TRADE_TICKET',
      payload: {
        ticket: payload?.executionTicket,
        executionDeadlineMs: payload?.executionDeadlineMs
      }
    }, 35000).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    if (!consumed?.ok || !consumed?.permit) {
      throw new Error(consumed?.error || 'Сервер не подтвердил разрешение на исполнение сделки');
    }
    return canonicalTradePayloadFromPermit(payload, consumed.permit);
  }

  async function executeTerminalSessionFallback(payload, timeout, officialMeta = {}) {
    // The MAIN-world bridge must consume the one-time server ticket itself. Passing
    // a ready permit through window messages would let arbitrary page code forge the
    // permit object. The server CORS contract explicitly covers supported Pocket
    // Option domains and rotating mirrors.
    const executionDeadlineMs = Number(payload?.executionDeadlineMs);
    if (Number.isFinite(executionDeadlineMs) && executionDeadlineMs - Date.now() <= 1950) {
      throw new Error('Сигнал устарел до подтверждения разрешения · сделка не отправлена');
    }
    const terminalTimeout = Number.isFinite(executionDeadlineMs)
      ? Math.max(500, Math.min(timeout, executionDeadlineMs - Date.now() - 100))
      : timeout;
    const fallback = await pageCommand('TRADE', payload, terminalTimeout).catch((error) => ({
      ok: false,
      confirmed: false,
      fallback: true,
      officialAttempted: Boolean(officialMeta?.officialAttempted),
      officialError: officialMeta?.error || null,
      error: String(error?.message || error)
    }));
    if (fallback?.ok) {
      return {
        ...fallback,
        executor: officialMeta?.unifiedTerminalRoute ? 'terminal_session_unified' : (officialMeta?.directReadyRoute ? 'terminal_session_ready_route' : 'terminal_session_fallback'),
        officialAttempted: Boolean(officialMeta?.officialAttempted),
        officialFallbackReason: officialMeta?.error || (officialMeta?.directReadyRoute ? 'official_route_not_ready' : 'official_auth_failed'),
        executionRouteHost: String(location?.hostname || ''),
        result: { ...(fallback.result || {}), officialApi: false, terminalFallback: true, unifiedTerminalRoute: officialMeta?.unifiedTerminalRoute === true }
      };
    }
    return {
      ...fallback,
      officialAttempted: Boolean(officialMeta?.officialAttempted),
      officialError: officialMeta?.error || null,
      error: fallback?.error || officialMeta?.error || 'Терминальный WebSocket Pocket Option не подтвердил сделку'
    };
  }

  async function executeTradeCommand(payload, timeout = 45000) {
    const accountMode = String(latestState?.account?.mode || '').toUpperCase() === 'REAL' ? 'REAL' : 'DEMO';
    const executionDeadlineMs = Number(payload?.executionDeadlineMs);
    const hasExecutionDeadline = Number.isFinite(executionDeadlineMs) && executionDeadlineMs > 0;
    const remainingMs = hasExecutionDeadline ? executionDeadlineMs - Date.now() : Infinity;
    if (hasExecutionDeadline && remainingMs <= 1200) {
      throw new Error('Сигнал устарел до отправки торговой команды');
    }
    const executionTimeout = hasExecutionDeadline
      ? Math.max(1000, Math.min(timeout, remainingMs - 100))
      : timeout;

    // v1.0.75: one execution path for every Pocket Option domain.
    // The canonical site and rotating po-*** mirrors must not diverge here. When the
    // browser terminal session already has a concrete UID and an authenticated OPEN
    // trading socket, execute through that exact session on both domains. The same
    // one-time Pocket TRADE ticket, payout floor, risk checks, requestId matching,
    // account mode and broker confirmation remain mandatory. The optional
    // ws.partners-po.com transport is no longer a prerequisite or a pre-trade delay.
    if (terminalExecutionRouteReady()) {
      return executeTerminalSessionFallback(payload, executionTimeout, {
        directReadyRoute: true,
        unifiedTerminalRoute: true,
        officialAttempted: false,
        error: 'unified_authenticated_terminal_route'
      });
    }

    // The official transport runs in the service worker and previously bypassed
    // the page-side one-time-ticket consumption. Consume and canonicalize it here
    // before official execution. The terminal route intentionally keeps receiving
    // only the opaque ticket, never a forgeable ready permit through postMessage.
    const executionPayload = await consumeExecutionPermit(payload);
    const remainingAfterConsume = hasExecutionDeadline ? executionDeadlineMs - Date.now() : Infinity;
    if (hasExecutionDeadline && remainingAfterConsume <= 1200) {
      throw new Error('Сигнал устарел до отправки торговой команды');
    }
    const officialExecutionTimeout = hasExecutionDeadline
      ? Math.max(1000, Math.min(timeout, remainingAfterConsume - 100))
      : timeout;

    let official = await safeRuntimeMessage({
      type: 'PT_OFFICIAL_TRADE',
      payload: { ...executionPayload, accountMode }
    }, hasExecutionDeadline ? officialExecutionTimeout : timeout + 2000).catch((error) => ({
      ok: false,
      confirmed: false,
      unconfirmed: true,
      submitted: true,
      fallback: false,
      officialAttempted: true,
      requestId: payload?.requestId || null,
      result: { status: 'unconfirmed', requestId: payload?.requestId || null },
      error: String(error?.message || error)
    }));

    // safeRuntimeMessage resolves transport failures instead of rejecting them.
    // Once PT_OFFICIAL_TRADE has been dispatched, a missing runtime response does
    // not prove that the broker order was not emitted. Treat the delivery result
    // as ambiguous so neither the terminal fallback nor recovery retry can submit
    // the same logical request a second time.
    if (!official?.ok && (
      official?.code === 'RUNTIME_MESSAGE_TIMEOUT'
      || official?.code === 'RUNTIME_MESSAGE_ERROR'
      || official?.code === 'EXTENSION_CONTEXT_INVALIDATED'
    )) {
      official = {
        ...official,
        confirmed: false,
        unconfirmed: true,
        submitted: true,
        fallback: false,
        officialAttempted: true,
        requestId: official?.requestId || payload?.requestId || null,
        result: {
          ...(official?.result || {}),
          status: 'unconfirmed',
          requestId: official?.requestId || payload?.requestId || null
        }
      };
    }

    if (official?.ok) return official;

    if (official?.unconfirmed === true || official?.submitted === true) {
      return {
        ...official,
        ok: false,
        confirmed: false,
        unconfirmed: true,
        result: { ...(official?.result || {}), status: 'unconfirmed', requestId: official?.requestId || payload?.requestId || null }
      };
    }

    // Pocket Partners API requires a dedicated CLIENT_JWT_ACCESS_TOKEN. If the
    // official transport/auth route fails, keep the already-authorized terminal
    // execution path available instead of stalling a short-lived signal.
    if (shouldUseTerminalExecutionFallback(official)) {
      return executeTerminalSessionFallback(payload, officialExecutionTimeout, {
        officialAttempted: true,
        error: official?.error || null
      });
    }

    throw new Error(official?.error || 'Официальное исполнение Pocket Option не подтвердило сделку');
  }



  function normalizeGraphPeriods(rawPeriods, fallback = 60) {
    const values = Array.isArray(rawPeriods) ? rawPeriods : [rawPeriods];
    const periods = values
      .map((value) => normalizeAnalysisPeriodSeconds(value, fallback))
      .filter((value) => Number.isFinite(value) && value > 0);
    return [...new Set(periods)].sort((a, b) => a - b);
  }

  function seedGraphCacheRecords(records, period) {
    if (!records || typeof records !== 'object') return 0;
    let seeded = 0;
    for (const [asset, record] of Object.entries(records)) {
      const historyItems = Array.isArray(record?.historyItems) ? record.historyItems : [];
      if (Number(record?.period || period) !== Number(period) || historyItems.length < 20) continue;
      const snapshot = putMarketSnapshot(asset, {
        asset,
        period,
        historyItems: historyItems.slice(-5000),
        historyCount: historyItems.length,
        historyReceivedAt: record.receivedAt || new Date().toISOString(),
        recentCandles: historyItems.slice(-3),
        recentTicks: [],
        currentCandle: null,
        requested: true,
        subscribed: false,
        streamActive: false,
        source: 'extension-cache'
      });
      if (snapshot) seeded += 1;
    }
    return seeded;
  }

  function graphPeriodAssets(period) {
    const scoped = graphSubscriptionManager.assetsByPeriod?.[period];
    return Array.isArray(scoped) ? scoped : graphSubscriptionManager.assets;
  }

  function graphPeriodReadyCount(period, assets = graphPeriodAssets(period)) {
    let ready = 0;
    for (const asset of assets) {
      const snapshot = getMarketSnapshot(asset, period);
      if (snapshot && Number(snapshot.period) === Number(period) && Array.isArray(snapshot.historyItems) && snapshot.historyItems.length >= 40) ready += 1;
    }
    return ready;
  }

  async function waitForGraphPeriodCoverage(period, token, timeoutMs = 90000) {
    const periodAssets = graphPeriodAssets(period);
    const total = periodAssets.length;
    if (!total) return { ready: 0, total: 0, complete: true };
    const target = Math.max(1, Math.ceil(total * 0.55));
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 90000);
    let ready = graphPeriodReadyCount(period, periodAssets);
    while (ready < target && Date.now() < deadline) {
      if (!graphSubscriptionManager.enabled || token !== graphSubscriptionManager.token) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      ready = graphPeriodReadyCount(period, periodAssets);
    }
    return { ready, total, complete: ready >= target };
  }

  function scheduleGraphSubscriptionRefresh(delayMs = 1000) {
    if (graphSubscriptionManager.timer) clearTimeout(graphSubscriptionManager.timer);
    if (!graphSubscriptionManager.enabled) return;
    graphSubscriptionManager.timer = setTimeout(() => {
      graphSubscriptionManager.timer = null;
      void runGraphSubscriptionRefresh();
    }, Math.max(250, Number(delayMs) || 1000));
  }

  async function runGraphSubscriptionRefresh() {
    if (!graphSubscriptionManager.enabled || extensionContextInvalidated) return;
    const token = graphSubscriptionManager.token;
    if (!isConnected()) {
      scheduleGraphSubscriptionRefresh(2000);
      return;
    }
    const now = Date.now();
    // Bootstrap only one secondary timeframe at a time. Opening a WebSocket lane
    // for every TF simultaneously overloads Pocket Option on large asset sets and
    // can make the real account socket look as if it is reconnecting.
    const duePeriods = [...graphSubscriptionManager.bootstrapPendingPeriods]
      .filter((period) => !graphSubscriptionManager.inFlightPeriods.has(period))
      .filter((period) => Number(graphSubscriptionManager.refreshDueAt.get(period) || 0) <= now)
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, 1);

    if (!duePeriods.length) {
      graphSubscriptionManager.bootstrapping = graphSubscriptionManager.bootstrapPendingPeriods.size > 0;
      if (graphSubscriptionManager.bootstrapping) {
        const nextDue = Math.min(...[...graphSubscriptionManager.bootstrapPendingPeriods].map((period) => Number(graphSubscriptionManager.refreshDueAt.get(period) || now + 3000)));
        scheduleGraphSubscriptionRefresh(Math.max(300, Math.min(5000, nextDue - now)));
      }
      return;
    }

    for (const period of duePeriods) graphSubscriptionManager.inFlightPeriods.add(period);
    await Promise.allSettled(duePeriods.map(async (period) => {
      const periodAssets = graphPeriodAssets(period);
      if (!periodAssets.length) {
        graphSubscriptionManager.bootstrapPendingPeriods.delete(period);
        graphSubscriptionManager.refreshDueAt.delete(period);
        return;
      }
      const historyOffset = Math.max(60, Math.min(5000, Number(graphSubscriptionManager.historyOffsets?.[period]) || 180));
      let success = false;
      try {
        const response = await pageCommand('HISTORY', {
          assets: periodAssets,
          period,
          historyOffset,
          offset: historyOffset,
          reset: false,
          hiddenGraphManager: true,
          sequentialTimeframeBootstrap: true
        }, 15000);
        success = response?.ok !== false;
        if (success) {
          const coverage = await waitForGraphPeriodCoverage(period, token, Math.max(45000, periodAssets.length * 900));
          success = coverage.complete;
        }
      } catch {}
      if (token !== graphSubscriptionManager.token || !graphSubscriptionManager.enabled) return;
      const attempts = Number(graphSubscriptionManager.bootstrapAttempts.get(period) || 0) + 1;
      graphSubscriptionManager.bootstrapAttempts.set(period, attempts);
      if (success || attempts >= 3) {
        graphSubscriptionManager.bootstrapPendingPeriods.delete(period);
        graphSubscriptionManager.refreshDueAt.delete(period);
      } else {
        graphSubscriptionManager.refreshDueAt.set(period, Date.now() + 3000);
      }
    }));

    for (const period of duePeriods) graphSubscriptionManager.inFlightPeriods.delete(period);
    if (token !== graphSubscriptionManager.token || !graphSubscriptionManager.enabled) return;
    graphSubscriptionManager.bootstrapping = graphSubscriptionManager.bootstrapPendingPeriods.size > 0;
    if (graphSubscriptionManager.bootstrapping) scheduleGraphSubscriptionRefresh(250);
  }

  function startGraphSubscriptionManager({ assets, assetsByPeriod = {}, periods, primaryPeriod, historyOffsets = {} } = {}) {
    stopGraphSubscriptionManager();
    const normalizedAssets = [...new Set((Array.isArray(assets) ? assets : []).map((item) => String(item || '').trim()).filter(Boolean))];
    const normalizedPeriods = normalizeGraphPeriods(periods, primaryPeriod || 60);
    if (!normalizedAssets.length || !normalizedPeriods.length) return;
    graphSubscriptionManager.enabled = true;
    graphSubscriptionManager.assets = normalizedAssets;
    graphSubscriptionManager.periods = normalizedPeriods;
    graphSubscriptionManager.primaryPeriod = normalizeAnalysisPeriodSeconds(primaryPeriod || normalizedPeriods[0], normalizedPeriods[0]);
    graphSubscriptionManager.assetsByPeriod = Object.fromEntries(normalizedPeriods.map((period) => [
      period,
      [...new Set((Array.isArray(assetsByPeriod?.[period]) ? assetsByPeriod[period] : normalizedAssets)
        .map((item) => String(item || '').trim())
        .filter((item) => normalizedAssets.includes(item)))]
    ]));
    graphSubscriptionManager.historyOffsets = { ...historyOffsets };
    graphSubscriptionManager.bootstrapAttempts.clear();
    const secondaryPeriods = normalizedPeriods.filter((period) =>
      Number(period) !== Number(graphSubscriptionManager.primaryPeriod)
      && graphPeriodAssets(period).length > 0
    );
    graphSubscriptionManager.bootstrapPendingPeriods = new Set(secondaryPeriods);
    graphSubscriptionManager.bootstrapping = secondaryPeriods.length > 0;
    const now = Date.now();
    for (const period of secondaryPeriods) graphSubscriptionManager.refreshDueAt.set(period, now);
    scheduleGraphSubscriptionRefresh(120);
  }

  async function collectStrategyTesterHistory(payload = {}) {
    const assets = Array.isArray(payload.assets)
      ? [...new Set(payload.assets.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 30)
      : selectedAutotradeAssets().slice(0, 30);
    const periods = Array.isArray(payload.periods)
      ? [...new Set(payload.periods.map(Number).filter((item) => Number.isFinite(item) && item > 0).map((item) => normalizeAnalysisPeriodSeconds(item, 60)))].slice(0, 12)
      : [normalizeAnalysisPeriodSeconds(settings.autoTrade?.period || settings.period || 60, 60)];
    // Keep the tester collector aligned with the real bridge capacity. The old
    // hidden 1 500 cap made a visible 5 000 request silently return less data.
    const historyOffset = Math.max(60, Math.min(5000, Math.floor(Number(payload.historyOffset) || 500)));
    if (!assets.length) return { ok: false, error: 'Не выбраны активы для тестера' };
    if (!isConnected()) {
      await pageCommand('CONNECT', null, 15000).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    const records = {};
    const collected = [];
    for (const period of periods) {
      const cached = await safeRuntimeMessage({ type: 'PT_MARKET_CACHE_GET', payload: { assets, period } }).catch(() => null);
      const historyRequest = await pageCommand('HISTORY', {
        assets,
        period,
        historyOffset,
        offset: historyOffset,
        reset: false,
        tester: true,
        sequentialTimeframeBootstrap: true
      }, Math.max(9000, assets.length * 350)).catch((error) => ({ ok: false, error: String(error?.message || error) }));
      if (historyRequest?.ok === false) return { ok: false, error: historyRequest.error || `Не удалось запросить историю ${period} сек` };
      const deadline = Date.now() + Math.max(8000, Math.min(30000, assets.length * 2500));
      // Wait for the requested depth, not merely the first 500 candles.
      // The deadline below still allows partial history when Pocket has less data
      // or the broker stream is slow.
      const readyTarget = historyOffset;
      while (Date.now() < deadline) {
        const ready = assets.filter((asset) => {
          const snap = getMarketSnapshot(asset, period) || {};
          return Number(snap.period || period) === Number(period) && Array.isArray(snap.historyItems) && snap.historyItems.length >= readyTarget;
        }).length;
        if (ready >= assets.length) break;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      for (const asset of assets) {
        const snap = getMarketSnapshot(asset, period) || {};
        const candles = Array.isArray(snap.historyItems) ? snap.historyItems : [];
        const recent = Array.isArray(snap.recentCandles) ? snap.recentCandles : [];
        const cachedCandles = Array.isArray(cached?.records?.[asset]?.historyItems)
          ? cached.records[asset].historyItems
          : [];
        const brokerOffset = finiteNumber(latestState?.market?.brokerClockOffsetSec) ?? 0;
        const expectedCurrentBucket = Math.floor((Date.now() / 1000 + brokerOffset) / period) * period;
        let currentCandleTime = finiteNumber(snap.currentCandle?.time);
        if (currentCandleTime == null || Math.floor(currentCandleTime / period) * period !== expectedCurrentBucket) {
          const latestRecentTime = recent.reduce((latest, item) => Math.max(latest, Number(item?.time) || 0), 0);
          currentCandleTime = latestRecentTime && Math.floor(latestRecentTime / period) * period === expectedCurrentBucket
            ? latestRecentTime
            : null;
        }
        const mergedByTime = new Map();
        for (const raw of [...cachedCandles, ...candles, ...recent]) {
          if (!raw || raw.time == null) continue;
          const candleTime = Number(raw.time);
          // recentCandles may include the still-forming candle. Match the live
          // engine's broker-time bucket check and exclude that entire bucket.
          if (currentCandleTime != null && Math.floor(candleTime / period) * period === Math.floor(currentCandleTime / period) * period) continue;
          mergedByTime.set(candleTime, raw);
        }
        const normalized = [...mergedByTime.values()]
          .map((candle) => ({
            time: Math.floor(Number(candle.time) || 0),
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close),
            volume: Number(candle.volume || 0),
            ticks: Number(candle.ticks || 0)
          }))
          .filter((candle) => candle.time
            && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
            && candle.high >= candle.low
            && candle.high >= Math.max(candle.open, candle.close)
            && candle.low <= Math.min(candle.open, candle.close))
          .sort((a, b) => a.time - b.time)
          .slice(-historyOffset);
        records[`${asset}|${period}`] = {
          asset,
          period,
          candles: normalized,
          payout: finiteNumber(snap.payout) ?? finiteNumber(latestState?.market?.subscriptions?.[asset]?.payout) ?? null,
          precision: period <= 30 ? 'turbo-candles' : 'candles',
          receivedAt: new Date().toISOString()
        };
        collected.push({ asset, period, candles: normalized.length });
      }
    }
    return { ok: true, records, collected, assets, periods, historyOffset };
  }

  async function syncGuestLoginHandoff(state = latestState) {
    try {
      const connected = isConnected(state);
      const waiting = Boolean(state?.connection?.waitingForLogin && !connected);
      if (connected) {
        await chrome.storage.local.remove(LOGIN_HANDOFF_STORAGE_KEY).catch(() => null);
        return;
      }
      if (waiting) {
        await chrome.storage.local.set({
          [LOGIN_HANDOFF_STORAGE_KEY]: { at: Date.now(), origin: location.origin, reason: state?.connection?.loginWaitReason || 'waiting_auth' }
        }).catch(() => null);
        return;
      }
      const stored = await chrome.storage.local.get(LOGIN_HANDOFF_STORAGE_KEY).catch(() => ({}));
      const marker = stored?.[LOGIN_HANDOFF_STORAGE_KEY];
      const at = Number(marker?.at || 0);
      if (!at || Date.now() - at > LOGIN_HANDOFF_TTL_MS) {
        if (marker) await chrome.storage.local.remove(LOGIN_HANDOFF_STORAGE_KEY).catch(() => null);
        return;
      }
      const now = Date.now();
      if (now - loginHandoffAttemptAt < 1800) return;
      loginHandoffAttemptAt = now;
      const result = await pageCommand('CONNECT', null, 5500).catch(() => null);
      if (result?.ok && !result?.waitingAuth && result?.status !== 'waiting_auth') {
        await chrome.storage.local.remove(LOGIN_HANDOFF_STORAGE_KEY).catch(() => null);
        setTimeout(() => void safeRuntimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: true }).catch(() => null), 500);
      }
    } catch {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || !message[MARKER]) return;

    if (message[MARKER] === 'PAGE_CONSUME_LOCAL_TICKET' && message.requestId && message.ticket) {
      void safeRuntimeMessage({
        type: 'PT_CONSUME_TRADE_TICKET',
        payload: { ticket: message.ticket, executionDeadlineMs: message.executionDeadlineMs }
      }, 20000).then((result) => {
        window.postMessage({
          [MARKER]: 'CONTENT_LOCAL_TICKET_RESULT',
          requestId: message.requestId,
          ok: Boolean(result?.ok && result?.permit),
          permit: result?.permit || null,
          error: result?.error || null
        }, '*');
      }).catch((error) => {
        window.postMessage({
          [MARKER]: 'CONTENT_LOCAL_TICKET_RESULT',
          requestId: message.requestId,
          ok: false,
          error: String(error?.message || error)
        }, '*');
      });
      return;
    }

    if (message[MARKER] === 'PAGE_OFFICIAL_AUTH' && message.auth) {
      void safeRuntimeMessage({ type: 'PT_POCKET_PARTNERS_CAPTURE_AUTH', payload: message.auth }, 5000).catch(() => null);
      return;
    }

    if (message[MARKER] === 'PAGE_STATE' && message.state) {
      latestState = mergeCompactStateWithSnapshots(message.state);
      if (isConnected(latestState) || isRobotEligiblePage(latestState)) {
        if (guestLaunchWaiting) guestLaunchWaiting = false;
        void chrome.storage.local.remove(PENDING_LOGIN_WAIT_STORAGE_KEY).catch(() => null);
      }
      const liveStatsChanged = mergeLiveBrokerClosedDealsIntoState();
      notifyClosedTradesFromState(latestState);
      const marketAt = latestMarketActivityMs(latestState);
      if (marketAt) autoRuntime.lastMarketTickAt = marketAt;
      reconcileActiveAutoTrades();
      const martingaleRiskStopReason = martingaleStopReasonForAuto(settings.autoTrade || {});
      if (martingaleRiskStopReason) {
        // stopAutoTradingByRisk disables settings synchronously before its first
        // await, so the scheduler below cannot admit another signal in this tick.
        void stopAutoTradingByRisk(martingaleRiskStopReason).catch(() => null);
      } else {
        void maybeRunFollowSignalRecovery('page_state').catch(() => null);
      }
      void updateStrategyCalibrationFromState(latestState);
      const nextTradeFingerprint = tradeStateFingerprint(latestState);
      const nextCriticalStateFingerprint = criticalStateFingerprint(latestState);
      saveStateSoon(
        liveStatsChanged
        || nextTradeFingerprint !== lastSavedTradeFingerprint
        || nextCriticalStateFingerprint !== lastSavedCriticalStateFingerprint
      );
      scheduleRender();
      scheduleAutoEngine();
      void syncGuestLoginHandoff(latestState);
      scheduleSnapshotPublish(false, 80);
      return;
    }

    if (message[MARKER] === 'PAGE_MARKET_DATA' && message.asset && message.snapshot) {
      const asset = String(message.asset);
      const period = Math.max(1, Number(message.snapshot?.period || message.period) || 60);
      const previous = getMarketSnapshot(asset, period) || {};
      const pocketKey = marketSnapshotKey(asset, period);
      const previousPocket = pocketMarketSnapshots.get(pocketKey) || {};
      const pocketSnapshot = { ...previousPocket, ...message.snapshot, asset, period, source: message.snapshot?.source || 'pocket-option' };
      pocketMarketSnapshots.set(pocketKey, pocketSnapshot);
      const primaryPocketPeriod = Number(latestState?.market?.period || graphSubscriptionManager.primaryPeriod || 0);
      if (!pocketMarketSnapshots.has(asset) || period === primaryPocketPeriod) pocketMarketSnapshots.set(asset, pocketSnapshot);
      const mergedSnapshot = putMarketSnapshot(asset, pocketSnapshot);
      if (latestState?.market && mergedSnapshot) {
        const primaryPeriod = Number(latestState.market.period || graphSubscriptionManager.primaryPeriod || 0);
        if (period === primaryPeriod) {
          latestState.market.subscriptions = latestState.market.subscriptions || {};
          latestState.market.subscriptions[asset] = { ...(latestState.market.subscriptions[asset] || {}), ...mergedSnapshot };
        } else {
          latestState.market.timeframeSubscriptions = latestState.market.timeframeSubscriptions || {};
          latestState.market.timeframeSubscriptions[marketSnapshotKey(asset, period)] = {
            ...(latestState.market.timeframeSubscriptions[marketSnapshotKey(asset, period)] || {}),
            ...mergedSnapshot
          };
        }
      }
      const previousCandle = Array.isArray(previous.recentCandles) ? previous.recentCandles[previous.recentCandles.length - 1] : null;
      const nextCandle = Array.isArray(message.snapshot.recentCandles) ? message.snapshot.recentCandles[message.snapshot.recentCandles.length - 1] : null;
      const candleChanged = Boolean(nextCandle && (`${nextCandle.time}:${nextCandle.close}` !== `${previousCandle?.time}:${previousCandle?.close}`));
      if (mergedSnapshot && (Array.isArray(message.snapshot.historyItems) || candleChanged)) queueMarketCacheWrite(asset, mergedSnapshot);
      scheduleAutoEngine();
      // Coalesce bursts from many assets/timeframes into one parallel sweep.
      scheduleSnapshotPublish(false, candleChanged ? 20 : 90);
      return;
    }

    if (message[MARKER] === 'PAGE_RESPONSE' && message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.ok) item.resolve(message.result);
      else item.reject(new Error(message.error || 'Команда не выполнена'));
    }
  });


  function findStatusBarDock() {
    const headerRow = document.querySelector('header.site-header .wrapper_top')
      || document.querySelector('.wrapper_top')
      || document.querySelector('header.site-header');
    const rightBlock = document.querySelector('.right-block.js-right-block')
      || document.querySelector('header.site-header .wrapper_top .right-block')
      || document.querySelector('.right-block');
    return { headerRow, rightBlock };
  }

  function isStatusBarDockUsable(node) {
    if (!node?.isConnected) return false;
    try {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
      return node.getBoundingClientRect().width >= 180;
    } catch {
      // A transient layout read must not prevent the normal dock attempt.
      return true;
    }
  }

  function isStatusBarHostActuallyVisible() {
    if (!host?.isConnected) return false;
    try {
      const style = window.getComputedStyle(host);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
      const rect = host.getBoundingClientRect();
      return rect.width >= 120
        && rect.height >= 20
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < window.innerWidth
        && rect.top < window.innerHeight;
    } catch {
      return false;
    }
  }

  function statusBarNeedsRecovery() {
    if (settings.statusBarVisible === false) return false;
    if (!host?.isConnected || !isStatusBarHostActuallyVisible()) return true;
    return host.dataset.ptStatusBarMode === 'docked' && !isStatusBarDockUsable(host.parentElement);
  }

  function setStatusBarHostMode(mode) {
    if (!host) return;
    const floating = mode === 'floating';
    host.dataset.ptStatusBarMode = floating ? 'floating' : 'docked';
    if (floating) {
      Object.assign(host.style, {
        position: 'fixed',
        top: '',
        right: '',
        left: '',
        zIndex: '2147483000',
        width: 'min(820px, calc(100vw - 28px))',
        minWidth: 'min(560px, calc(100vw - 28px))',
        maxWidth: 'min(820px, calc(100vw - 28px))',
        margin: '0',
        alignSelf: 'auto'
      });
      Object.assign(host.style, { left: 'auto', top: '68px', right: '14px' });
      return;
    }
    Object.assign(host.style, {
      position: 'static',
      top: '',
      right: '',
      left: '',
      zIndex: '',
      width: '',
      minWidth: '560px',
      maxWidth: '820px',
      margin: '0 14px',
      alignSelf: 'center'
    });
  }

  function mountStatusBarFallback() {
    if (!host) return false;
    const fallbackParent = document.body || document.documentElement;
    if (!fallbackParent) return false;
    if (host.parentElement !== fallbackParent) fallbackParent.appendChild(host);
    setStatusBarHostMode('floating');
    host.style.visibility = 'visible';
    return true;
  }

  function mountStatusBarHost() {
    if (!host) return false;
    const cachedRightBlockHealthy = !statusHostRightBlock
      || (statusHostRightBlock.isConnected && host.nextElementSibling === statusHostRightBlock);
    if (isStatusBarDockUsable(statusHostDock) && host.parentElement === statusHostDock && cachedRightBlockHealthy) {
      setStatusBarHostMode('docked');
      host.style.visibility = 'visible';
      return true;
    }
    const { headerRow, rightBlock } = findStatusBarDock();
    if (!isStatusBarDockUsable(headerRow)) return false;
    setStatusBarHostMode('docked');
    if (host.parentElement !== headerRow) {
      try {
        headerRow.insertBefore(host, rightBlock || null);
      } catch {
        headerRow.appendChild(host);
      }
    } else if (rightBlock && host.nextElementSibling !== rightBlock) {
      try {
        headerRow.insertBefore(host, rightBlock);
      } catch {}
    }
    statusHostDock = headerRow;
    statusHostRightBlock = rightBlock || null;
    host.style.visibility = 'visible';
    return true;
  }



  function ensureStatusBar() {
    if (host && shadow) {
      if (!mountStatusBarHost()) mountStatusBarFallback();
      host.style.visibility = 'visible';
      return;
    }
    host = document.createElement('div');
    host.id = PT_STATUS_BAR_HOST_ID;
    host.dataset.ptStatusBarOwner = PT_STATUS_BAR_OWNER;
    host.style.cssText = 'all:initial;display:block;flex:1 1 720px;min-width:560px;max-width:820px;margin:0 14px;pointer-events:auto;visibility:hidden;align-self:center;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box}:host{all:initial}
        .bar{display:flex;align-items:center;gap:10px;min-height:40px;width:100%;max-width:100%;padding:4px 10px;border:1px solid rgba(92,112,211,.36);border-radius:12px;background:linear-gradient(135deg,rgba(6,10,27,.97),rgba(10,15,38,.97));box-shadow:0 10px 28px rgba(0,0,0,.38);backdrop-filter:blur(14px);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#edf3ff;white-space:nowrap;user-select:none;transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease}
        .bar.pulse{animation:ptBarPulse 1.15s ease 2}
        @keyframes ptBarPulse{0%{transform:scale(1);box-shadow:0 10px 28px rgba(0,0,0,.38)}35%{transform:scale(1.01);box-shadow:0 16px 42px rgba(17,110,255,.32)}100%{transform:scale(1)}}
        .led{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:#596278;box-shadow:0 0 0 3px rgba(89,98,120,.08)}.connected .led{background:#36df91;box-shadow:0 0 8px rgba(54,223,145,.9)}.reconnecting .led{background:#ffc35b;box-shadow:0 0 8px rgba(255,195,91,.8)}
        .status{flex:0 0 auto;color:#b9c4db;font-size:11px;font-weight:850}.connected .status{color:#72e9ae}.reconnecting .status{color:#ffd486}
        .mode{flex:0 0 auto;padding:3px 7px;border:1px solid rgba(63,142,255,.3);border-radius:7px;background:rgba(42,94,190,.15);color:#c8dcff;font-size:10px;font-weight:900;letter-spacing:.04em}.trialAccess{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;padding:4px 7px;border:1px solid rgba(255,197,69,.38);border-radius:7px;background:rgba(255,176,40,.1);color:#ffe19a;font-size:9px;font-weight:900;cursor:pointer;font-variant-numeric:tabular-nums}.trialAccess[hidden]{display:none}.trialAccess.expired{border-color:rgba(255,83,111,.45);background:rgba(255,54,88,.09);color:#ff9eb0}.trialAccess.registered{border-color:rgba(66,169,255,.42);background:rgba(43,134,255,.09);color:#9bd5ff}.trialAccess.premium{border-color:rgba(60,220,143,.38);background:rgba(41,198,129,.08);color:#8beebd}
        .metric{flex:0 0 auto;overflow:visible;text-overflow:clip;padding-left:8px;border-left:1px solid rgba(105,122,176,.15);color:#e6ebf8;font-size:11px;font-weight:800}.metric.uid{color:#9fb2d3}.metric.profit{color:#49e49a}.metric.loss{color:#ff728b}.metric.neutral{color:#d5dced}
        .openButton{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:30px;flex:0 0 auto;padding:0 16px;border:1px solid rgba(82,171,255,.42);border-radius:9px;background:linear-gradient(135deg,#1e6dff,#35a3ff);color:#fff;cursor:pointer;pointer-events:auto;touch-action:manipulation;font:900 11px/1 system-ui;box-shadow:0 10px 24px rgba(37,128,255,.3);transition:transform .08s ease,filter .12s ease,box-shadow .12s ease}.openButton:hover{filter:brightness(1.08)}.openButton:active{transform:translateY(1px) scale(.985);filter:brightness(.96);box-shadow:0 5px 14px rgba(37,128,255,.26)}.openButton .icon{font-size:13px;line-height:1}.openButton .label{display:inline-block;overflow:visible;text-overflow:clip}
        @media(max-width:1360px){:host{min-width:500px!important;max-width:680px!important;margin:0 10px!important}.bar{gap:8px;padding:4px 8px}.openButton{padding:0 12px}.openButton .label{max-width:190px;overflow:hidden;text-overflow:ellipsis}}
        @media(max-width:1120px){:host{min-width:420px!important;max-width:560px!important}.metric.uid{display:none}.status{max-width:95px;overflow:hidden;text-overflow:ellipsis}.openButton .label{max-width:150px;overflow:hidden;text-overflow:ellipsis}}
        @media(max-width:960px){:host{min-width:340px!important;max-width:430px!important}.status,.metric.uid{display:none}.metric{font-size:10px;padding-left:5px}.openButton{height:28px;padding:0 10px}.openButton .label{max-width:118px;overflow:hidden;text-overflow:ellipsis}}
      </style>
      <div class="bar" id="bar">
        <span class="led" id="connLed"></span>
        <strong class="status" id="statusText">Не подключено</strong>
        <span class="mode" id="mode">—</span>
        <button class="trialAccess" id="trialAccess" type="button" hidden>♛ TRIAL 24:00:00</button>
        <span class="metric uid" id="uid">UID —</span>
        <span class="metric" id="balance">—</span>
        <span class="metric neutral" id="profit">0</span>
        <button class="openButton" id="open" title="Открыть Pocket TRADE ROBOT" aria-label="Открыть Pocket TRADE ROBOT"><span class="icon">⚡</span><span class="label">Открыть Pocket TRADE ROBOT</span></button>
      </div>`;

    shadow.getElementById('trialAccess').addEventListener('click', async () => {
      const entitlement = serverState?.entitlement || {};
      const accessState = String(entitlement.accessState || '').toUpperCase();
      pulseStatusBar();
      if (['TRIAL_EXPIRED','AFFILIATE_REGISTERED','PREMIUM_PAUSED'].includes(accessState)) {
        await safeStorageSet({ ptRequestedDashboardTab: 'premium' });
        await openEmbeddedDashboard({ source: 'trial_access_badge' }).catch(() => null);
        return;
      }
      if (accessState === 'TRIAL_ACTIVE') {
        showLocalStatusNotice('TRIAL Premium активен', 'Полный доступ действует до окончания серверного таймера.', 'success', 4500);
      } else if (entitlement.premium) {
        showLocalStatusNotice('Premium активен', 'Все доступные функции подтверждены сервером.', 'success', 4500);
      }
    });

    shadow.getElementById('open').addEventListener('click', async () => {
      // Never latch/disable this button on a guest page. Every click remains a
      // valid retry after Pocket navigation or passive login detection changes.
      pulseStatusBar();
      await openEmbeddedDashboard({ source: 'status_bar_docked' }).catch(() => null);
    });

    if (!statusHostObserver && document.documentElement) {
      statusHostObserver = new MutationObserver((mutations) => {
        if (!host) return;
        // Ignore mutations caused only by our own inline visibility/style
        // recovery to avoid a self-triggered observer loop.
        if (mutations.length && mutations.every((item) => item.target === host)) return;
        const rightBlockHealthy = !statusHostRightBlock
          || (statusHostRightBlock.isConnected && host.nextElementSibling === statusHostRightBlock);
        const floating = host.dataset.ptStatusBarMode === 'floating';
        if (!floating && !statusBarNeedsRecovery() && rightBlockHealthy) return;
        if (statusHostRemountTimer) return;
        statusHostRemountTimer = setTimeout(() => {
          statusHostRemountTimer = null;
          if (!host) return;
          if (!mountStatusBarHost()) mountStatusBarFallback();
        }, 250);
      });
      statusHostObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
      });
    }
    if (!mountStatusBarHost()) {
      mountStatusBarFallback();
    }
    host.style.visibility = 'visible';
  }

  function scheduleRender(immediate = false) {
    if (immediate) {
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = null;
      renderStatusBar();
      return;
    }
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderStatusBar();
    }, 100);
  }

  function pulseStatusBar() {
    try {
      ensureStatusBar();
      const bar = shadow?.getElementById('bar');
      if (!bar) return;
      bar.classList.remove('pulse');
      void bar.offsetWidth;
      bar.classList.add('pulse');
      setTimeout(() => bar.classList.remove('pulse'), 2400);
    } catch {}
  }


  function renderStatusBar() {
    if (!document.documentElement) return;
    ensureStatusBar();

    host.style.setProperty('display', settings.statusBarVisible === false ? 'none' : 'block', 'important');
    host.style.setProperty('visibility', settings.statusBarVisible === false ? 'hidden' : 'visible', 'important');
    if (settings.statusBarVisible === false) return;

    const bar = shadow.getElementById('bar');
    const connected = isConnected();
    // Route state has priority over stale/persisted connection flags. Once the
    // user reaches an authenticated-looking /cabinet/ route, the next expected
    // step is Robot account connection/UID capture, not another login prompt.
    const waitingForConnection = Boolean(!connected && isPocketCabinetPage() && !isGuestTryDemoPage());
    const waitingForLogin = Boolean(
      !connected && !waitingForConnection && (
        isGuestTryDemoPage()
        || latestState?.connection?.waitingForLogin
        || (guestLaunchWaiting && !isRobotEligiblePage(latestState))
      )
    );
    const reconnecting = Boolean(latestState?.connection?.requested && latestState?.connection?.reconnecting);
    bar.classList.toggle('connected', connected);
    bar.classList.toggle('reconnecting', (reconnecting || waitingForLogin || waitingForConnection) && !connected);

    shadow.getElementById('statusText').textContent = connected
      ? tr('Подключено', 'Connected')
      : waitingForLogin
        ? tr('Ожидаю входа…', 'Waiting for login…')
        : waitingForConnection
          ? tr('Ожидаю подключения…', 'Waiting for connection…')
          : reconnecting
            ? tr('Переподключение…', 'Reconnecting…')
            : tr('Не подключено', 'Disconnected');
    shadow.getElementById('mode').textContent = latestState?.account?.mode || '—';
    shadow.getElementById('uid').textContent = `UID ${latestState?.account?.uid ?? '—'}`;
    shadow.getElementById('balance').textContent = formatBalance(latestState?.account);
    const pnl = profitLabel();
    const profitNode = shadow.getElementById('profit');
    profitNode.textContent = pnl.value;
    profitNode.className = `metric ${pnl.className}`;
    profitNode.title = pnl.title;
    const entitlement = serverState?.entitlement || {};
    const accessState = String(entitlement.accessState || '').toUpperCase();
    const trialNode = shadow.getElementById('trialAccess');
    trialNode.classList.remove('expired', 'registered', 'premium');
    if (accessState === 'TRIAL_ACTIVE') {
      const expires = Date.parse(entitlement.trial?.expiresAt || entitlement.expiresAt || '');
      const serverEpoch = Date.parse(entitlement.serverTime || serverState?.serverTime || '');
      if (!trialStatusClockAnchor || trialStatusClockAnchor.expires !== expires || (Number.isFinite(serverEpoch) && trialStatusClockAnchor.serverEpoch !== serverEpoch)) {
        trialStatusClockAnchor = {
          expires,
          serverEpoch: Number.isFinite(serverEpoch) ? serverEpoch : Date.now(),
          perf: performance.now()
        };
      }
      const estimatedServerNow = trialStatusClockAnchor.serverEpoch + Math.max(0, performance.now() - trialStatusClockAnchor.perf);
      const remaining = Number.isFinite(expires) ? Math.max(0, Math.floor((expires - estimatedServerNow) / 1000)) : Number(entitlement.trial?.remainingSeconds || 0);
      const h = Math.floor(remaining / 3600), m = Math.floor((remaining % 3600) / 60), s = remaining % 60;
      if (remaining <= 0 && Date.now() - trialExpirySyncAt > 15000) {
        trialExpirySyncAt = Date.now();
        void safeRuntimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: true }, 10000).catch(() => null);
      }
      trialNode.hidden = false; trialNode.textContent = `♛ TRIAL ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    } else if (accessState === 'TRIAL_EXPIRED') { trialNode.hidden = false; trialNode.classList.add('expired'); trialNode.textContent = 'TRIAL ЗАВЕРШЁН';
    } else if (accessState === 'AFFILIATE_REGISTERED' || (entitlement.affiliate?.registered && !entitlement.premium)) { trialNode.hidden = false; trialNode.classList.add('registered'); trialNode.textContent = 'DEMO 50/сутки';
    } else if (entitlement.premium) { trialNode.hidden = false; trialNode.classList.add('premium'); trialNode.textContent = 'PREMIUM';
    } else { trialNode.hidden = true; }
    const openNode = shadow.getElementById('open');
    openNode.title = tr('Открыть Pocket TRADE ROBOT', 'Open Pocket TRADE ROBOT');
    const openLabel = openNode.querySelector('.label');
    if (openLabel) openLabel.textContent = tr('Открыть Pocket TRADE ROBOT', 'Open Pocket TRADE ROBOT');
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const legalKeysChanged = PT_LEGAL_DISCLOSURE_STORAGE_KEYS.filter((key) => changes[key]);
    if (legalKeysChanged.length) {
      const snapshot = { ...(lastKnownLegalDisclosureStorage || {}) };
      for (const key of legalKeysChanged) {
        if (changes[key].newValue === undefined) delete snapshot[key];
        else snapshot[key] = changes[key].newValue;
      }
      lastKnownLegalDisclosureStorage = snapshot;
      const preference = snapshot?.[PT_LEGAL_DISCLOSURE_PREFERENCE_KEY];
      const dontShowAgain = preference?.schemaVersion === PT_LEGAL_DISCLOSURE_PREFERENCE_SCHEMA
        ? preference?.dontShowAgain === true
        : snapshot?.ptLegalConsent?.disclosureDontShowAgain === true || snapshot?.ptLegalDisclosureDontShowAgain === true;
      // If another Pocket tab completed the same prompt, immediately settle an
      // already-open duplicate instead of making the user confirm it twice.
      if (isCurrentLegalConsentRecord(snapshot?.ptLegalConsent) && dontShowAgain) {
        disclosureAcceptedForCurrentFlow = true;
        settleRobotDisclosureModal(true);
      }
    }
    if (changes.poBridgeSettings) {
      const previousSessionStartedAt = settings.autoTrade?.sessionStartedAt || null;
      const previousEnabled = settings.autoTrade?.enabled === true;
      const previousPeriod = selectedEffectiveAnalysisPeriod(settings.autoTrade || {});
      const previousSignalConfigKey = currentSignalConfigurationKey(settings.autoTrade || {});
      settings = mergeSettings(changes.poBridgeSettings.newValue || {});
      if (settings.tradeResultNotifications === false) {
        tradeResultNoticeQueue.length = 0;
        document.getElementById('pt-trade-result-notice')?.remove();
        tradeResultNoticeActive = false;
      }
      const nextPeriod = selectedEffectiveAnalysisPeriod(settings.autoTrade || {});
      const nextSignalConfigKey = currentSignalConfigurationKey(settings.autoTrade || {});
      const signalConfigurationChanged = previousSignalConfigKey !== nextSignalConfigKey;
      const nextSessionStartedAt = settings.autoTrade?.sessionStartedAt || null;
      const nextEnabled = settings.autoTrade?.enabled === true;
      // A false -> true transition happens only after an explicit local/remote
      // enable action while this tab is alive, so arm this tab session. Turning
      // autotrading off clears the marker immediately.
      if (!nextEnabled) setAutoTradeArmedForThisTabSession(false);
      else if (!previousEnabled && nextEnabled) setAutoTradeArmedForThisTabSession(true);
      if (!nextEnabled || previousSessionStartedAt !== nextSessionStartedAt || previousEnabled !== nextEnabled) {
        autoRuntime.activeTrades.clear();
        autoRuntime.inFlightAssets.clear();
        autoRuntime.inFlightSignalIds.clear();
        autoRuntime.inFlightRecoveryScopes.clear();
        autoRuntime.inFlightBaseSignals.clear();
        autoRuntime.provisionalClosedDeals.clear();
        autoRuntime.settlementPendingTrades.clear();
        autoRuntime.followRecoveryRetryAfterByScope.clear();
        try { sessionStorage.removeItem(FOLLOW_RECOVERY_RETRY_STORAGE_KEY); } catch {}
        autoRuntime.lastTradeAtByAsset.clear();
        const existingClosedDeals = mergedRobotClosedDeals();
        autoRuntime.lastClosedDealCount = existingClosedDeals.length;
        autoRuntime.reconciledClosedDealKeys = new Set(existingClosedDeals.map(closedDealReconcileKey));
        autoRuntime.fallbackSessionStartedAt = Number.isFinite(Date.parse(nextSessionStartedAt || ''))
          ? Date.parse(nextSessionStartedAt)
          : Date.now();
      }
      if (!statusBarPlacement) statusBarPlacement = normalizeStatusBarPlacement(settings.statusBarPosition);
      scheduleRender(true);
      if (previousPeriod !== nextPeriod || signalConfigurationChanged) {
        autoRuntime.subscribedKey = '';
        autoRuntime.lastSubscriptionAt = 0;
        autoRuntime.lastSnapshotCandleByAsset.clear();
        autoRuntime.lastSnapshotSourceByAsset.clear();
        resetSignalExecutionPipeline(previousPeriod !== nextPeriod ? 'analysis_timeframe_changed' : 'analysis_configuration_changed');
        void restoreMarketStream(previousPeriod !== nextPeriod ? 'analysis_timeframe_changed' : 'analysis_configuration_changed', { force: true, quiet: true })
          .then(() => ensureSignalSubscription())
          .then(() => publishCandleSnapshots(true))
          .catch(() => null);
      } else {
        scheduleAutoEngine();
        void publishCandleSnapshots(false);
      }
    }
    if (changes.ptStatusBarPlacement) {
      statusBarPlacement = normalizeStatusBarPlacement(changes.ptStatusBarPlacement.newValue);
      scheduleRender(true);
    }
    if (changes.poProfitStats) {
      profitStats = changes.poProfitStats.newValue || null;
      scheduleRender(true);
    }
    if (changes.poTradeLedger) {
      notifyNewClosedTrades(changes.poTradeLedger.oldValue || robotLedger, changes.poTradeLedger.newValue || null);
      robotLedger = changes.poTradeLedger.newValue || { version: 3, robotOnly: true, closedDeals: [], openDeals: [], summary: {}, today: {} };
      scheduleRender(true);
      scheduleAutoEngine();
    }
    if (changes.ptServerState) {
      serverState = changes.ptServerState.newValue || null;
      scheduleRender(true);
      scheduleAutoEngine();
      if (registrationGateRequiredFromAccess(serverState)) {
        setTimeout(() => void enforceRegistrationGateFromCurrentAccess('trial_expired_server_state'), 120);
      }
    }
    if (changes.ptUiLanguage) {
      uiLanguage = normalizeUiLanguage(changes.ptUiLanguage.newValue);
      renderEmbeddedDashboardLanguage?.(uiLanguage);
      scheduleRender(true);
    }
    if (changes.ptAccessNotification?.newValue) void showAccessNotification(changes.ptAccessNotification.newValue);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.type) {
          case 'PT_SERVER_SIGNAL': {
            sendResponse(enqueueServerSignal(message.signal || {}));
            return;
          }
          case 'PT_FORCE_TIMEFRAME_RESUBSCRIBE': {
            const requestedPeriod = normalizeAnalysisPeriodSeconds(message.period ?? settings.autoTrade?.period ?? settings.period ?? 60, 60);
            settings = mergeSettings({ ...settings, period: requestedPeriod, autoTrade: { ...(settings.autoTrade || {}), period: requestedPeriod } });
            autoRuntime.subscribedKey = '';
            autoRuntime.lastSubscriptionAt = 0;
            autoRuntime.lastSnapshotCandleByAsset.clear();
            autoRuntime.lastSnapshotSourceByAsset.clear();
            resetSignalExecutionPipeline('analysis_timeframe_reselected');
            const restored = await restoreMarketStream('analysis_timeframe_reselected', { force: true, quiet: true }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
            const subscribed = await ensureSignalSubscription().catch((error) => ({ ok: false, error: String(error?.message || error) }));
            if (restored?.ok || subscribed?.ok) setTimeout(() => void publishCandleSnapshots(true), 0);
            sendResponse({ ok: Boolean(restored?.ok || subscribed?.ok), restored, subscribed });
            return;
          }
          case 'PT_SIGNAL_SOCKET_STATUS': {
            const socketStatus = String(message.status || 'offline');
            const previousSocketStatus = autoRuntime.signalSocketStatus;
            if (Number(message.snapshotWorkersRecommended) > 0) {
              autoRuntime.snapshotWorkersRecommended = Math.max(2, Math.min(8, Number(message.snapshotWorkersRecommended)));
            }
            if (Number(message.snapshotWorkersServerMax) > 0) {
              autoRuntime.snapshotWorkersServerMax = Math.max(1, Math.min(16, Number(message.snapshotWorkersServerMax)));
            }
            if (Number(message.snapshotSchedulerWorkers) > 0) {
              autoRuntime.snapshotSchedulerWorkers = Math.max(1, Math.min(16, Number(message.snapshotSchedulerWorkers)));
            }
            autoRuntime.signalSocketStatus = socketStatus === 'subscribing' ? 'connecting' : socketStatus;
            autoRuntime.signalSocketStatusAt = Date.now();
            if (socketStatus === 'analyzing' && previousSocketStatus !== 'analyzing') {
              autoRuntime.signalAnalyzingSince = Date.now();
              // A new subscription must never inherit stale readiness from the old
              // strategy/asset set.
              autoRuntime.lastEngineStatusAt = 0;
              autoRuntime.lastEngineAsset = '';
              autoRuntime.analysisBootstrapAwaiting = false;
              autoRuntime.analysisBootstrapSentAt = 0;
              autoRuntime.analysisBootstrapSnapshotId = '';
              autoRuntime.analysisBootstrapAsset = '';
            }
            if (socketStatus === 'online') {
              autoRuntime.signalAnalyzingSince = 0;
              autoRuntime.analysisBootstrapAwaiting = false;
              autoRuntime.analysisBootstrapSentAt = 0;
              autoRuntime.analysisBootstrapSnapshotId = '';
              autoRuntime.analysisBootstrapAsset = '';
              autoRuntime.analysisStallRecoveries = 0;
            }
            if (['offline', 'error', 'reconnecting', 'connecting', 'subscribing'].includes(socketStatus)) {
              autoRuntime.signalAnalyzingSince = 0;
              autoRuntime.analysisBootstrapAwaiting = false;
            }
            if (settings.autoTrade?.enabled) {
              if (socketStatus === 'online' && ['offline', 'error', 'reconnecting', 'connecting'].includes(String(previousSocketStatus || ''))) {
                showLocalStatusNotice('Канал сигналов восстановлен', 'Канал сигналов был восстановлен автоматически.', 'success', 7000);
              }
              const label = socketStatus === 'online'
                ? 'Сервер сигналов подключён · анализ подтверждён'
                : socketStatus === 'analyzing'
                  ? 'Канал подключён · запуск анализа…'
                  : socketStatus === 'subscribing'
                    ? 'Подписка на серверные сигналы…'
                  : socketStatus === 'connecting'
                    ? 'Подключение сервера сигналов…'
                    : socketStatus === 'reconnecting'
                      ? 'Переподключение сервера сигналов…'
                      : socketStatus === 'error'
                        ? 'Временная ошибка канала сигналов · выполняется переподключение'
                        : 'Канал сигналов временно недоступен · выполняется переподключение';
              const uiState = ['connecting', 'subscribing', 'reconnecting'].includes(socketStatus)
                ? 'connecting'
                : socketStatus === 'analyzing'
                  ? 'scanning'
                  : socketStatus;
              void writeAutoStatus({ force: true, enabled: true, state: uiState || 'offline', message: label });
              if (socketStatus === 'online' || socketStatus === 'analyzing') {
                scheduleAutoEngine();
                setTimeout(() => void publishCandleSnapshots(true), 0);
              } else if (['offline', 'error', 'reconnecting'].includes(socketStatus)) {
                // Не оставляем канал в конечном состоянии «недоступен»: heartbeat
                // повторно зарегистрирует подписку, если service worker был перезапущен.
                autoRuntime.subscribedKey = '';
                autoRuntime.lastSubscriptionAt = 0;
                setTimeout(() => scheduleAutoEngine(), 350);
              }
            }
            sendResponse({ ok: true });
            return;
          }
          case 'PT_ENGINE_STATUS':
            if (settings.autoTrade?.enabled) {
              const status = message.status || {};
              autoRuntime.lastEngineStatusAt = Date.now();
              autoRuntime.signalSocketStatus = 'online';
              autoRuntime.signalSocketStatusAt = Date.now();
              autoRuntime.signalAnalyzingSince = 0;
              autoRuntime.analysisBootstrapAwaiting = false;
              autoRuntime.analysisBootstrapSentAt = 0;
              autoRuntime.analysisBootstrapSnapshotId = '';
              autoRuntime.analysisBootstrapAsset = '';
              autoRuntime.analysisStallRecoveries = 0;
              autoRuntime.lastEngineAsset = String(status.asset || '');
              const statusAsset = String(status.asset || '');
              const statusPeriod = Number(status.period || status.configuredPeriod || status.timeframe || 0);
              const queuedScope = statusAsset
                ? [...autoRuntime.analysisQueuedAssets].find((scope) => String(scope).startsWith(`${statusAsset}|`) && (!statusPeriod || String(scope) === marketSnapshotKey(statusAsset, statusPeriod)))
                : '';
              const statusScope = statusAsset ? (statusPeriod ? marketSnapshotKey(statusAsset, statusPeriod) : (queuedScope || statusAsset)) : '';
              const statusResult = String(status.result || '');
              const supersededStatus = status.superseded === true || /^(?:superseded|coalesced)/i.test(statusResult);
              const bootstrapProbeStatus = statusResult === 'bootstrap_probe';
              if (statusScope) {
                autoRuntime.analysisQueuedAssets.delete(statusScope);
                if (status.state === 'error' || status.error) {
                  autoRuntime.analysisFailedAssets.add(statusScope);
                  if (status.error === 'engine_processing_failed') {
                    autoRuntime.lastSnapshotCandleByAsset.delete(statusScope);
                    autoRuntime.lastSnapshotSourceByAsset.delete(statusScope);
                    autoRuntime.snapshotBackoffUntil = Math.max(Number(autoRuntime.snapshotBackoffUntil || 0), Date.now() + 2500);
                  }
                } else if (!supersededStatus && !bootstrapProbeStatus) {
                  autoRuntime.analysisCompletedAssets.add(statusScope);
                  autoRuntime.analysisFailedAssets.delete(statusScope);
                } else {
                  autoRuntime.analysisFailedAssets.delete(statusScope);
                }
              }
              const modeLabels = { best: 'лучший', independent: 'отдельно' };
              const totalStrategyCount = selectedStrategyIds(settings.autoTrade || {}).length;
              const details = [
                status.asset || '',
                totalStrategyCount ? `стратегий: ${totalStrategyCount}` : '',
                modeLabels[status.strategyMode] || ''
              ].filter(Boolean).join(' · ');
              void writeAutoStatus({
                force: true,
                enabled: true,
                state: status.state || 'scanning',
                message: status.state === 'signal'
                  ? `Найдено торговых кандидатов${status.signals ? ` · ${status.signals}` : ''} · проверяем условия входа`
                  : status.state === 'error'
                    ? `Временная ошибка анализа ${details} · актив повторится автоматически`
                    : `Анализ ${details}${status.candidates === 0 ? ' · подходящего входа пока нет' : ''}`,
                engine: status
              });
              if (status.state === 'signal') scheduleSignalStatusClear(12000);
              if (bootstrapProbeStatus) {
                // The probe proves bidirectional data-plane readiness only. Start the
                // real full-history analysis immediately; it never opens a trade itself.
                scheduleAutoEngine();
                setTimeout(() => void publishCandleSnapshots(true), 0);
              }
            }
            sendResponse({ ok: true }); return;
          case 'PT_SERVER_BROADCAST': {
            const item = message.broadcast || {};
            const stored = await chrome.storage.local.get(['ptNotificationHistory', 'ptSeenServerNotifications']);
            const id = `server-notification-${String(item.id || Date.now())}`;
            const seen = new Set(Array.isArray(stored.ptSeenServerNotifications) ? stored.ptSeenServerNotifications : []);
            if (!seen.has(id) && item.body) {
              const history = Array.isArray(stored.ptNotificationHistory) ? stored.ptNotificationHistory : [];
              seen.add(id);
              await chrome.storage.local.set({
                ptNotificationHistory: [{ id, kind: 'system', title: item.title || 'Pocket TRADE ROBOT', message: item.body, createdAt: item.created_at || item.createdAt || new Date().toISOString(), read: false }, ...history].slice(0, 100),
                ptSeenServerNotifications: [...seen].slice(-500)
              });
            }
            sendResponse({ ok: true });
            return;
          }
          case 'PT_ACCESS_NOTIFICATION': {
            const notice = message.notification || {};
            if ((notice.kind === 'free_limit' || notice.reason === 'DAILY_TRADE_LIMIT') && settings.autoTrade?.enabled) {
              await stopAutoTradingByRisk('Дневной лимит FREE исчерпан. Автоторговля остановлена до активации Trial/Premium или сброса лимита.');
            }
            void showAccessNotification(notice);
            sendResponse({ ok: true });
            return;
          }

          case 'PT_OPEN_IN_PAGE_DASHBOARD':
            sendResponse(await openEmbeddedDashboard(message.payload || {}));
            return;
          case 'PT_CLOSE_IN_PAGE_DASHBOARD':
            embeddedDashboardHost?.remove();
            embeddedDashboardHost = null;
            renderEmbeddedDashboardLanguage = null;
            disclosureAcceptedForCurrentFlow = false;
            sendResponse({ ok: true });
            return;
          case 'PT_SHOW_STATUS_BAR':
            if (message?.payload?.forceVisible) {
              settings = mergeSettings({ ...settings, statusBarVisible: true });
              await safeStorageSet({ poBridgeSettings: settings }).catch(() => null);
            }
            if (message?.payload?.waitingForLogin === true && !isRobotEligiblePage(latestState)) {
              guestLaunchWaiting = true;
              await safeStorageSet({
                [PENDING_LOGIN_WAIT_STORAGE_KEY]: { at: Date.now(), source: String(message?.payload?.source || 'status_bar_wait') }
              }).catch(() => null);
            }
            ensureStatusBar();
            host.style.visibility = 'visible';
            host.style.display = 'block';
                    if (message?.payload?.pulse !== false) pulseStatusBar();
            renderStatusBar();
            sendResponse({ ok: true });
            return;
          case 'PT_CONTENT_CAPABILITIES':
            sendResponse({ ok: true, version: VERSION, strategyTesterHistory: true, embeddedDashboard: true });
            return;
          case 'PT_TESTER_COLLECT_HISTORY':
            sendResponse(await collectStrategyTesterHistory(message.payload || {}));
            return;
          case 'PO_GET_STATE':
            if (mergeLiveBrokerClosedDealsIntoState()) saveStateSoon(true);
            sendResponse({ ok: true, state: slimStateForStorage(latestState) });
            return;
          case 'PO_CONNECT': {
            if (await shouldShowRobotDisclosure({ source: 'account_connect' })) {
              const accepted = await showRobotDisclosureModal({ source: 'account_connect' });
              if (!accepted) {
                sendResponse({ ok: false, cancelled: true, disclosureRequired: true, error: 'LEGAL_DISCLOSURE_REQUIRED' });
                return;
              }
            }
            try {
              const result = await pageCommand('CONNECT', null, 7000);
              setTimeout(() => void safeRuntimeMessage({ type: 'PT_SERVER_SYNC', forceBootstrap: true }).catch(() => null), 800);
              sendResponse(result);
            } finally {
              // The next explicit manual CONNECT is a new legal-notice cycle.
              // Automatic recovery stays inside page-bridge and does not trigger it.
              disclosureAcceptedForCurrentFlow = false;
            }
            return;
          }
          case 'PO_DISCONNECT':
            closeSignalSocket('account_disconnect');
            disclosureAcceptedForCurrentFlow = false;
            sendResponse(await pageCommand('DISCONNECT', null, 5000));
            return;
          case 'PO_TRADE': {
            const requestId = String(message.payload?.requestId || crypto.randomUUID());
            const payload = { ...(message.payload || {}), requestId };
            const access = await safeRuntimeMessage({
              type: 'PO_CHECK_TRADE_ACCESS',
              payload: { requestId, source: payload.source || 'manual', asset: payload.asset, strategyId: payload.strategyId, action: payload.action, amount: payload.amount, duration: payload.duration }
            });
            if (!access?.ok || access.allowed === false || access.duplicate) {
              sendResponse({ ok: false, error: access?.error || (access?.duplicate ? 'Эта команда уже исполнена' : 'Сделка запрещена сервером') });
              return;
            }
            try {
              const result = await executeTradeCommand({ ...payload, executionTicket: access.executionTicket }, 45000);
              const opened = Boolean(result?.ok && result?.confirmed === true && result?.result?.status === 'success');
              await safeRuntimeMessage({
                type: 'PT_REPORT_TRADE',
                payload: { requestId, opened, asset: payload.asset, action: payload.action, amount: payload.amount, duration: payload.duration, strategyId: payload.strategyId, source: payload.source || 'manual', openedAt: new Date().toISOString(), rawResult: result || null }
              }).catch(() => null);
              if (opened) await safeRuntimeMessage({ type: 'PO_RECORD_TRADE_USAGE', payload: { source: payload.source || 'manual' } });
              sendResponse(result);
            } catch (error) {
              await safeRuntimeMessage({ type: 'PT_REPORT_TRADE', payload: { requestId, opened: false, asset: payload.asset, action: payload.action, source: payload.source || 'manual', error: String(error?.message || error) } }).catch(() => null);
              throw error;
            }
            return;
          }
          case 'PO_SUBSCRIBE': {
            const access = await safeRuntimeMessage({ type: 'PO_GET_ACCESS_STATE' });
            const assets = Array.isArray(message.payload?.assets)
              ? [...new Set(message.payload.assets.map((item) => String(item || '').trim()).filter(Boolean))]
              : [String(message.payload?.asset || '').trim()].filter(Boolean);
            const maxAssets = access?.limits?.maxAssets;
            if (maxAssets != null && assets.length > maxAssets) {
              sendResponse({ ok: false, error: `Тариф FREE позволяет подключить максимум ${maxAssets} графиков` });
              return;
            }
            const periods = normalizeGraphPeriods(message.payload?.periods, message.payload?.period || 60);
            const primaryPeriod = normalizeAnalysisPeriodSeconds(message.payload?.primaryPeriod || message.payload?.period || periods[0] || 60, periods[0] || 60);
            if (!periods.includes(primaryPeriod)) periods.unshift(primaryPeriod);
            const historyOffsets = message.payload?.historyOffsets && typeof message.payload.historyOffsets === 'object'
              ? message.payload.historyOffsets
              : {};
            const effectiveHistoryOffsets = { ...historyOffsets };
            for (const period of periods) {
              effectiveHistoryOffsets[period] = Math.max(60, Math.min(5000,
                Number(effectiveHistoryOffsets?.[period]) || Number(message.payload?.historyOffset) || 180
              ));
            }
            const minimumPayout = Math.max(MIN_TRADE_PAYOUT, Number(settings.autoTrade?.minPayout) || 0);
            const eligibility = Object.fromEntries(assets.map((asset) => [asset, marketAnalysisEligibility(asset, minimumPayout)]));
            const eligibleAssets = assets.filter((asset) => eligibility[asset]?.eligible === true);
            const payoutFilteredAssets = assets.filter((asset) => eligibility[asset]?.reason === 'payout_below_minimum');
            const unavailableAssets = assets.filter((asset) => eligibility[asset]?.reason === 'unavailable_on_pocket');
            const payoutUnknownAssets = assets.filter((asset) => eligibility[asset]?.reason === 'payout_unknown');
            const coverage = await cacheBridgeCoverageForPlan(eligibleAssets, periods, effectiveHistoryOffsets, {
              forceFull: true,
              defaultLimit: Number(message.payload?.historyOffset) || 180,
              minimumCandles: 40,
              timeoutMs: 18000
            });
            const result = await applyPocketFallbackSubscriptions({
              allAssets: eligibleAssets.length ? eligibleAssets : assets,
              fallbackAssets: coverage.fallbackAssets,
              fallbackScopes: coverage.fallbackScopes,
              periods,
              primaryPeriod,
              historyOffsets: effectiveHistoryOffsets,
              reason: eligibleAssets.length ? 'user_market_selection' : 'no_assets_above_minimum_payout',
              force: true
            });
            setTimeout(() => void safeRuntimeMessage({ type: 'PT_SERVER_SYNC' }).catch(() => null), 500);
            sendResponse({
              ok: result?.ok !== false,
              ...result,
              assets,
              periods,
              primaryPeriod,
              cacheBridge: true,
              minimumPayout,
              eligibleAssets,
              eligibleAssetCount: eligibleAssets.length,
              payoutFilteredAssets,
              payoutFilteredAssetCount: payoutFilteredAssets.length,
              unavailableAssets,
              unavailableAssetCount: unavailableAssets.length,
              payoutUnknownAssets,
              payoutUnknownAssetCount: payoutUnknownAssets.length,
              cacheAssets: coverage.cacheAssets,
              cacheAssetCount: coverage.cacheAssets.length,
              fallbackAssets: coverage.fallbackAssets,
              fallbackAssetCount: coverage.fallbackAssets.length,
              graphManager: coverage.fallbackAssets.length > 0
            });
            return;
          }
          case 'PO_HISTORY':
            sendResponse(await pageCommand('HISTORY', message.payload, 7000));
            return;
          case 'PO_CLEAR_LOG':
            sendResponse(await pageCommand('CLEAR_LOG', null, 5000));
            return;
          case 'PO_GET_LIVE_BROKER_STATS': {
            const changed = mergeLiveBrokerClosedDealsIntoState();
            if (changed) saveStateSoon(true);
            sendResponse({ ok: true, changed, deals: Array.isArray(latestState?.trades?.closedDeals) ? latestState.trades.closedDeals.filter((deal) => deal?.brokerUiLive && isRobotTradeDeal(deal)).slice(-500) : [], statistics: latestState?.trades?.statistics || null });
            return;
          }
          case 'PO_GET_DIAGNOSTICS':
            sendResponse({
              ok: true,
              diagnostics: {
                ...(latestState || {}),
                autoExecutionDiagnostics: {
                  queueDepth: refreshSignalQueueDepth(),
                  pendingSignals: autoRuntime.pendingSignals.size,
                  activeSignalWorkers: autoRuntime.signalWorkers,
                  configRevision: autoRuntime.signalConfigRevision,
                  configKey: autoRuntime.signalConfigKey || currentSignalConfigurationKey(settings.autoTrade || {}),
                  lastResetReason: autoRuntime.lastSignalPipelineResetReason || null,
                  inFlightSignals: autoRuntime.inFlightSignalIds.size,
                  inFlightRecoveryScopes: autoRuntime.inFlightRecoveryScopes.size,
                  graphManager: {
                    enabled: graphSubscriptionManager.enabled,
                    assets: graphSubscriptionManager.assets.length,
                    periods: [...graphSubscriptionManager.periods],
                    primaryPeriod: graphSubscriptionManager.primaryPeriod,
                    cachedSnapshots: [...marketSnapshots.keys()].filter((key) => String(key).includes('|')).length,
                    bootstrapping: graphSubscriptionManager.bootstrapping,
                    parallelPeriodsInFlight: [...graphSubscriptionManager.inFlightPeriods]
                  },
                  cacheBridge: {
                    enabled: cacheBridgeControl.enabled,
                    online: cacheBridgeControl.online,
                    baseUrl: cacheBridgeControl.baseUrl,
                    lastAttemptAt: cacheBridgeControl.lastAttemptAt || null,
                    lastSuccessAt: cacheBridgeControl.lastSuccessAt || null,
                    lastLatencyMs: cacheBridgeControl.lastLatencyMs,
                    lastError: cacheBridgeControl.lastError,
                    resultCount: cacheBridgeControl.lastResultCount,
                    cachedScopes: cacheBridgeSnapshots.size,
                    primaryScopes: [...cacheBridgeControl.primaryScopes],
                    fallbackScopes: [...cacheBridgeControl.fallbackScopes],
                    fallbackAssets: [...cacheBridgeControl.fallbackAssets],
                    payoutMinimum: Math.max(MIN_TRADE_PAYOUT, Number(settings.autoTrade?.minPayout) || 0),
                    payoutEligibleAssets: selectedAutotradeAssets().filter((asset) => marketAnalysisEligibility(asset, settings.autoTrade?.minPayout).eligible).length,
                    payoutFilteredAssets: selectedAutotradeAssets().filter((asset) => !marketAnalysisEligibility(asset, settings.autoTrade?.minPayout).eligible).length
                  },
                  snapshotTransport: {
                    clientProfile: { ...CLIENT_PERFORMANCE_PROFILE },
                    basePaceMs: autoRuntime.snapshotBasePaceMs,
                    currentPaceMs: autoRuntime.snapshotSendPaceMs,
                    lastAckLatencyMs: autoRuntime.snapshotLastAckLatencyMs || null,
                    consecutiveSuccesses: autoRuntime.snapshotConsecutiveSuccesses,
                    consecutiveTimeouts: autoRuntime.snapshotConsecutiveTimeouts,
                    pressureLevel: autoRuntime.serverPressureLevel,
                    backpressureEvents: autoRuntime.serverBackpressureEvents,
                    backoffUntil: autoRuntime.snapshotBackoffUntil || null,
                    publishing: autoRuntime.snapshotPublishing,
                    lastSuccessAt: autoRuntime.lastSnapshotSuccessAt || null
                  },
                  decisions: { ...autoRuntime.signalDecisionStats }
                }
              }
            });
            return;
          default:
            sendResponse({ ok: false, error: 'UNKNOWN_MESSAGE' });
        }
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  });

  void loadStoredData();
  autoRuntime.heartbeatTimer = setInterval(() => {
    if (extensionContextInvalidated) return;
    if (settings.statusBarVisible !== false) {
      const floating = host?.dataset?.ptStatusBarMode === 'floating';
      if (floating) {
        // Pocket builds its header asynchronously. Move the bar back to its
        // normal header slot as soon as that slot becomes usable.
        if (mountStatusBarHost()) renderStatusBar();
      } else if (statusBarNeedsRecovery()) {
        statusHostDock = null;
        statusHostRightBlock = null;
        ensureStatusBar();
        renderStatusBar();
      }
    }
    reconcileActiveAutoTrades();
    void maybeRunFollowSignalRecovery('heartbeat').catch(() => null);
    scheduleAutoEngine();
    if (settings.autoTrade?.enabled) {
      void longSessionWatchdog();
      scheduleSnapshotPublish(false, 120);
    }
  }, 2500);
  if (document.documentElement) {
    ensureStatusBar();
    renderStatusBar();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      ensureStatusBar();
      renderStatusBar();
    }, { once: true });
  }

  setTimeout(() => {
    void pageCommand('GET_STATE', null, 3000).catch(() => {});
  }, 700);
})();
