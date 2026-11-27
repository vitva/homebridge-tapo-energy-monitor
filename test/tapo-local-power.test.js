'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EnergyStore } = require('../src/energy-store');
const { TapoLocalPowerMonitor, normalizePrivateIpv4 } = require('../src/tapo-local-power');

async function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tapo-local-power-'));
  try {
    await run(new EnergyStore(directory, { warn() {}, error() {} }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('accepts only private IPv4 addresses for local Tapo access', () => {
  assert.equal(normalizePrivateIpv4('192.168.1.40'), '192.168.1.40');
  assert.equal(normalizePrivateIpv4('10.0.0.5'), '10.0.0.5');
  assert.equal(normalizePrivateIpv4('172.16.0.2'), '172.16.0.2');
  assert.equal(normalizePrivateIpv4('172.31.255.1'), '172.31.255.1');
  assert.equal(normalizePrivateIpv4('8.8.8.8'), null);
  assert.equal(normalizePrivateIpv4('127.0.0.1'), null);
  assert.equal(normalizePrivateIpv4('192.168.1.999'), null);
});

test('reads live P110M watts over LAN and stores them without estimating energy', async () => {
  await withStore(async store => {
    const connected = [];
    const client = {
      devices: new Map(),
      async connect(ip, options) {
        connected.push({ ip, options });
        const device = { model: 'P110M', async getCurrentPower() { return { currentPower: 86.4 }; } };
        this.devices.set(options.name, device);
        return device;
      }
    };
    const monitor = new TapoLocalPowerMonitor({
      username: 'user@example.com', password: 'secret',
      log: { info() {}, warn() {} }, clientFactory: () => client
    });
    const result = await monitor.poll(
      [{ id: 'plug-1', name: 'Kitchen', model: 'P110M' }],
      new Map([['plug-1', { ip: '192.168.1.40' }]]),
      store, 1_800_000_000_000
    );
    assert.deepEqual(result, { deviceCount: 1, available: 1, unavailable: 0 });
    assert.deepEqual(connected, [{ ip: '192.168.1.40', options: { name: 'plug-1' } }]);
    const device = store.getSummary().devices['plug-1'];
    assert.equal(device.powerW, 86.4);
    assert.equal(device.powerUpdatedAt, 1_800_000_000_000);
    assert.equal(device.energyWh, 0);
    assert.deepEqual(device.totals, { daily: {}, monthly: {}, yearly: {} });
  });
});

test('does not connect to a device when Tapo Cloud has no private LAN address', async () => {
  await withStore(async store => {
    let calls = 0;
    const monitor = new TapoLocalPowerMonitor({
      username: 'user@example.com', password: 'secret',
      log: { info() {}, warn() {} },
      clientFactory: () => ({ devices: new Map(), async connect() { calls += 1; } })
    });
    const result = await monitor.poll(
      [{ id: 'plug-1', name: 'Kitchen', model: 'P110M' }],
      new Map([['plug-1', { ip: '8.8.8.8' }]]),
      store
    );
    assert.deepEqual(result, { deviceCount: 1, available: 0, unavailable: 1 });
    assert.equal(calls, 0);
  });
});

test('stops retrying a device after a local authentication rejection', async () => {
  await withStore(async store => {
    let calls = 0;
    const authError = Object.assign(new Error('authentication rejected'), { kind: 'auth' });
    const monitor = new TapoLocalPowerMonitor({
      username: 'user@example.com', password: 'secret',
      log: { info() {}, warn() {} },
      clientFactory: () => ({ devices: new Map(), async connect() { calls += 1; throw authError; } })
    });
    const devices = [{ id: 'plug-1', name: 'Kitchen', model: 'P110M' }];
    const info = new Map([['plug-1', { ip: '192.168.1.40' }]]);
    const first = await monitor.poll(devices, info, store, 1_800_000_000_000);
    const second = await monitor.poll(devices, info, store, 1_800_000_000_001);
    assert.equal(first.unavailable, 1);
    assert.equal(second.unavailable, 1);
    assert.equal(calls, 1);
  });
});

test('ignores a local endpoint that identifies as a different model', async () => {
  await withStore(async store => {
    const monitor = new TapoLocalPowerMonitor({
      username: 'user@example.com', password: 'secret',
      log: { info() {}, warn() {} },
      clientFactory: () => ({
        devices: new Map(),
        async connect() { return { model: 'P110', async getCurrentPower() { return { currentPower: 50 }; } }; }
      })
    });
    const result = await monitor.poll(
      [{ id: 'plug-1', name: 'Kitchen', model: 'P110M' }],
      new Map([['plug-1', { ip: '192.168.1.40' }]]),
      store
    );
    assert.equal(result.available, 0);
    assert.equal(store.getSummary().devices['plug-1'], undefined);
  });
});
