'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TapoThingApi, validateThingHost, cloudApiError } = require('../src/tapo-thing-api');

test('validates only HTTPS TP-Link Thing API hosts', () => {
  assert.equal(validateThingHost('https://eu-app-server.iot.i.tplinkcloud.com/'),
    'https://eu-app-server.iot.i.tplinkcloud.com');
  for (const value of [
    'http://eu-app-server.iot.i.tplinkcloud.com',
    'https://example.com',
    'https://user:pass@eu-app-server.iot.i.tplinkcloud.com',
    'https://eu-app-server.iot.i.tplinkcloud.com:444',
    'https://eu-app-server.iot.i.tplinkcloud.com/path'
  ]) assert.throws(() => validateThingHost(value), /invalid Thing API host/);
});

test('rejects malformed and non-zero API error payloads', () => {
  assert.throws(() => cloudApiError([]), /invalid Thing API response/);
  assert.throws(() => cloudApiError({ error_code: 'not-a-number' }), /invalid Thing API response/);
  assert.throws(() => cloudApiError({ error_code: -20651 }), /error \(-20651\)/);
});

test('Thing API exposes only read-only GET endpoints and parses usage data', async () => {
  const calls = [];
  const fakeRequest = (url, options, callback) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers });
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const req = new EventEmitter();
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.end(JSON.stringify(calls.length === 1
        ? { error_code: 0, total: 1, data: [{ thingName: 'thing-1', model: 'P110M' }] }
        : { error_code: 0, data: { power: 42, history: [] } }));
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const client = new TapoThingApi({
    host: 'https://eu-app-server.iot.i.tplinkcloud.com',
    token: 'test-token',
    termId: 'test-term',
    request: fakeRequest,
    caPath: require('node:path').join(__dirname, '..', 'helpers', 'tplink-cloud-server-ca.pem')
  });
  const things = await client.listThings();
  assert.equal(things[0].thingName, 'thing-1');
  const usage = await client.getUsage('thing/1');
  assert.deepEqual(usage, { power: 42, history: [] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.ok(calls[0].url.includes('/v2/things?'));
  assert.ok(calls[1].url.includes('/v1/things/thing%2F1/usage'));
  assert.equal(calls[0].headers.Authorization, 'ut|test-token');
});

test('requires a non-empty cloud session token', () => {
  assert.throws(() => new TapoThingApi({
    host: 'https://eu-app-server.iot.i.tplinkcloud.com',
    token: ''
  }), /session token is required/);
});
