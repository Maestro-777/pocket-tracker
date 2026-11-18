(() => {
  'use strict';

  if (window !== window.top || window.__PT_DESKTOP_BG_PROBE__) return;

  const state = {
    startedAt: Date.now(),
    ticks: 0,
    lastTickAt: Date.now()
  };

  window.__PT_DESKTOP_EXTENSION_INJECTED__ = true;
  window.__PT_DESKTOP_BG_PROBE__ = state;

  window.setInterval(() => {
    state.ticks += 1;
    state.lastTickAt = Date.now();
    state.visibilityState = document.visibilityState;
  }, 1000);
})();