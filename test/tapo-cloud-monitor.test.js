'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { EnergyStore } = require('../src/energy-store');
const { TapoCloudEnergyMonitor } = require('../src/tapo-cloud-monitor');

test('imports verified P110M daily cloud Wh into the persistent energy store', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tapo-cloud-monitor-'));
  const store = new EnergyStore(directory, { warn() {}, error() {} });
  const requestedRanges = [];
  const infoMessages = [];
  const monitor = new TapoCloudEnergyMonitor({
    log: { info(message, ...args) { infoMessages.push(util.format(message, ...args)); }, warn() {}, error() {} },
    username: 'user@example.com',
    password: 'secret',
    auth: {
      async login() {
        return { ok: true, token: 'session', refreshToken: null, termId: 'term' };
      },
      async discoverThingService() {
        return 'https://eu-app-server.iot.i.tplinkcloud.com';
      }
    },
    apiFactory: ({ host }) => ({
      host,
      async listThings() {
        return [{ thingName: 'p110m-1', nickname: 'Kitchen plug', model: 'P110M' }];
      },
      async getThingResource() {
        return { region: 'Europe/Moscow' };
      },
      async getUsage(_id, _host, range) {
        requestedRanges.push(range);
        if (range.interval === 43200) {
          const monthly = Array(12).fill(0);
          monthly[0] = 1000;
          monthly[10] = 5000;
          return {
            energy_data: {
              data: monthly,
              start_timestamp: range.start_timestamp,
              end_timestamp: range.end_timestamp,
              interval: 43200
            }
          };
        }
        const end = new Date(range.end_timestamp * 1000 - 1000);
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(end);
        const date = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
        return {
          energy_data: {
            local_time: date.year + '-' + date.month + '-' + date.day + ' 12:00:00',
            data: [1250, 2750],
            start_timestamp: range.start_timestamp,
            end_timestamp: range.end_timestamp,
            interval: 1440
          }
        };
      }
    })
  });

  try {
    const result = await monitor.poll(store);
    assert.deepEqual(result, { deviceCount: 1, importedDevices: 1 });
    assert.equal(requestedRanges.some(range => range.interval === 1440), true);
    assert.equal(requestedRanges.some(range => range.interval === 43200), true);
    assert.equal(requestedRanges.every(range => range.start_timestamp < range.end_timestamp), true);
    const summary = store.getSummary();
    assert.equal(summary.devices['p110m-1'].name, 'Kitchen plug');
    assert.equal(summary.devices['p110m-1'].energyWh, 6000);
    assert.equal(summary.devices['p110m-1'].totals.monthly['2026-11'], 5000);
    assert.equal(summary.devices['p110m-1'].totals.yearly['2026'], 6000);
    assert.equal(Object.values(summary.totals.daily).reduce((sum, value) => sum + value, 0), 4000);
    assert.equal(summary.totals.monthly['2026-11'], 5000);
    assert.equal(summary.totals.yearly['2026'], 6000);
    assert.equal(infoMessages.some(message => message.includes('[TAPO CLOUD STORED]') &&
      message.includes('energyWh=6000.00') && message.includes('monthlyBuckets=12') &&
      message.includes('month[2026-11]=5000.00 Wh')), true,
    'cloud poll must log the values actually persisted for each device');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
