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
          { thingName: 'p110m-1', nickname: 'Socket', model: 'P110M',
            appServerUrlV2: 'https://us-app-server.iot.i.tplinkcloud.com' },
          { thingName: 's112-1', model: 'S112' },
          { thingName: 'p110-1', model: 'P110' }
        ];
      },
      async getUsage(id, host) {
        calls.push(['usage', id, host]);
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
  assert.deepEqual(result.diagnostics.map(item => [item.stage, item.status]), [
    ['authentication', 'success'], ['thing_service', 'success'],
    ['device_list', 'success'], ['usage', 'success']
  ]);
  assert.ok(result.diagnostics.every(item => Number.isInteger(item.durationMs) && item.durationMs >= 0));
  assert.deepEqual(result.readings, [{ id: 'p110m-1', usage: { today: 1.25, history: [] } }]);
  assert.deepEqual(calls.map(call => call[0]), ['login', 'discover', 'api', 'list', 'usage']);
  assert.equal(calls[1][2], 'session-secret');
  assert.equal(calls[2][1].token, 'session-secret');
  assert.deepEqual(calls[4], [
    'usage', 'p110m-1', 'https://us-app-server.iot.i.tplinkcloud.com'
  ]);
  assert.equal(JSON.stringify(result).includes('session-secret'), false);
});

test('falls back to the discovered Thing host when a device has no appServerUrlV2', async () => {
  let usageHost;
  const result = await probeTapoThingCloud({
    username: 'user@example.com',
    password: 'local-only',
    auth: {
      async login() { return { ok: true, token: 't', termId: 'term' }; },
      async discoverThingService() { return 'https://eu-app-server.iot.i.tplinkcloud.com'; }
    },
    apiFactory: () => ({
      async listThings() { return [{ thingName: 'p1', model: 'P110M' }]; },
      async getUsage(_id, host) { usageHost = host; return { today: 1 }; }
    })
  });
  assert.equal(result.ok, true);
  assert.equal(usageHost, 'https://eu-app-server.iot.i.tplinkcloud.com');
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
  assert.deepEqual(result.diagnostics.map(item => [item.stage, item.status]), [['authentication', 'required']]);
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


test('reports rejected MFA codes without exposing account credentials', async () => {
  const result = await probeTapoThingCloud({
    username: 'private@example.com',
    password: 'never-return-this-password',
    mfaCode: '654321',
    auth: {
      async login(input) {
        assert.equal(input.username, 'private@example.com');
        assert.equal(input.password, 'never-return-this-password');
        assert.equal(input.mfaCode, '654321');
        return {
          ok: false,
          code: 'mfa_failed',
          message: 'TP-Link не принял код подтверждения.'
        };
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'mfa_failed');
  assert.deepEqual(result.diagnostics.map(item => [item.stage, item.status]), [
    ['authentication', 'failed']
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('never-return-this-password'), false);
  assert.equal(serialized.includes('654321'), false);
  assert.equal(serialized.includes('private@example.com'), false);
});

test('reports rejected account credentials as an authentication failure', async () => {
  const result = await probeTapoThingCloud({
    username: 'private@example.com',
    password: 'never-return-this-password',
    auth: {
      async login() {
        return {
          ok: false,
          code: 'auth_failed',
          message: 'TP-Link отклонил логин или пароль.'
        };
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'auth_failed');
  assert.deepEqual(result.diagnostics.map(item => [item.stage, item.status]), [
    ['authentication', 'failed']
  ]);
  assert.equal(JSON.stringify(result).includes('never-return-this-password'), false);
});

test('attributes Thing service discovery failures to the correct stage', async () => {
  const result = await probeTapoThingCloud({
    username: 'private@example.com',
    password: 'local-only',
    auth: {
      async login() { return { ok: true, token: 'session-secret', termId: 'term' }; },
      async discoverThingService() { throw new Error('private transport details'); }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'thing_api_error');
  assert.deepEqual(result.diagnostics.map(item => [item.stage, item.status]), [
    ['authentication', 'success'],
    ['thing_service', 'failed']
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('session-secret'), false);
  assert.equal(serialized.includes('private transport details'), false);
});


test('attributes Thing API client initialization failures to device listing', async () => {
  const result = await probeTapoThingCloud({
    username: 'private@example.com',
    password: 'local-only',
    auth: {
      async login() { return { ok: true, token: 'session-secret', termId: 'term' }; },
      async discoverThingService() { return 'https://eu-app-server.iot.i.tplinkcloud.com'; }
    },
    apiFactory() { throw new Error('private constructor detail'); }
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map(item => [item.stage, item.status]), [
    ['authentication', 'success'],
    ['thing_service', 'success'],
    ['device_list', 'failed']
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('session-secret'), false);
  assert.equal(serialized.includes('private constructor detail'), false);
});


test('includes safe transport diagnostics when a P110M usage request fails', async () => {
  const result = await probeTapoThingCloud({
    username: 'user@example.com', password: 'local-only',
    auth: {
      async login() { return { ok: true, token: 't', termId: 'term' }; },
      async discoverThingService() { return 'https://eu-app-server.iot.i.tplinkcloud.com'; }
    },
    apiFactory: () => ({
      async listThings() { return [{ thingName: 'p1', model: 'P110M' }]; },
      async getUsage() { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
    })
  });
  const usage = result.diagnostics.find(item => item.stage === 'usage');
  assert.equal(usage.status, 'failed');
  assert.equal(usage.errorCode, 'ECONNRESET');
  assert.equal(usage.reason, 'Сервер или сеть неожиданно разорвали соединение.');
  assert.equal(result.readings[0].errorCode, 'ECONNRESET');
  assert.equal(JSON.stringify(result).includes('socket hang up'), false);
});
