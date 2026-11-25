'use strict';

const { TapoEnergyMonitorPlatform } = require('./src/platform');

module.exports = (api) => {
  api.registerPlatform('homebridge-tapo-energy-monitor', 'TapoEnergyMonitor', TapoEnergyMonitorPlatform);
};
