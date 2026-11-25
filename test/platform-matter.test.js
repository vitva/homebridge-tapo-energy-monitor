'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

test('registers one Matter Electrical Sensor when Matter is enabled', async () => {
  const registered = [];
  const matter = {
    uuid: { generate: value => 'uuid:' + value },
    deviceTypes: { ElectricalSensor: 'ElectricalSensorType' },
    registerPlatformAccessories: async (...args) => registered.push(args)
  };
  const { platform } = makePlatform({}, matter);
  await platform.registerMatterMeter();

  assert.equal(registered.length, 1);
  assert.equal(registered[0][0], 'homebridge-tapo-energy-monitor');
  assert.equal(registered[0][1], 'TapoEnergyMonitor');
  assert.equal(registered[0][2][0].displayName, 'Tapo Energy — Расчётная');
});

test('skips Matter export cleanly when Matter is disabled', async () => {
  const { platform, warnings } = makePlatform({}, undefined);
  await platform.registerMatterMeter();
  assert.equal(platform.matterMeterUuid, null);
  assert.match(warnings[0], /Enable Matter on this Homebridge bridge/);
});

test('keeps the local platform usable when Matter registration fails', async () => {
  const warnings = [];
  const matter = {
    uuid: { generate: value => 'uuid:' + value },
    deviceTypes: { ElectricalSensor: 'ElectricalSensorType' },
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
