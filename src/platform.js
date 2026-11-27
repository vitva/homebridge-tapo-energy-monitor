'use strict';

const { EnergyStore } = require('./energy-store');
const { TapoCloudEnergyMonitor } = require('./tapo-cloud-monitor');
const { getStableTapoTermId } = require('./tapo-cloud-identity');
const {
  PLUGIN_IDENTIFIER,
  PLATFORM_NAME,
  createEstimatedMeterAccessory,
  updateEstimatedMeter,
  createCloudEnergyMeterAccessory,
  updateCloudEnergyMeter
} = require('./matter-meter');

async function waitForMatterClusterState(matter, uuid, cluster, predicate = () => true) {
  if (typeof matter?.getAccessoryState !== 'function') return undefined;

  // Homebridge's Matter API dispatches updateAccessoryState asynchronously.
  // Its returned promise confirms event dispatch, not completion of the
  // Matter.js endpoint transaction. Poll the actual state before diagnosing
  // the endpoint as missing or reporting an update as unapplied.
  const attempts = 20;
  const intervalMs = 50;
  let state;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = await matter.getAccessoryState(uuid, cluster);
    if (state !== undefined && predicate(state)) return state;
    if (attempt + 1 < attempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  return state;
}

class TapoEnergyMonitorPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.timer = null;
    this.store = null;
    this.matterMeterUuid = null;
    this.cloudMatterMeterUuid = null;
    this.cloudMatterLastReading = null;
    this.cloudMatterRegistrationRetryAt = 0;

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
    this.cloudMonitor = new TapoCloudEnergyMonitor({
      username, password, log: this.log,
      termId: getStableTapoTermId(storageRoot)
    });
    await this.registerCloudMatterMeter();
    const configuredInterval = Number(this.config.pollingIntervalSeconds) || 900;
    const interval = Math.max(300, Math.min(3600, configuredInterval));
    const poll = async () => {
      try {
        // Retry endpoint registration independently of cloud polling: a temporary
        // TP-Link outage must not prevent recovery of the Matter endpoint.
        await this.ensureCloudMatterMeterRegistration();
        const result = await this.cloudMonitor.poll(this.store);
        if (this.cloudMatterMeterUuid) {
          await this.publishCloudMatterReading(this.store.getSummary());
        }
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

  async ensureCloudMatterMeterRegistration() {
    if (this.config.enableMatterMeter === false || this.cloudMatterMeterUuid ||
      !this.api?.matter || Date.now() < this.cloudMatterRegistrationRetryAt) {
      return false;
    }

    await this.registerCloudMatterMeter();
    return Boolean(this.cloudMatterMeterUuid);
  }

  async registerCloudMatterMeter() {
    if (this.config.enableMatterMeter === false) return;

    const matter = this.api && this.api.matter;
    if (!matter || typeof matter.registerPlatformAccessories !== 'function') {
      this.log.warn('Cloud Matter meter not registered: Matter is not enabled for this Homebridge bridge. Cloud history will continue without a Matter endpoint.');
      return;
    }

    try {
      const accessory = createCloudEnergyMeterAccessory(this.api, this.config.cloudMatterMeterName || 'Tapo Energy — Облако (тест)');
      if (!accessory) {
        this.cloudMatterRegistrationRetryAt = Number.MAX_SAFE_INTEGER;
        this.log.warn('Cloud Matter meter not registered. Homebridge 2.5.0 or later with Electrical Meter support is required.');
        return;
      }

      // Homebridge resolves this promise only after the endpoint is registered and ready
      // for updates. Restored Matter accessories must be registered again on every start.
      await matter.registerPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, [accessory]);
      this.cloudMatterMeterUuid = accessory.UUID;
      this.cloudMatterRegistrationRetryAt = 0;
      const restored = await this.restoreCloudMatterLastReading();
      if (restored === undefined) {
        throw new Error('Homebridge accepted the registration request but the Matter energy endpoint/cluster is not available.');
      }
      this.log.info('[MATTER CLOUD REGISTERED] %s | %s', accessory.UUID, accessory.displayName);

      // Do not remove the old simulation meter until the cloud endpoint is safely registered.
      if (typeof matter.unregisterPlatformAccessories === 'function') {
        const previousEstimated = createEstimatedMeterAccessory(this.api, this.config.matterMeterName || 'Tapo Energy — Расчётная');
        if (previousEstimated) {
          try {
            await matter.unregisterPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, [previousEstimated]);
            this.log.info('Removed the previous estimated Matter meter from cloud mode.');
          } catch (error) {
            this.log.warn('Could not remove the previous estimated Matter meter: %s', error.message);
          }
        }
      }
    } catch (error) {
      this.cloudMatterMeterUuid = null;
      this.cloudMatterRegistrationRetryAt = Date.now() + 300000;
      this.log.warn('Cloud Matter meter registration failed; will retry after 5 minutes. Cloud history will continue: %s', error.message);
    }
  }

  async restoreCloudMatterLastReading() {
    const matter = this.api && this.api.matter;
    if (!this.cloudMatterMeterUuid) return null;
    if (typeof matter?.getAccessoryState !== 'function') return undefined;

    try {
      const energyCluster = matter.clusterNames?.ElectricalEnergyMeasurement || 'electricalEnergyMeasurement';
      const state = await waitForMatterClusterState(matter, this.cloudMatterMeterUuid, energyCluster);
      if (state === undefined) {
        this.log.warn('[MATTER CLOUD RESTORE] %s | Matter endpoint/cluster state is unavailable after registration; cached reading cannot be restored',
          this.cloudMatterMeterUuid);
        return undefined;
      }
      const imported = state.cumulativeEnergyImported;
      const energyMWh = Number(imported?.energy);
      const timestamp = Number(imported?.endTimestamp);

      // A freshly created endpoint starts at zero. Restore only a real, positive
      // cached cumulative value; otherwise the first cloud poll must not fabricate
      // a periodic interval from the entire imported history.
      if (Number.isFinite(energyMWh) && energyMWh > 0 &&
        Number.isFinite(timestamp) && timestamp > 0) {
        this.cloudMatterLastReading = {
          cumulativeEnergyWh: energyMWh / 1000,
          timestamp
        };
        this.log.info('[MATTER CLOUD RESTORE] %s | cumulative %s Wh | Matter timestamp %s',
          this.cloudMatterMeterUuid, this.cloudMatterLastReading.cumulativeEnergyWh.toFixed(3), timestamp);
        return this.cloudMatterLastReading;
      }

      this.log.info('[MATTER CLOUD RESTORE] %s | no previous positive cumulative reading in Matter cache',
        this.cloudMatterMeterUuid);
      return null;
    } catch (error) {
      this.log.warn('[MATTER CLOUD RESTORE] %s | could not restore previous reading: %s',
        this.cloudMatterMeterUuid, error.message);
      return null;
    }
  }

  async publishCloudMatterReading(summary) {
    if (!this.cloudMatterMeterUuid) return null;

    let meter;
    try {
      meter = await updateCloudEnergyMeter(
        this.api,
        this.cloudMatterMeterUuid,
        summary,
        this.cloudMatterLastReading
      );
    } catch (error) {
      this.log.warn('Matter cloud energy update failed; cloud history will continue: %s', error.message);
      return null;
    }

    if (!meter) return null;

    this.cloudMatterLastReading = {
      cumulativeEnergyWh: meter.cumulativeEnergyWh,
      timestamp: meter.timestamp
    };
    this.log.info('[MATTER CLOUD TEST] cumulative imported: %s Wh | periodic: %s Wh',
      meter.cumulativeEnergyWh.toFixed(2), meter.periodicEnergyWh.toFixed(2));

    // Keep readback diagnostics independent: a failed readback must not misreport
    // a successful state update as a failed Matter publication.
    const matter = this.api && this.api.matter;
    if (typeof matter?.getAccessoryState === 'function') {
      try {
        const energyCluster = matter.clusterNames?.ElectricalEnergyMeasurement || 'electricalEnergyMeasurement';
        const expectedEnergyMWh = Math.round(meter.cumulativeEnergyWh * 1000);
        const state = await waitForMatterClusterState(
          matter,
          this.cloudMatterMeterUuid,
          energyCluster,
          value => Number(value?.cumulativeEnergyImported?.energy) === expectedEnergyMWh
        );
        if (state === undefined) {
          this.log.warn('[MATTER CLOUD READBACK] %s | no readable energy cluster state after waiting for Matter update dispatch',
            this.cloudMatterMeterUuid);
        } else {
          const actualEnergyMWh = Number(state.cumulativeEnergyImported?.energy);
          const serialized = JSON.stringify(state, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value);
          if (actualEnergyMWh !== expectedEnergyMWh) {
            this.log.warn('[MATTER CLOUD READBACK] %s | state did not converge: expected %s mWh, got %s | %s',
              this.cloudMatterMeterUuid, expectedEnergyMWh, actualEnergyMWh, serialized);
          } else {
            this.log.info('[MATTER CLOUD READBACK] %s | %s', this.cloudMatterMeterUuid, serialized);
          }
        }
      } catch (error) {
        this.log.warn('[MATTER CLOUD READBACK] %s | readback failed: %s',
          this.cloudMatterMeterUuid, error.message);
      }
    } else {
      this.log.warn('[MATTER CLOUD READBACK] getAccessoryState is unavailable in this Homebridge Matter API.');
    }

    return meter;
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
