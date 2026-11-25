'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeTapoThingCloud, normalizeThing } = require('../src/tapo-cloud-client');

test('normalizes Thing devices without exposing raw records', () => {
  assert.deepEqual(normalizeThing({
    thingName: 'device-1', nickname: 'Kitchen', model: 'P110M',
    status: 'online', category: 'plug', secretField: 'not-copied'
  }), {
    id: 'device-1', name: 'Kitchen', model: 'P110M',
    status: 'online', category: 'plug'
  });
});

test('runs cloud login, Thing discovery, listing and read-only P110M usage', async () => {
  const calls = [];
  const auth = {
    async login(input) {
      calls.push(['login', input]);
      return { ok: true, token: 'session-secret', termId: 'term-1' };
    },
    async discoverThingService(username, token) {
      calls.push(['discover', username, token]);
      return 'https://eu-app-server.iot.i.tplinkcloud.com';
    }
  };
  const apiFactory = options => {
    calls.push(['api', options]);
    return {
      async listThings() {
        calls.push(['list']);
        return [
          { thingName: 'p110m-1', nickname: 'Socket', model: 'P110M', status: 'online' },
          { thingName: 's112-1', model: 'S112' },
          { thingName: 'p110-1', model: 'P110' }
        ];
      },
      async getUsage(id) {
        calls.push(['usage', id]);
        return { today: 1.25, history: [] };
      }
    };
  };

  const result = await probeTapoThingCloud({
    username: ' user@example.com ',
    password: 'local-only',
    mfaCode: '123456',
    auth,
    apiFactory
  });

  assert.equal(result.ok, true);
  assert.equal(result.deviceCount, 3);
  assert.equal(result.p110mCount, 1);
  assert.deepEqual(result.readings, [{ id: 'p110m-1', usage: { today: 1.25, history: [] } }]);
  assert.deepEqual(calls.map(call => call[0]), ['login', 'discover', 'api', 'list', 'usage']);
  assert.equal(calls[1][2], 'session-secret');
  assert.equal(calls[2][1].token, 'session-secret');
  assert.equal(JSON.stringify(result).includes('session-secret'), false);
});

test('returns MFA challenge without attempting Thing API calls', async () => {
  let apiCreated = false;
  const result = await probeTapoThingCloud({
    username: 'user@example.com',
    password: 'local-only',
    auth: { async login() {
      return { ok: false, code: 'mfa_required', message: 'Enter MFA' };
    } },
    apiFactory() { apiCreated = true; }
  });
  assert.equal(result.code, 'mfa_required');
  assert.equal(apiCreated, false);
});

test('keeps device discovery result when an individual P110M usage request fails', async () => {
  const result = await probeTapoThingCloud({
    username: 'user@example.com',
    password: 'local-only',
    auth: {
      async login() { return { ok: true, token: 't', termId: 'term' }; },
      async discoverThingService() { return 'https://eu-app-server.iot.i.tplinkcloud.com'; }
    },
    apiFactory: () => ({
      async listThings() { return [{ thingName: 'p1', model: 'P110M' }]; },
      async getUsage() { throw new Error('private transport detail'); }
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceCount, 1);
  assert.match(result.readings[0].error, /не удалось прочитать/i);
  assert.equal(JSON.stringify(result).includes('private transport detail'), false);
});

test('rejects missing credentials before cloud calls', async () => {
  const result = await probeTapoThingCloud({ username: '', password: '' });
  assert.equal(result.code, 'credentials_required');
});
