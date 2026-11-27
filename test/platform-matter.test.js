'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TapoEnergyMonitorPlatform } = require('../src/platform');

function makePlatform(config, matter) {
  const warnings = [];
  const registered = [];
  const log = { info() {}, warn(message) { warnings.push(message); }, error() {} };
  const api = {
    on() {},
    matter,
  };
  const platform = new TapoEnergyMonitorPlatform(log, config, api);
  return { platform, warnings, registered, api };
}

test('registers one Matter Electrical Meter when Matter is enabled', async () => {
  const registered = [];
  const matter = {
    uuid: { generate: value => 'uuid:' + value },
    deviceTypes: { ElectricalMeter: 'ElectricalMeterType' },
    registerPlatformAccessories: async (...args) => registered.push(args)
  };
  const { platform } = makePlatform({}, matter);
  await platform.registerMatterMeter();

  assert.equal(registered.length, 1);
  assert.equal(registered[0][0], 'homebridge-tapo-energy-monitor');
  assert.equal(registered[0][1], 'TapoEnergyMonitor');
  assert.equal(registered[0][2][0].displayName, 'Tapo Energy — Расчётная');
  assert.equal(registered[0][2][0].deviceType, 'ElectricalMeterType');
});

test('skips Matter export cleanly when Electrical Meter is unavailable', async () => {
  const { platform, warnings } = makePlatform({}, {
    uuid: { generate: value => 'uuid:' + value },
    deviceTypes: { ElectricalSensor: 'ElectricalSensorType' }
  });
  await platform.registerMatterMeter();
  assert.equal(platform.matterMeterUuid, null);
  assert.match(warnings[0], /Homebridge 2\.5\.0 or later/);
});

test('keeps the local platform usable when Matter registration fails', async () => {
  const warnings = [];
  const matter = {
    uuid: { generate: value => 'uuid:' + value },
    deviceTypes: { ElectricalMeter: 'ElectricalMeterType' },
    registerPlatformAccessories: async () => { throw new Error('Matter bridge unavailable'); }
  };
  const { platform } = makePlatform({}, matter);
  platform.log.warn = message => warnings.push(message);
  await assert.doesNotReject(() => platform.registerMatterMeter());
  assert.equal(platform.matterMeterUuid, null);
  assert.match(warnings[0], /local history will continue/);
});

test('allows Matter export to be disabled in plugin settings', async () => {
  const { platform, warnings } = makePlatform({ enableMatterMeter: false }, undefined);
  await platform.registerMatterMeter();
  assert.equal(platform.matterMeterUuid, null);
  assert.equal(warnings.length, 0);
});

test('does not start when simulation is not explicitly enabled', async () => {
  const { platform, warnings } = makePlatform({}, undefined);
  await platform.start();
  assert.equal(platform.store, null);
  assert.equal(platform.timer, null);
  assert.match(warnings[0], /Simulation is disabled/);
});

test('does not start simulation without an explicitly configured device', async () => {
  const { platform, warnings } = makePlatform({ simulationMode: true }, undefined);
  await platform.start();
  assert.equal(platform.store, null);
  assert.equal(platform.timer, null);
  assert.match(warnings[0], /No simulated devices configured/);
});

test('stores history only in the Homebridge storage directory', async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tapo-energy-homebridge-'));
  const { platform } = makePlatform({
    simulationMode: true,
    pollingIntervalSeconds: 3600,
    simulatedDevices: [{ id: 'test-device', name: 'Test device', model: 'P110M', powerW: 100 }]
  }, undefined);
  platform.api.user = { storagePath: () => storagePath };
  try {
    await platform.start();
    assert.equal(platform.store.directory, storagePath);
    assert.equal(fs.existsSync(path.join(storagePath, 'tapo-energy-history.json')), true);
    assert.ok(platform.timer);
  } finally {
    if (platform.timer) clearInterval(platform.timer);
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test('publishes the initial simulated sample to the registered Matter meter', async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tapo-energy-matter-'));
  const registrations = [];
  const updates = [];
  const matter = {
    uuid: { generate: value => 'uuid:' + value },
    deviceTypes: { ElectricalMeter: 'ElectricalMeterType' },
    clusterNames: {
      ElectricalPowerMeasurement: 'power-cluster',
      ElectricalEnergyMeasurement: 'energy-cluster'
    },
    registerPlatformAccessories: async (...args) => registrations.push(args),
    updateAccessoryState: async (...args) => updates.push(args)
  };
  const { platform } = makePlatform({
    simulationMode: true,
    pollingIntervalSeconds: 3600,
    simulatedDevices: [{ id: 'sim-p110m', name: 'P110M test', model: 'P110M', powerW: 150 }]
  }, matter);
  platform.api.user = { storagePath: () => storagePath };

  try {
    await platform.start();
    assert.equal(registrations.length, 1);
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0], ['uuid:tapo-energy-estimated-total', 'power-cluster', { activePower: 150000 }]);
    assert.deepEqual(updates[1], ['uuid:tapo-energy-estimated-total', 'energy-cluster', {
      cumulativeEnergyImported: { energy: 0 }
    }]);
  } finally {
    if (platform.timer) clearInterval(platform.timer);
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test('registers a separate real cloud energy meter for cloud mode', async () => {
  const registered = [];
  const unregistered = [];
  const matter = {
    uuid: { generate: value => 'uuid:' + value },
    deviceTypes: { ElectricalMeter: 'ElectricalMeterType' },
    unregisterPlatformAccessories: async (...args) => unregistered.push(args),
    registerPlatformAccessories: async (...args) => registered.push(args)
  };
  const { platform } = makePlatform({}, matter);
  platform.api.unregisterPlatformAccessories = async () => {
    throw new Error('HAP unregister API must not be used for Matter accessories');
  };
  await platform.registerCloudMatterMeter();

  assert.equal(unregistered.length, 1);
  assert.equal(unregistered[0][2][0].UUID, 'uuid:tapo-energy-estimated-total');
  assert.equal(registered.length, 1);
  const accessory = registered[0][2][0];
  assert.equal(accessory.UUID, 'uuid:tapo-energy-cloud-total');
  assert.equal(accessory.displayName, 'Tapo Energy — Облако (тест)');
  assert.equal(accessory.context.measurementSource, 'tapo_cloud');
  assert.deepEqual(accessory.clusters.electricalPowerMeasurement, { activePower: null });
  assert.ok(accessory.clusters.electricalEnergyMeasurement.cumulativeEnergyImported);
  assert.ok(accessory.clusters.electricalEnergyMeasurement.periodicEnergyImported);
  assert.equal(platform.cloudMatterMeterUuid, accessory.UUID);
  assert.equal(platform.matterMeterUuid, null);
});


test('keeps the previous estimated meter when cloud Matter registration fails', async () => {
  const unregistered = [];
  const matter = {
    uuid: { generate: value => 'uuid:' + value },
    deviceTypes: { ElectricalMeter: 'ElectricalMeterType' },
    unregisterPlatformAccessories: async (...args) => unregistered.push(args),
    registerPlatformAccessories: async () => { throw new Error('Matter bridge temporarily unavailable'); }
  };
  const { platform, warnings } = makePlatform({}, matter);
  await platform.registerCloudMatterMeter();

  assert.equal(unregistered.length, 0);
  assert.equal(platform.cloudMatterMeterUuid, null);
  assert.ok(platform.cloudMatterRegistrationRetryAt > Date.now());
  assert.match(warnings[0], /will retry after 5 minutes/);
});

test('reports Matter disabled explicitly without attempting accessory registration', async () => {
  const { platform, warnings } = makePlatform({}, undefined);
  await platform.registerCloudMatterMeter();

  assert.equal(platform.cloudMatterMeterUuid, null);
  assert.match(warnings[0], /Matter is not enabled/);
});

test('keeps a successful Matter update successful when readback independently fails', async () => {
  const warnings = [];
  const updates = [];
  const matter = {
    clusterNames: { ElectricalEnergyMeasurement: 'electricalEnergyMeasurement' },
    updateAccessoryState: async (...args) => updates.push(args),
    getAccessoryState: async () => { throw new Error('readback unavailable'); }
  };
  const { platform } = makePlatform({}, matter);
  platform.log.warn = message => warnings.push(message);
  platform.cloudMatterMeterUuid = 'cloud-meter-uuid';

  const result = await platform.publishCloudMatterReading({
    devices: { cloudA: { source: 'tapo_cloud', energyWh: 125.5 } }
  });

  assert.equal(result.cumulativeEnergyWh, 125.5);
  assert.equal(updates.length, 1);
  assert.equal(platform.cloudMatterLastReading.cumulativeEnergyWh, 125.5);
  assert.match(warnings[0], /MATTER CLOUD READBACK.*readback failed/);
  assert.equal(warnings.some(message => /Matter cloud energy update failed/.test(message)), false);
});


test('retries cloud Matter registration only when enabled and retry time has elapsed', async () => {
  const matter = {};
  const { platform } = makePlatform({ enableMatterMeter: false }, matter);
  let attempts = 0;
  platform.registerCloudMatterMeter = async () => { attempts += 1; };

  assert.equal(await platform.ensureCloudMatterMeterRegistration(), false);
  assert.equal(attempts, 0);

  platform.config.enableMatterMeter = true;
  platform.cloudMatterRegistrationRetryAt = Date.now() + 60000;
  assert.equal(await platform.ensureCloudMatterMeterRegistration(), false);
  assert.equal(attempts, 0);

  platform.cloudMatterRegistrationRetryAt = 0;
  platform.registerCloudMatterMeter = async () => {
    attempts += 1;
    platform.cloudMatterRegistrationRetryAt = Date.now() + 300000;
  };
  assert.equal(await platform.ensureCloudMatterMeterRegistration(), false);
  assert.equal(attempts, 1);
  assert.equal(await platform.ensureCloudMatterMeterRegistration(), false);
  assert.equal(attempts, 1);
});


test('restores the previous cumulative Matter reading after a plugin restart', async () => {
  const matter = {
    clusterNames: { ElectricalEnergyMeasurement: 'electricalEnergyMeasurement' },
    getAccessoryState: async (uuid, cluster) => {
      assert.equal(uuid, 'cloud-meter-uuid');
      assert.equal(cluster, 'electricalEnergyMeasurement');
      return { cumulativeEnergyImported: { energy: 125500, endTimestamp: 853315200 } };
    }
  };
  const { platform } = makePlatform({}, matter);
  platform.cloudMatterMeterUuid = 'cloud-meter-uuid';

  const restored = await platform.restoreCloudMatterLastReading();

  assert.deepEqual(restored, { cumulativeEnergyWh: 125.5, timestamp: 853315200 });
  assert.deepEqual(platform.cloudMatterLastReading, restored);
});

test('does not turn a fresh zero-valued Matter endpoint into a fake historical interval', async () => {
  const matter = {
    getAccessoryState: async () => ({
      cumulativeEnergyImported: { energy: 0, endTimestamp: 853315200 }
    })
  };
  const { platform } = makePlatform({}, matter);
  platform.cloudMatterMeterUuid = 'new-cloud-meter-uuid';

  assert.equal(await platform.restoreCloudMatterLastReading(), null);
  assert.equal(platform.cloudMatterLastReading, null);
});


test('keeps cloud operation available when Matter accessory construction throws', async () => {
  const matter = {
    uuid: { generate: () => { throw new Error('UUID service unavailable'); } },
    deviceTypes: { ElectricalMeter: 'ElectricalMeterType' },
    registerPlatformAccessories: async () => { throw new Error('must not be reached'); }
  };
  const { platform, warnings } = makePlatform({}, matter);

  await assert.doesNotReject(() => platform.registerCloudMatterMeter());
  assert.equal(platform.cloudMatterMeterUuid, null);
  assert.match(warnings[0], /UUID service unavailable/);
});
