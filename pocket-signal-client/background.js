"use strict";

const SIGNAL_URL = "https://signalbots.ai/tools/binary-option/chinese-bot/signal";
const ITEM = "ext-pocket-option";


const LICENSE_URL = "https://signalbots.ai/tools/binary-option/chinese-bot/web-license";

function checkLicense(input) {
  const value = String(input.credential || "").trim();
  let key = "";
  let lt = "";
  try {
    const parsed = new URL(value);
    key = parsed.searchParams.get("key") || "";
    lt = parsed.searchParams.get("lt") || "";
  } catch (_) {
    if (/^sb-/i.test(value)) key = value;
    else if (value) lt = value;
  }
  key = key.toUpperCase();
  const params = new URLSearchParams();
  if (key) params.set("key", key);
  if (lt) params.set("lt", lt);
  params.set("item", ITEM);
  params.set("broker", "pocket-option");
  return fetch(LICENSE_URL + "?" + params.toString(), {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  }).then(async response => {
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    return { ok: response.ok, status: response.status, data, key, lt };
  });
}

function makeSignalUrl(input) {
  const params = new URLSearchParams();
  params.set("broker", "pocket-option");
  params.set("mode", "real");
  params.set("pair", input.pair);
  params.set("tf", input.tf);
  params.set("salt", "0");
  params.set("item", ITEM);
  if (input.key) params.set("key", input.key.trim());
  return SIGNAL_URL + "?" + params.toString();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.type === "PSC_CHECK_LICENSE") {
    checkLicense(message.payload || {}).then(sendResponse).catch(error => sendResponse({ ok: false, status: 0, error: error.message || String(error) }));
    return true;
  }
  if (message.type !== "PSC_GET_SIGNAL") return false;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Недопустимый источник запроса." });
    return false;
  }

  const input = message.payload || {};
  const allowedPairs = ["AUDCAD","AUDCHF","AUDJPY","AUDUSD","CHFJPY","EURAUD","EURCAD","EURCHF","EURGBP","EURJPY","EURUSD","GBPAUD","GBPJPY","GBPUSD","UKOIL"];
  const allowedTimeframes = ["1M","3M","5M","30M","1H","4H"];
  if (!allowedPairs.includes(input.pair) || !allowedTimeframes.includes(input.tf)) {
    sendResponse({ ok: false, error: "Недопустимая валютная пара или таймфрейм." });
    return false;
  }

  fetch(makeSignalUrl(input), {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  })
    .then(async response => {
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) {
        data = { raw: text };
      }
      sendResponse({ ok: response.ok, status: response.status, data });
    })
    .catch(error => sendResponse({
      ok: false,
      status: 0,
      error: error && error.message ? error.message : String(error)
    }));
  return true;
});
