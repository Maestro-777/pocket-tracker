"use strict";

const $ = id => document.getElementById(id);
const button = $("getSignal");
const result = $("result");
const raw = $("raw");

function showError(message, status) {
  result.className = "result error";
  result.textContent = "";
  const title = document.createElement("h2");
  title.textContent = "Не удалось получить сигнал";
  const detail = document.createElement("div");
  detail.className = "meta";
  detail.textContent = (status ? "HTTP " + status + " · " : "") + message;
  result.append(title, detail);
}

function showSignal(data, status) {
  result.className = "result";
  result.textContent = "";
  const direction = String(data && (data.direction || data.word || data.signal) || "").toLowerCase();
  const isCall = /^(call|buy|вверх|up)$/i.test(direction);
  const isPut = /^(put|sell|вниз|down)$/i.test(direction);
  if (isCall || isPut) {
    result.classList.add(isCall ? "call" : "put");
    const title = document.createElement("h2");
    title.textContent = isCall ? "CALL · ВВЕРХ" : "PUT · ВНИЗ";
    result.appendChild(title);
  } else {
    const title = document.createElement("h2");
    title.textContent = "Ответ получен";
    result.appendChild(title);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  const pair = data && data.pair ? data.pair : $("pair").value;
  const tf = data && data.tf ? data.tf : $("tf").value;
  const strength = data && data.strength != null ? " · сила: " + data.strength : "";
  meta.textContent = pair + " · " + tf + " · HTTP " + status + strength;
  result.appendChild(meta);
  if (!isCall && !isPut) {
    const note = document.createElement("div");
    note.className = "meta";
    note.textContent = "Направление не распознано автоматически — проверьте полный JSON ниже.";
    result.appendChild(note);
  }
}

function sendMessage(payload) {
  return new Promise(resolve => chrome.runtime.sendMessage(payload, response => {
    if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
    else resolve(response || { ok: false, error: "Пустой ответ" });
  }));
}

button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "Проверяю доступ…";
  result.className = "result idle";
  result.textContent = "Проверка лицензии SignalBots…";
  raw.textContent = "Ожидание ответа…";

  const credential = $("key").value.trim();
  const license = await sendMessage({
    type: "PSC_CHECK_LICENSE",
    payload: { credential }
  });

  if (!license || !license.ok || !license.data || !license.data.licensed) {
    button.disabled = false;
    button.textContent = "Получить сигнал";
    const data = license && license.data || {};
    const reason = license && (license.error || data.message || data.error)
      || "Лицензия не подтверждена сервером.";
    showError(reason + " Войдите на signalbots.ai или используйте действующий SB-ключ / unlock-ссылку.", license && license.status);
    raw.textContent = JSON.stringify(license && (license.data || license) || {}, null, 2);
    return;
  }

  button.textContent = "Запрашиваю сигнал…";
  result.textContent = "Доступ подтверждён. Запрашиваю серверный сигнал…";
  const signal = await sendMessage({
    type: "PSC_GET_SIGNAL",
    payload: {
      pair: $("pair").value,
      tf: $("tf").value,
      key: license.key || ""
    }
  });

  button.disabled = false;
  button.textContent = "Получить сигнал";
  raw.textContent = JSON.stringify(signal && (signal.data !== undefined ? signal.data : signal), null, 2);
  if (!signal || !signal.ok) {
    const data = signal && signal.data || {};
    showError(signal && (signal.error || data.message || data.error) || "Сервер отклонил запрос после проверки лицензии.", signal && signal.status);
    return;
  }
  if (!signal.data || typeof signal.data !== "object") {
    showError("Сервер вернул пустой или неожиданный ответ.", signal.status);
    return;
  }
  showSignal(signal.data, signal.status);
});
