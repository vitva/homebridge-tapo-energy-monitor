'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runTapoCloudProbe } = require('../src/tapo-cloud');

test('cloud probe parses the helper JSON response', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => {
      process.nextTick(() => {
        child.stdout.end(JSON.stringify({ ok: true, authenticated: true, deviceCount: 0, devices: [] }));
        child.emit('close', 0);
      });
    });
    return child;
  };
  const result = await runTapoCloudProbe({ username: '', password: '', spawn });
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
});

test('cloud probe rejects invalid helper output', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => {
      process.nextTick(() => {
        child.stdout.end('invalid');
        child.emit('close', 0);
      });
    });
    return child;
  };
  await assert.rejects(runTapoCloudProbe({ spawn }), /некорректный ответ/);
});
