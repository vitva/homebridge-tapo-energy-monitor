'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeTapoThingCloud, normalizeThing, buildDailyUsageRange, normalizeDailyEnergyHistory } = require('../src/tapo-cloud-client');

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
      async getUsage(id, host, range) {
        calls.push(['usage', id, host, range]);
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
  assert.deepEqual(calls[4].slice(0, 3), [
    'usage', 'p110m-1', 'https://us-app-server.iot.i.tplinkcloud.com'
  ]);
  assert.equal(calls[4][3].interval, 1440);
  assert.ok(Number.isSafeInteger(calls[4][3].start_timestamp));
  assert.ok(calls[4][3].end_timestamp > calls[4][3].start_timestamp);
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

test('prefers the per-device appServerUrl returned by Tapo', async () => {
  let usageHost;
  const result = await probeTapoThingCloud({
    username: 'user@example.com',
    password: 'local-only',
    auth: {
      async login() { return { ok: true, token: 't', termId: 'term' }; },
      async discoverThingService() { return 'https://eu-app-server.iot.i.tplinkcloud.com'; }
    },
    apiFactory: () => ({
      async listThings() {
        return [{
          thingName: 'p1',
          model: 'P110M',
          appServerUrl: 'https://euw1-app-server.iot.i.tplinknbu.com'
        }];
      },
      async getUsage(_id, host) { usageHost = host; return { energy_data: { data: [] } }; }
    })
  });
  assert.equal(result.ok, true);
  assert.equal(usageHost, 'https://euw1-app-server.iot.i.tplinknbu.com');
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


test('probes read-only P110M cloud resources and reports model service names', async () => {
  const result = await probeTapoThingCloud({
    username: 'user@example.com', password: 'local-only',
    auth: {
      async login() { return { ok: true, token: 't', termId: 'term' }; },
      async discoverThingService() { return 'https://eu-app-server.iot.i.tplinkcloud.com'; }
    },
    apiFactory: () => ({
      async listThings() {
        return [{ thingName: 'p1', model: 'P110M', thingModelId: 'model-1' }];
      },
      async getThingResource(_id, resource) {
        if (resource === 'details') return { fwVer: '1.0', macAddress: 'should-not-appear' };
        if (resource === 'settings') return { region: 'Europe/Helsinki' };
        return { safeField: true };
      },
      async getShadows(_id, _host, matter) {
        return matter ? { shadows: [] } : { shadows: [{ state: { reported: { on: true, power: 123 } } }] };
      },
      async getModel() {
        return { services: [{ serviceId: 'reverseStatus' }, { serviceId: 'clearEnergyData' }],
          properties: [{ propertyName: 'on' }, { propertyName: 'power' }] };
      },
      async getUsage(_id, _host, range) {
        assert.equal(range.interval, 1440);
        const localEnd = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).format(new Date(range.end_timestamp * 1000));
        assert.match(localEnd, /00:00/);
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      }
    })
  });
  const stages = result.diagnostics.map(item => item.stage);
  for (const stage of ['cloud_details', 'cloud_rt_info', 'cloud_settings', 'cloud_shadows',
    'cloud_matter_shadows', 'cloud_model']) assert.ok(stages.includes(stage));
  const model = result.diagnostics.find(item => item.stage === 'cloud_model');
  assert.match(model.reason, /reverseStatus/);
  assert.match(model.reason, /clearEnergyData/);
  assert.match(model.reason, /power/);
  assert.equal(JSON.stringify(result).includes('should-not-appear'), false);
});


test('builds daily energy history timestamps in the device timezone across DST', () => {
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  const range = buildDailyUsageRange('Europe/Helsinki', now, 60);
  assert.equal(range.interval, 1440);
  assert.ok(range.end_timestamp > range.start_timestamp);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Helsinki',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  assert.match(formatter.format(new Date(range.start_timestamp * 1000)), /00:00$/);
  assert.match(formatter.format(new Date(range.end_timestamp * 1000)), /00:00$/);
  assert.equal(Math.round((range.end_timestamp - range.start_timestamp) / 86400), 61);
});

test('falls back to UTC for a missing or invalid device timezone', () => {
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  const missing = buildDailyUsageRange(null, now, 60);
  const invalid = buildDailyUsageRange('not/a-timezone', now, 60);
  assert.deepEqual(invalid, missing);
  assert.equal(new Date(missing.end_timestamp * 1000).toISOString(), '2026-11-27T00:00:00.000Z');
});


test('maps daily energy values backward from the exclusive end date', () => {
  const values = Array.from({ length: 91 }, (_, index) => index === 90 ? 1234 : 0);
  const parsed = normalizeDailyEnergyHistory({
    energy_data: {
      local_time: '2026-11-26 23:44:26',
      data: values,
      start_timestamp: 1790456400,
      end_timestamp: 1795726800,
      interval: 1440
    }
  }, 'Europe/Helsinki');

  assert.equal(parsed.ok, true);
  assert.equal(parsed.records.length, 91);
  assert.equal(parsed.records[0].date, '2026-08-28');
  assert.equal(parsed.records.at(-1).date, '2026-11-26');
  assert.equal(parsed.records.at(-1).value, 1234);
  assert.equal(parsed.meta.requestedDays, 61);
  assert.equal(parsed.meta.returnedDays, 91);
  assert.equal(parsed.meta.rangeMismatch, true);
  assert.equal(parsed.meta.valueUnit, 'unconfirmed');
});

test('keeps daily date alignment correct across daylight-saving transitions', () => {
  const parsed = normalizeDailyEnergyHistory({
    energy_data: {
      data: [10, 20, 30],
      start_timestamp: 1774652400,
      end_timestamp: 1774911600,
      interval: 1440
    }
  }, 'Europe/Helsinki');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.records.length, 3);
  assert.equal(parsed.records[2].date, '2026-03-30');
});

test('does not interpret an unknown usage response as daily history', () => {
  assert.equal(normalizeDailyEnergyHistory({ today: 1.25, history: [] }).ok, false);
  assert.equal(normalizeDailyEnergyHistory({
    energy_data: { data: ['12'], end_timestamp: 1795726800, interval: 1440 }
  }).ok, false);
});
