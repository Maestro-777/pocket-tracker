(() => {
  "use strict";
  const CHANNEL = "POCKET_TRACKER_BRIDGE_V3";
  const GUARD = "__POCKET_TRACKER_PAGE_HOOK_V3__";
  if (window[GUARD]) return;
  window[GUARD] = true;

  const NativeWebSocket = window.WebSocket;
  const sockets = new Map();
  let requestCounter = Date.now() % 1000000000;
  let lastStatusKey = "";
  let lastAccountMode = "unknown";
  let desiredAsset = null;
  let desiredPeriod = 5;
  const DEMO_HOSTS = new Set(["demo-api-eu.po.market", "try-demo-eu.po.market"]);

  function post(type, data) {
    try {
      window.postMessage(Object.assign({ channel: CHANNEL, type: type }, data || {}), location.origin);
    } catch (_) {}
  }
  function normalizeHost(url) {
    try { return new URL(url, location.href).hostname.toLowerCase(); } catch (_) { return ""; }
  }
  function isDemoHost(host) {
    return DEMO_HOSTS.has(host);
  }
  function visibleAccountMode() {
    const realSelectors = [
      ".accounts-list__item--real.active", ".accounts-list__item--real.is-active",
      ".accounts-list__item--real.selected", '[data-account-type="real"].active',
      ".switcher__btn--real.active", ".header-balance__item--real.active",
      ".header-balance__item--real.is-active", ".balance-info--real.active",
      ".balance-info--real.is-active", 'button[class*="real"].active',
      'a[class*="real"].active'
    ];
    const demoSelectors = [
      ".accounts-list__item--demo.active", ".accounts-list__item--demo.is-active",
      ".accounts-list__item--demo.selected", '[data-account-type="demo"].active',
      ".switcher__btn--demo.active", ".header-balance__item--demo.active",
      ".header-balance__item--demo.is-active", ".balance-info--demo.active",
      ".balance-info--demo.is-active", ".js-switch-to-demo.active"
    ];
    try {
      for (const selector of realSelectors) if (document.querySelector(selector)) return "real";
      for (const selector of demoSelectors) if (document.querySelector(selector)) return "demo";
      const real = document.querySelector(".js-balance-real-USD, .js-balance-real");
      const demo = document.querySelector(".js-balance-demo");
      if (real && real.offsetParent !== null && (!demo || demo.offsetParent === null)) return "real";
      if (demo && demo.offsetParent !== null && (!real || real.offsetParent === null)) return "demo";
    } catch (_) {}
    return "unknown";
  }
  function demoFlag(value, depth) {
    if (depth > 4 || value == null) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = demoFlag(item, depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    const keys = ["isDemo", "is_demo", "demo_account", "demoAccount", "isDemoAccount"];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const v = value[key];
        if (v === true || v === 1 || String(v).toLowerCase() === "true" || String(v) === "1") return true;
        if (v === false || v === 0 || String(v).toLowerCase() === "false" || String(v) === "0") return false;
      }
    }
    for (const key of ["data", "user", "balance", "account", "result"]) {
      if (value[key] && typeof value[key] === "object") {
        const found = demoFlag(value[key], depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  }
  function latestDemoSocket() {
    let chosen = null;
    const mode = visibleAccountMode();
    if (mode === "real" || (mode === "unknown" && lastAccountMode === "real")) return null;
    for (const rec of sockets.values()) {
      if (!rec.demoEndpoint || rec.serverDemo !== true || rec.authenticated !== true || rec.ws.readyState !== NativeWebSocket.OPEN) continue;
      if (!chosen || rec.lastDataAt > chosen.lastDataAt) chosen = rec;
    }
    return chosen;
  }
  function reportStatus(force) {
    const visibleMode = visibleAccountMode();
    const open = Array.from(sockets.values()).filter(x => x.ws.readyState === NativeWebSocket.OPEN);
    const demo = latestDemoSocket();
    const mode = visibleMode === "real" ? "real" :
      visibleMode === "demo" ? "demo" :
      lastAccountMode === "real" ? "real" : (demo ? "demo" : lastAccountMode);
    const key = [open.length, !!demo, mode, demo && demo.host, demo && demo.lastDataAt].join("|");
    if (!force && key === lastStatusKey) return;
    lastStatusKey = key;
    post("SOCKET_STATUS", {
      socketCount: open.length,
      socketConnected: !!demo,
      demoEndpointSeen: open.some(x => x.demoEndpoint),
      serverDemoConfirmed: !!demo,
      demoVerified: !!demo && mode !== "real",
      accountMode: mode,
      endpoint: demo ? demo.host : (open[0] ? open[0].host : ""),
      message: mode === "real" ? "В терминале выбран REAL. Торговля заблокирована." :
        demo ? "Соединение DEMO и тип счёта подтверждены брокером." :
        "Ожидаю авторизованное DEMO-соединение и подтверждение баланса."
    });
  }
  function parsePacket(frame) {
    if (typeof frame !== "string") return null;
    const index = frame.indexOf("[");
    if (index < 0) return null;
    try {
      const parsed = JSON.parse(frame.slice(index));
      return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed : null;
    } catch (_) { return null; }
  }
  function safeBalancePayload(payload) {
    const src = Array.isArray(payload) ? payload[0] : payload;
    if (!src || typeof src !== "object") return { isDemo: null, balance: null };
    const flag = demoFlag(src, 0);
    const amount = Number(src.balance ?? src.demo_balance ?? src.real_balance ?? src.amount);
    return { isDemo: flag, balance: Number.isFinite(amount) && amount >= 0 ? amount : null };
  }
  function forwardAssets(payload) {
    const rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.assets) ? payload.assets : [payload]);
    const assets = [];
    for (const row of rows) {
      if (!row) continue;
      let symbol = "", id = null, digits = null, active = true, label = "";
      if (Array.isArray(row)) {
        id = row[0]; symbol = row[1]; label = row[2] || symbol;
        digits = null;
        if (row.length > 14) active = Boolean(row[14]);
      } else if (typeof row === "object") {
        symbol = row.symbol || row.asset || row.code || row.s || "";
        id = row.id ?? row.assetId ?? null;
        digits = row.digits ?? row.precision ?? null;
        active = row.active ?? row.available ?? true;
        label = row.name || row.title || row.label || symbol;
      }
      if (typeof symbol === "string" && symbol && active) {
        const d = Number(digits);
        assets.push({ symbol: symbol, id: id == null ? null : String(id),
          digits: Number.isInteger(d) && d >= 0 && d <= 12 ? d : null,
          label: String(label || symbol).slice(0, 80) });
      }
      if (assets.length >= 500) break;
    }
    post("ASSET_LIST", { assets: assets });
  }
  function extractAssetFromCharts(payload) {
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      let settings = row.settings;
      if (typeof settings === "string") {
        try { settings = JSON.parse(settings); } catch (_) { settings = null; }
      }
      const symbol = (settings && (settings.symbol || settings.asset)) || row.symbol || row.asset;
      if (typeof symbol === "string" && symbol) {
        post("CHART_ASSET", { asset: symbol, period: Number(settings && (settings.chartPeriod || settings.fastTimeframe)) || null });
      }
    }
  }
  function emitHistory(name, payload) {
    let data = Array.isArray(payload) && payload[0] && typeof payload[0] === "object" && !Array.isArray(payload[0])
      ? payload[0] : payload;
    if (!data || typeof data !== "object") return;
    let rows = data.candles || data.history || data.data || data.rows;
    let asset = data.asset || data.symbol || desiredAsset || "";
    let period = Number(data.period || data.timeframe || desiredPeriod || 5);
    if (!Array.isArray(rows) && Array.isArray(payload)) rows = payload;
    if (!Array.isArray(rows) || !rows.length) return;
    const maxRows = 600000;
    if (rows.length > maxRows) rows = rows.slice(-maxRows);
    const chunkSize = 4000;
    const total = Math.ceil(rows.length / chunkSize);
    const batchId = String(Date.now()) + "-" + String(Math.random()).slice(2, 8);
    for (let i = 0; i < total; i++) {
      post("HISTORY_CHUNK", {
        batchId: batchId, chunkIndex: i, chunkCount: total,
        asset: String(asset), period: period,
        rows: rows.slice(i * chunkSize, Math.min(rows.length, (i + 1) * chunkSize)),
        sourceEvent: name
      });
    }
  }
  function safeDeals(payload) {
    const rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.deals) ? payload.deals : []);
    return rows.slice(0, 100).map(function(d) {
      return {
        id: d && (d.id ?? d.ticket ?? null),
        requestId: d && d.requestId,
        asset: d && (d.asset || d.symbol || ""),
        amount: d && Number(d.amount || d.investment || 0),
        profit: d && Number(d.profit || 0),
        closeTimestamp: d && (d.closeTimestamp ?? d.close_time ?? d.expired_at ?? null),
        status: d && (d.status || d.result || "")
      };
    });
  }
  function handleEvent(rec, name, payload) {
    rec.lastDataAt = Date.now();
    if (name === "updateBalance" || name === "successupdateBalance") {
      const info = safeBalancePayload(payload);
      if (info.isDemo !== null) {
        rec.serverDemo = info.isDemo;
        rec.balanceKnown = true;
        lastAccountMode = info.isDemo ? "demo" : "real";
      }
      rec.balance = info.balance;
      if (rec.demoEndpoint && rec.serverDemo === true) sendRaw(rec, "updateOpenedDeals");
      reportStatus(true);
      post("BALANCE_STATE", { isDemo: info.isDemo, balance: info.balance });
      return;
    }
    if (name === "successauth" || name === "user_ready" || name === "auth/success") {
      rec.authenticated = true;
      reportStatus(true);
      return;
    }
    if (name === "updateAssets") { forwardAssets(payload); return; }
    if (name === "updateCharts") { extractAssetFromCharts(payload); return; }
    if (name === "updateStream" || name === "quotes/stream") {
      post("MARKET_TICKS", { payload: payload, sourceEvent: name });
      return;
    }
    if (name === "updateHistory" || name === "updateHistoryNew" ||
        name === "updateHistoryNewFast" || name === "loadHistoryPeriodFast" ||
        name === "loadHistoryPeriod" || name === "history/list/v2") {
      emitHistory(name, payload);
      return;
    }
    if (name === "updateOpenedDeals") {
      const deals = safeDeals(payload);
      rec.activeDealCount = deals.filter(function(d) { return d.closeTimestamp == null || d.closeTimestamp === 0 || d.closeTimestamp === ""; }).length;
      if (rec.activeDealCount > 0) rec.pendingOrderId = null;
      post("OPEN_DEALS", { deals: deals });
      return;
    }
    if (name === "successopenOrder") {
      const requestId = payload && payload.requestId != null ? String(payload.requestId) : "";
      const own = !!requestId && rec.ownRequestIds.has(requestId);
      if (own) {
        rec.ownRequestIds.delete(requestId);
        rec.pendingOrderId = null;
        rec.activeDealCount = Math.max(1, rec.activeDealCount);
        post("ORDER_ACK", { accepted: true, order: {
          id: payload.id ?? null, requestId: payload.requestId,
          asset: payload.asset || "", amount: Number(payload.amount || 0)
        }});
        sendRaw(rec, "updateOpenedDeals");
      }
      return;
    }
    if (name === "failopenOrder") {
      const requestId = payload && payload.requestId != null ? String(payload.requestId) : "";
      const own = !!requestId && rec.ownRequestIds.has(requestId);
      if (own) {
        rec.ownRequestIds.delete(requestId);
        rec.pendingOrderId = null;
        post("ORDER_ACK", { accepted: false, order: {
          requestId: payload.requestId, error: String(payload.error || payload.message || "Order rejected")
        }});
      }
      return;
    }
    if (name === "successcloseOrder") {
      const deals = safeDeals(payload);
      post("CLOSED_DEALS", { deals: deals });
      if (rec.demoEndpoint && rec.serverDemo === true) sendRaw(rec, "updateOpenedDeals");
      return;
    }
    if (name === "NotAuthorized" || name === "auth/error") {
      post("BROKER_AUTH_ERROR", { message: "Pocket Option отвергла текущую сессию." });
    }
  }
  function onSocketMessage(rec, data) {
    if (typeof data === "string") {
      if (data === "2") { try { rec.ws.send("3"); } catch (_) {} return; }
      if (data.indexOf("451-") === 0 || data.indexOf("452-") === 0 || data.indexOf("453-") === 0) {
        const packet = parsePacket(data.slice(1));
        if (packet) rec.pendingBinaryEvent = packet[0];
        return;
      }
      if (data.indexOf("42") === 0) {
        const packet = parsePacket(data.slice(2));
        if (packet) handleEvent(rec, packet[0], packet[1]);
      }
      return;
    }
    const processBuffer = function(buffer) {
      const pending = rec.pendingBinaryEvent;
      rec.pendingBinaryEvent = null;
      if (!pending) return;
      try {
        const text = new TextDecoder("utf-8").decode(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
        const parsed = JSON.parse(text);
        handleEvent(rec, pending, parsed);
      } catch (_) {}
    };
    if (data instanceof ArrayBuffer) processBuffer(data);
    else if (typeof Blob !== "undefined" && data instanceof Blob) {
      const pending = rec.pendingBinaryEvent;
      rec.pendingBinaryEvent = null;
      data.arrayBuffer().then(function(buffer) {
        if (!pending) return;
        try {
          const text = new TextDecoder("utf-8").decode(buffer);
          handleEvent(rec, pending, JSON.parse(text));
        } catch (_) {}
      }).catch(function(){});
    }
  }
  function parseOutgoing(rec, frame) {
    if (typeof frame !== "string" || frame.indexOf("42") !== 0) return;
    const packet = parsePacket(frame.slice(2));
    if (!packet) return;
    const name = packet[0], data = packet[1];
    if (name === "changeSymbol" && data && typeof data.asset === "string") {
      desiredAsset = data.asset;
      post("CHART_ASSET", { asset: data.asset, period: Number(data.period) || null });
    } else if (name === "subfor" && typeof data === "string") {
      desiredAsset = data;
    } else if (name === "openOrder" && data && (data.requestId == null || !rec.ownRequestIds.has(String(data.requestId)))) {
      rec.activeDealCount = Math.max(1, rec.activeDealCount);
      post("EXTERNAL_ORDER", { requestId: data.requestId, asset: data.asset || "", amount: Number(data.amount || 0) });
    }
  }
  function sendRaw(rec, name, payload) {
    if (!rec || rec.ws.readyState !== NativeWebSocket.OPEN) return false;
    try {
      const frame = "42" + JSON.stringify(payload === undefined ? [name] : [name, payload]);
      rec.ws.send(frame);
      return true;
    } catch (_) { return false; }
  }
  function commandSubscribe(args) {
    const mode = visibleAccountMode();
    const rec = latestDemoSocket();
    if (mode === "real") return post("COMMAND_RESULT", { command: "SUBSCRIBE", ok: false, message: "Выбран REAL-счёт. Подписка для торговли заблокирована." });
    if (!rec) return post("COMMAND_RESULT", { command: "SUBSCRIBE", ok: false, message: "Нет активного соединения, подтверждённого брокером как DEMO." });
    const asset = String(args.asset || "").trim();
    const period = 5;
    if (!/^[A-Za-z0-9_#]{3,32}$/.test(asset)) return post("COMMAND_RESULT", { command: "SUBSCRIBE", ok: false, message: "Некорректный символ инструмента." });
    const previous = rec.subscribedAsset;
    if (previous && previous !== asset) sendRaw(rec, "unsubfor", previous);
    if (!sendRaw(rec, "subfor", asset)) return post("COMMAND_RESULT", { command: "SUBSCRIBE", ok: false, message: "Не удалось подписаться на поток котировок." });
    sendRaw(rec, "changeSymbol", { asset: asset, period: period });
    const now = Math.floor(Date.now() / 1000);
    const days = Math.min(30, Math.max(1, Number(args.lookbackDays) || 30));
    const offset = Math.max(days * 86400, period * 90);
    sendRaw(rec, "loadHistoryPeriod", { asset: asset, index: now, time: now, offset: offset, period: period });
    rec.subscribedAsset = asset;
    desiredAsset = asset;
    desiredPeriod = period;
    post("COMMAND_RESULT", { command: "SUBSCRIBE", ok: true, message: "Подписка и запрос максимально доступной истории отправлены.", asset: asset });
  }
  function commandOpenOrder(args) {
    const mode = visibleAccountMode();
    const rec = latestDemoSocket();
    if (mode === "real") return post("COMMAND_RESULT", { command: "OPEN_ORDER", ok: false, message: "REAL-счёт обнаружен в торговом интерфейсе. Ордер заблокирован." });
    if (!rec || rec.serverDemo !== true || !rec.demoEndpoint || rec.authenticated !== true) return post("COMMAND_RESULT", { command: "OPEN_ORDER", ok: false, message: "Нет авторизованного соединения с подтверждённым DEMO-счётом." });
    if (rec.pendingOrderId != null || rec.activeDealCount > 0) return post("COMMAND_RESULT", { command: "OPEN_ORDER", ok: false, message: "На стороне брокерского соединения уже есть ожидающий или открытый ордер." });
    const asset = String(args.asset || "").trim();
    const direction = String(args.direction || "").toUpperCase();
    const amount = Number(args.amount);
    const expiry = 15;
    if (!/^[A-Za-z0-9_#]{3,32}$/.test(asset)) return post("COMMAND_RESULT", { command: "OPEN_ORDER", ok: false, message: "Некорректный инструмент." });
    if (direction !== "CALL" && direction !== "PUT") return post("COMMAND_RESULT", { command: "OPEN_ORDER", ok: false, message: "Недопустимое направление." });
    if (!Number.isFinite(amount) || amount < 1 || amount > 50000) return post("COMMAND_RESULT", { command: "OPEN_ORDER", ok: false, message: "Сумма сделки должна быть от 1 до 50000." });
    const requestId = ++requestCounter;
    rec.ownRequestIds.add(String(requestId));
    rec.pendingOrderId = requestId;
    if (rec.ownRequestIds.size > 100) rec.ownRequestIds.delete(rec.ownRequestIds.values().next().value);
    const payload = {
      asset: asset, amount: amount, action: direction.toLowerCase(),
      isDemo: 1, requestId: requestId, optionType: 100, time: expiry
    };
    if (!sendRaw(rec, "openOrder", payload)) {
      rec.ownRequestIds.delete(String(requestId));
      rec.pendingOrderId = null;
      return post("COMMAND_RESULT", { command: "OPEN_ORDER", ok: false, message: "Соединение закрылось до отправки ордера." });
    }
    post("ORDER_SENT", { requestId: requestId, asset: asset, direction: direction, amount: amount, expiry: expiry });
  }
  function handleCommand(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.type !== "COMMAND") return;
    if (data.command === "SUBSCRIBE") commandSubscribe(data.args || {});
    if (data.command === "OPEN_ORDER") commandOpenOrder(data.args || {});
    if (data.command === "REQUEST_STATUS") {
      reportStatus(true);
      const rec = latestDemoSocket();
      if (rec) sendRaw(rec, "updateOpenedDeals");
    }
  }

  window.addEventListener("message", handleCommand, true);
  window.addEventListener("message", function(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const d = event.data;
    if (!d || d.channel !== CHANNEL || d.type !== "COMMAND") return;
  }, true);

  function installSocketHook() {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct: function(Target, args) {
        const ws = Reflect.construct(Target, args, Target);
        const url = String(args[0] || "");
        const host = normalizeHost(url);
        if (host.endsWith(".po.market")) {
          const rec = {
            ws: ws, host: host, demoEndpoint: isDemoHost(host),
            serverDemo: null, balanceKnown: false, authenticated: false,
            lastDataAt: 0, pendingBinaryEvent: null, subscribedAsset: null,
            ownRequestIds: new Set(), pendingOrderId: null, activeDealCount: 0
          };
          sockets.set(ws, rec);
          try { ws.binaryType = "arraybuffer"; } catch (_) {}
          ws.addEventListener("open", function() { reportStatus(true); });
          ws.addEventListener("message", function(event) { onSocketMessage(rec, event.data); });
          ws.addEventListener("close", function() { sockets.delete(ws); reportStatus(true); });
          const originalSend = ws.send;
          ws.send = function(frame) {
            try { parseOutgoing(rec, frame); } catch (_) {}
            return originalSend.apply(ws, arguments);
          };
          reportStatus(true);
        }
        return ws;
      }
    });
  }

  installSocketHook();
  window.addEventListener("pageshow", function() { reportStatus(true); });
  window.addEventListener("focus", function() { reportStatus(true); });
  post("HOOK_READY", { message: "Перехват WebSocket установлен. Ожидаю рыночное соединение." });
})();