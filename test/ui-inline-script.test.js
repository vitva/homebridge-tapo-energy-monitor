'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Homebridge custom UI inline script parses successfully', () => {
  const file = path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'custom UI script block must exist');
  assert.doesNotThrow(() => new vm.Script(match[1], { filename: file }));
});

test('custom UI defaults to the tested Node.js Tapo transport', () => {
  const file = path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /<option value="node" selected>/);
});
