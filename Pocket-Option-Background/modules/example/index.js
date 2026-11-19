'use strict';
exports.createModule = async context => ({
  async start() { context.log('info', 'Пример модуля готов к подключению'); },
  async stop() {},
  async healthCheck() { return { ok: true, detail: 'Примерный модуль активен' }; }
});
