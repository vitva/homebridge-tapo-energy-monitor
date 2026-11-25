'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCloudBase, signBody } = require('../src/tapo-cloud-auth');

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
