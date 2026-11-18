// bridge/grant.js — запрос опционального доступа ко всем сайтам (по клику пользователя).
(function () {
    'use strict';
    const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
    const ORIGINS = ['*://*/*'];
    // Firefox: в том же клике спрашиваем согласие на передачу статистики (optional data_collection).
    // Отказ не мешает оверлею — не уходит только статистика.
    const IS_FIREFOX = !!(api.runtime.getManifest().browser_specific_settings || {}).gecko;
    const DATA_COLLECTION = ['websiteActivity', 'financialAndPaymentInfo'];
    const btn = document.getElementById('grant');
    const status = document.getElementById('status');

    function render(perm) {
        btn.hidden = !!perm;
        status.textContent = perm
            ? 'Готово. Включите бота в приложении и обновите вкладку с зеркалом.'
            : '';
    }

    btn.addEventListener('click', function () {
        // request() должен вызываться синхронно в обработчике клика
        const req = { origins: ORIGINS };
        if (IS_FIREFOX) req.data_collection = DATA_COLLECTION;
        Promise.resolve(api.permissions.request(req))
            .then(function (granted) {
                render(granted);
                if (!granted) status.textContent = 'Доступ не выдан. Без него бот работает только на pocketoption.com.';
            })
            .catch(function (e) { status.textContent = 'Ошибка: ' + (e && e.message || e); });
    });

    Promise.resolve(api.permissions.contains({ origins: ORIGINS })).then(render).catch(function () {});
})();
