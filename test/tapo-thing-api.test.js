'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { TapoThingApi, validateThingHost, cloudApiError, classifyThingError } = require('../src/tapo-thing-api');

test('validates only HTTPS TP-Link Thing API hosts', () => {
  assert.equal(validateThingHost('https://eu-app-server.iot.i.tplinkcloud.com/'),
    'https://eu-app-server.iot.i.tplinkcloud.com');
  assert.equal(validateThingHost('https://euw1-app-server.iot.i.tplinknbu.com/'),
    'https://euw1-app-server.iot.i.tplinknbu.com');
  for (const value of [
    'http://eu-app-server.iot.i.tplinkcloud.com',
    'https://example.com',
    'https://user:pass@eu-app-server.iot.i.tplinkcloud.com',
    'https://eu-app-server.iot.i.tplinkcloud.com:444',
    'https://eu-app-server.iot.i.tplinkcloud.com/path',
    'https://euw1-app-server.iot.i.tplinknbu.com/path'
  ]) assert.throws(() => validateThingHost(value), /invalid Thing API host/);
});

test('rejects malformed and non-zero API error payloads', () => {
  assert.throws(() => cloudApiError([]), /invalid Thing API response/);
  assert.throws(() => cloudApiError({ error_code: 'not-a-number' }), /invalid Thing API response/);
  assert.throws(() => cloudApiError({ error_code: -20651 }), /error \(-20651\)/);
});

test('Thing API lists with GET and reads energy history with Watt-compatible POST', async () => {
  const calls = [];
  const fakeRequest = (url, options, callback) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers, ca: options.ca, rejectUnauthorized: options.rejectUnauthorized });
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const req = new EventEmitter();
    req.end = body => {
      calls.at(-1).body = body;
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
  const range = { start_timestamp: 1730422800, end_timestamp: 1736812800, interval: 1440 };
  const usage = await client.getUsage('thing/1', 'https://euw1-app-server.iot.i.tplinknbu.com', range);
  assert.deepEqual(usage, { opaqueVendorField: { sample: 'fixture-only' }, records: [{ value: 42 }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  assert.ok(calls.every(call => call.rejectUnauthorized === true));
  assert.ok(calls.every(call => Array.isArray(call.ca) && call.ca.length > tls.rootCertificates.length));
  assert.ok(calls.every(call => call.ca.slice(0, tls.rootCertificates.length).every((cert, index) => cert === tls.rootCertificates[index])));
  assert.ok(calls.every(call => Buffer.isBuffer(call.ca.at(-1)) && call.ca.at(-1).length > 0));
  assert.ok(calls[0].url.startsWith('https://eu-app-server.iot.i.tplinkcloud.com/v2/things?'));
  assert.ok(calls[1].url.startsWith('https://euw1-app-server.iot.i.tplinknbu.com/v1/things/thing%2F1/usage'));
  assert.deepEqual(JSON.parse(calls[1].body), {
    method: 'get_energy_data',
    params: { end_timestamp: 1736812800, interval: 1440, start_timestamp: 1730422800 }
  });
  assert.equal(calls[1].headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.equal(Number(calls[1].headers['Content-Length']), Buffer.byteLength(calls[1].body));
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


test('classifies Thing API network and HTTP failures without leaking raw messages', () => {
  assert.deepEqual(classifyThingError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), {
    errorCode: 'ECONNRESET', reason: 'Сервер или сеть неожиданно разорвали соединение.'
  });
  assert.deepEqual(classifyThingError(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })), {
    errorCode: 'ETIMEDOUT', reason: 'Истекло время ожидания ответа Thing API.'
  });
  assert.deepEqual(classifyThingError(Object.assign(new Error('HTTP 429'), { statusCode: 429, code: 'HTTP_429' })), {
    errorCode: 'HTTP_429', httpStatus: 429, reason: 'Сервер Thing API вернул HTTP 429.'
  });
  assert.equal(classifyThingError(new Error('secret token must never be shown')).reason,
    'Не удалось завершить запрос к Thing API.');
});


test('reads only documented Thing details, telemetry, settings, shadows and model endpoints', async () => {
  const calls = [];
  const fakeRequest = (url, options, callback) => {
    calls.push({ url: String(url), method: options.method });
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const req = new EventEmitter();
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.end(JSON.stringify({ error_code: 0, data: { safe: true } }));
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
  await client.getThingResource('p110m-1', 'details');
  await client.getThingResource('p110m-1', 'rt-info');
  await client.getThingResource('p110m-1', 'settings');
  await client.getShadows('p110m-1');
  await client.getShadows('p110m-1', 'https://eu-app-server.iot.i.tplinkcloud.com', true);
  await client.getModel('model-1');
  assert.deepEqual(calls.map(call => call.method), Array(6).fill('GET'));
  assert.ok(calls.some(call => call.url.endsWith('/v1/things/p110m-1/details')));
  assert.ok(calls.some(call => call.url.endsWith('/v1/things/p110m-1/rt-info')));
  assert.ok(calls.some(call => call.url.endsWith('/v1/things/p110m-1/settings')));
  assert.ok(calls.some(call => call.url.includes('/v1/things/shadows?thingNames=p110m-1')));
  assert.ok(calls.some(call => call.url.includes('/v1/things/matter/shadows?thingNames=p110m-1')));
  assert.ok(calls.some(call => call.url.endsWith('/v1/things/models/model-1')));
  await assert.rejects(client.getThingResource('p110m-1', 'usage-admin'), /Unsupported read-only/);
});


test('uses the documented read-only Thing resource endpoints', async () => {
  const calls = [];
  const fakeRequest = (url, options, callback) => {
    calls.push({ url: String(url), method: options.method });
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const req = new EventEmitter();
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.end(JSON.stringify({ error_code: 0, data: { ok: true } }));
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const client = new TapoThingApi({
    host: 'https://eu-app-server.iot.i.tplinkcloud.com',
    token: 'test-token', termId: 'test-term', request: fakeRequest,
    caPath: require('node:path').join(__dirname, '..', 'helpers', 'tplink-cloud-server-ca.pem')
  });
  await client.getThingResource('p110m-1', 'details');
  await client.getThingResource('p110m-1', 'rt-info');
  await client.getThingResource('p110m-1', 'settings');
  await client.getShadows('p110m-1');
  await client.getShadows('p110m-1', 'https://eu-app-server.iot.i.tplinkcloud.com', true);
  await client.getModel('model-1');
  assert.ok(calls.every(call => call.method === 'GET'));
  for (const suffix of ['/details', '/rt-info', '/settings']) {
    assert.ok(calls.some(call => call.url.endsWith('/v1/things/p110m-1' + suffix)));
  }
  assert.ok(calls.some(call => call.url.includes('/v1/things/shadows?thingNames=p110m-1')));
  assert.ok(calls.some(call => call.url.includes('/v1/things/matter/shadows?thingNames=p110m-1')));
  assert.ok(calls.some(call => call.url.endsWith('/v1/things/models/model-1')));
  await assert.rejects(client.getThingResource('p110m-1', 'unsupported'), /Unsupported read-only/);
});
