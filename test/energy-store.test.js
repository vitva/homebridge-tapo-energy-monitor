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

test('integrates samples and stores per-device plus combined period totals', () => {
  withStore((store) => {
    const start = new Date(2026, 10, 25, 12).getTime();
    store.recordPower('plug-1', 100, start, { name: 'Plug 1', model: 'P110M' });
    store.recordPower('plug-2', 50, start, { name: 'Plug 2', model: 'S112' });
    store.recordPower('plug-1', 100, start + 60 * 60 * 1000);
    store.recordPower('plug-2', 50, start + 60 * 60 * 1000);

    const summary = store.getSummary();
    assert.equal(summary.totals.daily['2026-11-25'], 150);
    assert.equal(summary.devices['plug-1'].totals.daily['2026-11-25'], 100);
    assert.equal(summary.devices['plug-2'].totals.monthly['2026-11'], 50);
    assert.equal(summary.devices['plug-1'].energyWh, 100);
    assert.equal(summary.devices['plug-2'].energyWh, 50);
    assert.equal(summary.devices['plug-1'].name, 'Plug 1');
  });
});

test('imports cloud daily Wh idempotently and rebuilds day, month and year totals', () => {
  withStore(store => {
    const records = [
      { date: '2026-11-25', value: 1200 },
      { date: '2026-11-26', value: 2300 }
    ];
    store.recordDailyEnergy('cloud-p110m', records, { name: 'P110M', model: 'P110M' });
    store.recordDailyEnergy('cloud-p110m', records, { name: 'P110M', model: 'P110M' });
    let summary = store.getSummary();
    assert.equal(summary.devices['cloud-p110m'].energyWh, 3500);
    assert.equal(summary.devices['cloud-p110m'].totals.daily['2026-11-25'], 1200);
    assert.equal(summary.totals.daily['2026-11-26'], 2300);
    assert.equal(summary.totals.monthly['2026-11'], 3500);
    assert.equal(summary.totals.yearly['2026'], 3500);

    store.recordDailyEnergy('cloud-p110m', [
      { date: '2026-11-26', value: 2500 }
    ]);
    summary = store.getSummary();
    assert.equal(summary.devices['cloud-p110m'].energyWh, 3700);
    assert.equal(summary.totals.daily['2026-11-26'], 2500);
    assert.equal(summary.totals.monthly['2026-11'], 3700);
  });
});

test('prefers cloud monthly totals over partial daily sums for monthly and yearly reports', () => {
  withStore(store => {
    store.recordDailyEnergy('cloud-p110m', [
      { date: '2026-11-25', value: 1200 },
      { date: '2026-11-26', value: 2300 }
    ]);
    store.recordMonthlyEnergy('cloud-p110m', [
      { month: '2026-01', value: 8000 },
      { month: '2026-11', value: 5000 }
    ]);
    const summary = store.getSummary();
    assert.equal(summary.totals.daily['2026-11-25'], 1200);
    assert.equal(summary.totals.monthly['2026-11'], 5000);
    assert.equal(summary.totals.yearly['2026'], 13000);
    assert.equal(summary.devices['cloud-p110m'].energyWh, 13000);
  });
});

test('ignores invalid IDs and negative/non-finite power readings', () => {
  withStore((store) => {
    const now = Date.now();
    store.recordPower('', 10, now);
    store.recordPower('plug-1', -1, now);
    store.recordPower('plug-1', Number.NaN, now);
    assert.equal(Object.keys(store.getSummary().devices).length, 0);
  });
});

test('persists and reloads device-level and combined history', () => {
  withStore((store, directory) => {
    const start = new Date(2026, 10, 25, 12).getTime();
    store.recordPower('plug-1', 200, start);
    store.recordPower('plug-1', 200, start + 30 * 60 * 1000);

    const reloaded = new EnergyStore(directory, { warn() {}, error() {} });
    const summary = reloaded.getSummary();
    assert.equal(summary.totals.daily['2026-11-25'], 100);
    assert.equal(summary.devices['plug-1'].totals.daily['2026-11-25'], 100);
  });
});

test('loads legacy version 1 data and upgrades it in memory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tapo-energy-'));
  try {
    fs.writeFileSync(path.join(directory, 'tapo-energy-history.json'), JSON.stringify({
      version: 1,
      devices: { old: { powerW: 10, timestamp: 1, energyWh: 4 } },
      totals: { daily: {}, monthly: {}, yearly: {} }
    }));
    const store = new EnergyStore(directory, { warn() {}, error() {} });
    assert.equal(store.getSummary().version, 2);
    assert.deepEqual(store.getSummary().devices.old.totals, { daily: {}, monthly: {}, yearly: {} });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('marks removed devices inactive without deleting their historical totals', () => {
  withStore((store) => {
    const start = new Date(2026, 10, 25, 12).getTime();
    store.recordPower('plug-1', 100, start);
    store.recordPower('plug-1', 100, start + 60 * 60 * 1000);
    store.recordPower('plug-2', 50, start);
    store.setActiveDevices(['plug-2']);
    const summary = store.getSummary();
    assert.equal(summary.devices['plug-1'].active, false);
    assert.equal(summary.devices['plug-2'].active, true);
    assert.equal(summary.devices['plug-1'].energyWh, 100);
    assert.equal(summary.totals.daily['2026-11-25'], 100);
  });
});


test('falls back to refreshed daily values when the current monthly snapshot is stale', () => {
  withStore(store => {
    store.recordDailyEnergy('cloud-p110m', [
      { date: '2026-11-25', value: 1200 },
      { date: '2026-11-26', value: 2300 }
    ], { latestDate: '2026-11-26' });
    store.recordMonthlyEnergy('cloud-p110m', [
      { month: '2026-11', value: 5000 }
    ]);
    assert.equal(store.getSummary().totals.monthly['2026-11'], 5000);

    // The next daily poll succeeds but the monthly endpoint is unavailable.
    store.recordDailyEnergy('cloud-p110m', [
      { date: '2026-11-25', value: 1200 },
      { date: '2026-11-26', value: 2600 }
    ], { latestDate: '2026-11-26' });

    let summary = store.getSummary();
    assert.equal(summary.totals.monthly['2026-11'], 3800);
    assert.equal(summary.totals.yearly['2026'], 3800);
    assert.equal(summary.devices['cloud-p110m'].energyWh, 3800);

    // A later successful monthly poll restores the authoritative full-month value.
    store.recordMonthlyEnergy('cloud-p110m', [
      { month: '2026-11', value: 5400 }
    ]);
    summary = store.getSummary();
    assert.equal(summary.totals.monthly['2026-11'], 5400);
    assert.equal(summary.totals.yearly['2026'], 5400);
  });
});

test('keeps cumulative cloud energy across a calendar-year rollover without double counting', () => {
  withStore(store => {
    store.recordDailyEnergy('cloud-p110m', [
      { date: '2026-12-30', value: 1000 },
      { date: '2026-12-31', value: 1500 }
    ]);
    store.recordMonthlyEnergy('cloud-p110m', [
      { month: '2026-12', value: 2500 }
    ]);
    store.recordDailyEnergy('cloud-p110m', [
      { date: '2027-01-01', value: 700 },
      { date: '2027-01-02', value: 900 }
    ]);
    store.recordMonthlyEnergy('cloud-p110m', [
      { month: '2027-01', value: 1600 }
    ]);

    const summary = store.getSummary();
    assert.equal(summary.devices['cloud-p110m'].energyWh, 4100);
    assert.equal(summary.totals.monthly['2026-12'], 2500);
    assert.equal(summary.totals.monthly['2027-01'], 1600);
    assert.equal(summary.totals.yearly['2026'], 2500);
    assert.equal(summary.totals.yearly['2027'], 1600);
    assert.equal(summary.totals.daily['2026-12-31'], 1500);
    assert.equal(summary.totals.daily['2027-01-01'], 700);
  });
});
