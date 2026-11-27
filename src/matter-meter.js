'use strict';

const PLUGIN_IDENTIFIER = 'homebridge-tapo-energy-monitor';
const PLATFORM_NAME = 'TapoEnergyMonitor';
const METER_ID = 'tapo-energy-estimated-total';
const CLOUD_METER_ID = 'tapo-energy-cloud-total';
// Matter ElectricalEnergyMeasurement epoch-s is validated as Unix seconds by Matter.js.
const MIN_MATTER_EPOCH_SECONDS = 946684800;

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

  const timestamp = Math.floor(Date.now() / 1000);

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
        cumulativeEnergyImported: { energy: 0, endTimestamp: timestamp },
        periodicEnergyImported: null
      }
    }
  };
}

function getDateKeyInTimeZone(timestampMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

function getStartOfDayTimestamp(dateKey, timeZone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const targetLocalAsUtc = Date.UTC(year, month - 1, day);
  let guess = targetLocalAsUtc;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });

  // Convert local midnight to UTC without assuming the Homebridge host timezone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
    const representedAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    const adjustment = targetLocalAsUtc - representedAsUtc;
    if (adjustment === 0) break;
    guess += adjustment;
  }
  return Math.floor(guess / 1000);
}

async function updateCloudEnergyMeter(api, uuid, summary, _previousReading = null, nowMs = Date.now()) {
  const matter = api && api.matter;
  if (!matter || !uuid || typeof matter.updateAccessoryState !== 'function') return null;

  const devices = Object.values((summary && summary.devices) || {});
  const cloudDevices = devices.filter(device => device && device.source === 'tapo_cloud' &&
    device.active !== false && Number.isFinite(device.energyWh) && device.energyWh >= 0);
  const cumulativeEnergyWh = cloudDevices.reduce((total, device) => total + device.energyWh, 0);

  const timestamp = Math.floor(nowMs / 1000);
  if (timestamp < MIN_MATTER_EPOCH_SECONDS) {
    throw new RangeError('Matter energy timestamps must be Unix epoch seconds on or after 2000-01-01T00:00:00Z.');
  }

  // Publish the authoritative current-month cloud total as periodic imported
  // energy. Daily history can be stale or incomplete, while the monthly endpoint
  // remains the authoritative source for the current month.
  const timeZone = cloudDevices.find(device => typeof device.timeZone === 'string')?.timeZone || 'UTC';
  const dateKey = getDateKeyInTimeZone(nowMs, timeZone);
  const periodKey = dateKey.slice(0, 7);
  const periodStartDateKey = periodKey + '-01';
  const hasCompleteMonthlyReading = cloudDevices.length > 0 &&
    cloudDevices.every(device => Number.isFinite(device.energyByMonth?.[periodKey]) && device.energyByMonth[periodKey] >= 0);
  const periodicEnergyWh = hasCompleteMonthlyReading
    ? cloudDevices.reduce((total, device) => total + device.energyByMonth[periodKey], 0)
    : null;
  const startTimestamp = getStartOfDayTimestamp(periodStartDateKey, timeZone);

  const energyCluster = matter.clusterNames?.ElectricalEnergyMeasurement || 'electricalEnergyMeasurement';
  await matter.updateAccessoryState(uuid, energyCluster, {
    cumulativeEnergyImported: {
      energy: Math.round(cumulativeEnergyWh * 1000),
      endTimestamp: timestamp
    },
    periodicEnergyImported: periodicEnergyWh === null ? null : {
      energy: Math.round(periodicEnergyWh * 1000),
      startTimestamp,
      endTimestamp: timestamp
    }
  });

  return { cumulativeEnergyWh, periodicEnergyWh, timestamp, dateKey, periodKey, timeZone };
}

module.exports = {
  PLUGIN_IDENTIFIER,
  PLATFORM_NAME,
  createEstimatedMeterAccessory,
  updateEstimatedMeter,
  createCloudEnergyMeterAccessory,
  updateCloudEnergyMeter
};
