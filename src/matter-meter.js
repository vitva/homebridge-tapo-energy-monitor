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
    // ElectricalMeter requires both power and energy measurement clusters.
    // Tapo Cloud does not provide a trustworthy live-power sample, so null is
    // the Matter-defined "no reading available" value, not a fabricated zero.
    // Keep both imported-energy features declared at registration time.
    clusters: {
      electricalPowerMeasurement: { activePower: null },
      electricalEnergyMeasurement: {
        cumulativeEnergyImported: { energy: 0 },
        periodicEnergyImported: { energy: 0 }
      }
    }
  };
}

async function updateCloudPowerMeter(api, uuid, summary, nowMs = Date.now()) {
  const matter = api && api.matter;
  if (!matter || !uuid || typeof matter.updateAccessoryState !== 'function') return null;
  const devices = Object.values((summary && summary.devices) || {})
    .filter(device => device && device.source === 'tapo_cloud' && device.active !== false);
  const allReadingsFresh = devices.length > 0 && devices.every(device =>
    Number.isFinite(device.powerW) && Number.isFinite(device.powerUpdatedAt) &&
    nowMs >= device.powerUpdatedAt && nowMs - device.powerUpdatedAt <= 90_000
  );
  const activePowerW = allReadingsFresh ? devices.reduce((total, device) => total + device.powerW, 0) : null;
  const powerCluster = matter.clusterNames?.ElectricalPowerMeasurement || 'electricalPowerMeasurement';
  await matter.updateAccessoryState(uuid, powerCluster, {
    activePower: activePowerW === null ? null : Math.round(activePowerW * 1000)
  });
  return { activePowerW };
}

async function updateCloudEnergyMeter(api, uuid, summary, previousReading = null, nowMs = Date.now()) {
  const matter = api && api.matter;
  if (!matter || !uuid || typeof matter.updateAccessoryState !== 'function') return null;

  const devices = Object.values((summary && summary.devices) || {});
  const cumulativeEnergyWh = devices
    .filter(device => device && device.source === 'tapo_cloud' &&
      Number.isFinite(device.energyWh) && device.energyWh >= 0)
    .reduce((total, device) => total + device.energyWh, 0);

  const timestamp = Math.floor(nowMs / 1000);
  const hasPrevious = previousReading &&
    Number.isFinite(previousReading.cumulativeEnergyWh) &&
    Number.isFinite(previousReading.timestamp);
  const periodicEnergyWh = hasPrevious
    ? Math.max(0, cumulativeEnergyWh - previousReading.cumulativeEnergyWh)
    : 0;
  const startTimestamp = hasPrevious && previousReading.timestamp < timestamp
    ? previousReading.timestamp
    : Math.max(0, timestamp - 1);

  const energyCluster = matter.clusterNames?.ElectricalEnergyMeasurement || 'electricalEnergyMeasurement';
  await matter.updateAccessoryState(uuid, energyCluster, {
    cumulativeEnergyImported: { energy: Math.round(cumulativeEnergyWh * 1000) },
    periodicEnergyImported: {
      energy: Math.round(periodicEnergyWh * 1000),
      startTimestamp,
      endTimestamp: timestamp
    }
  });

  return { cumulativeEnergyWh, periodicEnergyWh, timestamp };
}

module.exports = {
  PLUGIN_IDENTIFIER,
  PLATFORM_NAME,
  createEstimatedMeterAccessory,
  updateEstimatedMeter,
  createCloudEnergyMeterAccessory,
  updateCloudEnergyMeter,
  updateCloudPowerMeter
};
