'use strict';

const PLUGIN_IDENTIFIER = 'homebridge-tapo-energy-monitor';
const PLATFORM_NAME = 'TapoEnergyMonitor';
const METER_ID = 'tapo-energy-estimated-total';

function createEstimatedMeterAccessory(api, displayName = 'Tapo Energy — Расчётная') {
  const matter = api && api.matter;
  if (!matter || !matter.deviceTypes || !matter.deviceTypes.ElectricalSensor || !matter.uuid) {
    return null;
  }

  return {
    UUID: matter.uuid.generate(METER_ID),
    displayName,
    deviceType: matter.deviceTypes.ElectricalSensor,
    manufacturer: 'Tapo Energy Monitor',
    model: 'Virtual aggregate energy sensor',
    serialNumber: 'TAPO-ENERGY-ESTIMATED',
    context: { meterId: METER_ID, measurementSource: 'estimated' },
    clusters: {
      electricalPowerMeasurement: {
        activePower: 0
      },
      electricalEnergyMeasurement: {
        cumulativeEnergyImported: { energy: 0 }
      }
    }
  };
}

async function updateEstimatedMeter(api, uuid, summary) {
  const matter = api && api.matter;
  if (!matter || !uuid || typeof matter.updateAccessoryState !== 'function') {
    return null;
  }

  const devices = Object.values((summary && summary.devices) || {});
  const activePowerW = devices
    .filter(device => device && device.active === true)
    .reduce((total, device) => total + (Number.isFinite(device.powerW) ? device.powerW : 0), 0);
  const cumulativeEnergyWh = devices
    .reduce((total, device) => total + (Number.isFinite(device.energyWh) ? device.energyWh : 0), 0);

  // Matter ElectricalPowerMeasurement uses mW; ElectricalEnergyMeasurement uses mWh.
  await matter.updateAccessoryState(uuid, 'electricalPowerMeasurement', {
    activePower: Math.round(activePowerW * 1000)
  });
  await matter.updateAccessoryState(uuid, 'electricalEnergyMeasurement', {
    cumulativeEnergyImported: { energy: Math.round(cumulativeEnergyWh * 1000) }
  });

  return { activePowerW, cumulativeEnergyWh };
}

module.exports = {
  PLUGIN_IDENTIFIER,
  PLATFORM_NAME,
  createEstimatedMeterAccessory,
  updateEstimatedMeter
};
