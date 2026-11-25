'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEstimatedMeterAccessory, updateEstimatedMeter } = require('../src/matter-meter');

function mockApi() {
  const updates = [];
  return {
    updates,
    api: {
      matter: {
        uuid: { generate: value => 'uuid:' + value },
        deviceTypes: { ElectricalSensor: 'ElectricalSensorType' },
        updateAccessoryState: async (...args) => updates.push(args)
      }
    }
  };
}

test('creates a stable Matter Electrical Sensor with separate estimated identity', () => {
  const { api } = mockApi();
  const accessory = createEstimatedMeterAccessory(api);
  assert.equal(accessory.UUID, 'uuid:tapo-energy-estimated-total');
  assert.equal(accessory.deviceType, 'ElectricalSensorType');
  assert.equal(accessory.context.measurementSource, 'estimated');
  assert.equal(accessory.clusters.electricalPowerMeasurement.activePower, 0);
  assert.deepEqual(accessory.clusters.electricalEnergyMeasurement.cumulativeEnergyImported, { energy: 0 });
});

test('does not create a Matter accessory when Matter is unavailable', () => {
  assert.equal(createEstimatedMeterAccessory({}), null);
});

test('publishes active watts and lifetime estimated Wh in Matter units', async () => {
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
