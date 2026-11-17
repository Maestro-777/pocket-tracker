// Isolated-world receiver and local IndexedDB store. No trading actions.
(() => {
  "use strict";
  const SOURCE = "POCKET_PATTERN_LAB_PAGE";
  const DB_NAME = "pocket-pattern-lab";
  const DB_VERSION = 1;
  const STORE = "candles";
  const live = { connected: false, sockets: 0, events: 0, ticks: 0, candles: 0, assets: 0, lastEventAt: 0, lastError: "" };
  const currentBars = new Map();
  let dbPromise;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("asset_period_time", ["asset", "period", "time"], { unique: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function putCandles(rows) {
    if (!rows.length) return;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const c of rows) store.put(c);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    live.candles += rows.length;
  }

  function normalizeAsset(v) {
    return String(v || "").trim().toUpperCase().replace(/\s+/g, "").replace(/_OTC$/i, "_OTC");
  }
  function validOhlc(c) {
    return c && [c.open,c.high,c.low,c.close].every(Number.isFinite) &&
      c.open > 0 && c.high >= Math.max(c.open,c.close) &&
      c.low <= Math.min(c.open,c.close) && c.low > 0;
  }
  function epochMs(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? Math.floor(n) : Math.floor(n * 1000);
  }

  function detectLayout(rows) {
    let ohlc = 0, ochl = 0;
    for (const r of rows.slice(0, 50)) {
      if (!Array.isArray(r) || r.length < 5) continue;
      const a = Number(r[1]), b = Number(r[2]), c = Number(r[3]), d = Number(r[4]);
      if (![a,b,c,d].every(Number.isFinite)) continue;
      const hi = Math.max(a,b,c,d), lo = Math.min(a,b,c,d);
      if (b === hi && c === lo) ohlc++;
      if (c === hi && d === lo) ochl++;
    }
    if (ohlc > ochl && ohlc > 0) return { open:1, high:2, low:3, close:4 };
    if (ochl > 0) return { open:1, high:3, low:4, close:2 };
    return null;
  }

  async function ingestHistory(payload) {
    const data = Array.isArray(payload) ? payload[0] : payload;
    if (!data || !data.asset || !Array.isArray(data.history || data.data)) return;
    const rows = data.history || data.data;
    const period = Number(data.period || 0);
    if (!period) return;
    const layout = detectLayout(rows);
    if (!layout) {
      // Price-only history is not misrepresented as OHLC.
      live.lastError = "Сервер прислал историю без подтверждённого OHLC";
      return;
    }
    const asset = normalizeAsset(data.asset), out = [];
    for (const row of rows) {
      let c;
      if (Array.isArray(row) && row.length >= 5) {
        const t = epochMs(row[0]);
        c = { time: t, open:Number(row[layout.open]), high:Number(row[layout.high]),
          low:Number(row[layout.low]), close:Number(row[layout.close]), volume:0 };
      } else if (row && typeof row === "object") {
        const t = epochMs(row.time ?? row.t ?? row.ts);
        c = { time:t, open:Number(row.open ?? row.o), high:Number(row.high ?? row.h),
          low:Number(row.low ?? row.l), close:Number(row.close ?? row.c), volume:Number(row.volume || 0) };
      }
      if (!c || !c.time || !validOhlc(c)) continue;
      c.time = Math.floor(c.time / (period * 1000)) * period * 1000;
      out.push({ id: asset + "|" + period + "|" + c.time, asset, period, ...c, source:"history" });
    }
    await putCandles(out);
  }

  async function ingestTicks(payload) {
    const rows = Array.isArray(payload) ? payload : [payload];
    const updates = new Map();
    for (const row of rows) {
      let asset, time, price;
      if (Array.isArray(row) && row.length >= 3) {
        [asset] = row; time = epochMs(row[1]); price = Number(row[2]);
      } else if (row && typeof row === "object") {
        asset = row.asset;
        if (Array.isArray(row.prices)) {
          for (const tick of row.prices) {
            await ingestTicks([{asset, time:tick.time ?? tick.t, price:tick.price ?? tick.p}]);
          }
          continue;
        }
        time = epochMs(row.time ?? row.timestamp ?? row.t);
        price = Number(row.price ?? row.close ?? row.p);
      }
      asset = normalizeAsset(asset);
      if (!asset || !time || !Number.isFinite(price) || price <= 0) continue;
      live.ticks++;
      const period = 5, bucket = Math.floor(time / 5000) * 5000;
      const id = asset + "|" + period + "|" + bucket;
      let bar = currentBars.get(id);
      if (!bar) bar = { id, asset, period, time:bucket, open:price, high:price, low:price, close:price, volume:0, source:"ticks" };
      else { bar.high=Math.max(bar.high,price); bar.low=Math.min(bar.low,price); bar.close=price; }
      currentBars.set(id,bar);
      updates.set(id,bar);
    }
    if (updates.size) await putCandles([...updates.values()]);
  }

  async function handle(kind, payload) {
    live.events++; live.lastEventAt = Date.now();
    if (kind === "SOCKET") {
      live.connected = !!payload?.connected;
      live.sockets = payload?.socketCount || live.sockets;
    } else if (kind === "updateAssets") {
      const rows = Array.isArray(payload) ? payload : (payload?.assets || [payload]);
      live.assets = rows.filter(Boolean).length;
    } else if (kind === "quotes/stream" || kind === "updateStream") {
      await ingestTicks(payload);
    } else if (["history/list/v2","updateHistoryNew","updateHistoryNewFast","loadHistoryPeriod","loadHistoryPeriodFast"].includes(kind)) {
      await ingestHistory(payload);
    }
    window.dispatchEvent(new CustomEvent("ppl-status", { detail: { ...live } }));
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    handle(event.data.kind, event.data.payload).catch(err => {
      live.lastError = String(err?.message || err);
      window.dispatchEvent(new CustomEvent("ppl-status", { detail: { ...live } }));
    });
  });

  async function status() {
    const db = await openDb();
    const count = await new Promise((resolve,reject) => {
      const req = db.transaction(STORE).objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return { ok:true, mode:"observe-only", ...live, storedCandles:count };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "PPL_GET_STATUS") {
      status().then(reply).catch(err => reply({ok:false,error:String(err)}));
      return true;
    }
    if (msg?.type === "PPL_GET_CANDLES") {
      (async () => {
        const db = await openDb();
        return await new Promise((resolve,reject) => {
          const req = db.transaction(STORE).objectStore(STORE).getAll();
          req.onsuccess = () => resolve({ok:true,candles:req.result});
          req.onerror = () => reject(req.error);
        });
      })().then(reply).catch(err => reply({ok:false,error:String(err)}));
      return true;
    }
  });
})();
