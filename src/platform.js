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
      this.log.warn('Simulation is disabled, but real Tapo communication is not implemented in this prototype. No devices will be polled.');
      return;
    }

    const storageRoot = this.config.dataDirectory && this.config.dataDirectory.trim()
      ? path.resolve(this.config.dataDirectory.trim())
      : this.api.user.storagePath();
    this.store = new EnergyStore(storageRoot, this.log);

    const interval = Math.max(30, Math.min(3600, Number(this.config.pollingIntervalSeconds) || 60));
    const powerW = Math.max(0, Number(this.config.simulatedPowerW) || 450);
    const sample = () => {
      this.store.recordPower('demo-p110m', powerW);
      const summary = this.store.getSummary();
      const today = new Date().toISOString().slice(0, 10);
      const todayWh = summary.totals.daily[today] || 0;
      this.log.info('[SIMULATION] demo-p110m: %s W; today: %s Wh', powerW.toFixed(1), todayWh.toFixed(2));
    };

    sample();
    this.timer = setInterval(sample, interval * 1000);
    this.log.info('Prototype started in simulation mode. No physical Tapo devices are contacted.');
  }
}

module.exports = { TapoEnergyMonitorPlatform };
