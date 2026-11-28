'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEstimatedMeterAccessory, updateEstimatedMeter, createCloudEnergyMeterAccessory, createCloudEnergySensorAccessory, updateCloudEnergyMeter } = require('../src/matter-meter');

function mockApi() {
  const updates = [];
  return {
    updates,
    api: {
      matter: {
        uuid: { generate: value => 'uuid:' + value },
        deviceTypes: { ElectricalMeter: 'ElectricalMeterType' },
        updateAccessoryState: async (...args) => updates.push(args)
      }
    }
  };
}

test('creates a stable Matter Electrical Meter with separate estimated identity', () => {
  const { api } = mockApi();
  const accessory = createEstimatedMeterAccessory(api);
  assert.equal(accessory.UUID, 'uuid:tapo-energy-estimated-total');
  assert.equal(accessory.deviceType, 'ElectricalMeterType');
  assert.equal(accessory.context.measurementSource, 'estimated');
  assert.equal(accessory.clusters.electricalPowerMeasurement.activePower, 0);
  assert.deepEqual(accessory.clusters.electricalEnergyMeasurement.cumulativeEnergyImported, { energy: 0 });
});

test('does not silently fall back to Electrical Sensor when Electrical Meter is unavailable', () => {
  assert.equal(createEstimatedMeterAccessory({
    matter: {
      uuid: { generate: value => value },
      deviceTypes: { ElectricalSensor: 'ElectricalSensorType' }
    }
  }), null);
});

test('does not create a Matter accessory when Matter is unavailable', () => {
  assert.equal(createEstimatedMeterAccessory({}), null);
});

test('publishes active watts and cumulative Wh including inactive device history in Matter units', async () => {
  const { api, updates } = mockApi();
  const result = await updateEstimatedMeter(api, 'meter-uuid', {
    devices: {
      activeA: { active: true, powerW: 125.5, energyWh: 450 },
      activeB: { active: true, powerW: 74.5, energyWh: 250 },
      archived: { active: false, powerW: 900, energyWh: 100 }
    }
  });

  assert.deepEqual(result, { activePowerW: 200, cumulativeEnergyWh: 800 });
  assert.deepEqual(updates, [
    ['meter-uuid', 'electricalPowerMeasurement', { activePower: 200000 }],
    ['meter-uuid', 'electricalEnergyMeasurement', { cumulativeEnergyImported: { energy: 800000 } }]
  ]);
});

test('creates a distinct cloud Electrical Meter with required power cluster and no fabricated live reading', () => {
  const { api } = mockApi();
  const accessory = createCloudEnergyMeterAccessory(api);
  assert.equal(accessory.UUID, 'uuid:tapo-energy-cloud-total');
  assert.equal(accessory.displayName, 'Tapo Energy — Облако (тест)');
  assert.equal(accessory.deviceType, 'ElectricalMeterType');
  assert.equal(accessory.context.measurementSource, 'tapo_cloud');
  assert.equal(accessory.context.testBuild, true);
  assert.deepEqual(accessory.clusters.electricalPowerMeasurement, { activePower: null });
  assert.equal(accessory.clusters.electricalEnergyMeasurement.cumulativeEnergyImported.energy, 0);
  assert.ok(Number.isInteger(accessory.clusters.electricalEnergyMeasurement.cumulativeEnergyImported.endTimestamp));
  assert.equal(accessory.clusters.electricalEnergyMeasurement.periodicEnergyImported.energy, 0);
  assert.ok(Number.isInteger(accessory.clusters.electricalEnergyMeasurement.periodicEnergyImported.startTimestamp));
  assert.ok(Number.isInteger(accessory.clusters.electricalEnergyMeasurement.periodicEnergyImported.endTimestamp));
});

test('publishes only real cloud imported Wh as Matter mWh and excludes estimates', async () => {
  const { api, updates } = mockApi();
  const result = await updateCloudEnergyMeter(api, 'cloud-meter-uuid', {
    devices: {
      cloudA: { source: 'tapo_cloud', energyWh: 604.574 },
      cloudB: { source: 'tapo_cloud', energyWh: 125.426 },
      simulated: { source: 'simulation', energyWh: 99999 },
      malformed: { source: 'tapo_cloud', energyWh: NaN }
    }
  }, null, 1_800_000_000_000);

  assert.deepEqual(result, {
    cumulativeEnergyWh: 730,
    periodicEnergyWh: null,
    timestamp: 1800000000,
    dateKey: '2027-01-15',
    periodKey: '2027-01',
    timeZone: 'UTC'
  });
  assert.deepEqual(updates, [
    ['cloud-meter-uuid', 'electricalEnergyMeasurement', {
      cumulativeEnergyImported: { energy: 730000, endTimestamp: 1800000000 },
      periodicEnergyImported: null
    }]
  ]);
});


test('uses Unix epoch seconds required by the Matter.js epoch-s validator', async () => {
  const { api, updates } = mockApi();
  const result = await updateCloudEnergyMeter(api, 'cloud-meter-uuid', {
    devices: { cloudA: { source: 'tapo_cloud', energyWh: 1 } }
  }, null, 1_800_000_000_000);

  assert.equal(result.timestamp, 1800000000);
  assert.equal(updates[0][2].cumulativeEnergyImported.endTimestamp, 1800000000);
  assert.ok(updates[0][2].cumulativeEnergyImported.endTimestamp >= 946684800);
  assert.equal(updates[0][2].periodicEnergyImported, null);
});

test('rejects Matter timestamps before the supported Unix epoch minimum', async () => {
  const { api, updates } = mockApi();
  await assert.rejects(
    () => updateCloudEnergyMeter(api, 'cloud-meter-uuid', {
      devices: { cloudA: { source: 'tapo_cloud', energyWh: 1 } }
    }, null, 946684799000),
    /Unix epoch seconds/
  );
  assert.equal(updates.length, 0);
});

test('publishes the verified current-month cloud bucket as periodic imported energy', async () => {
  const { api, updates } = mockApi();
  const nowMs = Date.UTC(2027, 0, 15, 8, 0, 0);
  const result = await updateCloudEnergyMeter(api, 'cloud-meter-uuid', {
    devices: {
      cloudA: {
        source: 'tapo_cloud', active: true, energyWh: 735.25, timeZone: 'UTC',
        energyByMonth: { '2027-01': 5.25 }
      },
      cloudB: {
        source: 'tapo_cloud', active: true, energyWh: 100, timeZone: 'UTC',
        energyByMonth: { '2027-01': 2.75 }
      }
    }
  }, { cumulativeEnergyWh: 700, timestamp: 1799990000 }, nowMs);

  assert.deepEqual(result, {
    cumulativeEnergyWh: 835.25,
    periodicEnergyWh: 8,
    timestamp: 1800000000,
    dateKey: '2027-01-15',
    periodKey: '2027-01',
    timeZone: 'UTC'
  });
  assert.deepEqual(updates[0][2], {
    cumulativeEnergyImported: { energy: 835250, endTimestamp: 1800000000 },
    periodicEnergyImported: {
      energy: 8000,
      startTimestamp: Date.UTC(2027, 0, 1) / 1000,
      endTimestamp: 1800000000
    }
  });
});

test('does not publish a fabricated monthly value when any active cloud device has no verified bucket', async () => {
  const { api, updates } = mockApi();
  const nowMs = Date.UTC(2027, 0, 15, 8, 0, 0);
  const result = await updateCloudEnergyMeter(api, 'cloud-meter-uuid', {
    devices: {
      cloudA: {
        source: 'tapo_cloud', active: true, energyWh: 735.25, timeZone: 'UTC',
        energyByMonth: { '2027-01': 5.25 }
      },
      cloudB: {
        source: 'tapo_cloud', active: true, energyWh: 100, timeZone: 'UTC',
        energyByMonth: {}
      }
    }
  }, null, nowMs);

  assert.equal(result.periodicEnergyWh, null);
  assert.equal(updates[0][2].periodicEnergyImported, null);
});

test('uses the device timezone when calculating the current-month period start', async () => {
  const { api, updates } = mockApi();
  const nowMs = Date.UTC(2027, 0, 15, 8, 0, 0);
  const result = await updateCloudEnergyMeter(api, 'cloud-meter-uuid', {
    devices: {
      cloudA: {
        source: 'tapo_cloud', active: true, energyWh: 10, timeZone: 'Europe/Moscow',
        energyByMonth: { '2027-01': 10 }
      }
    }
  }, null, nowMs);

  assert.equal(result.dateKey, '2027-01-15');
  assert.equal(result.periodicEnergyWh, 10);
  assert.equal(updates[0][2].periodicEnergyImported.startTimestamp, Date.UTC(2026, 11, 31, 21, 0, 0) / 1000);
});
test('does not derive periodic usage from cumulative corrections when monthly history is unavailable', async () => {
  const { api, updates } = mockApi();
  const result = await updateCloudEnergyMeter(api, 'cloud-meter-uuid', {
    devices: { cloudA: { source: 'tapo_cloud', active: true, energyWh: 700, timeZone: 'UTC' } }
  }, { cumulativeEnergyWh: 730, timestamp: 1800000000 }, 1_800_000_900_000);

  assert.equal(result.periodicEnergyWh, null);
  assert.equal(updates[0][2].periodicEnergyImported, null);
});


test('creates an isolated Matter ElectricalSensor comparison accessory for cloud energy', () => {
  const { api } = mockApi();
  api.matter.deviceTypes.ElectricalSensor = 'ElectricalSensorType';
  const accessory = createCloudEnergySensorAccessory(api);
  assert.equal(accessory.UUID, 'uuid:tapo-energy-cloud-sensor-test');
  assert.equal(accessory.deviceType, 'ElectricalSensorType');
  assert.equal(accessory.context.measurementSource, 'tapo_cloud');
  assert.equal(accessory.context.testBuild, true);
  assert.equal(accessory.clusters.electricalPowerMeasurement.activePower, null);
  assert.equal(accessory.clusters.electricalEnergyMeasurement.cumulativeEnergyImported.energy, 0);
  assert.equal(accessory.clusters.electricalEnergyMeasurement.periodicEnergyImported.energy, 0);
});
