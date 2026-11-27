'use strict';

const PLUGIN_IDENTIFIER = 'homebridge-tapo-energy-monitor';
const PLATFORM_NAME = 'TapoEnergyMonitor';
const METER_ID = 'tapo-energy-estimated-total';
const CLOUD_METER_ID = 'tapo-energy-cloud-total';

function createEstimatedMeterAccessory(api, displayName = 'Tapo Energy — Расчётная') {
  const matter = api && api.matter;
  // ElectricalMeter is a dedicated Matter 1.3+ device type exposed by Homebridge 2.5.0+.
  // Do not silently downgrade to ElectricalSensor: this prototype specifically tests
  // Apple's presentation of a meter rather than a generic electrical sensor.
  if (!matter || !matter.deviceTypes || !matter.deviceTypes.ElectricalMeter || !matter.uuid) {
    return null;
  }

  return {
    UUID: matter.uuid.generate(METER_ID),
    displayName,
    deviceType: matter.deviceTypes.ElectricalMeter,
    manufacturer: 'Tapo Energy Monitor',
    model: 'Virtual aggregate electrical meter',
    serialNumber: 'TAPO-ENERGY-ESTIMATED',
    context: { meterId: METER_ID, measurementSource: 'estimated' },
    clusters: {
      electricalPowerMeasurement: { activePower: 0 },
      electricalEnergyMeasurement: { cumulativeEnergyImported: { energy: 0 } }
    }
  };
}

async function updateEstimatedMeter(api, uuid, summary) {
  const matter = api && api.matter;
  if (!matter || !uuid || typeof matter.updateAccessoryState !== 'function') {
    return null;
  }

  const devices = Object.values((summary && summary.devices) || {});
  // Power is an instantaneous reading, so only currently active devices contribute.
  const activePowerW = devices
    .filter(device => device && device.active === true)
    .reduce((total, device) => total + (Number.isFinite(device.powerW) ? device.powerW : 0), 0);
  // Energy is cumulative history: retain contributions from inactive/removed devices.
  const cumulativeEnergyWh = devices
    .filter(device => device && Number.isFinite(device.energyWh) && device.energyWh >= 0)
    .reduce((total, device) => total + device.energyWh, 0);

  // Matter ElectricalPowerMeasurement uses mW; ElectricalEnergyMeasurement uses mWh.
  const powerCluster = matter.clusterNames?.ElectricalPowerMeasurement || 'electricalPowerMeasurement';
  const energyCluster = matter.clusterNames?.ElectricalEnergyMeasurement || 'electricalEnergyMeasurement';
  await matter.updateAccessoryState(uuid, powerCluster, { activePower: Math.round(activePowerW * 1000) });
  await matter.updateAccessoryState(uuid, energyCluster, {
    cumulativeEnergyImported: { energy: Math.round(cumulativeEnergyWh * 1000) }
  });

  return { activePowerW, cumulativeEnergyWh };
}

function createCloudEnergyMeterAccessory(api, displayName = 'Tapo Energy — Облако (тест)') {
  const matter = api && api.matter;
  if (!matter || !matter.deviceTypes || !matter.deviceTypes.ElectricalMeter || !matter.uuid) {
    return null;
  }

  return {
    UUID: matter.uuid.generate(CLOUD_METER_ID),
    displayName,
    deviceType: matter.deviceTypes.ElectricalMeter,
    manufacturer: 'Tapo Energy Monitor',
    model: 'P110M cloud energy history (test)',
    serialNumber: 'TAPO-ENERGY-CLOUD-TEST',
    context: { meterId: CLOUD_METER_ID, measurementSource: 'tapo_cloud', testBuild: true },
    // This test accessory publishes only verified imported energy. Current W is
    // deliberately omitted because the cloud power-history endpoints returned no samples.
    clusters: {
      electricalEnergyMeasurement: { cumulativeEnergyImported: { energy: 0 } }
    }
  };
}

async function updateCloudEnergyMeter(api, uuid, summary) {
  const matter = api && api.matter;
  if (!matter || !uuid || typeof matter.updateAccessoryState !== 'function') return null;

  const devices = Object.values((summary && summary.devices) || {});
  const cumulativeEnergyWh = devices
    .filter(device => device && device.source === 'tapo_cloud' &&
      Number.isFinite(device.energyWh) && device.energyWh >= 0)
    .reduce((total, device) => total + device.energyWh, 0);

  const energyCluster = matter.clusterNames?.ElectricalEnergyMeasurement || 'electricalEnergyMeasurement';
  await matter.updateAccessoryState(uuid, energyCluster, {
    cumulativeEnergyImported: { energy: Math.round(cumulativeEnergyWh * 1000) }
  });

  return { cumulativeEnergyWh };
}

module.exports = {
  PLUGIN_IDENTIFIER,
  PLATFORM_NAME,
  createEstimatedMeterAccessory,
  updateEstimatedMeter,
  createCloudEnergyMeterAccessory,
  updateCloudEnergyMeter
};
