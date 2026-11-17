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

button.addEventListener("click", () => {
  button.disabled = true;
  button.textContent = "Запрашиваю…";
  result.className = "result idle";
  result.textContent = "Отправка запроса в SignalBots…";
  raw.textContent = "Ожидание ответа…";

  chrome.runtime.sendMessage({
    type: "PSC_GET_SIGNAL",
    payload: { pair: $("pair").value, tf: $("tf").value, key: $("key").value.trim() }
  }, response => {
    button.disabled = false;
    button.textContent = "Получить сигнал";
    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message);
      raw.textContent = chrome.runtime.lastError.message;
      return;
    }
    if (!response) {
      showError("Фоновый обработчик не вернул ответ.");
      raw.textContent = "Пустой ответ";
      return;
    }
    raw.textContent = JSON.stringify(response.data !== undefined ? response.data : response, null, 2);
    if (!response.ok) {
      const data = response.data || {};
      let message = response.error || data.message || data.error || "Сервер отклонил запрос.";
      if (response.status === 401 || response.status === 403) {
        message += " Проверьте вход на signalbots.ai и права/лицензию для этого продукта.";
      }
      showError(message, response.status);
      return;
    }
    if (!response.data || typeof response.data !== "object") {
      showError("Сервер вернул пустой или неожиданный ответ.", response.status);
      return;
    }
    showSignal(response.data, response.status);
  });
});
