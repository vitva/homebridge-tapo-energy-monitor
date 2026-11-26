'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');
const { TapoCloudAuth, validateCloudBase, signBody } = require('../src/tapo-cloud-auth');

test('accepts only HTTPS TP-Link cloud base URLs', () => {
  assert.equal(validateCloudBase('https://n-wap.i.tplinkcloud.com/'),
    'https://n-wap.i.tplinkcloud.com');
  for (const value of [
    'http://n-wap.i.tplinkcloud.com',
    'https://example.com',
    'https://tplinkcloud.com.evil.test',
    'https://user:pass@n-wap.i.tplinkcloud.com',
    'https://n-wap.i.tplinkcloud.com:444',
    'https://n-wap.i.tplinkcloud.com/path'
  ]) {
    assert.throws(() => validateCloudBase(value), /invalid cloud server address/);
  }
});

test('signs the exact JSON body and request path deterministically', () => {
  const body = JSON.stringify({ hello: 'tapo' });
  const first = signBody(body, '/api/v2/account/login', 'fixed-nonce');
  const second = signBody(body, '/api/v2/account/login', 'fixed-nonce');
  assert.equal(first['Content-MD5'], second['Content-MD5']);
  assert.equal(first['X-Authorization'], second['X-Authorization']);
  assert.match(first['X-Authorization'], /^Timestamp=9999999999, Nonce=fixed-nonce, AccessKey=[a-f0-9]+, Signature=[a-f0-9]+$/);
  assert.notEqual(first['X-Authorization'],
    signBody(body, '/api/v2/account/refreshToken', 'fixed-nonce')['X-Authorization']);
});

test('does not accept malformed TP-Link cloud URLs', () => {
  for (const value of ['', null, 'not a url', 'https://tplinkcloud.com']) {
    assert.throws(() => validateCloudBase(value));
  }
});

test('performs regional discovery and login using the bundled TP-Link CA', async () => {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url: new URL(String(url)), options });
    const req = new EventEmitter();
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.setEncoding('utf8');
      callback(response);
      const payload = calls.length === 1
        ? { error_code: 0, result: { appServerUrl: 'https://eu1.tplinkcloud.com' } }
        : { error_code: 0, result: { token: 'test-session-token', refreshToken: 'test-refresh-token' } };
      response.end(JSON.stringify(payload));
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const auth = new TapoCloudAuth({ request, termId: 'test-terminal' });
  const result = await auth.login({ username: 'test@example.com', password: 'not-a-real-password' });

  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.token, 'test-session-token');
  assert.equal(result.refreshToken, 'test-refresh-token');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.method === 'POST' && call.options.rejectUnauthorized === true));
  assert.ok(calls.every(call => Buffer.isBuffer(call.options.ca) && call.options.ca.length > 0));
  assert.ok(calls[0].url.pathname.endsWith('/getAccountStatusAndUrl'));
  assert.ok(calls[1].url.pathname.endsWith('/login'));
  assert.equal(calls[1].url.hostname, 'eu1.tplinkcloud.com');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json;charset=UTF-8');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'helpers', 'tplink-cloud-server-ca.pem')));
});

test('discovers and validates the regional Thing API service host', async () => {
  let captured;
  const request = (url, options, callback) => {
    captured = { url: new URL(String(url)), options };
    const req = new EventEmitter();
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.setEncoding('utf8');
      callback(response);
      response.end(JSON.stringify({
        error_code: 0,
        result: {
          serviceList: [
            { serviceId: 'nbu.iot-cloud-gateway.app-v2', serviceUrl: 'https://gateway-app-server.iot.i.tplinkcloud.com' },
            { serviceId: 'nbu.iot-app-server.app-v2', serviceUrl: 'https://eu-app-server.iot.i.tplinkcloud.com' }
          ]
        }
      }));
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const auth = new TapoCloudAuth({ request, termId: 'test-terminal' });
  auth.host = 'https://eu1.tplinkcloud.com';
  const host = await auth.discoverThingService('test@example.com', 'test-session-token');
  assert.equal(host, 'https://eu-app-server.iot.i.tplinkcloud.com');
  assert.equal(captured.url.pathname, '/api/v2/common/getAppServiceUrlByCloudUserName');
  assert.equal(captured.url.searchParams.get('appVer'), '3.13.818');
  assert.equal(captured.url.searchParams.get('token'), 'test-session-token');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.rejectUnauthorized, true);
});

test('rejects an unsafe Thing service URL returned by cloud discovery', async () => {
  const request = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.setEncoding('utf8');
      callback(response);
      response.end(JSON.stringify({
        error_code: 0,
        result: { serviceList: [
          { serviceId: 'nbu.iot-app-server.app-v2', serviceUrl: 'https://attacker.example' }
        ] }
      }));
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const auth = new TapoCloudAuth({ request, termId: 'test-terminal' });
  auth.host = 'https://eu1.tplinkcloud.com';
  await assert.rejects(
    auth.discoverThingService('test@example.com', 'test-session-token'),
    /invalid Thing API host/
  );
});

test('returns an MFA challenge without retaining account credentials', async () => {
  const replies = [
    { error_code: 0, result: { appServerUrl: 'https://eu1.tplinkcloud.com' } },
    { error_code: -20677, result: { mfaType: 'verifyCodeLogin' } }
  ];
  const request = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.setEncoding('utf8');
      callback(response);
      response.end(JSON.stringify(replies.shift()));
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const auth = new TapoCloudAuth({ request, termId: 'test-terminal' });
  const result = await auth.login({ username: 'test@example.com', password: 'not-a-real-password' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'mfa_required');
  assert.equal(Object.hasOwn(auth, 'password'), false);
  assert.equal(Object.hasOwn(auth, 'username'), false);
});


test('rejects an invalid MFA code without exposing credentials in diagnostics', async () => {
  const replies = [
    { error_code: 0, result: { appServerUrl: 'https://eu1.tplinkcloud.com' } },
    { error_code: -20677, result: { mfaType: 'verifyCodeLogin' } },
    { error_code: -20678, msg: 'invalid verification code' }
  ];
  const requests = [];
  const diagnostics = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.end = body => {
      requests.push({ url: new URL(String(url)), body: JSON.parse(body) });
      const response = new PassThrough();
      response.statusCode = 200;
      response.setEncoding('utf8');
      callback(response);
      response.end(JSON.stringify(replies.shift()));
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const auth = new TapoCloudAuth({
    request,
    termId: 'test-terminal',
    onDiagnostic: event => diagnostics.push(event)
  });
  const result = await auth.login({
    username: 'private@example.com',
    password: 'never-return-this-password',
    mfaCode: '654321'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'mfa_failed');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url.pathname, '/api/v2/account/checkMFACodeAndLogin');
  assert.equal(requests[2].body.code, '654321');
  assert.deepEqual(diagnostics.map(item => [item.stage, item.status]), [
    ['regional_server', 'success'],
    ['authentication', 'failed']
  ]);
  const serialized = JSON.stringify({ result, diagnostics });
  assert.equal(serialized.includes('never-return-this-password'), false);
  assert.equal(serialized.includes('654321'), false);
  assert.equal(serialized.includes('private@example.com'), false);
  assert.equal(Object.hasOwn(auth, 'password'), false);
  assert.equal(Object.hasOwn(auth, 'username'), false);
});


test('reports safe DNS transport diagnostics without exposing raw network errors', async () => {
  const diagnostics = [];
  const request = () => {
    const req = new EventEmitter();
    req.end = () => {
      const error = new Error('getaddrinfo ENOTFOUND private-internal-host.example');
      error.code = 'ENOTFOUND';
      req.emit('error', error);
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const auth = new TapoCloudAuth({
    request,
    onDiagnostic: event => diagnostics.push(event),
    termId: 'test-terminal'
  });
  const result = await auth.login({ username: 'private@example.com', password: 'local-secret' });
  assert.equal(result.ok, false);
  assert.equal(diagnostics[0].stage, 'regional_server');
  assert.equal(diagnostics[0].status, 'failed');
  assert.equal(diagnostics[0].errorCode, 'ENOTFOUND');
  assert.match(diagnostics[0].reason, /DNS/);
  const serialized = JSON.stringify({ result, diagnostics });
  assert.equal(serialized.includes('private-internal-host.example'), false);
  assert.equal(serialized.includes('local-secret'), false);
  assert.equal(serialized.includes('private@example.com'), false);
});

test('reports TLS transport failures with a safe explanation', async () => {
  const diagnostics = [];
  const request = () => {
    const req = new EventEmitter();
    req.end = () => {
      const error = new Error('certificate details must not be shown');
      error.code = 'CERT_HAS_EXPIRED';
      req.emit('error', error);
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const auth = new TapoCloudAuth({ request, onDiagnostic: event => diagnostics.push(event) });
  await auth.login({ username: 'private@example.com', password: 'local-secret' });
  assert.equal(diagnostics[0].errorCode, 'CERT_HAS_EXPIRED');
  assert.match(diagnostics[0].reason, /TLS/);
  assert.equal(JSON.stringify(diagnostics).includes('certificate details must not be shown'), false);
});

test('reports HTTP status codes from the regional server', async () => {
  const diagnostics = [];
  const request = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 503;
      callback(response);
      response.end('service unavailable');
    };
    req.destroy = error => { if (error) req.emit('error', error); };
    return req;
  };
  const auth = new TapoCloudAuth({ request, onDiagnostic: event => diagnostics.push(event) });
  await auth.login({ username: 'private@example.com', password: 'local-secret' });
  assert.equal(diagnostics[0].code, 503);
  assert.equal(diagnostics[0].errorCode, 'HTTP_503');
  assert.match(diagnostics[0].reason, /HTTP 503/);
});
