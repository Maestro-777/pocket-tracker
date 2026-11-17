(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get('tabId'));
  const requestedLang = String(params.get('lang') || 'ru').toLowerCase();
  const mode = String(params.get('mode') || 'popup').toLowerCase() === 'tab' ? 'tab' : 'popup';
  const sourceUrl = String(params.get('sourceUrl') || '');
  const canonicalTarget = String(params.get('target') || 'https://pocketoption.com/');
  const supportedLanguages = ['ru', 'en', 'es', 'hi', 'ar'];
  const lang = supportedLanguages.includes(requestedLang.split('-')[0]) ? requestedLang.split('-')[0] : 'ru';
  const hostEl = document.getElementById('mirrorHost');
  const messageEl = document.getElementById('message');
  const openButton = document.getElementById('openButton');
  const barOpenButton = document.getElementById('barOpenButton');
  const barStatus = document.getElementById('barStatus');
  const barMessage = document.getElementById('barMessage');
  const closeButton = document.getElementById('closeButton');

  const copy = {
    ru: {
      pageTitle: 'Pocket TRADE ROBOT — нужен VPN',
      subtitle: 'Для стабильной торговли нужен основной домен',
      title: 'Robot работает только на pocketoption.com',
      description: 'Вы открыли зеркало Pocket Option. На зеркалах автоторговля отключена из-за нестабильного торгового соединения.',
      step1: 'Включите VPN для компьютера.',
      step2: 'После подключения VPN нажмите кнопку ниже.',
      step3: 'Откроется основной сайт pocketoption.com, где Robot работает в штатном режиме.',
      currentLabel: 'Текущий зеркальный домен',
      message: 'VPN должен быть включён на компьютере до перехода на основной сайт.',
      open: 'VPN включён — открыть pocketoption.com',
      close: 'Закрыть',
      opening: 'Открываем основной сайт…',
      error: 'Не удалось открыть основной сайт. Проверьте VPN и повторите.',
      privacyTitle: 'Только локальное предупреждение',
      privacyText: 'Торговый модуль, данные аккаунта и автоторговля на зеркале не запускаются.',
      barStatus: 'Нужен VPN',
      barMessage: 'Зеркало обнаружено · торговое соединение отключено',
      barOpen: '⚡ Открыть Pocket TRADE ROBOT',
      closeTab: 'Закрыть вкладку'
    },
    en: {
      pageTitle: 'Pocket TRADE ROBOT — VPN required',
      subtitle: 'The canonical domain is required for stable trading',
      title: 'Robot works only on pocketoption.com',
      description: 'You opened a Pocket Option mirror. Autotrading is disabled on mirrors because the trading connection is not stable enough.',
      step1: 'Enable a VPN for the whole computer.',
      step2: 'After the VPN connects, click the button below.',
      step3: 'The main pocketoption.com site will open, where Robot works normally.',
      currentLabel: 'Current mirror domain',
      message: 'Enable the VPN on the computer before opening the main site.',
      open: 'VPN is on — open pocketoption.com',
      close: 'Close',
      opening: 'Opening the main site…',
      error: 'Could not open the main site. Check the VPN and try again.',
      privacyTitle: 'Local warning only',
      privacyText: 'Trading, account data and autotrading are not started on the mirror.',
      barStatus: 'VPN required',
      barMessage: 'Mirror detected · trading connection is disabled',
      barOpen: '⚡ Open Pocket TRADE ROBOT',
      closeTab: 'Close tab'
    },
    es: {
      pageTitle: 'Pocket TRADE ROBOT — se necesita VPN',
      subtitle: 'El dominio principal es necesario para un trading estable',
      title: 'Robot funciona solo en pocketoption.com',
      description: 'Has abierto un espejo de Pocket Option. El trading automático está desactivado en los espejos porque la conexión de trading no es suficientemente estable.',
      step1: 'Activa una VPN para todo el ordenador.',
      step2: 'Cuando la VPN se conecte, pulsa el botón de abajo.',
      step3: 'Se abrirá el sitio principal pocketoption.com, donde Robot funciona normalmente.',
      currentLabel: 'Dominio espejo actual',
      message: 'Activa la VPN en el ordenador antes de abrir el sitio principal.',
      open: 'VPN activada — abrir pocketoption.com',
      close: 'Cerrar',
      opening: 'Abriendo el sitio principal…',
      error: 'No se pudo abrir el sitio principal. Comprueba la VPN e inténtalo de nuevo.',
      privacyTitle: 'Solo aviso local',
      privacyText: 'El trading, los datos de cuenta y el trading automático no se inician en el espejo.',
      barStatus: 'Se necesita VPN',
      barMessage: 'Espejo detectado · conexión de trading desactivada',
      barOpen: '⚡ Abrir Pocket TRADE ROBOT',
      closeTab: 'Cerrar pestaña'
    },
    hi: {
      pageTitle: 'Pocket TRADE ROBOT — VPN आवश्यक',
      subtitle: 'स्थिर ट्रेडिंग के लिए मुख्य डोमेन आवश्यक है',
      title: 'Robot केवल pocketoption.com पर काम करता है',
      description: 'आपने Pocket Option का मिरर खोला है। अस्थिर ट्रेडिंग कनेक्शन के कारण मिरर पर ऑटोट्रेडिंग बंद रहती है।',
      step1: 'पूरे कंप्यूटर के लिए VPN चालू करें।',
      step2: 'VPN कनेक्ट होने के बाद नीचे का बटन दबाएँ।',
      step3: 'मुख्य pocketoption.com साइट खुलेगी, जहाँ Robot सामान्य रूप से काम करता है।',
      currentLabel: 'वर्तमान मिरर डोमेन',
      message: 'मुख्य साइट खोलने से पहले कंप्यूटर पर VPN चालू करें।',
      open: 'VPN चालू है — pocketoption.com खोलें',
      close: 'बंद करें',
      opening: 'मुख्य साइट खोली जा रही है…',
      error: 'मुख्य साइट नहीं खुल सकी। VPN जाँचें और फिर कोशिश करें।',
      privacyTitle: 'केवल स्थानीय चेतावनी',
      privacyText: 'मिरर पर ट्रेडिंग, खाता डेटा और ऑटोट्रेडिंग शुरू नहीं होते।',
      barStatus: 'VPN आवश्यक',
      barMessage: 'मिरर मिला · ट्रेडिंग कनेक्शन बंद है',
      barOpen: '⚡ Pocket TRADE ROBOT खोलें',
      closeTab: 'टैब बंद करें'
    },
    ar: {
      pageTitle: 'Pocket TRADE ROBOT — VPN مطلوب',
      subtitle: 'النطاق الرئيسي مطلوب لتداول مستقر',
      title: 'يعمل Robot فقط على pocketoption.com',
      description: 'لقد فتحت نطاقاً مرآة لـ Pocket Option. التداول التلقائي معطل على النطاقات المرآة لأن اتصال التداول غير مستقر بما يكفي.',
      step1: 'شغّل VPN للكمبيوتر كله.',
      step2: 'بعد اتصال VPN، اضغط على الزر أدناه.',
      step3: 'سيُفتح موقع pocketoption.com الرئيسي حيث يعمل Robot بشكل طبيعي.',
      currentLabel: 'النطاق المرآة الحالي',
      message: 'شغّل VPN على الكمبيوتر قبل فتح الموقع الرئيسي.',
      open: 'VPN يعمل — افتح pocketoption.com',
      close: 'إغلاق',
      opening: 'جارٍ فتح الموقع الرئيسي…',
      error: 'تعذّر فتح الموقع الرئيسي. تحقق من VPN وحاول مرة أخرى.',
      privacyTitle: 'تحذير محلي فقط',
      privacyText: 'لا يبدأ التداول أو الوصول لبيانات الحساب أو التداول التلقائي على النطاق المرآة.',
      barStatus: 'VPN مطلوب',
      barMessage: 'تم اكتشاف نطاق مرآة · اتصال التداول متوقف',
      barOpen: '⚡ افتح Pocket TRADE ROBOT',
      closeTab: 'إغلاق علامة التبويب'
    }
  }[lang];

  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = copy.pageTitle;
  document.body.dataset.mode = mode;
  for (const [id, key] of [['subtitle','subtitle'],['title','title'],['description','description'],['step1','step1'],['step2','step2'],['step3','step3'],['currentLabel','currentLabel']]) {
    const el = document.getElementById(id);
    if (el) el.textContent = copy[key];
  }
  messageEl.textContent = copy.message;
  openButton.textContent = copy.open;
  if (barStatus) barStatus.textContent = copy.barStatus;
  if (barMessage) barMessage.textContent = copy.barMessage;
  if (barOpenButton) barOpenButton.textContent = copy.barOpen;
  closeButton.textContent = mode === 'tab' ? copy.closeTab : copy.close;
  const privacyTitle = document.querySelector('.privacy-note b');
  const privacyText = document.querySelector('.privacy-note small');
  if (privacyTitle) privacyTitle.textContent = copy.privacyTitle;
  if (privacyText) privacyText.textContent = copy.privacyText;
  hostEl.textContent = params.get('host') || 'po-***.com';

  const runtimeMessage = (payload, timeoutMs = 10000) => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
      else finish(response || { ok: false });
    });
  });

  const openMainSite = async () => {
    openButton.disabled = true;
    if (barOpenButton) barOpenButton.disabled = true;
    closeButton.disabled = true;
    messageEl.textContent = copy.opening;
    messageEl.className = 'message success';
    const result = await runtimeMessage({ type: 'PT_VPN_OPEN_MAIN_SITE', tabId, target: canonicalTarget });
    if (!result?.ok) {
      messageEl.textContent = copy.error;
      messageEl.className = 'message error';
      openButton.disabled = false;
      if (barOpenButton) barOpenButton.disabled = false;
      closeButton.disabled = false;
      return;
    }
    if (mode === 'popup') setTimeout(() => window.close(), 160);
  };

  openButton.addEventListener('click', openMainSite);
  barOpenButton?.addEventListener('click', openMainSite);

  closeButton.addEventListener('click', async () => {
    if (mode === 'popup') { window.close(); return; }
    await runtimeMessage({ type: 'PT_VPN_CLOSE_NOTICE', tabId, mode });
  });

  void runtimeMessage({ type: 'PT_VPN_REQUIRED_CONTEXT', tabId, sourceUrl }, 5000).then((context) => {
    if (context?.ok && context?.host) hostEl.textContent = context.host;
  });
})();
