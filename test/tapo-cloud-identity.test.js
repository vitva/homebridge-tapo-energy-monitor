'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getStableTapoTermId } = require('../src/tapo-cloud-identity');

test('keeps one stable Tapo terminal UUID across Homebridge restarts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tapo-cloud-identity-'));
  try {
    const first = getStableTapoTermId(directory);
    const second = getStableTapoTermId(directory);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(second, first);
    assert.equal(fs.readFileSync(path.join(directory, 'tapo-cloud-terminal-id'), 'utf8').trim(), first);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
