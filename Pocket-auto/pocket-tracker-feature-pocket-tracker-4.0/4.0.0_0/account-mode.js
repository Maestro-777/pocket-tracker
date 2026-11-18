(() => {
  'use strict';
  // Top-frame only. This module deliberately avoids document-wide MutationObservers
  // and polling: those can starve the trading page's main thread.
  if (window !== window.top || window.__PT4_ACCOUNT_MODE__) return;
  window.__PT4_ACCOUNT_MODE__ = true;

  const state = { mode: 'unknown', balance: null, source: 'none', updatedAt: 0 };
  const demoRe = /\b(demo|practice|virtual)\b|демо|тренировочн|учебн/i;
  const realRe = /\b(real|live)\b|реальн|боев(ой|ом)/i;
  let badge = null;

  function normalize(value) {
    if (typeof value === 'boolean') return value ? 'demo' : 'real';
    const valueText = String(value ?? '').trim().toLowerCase();
    if (!valueText) return 'unknown';
    if (demoRe.test(valueText)) return 'demo';
    if (realRe.test(valueText)) return 'real';
    return 'unknown';
  }

  function fromBalanceEvent(data) {
    if (!data || typeof data !== 'object') return null;
    const direct = normalize(data.accountType ?? data.account_type ??
      data.accountMode ?? data.account_mode ?? data.mode);
    if (direct !== 'unknown') return { mode: direct, source: 'platform-event' };

    for (const key of ['isDemo', 'is_demo', 'demo_account', 'isDemoAccount']) {
      if (typeof data[key] === 'boolean' || data[key] === 0 || data[key] === 1 || data[key] === '0' || data[key] === '1') {
        return { mode: data[key] === true || data[key] === 1 || data[key] === '1' ? 'demo' : 'real', source: 'platform-event' };
      }
    }
    if (data.demoBalance != null && data.realBalance == null) return { mode: 'demo', source: 'balance-event' };
    if (data.realBalance != null && data.demoBalance == null) return { mode: 'real', source: 'balance-event' };
    return null;
  }

  function fromExplicitDom() {
    const path = location.pathname.toLowerCase();
    if (/\/(demo|practice)(\/|$)/.test(path) || /demo-quick-high-low/.test(path)) {
      return { mode: 'demo', source: 'url' };
    }
    const el = document.querySelector(
      '[data-account-type],[data-account-mode],[data-is-demo],[data-demo-account],.account-type,.account-mode,[data-testid="account-type"]'
    );
    if (!el) return null;
    const value = el.getAttribute('data-account-type') ||
      el.getAttribute('data-account-mode') ||
      el.getAttribute('data-is-demo') ||
      el.getAttribute('data-demo-account') ||
      el.textContent;
    const mode = normalize(value);
    return mode === 'unknown' ? null : { mode, source: 'explicit-dom-label' };
  }

  function render() {
    const text = state.mode === 'demo' ? 'PT 4 · DEMO СЧЁТ' :
      state.mode === 'real' ? 'PT 4 · REAL СЧЁТ' : 'PT 4 · СЧЁТ НЕ ОПРЕДЕЛЁН';
    const background = state.mode === 'demo' ? '#123c2b' :
      state.mode === 'real' ? '#542222' : '#30343b';

    if (!badge || !badge.isConnected) {
      badge = document.createElement('div');
      badge.id = 'pt4-account-mode-badge';
      badge.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:8px 12px;border-radius:9px;font:700 12px/1.2 Arial,sans-serif;letter-spacing:.4px;box-shadow:0 4px 18px #0006;pointer-events:none';
      (document.body || document.documentElement).appendChild(badge);
    }
    // Avoid DOM writes when the displayed state has not changed.
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.style.background !== background) badge.style.background = background;
    if (badge.style.color !== '#fff') badge.style.color = '#fff';
  }

  function publish(candidate, balance) {
    if (!candidate || candidate.mode === 'unknown') return;
    const changed = state.mode !== candidate.mode;
    state.mode = candidate.mode;
    state.source = candidate.source;
    if (balance != null && Number.isFinite(Number(balance))) state.balance = Number(balance);
    state.updatedAt = Date.now();
    if (changed) {
      render();
      try {
        chrome.runtime.sendMessage({ type: 'PT4_ACCOUNT_MODE', payload: { ...state } });
      } catch (_) {}
    } else if (!badge || !badge.isConnected) {
      render();
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.type !== 'POROBOT_BALANCE') return;
    const candidate = fromBalanceEvent(event.data);
    if (candidate) publish(candidate, event.data.balance);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PT4_GET_ACCOUNT_MODE') {
      sendResponse({ ...state });
      return true;
    }
  });

  function scanExplicitDom() {
    const candidate = fromExplicitDom();
    if (candidate) publish(candidate, null);
    else render();
  }

  // DOM is only inspected a few times after the document is ready; no global observer.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanExplicitDom, { once: true });
  } else {
    scanExplicitDom();
  }
  setTimeout(scanExplicitDom, 1800);
  setTimeout(scanExplicitDom, 5000);
})();