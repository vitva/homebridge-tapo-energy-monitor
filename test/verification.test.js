'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'config.schema.json'), 'utf8'));

test('declares Homebridge Matter platform support and supported Node LTS versions', () => {
  assert.ok(pkg.keywords.includes('homebridge-plugin'));
  assert.ok(pkg.keywords.includes('supports-matter'));
  assert.ok(!pkg.keywords.includes('supports-hap'));
  assert.equal(pkg.engines.homebridge, '>=2.2.0');
  assert.equal(pkg.engines.node, '^22.12.0 || ^24.0.0 || ^26.0.0');
});

test('ships the Homebridge plugin settings GUI', () => {
  assert.equal(schema.pluginType, 'platform');
  assert.equal(schema.customUi, true);
  assert.ok(pkg.files.includes('config.schema.json'));
  assert.ok(pkg.files.includes('homebridge-ui/'));
});

test('does not start simulation by default or create demo devices', () => {
  assert.equal(schema.schema.properties.simulationMode.default, false);
  assert.equal(Object.hasOwn(schema.schema.properties.simulatedDevices, 'default'), false);
  assert.equal(Object.hasOwn(schema.schema.properties, 'dataDirectory'), false);
});

test('does not define a host-modifying install lifecycle script', () => {
  for (const script of Object.keys(pkg.scripts || {})) {
    assert.ok(!/^(preinstall|install|postinstall)$/i.test(script), 'unexpected lifecycle script: ' + script);
  }
});
