'use strict';
const fs = require('node:fs');
const path = require('node:path');

class ModuleManager {
  constructor(options) {
    this.directory = options.directory;
    this.context = options.context || {};
    this.log = options.log || (() => {});
    this.modules = [];
  }

  async loadAll() {
    fs.mkdirSync(this.directory, { recursive: true });
    const entries = fs.readdirSync(this.directory, { withFileTypes: true }).filter(entry => entry.isDirectory());
    for (const entry of entries) {
      const folder = path.join(this.directory, entry.name);
      const manifestPath = path.join(folder, 'manifest.json');
      try {
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.enabled === false) continue;
        if (!manifest.id || !manifest.entrypoint) throw new Error('В manifest.json обязательны id и entrypoint');
        const modulePath = path.resolve(folder, manifest.entrypoint);
        if (!modulePath.startsWith(folder + path.sep)) throw new Error('Entry point выходит за пределы каталога модуля');
        const exported = require(modulePath);
        const factory = exported.createModule || exported.default;
        if (typeof factory !== 'function') throw new Error('Модуль должен экспортировать createModule(context)');
        const instance = await factory({ ...this.context, manifest });
        if (!instance || typeof instance !== 'object') throw new Error('createModule должен вернуть объект модуля');
        const record = { manifest, instance, started: false };
        if (typeof instance.start === 'function') await instance.start();
        record.started = true;
        this.modules.push(record);
        this.log('info', 'Модуль подключён', { id: manifest.id, version: manifest.version || '0.0.0' });
      } catch (error) {
        this.log('error', 'Не удалось загрузить модуль ' + entry.name, String(error));
      }
    }
  }

  async healthChecks() {
    const results = [];
    for (const record of this.modules) {
      const name = record.manifest.name || record.manifest.id;
      if (typeof record.instance.healthCheck !== 'function') {
        results.push({ name: 'Модуль: ' + name, ok: true, state: 'not-connected', detail: 'Модуль не предоставляет healthCheck()' });
        continue;
      }
      try {
        const result = await record.instance.healthCheck();
        results.push({ name: 'Модуль: ' + name, ok: result?.ok !== false, detail: String(result?.detail || 'Проверка выполнена') });
      } catch (error) {
        results.push({ name: 'Модуль: ' + name, ok: false, detail: String(error) });
      }
    }
    return results;
  }

  async stopAll() {
    for (const record of [...this.modules].reverse()) {
      if (!record.started || typeof record.instance.stop !== 'function') continue;
      try { await record.instance.stop(); record.started = false; }
      catch (error) { this.log('error', 'Ошибка остановки модуля ' + record.manifest.id, String(error)); }
    }
  }
}
module.exports = ModuleManager;
