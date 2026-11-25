'use strict';

const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { HomebridgePluginUiServer } = await import('@homebridge/plugin-ui-utils');

  class TapoEnergyMonitorUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/summary', this.getSummary.bind(this));
      this.ready();
    }

    async getSummary(payload = {}) {
      const requestedDirectory = typeof payload.dataDirectory === 'string' ? payload.dataDirectory.trim() : '';
      const directory = requestedDirectory ? path.resolve(requestedDirectory) : this.homebridgeStoragePath;
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
  }

  new TapoEnergyMonitorUiServer();
})().catch((error) => {
  console.error('Could not start Tapo Energy Monitor UI server:', error);
  process.exit(1);
});
