'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { probeTapoThingCloud } = require('../src/tapo-cloud-client');
const { parseWattCsv } = require('../src/watt-csv');

(async () => {
  const { HomebridgePluginUiServer } = await import('@homebridge/plugin-ui-utils');

  class TapoEnergyMonitorUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/summary', this.getSummary.bind(this));
      this.onRequest('/watt-imports', this.getWattImports.bind(this));
      this.onRequest('/watt-import', this.importWattCsv.bind(this));
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


    getWattImports() {
      const directory = this.homebridgeStoragePath;
      if (!directory) throw new Error('Homebridge storage directory is not available.');
      const filePath = path.join(directory, 'tapo-watt-imports.json');
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return { version: 1, individual: null, aggregate: null };
        throw error;
      }
    }

    importWattCsv(payload = {}) {
      const kind = payload.kind === 'aggregate' ? 'aggregate' : payload.kind === 'individual' ? 'individual' : null;
      const csv = typeof payload.csv === 'string' ? payload.csv : '';
      const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 80) : '';
      if (!kind) throw new Error('Select individual device or aggregate history.');
      if (kind === 'individual' && !label) throw new Error('Enter a device label for individual history.');
      const parsed = parseWattCsv(csv);
      const imports = this.getWattImports();
      imports[kind] = {
        label: kind === 'aggregate' ? 'All devices · Watt export' : label,
        importedAt: new Date().toISOString(),
        source: 'Watt CSV',
        ...parsed
      };
      const directory = this.homebridgeStoragePath;
      const filePath = path.join(directory, 'tapo-watt-imports.json');
      const tempPath = filePath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(imports, null, 2));
      fs.renameSync(tempPath, filePath);
      return { ok: true, kind, label: imports[kind].label, recordCount: parsed.recordCount, totalWh: parsed.totalWh, monthly: parsed.monthly, yearly: parsed.yearly };
    }

    async testTapoCloud(payload = {}) {
      const username = typeof payload.username === 'string' ? payload.username.trim() : '';
      const password = typeof payload.password === 'string' ? payload.password : '';
      const mfaCode = typeof payload.mfaCode === 'string' ? payload.mfaCode.trim() : '';
      if (!username || !password) {
        return { ok: false, code: 'credentials_required', message: 'Укажите email и пароль аккаунта Tapo.' };
      }
      if (username.length > 320 || password.length > 2048 || mfaCode.length > 32) {
        return { ok: false, code: 'invalid_input', message: 'Проверьте длину введённых данных.' };
      }
      return probeTapoThingCloud({ username, password, mfaCode });
    }
  }

  new TapoEnergyMonitorUiServer();
})().catch((error) => {
  console.error('Could not start Tapo Energy Monitor UI server:', error);
  process.exit(1);
});
