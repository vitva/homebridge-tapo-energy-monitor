'use strict';

const path = require('path');
const { EnergyStore } = require('./energy-store');

class TapoEnergyMonitorPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.timer = null;
    this.store = null;

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    });
  }

  start() {
    if (this.config.simulationMode !== true) {
      this.log.warn('Simulation is disabled, but real Tapo communication is not implemented. No devices will be polled.');
      return;
    }

    const storageRoot = this.config.dataDirectory && this.config.dataDirectory.trim()
      ? path.resolve(this.config.dataDirectory.trim())
      : this.api.user.storagePath();
    this.store = new EnergyStore(storageRoot, this.log);

    const interval = Math.max(30, Math.min(3600, Number(this.config.pollingIntervalSeconds) || 60));
    const configured = Array.isArray(this.config.simulatedDevices) ? this.config.simulatedDevices : [];
    const devices = configured.length
      ? configured
      : [{ id: 'demo-p110m', name: 'Demo P110M', model: 'P110M', powerW: this.config.simulatedPowerW ?? 450 }];

    const normalized = devices
      .filter(device => device && typeof device.id === 'string' && device.id.trim())
      .map(device => ({
        id: device.id.trim(),
        name: typeof device.name === 'string' && device.name.trim() ? device.name.trim() : device.id.trim(),
        model: typeof device.model === 'string' ? device.model : 'Simulation',
        powerW: Math.max(0, Number(device.powerW) || 0)
      }));

    if (!normalized.length) {
      this.log.warn('No valid simulated devices configured. Add at least one device in Homebridge UI.');
      return;
    }

    this.store.setActiveDevices(normalized.map(device => device.id));\n\n    const sample = () => {
      const now = Date.now();
      for (const device of normalized) {
        this.store.recordPower(device.id, device.powerW, now, device);
      }
      const summary = this.store.getSummary();
      const today = localDateKey(new Date(now));
      const totalTodayWh = summary.totals.daily[today] || 0;
      const currentPower = normalized.reduce((sum, device) => sum + device.powerW, 0);
      this.log.info('[SIMULATION] %s devices | combined: %s W | estimated today: %s Wh',
        normalized.length, currentPower.toFixed(1), totalTodayWh.toFixed(2));
      for (const device of normalized) {
        const saved = summary.devices[device.id];
        this.log.info('[SIMULATION] %s (%s): %s W | lifetime estimate: %s Wh',
          device.name, device.model, saved.powerW.toFixed(1), saved.energyWh.toFixed(2));
      }
    };

    sample();
    this.timer = setInterval(sample, interval * 1000);
    this.log.info('Prototype started in simulation mode. No physical Tapo devices are contacted.');
  }
}

function localDateKey(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

module.exports = { TapoEnergyMonitorPlatform };
