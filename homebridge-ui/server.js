'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runTapoCloudProbe } = require('../src/tapo-cloud');

(async () => {
  const { HomebridgePluginUiServer } = await import('@homebridge/plugin-ui-utils');

  class TapoEnergyMonitorUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/summary', this.getSummary.bind(this));
      this.onRequest('/tapo-cloud-test', this.testTapoCloud.bind(this));
      this.ready();
    }

    async getSummary(payload = {}) {
      const directory = this.homebridgeStoragePath;
      if (!directory) throw new Error('Homebridge storage directory is not available.');
      const filePath = path.join(directory, 'tapo-energy-history.json');

      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (!data || !data.devices || !data.totals) throw new Error('Invalid energy history format.');
        return { available: true, updatedAt: fs.statSync(filePath).mtimeMs, data };
      } catch (error) {
        if (error.code === 'ENOENT') return { available: false, message: 'No history file yet. Start the platform in simulation mode and wait for its first sample.' };
        throw error;
      }
    }

    async testTapoCloud(payload = {}) {
      const username = typeof payload.username === 'string' ? payload.username.trim() : '';
      const password = typeof payload.password === 'string' ? payload.password : '';
      const mfaCode = typeof payload.mfaCode === 'string' ? payload.mfaCode.trim() : '';
      const pythonExecutable = typeof payload.pythonExecutable === 'string' && payload.pythonExecutable.trim()
        ? payload.pythonExecutable.trim()
        : 'python3';
      if (!username || !password) {
        return { ok: false, code: 'credentials_required', message: 'Укажите email и пароль аккаунта Tapo.' };
      }
      if (username.length > 320 || password.length > 2048 || mfaCode.length > 32) {
        return { ok: false, code: 'invalid_input', message: 'Проверьте длину введённых данных.' };
      }
      return runTapoCloudProbe({ username, password, mfaCode, pythonExecutable });
    }
  }

  new TapoEnergyMonitorUiServer();
})().catch((error) => {
  console.error('Could not start Tapo Energy Monitor UI server:', error);
  process.exit(1);
});
