(() => {
  if (window.__PT_PO_BRIDGE_INSTALLED__) return;
  window.__PT_PO_BRIDGE_INSTALLED__ = true;
  const visible = el => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > .01;
  };
  const hidden = el => {
    if (!el) return true;
    const s = getComputedStyle(el);
    return el.getAttribute('data-hd-show') === '0' || s.display === 'none' || s.visibility === 'hidden';
  };
  const parse = el => {
    if (!el) return null;
    const raw = (el.getAttribute('data-hd-value') || el.getAttribute('data-balance') || el.textContent || '').replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
    if (!raw) return null;
    let value = raw;
    if (value.includes(',') && value.includes('.')) value = value.lastIndexOf(',') > value.lastIndexOf('.') ? value.replace(/\./g, '').replace(',', '.') : value.replace(/,/g, '');
    else if (value.includes(',')) value = value.replace(',', '.');
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const best = selectors => {
    const values = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(el => {
        if (hidden(el) || !visible(el)) return;
        const value = parse(el);
        if (value != null) values.push({ value, top: el.getBoundingClientRect().top, el });
      });
    }
    values.sort((a, b) => a.top - b.top);
    return values[0] || null;
  };
  const active = () => {
    const headerSelectors = ['.balance-info__button','.balance-info__wrap','.header-balance__current','.header-balance__value-wrap','.balance-current','.js-current-account','.balance-info:not(.balance-info--dropdown)','.header__balance','.top-header .balance-info'];
    for (const selector of headerSelectors) {
      const root = document.querySelector(selector);
      if (!visible(root)) continue;
      const real = root.querySelector('.js-balance-real-USD,.js-hd.js-balance-real-USD,.js-balance-real');
      const demo = root.querySelector('.js-balance-demo,.js-hd.js-balance-demo');
      if (real && !hidden(real) && parse(real) != null) return { type: 'real', balance: parse(real) };
      if (demo && !hidden(demo) && parse(demo) != null) return { type: 'demo', balance: parse(demo) };
    }
    const demo = best(['.js-balance-demo','.js-hd.js-balance-demo','[class*="js-balance-demo"]','[class*="balance-demo"]']);
    const real = best(['.js-balance-real-USD','.js-hd.js-balance-real-USD','.js-balance-real','[class*="js-balance-real"]','[class*="balance-real"]']);
    const demoActive = document.querySelector('.accounts-list__item--demo.active,.accounts-list__item--demo.is-active,.accounts-list__item--demo.selected,.balance-type-demo.active,[data-account-type="demo"].active,.switcher__btn--demo.active,.header-balance__item--demo.active,.js-switch-to-demo.active');
    const realActive = document.querySelector('.accounts-list__item--real.active,.accounts-list__item--real.is-active,.accounts-list__item--real.selected,[data-account-type="real"].active,.switcher__btn--real.active,.header-balance__item--real.active');
    if (realActive && !demoActive && real) return { type: 'real', balance: real.value };
    if (demoActive && !realActive && demo) return { type: 'demo', balance: demo.value };
    const top = best(['.js-balance-demo','.js-hd.js-balance-demo','.js-balance-real-USD','.js-hd.js-balance-real-USD','.js-balance-real']);
    if (top) {
      const cls = String(top.el.className || '');
      if (/real/i.test(cls)) return { type: 'real', balance: top.value };
      if (/demo/i.test(cls)) return { type: 'demo', balance: top.value };
    }
    return null;
  };
  let last = '';
  const tick = () => {
    const info = active();
    const state = {
      accountType: info?.type || null, balance: info?.balance ?? null,
      authenticated: !!document.querySelector('.block--expiration-inputs,.btn-call,.btn-put,.js-balance-demo,.js-balance-real-USD'),
      url: location.href, ts: Date.now()
    };
    window.__PT_PO_STATUS__ = state;
    const key = JSON.stringify([state.accountType, state.balance, state.authenticated]);
    if (key !== last && state.accountType && state.balance != null) {
      last = key;
      window.postMessage({ type: 'PT_PO_BALANCE', ...state }, location.origin);
    }
  };
  tick();
  const observer = new MutationObserver(() => tick());
  const attach = () => {
    if (document.documentElement) observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class','style','data-hd-show','data-hd-value','data-balance','aria-selected','aria-current'] });
  };
  attach();
  setInterval(tick, 1000);
  window.addEventListener('pageshow', () => setTimeout(tick, 250));
  window.addEventListener('popstate', () => setTimeout(tick, 500));
  window.postMessage({ type: 'PT_PO_LOG', message: 'Адаптер баланса запущен' }, location.origin);
})();