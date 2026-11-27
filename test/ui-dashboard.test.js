'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('initializes cloud dashboard state before reading it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
  const refreshStart = html.indexOf('async function refresh()');
  const initStart = html.indexOf('async function init()', refreshStart);
  assert.ok(refreshStart >= 0 && initStart > refreshStart, 'dashboard refresh function must exist');
  const refresh = html.slice(refreshStart, initStart);
  const activeDevices = refresh.indexOf('const activeDevices =');
  const cloudHistory = refresh.indexOf('const cloudHistory =');
  const primaryCloudDevice = refresh.indexOf('const primaryCloudDevice =');
  const todayWh = refresh.indexOf('const todayWh =');
  assert.ok(activeDevices >= 0 && activeDevices < primaryCloudDevice,
    'activeDevices must be initialized before primaryCloudDevice reads it');
  assert.ok(cloudHistory >= 0 && cloudHistory < todayWh,
    'cloudHistory must be initialized before todayWh reads it');
});
