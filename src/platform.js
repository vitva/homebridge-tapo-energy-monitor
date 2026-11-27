'use strict';

const { EnergyStore } = require('./energy-store');
const { TapoCloudEnergyMonitor } = require('./tapo-cloud-monitor');
const {
  PLUGIN_IDENTIFIER,
  PLATFORM_NAME,
  createEstimatedMeterAccessory,
  updateEstimatedMeter
} = require('./matter-meter');

class TapoEnergyMonitorPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.timer = null;
    this.store = null;
    this.matterMeterUuid = null;

    api.on('didFinishLaunching', () => {
      this.start().catch(error => this.log.error('Could not start Tapo Energy Monitor: %s', error.message));
    });
    api.on('shutdown', () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    });
  }

  async start() {
    if (this.timer) return;
    if (this.config.simulationMode !== true) {
      const username = typeof this.config.tapoCloudUsername === 'string' ? this.config.tapoCloudUsername.trim() : '';
      const password = typeof this.config.tapoCloudPassword === 'string' ? this.config.tapoCloudPassword : '';
      if (username && password) {
        await this.startCloudMonitor(username, password);
      } else {
        this.log.warn('Simulation is disabled and Tapo Cloud credentials are not configured. No devices will be polled.');
      }
      return;
    }

    const configured = Array.isArray(this.config.simulatedDevices) ? this.config.simulatedDevices : [];
    if (!configured.length) {
      this.log.warn('No simulated devices configured. The platform remains idle until at least one device is added in Homebridge UI.');
      return;
    }

    const storageRoot = this.api.user.storagePath();
    this.store = new EnergyStore(storageRoot, this.log);

    const interval = Math.max(30, Math.min(3600, Number(this.config.pollingIntervalSeconds) || 60));
    const normalized = configured
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

    this.store.setActiveDevices(normalized.map(device => device.id));
    await this.registerMatterMeter();

    const sample = async () => {
      const now = Date.now();
      for (const device of normalized) {
        this.store.recordPower(device.id, device.powerW, now, device);
      }
      const summary = this.store.getSummary();
      const today = localDateKey(new Date(now));
      const totalTodayWh = summary.totals.daily[today] || 0;
      const currentPower = normalized.reduce((sum, device) => sum + device.powerW, 0);

      if (this.matterMeterUuid) {
        try {
          const meter = await updateEstimatedMeter(this.api, this.matterMeterUuid, summary);
          if (meter) {
            this.log.info('[MATTER SIMULATION] estimated meter: %s W | cumulative estimate: %s Wh',
              meter.activePowerW.toFixed(1), meter.cumulativeEnergyWh.toFixed(2));
          }
        } catch (error) {
          this.log.warn('Matter energy update failed; local history will continue: %s', error.message);
        }
      }

      this.log.info('[SIMULATION] %s devices | combined: %s W | estimated today: %s Wh',
        normalized.length, currentPower.toFixed(1), totalTodayWh.toFixed(2));
      for (const device of normalized) {
        const saved = summary.devices[device.id];
        this.log.info('[SIMULATION] %s (%s): %s W | lifetime estimate: %s Wh',
          device.name, device.model, saved.powerW.toFixed(1), saved.energyWh.toFixed(2));
      }
    };

    await sample();
    this.timer = setInterval(() => {
      sample().catch(error => this.log.error('Energy sample failed: %s', error.message));
    }, interval * 1000);
    this.log.info('Prototype started in simulation mode. No physical Tapo devices are contacted.');
  }

  async startCloudMonitor(username, password) {
    const storageRoot = this.api.user.storagePath();
    this.store = new EnergyStore(storageRoot, this.log);
    this.cloudMonitor = new TapoCloudEnergyMonitor({ username, password, log: this.log });
    const configuredInterval = Number(this.config.pollingIntervalSeconds) || 900;
    const interval = Math.max(300, Math.min(3600, configuredInterval));
    const poll = async () => {
      try {
        const result = await this.cloudMonitor.poll(this.store);
        this.log.info('[TAPO CLOUD] %s P110M devices found; %s histories updated.',
          result.deviceCount, result.importedDevices);
      } catch (error) {
        this.log.error('Tapo Cloud energy history update failed: %s', error.message);
      }
    };
    await poll();
    this.timer = setInterval(poll, interval * 1000);
    this.log.info('Tapo Cloud daily energy history polling started (every %s seconds).', interval);
  }

  async registerMatterMeter() {
    if (this.config.enableMatterMeter === false) return;

    const accessory = createEstimatedMeterAccessory(this.api, this.config.matterMeterName || 'Tapo Energy — Расчётная');
    if (!accessory) {
      this.log.warn('Matter meter not registered. Enable Matter on this Homebridge bridge and use Homebridge 2.5.0 or later for Electrical Meter support.');
      return;
    }

    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, [accessory]);
      this.matterMeterUuid = accessory.UUID;
      this.log.info('Matter virtual energy sensor registered: %s', accessory.displayName);
    } catch (error) {
      this.log.warn('Matter sensor registration failed; local history will continue: %s', error.message);
    }
  }
}

function localDateKey(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

module.exports = { TapoEnergyMonitorPlatform };
