# Модульная архитектура

Приложение загружает модули из отдельных подпапок каталога `modules/`. Каждый модуль должен иметь `manifest.json` и JS entry point. Модульный код выполняется в главном процессе Electron и должен быть доверенным.

Пример manifest:

```json
{
  "id": "sample-module",
  "name": "Sample module",
  "version": "1.0.0",
  "enabled": false,
  "entrypoint": "index.js"
}
```

Entry point экспортирует фабрику:

```js
exports.createModule = async context => ({
  async start() {},
  async stop() {},
  async healthCheck() {
    return { ok: true, detail: "Модуль работает" };
  }
});
```

Контекст сейчас содержит `app`, `log` и `manifest`. Модули запускаются при старте приложения и останавливаются при завершении. Метод `healthCheck()` включается в пятиминутную диагностику.

Не устанавливайте непроверенные модули: они исполняются с полномочиями главного процесса приложения.
