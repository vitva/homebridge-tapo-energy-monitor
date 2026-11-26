'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
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

test('Thing API exposes only read-only GET endpoints and preserves the raw usage payload', async () => {
  const calls = [];
  const fakeRequest = (url, options, callback) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers, ca: options.ca, rejectUnauthorized: options.rejectUnauthorized });
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
        : { error_code: 0, data: { opaqueVendorField: { sample: 'fixture-only' }, records: [{ value: 42 }] } }));
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
  const usage = await client.getUsage('thing/1', 'https://us-app-server.iot.i.tplinkcloud.com');
  assert.deepEqual(usage, { opaqueVendorField: { sample: 'fixture-only' }, records: [{ value: 42 }] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === 'GET' && call.rejectUnauthorized === true));
  assert.ok(calls.every(call => Array.isArray(call.ca) && call.ca.length > tls.rootCertificates.length));
  assert.ok(calls.every(call => call.ca.slice(0, tls.rootCertificates.length).every((cert, index) => cert === tls.rootCertificates[index])));
  assert.ok(calls.every(call => Buffer.isBuffer(call.ca.at(-1)) && call.ca.at(-1).length > 0));
  assert.ok(calls[0].url.startsWith('https://eu-app-server.iot.i.tplinkcloud.com/v2/things?'));
  assert.ok(calls[1].url.startsWith('https://us-app-server.iot.i.tplinkcloud.com/v1/things/thing%2F1/usage'));
  assert.equal(calls[0].headers.Authorization, 'ut|test-token');
});

test('rejects an untrusted per-device Thing API host before making a request', async () => {
  const client = new TapoThingApi({
    host: 'https://eu-app-server.iot.i.tplinkcloud.com',
    token: 'test-token'
  });
  await assert.rejects(
    client.getUsage('thing-1', 'https://example.com'),
    /invalid Thing API host/
  );
});

test('requires a non-empty cloud session token', () => {
  assert.throws(() => new TapoThingApi({
    host: 'https://eu-app-server.iot.i.tplinkcloud.com',
    token: ''
  }), /session token is required/);
});
