'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWattCsv } = require('../src/watt-csv');

test('parses Watt daily CSV and preserves the date printed by Watt', () => {
  const result = parseWattCsv([
    'Date,Consumption (Wh), Runtime (Minute)',
    '2026-10-26 21:00:00 +0000,0,0',
    '2026-10-27 21:00:00 +0000,296,0',
    '2026-11-01 21:00:00 +0000,3,0',
    '2026-11-02 21:00:00 +0000,313,0'
  ].join('\n'));
  assert.equal(result.recordCount, 4);
  assert.equal(result.totalWh, 612);
  assert.equal(result.daily['2026-10-27'], 296);
  assert.equal(result.monthly['2026-10'], 296);
  assert.equal(result.monthly['2026-11'], 316);
  assert.equal(result.yearly['2026'], 612);
  assert.equal(result.records[0].date, '2026-10-26');
  assert.equal(result.records[0].runtimeMinutes, 0);
});

test('rejects duplicate dates, negative consumption, and unsupported headers', () => {
  assert.throws(() => parseWattCsv('Date,Consumption (Wh)\n2026-01-01 00:00:00 +0000,1\n2026-01-01 12:00:00 +0000,2'), /Duplicate/);
  assert.throws(() => parseWattCsv('Date,Consumption (Wh)\n2026-01-01 00:00:00 +0000,-1'), /Invalid/);
  assert.throws(() => parseWattCsv('date,wh\n2026-01-01,1'), /header/);
});
