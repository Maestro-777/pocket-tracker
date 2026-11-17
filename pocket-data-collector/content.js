(() => {
  "use strict";
  const marker = "POCKET_DATA_COLLECTOR";
  let lastState = "";
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.__pdc !== marker) return;
    const data = event.data;
    if (data.kind === "PAGE_STATE") {
      const key = JSON.stringify(data.payload);
      if (key === lastState) return;
      lastState = key;
    }
    chrome.runtime.sendMessage({
      type: "PDC_PAGE_MESSAGE",
      kind: data.kind,
      payload: data.payload,
      at: data.at || Date.now(),
      href: location.href,
      isTop: window === window.top
    }).catch(() => {});
  });
  chrome.runtime.sendMessage({
    type: "PDC_CONTENT_READY",
    href: location.href,
    isTop: window === window.top
  }).catch(() => {});
})();