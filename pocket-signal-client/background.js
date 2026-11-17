"use strict";

const SIGNAL_URL = "https://signalbots.ai/tools/binary-option/chinese-bot/signal";
const ITEM = "ext-pocket-option";

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
  if (!message || message.type !== "PSC_GET_SIGNAL") return false;
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
