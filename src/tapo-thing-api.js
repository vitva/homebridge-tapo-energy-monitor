'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');

const THING_SUFFIX = '-app-server.iot.i.tplinkcloud.com';
const DEFAULT_APP = 'TP-Link_Tapo_Android';
const DEFAULT_VERSION = '3.13.818';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function validateThingHost(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch {
    throw new Error('TP-Link returned an invalid Thing API host.');
  }
  const host = parsed.hostname.toLowerCase();
  const prefix = host.endsWith(THING_SUFFIX) ? host.slice(0, -THING_SUFFIX.length) : '';
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      !prefix || !/^[a-z0-9-]+$/.test(prefix)) {
    throw new Error('TP-Link returned an invalid Thing API host.');
  }
  return 'https://' + host;
}

function cloudApiError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('TP-Link returned an invalid Thing API response.');
  }
  const rawCode = payload.error_code ?? payload.errorCode ?? 0;
  const code = Number(rawCode);
  if (!Number.isFinite(code)) throw new Error('TP-Link returned an invalid Thing API response.');
  if (code !== 0) {
    const error = new Error('TP-Link Thing API error (' + code + ').');
    error.code = code;
    throw error;
  }
  return payload;
}

function requestJson(url, options = {}) {
  const request = options.request || https.request;
  const caPath = options.caPath || path.join(__dirname, '..', 'helpers', 'tplink-cloud-server-ca.pem');
  const ca = [...tls.rootCertificates, fs.readFileSync(caPath)];
  const timeoutMs = Math.max(5000, Math.min(60000, Number(options.timeoutMs) || 20000));

  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      headers: options.headers,
      ca,
      rejectUnauthorized: true,
      timeout: timeoutMs
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        reject(new Error('TP-Link Thing API redirect was rejected.'));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('TP-Link Thing API response is too large.'));
        }
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error('TP-Link Thing API returned HTTP ' + response.statusCode + '.'));
          return;
        }
        try {
          resolve(cloudApiError(JSON.parse(body)));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TP-Link Thing API request timed out.')));
    req.on('error', error => reject(error));
    req.end();
  });
}

class TapoThingApi {
  constructor(options = {}) {
    this.host = validateThingHost(options.host);
    if (typeof options.token !== 'string' || !options.token.trim()) {
      throw new Error('A Tapo cloud session token is required.');
    }
    this.token = options.token;
    this.termId = typeof options.termId === 'string' ? options.termId : '';
    this.appName = options.appName || DEFAULT_APP;
    this.appVersion = options.appVersion || DEFAULT_VERSION;
    this.request = options.request || https.request;
    this.caPath = options.caPath;
    this.timeoutMs = options.timeoutMs;
  }

  get headers() {
    return {
      Authorization: 'ut|' + this.token,
      'app-cid': 'app:' + this.appName + ':' + this.termId,
      'x-app-name': this.appName,
      'x-app-version': this.appVersion,
      'x-term-id': this.termId,
      'x-ospf': 'Android 15',
      'x-net-type': 'wifi',
      'x-strict': '0',
      'x-locale': 'en_US',
      'x-app-brand': 'TPLINK',
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': this.appName + '/' + this.appVersion + '(Homebridge/;Android 15)'
    };
  }

  async getJson(url) {
    return requestJson(url, {
      request: this.request,
      caPath: this.caPath,
      timeoutMs: this.timeoutMs,
      headers: this.headers
    });
  }

  async listThings(options = {}) {
    const pageSize = Math.max(1, Math.min(100, Number(options.pageSize) || 100));
    const maxPages = Math.max(1, Math.min(100, Number(options.maxPages) || 100));
    const things = [];
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL('/v2/things', this.host);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('includeKasaShareDevices', 'false');
      url.searchParams.set('includePcDevice', 'false');
      url.searchParams.set('includeMatterDevice', 'false');
      url.searchParams.set('includeExternalVendorDeviceInfo', 'false');
      const payload = await this.getJson(url);
      const items = Array.isArray(payload.data) ? payload.data : [];
      things.push(...items);
      const total = Number(payload.total) || 0;
      if (items.length < pageSize || (total > 0 && things.length >= total)) return things;
    }
    throw new Error('TP-Link Thing API pagination limit reached.');
  }

  async getUsage(thingName, thingHost = this.host) {
    if (typeof thingName !== 'string' || !thingName.trim() || thingName.length > 512) {
      throw new Error('A valid Thing device identifier is required.');
    }
    const host = validateThingHost(thingHost);
    const url = new URL('/v1/things/' + encodeURIComponent(thingName) + '/usage', host);
    const payload = await this.getJson(url);
    return payload.data ?? payload;
  }
}

module.exports = { TapoThingApi, validateThingHost, cloudApiError };
