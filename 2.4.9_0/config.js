/*
 * PocketOption AI Scalper Robot — single-broker configuration.
 *
 * Same engine as the sibling pocket-otc-bot (popup.js/popup.html/background.js
 * ported unchanged), but this product trades PocketOption's REAL market, not
 * OTC — the broker and the market are both fixed and not selectable. Beyond
 * signalling it can Auto-Trade — place the CALL/PUT on the PocketOption page via
 * pocket-socket.js, a from-scratch Engine.IO v4 / Socket.IO v4 client. The static
 * pair fallback mirrors binary_signal.REAL_PAIRS (broker-agnostic real-market
 * list); reads come from the shared SignalBots endpoint (background.js), keyed
 * by broker=pocket-option & mode=real, so a read matches the web tool for the
 * same candle. This product replaces the previous "PocketOption AI Scalper
 * Robot" v1.0.7 build, which ran on a separate data.signalbots.ai license/auth
 * backend — see _legacy-v1.0.7/ for the retired files.
 */
(function (root) {
  "use strict";

  function label(code) {
    if (code.length === 6) { return code.slice(0, 3) + "/" + code.slice(3); }
    return code;
  }

  var CB_CONFIG = {
    APP_NAME: "PocketOption AI Scalper Robot",
    APP_NAME_HTML: "PocketOption AI <b>Scalper</b> Robot",
    APP_TAGLINE: "AI signals & auto-trade",

    SIGNAL_URL: "https://signalbots.ai/tools/binary-option/chinese-bot/signal",
    LICENSE_URL: "https://signalbots.ai/tools/binary-option/chinese-bot/web-license",
    LANDING_URL: "https://signalbots.ai/trading-bots/pocket-option",
    REGISTER_URL: "https://signalbots.ai/accounts/signup/",

    WHATSAPP: "971588875100",

    // Register -> OUR Pocket Option affiliate/IB link (markets_catalog.BINARY_
    // BROKER_AFFILIATES["pocket-option"]). Opened rel="sponsored nofollow noopener".
    AFFILIATE_URL: "https://u3.shortink.io/register?utm_campaign=4955&utm_source=affiliate&utm_medium=sr&a=VrQlSIZqLZfZcc&al=1757261&ac=signalbotsai&cid=953612",

    TELEGRAM_POOL: ["SignalBotsai", "SignalBots_ai", "Signalbots2"],

    TRIAL_DAYS: 7,

    SHOW_BROKER: false,
    SHOW_MARKET: false,
    // The fixed market for this build, applied by popup.js whenever SHOW_MARKET
    // is false. pocket-otc-bot is the OTC counterpart of this same broker/engine.
    MARKET: "real",
    ALLOW_AUTOTRADE: true,

    // Licensable-item key (sent as ?item=). One license covers Pocket Option's
    // WHOLE extension family — this real-market scalper and the OTC bot — so
    // both send the broker's single item key, never a market-suffixed one. The
    // server folds any legacy "-otc"/"-real" suffix onto this key anyway
    // (licensing.services.canonical_item_key). See BUSINESS-MAP.md §4.9.
    ITEM: "ext-pocket-option",

    label: label,

    BROKER: { key: "pocket-option", label: "PocketOption" },

    SOCKET_FILE: "pocket-socket.js",

    // Host fragments used to locate the open PocketOption tab for auto-trade.
    BROKER_HOSTS: ["pocketoption.com", "po.trade", "pocket-broker.com"],

    // Mirrors binary_signal.REAL_PAIRS (broker-agnostic — every broker's "Real
    // market" mode shows this same list). Traded as the bare code, no suffix,
    // unlike the OTC bot's <CODE>_otc. This is only the static bootstrap shown
    // before the tab's own live asset list arrives (see pocket-socket.js).
    STATIC_PAIRS: {
      "pocket-option": [
        "AUDCAD", "AUDCHF", "AUDJPY", "AUDUSD", "UKOIL", "CHFJPY", "EURAUD",
        "EURCAD", "EURCHF", "EURGBP", "EURJPY", "EURUSD", "GBPAUD", "GBPJPY",
        "GBPUSD"
      ]
    },

    // Real-market expiries only. PocketOption's sub-minute expiries (5s / 10s /
    // 15s / 30s) are an OTC-asset feature: the broker answers a real-market
    // order carrying one with `failopenOrder {"error":"IncorrectExpTime"}` and
    // places nothing, which is what "Trade failed: IncorrectExpTime" on CHFJPY
    // was. Offering them here is a trap, so the ladder starts at one minute and
    // the four short ones stay in the OTC sibling (pocket-otc-bot) that can
    // actually trade them. pocket-socket.js still learns any further
    // asset-specific rejection at runtime, so this list being wrong costs one
    // rejected order rather than a stopped run.
    // PocketOption's own live-market ladder: M1, M3, M5, M30, H1, H4 — the OTC
    // list without its three sub-minute steps. Sub-minute expiries are an
    // OTC-asset feature here: the same order against a real-market pair comes
    // back "IncorrectExpTime" with nothing opened.
    TIMEFRAMES: [
      { code: "1M", label: "1 min", free: false },
      { code: "3M", label: "3 min", free: false },
      { code: "5M", label: "5 min", free: false },
      { code: "30M", label: "30 min", free: false },
      { code: "1H", label: "1 hour", free: false },
      { code: "4H", label: "4 hour", free: true }
    ],

    STAKE_STEPS: [1, 2, 3, 5, 10],
    STAKE_AMOUNTS: [1, 2, 5, 10, 25, 50],

    DEFAULTS: { tf: "1M" }
  };

  root.CB_CONFIG = CB_CONFIG;
})(typeof self !== "undefined" ? self : this);
