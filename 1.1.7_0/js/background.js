const SESSION_KEY = (tabId) => `started_${tabId}`;

async function getStarted(tabId) {
  const key = SESSION_KEY(tabId);
  const result = await chrome.storage.session.get(key);
  return !!result[key];
}

async function setStarted(tabId, value) {
  await chrome.storage.session.set({ [SESSION_KEY(tabId)]: value });
  chrome.tabs.sendMessage(tabId, {
    act: "startedChanged",
    started: value
  }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(SESSION_KEY(tabId));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (msg.act === "getStarted" && tabId !== undefined) {
    getStarted(tabId).then((started) => sendResponse({ started }));
    return true;
  }
  if (msg.act === "setStarted" && tabId !== undefined) {
    setStarted(tabId, !!msg.value).then(() => sendResponse({}));
    return true;
  }
});
