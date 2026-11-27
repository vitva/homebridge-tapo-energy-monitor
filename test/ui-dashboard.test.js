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
  assert.ok(refresh.includes('latestCommonDate'),
    'cloud dashboard must fall back to the latest date complete across active devices');
  const monthKey = refresh.indexOf('const monthKey =');
  const monthRender = refresh.indexOf("byId('month').textContent");
  assert.ok(monthKey >= 0 && monthKey < monthRender,
    'reporting period keys must be initialized before monthly values render');
  assert.ok(refresh.includes("byId('month').textContent") && refresh.includes("byId('year').textContent"),
    'cloud dashboard must expose monthly and yearly totals without requiring a daily bucket');
  assert.ok(html.includes('id="month"') && html.includes('id="year"'),
    'monthly and yearly summary cards must exist');
});
