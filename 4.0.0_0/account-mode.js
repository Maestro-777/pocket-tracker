(() => {
  'use strict';
  if (window.__PT4_ACCOUNT_MODE__) return;
  window.__PT4_ACCOUNT_MODE__ = true;

  const state = { mode: 'unknown', balance: null, source: 'none', updatedAt: 0 };
  const words = {
    demo: /\\b(demo|practice|virtual)\\b|демо|тренировочн|учебн/i,
    real: /\\b(real|live|เงินจริง)\\b|реальн|боев(ой|ом)/i
  };

  function normalize(value) {
    if (typeof value === 'boolean') return value ? 'demo' : 'real';
    const s = String(value ?? '').trim().toLowerCase();
    if (!s) return 'unknown';
    if (words.demo.test(s)) return 'demo';
    if (words.real.test(s)) return 'real';
    return 'unknown';
  }

  function fromMessage(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [data.accountType, data.account_type, data.accountMode,
      data.account_mode, data.mode, data.typeAccount, data.type_account];
    for (const v of candidates) {
      const mode = normalize(v);
      if (mode !== 'unknown') return { mode, source: 'platform-event' };
    }
    for (const key of ['isDemo', 'is_demo', 'demo', 'practice']) {
      if (typeof data[key] === 'boolean') return { mode: data[key] ? 'demo' : 'real', source: 'platform-event' };
    }
    const demoBalance = data.demoBalance ?? data.demo_balance;
    const realBalance = data.realBalance ?? data.real_balance;
    if (demoBalance != null && realBalance == null) return { mode: 'demo', source: 'balance-event' };
    if (realBalance != null && demoBalance == null) return { mode: 'real', source: 'balance-event' };
    return null;
  }

  function fromDom() {
    const path = location.pathname.toLowerCase();
    if (/\\/(demo|practice)(\\/|$)/.test(path) || /demo-quick-high-low/.test(path)) {
      return { mode: 'demo', source: 'url' };
    }
    const attrs = document.querySelectorAll('[data-account-type],[data-account-mode],[data-balance-type]');
    for (const el of attrs) {
      const value = el.getAttribute('data-account-type') || el.getAttribute('data-account-mode') || el.getAttribute('data-balance-type');
      const mode = normalize(value);
      if (mode !== 'unknown') return { mode, source: 'dom-attribute' };
    }
    const selectors = '[class*="account"],[class*="balance"],[class*="profile"],[data-testid*="account"]';
    for (const el of document.querySelectorAll(selectors)) {
      if (!el.getClientRects().length) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length > 90) continue;
      const mode = normalize(text);
      if (mode !== 'unknown') return { mode, source: 'visible-label' };
    }
    return null;
  }

  function publish(candidate) {
    if (!candidate || candidate.mode === 'unknown') return;
    const balanceText = document.querySelector('[class*="balance"]')?.textContent?.trim() || null;
    const changed = state.mode !== candidate.mode || state.source !== candidate.source;
    state.mode = candidate.mode;
    state.source = candidate.source;
    state.balance = balanceText;
    state.updatedAt = Date.now();
    render();
    if (changed) {
      const payload = { ...state };
      try { chrome.runtime.sendMessage({ type: 'PT4_ACCOUNT_MODE', payload }); } catch (_) {}
      try { window.postMessage({ type: 'PT4_ACCOUNT_MODE', payload }, location.origin); } catch (_) {}
    }
  }

  function render() {
    let badge = document.getElementById('pt4-account-mode-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'pt4-account-mode-badge';
      badge.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:8px 12px;border-radius:9px;font:700 12px/1.2 Arial,sans-serif;letter-spacing:.4px;box-shadow:0 4px 18px #0006;pointer-events:none';
      (document.documentElement || document.body).appendChild(badge);
    }
    const known = state.mode !== 'unknown';
    badge.textContent = known ? (state.mode === 'demo' ? 'PT 4 · DEMO СЧЁТ' : 'PT 4 · REAL СЧЁТ') : 'PT 4 · СЧЁТ НЕ ОПРЕДЕЛЁН';
    badge.style.background = state.mode === 'demo' ? '#123c2b' : state.mode === 'real' ? '#542222' : '#30343b';
    badge.style.color = '#fff';
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PT4_GET_ACCOUNT_MODE') {
      sendResponse({ ...state });
      return true;
    }
  });

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data) return;
    const d = event.data;
    if (d.type === 'POROBOT_BALANCE' || d.type === 'POROBOT_ACCOUNT' || d.type === 'POROBOT_STATE') {
      const candidate = fromMessage(d.payload || d.data || d);
      if (candidate) publish(candidate);
    }
  });

  function scan() {
    const candidate = fromDom();
    if (candidate) publish(candidate);
    else if (state.mode !== 'unknown' && Date.now() - state.updatedAt > 12000) {
      state.mode = 'unknown';
      state.source = 'stale';
      render();
      try { chrome.runtime.sendMessage({ type: 'PT4_ACCOUNT_MODE', payload: { ...state } }); } catch (_) {}
    } else render();
  }

  scan();
  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-account-type', 'data-account-mode', 'data-balance-type'] });
  setInterval(scan, 1800);
})();