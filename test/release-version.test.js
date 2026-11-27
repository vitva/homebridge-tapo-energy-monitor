'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('beta release metadata matches the prepared npm candidate', () => {
  assert.equal(pkg.version, '0.2.0-beta.27');
});
