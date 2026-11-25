'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EnergyStore } = require('../src/energy-store');

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tapo-energy-'));
  try {
    run(new EnergyStore(directory, { warn() {}, error() {} }), directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('integrates adjacent power samples and aggregates daily/monthly/yearly Wh', () => {
  withStore((store) => {
    const start = new Date(2026, 10, 25, 12, 0, 0).getTime();
    store.recordPower('plug-1', 100, start);
    store.recordPower('plug-1', 100, start + 60 * 60 * 1000);

    const summary = store.getSummary();
    const day = '2026-11-25';
    assert.equal(summary.totals.daily[day], 100);
    assert.equal(summary.totals.monthly['2026-11'], 100);
    assert.equal(summary.totals.yearly['2026'], 100);
    assert.equal(summary.devices['plug-1'].energyWh, 100);
  });
});

test('ignores negative and non-finite power readings', () => {
  withStore((store) => {
    const now = Date.now();
    store.recordPower('plug-1', -1, now);
    store.recordPower('plug-1', Number.NaN, now);
    assert.equal(Object.keys(store.getSummary().devices).length, 0);
  });
});

test('persists history and reloads it from disk', () => {
  withStore((store, directory) => {
    const start = new Date(2026, 10, 25, 12, 0, 0).getTime();
    store.recordPower('plug-1', 200, start);
    store.recordPower('plug-1', 200, start + 30 * 60 * 1000);

    const reloaded = new EnergyStore(directory, { warn() {}, error() {} });
    assert.equal(reloaded.getSummary().totals.daily['2026-11-25'], 100);
  });
});
