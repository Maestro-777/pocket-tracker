// market/market.js — экран «Маркет» пресетов, общий для браузерного расширения (≥ 3.6.0) и Windows-приложения.
// Источник правды — корень монорепо; в приложение копируется как WebCore/app-market.js (Windows/build/sync-webcore.mjs).
// Экран живёт внутри панели #pos-panel (режим .market-mode): каталог, «Мои», официальные, деталь пресета, применение
// с откатом, сохранение в библиотеку, публикация, покупка за USDT (счёт TRC20). Стили — .pos-mk-* в css/bot-ui.css.
// Хост — __posChrome.posApp:
//   приложение (host-shim.js): market(action, params) → C# MarketService (токен лицензии в страницу не попадает),
//     панель — выезжающая posApp.drawer (app-drawer.js), язычок #pos-market-handle (app-drawer.css);
//   расширение (market/ext-host.js, posApp.host === 'extension'): market() → background.js → /api/market.php с токеном
//     маркета (вход email + паролем аккаунта, posApp.account), панель плавающая, кнопка 🏪 в шапке панели бота.
// Снимок/применение настроек — posApp.core из content.js. Протокол API — Windows/ARCHITECTURE.md §15–16 и §18,
// экраны A1–A9 — Windows/MARKETPLACE-SCREENS.md. qrcode — генератор QR (market/qrcode.js): в приложении локальная
// функция бандла (TradingCore.BuildBundle), в расширении — глобальная функция изолированного мира content scripts.
(function () {
    'use strict';
    if (window !== window.top) return;
    var posApp = (typeof __posChrome !== 'undefined' && __posChrome) ? __posChrome.posApp : null;
    if (!posApp) return;
    // Расширение: своя плавающая панель и свой вход в аккаунт. Приложение: выезжающая панель, вход — у приложения.
    var EXT = posApp.host === 'extension';

    // ── Тексты ───────────────────────────────────────────────────────
    var TXT = {
        ru: {
            handle: 'Маркет пресетов', handle_upd: 'Есть обновления установленных пресетов',
            title: 'Маркет', close: 'Закрыть', back: 'Назад',
            tab_catalog: 'Каталог', tab_my: 'Мои', tab_official: 'Официальные',
            search: 'Название, ник автора…', filters: 'Фильтры', reset: 'Сбросить фильтры',
            sort_popular: 'Популярные', sort_new: 'Новые', sort_rating: 'Рейтинг', sort_installs: 'По установкам',
            f_exp: 'Экспирация', f_ind: 'Индикаторы', f_mm: 'Система ставок', f_risk: 'Риск', f_price: 'Цена', f_lang: 'Язык описания',
            all: 'Все', free_p: 'Бесплатные', paid_p: 'Платные',
            risk_low: 'Низкий', risk_medium: 'Средний', risk_high: 'Высокий',
            risk_low_c: 'Низкий риск', risk_medium_c: 'Средний риск', risk_high_c: 'Высокий риск',
            free: 'Бесплатно', official: 'Official', more: 'Ещё 20',
            installs: 'установок', installed: '✓ установлен', purchased: '✓ куплен', own: 'ваш', upd: '↑ обновление до v',
            wr_none: 'мало данных', wr: 'винрейт', wr_deals: 'сделок, реальный счёт',
            empty_found: 'Ничего не найдено по заданным фильтрам.', empty: 'Пока здесь пусто.',
            net_err: 'Нет соединения с сервером маркета.', retry: 'Повторить',
            not_logged: 'Вы не вошли в приложение — каталог виден, но для установки, покупки и библиотеки нужно войти в аккаунт.',
            save_current: '💾 Сохранить текущие настройки', my_lib: 'Моя библиотека', my_bought: 'Купленные', my_inst: 'Установленные',
            of: 'из', private: 'приватный', published: 'опубликован', sales: 'продаж', removed: 'снят автором',
            params: 'Параметры', ind: 'Индикаторы', exp: 'Экспирация', mm: 'Система ставок', modes: 'Режим входа',
            tp_tl: 'TP / TL', tp_tl_off: 'значения есть, лимиты не включаются', htf: 'Фильтр старшего ТФ', on: 'вкл', off: 'выкл',
            risk: 'Риск', stats: 'Статистика', installs_c: 'Установки', rating: 'Рейтинг', version: 'Версия', updated: 'обновлён',
            lock_note: 'Параметры индикаторов скрыты до покупки. Видны: индикаторы, экспирация, ММ, риск, статистика.',
            locked_title: 'Параметры индикаторов', available: 'Доступно без покупки', mm_keep: 'не меняется (ваша)',
            apply: 'Применить', buy: 'Купить за', update_to: 'Обновить до v', uninstall: 'Убрать из моих',
            publish: 'Опубликовать', change_price: 'Изменить цену', unpublish: 'Снять с публикации', delete: 'Удалить',
            apply_q: 'Применить «%s»?', risky: '⚠️ Рискованная настройка: %s.', keep_note: 'Ваша ставка и автоторговля не меняются.',
            cancel: 'Отмена', applied: 'Применено', undo: 'Вернуть мои настройки', restored: 'Ваши настройки возвращены',
            save_title: 'Сохранить в библиотеку', name: 'Название (3–60)', desc: 'Описание (до 500)', lang: 'Язык',
            preview: 'Предпросмотр — уйдёт на сервер', not_sent: 'Ставка, баланс, автоторговля', not_sent_v: 'не передаются',
            links_note: 'Ссылки и контакты в описании удаляются автоматически.', save: 'Сохранить', saved: 'Сохранено в библиотеку',
            publish_title: 'Опубликовать «%s»', price_title: 'Цена «%s»', seg_free: 'Бесплатно', seg_paid: 'Платно',
            price: 'Цена, USDT (%s–%s)', fee: 'Комиссия %s% — вы получите %s USDT с продажи.',
            need_nick: '🪪 Нет ника — задайте его на сайте, чтобы публиковать пресеты.', open_profile: 'Открыть профиль',
            need_wallet: '👛 Для платных пресетов добавьте TRC20-адрес для выплат в профиле.',
            dup: 'Такой пресет уже опубликован.', open: 'Открыть', published_ok: 'Опубликовано', price_ok: 'Цена изменена',
            unpub_q: 'Снять «%s» с публикации?', unpub_note: 'Пресет останется в вашей библиотеке и у тех, кто его установил или купил.',
            del_q: 'Удалить «%s»?', del_note: 'Пресет пропадёт из библиотеки и у установивших. У купивших он останется.',
            unpub_ok: 'Снято с публикации', del_ok: 'Удалено', uninst_ok: 'Убрано из «Моих»', updated_ok: 'Обновлено до v',
            invoice: 'Счёт #', waiting: 'Ждём перевод…', copy: 'Скопировано',
            pay_note: 'Переведите ровно эту сумму — она уникальна для этого счёта. Только сеть TRC20. Возвратов нет.',
            open_pay: 'Открыть страницу оплаты в браузере', have_paid: 'Уже оплатил — указать хеш транзакции',
            tx_ph: 'Хеш транзакции или ссылка tronscan', check: 'Проверить',
            paid: 'Оплачено', paid_text: 'Пресет «%s» добавлен в «Купленные».',
            expired: 'Срок истёк', expired_text: 'Если уже перевели — укажите хеш транзакции.', new_invoice: 'Новый счёт', enter_tx: 'Указать хеш',
            underpaid: 'Недоплата', underpaid_text: 'Получено %s USDT при цене %s USDT. Возврата нет.',
            canceled: 'Счёт отменён', loading: 'Загрузка…',
            not_logged_ext: 'Каталог виден без входа. Чтобы применять, сохранять, публиковать и покупать пресеты, войдите в аккаунт PocketOption Signal (тот же, что на сайте и в приложении для Windows).',
            login: 'Войти', login_title: 'Вход в аккаунт', email: 'Email', password: 'Пароль', totp: 'Код 2FA (6 цифр)',
            login_note: 'Аккаунт тот же, что на сайте и в приложении для Windows. Пароль в расширении не сохраняется.',
            register: 'Регистрация', forgot: 'Забыли пароль?', logout: 'Выйти', signed_as: 'Вы вошли как',
            logged_in: 'Вы вошли в аккаунт', logged_out: 'Вы вышли из аккаунта',
            mm_names: { fixed: 'Фикс', martingale: 'Мартингейл', anti_mart: 'Антимартингейл', fibonacci: 'Фибоначчи', dalembert: "Д'Аламбер",
                oscar: "Oscar's Grind", parlay: 'Парлай', labouchere: 'Лабушер', boost: 'Разгон депозита' },
            steps: 'шагов', step: 'шаг', fm: { ALL: 'все фильтры', ANY: 'любой фильтр', CONTEXT: 'контекст + вход' },
            cm: { auto: 'авто', trend: 'тренд', reversion: 'возврат', off: 'без подтверждения' },
            exp_u: { s: 'с', m: 'м', h: 'ч' }
        },
        en: {
            handle: 'Preset market', handle_upd: 'Updates available for installed presets',
            title: 'Market', close: 'Close', back: 'Back',
            tab_catalog: 'Catalog', tab_my: 'Mine', tab_official: 'Official',
            search: 'Name, author nickname…', filters: 'Filters', reset: 'Reset filters',
            sort_popular: 'Popular', sort_new: 'New', sort_rating: 'Rating', sort_installs: 'By installs',
            f_exp: 'Expiration', f_ind: 'Indicators', f_mm: 'Bet system', f_risk: 'Risk', f_price: 'Price', f_lang: 'Description language',
            all: 'All', free_p: 'Free', paid_p: 'Paid',
            risk_low: 'Low', risk_medium: 'Medium', risk_high: 'High',
            risk_low_c: 'Low risk', risk_medium_c: 'Medium risk', risk_high_c: 'High risk',
            free: 'Free', official: 'Official', more: 'Load 20 more',
            installs: 'installs', installed: '✓ installed', purchased: '✓ purchased', own: 'yours', upd: '↑ update to v',
            wr_none: 'not enough data', wr: 'win rate', wr_deals: 'trades, real account',
            empty_found: 'Nothing matches these filters.', empty: 'Nothing here yet.',
            net_err: 'No connection to the market server.', retry: 'Retry',
            not_logged: 'You are not signed in — the catalog is visible, but installing, buying and the library require signing in.',
            save_current: '💾 Save current settings', my_lib: 'My library', my_bought: 'Purchased', my_inst: 'Installed',
            of: 'of', private: 'private', published: 'published', sales: 'sales', removed: 'removed by author',
            params: 'Parameters', ind: 'Indicators', exp: 'Expiration', mm: 'Bet system', modes: 'Entry mode',
            tp_tl: 'TP / TL', tp_tl_off: 'values set, limits not enabled', htf: 'Higher TF filter', on: 'on', off: 'off',
            risk: 'Risk', stats: 'Statistics', installs_c: 'Installs', rating: 'Rating', version: 'Version', updated: 'updated',
            lock_note: 'Indicator parameters are hidden until purchase. Visible: indicators, expiration, MM, risk, statistics.',
            locked_title: 'Indicator parameters', available: 'Visible before purchase', mm_keep: 'unchanged (yours)',
            apply: 'Apply', buy: 'Buy for', update_to: 'Update to v', uninstall: 'Remove from mine',
            publish: 'Publish', change_price: 'Change price', unpublish: 'Unpublish', delete: 'Delete',
            apply_q: 'Apply “%s”?', risky: '⚠️ Risky setting: %s.', keep_note: 'Your bet and auto trading are not changed.',
            cancel: 'Cancel', applied: 'Applied', undo: 'Restore my settings', restored: 'Your settings are restored',
            save_title: 'Save to library', name: 'Name (3–60)', desc: 'Description (up to 500)', lang: 'Language',
            preview: 'Preview — sent to the server', not_sent: 'Bet, balance, auto trading', not_sent_v: 'not sent',
            links_note: 'Links and contacts in the description are removed automatically.', save: 'Save', saved: 'Saved to library',
            publish_title: 'Publish “%s”', price_title: 'Price of “%s”', seg_free: 'Free', seg_paid: 'Paid',
            price: 'Price, USDT (%s–%s)', fee: 'Fee %s% — you get %s USDT per sale.',
            need_nick: '🪪 No nickname — set it on the website to publish presets.', open_profile: 'Open profile',
            need_wallet: '👛 Add a TRC20 payout address in your profile to sell presets.',
            dup: 'This preset is already published.', open: 'Open', published_ok: 'Published', price_ok: 'Price changed',
            unpub_q: 'Unpublish “%s”?', unpub_note: 'The preset stays in your library and with those who installed or bought it.',
            del_q: 'Delete “%s”?', del_note: 'The preset disappears from your library and for those who installed it. Buyers keep it.',
            unpub_ok: 'Unpublished', del_ok: 'Deleted', uninst_ok: 'Removed from mine', updated_ok: 'Updated to v',
            invoice: 'Invoice #', waiting: 'Waiting for transfer…', copy: 'Copied',
            pay_note: 'Send exactly this amount — it is unique to this invoice. TRC20 network only. No refunds.',
            open_pay: 'Open payment page in browser', have_paid: 'Already paid — enter transaction hash',
            tx_ph: 'Transaction hash or tronscan link', check: 'Check',
            paid: 'Paid', paid_text: 'Preset “%s” is added to Purchased.',
            expired: 'Invoice expired', expired_text: 'If you have already paid — enter the transaction hash.', new_invoice: 'New invoice', enter_tx: 'Enter hash',
            underpaid: 'Underpaid', underpaid_text: 'Received %s USDT for a price of %s USDT. No refunds.',
            canceled: 'Invoice canceled', loading: 'Loading…',
            not_logged_ext: 'The catalog is visible without signing in. To apply, save, publish and buy presets, sign in to your PocketOption Signal account (the same as on the website and in the Windows app).',
            login: 'Sign in', login_title: 'Sign in to your account', email: 'Email', password: 'Password', totp: '2FA code (6 digits)',
            login_note: 'Same account as on the website and in the Windows app. The password is not stored in the extension.',
            register: 'Sign up', forgot: 'Forgot password?', logout: 'Sign out', signed_as: 'Signed in as',
            logged_in: 'Signed in', logged_out: 'Signed out',
            mm_names: { fixed: 'Fixed', martingale: 'Martingale', anti_mart: 'Anti-Martingale', fibonacci: 'Fibonacci', dalembert: "D'Alembert",
                oscar: "Oscar's Grind", parlay: 'Parlay', labouchere: 'Labouchère', boost: 'Deposit Boost' },
            steps: 'steps', step: 'unit', fm: { ALL: 'all filters', ANY: 'any filter', CONTEXT: 'context + entry' },
            cm: { auto: 'auto', trend: 'trend', reversion: 'reversion', off: 'no confirmation' },
            exp_u: { s: 's', m: 'm', h: 'h' }
        }
    };
    var ERR = {
        ru: {
            network: 'Нет соединения с сервером маркета.', auth: 'Войдите в аккаунт в приложении.',
            nickname_required: 'Сначала задайте ник в профиле на сайте.', payout_address_required: 'Добавьте TRC20-адрес для выплат в профиле.',
            duplicate: 'Такой пресет уже опубликован.', library_full: 'Библиотека заполнена (максимум %max).',
            public_limit: 'Достигнут лимит публичных пресетов (%max).', publish_rate: 'Не больше %max новых публикаций в сутки.',
            rate_limited: 'Слишком часто. Попробуйте позже.', bad_config: 'Настройки не подходят для маркета (%field).',
            title_short: 'Название — от 3 символов.', text_forbidden: 'Контакты и мессенджеры в тексте запрещены.',
            bad_price: 'Цена — 0 или от %min до %max USDT, не больше 2 знаков.', paid_not_available: 'Платные пресеты пока недоступны.',
            payment_required: 'Пресет платный — сначала купите его.', own_preset: 'Это ваш пресет.', already_purchased: 'Пресет уже куплен.',
            not_paid: 'Покупка недоступна.', not_found: 'Пресет не найден или удалён.', bad_tx: 'Неверный хеш транзакции.',
            tx_not_found: 'Перевод пока не найден. Подождите пару минут и проверьте снова.', tx_used: 'Этот перевод уже использован.',
            invoice_closed: 'Счёт уже закрыт.', tx_before_invoice: 'Перевод сделан раньше, чем создан счёт.',
            underpaid: 'Сумма перевода меньше цены.', server_error: 'Ошибка сервера. Попробуйте позже.', other: 'Ошибка: %code',
            auth_ext: 'Войдите в аккаунт, чтобы продолжить.', bad_credentials: 'Неверный email или пароль.',
            '2fa_required': 'Введите код двухфакторной аутентификации.', bad_totp: 'Код 2FA не подошёл.',
            account_blocked: 'Аккаунт заблокирован.', login_rate: 'Слишком много попыток входа. Подождите 15 минут.'
        },
        en: {
            network: 'No connection to the market server.', auth: 'Sign in to your account in the app.',
            nickname_required: 'Set a nickname in your profile on the website first.', payout_address_required: 'Add a TRC20 payout address in your profile.',
            duplicate: 'This preset is already published.', library_full: 'Library is full (max %max).',
            public_limit: 'Public preset limit reached (%max).', publish_rate: 'No more than %max new publications per day.',
            rate_limited: 'Too often. Try again later.', bad_config: 'These settings cannot be shared (%field).',
            title_short: 'Name must be at least 3 characters.', text_forbidden: 'Contacts and messengers are not allowed in the text.',
            bad_price: 'Price is 0 or %min–%max USDT, max 2 decimals.', paid_not_available: 'Paid presets are not available yet.',
            payment_required: 'This preset is paid — buy it first.', own_preset: 'This is your preset.', already_purchased: 'Already purchased.',
            not_paid: 'Purchase is not available.', not_found: 'Preset not found or deleted.', bad_tx: 'Invalid transaction hash.',
            tx_not_found: 'Transfer not found yet. Wait a couple of minutes and check again.', tx_used: 'This transfer is already used.',
            invoice_closed: 'Invoice is already closed.', tx_before_invoice: 'The transfer was made before the invoice.',
            underpaid: 'The transfer is less than the price.', server_error: 'Server error. Try again later.', other: 'Error: %code',
            auth_ext: 'Sign in to your account to continue.', bad_credentials: 'Wrong email or password.',
            '2fa_required': 'Enter your two-factor authentication code.', bad_totp: 'The 2FA code is wrong.',
            account_blocked: 'The account is blocked.', login_rate: 'Too many sign-in attempts. Wait 15 minutes.'
        }
    };
    var AUTH_ERRORS = { auth_required: 1, invalid_token: 1, device_removed: 1 };
    var EXPS = [3, 15, 30, 60, 180, 300, 1800, 3600, 14400];
    var INDS = ['RSI', 'EMA', 'SMA', 'BB', 'MACD', 'STOCH', 'CCI', 'TREND', 'SENTIMENT', 'PSAR'];
    var MMS = ['fixed', 'martingale', 'anti_mart', 'fibonacci', 'dalembert', 'oscar', 'parlay', 'labouchere', 'boost'];
    var RISKY_MM = { martingale: 1, anti_mart: 1, boost: 1, labouchere: 1 };
    var PARAM_ORDER = {
        RSI: ['period', 'oversold', 'overbought'], EMA: ['fast', 'slow'], SMA: ['fast', 'slow'], BB: ['period', 'dev'],
        MACD: ['fast', 'slow', 'signal'], STOCH: ['kPeriod', 'dPeriod', 'oversold', 'overbought'], CCI: ['period', 'level'],
        TREND: ['period'], SENTIMENT: ['threshold'], PSAR: ['fastEma', 'slowEma']
    };

    function lang() { try { return posApp.core && posApp.core.lang() === 'en' ? 'en' : 'ru'; } catch (_) { return 'ru'; } }
    function t(k) { var v = TXT[lang()][k]; return v == null ? k : v; }
    function fmt(s) { var a = arguments, i = 1; return String(s).replace(/%s/g, function () { return a[i++] != null ? a[i - 1] : ''; }); }
    function errText(r) {
        r = r || {};
        var code = r.error || 'network', E = ERR[lang()];
        var s = AUTH_ERRORS[code] ? (EXT ? E.auth_ext : E.auth) : (E[code] || E.other);
        return s.replace('%max', r.max != null ? r.max : '').replace('%min', r.min != null ? r.min : '')
            .replace('%field', r.field || '').replace('%code', code);
    }
    function isAuthErr(r) { return !!(r && AUTH_ERRORS[r.error]); }
    function call(action, params) {
        var p = Object.assign({ lang: lang() }, params || {});
        return posApp.market(action, p).then(function (r) {
            if (isAuthErr(r)) S.authed = false;
            else if (r && r.ok && action !== 'catalog' && action !== 'get') S.authed = true;
            return r || { ok: false, error: 'network' };
        });
    }

    // ── Форматирование ───────────────────────────────────────────────
    function expLabel(sec) {
        var u = t('exp_u');
        sec = +sec || 0;
        if (sec >= 3600 && sec % 3600 === 0) return (sec / 3600) + u.h;
        if (sec >= 60 && sec % 60 === 0) return (sec / 60) + u.m;
        return sec + u.s;
    }
    function money(v) { var n = parseFloat(v); return isFinite(n) ? n.toFixed(2) : String(v || ''); }
    function mmName(id) { return t('mm_names')[id] || id || '—'; }
    function mmText(mm, p) {
        p = p || {};
        var s = mmName(mm);
        if (p.multiplier != null) s += ' ×' + p.multiplier;
        if (p.maxSteps != null) s += ' · ' + p.maxSteps + ' ' + t('steps');
        if (p.dalembertUnit != null) s += ' · ' + t('step') + ' ' + p.dalembertUnit;
        if (p.parlaySteps != null) s += ' · ' + p.parlaySteps + ' ' + t('steps');
        if (p.labSequence) s += ' · ' + p.labSequence;
        return s;
    }
    function mmParamsOf(cfg) {
        var p = {};
        ['multiplier', 'maxSteps', 'dalembertUnit', 'parlaySteps', 'labSequence'].forEach(function (k) { if (cfg && cfg[k] != null) p[k] = cfg[k]; });
        return p;
    }
    function indText(cfg) {
        var ic = (cfg && cfg.indConfig) || {};
        return (cfg.indicators || []).map(function (id) {
            var c = ic[id];
            if (!c) return id;
            var vals = (PARAM_ORDER[id] || Object.keys(c)).filter(function (k) { return c[k] != null; }).map(function (k) { return c[k]; });
            return vals.length ? id + '(' + vals.join(', ') + ')' : id;
        }).join(', ');
    }
    function riskText(r) {
        if (!r) return null;
        var one = function (v, m) { return m === 'amount' ? '$' + v : v + '%'; };
        return '+' + one(r.tp, r.tpMode) + ' / −' + one(r.tl, r.tlMode) + (r.on === false ? ' (' + t('tp_tl_off') + ')' : '');
    }
    function dateText(s) {
        if (!s) return '';
        var d = new Date(String(s).replace(' ', 'T') + 'Z');
        if (isNaN(d)) return '';
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
    }
    function riskyReasons(cfg, applyMm) {
        if (!applyMm || !cfg) return [];
        var out = [];
        if (RISKY_MM[cfg.mm]) out.push(mmName(cfg.mm));
        if (cfg.maxSteps > 4) out.push(cfg.maxSteps + ' ' + t('steps'));
        if (cfg.multiplier > 2) out.push('×' + cfg.multiplier);
        return out;
    }

    // ── DOM ──────────────────────────────────────────────────────────
    function root() { return document.documentElement; }
    function h(tag, props, kids) {
        var e = document.createElement(tag);
        if (props) Object.keys(props).forEach(function (k) {
            var v = props[k];
            if (v == null || v === false) return;
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
            else if (k === 'value') e.value = v;
            else e.setAttribute(k, v === true ? '' : v);
        });
        add(e, kids);
        return e;
    }
    function add(e, kids) {
        if (kids == null || kids === false) return;
        if (Array.isArray(kids)) { kids.forEach(function (k) { add(e, k); }); return; }
        e.appendChild(typeof kids === 'object' ? kids : document.createTextNode(String(kids)));
    }
    function btn(text, cls, onclick, extra) {
        return h('button', Object.assign({ type: 'button', class: 'pos-mk-btn ' + (cls || ''), onclick: onclick }, extra || {}), text);
    }
    function row(dt, dd) {
        if (dd == null || dd === '') return null;
        return h('div', { class: 'pos-mk-row' }, [h('dt', { text: dt }), h('dd', null, dd)]);
    }
    function riskBadge(level, full) {
        if (!level) return null;
        return h('span', { class: 'pos-mk-risk ' + level, text: t('risk_' + level + (full ? '_c' : '')) });
    }
    function priceBadge(c) {
        if (c.paid) return h('span', { class: 'pos-mk-price paid', text: money(c.price_usdt) + ' USDT' });
        if (c.official) return h('span', { class: 'pos-mk-official-badge', text: t('official') });
        return h('span', { class: 'pos-mk-price free', text: t('free') });
    }
    function copyText(text, el) {
        var done = function () {
            if (!el) return;
            el.classList.add('copied');
            setTimeout(function () { el.classList.remove('copied'); }, 1200);
            toast(t('copy'));
        };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function () { fallback(); });
                return;
            }
        } catch (_) {}
        fallback();
        function fallback() {
            var ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0' });
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (_) {}
            ta.remove();
        }
    }

    // ── Состояние ────────────────────────────────────────────────────
    function emptyFilters() { return { exp: null, ind: [], mm: '', risk: '', price: '', lang: '' }; }
    var S = {
        tab: 'catalog', q: '', f: emptyFilters(), sort: 'popular', filtersOpen: false,
        list: { items: [], page: 0, pages: 1, loading: false, error: null, key: '' },
        my: null, myLoading: false, myError: null,
        authed: null, account: null,
        view: 'list', detail: null, pay: null,
        sheet: null
    };
    var panel = null, handle = null, mk = null, bodyEl = null, toastEl = null, toastTimer = 0;
    var listSeq = 0, searchTimer = 0, payPoll = 0, payTick = 0, myTimer = 0;

    function filterCount() {
        var f = S.f;
        return (f.exp ? 1 : 0) + f.ind.length + (f.mm ? 1 : 0) + (f.risk ? 1 : 0) + (f.price ? 1 : 0) + (f.lang ? 1 : 0);
    }
    function inMarket() { return !!(panel && panel.classList.contains('market-mode')); }

    // ── Загрузка данных ──────────────────────────────────────────────
    function loadList(more) {
        var seq = ++listSeq, L = S.list;
        var page = more ? L.page + 1 : 1;
        L.loading = true; L.error = null;
        if (!more) { L.items = []; L.page = 0; }
        renderBody();
        var params = { tab: S.tab === 'official' ? 'official' : 'all', page: page, sort: S.tab === 'official' ? 'official' : S.sort };
        if (S.q) params.q = S.q;
        if (S.f.exp) params.exp = S.f.exp;
        if (S.f.ind.length) params.ind = S.f.ind.slice();
        if (S.f.mm) params.mm = S.f.mm;
        if (S.f.risk) params.risk = S.f.risk;
        if (S.f.price) params.price = S.f.price;
        if (S.f.lang) params.lang = S.f.lang;
        call('catalog', params).then(function (r) {
            if (seq !== listSeq) return;
            L.loading = false;
            if (!r.ok) { L.error = r; renderBody(); return; }
            L.items = more ? L.items.concat(r.items || []) : (r.items || []);
            L.page = r.page || page; L.pages = r.pages || 1;
            renderBody();
        });
    }
    function loadMy(silent) {
        if (S.myLoading) return Promise.resolve();
        S.myLoading = true;
        if (!silent && S.tab === 'my') renderBody();
        return call('my').then(function (r) {
            S.myLoading = false;
            if (r.ok) { S.my = r; S.myError = null; pushLibrary(); }
            else S.myError = r;
            syncBadges();
            if (S.view === 'list' && S.tab === 'my') renderBody();
        });
    }
    /** «Пресеты стратегии» в настройках бота показывают только добавленное из маркета: свои, купленные, установленные. */
    function pushLibrary() {
        var m = S.my, core = posApp.core;
        if (!m || !core || typeof core.setLibrary !== 'function') return;
        try { core.setLibrary((m.own || []).concat(m.purchased || [], m.installed || [])); } catch (_) {}
    }
    function hasUpdates() {
        var m = S.my;
        if (!m) return false;
        return (m.installed || []).concat(m.purchased || []).some(function (c) { return c.update_available; });
    }
    function syncBadges() {
        var upd = hasUpdates();
        if (handle) {
            handle.classList.toggle('has-updates', upd);
            handle.title = upd ? t('handle_upd') : t('handle');
        }
        var dot = mk && mk.querySelector('.pos-mk-tab-dot');
        if (dot) dot.style.display = upd ? '' : 'none';
    }

    // ── Отрисовка ────────────────────────────────────────────────────
    function renderAll() {
        if (!mk) return;
        while (mk.firstChild) mk.removeChild(mk.firstChild);
        bodyEl = null;
        if (S.view === 'detail' && S.detail) renderDetail();
        else if (S.view === 'pay' && S.pay) renderPay();
        else { S.view = 'list'; renderList(); }
        if (S.sheet) mk.appendChild(S.sheet);
        if (toastEl) mk.appendChild(toastEl);
        syncBadges();
    }

    function head(title, withBack) {
        return h('div', { class: 'pos-mk-head' }, [
            h('button', { type: 'button', class: 'pos-icon-btn pos-mk-back' + (withBack ? ' show' : ''), title: t('back'), onclick: back }, '←'),
            h('h2', { class: 'pos-mk-title', text: title }),
            h('button', { type: 'button', class: 'pos-icon-btn', title: t('close'), onclick: function () { closeDrawer(); } }, '✕')
        ]);
    }

    function renderList() {
        mk.appendChild(head(t('title'), false));
        var tabs = h('div', { class: 'pos-tabs pos-mk-tabs', role: 'tablist' });
        [['catalog', t('tab_catalog')], ['my', t('tab_my')], ['official', t('tab_official')]].forEach(function (x) {
            var b = h('button', { type: 'button', class: 'pos-tab' + (S.tab === x[0] ? ' active' : ''), role: 'tab', onclick: function () { setTab(x[0]); } }, x[1]);
            if (x[0] === 'my') b.appendChild(h('span', { class: 'pos-mk-tab-dot', style: 'display:none' }));
            tabs.appendChild(b);
        });
        mk.appendChild(tabs);

        if (S.tab !== 'my') {
            var input = h('input', { type: 'search', placeholder: t('search'), value: S.q, maxlength: '60' });
            input.addEventListener('input', function () {
                S.q = input.value.trim();
                clearTimeout(searchTimer);
                searchTimer = setTimeout(function () { loadList(false); }, 350);
            });
            mk.appendChild(h('div', { class: 'pos-mk-search' }, input));
            var n = filterCount();
            var bar = h('div', { class: 'pos-mk-filters-bar' }, [
                h('button', { type: 'button', class: 'pos-mk-filters-toggle' + (S.filtersOpen ? ' open' : ''), 'aria-expanded': S.filtersOpen ? 'true' : 'false',
                    onclick: function () { S.filtersOpen = !S.filtersOpen; renderAll(); } },
                    [h('span', null, [t('filters'), n ? h('span', { class: 'cnt', text: ' · ' + n }) : null]), h('span', { class: 'chev', text: '▾' })])
            ]);
            if (S.tab === 'catalog') {
                var sel = h('select', { class: 'pos-mk-sort' });
                ['popular', 'new', 'rating', 'installs'].forEach(function (k) {
                    var o = h('option', { value: k, text: t('sort_' + k) });
                    if (S.sort === k) o.selected = true;
                    sel.appendChild(o);
                });
                sel.addEventListener('change', function () { S.sort = sel.value; loadList(false); });
                bar.appendChild(sel);
            }
            mk.appendChild(bar);
            if (S.filtersOpen) mk.appendChild(renderFilters());
        }
        bodyEl = h('div', { class: 'pos-mk-body' });
        mk.appendChild(bodyEl);
        renderBody();
    }

    function renderFilters() {
        var f = S.f;
        var chip = function (label, sel, onclick) {
            return h('button', { type: 'button', class: 'pos-mk-chip' + (sel ? ' sel' : ''), 'aria-pressed': sel ? 'true' : 'false', onclick: onclick }, label);
        };
        var change = function () { renderAll(); loadList(false); };
        var group = function (label, chips) {
            return h('div', { class: 'pos-mk-filter-group' }, [h('label', { text: label }), h('div', { class: 'pos-mk-chips' }, chips)]);
        };
        var single = function (key, val) { return function () { f[key] = f[key] === val ? (key === 'exp' ? null : '') : val; change(); }; };
        return h('div', { class: 'pos-mk-filters open', style: 'flex:none; overflow:visible; max-height:none' }, [
            group(t('f_exp'), EXPS.map(function (e) { return chip(expLabel(e), f.exp === e, single('exp', e)); })),
            group(t('f_ind'), INDS.map(function (id) {
                return chip(id, f.ind.indexOf(id) >= 0, function () {
                    var i = f.ind.indexOf(id);
                    if (i >= 0) f.ind.splice(i, 1); else if (f.ind.length < 5) f.ind.push(id);
                    change();
                });
            })),
            group(t('f_mm'), MMS.map(function (m) { return chip(mmName(m), f.mm === m, single('mm', m)); })),
            group(t('f_risk'), ['low', 'medium', 'high'].map(function (r) { return chip(t('risk_' + r), f.risk === r, single('risk', r)); })),
            group(t('f_price'), [chip(t('all'), !f.price, function () { f.price = ''; change(); }),
                chip(t('free_p'), f.price === 'free', single('price', 'free')), chip(t('paid_p'), f.price === 'paid', single('price', 'paid'))]),
            group(t('f_lang'), [chip(t('all'), !f.lang, function () { f.lang = ''; change(); }),
                chip('RU', f.lang === 'ru', single('lang', 'ru')), chip('EN', f.lang === 'en', single('lang', 'en'))]),
            h('div', { class: 'pos-mk-filters-foot' },
                h('button', { type: 'button', class: 'pos-mk-filters-reset', onclick: resetFilters }, t('reset')))
        ]);
    }
    function resetFilters() { S.f = emptyFilters(); S.q = ''; renderAll(); loadList(false); }

    function skeletons() {
        return h('div', { class: 'pos-mk-list' }, [0, 1, 2].map(function () {
            return h('div', { class: 'pos-mk-skel' }, [h('div', { class: 'pos-mk-skel-line w60' }), h('div', { class: 'pos-mk-skel-line w40' })]);
        }));
    }
    function emptyBox(ico, text, button) {
        return h('div', { class: 'pos-mk-empty' }, [h('span', { class: 'ico', text: ico }), h('p', { text: text }), button || null]);
    }
    function netError(retry, r) {
        return emptyBox('📡', errText(r), btn(t('retry'), 'primary', retry, { style: 'flex:none; padding:8px 18px' }));
    }
    function authNote() {
        if (!EXT) return h('div', { class: 'pos-mk-note' }, t('not_logged'));
        return h('div', { class: 'pos-mk-note pos-mk-login-note' }, [h('span', { text: t('not_logged_ext') }),
            btn(t('login'), 'primary', openLoginSheet, { style: 'flex:none; padding:8px 18px; margin-top:8px' })]);
    }

    function renderBody() {
        if (!bodyEl) return;
        while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
        if (S.tab === 'my') { renderMy(); return; }
        var L = S.list;
        if (S.authed === false) bodyEl.appendChild(authNote());
        if (L.error && !L.items.length) { bodyEl.appendChild(netError(function () { loadList(false); }, L.error)); return; }
        if (L.loading && !L.items.length) { bodyEl.appendChild(skeletons()); return; }
        if (!L.items.length) {
            var filtered = filterCount() > 0 || !!S.q;
            bodyEl.appendChild(emptyBox('🔍', filtered ? t('empty_found') : t('empty'),
                filtered ? btn(t('reset'), '', resetFilters, { style: 'flex:none; padding:8px 18px' }) : null));
            return;
        }
        bodyEl.appendChild(h('div', { class: 'pos-mk-list' }, L.items.map(function (c) { return card(c); })));
        if (L.page < L.pages) {
            bodyEl.appendChild(h('button', { type: 'button', class: 'pos-mk-more', disabled: L.loading, onclick: function () { loadList(true); } },
                L.loading ? t('loading') : t('more')));
        }
    }

    function card(c, mode) {
        var cls = 'pos-mk-card' + (c.official ? ' official' : '') + (c.own ? ' own' : '') + (!c.own && (c.installed || c.purchased) ? ' installed' : '');
        var inds = c.indicators || [];
        var chips = [h('span', { class: 'pos-mk-card-chip', text: expLabel(c.expiration) })];
        if (inds.length) chips.push(h('span', { class: 'pos-mk-card-chip', text: inds.slice(0, 3).join(' + ') }));
        if (inds.length > 3) chips.push(h('span', { class: 'pos-mk-card-chip more', text: '+' + (inds.length - 3) }));
        if (c.mm) chips.push(h('span', { class: 'pos-mk-card-chip', text: mmName(c.mm) }));
        chips.push(riskBadge(c.risk_level, true));

        var left;
        if (c.own) {
            left = h('span', null, (c.visibility === 'public' ? t('published') : t('private')) +
                (c.sales != null && c.paid ? ' · ' + c.sales + ' ' + t('sales') : ''));
        } else if (c.update_available) left = h('span', { class: 'pos-mk-card-status update', text: t('upd') + c.version });
        else if (c.purchased) left = h('span', { class: 'pos-mk-card-status installed', text: c.deleted ? t('purchased') + ' · ' + t('removed') : t('purchased') });
        else if (c.installed) left = h('span', { class: 'pos-mk-card-status installed', text: t('installed') });
        else left = h('span', null, '⭳ ' + (c.installs || 0) + ' ' + t('installs') + (c.rating ? ' · ★ ' + c.rating : ''));

        var wr = c.winrate_real;
        var right = wr && wr.trades
            ? h('span', { class: 'pos-mk-card-wr' }, [t('wr') + ' ', h('strong', { text: Math.round(wr.winrate) + '%' }), ' · ' + wr.trades + ' ' + t('wr_deals')])
            : h('span', { class: 'pos-mk-card-wr no-data', text: t('wr_none') });
        if (mode === 'own' && c.paid) right = null;

        return h('button', { type: 'button', class: cls, onclick: function () { openDetail(c); } }, [
            h('div', { class: 'pos-mk-card-top' }, [
                h('div', { class: 'pos-mk-card-name-wrap' }, [
                    h('span', { class: 'pos-mk-card-name', text: c.title }),
                    h('span', { class: 'pos-mk-card-author', text: c.official ? 'PocketOption Signal' : (c.author ? '@' + c.author : (c.own ? t('own') : '')) })
                ]),
                priceBadge(c)
            ]),
            h('div', { class: 'pos-mk-card-chips' }, chips),
            h('div', { class: 'pos-mk-card-foot' }, [left, right])
        ]);
    }

    function renderMy() {
        if (S.authed === false && !S.my) { bodyEl.appendChild(authNote()); return; }
        if (!S.my) {
            if (S.myError) bodyEl.appendChild(netError(function () { loadMy(); }, S.myError));
            else { bodyEl.appendChild(skeletons()); if (!S.myLoading) loadMy(); }
            return;
        }
        var m = S.my, p = m.profile || {};
        if (EXT && S.account) {
            bodyEl.appendChild(h('div', { class: 'pos-mk-account' }, [
                h('span', { class: 'pos-mk-account-who' }, [t('signed_as') + ' ', h('strong', { text: S.account.email || '' }),
                    p.nickname ? ' · @' + p.nickname : '']),
                h('button', { type: 'button', class: 'pos-mk-filters-reset', onclick: logout }, t('logout'))
            ]));
        }
        bodyEl.appendChild(h('button', { type: 'button', class: 'pos-mk-save-current', onclick: openSaveSheet }, t('save_current')));
        var section = function (title, cnt, items, mode) {
            return h('div', null, [
                h('div', { class: 'pos-mk-mysection-head' }, [h('h3', { text: title }), h('span', { class: 'cnt', text: cnt })]),
                items.length ? h('div', { class: 'pos-mk-list' }, items.map(function (c) { return card(c, mode); }))
                    : h('div', { class: 'pos-mk-note', style: 'margin-top:0' }, t('empty'))
            ]);
        };
        bodyEl.appendChild(h('div', { class: 'pos-mk-mysections' }, [
            section(t('my_lib'), (p.library != null ? p.library : (m.own || []).length) + ' ' + t('of') + ' ' + (p.library_max || 100), m.own || [], 'own'),
            section(t('my_bought'), String((m.purchased || []).length), m.purchased || []),
            section(t('my_inst'), String((m.installed || []).length), m.installed || [])
        ]));
    }

    // ── Деталь пресета (A5) ──────────────────────────────────────────
    function openDetail(c) {
        S.detail = { card: c, preset: c.config ? c : null, loading: true, error: null };
        S.view = 'detail';
        renderAll();
        reloadDetail();
    }
    function reloadDetail() {
        var d = S.detail;
        if (!d) return Promise.resolve();
        var id = d.card.id;
        return call('get', { id: id }).then(function (r) {
            if (S.detail !== d) return;
            d.loading = false;
            if (r.ok && r.preset) { d.card = r.preset; d.preset = r.preset; d.error = null; }
            else if (!d.preset) d.error = r;
            if (S.view === 'detail') renderAll();
        });
    }

    function renderDetail() {
        var d = S.detail, c = d.card, cfg = d.preset && d.preset.config;
        mk.appendChild(head(c.title, true));
        var pad = h('div', { class: 'pos-mk-screen-pad', style: 'display:flex; flex-direction:column' });
        mk.appendChild(pad);
        if (d.error && !cfg && d.error.error !== 'not_found' && !c.paid) { pad.appendChild(netError(reloadDetail, d.error)); return; }
        if (d.error && d.error.error === 'not_found') { pad.appendChild(emptyBox('🗑', errText(d.error))); return; }

        var meta = [c.official ? t('official') : (c.author ? '@' + c.author : (c.own ? t('own') : '')), 'v' + c.version];
        if (c.updated_at) meta.push(t('updated') + ' ' + dateText(c.updated_at));
        var locked = c.paid && !cfg && !c.own && !c.purchased;
        var mmP = cfg ? mmParamsOf(cfg) : (c.mm_params || {});

        var det = h('div', { class: 'pos-mk-detail' }, [
            h('div', { class: 'pos-mk-detail-head' }, [
                h('div', null, [h('h3', { class: 'pos-mk-detail-name', text: c.title }), h('div', { class: 'pos-mk-detail-meta', text: meta.filter(Boolean).join(' · ') })]),
                priceBadge(c)
            ]),
            c.description ? h('p', { class: 'pos-mk-detail-desc', text: c.description, style: 'white-space:pre-line' }) : null
        ]);
        if (cfg) {
            det.appendChild(h('div', { class: 'pos-mk-section' }, [
                h('h4', { class: 'pos-mk-section-title', text: t('params') }),
                h('dl', { class: 'pos-mk-rows' }, [
                    row(t('ind'), indText(cfg)),
                    row(t('modes'), (t('fm')[cfg.filterMode] || cfg.filterMode) + (cfg.confirmMode && cfg.confirmMode !== 'auto' ? ' · ' + (t('cm')[cfg.confirmMode] || cfg.confirmMode) : '')),
                    row(t('exp'), expLabel(cfg.expiration)),
                    row(t('mm'), c.apply_mm ? mmText(cfg.mm, mmP) : mmText(cfg.mm, mmP) + ' — ' + t('mm_keep')),
                    cfg.htfFilter != null ? row(t('htf'), cfg.htfFilter ? t('on') : t('off')) : null,
                    row(t('tp_tl'), riskText(cfg.risk)),
                    row(t('risk'), riskBadge(c.risk_level))
                ])
            ]));
        } else if (locked) {
            det.appendChild(h('div', { class: 'pos-mk-lock-note' }, [h('span', { class: 'ico', text: '🔒' }), ' ' + t('lock_note')]));
            det.appendChild(h('div', { class: 'pos-mk-section pos-mk-locked', 'aria-hidden': 'true' }, [
                h('h4', { class: 'pos-mk-section-title', text: t('locked_title') }),
                h('dl', { class: 'pos-mk-rows' }, (c.indicators || []).slice(0, 3).map(function (id) { return row(id, '••, ••'); }))
            ]));
            det.appendChild(h('div', { class: 'pos-mk-section' }, [
                h('h4', { class: 'pos-mk-section-title', text: t('available') }),
                h('dl', { class: 'pos-mk-rows' }, [
                    row(t('ind'), (c.indicators || []).join(' + ')),
                    row(t('exp'), expLabel(c.expiration)),
                    row(t('mm'), mmText(c.mm, mmP)),
                    row(t('risk'), riskBadge(c.risk_level))
                ])
            ]));
        } else if (d.loading) {
            det.appendChild(skeletons());
        }
        var wr = c.winrate_real;
        det.appendChild(h('div', { class: 'pos-mk-section' }, [
            h('h4', { class: 'pos-mk-section-title', text: t('stats') }),
            h('dl', { class: 'pos-mk-rows' }, [
                row(t('wr'), wr && wr.trades ? Math.round(wr.winrate) + '% · ' + wr.trades + ' ' + t('wr_deals') : h('span', { class: 'pos-mk-card-wr no-data', text: t('wr_none') })),
                row(t('installs_c'), String(c.installs || 0)),
                c.rating ? row(t('rating'), '★ ' + c.rating + ' (' + c.rating_count + ')') : null,
                c.own && c.paid && c.sales != null ? row(t('sales'), String(c.sales)) : null
            ])
        ]));
        pad.appendChild(det);

        // действия по состоянию
        if (S.authed === false) { pad.appendChild(authNote()); return; }
        if (c.own) {
            var sub = h('div', { class: 'pos-mk-subactions' }, [
                btn(c.visibility === 'public' ? t('change_price') : t('publish'), 'ghost', function () { openPublishSheet(c); }),
                c.visibility === 'public' ? btn(t('unpublish'), 'ghost', function () { confirmSheet(fmt(t('unpub_q'), c.title), t('unpub_note'), t('unpublish'), false, function () { return ownAction('unpublish', c, t('unpub_ok')); }); }) : null,
                btn(t('delete'), 'danger', function () { confirmSheet(fmt(t('del_q'), c.title), t('del_note'), t('delete'), true, function () { return ownAction('delete', c, t('del_ok'), true); }); })
            ]);
            pad.appendChild(sub);
        }
        var actions = h('div', { class: 'pos-mk-actions' });
        if (locked) {
            actions.appendChild(btn(t('buy') + ' ' + money(c.price_usdt) + ' USDT', 'primary', function (e) { buy(c, e.currentTarget); }));
        } else {
            if (!c.own && c.installed && !c.purchased) actions.appendChild(btn(t('uninstall'), 'ghost', function (e) { uninstall(c, e.currentTarget); }));
            if (!c.own && c.update_available) actions.appendChild(btn(t('update_to') + c.version, 'ghost', function (e) { updatePreset(c, e.currentTarget); }));
            actions.appendChild(btn(t('apply'), 'primary', function () { openApplySheet(c); }, { disabled: !cfg }));
        }
        pad.appendChild(actions);
    }

    function ownAction(action, c, okText, goBack) {
        return call(action, { id: c.id }).then(function (r) {
            if (!r.ok) return errText(r);
            toast(okText);
            loadMy(true);
            if (goBack) back(); else reloadDetail();
            return null;
        });
    }
    function busy(el, on) { if (el) el.disabled = !!on; }
    function uninstall(c, el) {
        busy(el, true);
        call('uninstall', { id: c.id }).then(function (r) {
            busy(el, false);
            if (!r.ok) { toast(errText(r), null, null, 'err'); return; }
            toast(t('uninst_ok'));
            loadMy(true);
            back();
        });
    }
    function updatePreset(c, el) {
        busy(el, true);
        call('install', { id: c.id }).then(function (r) {
            busy(el, false);
            if (!r.ok) { toast(errText(r), null, null, 'err'); return; }
            toast(t('updated_ok') + r.preset.version);
            S.detail.card = r.preset; S.detail.preset = r.preset;
            loadMy(true);
            renderAll();
        });
    }

    // ── Применение (A6) ──────────────────────────────────────────────
    function openApplySheet(c) {
        var cfg = c.config || (S.detail && S.detail.preset && S.detail.preset.config);
        if (!cfg) return;
        var reasons = riskyReasons(cfg, c.apply_mm);
        var err = h('div', { class: 'pos-mk-risk-hint', style: 'display:none' });
        var ok = btn(t('apply'), 'primary', function () {
            busy(ok, true);
            doApply(c).then(function (e) {
                if (e && EXT && S.authed === false) { closeSheet(); renderAll(); openLoginSheet(); return; }
                if (e) { busy(ok, false); err.textContent = e; err.style.display = ''; return; }
                closeSheet();
            });
        });
        openSheet([
            h('h3', { class: 'pos-mk-sheet-title', text: fmt(t('apply_q'), c.title) }),
            h('dl', { class: 'pos-mk-rows' }, [
                row(t('ind'), indText(cfg)),
                row(t('exp'), expLabel(cfg.expiration)),
                row(t('mm'), c.apply_mm ? mmText(cfg.mm, mmParamsOf(cfg)) : t('mm_keep')),
                cfg.risk && cfg.risk.on !== false ? row(t('tp_tl'), riskText(cfg.risk)) : null
            ]),
            reasons.length ? h('div', { class: 'pos-mk-risk-hint', text: fmt(t('risky'), reasons.join(', ')) }) : null,
            h('div', { class: 'pos-mk-note', text: t('keep_note') }),
            err,
            h('div', { class: 'pos-mk-sheet-foot' }, [btn(t('cancel'), 'ghost', closeSheet), ok])
        ]);
    }
    /** Установить (если нужно) и применить. Возвращает текст ошибки или null. */
    function doApply(c) {
        var core = posApp.core;
        if (!core) return Promise.resolve(errText({ error: 'other' }));
        var need = !c.own && (!c.installed || c.update_available);
        var p = need ? call('install', { id: c.id }) : Promise.resolve({ ok: true, preset: c.config ? c : S.detail.preset });
        return p.then(function (r) {
            if (!r.ok) return errText(r);
            var pr = r.preset;
            var backup = null;
            try { backup = core.backup(); } catch (_) {}
            var applied = false;
            try { applied = core.apply(pr.config, { id: pr.id, key: pr.official ? pr.key : null, applyMm: !!pr.apply_mm, title: pr.title }); } catch (_) {}
            if (!applied) return errText({ error: 'bad_config', field: 'config' });
            toast(t('applied'), t('undo'), function () {
                try { core.restore(backup); toast(t('restored')); } catch (_) {}
            }, null, 12000);
            if (need) {
                loadMy(true);
                if (S.detail && S.detail.card.id === pr.id) { S.detail.card = pr; S.detail.preset = pr; if (S.view === 'detail') renderAll(); }
            }
            return null;
        });
    }

    // ── Сохранить в библиотеку (A8) ──────────────────────────────────
    function openSaveSheet() {
        var core = posApp.core;
        var cfg = core && core.share ? core.share() : null;
        if (!cfg) { toast(errText({ error: 'bad_config', field: 'config' }), null, null, 'err'); return; }
        var title = h('input', { type: 'text', maxlength: '60' });
        var desc = h('textarea', { maxlength: '500', rows: '3', style: 'resize:vertical; min-height:54px' });
        var lsel = h('select');
        [['ru', 'Русский'], ['en', 'English']].forEach(function (x) { var o = h('option', { value: x[0], text: x[1] }); if (lang() === x[0]) o.selected = true; lsel.appendChild(o); });
        var err = h('div', { class: 'pos-mk-risk-hint', style: 'display:none' });
        var ok = btn(t('save'), 'primary', function () {
            var tv = title.value.trim();
            if (tv.length < 3) { err.textContent = errText({ error: 'title_short' }); err.style.display = ''; return; }
            busy(ok, true);
            call('save', { title: tv, description: desc.value.trim(), lang: lsel.value, config: cfg }).then(function (r) {
                busy(ok, false);
                if (!r.ok) { err.textContent = errText(r); err.style.display = ''; return; }
                closeSheet();
                toast(t('saved'));
                loadMy(true);
            });
        });
        openSheet([
            h('h3', { class: 'pos-mk-sheet-title', text: t('save_title') }),
            h('div', { class: 'pos-fg', style: 'margin-bottom:8px' }, [h('label', { text: t('name') }), title]),
            h('div', { class: 'pos-fg', style: 'margin-bottom:8px' }, [h('label', { text: t('desc') }), desc]),
            h('div', { class: 'pos-fg', style: 'margin-bottom:8px' }, [h('label', { text: t('lang') }), lsel]),
            h('div', { class: 'pos-mk-section' }, [
                h('h4', { class: 'pos-mk-section-title', text: t('preview') }),
                h('dl', { class: 'pos-mk-rows' }, [
                    row(t('ind'), indText(cfg)),
                    row(t('modes'), t('fm')[cfg.filterMode] || cfg.filterMode),
                    row(t('exp'), expLabel(cfg.expiration)),
                    row(t('mm'), mmText(cfg.mm, mmParamsOf(cfg))),
                    row(t('tp_tl'), riskText(cfg.risk)),
                    row(t('not_sent'), t('not_sent_v'))
                ])
            ]),
            h('div', { class: 'pos-mk-note', text: t('links_note') }),
            err,
            h('div', { class: 'pos-mk-sheet-foot' }, [btn(t('cancel'), 'ghost', closeSheet), ok])
        ], true);
        setTimeout(function () { try { title.focus(); } catch (_) {} }, 50);
    }

    // ── Публикация / цена (A8) ───────────────────────────────────────
    function openPublishSheet(c) {
        var prof = (S.my && S.my.profile) || null;
        if (!prof) { call('profile').then(function (r) { if (r.ok) { S.my = S.my || { own: [], installed: [], purchased: [] }; S.my.profile = r.profile; openPublishSheet(c); } else toast(errText(r), null, null, 'err'); }); return; }
        var isPublic = c.visibility === 'public';
        var paid = c.paid;
        var min = prof.price_min || 1, max = prof.price_max || 1000, fee = prof.fee_pct != null ? prof.fee_pct : 1;
        var priceIn = h('input', { type: 'text', inputmode: 'decimal', value: c.paid ? money(c.price_usdt) : money(min) });
        var feeNote = h('div', { class: 'pos-mk-note', style: 'margin-top:0' });
        var err = h('div', { class: 'pos-mk-risk-hint', style: 'display:none; border-color: rgba(248,113,113,.3); background: var(--q-down-soft); color: var(--q-down)' });
        var priceBox = h('div', null, [h('div', { class: 'pos-fg', style: 'margin-bottom:6px' }, [h('label', { text: fmt(t('price'), min, max) }), priceIn]), feeNote]);
        var walletNote = h('div', { class: 'pos-mk-lock-note', style: 'margin-top:10px' }, [t('need_wallet') + ' ',
            btn(t('open_profile'), 'ghost', function () { posApp.openUrl(prof.profile_url); }, { style: 'flex:none; margin-left:auto; padding:6px 10px' })]);
        var segFree = h('button', { type: 'button', class: 'pos-mk-seg-btn', onclick: function () { paid = false; sync(); } }, t('seg_free'));
        var segPaid = h('button', { type: 'button', class: 'pos-mk-seg-btn', onclick: function () { paid = true; sync(); } }, t('seg_paid'));
        var ok = btn(isPublic ? t('change_price') : t('publish'), 'primary', submit);
        function priceVal() { return parseFloat(String(priceIn.value).replace(',', '.')); }
        function sync() {
            segFree.classList.toggle('active', !paid);
            segPaid.classList.toggle('active', paid);
            priceBox.style.display = paid ? '' : 'none';
            walletNote.style.display = paid && !prof.can_sell ? '' : 'none';
            var v = priceVal();
            feeNote.textContent = isFinite(v) ? fmt(t('fee'), fee, (Math.floor(v * (100 - fee)) / 100).toFixed(2)) : '';
            ok.disabled = !prof.can_publish || (paid && !prof.can_sell);
        }
        priceIn.addEventListener('input', sync);
        function submit() {
            var price = 0;
            if (paid) {
                price = priceVal();
                if (!isFinite(price) || price < min || price > max || Math.round(price * 100) !== price * 100) {
                    err.textContent = errText({ error: 'bad_price', min: min, max: max }); err.style.display = ''; return;
                }
            }
            busy(ok, true);
            call('publish', { id: c.id, price: price.toFixed(2) }).then(function (r) {
                busy(ok, false);
                if (!r.ok) {
                    while (err.firstChild) err.removeChild(err.firstChild);
                    add(err, errText(r));
                    if (r.error === 'duplicate' && r.existing_id) {
                        add(err, [' ', h('a', { href: '#', style: 'color:inherit; text-decoration:underline', onclick: function (e) {
                            e.preventDefault(); closeSheet(); openDetail({ id: r.existing_id, title: '…', version: 1 }); } }, t('open'))]);
                    }
                    if ((r.error === 'nickname_required' || r.error === 'payout_address_required') && r.profile_url) {
                        add(err, [' ', h('a', { href: '#', style: 'color:inherit; text-decoration:underline', onclick: function (e) { e.preventDefault(); posApp.openUrl(r.profile_url); } }, t('open_profile'))]);
                    }
                    err.style.display = '';
                    return;
                }
                closeSheet();
                toast(isPublic ? t('price_ok') : t('published_ok'));
                loadMy(true);
                reloadDetail();
            });
        }
        var kids = [h('h3', { class: 'pos-mk-sheet-title', text: fmt(isPublic ? t('price_title') : t('publish_title'), c.title) })];
        if (!prof.can_publish) {
            kids.push(h('div', { class: 'pos-mk-lock-note' }, [t('need_nick') + ' ',
                btn(t('open_profile'), 'ghost', function () { posApp.openUrl(prof.profile_url); }, { style: 'flex:none; margin-left:auto; padding:6px 10px' })]));
        } else {
            kids.push(h('div', { class: 'pos-mk-segmented', style: 'margin-bottom:10px' }, [segFree, segPaid]), priceBox, walletNote);
        }
        kids.push(err, h('div', { class: 'pos-mk-sheet-foot' }, [btn(t('cancel'), 'ghost', closeSheet), ok]));
        openSheet(kids);
        sync();
    }

    function confirmSheet(title, text, label, danger, action) {
        var err = h('div', { class: 'pos-mk-risk-hint', style: 'display:none' });
        var ok = btn(label, danger ? 'danger' : 'primary', function () {
            busy(ok, true);
            action().then(function (e) {
                if (e) { busy(ok, false); err.textContent = e; err.style.display = ''; return; }
                closeSheet();
            });
        });
        openSheet([h('h3', { class: 'pos-mk-sheet-title', text: title }), h('p', { class: 'pos-mk-sheet-sub', text: text }), err,
            h('div', { class: 'pos-mk-sheet-foot' }, [btn(t('cancel'), 'ghost', closeSheet), ok])]);
    }

    // ── Нижний лист и тост ───────────────────────────────────────────
    function openSheet(kids) {
        closeSheet();
        var sheet = h('div', { class: 'pos-mk-sheet', role: 'dialog', 'aria-modal': 'true' }, kids);
        var ov = h('div', { class: 'pos-mk-sheet-overlay open' }, sheet);
        ov.addEventListener('pointerdown', function (e) { if (e.target === ov) closeSheet(); });
        S.sheet = ov;
        if (mk) mk.appendChild(ov);
    }
    function closeSheet() {
        if (S.sheet && S.sheet.parentNode) S.sheet.parentNode.removeChild(S.sheet);
        S.sheet = null;
    }
    function toast(text, actionLabel, action, kind, ms) {
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        clearTimeout(toastTimer);
        var style = kind === 'err' ? 'border-color: rgba(248,113,113,.3); background:#2a1212; color: var(--q-down);' : '';
        if (S.view !== 'list') style += 'bottom: 66px;'; // над липкой панелью действий детали/счёта
        toastEl = h('div', { class: 'pos-mk-toast', role: 'status', style: style }, [h('span', { text: text }),
            actionLabel ? h('button', { type: 'button', onclick: function () { hideToast(); action(); } }, actionLabel) : null]);
        if (mk) mk.appendChild(toastEl);
        toastTimer = setTimeout(hideToast, ms || 3500);
    }
    function hideToast() {
        clearTimeout(toastTimer);
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        toastEl = null;
    }

    // ── Покупка: счёт USDT (A9) ──────────────────────────────────────
    function buy(c, el) {
        if (S.authed === false) { if (EXT) openLoginSheet(); else toast(errText({ error: 'auth_required' }), null, null, 'err'); return; }
        busy(el, true);
        call('buy', { id: c.id }).then(function (r) {
            busy(el, false);
            if (!r.ok) {
                toast(errText(r), null, null, 'err');
                if (r.error === 'already_purchased') reloadDetail();
                return;
            }
            openPay(r.invoice, c);
        });
    }
    function openPay(inv, c) {
        S.pay = { invoice: inv, card: c, preset: null, deadline: Date.now() + (inv.seconds_left || 0) * 1000, txOpen: false, txErr: null };
        S.view = 'pay';
        renderAll();
        startPayPoll();
    }
    function startPayPoll() {
        stopPayPoll();
        payTick = setInterval(tickTimer, 1000);
        payPoll = setInterval(pollInvoice, 10000);
    }
    function stopPayPoll() { clearInterval(payPoll); clearInterval(payTick); payPoll = payTick = 0; }
    function pollInvoice() {
        var P = S.pay;
        if (!P || S.view !== 'pay' || !inMarket()) return;
        if (P.invoice.status !== 'pending') { stopPayPoll(); return; }
        call('invoice', { invoice_id: P.invoice.id }).then(function (r) { if (r.ok) setInvoice(r); });
    }
    function setInvoice(r) {
        var P = S.pay;
        if (!P || !r.invoice || r.invoice.id !== P.invoice.id) return;
        var changed = r.invoice.status !== P.invoice.status;
        P.invoice = r.invoice;
        P.deadline = Date.now() + (r.invoice.seconds_left || 0) * 1000;
        if (r.preset) P.preset = r.preset;
        if (r.invoice.status !== 'pending') stopPayPoll();
        if (changed) {
            if (r.invoice.status === 'paid') loadMy(true);
            if (S.view === 'pay') renderAll();
        }
    }
    function tickTimer() {
        var P = S.pay;
        if (!P) return;
        var left = Math.max(0, Math.round((P.deadline - Date.now()) / 1000));
        var el = mk && mk.querySelector('.pos-mk-timer');
        if (el) {
            el.textContent = (left / 60 | 0) + ':' + ('0' + left % 60).slice(-2);
            el.classList.toggle('low', left < 300);
        }
        if (left === 0 && P.invoice.status === 'pending') { P.invoice.status = 'expired'; stopPayPoll(); pollOnce(); if (S.view === 'pay') renderAll(); }
    }
    function pollOnce() {
        var P = S.pay;
        if (!P) return;
        call('invoice', { invoice_id: P.invoice.id }).then(function (r) {
            if (!r.ok || !S.pay || r.invoice.id !== S.pay.invoice.id) return;
            S.pay.invoice = r.invoice;
            if (r.preset) S.pay.preset = r.preset;
            if (r.invoice.status === 'paid') loadMy(true);
            if (S.view === 'pay') renderAll();
        });
    }
    function qrCanvas(text) {
        var box = h('div', { class: 'pos-mk-qr' });
        try {
            var qr = qrcode(0, 'M');
            qr.addData(text);
            qr.make();
            var n = qr.getModuleCount(), cell = 4, quiet = 2, size = (n + quiet * 2) * cell;
            var cv = h('canvas', { width: String(size), height: String(size), style: 'width:100%; height:100%; image-rendering:pixelated' });
            var g = cv.getContext('2d');
            g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
            g.fillStyle = '#000';
            for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
            box.appendChild(cv);
        } catch (_) { box.textContent = 'QR'; }
        return box;
    }
    function txForm(P) {
        var input = h('input', { type: 'text', placeholder: t('tx_ph'), spellcheck: 'false', style: "font-family:'JetBrains Mono', ui-monospace, monospace" });
        var err = h('div', { class: 'pos-mk-risk-hint', style: P.txErr ? '' : 'display:none', text: P.txErr || '' });
        var ok = btn(t('check'), 'primary', function () {
            var v = input.value.trim();
            if (!v) return;
            busy(ok, true);
            call('invoice_tx', { invoice_id: P.invoice.id, tx_hash: v }).then(function (r) {
                busy(ok, false);
                if (r.invoice) { P.txErr = r.ok ? null : errText(r); P.invoice = r.invoice; if (r.preset) P.preset = r.preset; }
                if (r.ok || r.invoice) {
                    if (r.invoice && r.invoice.status === 'paid') { loadMy(true); if (!P.preset) pollOnce(); }
                    if (r.invoice && r.invoice.status !== 'pending') stopPayPoll();
                    renderAll();
                    return;
                }
                err.textContent = errText(r); err.style.display = '';
            });
        }, { style: 'flex:none; padding:8px 14px' });
        return h('div', { style: 'margin-top:10px' }, [h('div', { style: 'display:flex; gap:8px' }, [h('div', { class: 'pos-fg', style: 'flex:1; margin:0' }, input), ok]), err]);
    }
    function renderPay() {
        var P = S.pay, inv = P.invoice;
        mk.appendChild(head(t('invoice') + inv.id, true));
        var pad = h('div', { class: 'pos-mk-screen-pad' });
        mk.appendChild(pad);
        var title = inv.title || (P.card && P.card.title) || '';
        if (inv.status === 'paid') {
            var pr = P.preset;
            pad.appendChild(h('div', { class: 'pos-mk-pay-result ok' }, [
                h('span', { class: 'ico', text: '✅' }), h('h3', { style: 'margin:0; font-size:13px', text: t('paid') }),
                h('p', { text: fmt(t('paid_text'), title) }),
                pr && pr.config ? btn(t('apply'), 'primary', function () { openApplySheet(pr); }, { style: 'flex:none; padding:10px 22px' }) : null
            ]));
            return;
        }
        if (inv.status === 'underpaid') {
            pad.appendChild(h('div', { class: 'pos-mk-pay-result fail' }, [
                h('span', { class: 'ico', text: '⚠️' }), h('h3', { style: 'margin:0; font-size:13px', text: t('underpaid') }),
                h('p', { text: fmt(t('underpaid_text'), inv.paid_amount || '0', inv.price) })
            ]));
            return;
        }
        if (inv.status === 'expired' || inv.status === 'canceled') {
            var res = h('div', { class: 'pos-mk-pay-result fail' }, [
                h('span', { class: 'ico', text: '⏱️' }),
                h('h3', { style: 'margin:0; font-size:13px', text: inv.status === 'expired' ? t('expired') : t('canceled') }),
                inv.status === 'expired' ? h('p', { text: t('expired_text') }) : null,
                h('div', { style: 'display:flex; gap:8px; width:100%' }, [
                    inv.status === 'expired' ? btn(t('enter_tx'), 'ghost', function () { P.txOpen = true; renderAll(); }) : null,
                    P.card ? btn(t('new_invoice'), 'primary', function (e) { buy(P.card, e.currentTarget); }) : null
                ])
            ]);
            pad.appendChild(res);
            if (P.txOpen) pad.appendChild(txForm(P));
            return;
        }
        // pending
        var amount = h('button', { type: 'button', class: 'pos-mk-pay-amount', onclick: function () { copyText(inv.amount, amount); } },
            [inv.amount + ' ' + (inv.currency || 'USDT') + ' ', h('span', { class: 'copy-ico', text: '⧉' })]);
        var addr = h('button', { type: 'button', class: 'pos-mk-pay-address', onclick: function () { copyText(inv.address, addr); } }, inv.address + ' ⧉');
        add(pad, [
            h('div', { class: 'pos-mk-pay-status' }, h('span', { class: 'pos-mk-risk medium', style: 'color:var(--q-gold); background:var(--q-gold-soft)', text: t('waiting') })),
            amount,
            h('div', { style: 'text-align:center; margin:8px 0' }, h('span', { class: 'pos-mk-pay-network', text: 'USDT · TRC20 (TRON)' })),
            addr,
            qrCanvas(inv.address),
            h('div', { class: 'pos-mk-timer', text: '' }),
            h('div', { class: 'pos-mk-waiting' }, [h('span', { class: 'pos-mk-spinner' }), ' ' + t('waiting')]),
            h('div', { class: 'pos-mk-note', text: t('pay_note') }),
            h('div', { class: 'pos-mk-actions' }, btn(t('open_pay'), 'ghost', function () { posApp.openUrl(inv.pay_url); })),
            P.txOpen ? txForm(P) : h('button', { type: 'button', class: 'pos-mk-filters-reset', style: 'display:block; margin:8px auto 0',
                onclick: function () { P.txOpen = true; renderAll(); } }, t('have_paid'))
        ]);
        tickTimer();
    }

    // ── Навигация ────────────────────────────────────────────────────
    function setTab(tab) {
        if (S.tab === tab) return;
        S.tab = tab;
        S.filtersOpen = false;
        renderAll();
        if (tab === 'my') loadMy();
        else loadList(false);
    }
    function back() {
        closeSheet();
        if (S.view === 'pay') {
            stopPayPoll();
            S.pay = null;
            S.view = S.detail ? 'detail' : 'list';
            if (S.detail) reloadDetail();
        } else {
            S.detail = null;
            S.view = 'list';
        }
        renderAll();
    }
    function closeDrawer() {
        if (posApp.drawer) posApp.drawer.setOpen(false);
        else exit(); // расширение: ✕ возвращает к панели бота
    }

    function enter() {
        if (!panel || !mk) return;
        if (EXT) {
            if (panel.classList.contains('minimized')) { var mb = document.getElementById('pos-min-btn'); if (mb) mb.click(); }
            refreshAccount();
        }
        panel.classList.add('market-mode');
        if (EXT) fitPanel();
        if (handle) handle.classList.add('active');
        renderAll();
        if (S.view === 'list') {
            if (S.tab === 'my') loadMy();
            else if (!S.list.items.length || S.list.error) loadList(false);
        }
        if (S.view === 'pay' && S.pay && S.pay.invoice.status === 'pending') { startPayPoll(); pollInvoice(); }
        if (posApp.drawer) posApp.drawer.setOpen(true);
    }
    function exit() {
        closeSheet();
        stopPayPoll();
        if (panel) panel.classList.remove('market-mode');
        if (handle) handle.classList.remove('active');
    }
    posApp.ui = {
        exit: exit,
        onDrawer: function (open) {
            if (open || !inMarket()) return;
            // панель уехала — после анимации возвращаем обычный режим, чтобы язычок PoS открыл панель бота
            setTimeout(function () { if (!(posApp.drawer && posApp.drawer.isOpen())) exit(); }, 360);
        },
        onEsc: function () {
            if (S.sheet) { closeSheet(); return true; }
            if (S.view !== 'list') { back(); return true; }
            return false;
        }
    };

    // ── Язычок и встраивание в панель ────────────────────────────────
    function buildHandle() {
        if (EXT) {
            // расширение: кнопка в шапке панели бота (в режиме маркета шапка скрыта — выход через ✕/Esc в шапке маркета)
            var e = h('button', { type: 'button', id: 'pos-market-btn', class: 'pos-icon-btn pos-mk-hdr-btn', title: t('handle'), 'aria-label': t('handle') },
                ['🏪', h('span', { class: 'pmh-badge' })]);
            e.addEventListener('click', function () { if (inMarket()) exit(); else enter(); });
            return e;
        }
        var b = h('button', { type: 'button', id: 'pos-market-handle', title: t('handle'), 'aria-controls': 'pos-panel' },
            ['🏪', h('span', { class: 'pmh-badge' })]);
        b.addEventListener('click', function () {
            if (inMarket() && posApp.drawer && posApp.drawer.isOpen()) closeDrawer();
            else enter();
        });
        return b;
    }
    function attach(p) {
        panel = p;
        mk = document.getElementById('pos-market');
        if (!mk) { mk = h('div', { id: 'pos-market' }); p.appendChild(mk); }
        if (!handle) handle = buildHandle();
        mountHandle();
        var lb = document.getElementById('pos-lang-btn');
        if (lb) lb.addEventListener('click', function () { setTimeout(function () { if (handle) { handle.title = t('handle'); if (EXT) handle.setAttribute('aria-label', t('handle')); } if (inMarket()) renderAll(); }, 0); });
        if (EXT) refreshAccount();
        // бейдж обновлений — без открытия маркета: «Мои» через несколько секунд после загрузки и раз в 30 минут
        clearInterval(myTimer);
        setTimeout(function () { if (panel) loadMy(true); }, 4000);
        myTimer = setInterval(function () { if (panel) loadMy(true); }, 30 * 60 * 1000);
    }
    function detach() {
        exit();
        clearInterval(myTimer);
        if (handle && handle.parentNode) handle.parentNode.removeChild(handle);
        panel = null; mk = null; bodyEl = null;
    }
    function check() {
        var p = document.getElementById('pos-panel');
        if (p && p !== panel) attach(p);
        else if (!p && panel) detach();
    }
    function start() {
        check();
        new MutationObserver(check).observe(document.body, { childList: true });
        if (EXT) {
            // в приложении Esc обрабатывает app-drawer.js
            document.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape' || !inMarket()) return;
                e.stopPropagation();
                if (posApp.ui && posApp.ui.onEsc && posApp.ui.onEsc()) return;
                exit();
            }, true);
            // вход или выход в другой вкладке
            document.addEventListener('visibilitychange', function () { if (!document.hidden && panel) refreshAccount(); });
        }
    }

    // ── Только расширение: место кнопки, высота панели, вход в аккаунт ──
    function mountHandle() {
        if (!EXT) { document.body.appendChild(handle); return; }
        var actions = panel.querySelector('.pos-hdr-actions');
        var lb = document.getElementById('pos-lang-btn');
        if (actions && lb && lb.parentNode === actions) actions.insertBefore(handle, lb);
        else (actions || panel).appendChild(handle);
    }
    /** Плавающая панель в режиме маркета выше обычной: если не влезает по высоте — поднять. */
    function fitPanel() {
        if (!panel) return;
        try {
            var r = panel.getBoundingClientRect(), vh = window.innerHeight || 800;
            if (r.bottom > vh - 8) panel.style.top = Math.max(8, Math.round(vh - r.height - 8)) + 'px';
        } catch (_) {}
    }
    function refreshAccount() {
        var acc = posApp.account;
        if (!EXT || !acc || typeof acc.state !== 'function') return Promise.resolve();
        return acc.state().then(function (st) {
            var was = S.account;
            S.account = st && st.email ? { email: st.email } : null;
            if (!S.account) {
                if (was || S.authed !== false) {
                    S.authed = false; S.my = null;
                    if (was) { var core = posApp.core; if (core && typeof core.setLibrary === 'function') { try { core.setLibrary([]); } catch (_) {} } }
                    syncBadges();
                    if (inMarket()) renderAll();
                }
            } else if (!was || was.email !== S.account.email) {
                // вошли (в т.ч. в другой вкладке) — обновить «Мои» и бейдж
                S.authed = null; S.my = null; S.myError = null;
                loadMy(true);
                if (inMarket()) renderAll();
            }
        });
    }
    function openLoginSheet() {
        var acc = posApp.account;
        if (!acc) return;
        var site = 'https://pocketoption-signal.online' + (lang() === 'en' ? '/en' : '');
        var email = h('input', { type: 'email', autocomplete: 'username', maxlength: '190', spellcheck: 'false' });
        var pass = h('input', { type: 'password', autocomplete: 'current-password', maxlength: '200' });
        var totp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', spellcheck: 'false' });
        var totpBox = h('div', { class: 'pos-fg', style: 'margin-bottom:8px; display:none' }, [h('label', { text: t('totp') }), totp]);
        var err = h('div', { class: 'pos-mk-risk-hint', style: 'display:none' });
        var ok = btn(t('login'), 'primary', submit);
        function showErr(text) { err.textContent = text || ''; err.style.display = text ? '' : 'none'; }
        function submit() {
            var ev = email.value.trim(), pv = pass.value, E = ERR[lang()];
            if (!ev || !pv) { showErr(E.bad_credentials); return; }
            busy(ok, true); showErr('');
            acc.login(ev, pv, totpBox.style.display === 'none' ? '' : totp.value.trim(), lang()).then(function (r) {
                busy(ok, false);
                r = r || { ok: false, error: 'network' };
                if (!r.ok) {
                    if (r.error === '2fa_required' || r.error === 'bad_totp') {
                        totpBox.style.display = '';
                        setTimeout(function () { try { totp.focus(); } catch (_) {} }, 30);
                    }
                    showErr(r.error === 'rate_limited' ? E.login_rate : (E[r.error] && !AUTH_ERRORS[r.error] ? E[r.error] : errText(r)));
                    return;
                }
                pass.value = '';
                closeSheet();
                S.account = { email: (r.account && r.account.email) || ev };
                S.authed = true; S.my = null; S.myError = null;
                toast(t('logged_in'));
                loadMy(true);
                if (S.view === 'detail') reloadDetail();
                else if (S.view === 'list' && S.tab !== 'my') loadList(false);
                renderAll();
            });
        }
        [email, pass, totp].forEach(function (inp) {
            inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        });
        var link = function (text, url) { return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'pos-mk-login-link' }, text); };
        openSheet([
            h('h3', { class: 'pos-mk-sheet-title', text: t('login_title') }),
            h('div', { class: 'pos-fg', style: 'margin-bottom:8px' }, [h('label', { text: t('email') }), email]),
            h('div', { class: 'pos-fg', style: 'margin-bottom:8px' }, [h('label', { text: t('password') }), pass]),
            totpBox,
            h('div', { class: 'pos-mk-login-links' }, [link(t('register'), site + '/account/register'), link(t('forgot'), site + '/account/forgot')]),
            h('div', { class: 'pos-mk-note', text: t('login_note') }),
            err,
            h('div', { class: 'pos-mk-sheet-foot' }, [btn(t('cancel'), 'ghost', closeSheet), ok])
        ]);
        setTimeout(function () { try { email.focus(); } catch (_) {} }, 50);
    }
    function logout() {
        var acc = posApp.account;
        if (!acc) return;
        acc.logout().then(function () {
            S.account = null; S.authed = false; S.my = null; S.myError = null;
            var core = posApp.core;
            if (core && typeof core.setLibrary === 'function') { try { core.setLibrary([]); } catch (_) {} }
            syncBadges();
            toast(t('logged_out'));
            if (S.view === 'list' && S.tab !== 'my') loadList(false);
            renderAll();
        });
    }
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
})();
